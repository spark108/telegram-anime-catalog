const dubbedVideo = "(json_extract(m.result, '$.voiceover') IS NOT NULL OR json_extract(m.result, '$.audioVariant') IS NOT NULL)";
const subtitledVideo = "json_extract(m.result, '$.subtitles.mode') = 'video'";
const videoCount = "(SELECT COUNT(*) FROM json_each(m.attachments) WHERE json_extract(value, '$.kind') = 'video')";
const season = "json_extract(m.result, '$.season')";
const episode = "json_extract(m.result, '$.episode')";
const readJoin = `LEFT JOIN episode_reads r ON r.anime_id = m.anime_id AND r.season = COALESCE(${season}, -1)
  AND r.episode = COALESCE(${episode}, -1) AND r.source_id = m.source_id AND r.message_id = m.id`;
const isUnread = `(m.result IS NOT NULL OR m.manual_anime_id IS NOT NULL)
  AND (r.message_id IS NULL OR r.attachments IS NOT m.attachments OR r.text IS NOT m.text)`;

function openTracking(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_anime (
      anime_id INTEGER PRIMARY KEY REFERENCES anime(id) ON DELETE CASCADE,
      tracked_at INTEGER NOT NULL,
      blacklisted_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS episode_reads (
      anime_id INTEGER NOT NULL REFERENCES tracked_anime(anime_id) ON DELETE CASCADE,
      season INTEGER NOT NULL, episode INTEGER NOT NULL,
      source_id TEXT NOT NULL, message_id INTEGER NOT NULL,
      attachments TEXT NOT NULL, text TEXT NOT NULL,
      PRIMARY KEY (anime_id, season, episode, source_id, message_id),
      FOREIGN KEY (source_id, message_id) REFERENCES messages(source_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS publications_source_message ON publications(source_id, message_id);
    CREATE TRIGGER IF NOT EXISTS track_on_publication AFTER INSERT ON publications
    BEGIN
      INSERT OR IGNORE INTO tracked_anime(anime_id, tracked_at)
        SELECT anime_id, NEW.created_at FROM messages WHERE source_id = NEW.source_id AND id = NEW.message_id AND anime_id IS NOT NULL;
    END;
    CREATE TRIGGER IF NOT EXISTS track_on_message_assignment AFTER UPDATE OF anime_id ON messages
    WHEN NEW.anime_id IS NOT NULL AND NEW.anime_id IS NOT OLD.anime_id
    BEGIN
      INSERT OR IGNORE INTO tracked_anime(anime_id, tracked_at)
        SELECT NEW.anime_id, MIN(created_at) FROM publications
        WHERE source_id = NEW.source_id AND message_id = NEW.id HAVING COUNT(*) > 0;
    END;
    INSERT OR IGNORE INTO tracked_anime(anime_id, tracked_at)
      SELECT m.anime_id, MIN(p.created_at) FROM publications p
      JOIN messages m ON m.source_id = p.source_id AND m.id = p.message_id
      WHERE m.anime_id IS NOT NULL GROUP BY m.anime_id;
  `);
  if (!db.prepare('PRAGMA table_info(tracked_anime)').all().some(column => column.name === 'blacklisted_at')) {
    db.exec('ALTER TABLE tracked_anime ADD COLUMN blacklisted_at INTEGER');
  }

  const groups = db.prepare(`
    SELECT ${season} AS season, ${episode} AS episode,
      SUM(MAX(1, json_array_length(m.attachments))) AS items,
      SUM(${videoCount}) AS videos,
      SUM(CASE WHEN ${dubbedVideo} THEN ${videoCount} ELSE 0 END) AS dubbedVideos,
      SUM(CASE WHEN ${subtitledVideo} THEN ${videoCount} ELSE 0 END) AS subtitledVideos,
      SUM((SELECT COUNT(*) FROM json_each(m.attachments) WHERE json_extract(value, '$.kind') = 'subtitle')) AS subtitles,
      SUM(CASE WHEN t.anime_id IS NOT NULL AND ${isUnread} THEN 1 ELSE 0 END) AS unread
    FROM messages m LEFT JOIN tracked_anime t ON t.anime_id = m.anime_id AND t.blacklisted_at IS NULL
    ${readJoin}
    WHERE m.anime_id = ? GROUP BY ${season}, ${episode}
    ORDER BY ${season} IS NOT NULL, ${season}, ${episode} IS NULL, ${episode}
  `);
  const list = db.prepare(`
    WITH unread_groups AS (
      SELECT m.anime_id, ${season} AS season, ${episode} AS episode
      FROM tracked_anime t JOIN messages m ON m.anime_id = t.anime_id
      ${readJoin}
      WHERE t.blacklisted_at IS NULL AND ${isUnread}
      GROUP BY m.anime_id, ${season}, ${episode}
    ), counts AS (
      SELECT anime_id, COUNT(*) AS unread FROM unread_groups GROUP BY anime_id
    )
    SELECT a.id, a.title, a.year, COALESCE(c.unread, 0) AS unread
    FROM tracked_anime t JOIN anime a ON a.id = t.anime_id LEFT JOIN counts c ON c.anime_id = t.anime_id
    WHERE t.blacklisted_at IS NULL
    ORDER BY (c.unread IS NOT NULL) DESC, t.tracked_at DESC, a.id
  `);
  const markRead = db.prepare(`
    INSERT INTO episode_reads(anime_id, season, episode, source_id, message_id, attachments, text)
    SELECT m.anime_id, COALESCE(${season}, -1), COALESCE(${episode}, -1), m.source_id, m.id, m.attachments, m.text
    FROM messages m JOIN tracked_anime t ON t.anime_id = m.anime_id
    WHERE t.blacklisted_at IS NULL AND m.anime_id = $id
      AND ($scope = 'all' OR ${season} IS $season)
      AND ($scope <> 'episode' OR ${episode} IS $episode)
      AND (m.result IS NOT NULL OR m.manual_anime_id IS NOT NULL)
    ON CONFLICT(anime_id, season, episode, source_id, message_id)
    DO UPDATE SET attachments = excluded.attachments, text = excluded.text
  `);
  const membership = db.prepare('SELECT blacklisted_at FROM tracked_anime WHERE anime_id = ?');
  const setMembership = db.prepare(`
    INSERT INTO tracked_anime (anime_id, tracked_at, blacklisted_at) VALUES (?, ?, ?)
    ON CONFLICT(anime_id) DO UPDATE SET tracked_at = excluded.tracked_at, blacklisted_at = excluded.blacklisted_at
    WHERE (tracked_anime.blacklisted_at IS NULL) <> (excluded.blacklisted_at IS NULL)
  `);
  const blacklist = db.prepare(`
    SELECT a.id, a.title, a.year FROM tracked_anime t JOIN anime a ON a.id = t.anime_id
    WHERE t.blacklisted_at IS NOT NULL ORDER BY t.blacklisted_at DESC, a.id
  `);
  return {
    groups: id => groups.all(id),
    membership(id) {
      const row = membership.get(id);
      return { tracked: Boolean(row && row.blacklisted_at === null), blacklisted: row?.blacklisted_at != null };
    },
    setMembership(id, status) {
      const now = Date.now();
      setMembership.run(id, now, status === 'blacklisted' ? now : null);
    },
    list: () => list.all(),
    blacklist: () => blacklist.all(),
    markRead: (id, season, episode) => markRead.run({ id, scope: 'episode', season, episode }),
    markSeriesRead: (id, season) => markRead.run({ id, scope: season === undefined ? 'all' : 'season', season: season ?? null, episode: null }),
    merge(sourceId, targetId) {
      db.prepare(`
        INSERT INTO tracked_anime (anime_id, tracked_at, blacklisted_at)
        SELECT ?, tracked_at, blacklisted_at FROM tracked_anime WHERE anime_id = ?
        ON CONFLICT(anime_id) DO UPDATE SET tracked_at = MIN(tracked_anime.tracked_at, excluded.tracked_at),
          blacklisted_at = COALESCE(tracked_anime.blacklisted_at, excluded.blacklisted_at)
      `).run(targetId, sourceId);
      db.prepare(`
        INSERT INTO episode_reads (anime_id, season, episode, source_id, message_id, attachments, text)
        SELECT ?, season, episode, r.source_id, r.message_id, r.attachments, r.text
        FROM episode_reads r JOIN messages m ON m.source_id = r.source_id AND m.id = r.message_id
        WHERE r.anime_id = ? AND m.anime_id = r.anime_id AND m.attachments = r.attachments AND m.text = r.text
        ON CONFLICT(anime_id, season, episode, source_id, message_id) DO UPDATE
        SET attachments = excluded.attachments, text = excluded.text
      `).run(targetId, sourceId);
    }
  };
}

module.exports = { openTracking, dubbedVideo, subtitledVideo, readJoin, isUnread };
