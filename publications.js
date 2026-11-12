const { randomBytes } = require('node:crypto');
const { defaultCaption, readDefaultCaption, compileCaption, migrateCaption, renderCaption } = require('./caption');

function openPublicationStore(db, transaction) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS publications (
      id INTEGER PRIMARY KEY, request_id TEXT NOT NULL, source_id TEXT NOT NULL, message_id INTEGER NOT NULL,
      attachment_index INTEGER NOT NULL, destination_id TEXT NOT NULL, destination TEXT NOT NULL,
      attachment TEXT NOT NULL, caption TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'template', random_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending', error TEXT, sent_message_id INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_attempt INTEGER NOT NULL,
      retries INTEGER NOT NULL DEFAULT 0, UNIQUE(request_id, destination_id)
    );
    CREATE INDEX IF NOT EXISTS publications_attachment ON publications(source_id, message_id, attachment_index, destination_id, id);
    CREATE INDEX IF NOT EXISTS publications_queue ON publications(status, next_attempt, id);
    CREATE TABLE IF NOT EXISTS publication_inventory (
      id TEXT PRIMARY KEY, parent_id TEXT REFERENCES publication_inventory(id) ON DELETE CASCADE,
      data TEXT NOT NULL, topics_checked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS publication_inventory_parent ON publication_inventory(parent_id);
  `);
  if (!db.prepare('PRAGMA table_info(publications)').all().some(column => column.name === 'mode')) {
    db.exec("ALTER TABLE publications ADD COLUMN mode TEXT NOT NULL DEFAULT 'template'");
  }

  const insert = db.prepare(`
    INSERT INTO publications(request_id, source_id, message_id, attachment_index, destination_id, destination,
      attachment, caption, mode, random_id, created_at, updated_at, next_attempt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const requested = db.prepare('SELECT source_id, message_id, attachment_index FROM publications WHERE request_id = ? LIMIT 1');
  const putDestination = db.prepare(`
    INSERT INTO publication_inventory(id, parent_id, data) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data
  `);
  return {
    replaceChats(chats) {
      transaction(() => {
        const ids = JSON.stringify(chats.map(chat => chat.id));
        db.prepare(`
          DELETE FROM publication_inventory WHERE parent_id IS NULL AND id NOT IN (SELECT value FROM json_each(?))
        `).run(ids);
        for (const chat of chats) putDestination.run(chat.id, null, JSON.stringify(chat));
        db.exec(`
          DELETE FROM publication_inventory WHERE parent_id IN (
            SELECT id FROM publication_inventory WHERE parent_id IS NULL AND json_extract(data, '$.forum') IS NOT 1
          );
          UPDATE publication_inventory SET topics_checked_at = NULL
          WHERE parent_id IS NULL AND topics_checked_at IS NOT NULL AND json_extract(data, '$.forum') IS NOT 1;
        `);
      });
    },
    replaceTopics(chatId, topics) {
      transaction(() => {
        db.prepare('DELETE FROM publication_inventory WHERE parent_id = ?').run(chatId);
        for (const topic of topics) putDestination.run(topic.id, chatId, JSON.stringify(topic));
        db.prepare('UPDATE publication_inventory SET topics_checked_at = ? WHERE id = ?').run(Date.now(), chatId);
      });
    },
    forums: now => db.prepare(`
      SELECT data FROM publication_inventory WHERE parent_id IS NULL AND json_extract(data, '$.forum') = 1
        AND (topics_checked_at IS NULL OR topics_checked_at <= ?)
      ORDER BY topics_checked_at, id
    `).all(now).map(row => JSON.parse(row.data)),
    inventory: () => db.prepare('SELECT data, topics_checked_at FROM publication_inventory').all()
      .map(row => ({ ...JSON.parse(row.data), topicsChecked: row.topics_checked_at != null })),
    destination: id => {
      const row = db.prepare("SELECT data FROM publication_inventory WHERE id = ? AND json_extract(data, '$.forum') IS NOT 1").get(id);
      return row ? JSON.parse(row.data) : null;
    },
    request: id => requested.get(id),
    queue({ requestId, sourceId, messageId, index, targets, attachment, mode }) {
      transaction(() => {
        if (requested.get(requestId)) return;
        const now = Date.now();
        for (const { destination, caption } of targets) {
          const randomId = randomBytes(8).readBigInt64LE().toString();
          insert.run(requestId, sourceId, messageId, index, destination.id, JSON.stringify(destination),
            JSON.stringify(attachment), caption, mode, randomId, now, now, now);
        }
      });
    },
    next: now => db.prepare(
      "SELECT * FROM publications WHERE status = 'pending' AND next_attempt <= ? ORDER BY id LIMIT 1"
    ).get(now),
    retry: (id, nextAttempt) => db.prepare(
      "UPDATE publications SET retries = retries + 1, next_attempt = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
    ).run(nextAttempt, Date.now(), id),
    finish: (id, status, error, messageId) => db.prepare(
      "UPDATE publications SET status = ?, error = ?, sent_message_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
    ).run(status, error, messageId, Date.now(), id),
    summary(keys) {
      if (!keys.length) return [];
      return db.prepare(`
        WITH requested AS (
          SELECT DISTINCT json_extract(value, '$.sourceId') AS source_id,
            json_extract(value, '$.messageId') AS message_id, json_extract(value, '$.index') AS attachment_index
          FROM json_each(?)
        ), ranked AS (
          SELECT p.source_id, p.message_id, p.attachment_index, p.destination_id, p.destination,
            p.status, p.error, p.sent_message_id, p.updated_at,
            ROW_NUMBER() OVER (attachment ORDER BY p.id DESC) AS newest,
            COUNT(*) FILTER (WHERE p.status = 'published') OVER attachment AS count
          FROM requested r JOIN publications p USING (source_id, message_id, attachment_index)
          WINDOW attachment AS (PARTITION BY p.source_id, p.message_id, p.attachment_index, p.destination_id)
        )
        SELECT source_id AS sourceId, message_id AS messageId, attachment_index AS "index", destination_id AS channelId,
          json_extract(destination, '$.title') AS channel, json_extract(destination, '$.username') AS username,
          COALESCE(json_extract(destination, '$.chatId'), destination_id) AS chatId,
          json_extract(destination, '$.topicId') AS topicId,
          status, error, sent_message_id AS sentMessageId, updated_at AS updatedAt, count
        FROM ranked WHERE newest = 1 ORDER BY channel
      `).all(JSON.stringify(keys));
    }
  };
}

function createPublisher(catalog, telegram) {
  const store = catalog.publications;
  const previous = catalog.setting('publication');
  if (!previous) {
    compileCaption(defaultCaption, true);
    catalog.setSetting('publication', { destinations: [], template: defaultCaption, templateFormat: 'js' });
  } else if (previous.templateFormat !== 'js') {
    catalog.setSetting('publication', { ...previous, template: migrateCaption(previous.template), templateFormat: 'js' });
  }
  let pausedUntil = 0;
  let nextChatRefresh = 0;
  let discoveryPausedUntil = 0;
  let activeForum;
  const topicRetries = new Map();

  function settings() {
    const stored = catalog.setting('publication');
    return {
      destinations: stored?.destinations ?? stored?.channels ?? [], template: stored?.template ?? defaultCaption,
      originalCaption: stored?.originalCaption === true, originalAuthor: stored?.originalAuthor === true
    };
  }

  function publicSettings() {
    const { destinations, ...options } = settings();
    return {
      destinations: destinations.map(({ id, title, username, type, chatId, chatTitle, topicId, topicTitle }) => ({
        id, title, username, type: type || 'channel', chatId: chatId || id, chatTitle, topicId, topicTitle
      })),
      ...options
    };
  }

  async function discover() {
    let refreshingChats = false;
    try {
      const now = Date.now();
      if (telegram.status().step !== 'ready' || now < discoveryPausedUntil) return;
      if (now >= nextChatRefresh) {
        refreshingChats = true;
        const chats = await telegram.publicationDialogs();
        store.replaceChats(chats);
        catalog.setSetting('publicationInventoryUpdated', Date.now());
        nextChatRefresh = Date.now() + 2 * 60_000;
        if (activeForum && !chats.some(chat => chat.forum && chat.id === activeForum.group.id)) activeForum = null;
        return;
      }
      if (!activeForum) {
        const group = store.forums(now - 5 * 60_000).find(forum => now >= (topicRetries.get(forum.id) || 0));
        if (!group) return;
        activeForum = { group, topics: new Map(), offset: { offsetDate: 0, offsetId: 0, offsetTopic: 0 } };
      }
      const { group, topics, offset } = activeForum;
      const page = await telegram.publicationTopics(group, offset);
      for (const topic of page.topics) topics.set(topic.id, topic);
      if (page.next) {
        activeForum.offset = page.next;
      } else {
        store.replaceTopics(group.id, [...topics.values()]);
        topicRetries.delete(group.id);
        activeForum = null;
      }
    } catch (error) {
      const seconds = Number(error.seconds);
      discoveryPausedUntil = Date.now() + (seconds > 0 ? seconds + 1 : 10) * 1000;
      if (refreshingChats) nextChatRefresh = discoveryPausedUntil;
      else if (activeForum) {
        topicRetries.set(activeForum.group.id, Date.now() + 60_000);
        activeForum = null;
      }
      console.warn('Telegram, список мест публикации:', error.errorMessage || error.message);
    } finally {
      setTimeout(discover, 2600).unref();
    }
  }
  setTimeout(discover, 800).unref();

  function summarize(keys) {
    return store.summary(keys);
  }

  async function work() {
    let job;
    try {
      if (telegram.status().step !== 'ready' || Date.now() < pausedUntil) return;
      job = store.next(Date.now());
      if (!job) return;
      const source = catalog.source(job.source_id);
      if (!source) throw new Error('Источник сообщения недоступен.');
      const messageId = await telegram.publishMedia({
        source, destination: JSON.parse(job.destination), attachment: JSON.parse(job.attachment),
        messageId: job.message_id, caption: job.caption, mode: job.mode, randomId: job.random_id
      });
      store.finish(job.id, 'published', null, messageId);
    } catch (error) {
      if (!job) {
        console.error('Ошибка очереди публикации:', error.message);
        return;
      }
      const code = String(error.errorMessage || error.message || error);
      const seconds = Number(error.seconds);
      if (code === 'RANDOM_ID_DUPLICATE') {
        store.finish(job.id, 'published', null, null);
      } else if (seconds > 0) {
        pausedUntil = Date.now() + (seconds + 1) * 1000;
        store.retry(job.id, pausedUntil);
      } else if (job.retries < 3 && (Number(error.code) >= 500 || /timeout|timed out|ECONNRESET|ECONNREFUSED|EPIPE|not connected|disconnected|network/i.test(code))) {
        store.retry(job.id, Date.now() + (job.retries + 1) * 4000);
      } else {
        const known = {
          CHAT_FORWARDS_RESTRICTED: 'Telegram запретил копировать вложение из источника.',
          CHAT_WRITE_FORBIDDEN: 'Нет права публиковать в этот чат.',
          CHAT_ADMIN_REQUIRED: 'Для публикации нужны права администратора.',
          CHANNEL_PRIVATE: 'Чат недоступен текущему аккаунту.',
          CHAT_SEND_MEDIA_FORBIDDEN: 'В этом чате запрещена отправка медиа.',
          CHAT_SEND_VIDEOS_FORBIDDEN: 'В этом чате запрещена отправка видео.',
          CHAT_SEND_DOCS_FORBIDDEN: 'В этом чате запрещена отправка файлов.',
          TOPIC_CLOSED: 'Тема закрыта.',
          TOPIC_DELETED: 'Тема удалена.',
          MEDIA_CAPTION_TOO_LONG: 'Подпись слишком длинная для Telegram.'
        };
        store.finish(job.id, 'failed', known[code] || code.slice(0, 400), null);
      }
    } finally {
      setTimeout(work, 350).unref();
    }
  }
  setTimeout(work, 350).unref();

  return {
    settings: publicSettings,
    inventory() {
      return {
        refreshedAt: catalog.setting('publicationInventoryUpdated'),
        items: store.inventory().map(({ peer, ...destination }) => destination)
      };
    },
    save({ destinationIds, channelIds, template, originalCaption, originalAuthor }) {
      const ids = destinationIds ?? channelIds;
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
        throw new Error('Выберите места публикации.');
      }
      const saved = settings();
      originalCaption ??= saved.originalCaption;
      originalAuthor ??= saved.originalAuthor;
      if (typeof originalCaption !== 'boolean' || typeof originalAuthor !== 'boolean') {
        throw new Error('Некорректные настройки пересылки.');
      }
      if (originalCaption || originalAuthor) {
        template ??= saved.template;
        if (typeof template !== 'string' || template.length > 65536) {
          throw new Error('Введите JavaScript для подписи (до 65 536 символов).');
        }
      } else {
        compileCaption(template, true);
      }
      const existing = new Map(saved.destinations.map(destination => [destination.id, destination]));
      const destinations = [...new Set(ids)].map(id => {
        const destination = store.destination(id) || existing.get(id);
        if (!destination) throw new Error('Обновите список чатов и повторите выбор.');
        return destination;
      });
      catalog.setSetting('publication', { destinations, template, templateFormat: 'js', originalCaption, originalAuthor });
      return publicSettings();
    },
    resetTemplate() {
      const template = readDefaultCaption();
      compileCaption(template, true);
      catalog.setSetting('publication', { ...catalog.setting('publication'), template, templateFormat: 'js' });
      return { template };
    },
    summarize,
    publish({ requestId, sourceId, messageId, index, target }) {
      if (!/^[a-f0-9]{32}$/.test(requestId || '') || !validKey({ sourceId, messageId, index })) {
        throw new Error('Некорректный запрос публикации.');
      }
      const key = { sourceId, messageId, index };
      const previous = store.request(requestId);
      if (previous) {
        if (previous.source_id !== sourceId || previous.message_id !== messageId || previous.attachment_index !== index) {
          throw new Error('Этот запрос уже относится к другому вложению.');
        }
        return summarize([key]);
      }
      if (telegram.status().step !== 'ready') throw new Error('Сначала войдите в Telegram.');
      const row = catalog.publicationItem(sourceId, messageId);
      const attachment = row?.attachments[index];
      if (!attachment || !['video', 'subtitle'].includes(attachment.kind)) throw new Error('Видео или файл субтитров не найден.');
      const { destinations, template, originalCaption, originalAuthor } = settings();
      const selected = destinations.filter(destination => destination.id !== sourceId &&
        (target === 'all' || target === destination.id));
      if (!selected.length) throw new Error('Выберите место назначения в настройках публикации.');
      const mode = originalAuthor ? 'forward' : originalCaption ? 'original-caption' : 'template';
      const script = mode === 'template' ? compileCaption(template) : null;
      const targets = selected.map(destination => ({ destination, caption: script ? renderCaption(script, row, attachment, destination) : '' }));
      store.queue({ ...key, requestId, targets, attachment, mode });
      return summarize([key]);
    }
  };
}

function validKey({ sourceId, messageId, index } = {}) {
  return typeof sourceId === 'string' && /^-?\d+(?::[1-9]\d*)?$/.test(sourceId) &&
    Number.isSafeInteger(messageId) && messageId > 0 && Number.isSafeInteger(index) && index >= 0;
}

module.exports = { createPublisher, openPublicationStore, validKey };
