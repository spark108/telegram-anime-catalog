const { setTimeout: wait } = require('node:timers/promises');
const { toDataURL } = require('qrcode');
const { parseCredentials, readCredentials, saveCredentials, credentialFingerprint } = require('./telegram-config');

function createTelegram(catalog) {
  let library;
  let client;
  let ready = false;
  let step = 'phone';
  let message = '';
  let attempt;
  const cachedDialogs = catalog.setting('telegramDialogs');
  let dialogs = new Map((cachedDialogs?.items ?? []).map(dialog => [dialog.id, dialog]));
  let dialogsRefreshedAt = cachedDialogs?.refreshedAt ?? null;
  const forumTopics = new Map(Object.entries(catalog.setting('sourceForumTopics') ?? {}));
  const forumRefreshes = new Map();
  let dialogRefresh;
  let retryAt = 0;
  const errors = new Map();

  function load() {
    if (!library) {
      try {
        library = { ...require('telegram'), ...require('telegram/sessions'), bigInt: require('big-integer') };
      } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
        throw new Error('Установите зависимости командой npm install.');
      }
    }
    return library;
  }

  function ensureActive(current) {
    if (attempt !== current) throw new Error('Вход отменён.');
  }

  function ask(current, nextStep) {
    ensureActive(current);
    current.qr = null;
    step = nextStep;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => current.prompt.reject('Время ожидания истекло.'), 5 * 60_000);
      current.prompt = {
        resolve(value) {
          clearTimeout(timeout);
          current.prompt = null;
          step = 'connecting';
          message = '';
          resolve(value);
        },
        reject(reason) {
          clearTimeout(timeout);
          current.prompt = null;
          reject(new Error(reason));
        }
      };
    });
  }

  async function signInByQr(candidate, credentials, current, authParams) {
    const { Api } = load();
    const { Raw } = require('telegram/events');
    const event = new Raw({ types: [Api.UpdateLoginToken] });
    let update = new AbortController();
    const onLoginToken = () => update.abort();
    candidate.addEventHandler(onLoginToken, event);
    const exportToken = () => candidate.invoke(new Api.auth.ExportLoginToken({
      apiId: credentials.apiId, apiHash: credentials.apiHash, exceptIds: []
    }));
    try {
      while (true) {
        ensureActive(current);
        update = new AbortController();
        let result = await exportToken();
        ensureActive(current);
        if (result instanceof Api.auth.LoginTokenMigrateTo) {
          await candidate._switchDC(result.dcId);
          ensureActive(current);
          result = await candidate.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
          ensureActive(current);
        }
        if (result instanceof Api.auth.LoginTokenSuccess) return;
        if (!(result instanceof Api.auth.LoginToken)) throw new Error('Telegram вернул неизвестный ответ для входа по QR.');
        const expires = result.expires * 1000;
        const url = 'tg://login?token=' + result.token.toString('base64url');
        const image = await toDataURL(url, { width: 260, margin: 4 });
        ensureActive(current);
        current.qr = { image, expires };
        step = 'qr';
        const signal = AbortSignal.any([update.signal, current.abort.signal]);
        try {
          await wait(Math.max(250, expires - Date.now()), undefined, { signal });
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    } catch (error) {
      if (error.errorMessage !== 'SESSION_PASSWORD_NEEDED') throw error;
      ensureActive(current);
      current.qr = null;
      step = 'connecting';
      await candidate.signInWithPassword(credentials, authParams);
    } finally {
      candidate.removeEventHandler(onLoginToken, event);
    }
  }

  async function connect(credentials, { phone, qr } = {}) {
    const current = { abort: new AbortController() };
    attempt = current;
    step = 'connecting';
    message = '';
    try {
      const { TelegramClient, StringSession } = load();
      const candidate = new TelegramClient(new StringSession(credentials.session || ''), credentials.apiId, credentials.apiHash, {
        connectionRetries: 2, requestRetries: 2, floodSleepThreshold: 0
      });
      current.client = candidate;
      const authParams = {
        password: () => ask(current, 'password'),
        onError(error) {
          if (attempt !== current) return true;
          message = describe(error);
          rejectCredentials(error, credentials);
          return !['PHONE_CODE_INVALID', 'PASSWORD_HASH_INVALID'].includes(error.errorMessage);
        }
      };
      if (phone) {
        await candidate.start({
          ...authParams,
          phoneNumber: phone,
          phoneCode: () => ask(current, 'code'),
          firstName: () => { throw new Error('Для входа нужен существующий аккаунт Telegram.'); }
        });
      } else {
        await candidate.connect();
        ensureActive(current);
        if (qr) await signInByQr(candidate, credentials, current, authParams);
      }
      ensureActive(current);
      const me = await candidate.getMe();
      ensureActive(current);
      if (!me) throw new Error('Войдите в Telegram заново.');
      const account = String(me.id);
      if (catalog.setting('account') && catalog.setting('account') !== account) {
        throw new Error('Каталог связан с другим аккаунтом Telegram.');
      }
      saveCredentials(credentials);
      catalog.setSetting('rejectedTelegramApp', null);
      catalog.setSetting('account', account);
      catalog.setSetting('telegram', { session: candidate.session.save() });
      appCredentials = { apiId: credentials.apiId, apiHash: credentials.apiHash };
      client = candidate;
      attempt = null;
      ready = true;
      step = 'ready';
      message = '';
    } catch (error) {
      if (attempt === current) {
        rejectCredentials(error, credentials);
        attempt = null;
        if (error.message !== 'AUTH_USER_CANCEL' || !message) message = describe(error);
        step = 'phone';
      }
      await current.client?.disconnect().catch(() => {});
    }
  }

  function rejectCredentials(error, credentials) {
    if (!/\b(?:API_ID_INVALID|API_ID_PUBLISHED_FLOOD)\b/.test(describe(error))) return;
    const saved = readCredentials();
    if (!saved || credentialFingerprint(saved) !== credentialFingerprint(credentials)) return;
    catalog.setSetting('rejectedTelegramApp', credentialFingerprint(saved));
    appCredentials = null;
  }

  function configuredCredentials() {
    const credentials = readCredentials();
    if (credentials && credentialFingerprint(credentials) !== catalog.setting('rejectedTelegramApp')) return credentials;
    return null;
  }

  function inputPeer(source) {
    const { Api, bigInt } = load();
    const { type, id, hash } = JSON.parse(source.peer);
    if (type === 'InputPeerSelf') return new Api.InputPeerSelf();
    if (type === 'InputPeerChat') return new Api.InputPeerChat({ chatId: bigInt(id) });
    if (type === 'InputPeerUser') return new Api.InputPeerUser({ userId: bigInt(id), accessHash: bigInt(hash) });
    return new Api.InputPeerChannel({ channelId: bigInt(id), accessHash: bigInt(hash) });
  }

  function requireClient() {
    if (!ready) throw new Error('Сначала войдите в Telegram.');
    return client;
  }

  async function sync(source, history) {
    if (!ready || !source.analyzer || Date.now() < retryAt || (history && (source.head === null || source.history_done))) return;
    const options = history
      ? { limit: 30, offsetId: source.cursor }
      : source.head === null ? { limit: 1 } : { limit: 30, reverse: true, minId: source.head };
    const errorKey = source.id + (history ? ':history' : ':new');
    const active = client;
    try {
      const topicId = JSON.parse(source.peer).topicId;
      if (topicId > 1) options.replyTo = topicId;
      const rows = await active.getMessages(inputPeer(source), options);
      if (client !== active) return;
      // The General topic has no root thread. Advance using the full page, even if none belongs to it.
      const messages = (topicId === 1 ? rows.filter(row => messageTopicId(row) === 1) : rows).map(serialize);
      const ids = rows.map(row => row.id);
      const current = catalog.source(source.id);
      if (!current?.attached || !current.analyzer) return;
      if (history) {
        catalog.ingest(current, messages, {
          cursor: rows.length ? Math.min(...ids) : source.cursor,
          done: !rows.length
        });
      } else if (source.head === null) {
        const latest = ids[0] ?? 0;
        catalog.ingest(current, messages, { head: latest, cursor: latest, done: latest === 0 });
      } else if (rows.length) {
        catalog.ingest(current, messages, { head: Math.max(...ids) });
      }
      errors.delete(errorKey);
    } catch (error) {
      if (client !== active) return;
      errors.set(errorKey, describe(error));
      if (Number(error.seconds) > 0) retryAt = Date.now() + (error.seconds + 1) * 1000;
    }
  }

  function schedule(history, delay) {
    let index = 0;
    const run = async () => {
      try {
        const sources = catalog.sources().filter(source => source.analyzer && (!history || !source.history_done));
        if (sources.length) {
          const source = sources[index++ % sources.length];
          if (history) catalog.reanalyze(source);
          await sync(source, history);
        }
      } catch (error) {
        console.error('Ошибка синхронизации:', describe(error));
      } finally {
        setTimeout(run, delay).unref();
      }
    };
    setTimeout(run, delay).unref();
  }

  // Reanalysis also runs after a channel's history is fully imported.
  schedule(false, 4000);
  schedule(true, 2500);
  const reanalysis = setInterval(() => {
    for (const source of catalog.sources().filter(source => source.analyzer && source.history_done)) {
      try { catalog.reanalyze(source); } catch (error) { console.error(describe(error)); }
    }
  }, 2500);
  reanalysis.unref();

  async function collectDialogs(active) {
    const next = new Map();
    for await (const dialog of active.iterDialogs({})) {
      const peer = dialog.inputEntity;
      if (!['InputPeerSelf', 'InputPeerChat', 'InputPeerUser', 'InputPeerChannel'].includes(peer?.className)) continue;
      const entity = dialog.entity;
      const type = entity?.broadcast ? 'channel'
        : peer.className === 'InputPeerChat' || entity?.megagroup || entity?.gigagroup ? 'group' : null;
      next.set(String(dialog.id), {
        id: String(dialog.id),
        title: dialog.title || 'Избранное',
        username: entity?.username || null,
        type, forum: type === 'group' && Boolean(entity?.forum),
        canPost: canPublishTo(entity, type),
        peer: {
          type: peer.className,
          id: String(peer.channelId ?? peer.chatId ?? peer.userId ?? 0),
          hash: String(peer.accessHash ?? 0)
        }
      });
    }
    if (client !== active) throw new Error('Соединение с Telegram завершено.');
    const refreshedAt = Date.now();
    catalog.setSetting('telegramDialogs', { refreshedAt, items: [...next.values()] });
    dialogs = next;
    dialogsRefreshedAt = refreshedAt;
  }

  async function forumTopicPage(active, group, offsets) {
    const { Api, bigInt } = load();
    const args = { ...offsets, limit: 50 };
    const result = await active.invoke(Api.messages.GetForumTopics
      ? new Api.messages.GetForumTopics({ ...args, peer: inputPeer({ peer: JSON.stringify(group.peer) }) })
      : new Api.channels.GetForumTopics({ ...args, channel: new Api.InputChannel({
        channelId: bigInt(group.peer.id), accessHash: bigInt(group.peer.hash)
      }) }));
    const rows = result.topics.filter(topic => topic instanceof Api.ForumTopic);
    const last = rows.at(-1);
    const next = last && result.count > result.topics.length && last.id !== offsets.offsetTopic ? {
      offsetDate: result.orderByCreateDate ? last.date
        : result.messages.find(message => message.id === last.topMessage)?.date ?? last.date,
      offsetId: last.topMessage, offsetTopic: last.id
    } : null;
    return { rows, next };
  }

  async function collectSourceTopics(active, group) {
    const items = new Map();
    let offsets = { offsetDate: 0, offsetId: 0, offsetTopic: 0 };
    const visited = new Set();
    while (offsets && !visited.has(offsets.offsetTopic)) {
      visited.add(offsets.offsetTopic);
      const { rows, next } = await forumTopicPage(active, group, offsets);
      for (const topic of rows) {
        if (topic.hidden) continue;
        const id = group.id + ':' + topic.id;
        items.set(id, { id, topicId: topic.id, title: topic.title });
      }
      offsets = next;
    }
    if (client !== active) throw new Error('Соединение с Telegram завершено.');
    const entry = { refreshedAt: Date.now(), items: [...items.values()] };
    const next = new Map(forumTopics).set(group.id, entry);
    catalog.setSetting('sourceForumTopics', Object.fromEntries(next));
    forumTopics.set(group.id, entry);
  }

  const saved = catalog.setting('telegram');
  const legacy = catalog.setting('telegramApp');
  let appCredentials = readCredentials();
  const previousCredentials = parseCredentials(saved?.apiId, saved?.apiHash) ?? parseCredentials(legacy?.apiId, legacy?.apiHash);
  if (!appCredentials && previousCredentials) {
    saveCredentials(previousCredentials);
    appCredentials = previousCredentials;
  }
  if (saved && ('apiId' in saved || 'apiHash' in saved)) catalog.setSetting('telegram', saved.session ? { session: saved.session } : null);
  if (legacy) catalog.setSetting('telegramApp', null);
  appCredentials = configuredCredentials();
  if (saved?.session && appCredentials) void connect({ ...appCredentials, session: saved.session });

  return {
    status() {
      if (step === 'phone') appCredentials = configuredCredentials();
      return {
        step, message, canCancel: Boolean(attempt), configured: Boolean(appCredentials),
        qr: attempt?.qr?.expires > Date.now() ? attempt.qr : undefined
      };
    },
    errors: id => [errors.get(id + ':new'), errors.get(id + ':history')].filter(Boolean),
    login({ apiId, apiHash, phone }, qr = false) {
      if (step !== 'phone') throw new Error('Вход уже запущен.');
      appCredentials = configuredCredentials();
      const credentials = parseCredentials(apiId || appCredentials?.apiId, String(apiHash || appCredentials?.apiHash || '').trim());
      phone = String(phone || '').trim();
      if (!credentials) throw new Error('Проверьте API ID и API Hash.');
      if (!qr && !/^\+?\d{7,15}$/.test(phone)) throw new Error('Проверьте номер телефона.');
      void connect(credentials, { phone: qr ? null : phone, qr });
    },
    answer(kind, value) {
      const prompt = attempt?.prompt;
      if (!prompt || step !== kind || typeof value !== 'string' || !value.trim() || value.length > 1024) {
        throw new Error('Нет активного запроса для этого поля.');
      }
      prompt.resolve(kind === 'code' ? value.trim() : value);
    },
    cancel() {
      const current = attempt;
      if (!current) return;
      attempt = null;
      step = 'phone';
      message = '';
      current.abort.abort();
      current.prompt?.reject('Вход отменён.');
      void current.client?.disconnect().catch(() => {});
    },
    async logout() {
      const active = requireClient();
      catalog.setSetting('telegram', null);
      ready = false;
      client = null;
      step = 'phone';
      message = '';
      retryAt = 0;
      errors.clear();
      await active.disconnect().catch(() => {});
    },
    dialogs() {
      const items = [...dialogs.values()].filter(dialog => dialog.type === 'group' || dialog.type === 'channel')
        .map(({ id, title, username, type, forum }) => ({
          id, title, username, category: type === 'channel' ? 'channels' : forum ? 'groups' : 'chats',
          topics: forum ? forumTopics.get(id)?.items ?? null : undefined
        }));
      return { refreshedAt: dialogsRefreshedAt, items };
    },
    async refreshSourceTopics(id) {
      const active = requireClient();
      const group = dialogs.get(id);
      if (!group?.forum) throw new Error('Группа с темами не найдена.');
      const cached = forumTopics.get(id);
      if (cached && Date.now() - cached.refreshedAt < 5 * 60_000) return;
      const existing = forumRefreshes.get(id);
      if (existing?.client === active) return existing.pending;
      const pending = collectSourceTopics(active, group);
      forumRefreshes.set(id, { client: active, pending });
      try { await pending; } finally {
        if (forumRefreshes.get(id)?.pending === pending) forumRefreshes.delete(id);
      }
    },
    async previewSource(source) {
      const topicId = JSON.parse(source.peer).topicId;
      const rows = await requireClient().getMessages(inputPeer(source),
        topicId > 1 ? { limit: 30, replyTo: topicId } : { limit: 30 });
      return (topicId === 1 ? rows.filter(row => messageTopicId(row) === 1) : rows).map(serialize);
    },
    async refreshDialogs() {
      const active = requireClient();
      if (dialogRefresh?.client === active) return dialogRefresh.pending;
      const pending = collectDialogs(active);
      dialogRefresh = { client: active, pending };
      try { await pending; } finally {
        if (dialogRefresh?.pending === pending) dialogRefresh = undefined;
      }
    },
    async publicationDialogs() {
      await this.refreshDialogs();
      return [...dialogs.values()].filter(dialog => dialog.canPost)
        .map(({ id, title, username, type, forum, peer }) => ({ id, chatId: id, title, username, type, forum, peer }));
    },
    async publicationTopics(group, offsets) {
      const id = group.id;
      const { rows, next } = await forumTopicPage(requireClient(), group, offsets);
      const topics = [];
      for (const topic of rows) {
        const targetId = id + ':' + topic.id;
        if (topic.closed || topic.hidden) continue;
        const target = {
          id: targetId, chatId: id, title: group.title + ' → ' + topic.title, chatTitle: group.title,
          topicTitle: topic.title, topicId: topic.id, username: group.username, type: 'topic', peer: group.peer
        };
        topics.push(target);
      }
      return { topics, next };
    },
    async publishMedia({ source, destination, attachment, messageId, caption, mode, randomId }) {
      const active = requireClient();
      const { Api, bigInt } = load();
      const sourcePeer = inputPeer(source);
      const destinationPeer = inputPeer({ peer: JSON.stringify(destination.peer) });
      const send = async () => {
        const [message] = await active.getMessages(sourcePeer, { ids: [messageId] });
        if (!message?.document) throw new Error('Файл удалён или исходное сообщение недоступно.');
        if (message.noforwards || message.chat?.noforwards) throw new Error('Telegram запретил копировать вложение из источника.');
        if ((destination.chatId || destination.id) === source.id.split(':')[0] && destination.topicId) {
          if (messageTopicId(message) === destination.topicId) throw new Error('Вложение уже находится в этой теме.');
        }
        const current = serialize(message).attachments[0];
        if (current.kind !== attachment.kind || current.fileName !== attachment.fileName ||
            (attachment.size != null && current.size !== attachment.size) ||
            (attachment.documentId && current.documentId !== attachment.documentId)) {
          throw new Error('Вложение в исходном сообщении изменилось.');
        }
        if (mode === 'forward' || mode === 'original-caption') {
          return active.invoke(new Api.messages.ForwardMessages({
            fromPeer: sourcePeer, toPeer: destinationPeer, id: [messageId], randomId: [bigInt(randomId)],
            topMsgId: destination.topicId > 1 ? destination.topicId : undefined,
            dropAuthor: mode === 'original-caption' ? true : undefined
          }));
        }
        const { id, accessHash, fileReference } = message.document;
        return active.invoke(new Api.messages.SendMedia({
          peer: destinationPeer,
          media: new Api.InputMediaDocument({
            id: new Api.InputDocument({ id, accessHash, fileReference }),
            spoiler: message.media?.spoiler
          }),
          replyTo: destination.topicId > 1 ? new Api.InputReplyToMessage({ replyToMsgId: destination.topicId }) : undefined,
          message: caption, randomId: bigInt(randomId)
        }));
      };
      let result;
      try {
        result = await send();
      } catch (error) {
        if (!/^FILE_REFERENCE_(?:\d+_)?(?:EXPIRED|INVALID)$/.test(error.errorMessage || '')) throw error;
        result = await send();
      }
      if (result instanceof Api.UpdateShortSentMessage) return result.id;
      const mapping = result.updates?.find(update => update instanceof Api.UpdateMessageID && String(update.randomId) === randomId);
      const posted = result.updates?.find(update => update instanceof Api.UpdateNewChannelMessage || update instanceof Api.UpdateNewMessage);
      return mapping?.id ?? posted?.message?.id ?? null;
    },
    addSources(ids) {
      requireClient();
      const selected = [...new Set(ids)].map(id => {
        const [chatId, topicId] = id.split(':');
        const dialog = dialogs.get(chatId);
        if (dialog?.forum && topicId) {
          const topic = forumTopics.get(chatId)?.items.find(item => item.id === id);
          if (topic) return { ...dialog, id, title: dialog.title + ' → ' + topic.title, peer: { ...dialog.peer, topicId: topic.topicId } };
        }
        if (dialog && !dialog.forum && !topicId) return dialog;
        throw new Error('Обновите список чатов и выберите источник.');
      });
      catalog.addSources(selected);
      // Scheduled sync establishes the initial cursor before history starts.
    }
  };
}

function messageTopicId(message) {
  if (message.action?.className === 'MessageActionTopicCreate') return message.id;
  const reply = message.replyTo;
  return reply?.forumTopic ? (reply.replyToTopId ?? reply.replyToMsgId ?? 1) : 1;
}

function canPublishTo(entity, type) {
  if (!entity || entity.left || entity.kicked || entity.deactivated || entity.migratedTo) return false;
  if (type === 'channel') return Boolean(entity.creator || entity.adminRights?.postMessages);
  if (type !== 'group' || entity.className === 'ChatForbidden' || entity.className === 'ChannelForbidden') return false;
  if (entity.creator || entity.adminRights) return true;
  if (entity.gigagroup) return false;
  const restrictions = [entity.bannedRights, entity.defaultBannedRights].filter(Boolean);
  return !restrictions.some(rights => rights.viewMessages || rights.sendMessages || rights.sendMedia) &&
    !(restrictions.some(rights => rights.sendVideos) && restrictions.some(rights => rights.sendDocs));
}

function describe(error) {
  return String(error.errorMessage || error.message || error).slice(0, 400);
}

function serialize(message) {
  const attachments = [];
  const document = message.document;
  if (document) {
    const fileName = document.attributes?.find(attribute => attribute.className === 'DocumentAttributeFilename')?.fileName || null;
    const mimeType = document.mimeType || null;
    const video = document.attributes?.find(attribute => attribute.className === 'DocumentAttributeVideo');
    const kind = video || mimeType?.startsWith('video/') ? 'video'
      : /\.(ass|ssa|srt|vtt|sub|sup)$/i.test(fileName || '') ? 'subtitle' : 'file';
    attachments.push({
      kind, fileName, mimeType, size: document.size == null ? null : String(document.size), documentId: String(document.id),
      width: video?.w ?? null, height: video?.h ?? null
    });
  } else if (message.photo) {
    attachments.push({ kind: 'photo', fileName: null, mimeType: 'image/jpeg' });
  }
  return { id: message.id, date: message.date ?? null, text: message.message || '', attachments };
}

module.exports = { createTelegram };
