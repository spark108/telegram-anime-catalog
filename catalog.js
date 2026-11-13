const { DatabaseSync } = require('node:sqlite');
const { analyze, compile } = require('./analyzer');
const { openPublicationStore } = require('./publications');
const { openTracking, dubbedVideo, subtitledVideo, readJoin, isUnread } = require('./tracking');

const catalogReleases = `WITH releases AS NOT MATERIALIZED (
  SELECT anime_id, source_id, attachments, json_extract(result, '$.voiceover') AS voiceover,
    json_extract(result, '$.audioVariant') AS audio_variant,
    json_extract(result, '$.subtitles') AS subtitles,
    json_extract(result, '$.subtitles.author') AS subtitle_author
  FROM messages WHERE anime_id IS NOT NULL
)`;
const catalogMetadata = 'LEFT JOIN shikimori_cache c ON c.anime_id = a.id AND c.title = a.title AND c.year IS a.year';
const catalogYear = "COALESCE(a.year, json_extract(c.data, '$.year'))";

function openCatalog(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, username TEXT, peer TEXT NOT NULL,
      analyzer TEXT, head INTEGER, cursor INTEGER, history_done INTEGER NOT NULL DEFAULT 0,
      attached INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS anime (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, title_key TEXT NOT NULL, year INTEGER
    );
    CREATE INDEX IF NOT EXISTS anime_title ON anime(title_key, year);
    CREATE TABLE IF NOT EXISTS anime_aliases (
      anime_id INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
      title TEXT NOT NULL, title_key TEXT NOT NULL, year INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS anime_alias_unique ON anime_aliases(anime_id, title, COALESCE(year, -1));
    CREATE INDEX IF NOT EXISTS anime_alias_key ON anime_aliases(title_key, year, anime_id);
    CREATE TABLE IF NOT EXISTS anime_redirects (
      old_id INTEGER PRIMARY KEY, anime_id INTEGER NOT NULL REFERENCES anime(id)
    );
    CREATE INDEX IF NOT EXISTS anime_redirect_target ON anime_redirects(anime_id);
    CREATE TABLE IF NOT EXISTS anime_shikimori_ids (
      shikimori_id INTEGER PRIMARY KEY, anime_id INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS anime_shikimori_target ON anime_shikimori_ids(anime_id);
    CREATE TABLE IF NOT EXISTS messages (
      source_id TEXT NOT NULL REFERENCES sources(id), id INTEGER NOT NULL, date INTEGER,
      text TEXT NOT NULL, attachments TEXT NOT NULL, result TEXT, issue TEXT,
      anime_id INTEGER REFERENCES anime(id), manual_anime_id INTEGER REFERENCES anime(id),
      PRIMARY KEY (source_id, id)
    );
    CREATE INDEX IF NOT EXISTS messages_anime ON messages(anime_id);
    CREATE TABLE IF NOT EXISTS shikimori_cache (
      anime_id INTEGER PRIMARY KEY REFERENCES anime(id) ON DELETE CASCADE,
      title TEXT NOT NULL, year INTEGER, data TEXT, next_check INTEGER NOT NULL,
      poster_url TEXT, poster_type TEXT, poster BLOB
    );
  `);
  if (!db.prepare('PRAGMA table_info(sources)').all().some(column => column.name === 'attached')) {
    db.exec('ALTER TABLE sources ADD COLUMN attached INTEGER NOT NULL DEFAULT 1');
  }

  const analysisLog = [];
  let logSequence = 0;
  let pendingLog;
  const transaction = action => {
    db.exec('BEGIN IMMEDIATE');
    pendingLog = [];
    try {
      const result = action();
      db.exec('COMMIT');
      for (const entry of pendingLog) analysisLog.push({ id: ++logSequence, ...entry });
      if (analysisLog.length > 1000) analysisLog.splice(0, analysisLog.length - 1000);
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      pendingLog = undefined;
    }
  };
  const settings = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setSettings = db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)');
  const upsertSource = db.prepare(`
    INSERT INTO sources(id, title, username, peer) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, username = excluded.username, peer = excluded.peer, attached = 1
  `);
  const addSource = source => upsertSource.run(source.id, source.title, source.username, JSON.stringify(source.peer));
  const insertAnime = db.prepare(`
    INSERT INTO anime(id, title, title_key, year)
    VALUES (MAX(COALESCE((SELECT MAX(id) FROM anime), 0), COALESCE((SELECT MAX(old_id) FROM anime_redirects), 0)) + 1, ?, ?, ?)
  `);
  const searchAnime = db.prepare(`
    SELECT id, year, 1 AS primary_name FROM anime WHERE title_key = $key
    UNION ALL SELECT anime_id, year, 0 FROM anime_aliases WHERE title_key = $key
  `);
  const redirect = db.prepare('SELECT anime_id FROM anime_redirects WHERE old_id = ?');
  const resolveAnime = id => redirect.get(id)?.anime_id ?? id;
  const getAnime = db.prepare('SELECT * FROM anime WHERE id = ?');
  const aliasesFor = db.prepare('SELECT DISTINCT title FROM anime_aliases WHERE anime_id = ? AND title <> ? ORDER BY title');
  const setAnalysis = db.prepare(`
    UPDATE messages SET result = ?, issue = ?, anime_id = ? WHERE source_id = ? AND id = ?
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS messages_series_key ON messages(source_id, json_extract(result, '$.seriesKey'))
    WHERE json_extract(result, '$.seriesKey') IS NOT NULL
  `);
  const seriesTitles = db.prepare(`
    SELECT DISTINCT anime_id FROM messages
    WHERE source_id = ? AND json_extract(result, '$.seriesKey') = ?
      AND json_extract(result, '$.title') IS NOT NULL AND anime_id IS NOT NULL
    LIMIT 2
  `);
  const linkShortCaptions = db.prepare(`
    UPDATE messages SET anime_id = $animeId, issue = $issue
    WHERE source_id = $sourceId AND json_extract(result, '$.seriesKey') = $seriesKey
      AND json_extract(result, '$.title') IS NULL AND manual_anime_id IS NULL
      AND (anime_id IS NOT $animeId OR issue IS NOT $issue)
  `);
  const previousSeries = db.prepare(`
    SELECT json_extract(result, '$.seriesKey') AS seriesKey FROM messages
    WHERE source_id = ? AND id = ? AND json_extract(result, '$.title') IS NOT NULL
  `);
  const upsertMessage = db.prepare(`
    INSERT INTO messages(source_id, id, date, text, attachments) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_id, id) DO UPDATE SET date = excluded.date,
      text = excluded.text, attachments = excluded.attachments
    WHERE messages.date IS NOT excluded.date OR messages.text <> excluded.text
      OR messages.attachments <> excluded.attachments
    RETURNING manual_anime_id
  `);

  function matchAnime(result) {
    const titleKey = key(result.title);
    const candidates = searchAnime.all({ key: titleKey });
    if (result.year !== null) {
      const exact = new Set(candidates.filter(row => row.year === result.year).map(row => row.id));
      if (exact.size) return exact.size === 1 ? [...exact][0] : null;
    }
    const ids = new Set(candidates.map(row => row.id));
    if (result.year === null && ids.size > 1) return null;
    if (ids.size === 1 && (result.year === null || candidates.some(row => row.year === null))) {
      const [id] = ids;
      if (result.year !== null && candidates.some(row => row.primary_name && row.year === null)) {
        db.prepare('UPDATE anime SET year = ? WHERE id = ?').run(result.year, id);
      }
      return id;
    }
    return insertAnime.run(result.title, titleKey, result.year).lastInsertRowid;
  }

  function seriesMatch(sourceId, seriesKey) {
    const matches = seriesTitles.all(sourceId, seriesKey);
    if (matches.length === 1) return { animeId: matches[0].anime_id, issue: null };
    return { animeId: null, issue: matches.length
      ? 'Этот хештег встречается у нескольких тайтлов.' : 'Для хештега ещё нет полной подписи.' };
  }

  function applyAnalysis(script, sourceTitle, message, manualId) {
    let result = null;
    let issue = null;
    let animeId = manualId;
    try {
      if (script) result = analyze(script, message);
      if (result?.skip) {
        animeId = null;
      } else if (animeId === null && result?.title) {
        animeId = matchAnime(result);
        if (animeId === null) issue = 'Найдено несколько тайтлов с этим названием.';
      } else if (animeId === null && result?.seriesKey && message.attachments.length) {
        ({ animeId, issue } = seriesMatch(message.source_id, result.seriesKey));
      } else if (animeId === null && message.attachments.length) {
        issue = script ? 'Не определено название.' : 'Анализатор не настроен.';
      }
    } catch (error) {
      issue = error.message.slice(0, 500);
    }
    const sourceId = message.source_id;
    const previous = previousSeries.get(sourceId, message.id)?.seriesKey;
    setAnalysis.run(result && JSON.stringify(result), issue, animeId, sourceId, message.id);
    for (const seriesKey of new Set([previous, result?.title && result.seriesKey].filter(Boolean))) {
      linkShortCaptions.run({ sourceId, seriesKey, ...seriesMatch(sourceId, seriesKey) });
    }
    if (script) {
      const title = animeId === null ? null : getAnime.get(animeId)?.title;
      const fields = [
        'Аниме: ' + (title ?? result?.title ?? 'не указано'),
        result?.season == null ? null : 'Сезон: ' + result.season,
        result?.episode == null ? null : 'Серия: ' + result.episode,
        result?.voiceover || result?.audioVariant ? 'Озвучка: ' + (result.voiceover ?? result.audioVariant) : null,
        result?.subtitles || !(result?.voiceover || result?.audioVariant)
          ? 'Субтитры: ' + (result?.subtitles?.author ?? 'не указано') : null
      ];
      const summary = result?.skip ? 'Пропущено' : issue ? 'Отправлено на проверку · ' + issue
        : animeId === null ? 'Тайтл не определён' : fields.filter(Boolean).join(' · ');
      pendingLog.push({
        processedAt: Date.now(),
        line: `${sourceTitle} #${message.id}, ${summary}`.replace(/[\r\n]+/g, ' ')
      });
    }
  }

  const publications = openPublicationStore(db, transaction);
  const tracking = openTracking(db);
  const pruneAnime = db.prepare(`
    DELETE FROM anime WHERE NOT EXISTS (SELECT 1 FROM messages WHERE anime_id = anime.id OR manual_anime_id = anime.id)
      AND NOT EXISTS (SELECT 1 FROM anime_redirects WHERE anime_id = anime.id)
      AND NOT EXISTS (SELECT 1 FROM tracked_anime WHERE anime_id = anime.id)
  `);
  const shikimoriOwner = db.prepare('SELECT anime_id FROM anime_shikimori_ids WHERE shikimori_id = ?');
  const linkShikimori = db.prepare('INSERT INTO anime_shikimori_ids (shikimori_id, anime_id) VALUES (?, ?)');

  function mergeAnime(sourceId, targetId) {
    const source = getAnime.get(sourceId);
    const target = getAnime.get(targetId);
    if (!source || !target) throw new Error('Тайтл для объединения не найден.');
    if (sourceId === targetId) return targetId;
    db.prepare(`INSERT OR IGNORE INTO anime_aliases (anime_id, title, title_key, year) VALUES (?, ?, ?, ?)`)
      .run(targetId, source.title, source.title_key, source.year);
    db.prepare(`
      INSERT OR IGNORE INTO anime_aliases (anime_id, title, title_key, year)
      SELECT ?, title, title_key, year FROM anime_aliases WHERE anime_id = ?
    `).run(targetId, sourceId);
    tracking.merge(sourceId, targetId);
    db.prepare('UPDATE messages SET anime_id = ? WHERE anime_id = ?').run(targetId, sourceId);
    db.prepare('UPDATE messages SET manual_anime_id = ? WHERE manual_anime_id = ?').run(targetId, sourceId);
    db.prepare(`
      INSERT INTO shikimori_cache (anime_id, title, year, data, next_check, poster_url, poster_type, poster)
      SELECT $target, $title, $year, data, next_check, poster_url, poster_type, poster FROM shikimori_cache
      WHERE anime_id = $source AND title = $sourceTitle AND year IS $sourceYear AND data IS NOT NULL
      ON CONFLICT(anime_id) DO UPDATE SET title = excluded.title, year = excluded.year, data = excluded.data,
        next_check = excluded.next_check, poster_url = excluded.poster_url, poster_type = excluded.poster_type, poster = excluded.poster
      WHERE shikimori_cache.title <> excluded.title OR shikimori_cache.year IS NOT excluded.year OR shikimori_cache.data IS NULL
        OR (json_extract(shikimori_cache.data, '$.id') = json_extract(excluded.data, '$.id')
          AND json_extract(shikimori_cache.data, '$.poster') IS NULL AND json_extract(excluded.data, '$.poster') IS NOT NULL)
    `).run({ target: targetId, title: target.title, year: target.year, source: sourceId, sourceTitle: source.title, sourceYear: source.year });
    db.prepare('UPDATE anime_shikimori_ids SET anime_id = ? WHERE anime_id = ?').run(targetId, sourceId);
    db.prepare('UPDATE anime_redirects SET anime_id = ? WHERE anime_id = ?').run(targetId, sourceId);
    db.prepare('INSERT INTO anime_redirects (old_id, anime_id) VALUES (?, ?)').run(sourceId, targetId);
    db.prepare('DELETE FROM anime WHERE id = ?').run(sourceId);
    return targetId;
  }

  function registerShikimori(animeId, shikimoriId) {
    if (!Number.isSafeInteger(shikimoriId) || shikimoriId < 1) return;
    const owner = shikimoriOwner.get(shikimoriId);
    if (!owner) linkShikimori.run(shikimoriId, animeId);
    else if (owner.anime_id !== animeId) mergeAnime(animeId, owner.anime_id);
  }

  transaction(() => {
    const existing = db.prepare(`
      SELECT a.id, json_extract(c.data, '$.id') AS shikimori_id FROM anime a ${catalogMetadata}
      WHERE c.data IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM anime_shikimori_ids s WHERE s.anime_id = a.id AND s.shikimori_id = json_extract(c.data, '$.id')
      ) ORDER BY a.id
    `).all();
    for (const row of existing) registerShikimori(resolveAnime(row.id), row.shikimori_id);
  });

  return {
    publications,
    tracking,
    resolveAnime,
    setAnimeMembership(id, status) {
      id = resolveAnime(id);
      if (!getAnime.get(id)) throw new Error('Тайтл не найден.');
      tracking.setMembership(id, status);
      return tracking.membership(id);
    },
    mergeAnime: (sourceId, targetId) => transaction(() => mergeAnime(resolveAnime(sourceId), resolveAnime(targetId))),
    setting: name => JSON.parse(settings.get(name)?.value ?? 'null'),
    setSetting: (name, value) => setSettings.run(name, JSON.stringify(value)),
    sources: () => db.prepare('SELECT * FROM sources WHERE attached = 1 ORDER BY title').all(),
    source: id => db.prepare('SELECT * FROM sources WHERE id = ?').get(id),
    detachSource: id => db.prepare('UPDATE sources SET attached = 0 WHERE id = ?').run(id),
    addSource,
    addSources: sources => transaction(() => sources.forEach(addSource)),
    analysisLog: after => analysisLog.filter(entry => entry.id > after),
    saveAnalyzer(id, code) {
      const script = compile(code);
      transaction(() => {
        db.prepare('UPDATE sources SET analyzer = ? WHERE id = ?').run(code, id);
        const recent = db.prepare('SELECT * FROM messages WHERE source_id = ? ORDER BY id DESC LIMIT 25').all(id);
        const { title } = db.prepare('SELECT title FROM sources WHERE id = ?').get(id);
        for (const row of recent) applyAnalysis(script, title, decode(row), row.manual_anime_id);
        setSettings.run('reanalyze:' + id, JSON.stringify({ before: recent.at(-1)?.id ?? 0 }));
      });
    },
    reanalyze(source) {
      const setting = 'reanalyze:' + source.id;
      const position = settings.get(setting);
      if (!position) return;
      const script = compile(source.analyzer);
      const cursor = JSON.parse(position.value);
      const legacy = typeof cursor === 'number';
      const rows = legacy
        ? db.prepare(`SELECT * FROM messages WHERE source_id = ? AND id > ?
            AND result IS NULL AND issue IS NULL ORDER BY id LIMIT 25`).all(source.id, cursor)
        : db.prepare(`SELECT * FROM messages WHERE source_id = ? AND id < ?
            ORDER BY id DESC LIMIT 25`).all(source.id, cursor.before);
      transaction(() => {
        for (const row of rows) applyAnalysis(script, source.title, decode(row), row.manual_anime_id);
        if (rows.length) {
          const id = rows.at(-1).id;
          setSettings.run(setting, JSON.stringify(legacy ? id : { before: id }));
        }
        else {
          db.prepare('DELETE FROM settings WHERE key = ?').run(setting);
          pruneAnime.run();
        }
      });
    },
    ingest(source, rows, progress) {
      const script = source.analyzer && compile(source.analyzer);
      transaction(() => {
        for (const message of rows) {
          const row = upsertMessage.get(source.id, message.id, message.date, message.text, JSON.stringify(message.attachments));
          if (row) applyAnalysis(script, source.title, { ...message, source_id: source.id }, row.manual_anime_id);
        }
        if (progress.head !== undefined) db.prepare('UPDATE sources SET head = ? WHERE id = ?').run(progress.head, source.id);
        if (progress.cursor !== undefined) db.prepare('UPDATE sources SET cursor = ?, history_done = ? WHERE id = ?')
          .run(progress.cursor, Number(progress.done), source.id);
      });
    },
    samples: id => db.prepare('SELECT * FROM messages WHERE source_id = ? ORDER BY id DESC LIMIT 30').all(id).map(decode),
    publicationItem(sourceId, messageId) {
      const row = db.prepare(`
        SELECT m.*, a.title AS anime_title, a.year AS anime_year FROM messages m
        LEFT JOIN anime a ON a.id = m.anime_id WHERE m.source_id = ? AND m.id = ?
      `).get(sourceId, messageId);
      return row && decode(row);
    },
    review(source, page, pageSize) {
      const pending = 'm.issue IS NOT NULL AND m.manual_anime_id IS NULL';
      const sources = db.prepare(`
        SELECT s.id, s.title, COUNT(*) AS total
        FROM messages m JOIN sources s ON s.id = m.source_id
        WHERE ${pending} GROUP BY s.id
      `).all();
      const total = source ? sources.find(entry => entry.id === source)?.total ?? 0
        : sources.reduce((sum, entry) => sum + entry.total, 0);
      const pages = Math.max(1, Math.ceil(total / pageSize));
      page = Math.min(page, pages);
      const rows = db.prepare(`
        SELECT m.*, s.title AS source_title, s.username FROM messages m JOIN sources s ON s.id = m.source_id
        WHERE ${pending} AND ($source = '' OR m.source_id = $source)
        ORDER BY m.id DESC, m.source_id DESC LIMIT $pageSize OFFSET $offset
      `).all({ source, pageSize, offset: (page - 1) * pageSize }).map(decode);
      return { rows, sources, page, pages, total };
    },
    assign(sourceId, messageId, animeId, title, year) {
      transaction(() => {
        animeId = animeId === null ? insertAnime.run(title, key(title), year).lastInsertRowid : resolveAnime(animeId);
        const updated = db.prepare(`
          UPDATE messages SET manual_anime_id = ?, anime_id = ?, issue = NULL
          WHERE source_id = ? AND id = ? AND json_extract(result, '$.skip') IS NOT 1
        `)
          .run(animeId, animeId, sourceId, messageId);
        if (!updated.changes) throw new Error('Сообщение не найдено.');
        pruneAnime.run();
      });
    },
    list(query, after, {
      onlyVoiceovers = false, onlySubtitles = false, voiceovers = [], subtitles = [], years = [], sourceIds = [],
      tracking: trackingFilter = 'all', onlyUnread = false, includeBlacklist = true
    } = {}, includeCounts = false) {
      const matchingTitles = `${catalogReleases},
      selected_sources AS (SELECT value FROM json_each($sourceIds)),
      matching_releases AS NOT MATERIALIZED (
        SELECT * FROM releases WHERE $hasSources = 0 OR source_id IN (SELECT value FROM selected_sources)
      )
      SELECT a.id
      FROM anime a ${catalogMetadata} LEFT JOIN tracked_anime t ON t.anime_id = a.id
      WHERE (instr(a.title_key, $query) > 0 OR EXISTS (
        SELECT 1 FROM anime_aliases alias WHERE alias.anime_id = a.id AND instr(alias.title_key, $query) > 0
      ))
        AND EXISTS (SELECT 1 FROM matching_releases r WHERE r.anime_id = a.id)
        AND CASE $tracking
          WHEN 'tracked' THEN t.anime_id IS NOT NULL AND t.blacklisted_at IS NULL
          WHEN 'untracked' THEN t.anime_id IS NULL
          WHEN 'blacklisted' THEN t.blacklisted_at IS NOT NULL
          ELSE $includeBlacklist = 1 OR t.blacklisted_at IS NULL
        END
        AND ($onlyUnread = 0 OR EXISTS (
          SELECT 1 FROM messages m ${readJoin} WHERE m.anime_id = a.id AND ${isUnread}
            AND ($hasSources = 0 OR m.source_id IN (SELECT value FROM selected_sources))
        ))
        AND ($hasYears = 0 OR ${catalogYear} IN (SELECT value FROM json_each($years)))
        AND ($hasVoiceovers = 0 OR EXISTS (
          SELECT 1 FROM matching_releases r WHERE r.anime_id = a.id AND (
            r.voiceover IN (SELECT value FROM json_each($voiceovers)) OR
            r.audio_variant IN (SELECT value FROM json_each($voiceovers))
          )
        ))
        AND ($onlyVoiceovers = 0 OR EXISTS (
          SELECT 1 FROM matching_releases r WHERE r.anime_id = a.id AND (r.voiceover IS NOT NULL OR r.audio_variant IS NOT NULL)
        ))
        AND ($hasSubtitles = 0 OR EXISTS (
          SELECT 1 FROM matching_releases r WHERE r.anime_id = a.id AND r.subtitle_author IN (SELECT value FROM json_each($subtitles))
        ))
        AND ($onlySubtitles = 0 OR EXISTS (
          SELECT 1 FROM matching_releases r WHERE r.anime_id = a.id AND (r.subtitles IS NOT NULL OR EXISTS (
            SELECT 1 FROM json_each(r.attachments) f WHERE json_extract(f.value, '$.kind') = 'subtitle'
          ))
        ))
      `;
      const params = {
        query: key(query), onlyVoiceovers: Number(onlyVoiceovers), onlySubtitles: Number(onlySubtitles),
        tracking: trackingFilter, onlyUnread: Number(trackingFilter === 'tracked' && onlyUnread), includeBlacklist: Number(includeBlacklist),
        hasSources: Number(sourceIds.length > 0), sourceIds: JSON.stringify(sourceIds),
        hasYears: Number(years.length > 0), years: JSON.stringify(years),
        hasVoiceovers: Number(voiceovers.length > 0), voiceovers: JSON.stringify(voiceovers),
        hasSubtitles: Number(subtitles.length > 0), subtitles: JSON.stringify(subtitles)
      };
      const rows = db.prepare(`
        SELECT a.*, c.data AS metadata, c.next_check, (SELECT COUNT(*) FROM messages m WHERE m.anime_id = a.id) AS messages,
          (t.anime_id IS NOT NULL AND t.blacklisted_at IS NULL) AS tracked,
          t.blacklisted_at IS NOT NULL AS blacklisted
        FROM anime a ${catalogMetadata} LEFT JOIN tracked_anime t ON t.anime_id = a.id
        WHERE a.id > $after AND a.id IN (${matchingTitles} AND a.id > $after)
        ORDER BY a.id LIMIT 50
      `).all({ ...params, after }).map(withMetadataSummary);
      if (!includeCounts) return rows;
      const { matched, total } = db.prepare(`
        SELECT (SELECT COUNT(*) FROM (${matchingTitles})) AS matched,
          (SELECT COUNT(*) FROM anime a WHERE EXISTS (
            SELECT 1 FROM messages m WHERE m.anime_id = a.id
          )) AS total
      `).get(params);
      return { rows, matched, total };
    },
    filterOptions() {
      const voiceovers = db.prepare(`${catalogReleases}
        SELECT voiceover AS name FROM releases WHERE voiceover IS NOT NULL
        UNION SELECT audio_variant FROM releases WHERE audio_variant IS NOT NULL
      `).all();
      const subtitles = db.prepare(`${catalogReleases}
        SELECT DISTINCT subtitle_author AS name FROM releases WHERE subtitle_author IS NOT NULL
      `).all();
      const years = db.prepare(`
        SELECT DISTINCT ${catalogYear} AS year FROM anime a ${catalogMetadata}
        WHERE ${catalogYear} IS NOT NULL AND EXISTS (SELECT 1 FROM messages m WHERE m.anime_id = a.id)
      `).all();
      const sources = db.prepare(`
        SELECT s.id, s.title FROM sources s
        WHERE s.attached = 1 OR EXISTS (
          SELECT 1 FROM messages m WHERE m.source_id = s.id AND m.anime_id IS NOT NULL
        )
      `).all();
      return { voiceovers: voiceovers.map(row => row.name), subtitles: subtitles.map(row => row.name), years: years.map(row => row.year), sources };
    },
    metadata: ids => db.prepare(`
      SELECT a.id, c.data AS metadata, c.next_check FROM anime a
      LEFT JOIN shikimori_cache c ON c.anime_id = a.id AND c.title = a.title AND c.year IS a.year
      WHERE a.id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(ids)).map(withMetadataSummary),
    episodeSources: id => db.prepare(`
      SELECT DISTINCT s.id, s.title FROM messages m JOIN sources s ON s.id = m.source_id WHERE m.anime_id = ?
    `).all(resolveAnime(id)),
    animePage(id, requestedSource = '') {
      id = resolveAnime(id);
      const row = db.prepare(`
        SELECT a.*, c.data AS metadata, c.next_check FROM anime a
        LEFT JOIN shikimori_cache c ON c.anime_id = a.id AND c.title = a.title AND c.year IS a.year WHERE a.id = ?
      `).get(id);
      if (!row) return null;
      const { metadata, next_check, ...anime } = row;
      const shikimori = JSON.parse(metadata);
      const sources = this.episodeSources(id);
      const source = sources.some(entry => entry.id === requestedSource) ? requestedSource : '';
      return { anime, aliases: aliasesFor.all(id, anime.title).map(alias => alias.title), sources, source,
        episodes: tracking.groups(id, source), ...tracking.membership(id),
        shikimori, metadataChecked: next_check != null, posterPending: needsPoster(shikimori) };
    },
    playbackOptions: id => db.prepare(`
      WITH videos AS (
        SELECT json_extract(m.result, '$.season') AS season, json_extract(m.result, '$.episode') AS episode,
          json_extract(m.result, '$.voiceover') AS voiceover, json_extract(m.result, '$.audioVariant') AS audioVariant,
          json_extract(m.result, '$.subtitles.mode') AS subtitleMode,
          s.id AS sourceId, s.title AS sourceTitle, m.id AS messageId, CAST(f.key AS INTEGER) AS "index"
        FROM messages m JOIN sources s ON s.id = m.source_id, json_each(m.attachments) f
        WHERE m.anime_id = ? AND json_extract(f.value, '$.kind') = 'video'
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY season, episode, voiceover, audioVariant, subtitleMode, sourceId
          ORDER BY messageId DESC, "index"
        ) AS position FROM videos
      )
      SELECT season, episode, voiceover, audioVariant, subtitleMode, sourceId, sourceTitle, messageId, "index"
      FROM ranked WHERE position = 1
      ORDER BY season IS NULL, season, episode IS NULL, episode, messageId DESC, "index", sourceId
    `).all(resolveAnime(id)),
    episode: (id, season, episode, before, beforeSource, material = 'all', source = '') => db.prepare(`
      SELECT m.*, s.title AS source_title, s.username FROM messages m JOIN sources s ON s.id = m.source_id
      WHERE m.anime_id = ? AND json_extract(m.result, '$.season') IS ? AND json_extract(m.result, '$.episode') IS ?
        AND (m.id, m.source_id) < (?, ?)
        AND ($source = '' OR m.source_id = $source)
        AND ($material = 'all' OR EXISTS (
          SELECT 1 FROM json_each(m.attachments)
          WHERE json_extract(value, '$.kind') = CASE WHEN $material = 'subtitle' THEN 'subtitle' ELSE 'video' END
        ))
        AND ($material <> 'dubbed-video' OR ${dubbedVideo})
        AND ($material <> 'subtitled-video' OR ${subtitledVideo})
      ORDER BY m.id DESC, m.source_id DESC LIMIT 50
    `).all({ material, source }, resolveAnime(id), season, episode, before, beforeSource).map(decode),
    shikimoriTarget(now, id = null) {
      const row = db.prepare(`
        SELECT a.id, a.title, a.year,
          CASE WHEN c.title = a.title AND c.year IS a.year THEN c.data END AS metadata
        FROM anime a LEFT JOIN shikimori_cache c ON c.anime_id = a.id
        WHERE (? IS NULL OR a.id = ?) AND (c.next_check IS NULL OR c.next_check <= ? OR c.title <> a.title OR c.year IS NOT a.year)
          AND EXISTS (SELECT 1 FROM messages m WHERE m.anime_id = a.id)
        ORDER BY a.id LIMIT 1
      `).get(id, id, now);
      if (!row) return null;
      const fileTitles = db.prepare(`
        SELECT DISTINCT json_extract(result, '$.fileTitle') AS title FROM messages WHERE anime_id = ? AND title IS NOT NULL LIMIT 4
      `).all(row.id).map(alias => alias.title);
      const aliases = aliasesFor.all(row.id, row.title).map(alias => alias.title);
      return { ...row, aliases: [...new Set([...aliases, ...fileTitles])] };
    },
    cacheShikimori(target, data, nextCheck) {
      transaction(() => {
        const saved = db.prepare(`
        INSERT INTO shikimori_cache(anime_id, title, year, data, next_check)
        SELECT id, title, year, ?, ? FROM anime WHERE id = ? AND title = ? AND year IS ?
        ON CONFLICT(anime_id) DO UPDATE SET title = excluded.title, year = excluded.year,
          data = excluded.data, next_check = excluded.next_check
        `).run(data, nextCheck, target.id, target.title, target.year);
        if (saved.changes && data) registerShikimori(target.id, JSON.parse(data).id);
      });
    },
    shikimoriPosterTargets(priority) {
      return db.prepare(`
        SELECT a.id, json_extract(c.data, '$.id') AS shikimoriId FROM anime a ${catalogMetadata}
        WHERE c.data IS NOT NULL AND json_extract(c.data, '$.poster') IS NULL
          AND json_extract(c.data, '$.posterChecked') IS NULL
        ORDER BY a.id IN (SELECT value FROM json_each(?)) DESC, a.id LIMIT 24
      `).all(JSON.stringify([...priority]));
    },
    cacheShikimoriPoster(id, shikimoriId, poster) {
      db.prepare(`
        UPDATE shikimori_cache SET data = json_set(data, '$.poster', ?, '$.posterChecked', 1)
        WHERE anime_id = ? AND json_extract(data, '$.id') = ? AND json_extract(data, '$.poster') IS NULL
      `).run(poster, id, shikimoriId);
    },
    shikimoriPoster: id => db.prepare(`
      SELECT json_extract(c.data, '$.poster') AS url, c.poster_url, c.poster_type, c.poster
      FROM shikimori_cache c JOIN anime a ON a.id = c.anime_id AND a.title = c.title AND a.year IS c.year
      WHERE c.anime_id = ?
    `).get(id),
    cachePoster: (id, url, type, image) => db.prepare(`
      UPDATE shikimori_cache SET poster_url = ?, poster_type = ?, poster = ?
      WHERE anime_id = ? AND json_extract(data, '$.poster') = ?
    `).run(url, type, image, id, url),
    details: (id, before, beforeSource) => ({
      anime: getAnime.get(resolveAnime(id)),
      messages: db.prepare(`
        SELECT m.*, s.title AS source_title, s.username FROM messages m JOIN sources s ON s.id = m.source_id
        WHERE m.anime_id = ? AND (m.id, m.source_id) < (?, ?)
        ORDER BY m.id DESC, m.source_id DESC LIMIT 50
      `).all(resolveAnime(id), before, beforeSource).map(decode)
    })
  };
}

function key(title) {
  return title.normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function decode(row) {
  return { ...row, attachments: JSON.parse(row.attachments), result: JSON.parse(row.result) };
}

function withMetadataSummary({ metadata, next_check, ...anime }) {
  const info = JSON.parse(metadata);
  return {
    ...anime, metadataChecked: next_check != null, posterPending: needsPoster(info),
    shikimori: info && { id: info.id, poster: info.poster, year: info.year, score: info.score, kind: info.kind }
  };
}

function needsPoster(info) {
  return Boolean(info && !info.poster && !info.posterChecked);
}

module.exports = { openCatalog };
