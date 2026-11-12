const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openCatalog } = require('./catalog');
const { analyze, compile, example } = require('./analyzer');
const { captionExample, previewCaption } = require('./caption');
const { createTelegram } = require('./telegram-client');
const { createShikimori } = require('./shikimori');
const { createPublisher, validKey } = require('./publications');

const host = '::';
const port = Number(process.env.ANIME_CATALOG_PORT || 8187);
const origin = `http://127.0.0.1:${port}`;
const directory = process.env.ANIME_CATALOG_DATA || path.join(__dirname, 'data');
fs.mkdirSync(directory, { recursive: true });
const catalog = openCatalog(path.join(directory, 'catalog.sqlite'));
const accessKey = catalog.setting('accessKey') || crypto.randomBytes(24).toString('base64url');
catalog.setSetting('accessKey', accessKey);
const telegram = createTelegram(catalog);
const shikimori = createShikimori(catalog);
const publisher = createPublisher(catalog, telegram);
const isLoopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
  [`127.0.0.1:${port}`, `[::1]:${port}`, `localhost:${port}`].includes(req.headers.host);
const files = {
  '/': ['public/index.html', 'text/html'],
  '/app.js': ['public/app.js', 'text/javascript'],
  '/style.css': ['public/style.css', 'text/css'],
  '/vendor/codemirror.css': ['node_modules/codemirror/lib/codemirror.css', 'text/css'],
  '/vendor/codemirror.js': ['node_modules/codemirror/lib/codemirror.js', 'text/javascript'],
  '/vendor/codemirror-javascript.js': ['node_modules/codemirror/mode/javascript/javascript.js', 'text/javascript']
};

const sourceSummary = ({ id, title, head, cursor, history_done, analyzer }) => ({
  id, title, head, cursor, historyDone: Boolean(history_done), configured: Boolean(analyzer), errors: telegram.errors(id)
});

async function body(req) {
  let data = '';
  for await (const chunk of req.setEncoding('utf8')) {
    data += chunk;
    if (data.length > 256_000) throw new Error('Слишком большой запрос.');
  }
  return JSON.parse(data);
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function requiredSource(id) {
  const source = catalog.source(id);
  if (!source?.attached) throw new Error('Источник не найден.');
  return source;
}

function optionalNumber(value) {
  if (value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Некорректный номер сезона или серии.');
  return number;
}

function withPublications(rows) {
  const keys = rows.flatMap(row => row.attachments.flatMap((file, index) => ['video', 'subtitle'].includes(file.kind)
    ? [{ sourceId: row.source_id, messageId: row.id, index }] : []));
  const byMessage = new Map();
  for (const state of publisher.summarize(keys)) {
    const key = state.sourceId + '/' + state.messageId;
    if (!byMessage.has(key)) byMessage.set(key, []);
    byMessage.get(key).push(state);
  }
  return rows.map(row => ({ ...row, publications: byMessage.get(row.source_id + '/' + row.id) || [] }));
}

async function api(req, url) {
  const route = req.method + ' ' + url.pathname;
  const query = url.searchParams;
  const before = Number(query.get('before') ?? Number.MAX_SAFE_INTEGER);
  const beforeSource = query.get('beforeSource') || '~';
  switch (route) {
    case 'GET /api/status':
      return {
        auth: telegram.status(), sources: catalog.sources().map(sourceSummary),
        accessKey: isLoopback(req) ? accessKey : undefined
      };
    case 'POST /api/login':
      telegram.login(await body(req));
      return {};
    case 'POST /api/login-qr':
      telegram.login(await body(req), true);
      return {};
    case 'POST /api/answer': {
      const { kind, value } = await body(req);
      telegram.answer(kind, value);
      return {};
    }
    case 'POST /api/cancel-login':
      telegram.cancel();
      return {};
    case 'POST /api/logout':
      await telegram.logout();
      return {};
    case 'GET /api/dialogs':
      return telegram.dialogs();
    case 'POST /api/dialogs':
      await telegram.refreshDialogs();
      return telegram.dialogs();
    case 'POST /api/source-topics': {
      const { id } = await body(req);
      await telegram.refreshSourceTopics(id);
      return telegram.dialogs();
    }
    case 'POST /api/source': {
      const { id, ids = [id] } = await body(req);
      if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !/^-?\d+(?::[1-9]\d*)?$/.test(id))) {
        throw new Error('Выберите источники для подключения.');
      }
      telegram.addSources(ids);
      return {};
    }
    case 'GET /api/source': {
      const source = requiredSource(query.get('id'));
      return { ...sourceSummary(source), code: source.analyzer || example, samples: catalog.samples(source.id) };
    }
    case 'GET /api/source-samples': {
      const source = requiredSource(query.get('id'));
      const samples = catalog.samples(source.id);
      return samples.length ? samples : telegram.previewSource(source);
    }
    case 'POST /api/detach-source': {
      const { id } = await body(req);
      if (typeof id !== 'string') throw new Error('Выберите источник.');
      catalog.detachSource(id);
      return {};
    }
    case 'POST /api/analyzer': {
      const { id, code } = await body(req);
      requiredSource(id);
      checkCode(code);
      catalog.saveAnalyzer(id, code);
      return {};
    }
    case 'GET /api/analyzer-library': {
      const folder = path.join(__dirname, 'analyzers');
      const available = fs.readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.js'))
        .map(entry => entry.name).sort((a, b) => a.localeCompare(b, 'ru'));
      const file = query.get('file');
      if (file === null) return available;
      if (!available.includes(file)) throw new Error('Анализатор не найден.');
      return { code: fs.readFileSync(path.join(folder, file), 'utf8').trimEnd() };
    }
    case 'POST /api/preview': {
      const { code, text, attachments } = await body(req);
      checkCode(code);
      if (typeof text !== 'string' || !Array.isArray(attachments) ||
        attachments.some(item => !item || typeof item !== 'object')) throw new Error('Проверьте текст и массив вложений.');
      return analyze(compile(code), { text, attachments });
    }
    case 'GET /api/catalog':
    case 'POST /api/catalog': {
      const { q = '', after = 0, filters } = req.method === 'POST' ? await body(req) :
        { q: query.get('q') || '', after: Number(query.get('after') || 0) };
      if (typeof q !== 'string' || !Number.isSafeInteger(after) || after < 0) throw new Error('Некорректный запрос каталога.');
      if (filters !== undefined) checkCatalogFilters(filters);
      const rows = catalog.list(q, after, filters);
      shikimori.prioritize(rows.map(row => row.id));
      return rows;
    }
    case 'GET /api/catalog-filters':
      return catalog.filterOptions();
    case 'GET /api/view-settings':
      return catalog.setting('viewSettings') ?? {};
    case 'POST /api/view-settings': {
      const { catalogFilters, episodeMaterial, initialCatalogFilters } = await body(req);
      const settings = catalog.setting('viewSettings') ?? {};
      if (initialCatalogFilters !== undefined) {
        checkCatalogFilters(initialCatalogFilters);
        settings.catalogFilters ??= initialCatalogFilters;
      }
      if (catalogFilters !== undefined) {
        checkCatalogFilters(catalogFilters);
        settings.catalogFilters = catalogFilters;
      }
      if (episodeMaterial !== undefined) settings.episodeMaterial = checkEpisodeMaterial(episodeMaterial);
      catalog.setSetting('viewSettings', settings);
      return settings;
    }
    case 'GET /api/anime':
      return catalog.details(Number(query.get('id')), before, beforeSource);
    case 'GET /api/anime-page': {
      const id = Number(query.get('id'));
      const page = catalog.animePage(id);
      if (!page) return null;
      shikimori.prioritize([page.anime.id], true);
      return page;
    }
    case 'POST /api/anime-merge': {
      const { sourceId, targetId } = await body(req);
      if (![sourceId, targetId].every(id => Number.isSafeInteger(id) && id > 0) || sourceId === targetId) {
        throw new Error('Выберите два разных тайтла для объединения.');
      }
      return { id: catalog.mergeAnime(sourceId, targetId) };
    }
    case 'GET /api/episode':
      return withPublications(catalog.episode(Number(query.get('id')), optionalNumber(query.get('season')),
        optionalNumber(query.get('episode')), before, beforeSource, checkEpisodeMaterial(query.get('material') ?? 'all')));
    case 'POST /api/episode-open': {
      const data = await body(req);
      const id = catalog.resolveAnime(Number(data.id));
      const season = optionalNumber(data.season);
      const episode = optionalNumber(data.episode);
      const material = checkEpisodeMaterial(data.material ?? 'all');
      catalog.tracking.markRead(id, season, episode);
      return withPublications(catalog.episode(id, season, episode, Number.MAX_SAFE_INTEGER, '~', material));
    }
    case 'GET /api/tracking':
      return query.get('list') === 'blacklist' ? catalog.tracking.blacklist() : catalog.tracking.list();
    case 'POST /api/anime-membership': {
      const { id, status } = await body(req);
      if (!Number.isSafeInteger(id) || id < 1 || !['tracked', 'blacklisted'].includes(status)) {
        throw new Error('Некорректный тайтл или список.');
      }
      return catalog.setAnimeMembership(id, status);
    }
    case 'GET /api/tracking-episodes':
    case 'POST /api/tracking-episodes': {
      const reading = req.method === 'POST';
      const request = reading ? await body(req) : { id: Number(query.get('id')) };
      if (reading && (!Number.isSafeInteger(request.id) || request.id < 1)) throw new Error('Некорректный тайтл.');
      const id = catalog.resolveAnime(request.id);
      if (reading) {
        const season = request.season === undefined ? undefined : optionalNumber(request.season);
        catalog.tracking.markSeriesRead(id, season);
      }
      return { ...catalog.tracking.membership(id), episodes: catalog.tracking.groups(id) };
    }
    case 'GET /api/anime-metadata': {
      const ids = (query.get('ids') || '').split(',').slice(0, 50).map(Number)
        .filter(id => Number.isSafeInteger(id) && id > 0);
      return catalog.metadata(ids);
    }
    case 'GET /api/review':
      return withPublications(catalog.review(before, beforeSource));
    case 'GET /api/publication-settings':
      return { ...publisher.settings(), captionExample };
    case 'POST /api/caption-preview': {
      const { code, data } = await body(req);
      return { caption: previewCaption(code, data) };
    }
    case 'GET /api/publication-inventory':
      return publisher.inventory();
    case 'POST /api/publication-settings':
      return publisher.save(await body(req));
    case 'POST /api/caption-reset':
      return publisher.resetTemplate();
    case 'POST /api/publish':
      return publisher.publish(await body(req));
    case 'POST /api/publication-status': {
      const keys = await body(req);
      if (!Array.isArray(keys) || keys.length > 100 || keys.some(key => !key || !validKey(key))) {
        throw new Error('Некорректные данные для проверки публикаций.');
      }
      return publisher.summarize(keys);
    }
    case 'POST /api/assign': {
      const { sourceId, messageId, animeId, title, year } = await body(req);
      if (animeId === null && (typeof title !== 'string' || !title.trim() || title.length > 500)) {
        throw new Error('Укажите название нового тайтла.');
      }
      if (year != null && !Number.isSafeInteger(year)) throw new Error('Введите год числом.');
      catalog.assign(sourceId, messageId, animeId, title?.trim(), year ?? null);
      return {};
    }
    default:
      return null;
  }
}

function checkEpisodeMaterial(material) {
  if (!['all', 'video', 'dubbed-video', 'subtitled-video', 'subtitle'].includes(material)) throw new Error('Неизвестный тип материалов.');
  return material;
}

function checkCatalogFilters(filters) {
  const strings = values => Array.isArray(values) && values.every(value => typeof value === 'string');
  if (!filters || typeof filters.onlyVoiceovers !== 'boolean' || typeof filters.onlySubtitles !== 'boolean' ||
      (filters.tracking !== undefined && !['all', 'tracked', 'untracked', 'blacklisted'].includes(filters.tracking)) ||
      (filters.onlyUnread !== undefined && typeof filters.onlyUnread !== 'boolean') ||
      (filters.includeBlacklist !== undefined && typeof filters.includeBlacklist !== 'boolean') ||
      !strings(filters.voiceovers) || !strings(filters.subtitles) ||
      !Array.isArray(filters.years) || !filters.years.every(Number.isSafeInteger)) {
    throw new Error('Некорректные значения фильтра каталога.');
  }
}

function checkCode(code) {
  if (typeof code !== 'string' || !code.trim() || code.length > 30_000) throw new Error('Введите JS-код анализатора (до 30 000 символов).');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'");
  if (!/^(?:[\w.-]+|\[[\da-f:.]+\]):\d+$/i.test(req.headers.host || '') ||
      (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) ||
      req.headers['sec-fetch-site'] === 'cross-site' ||
      (req.method === 'POST' && req.headers['content-type'] !== 'application/json')) {
    return send(res, 403, { error: 'Запрос отклонён.' });
  }
  try {
    const url = new URL(req.url, origin);
    const file = /^\/anime\/[1-9]\d*\/?$/.test(url.pathname) ? files['/']
      : Object.hasOwn(files, url.pathname) ? files[url.pathname] : null;
    if (file && req.method === 'GET') {
      const contents = fs.readFileSync(path.join(__dirname, file[0]));
      res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8' });
      return res.end(contents);
    }
    const supplied = Buffer.from(String(req.headers['x-catalog-key'] || ''));
    const expected = Buffer.from(accessKey);
    if (!isLoopback(req) &&
        (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected))) {
      return send(res, 401, { error: 'Введите ключ доступа из локального интерфейса.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/poster') {
      const poster = await shikimori.poster(catalog.resolveAnime(Number(url.searchParams.get('id'))));
      if (!poster) return send(res, 404, { error: 'Постер не найден.' });
      res.writeHead(200, {
        'Content-Type': poster.type, 'Content-Length': poster.image.byteLength,
        'Cache-Control': 'private, max-age=86400', Vary: 'X-Catalog-Key'
      });
      return res.end(poster.image);
    }
    const result = await api(req, url);
    send(res, result === null ? 404 : 200, result ?? { error: 'Маршрут не найден.' });
  } catch (error) {
    send(res, 400, { error: String(error.message || error).slice(0, 600) });
  }
});
server.on('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen({ port, host, ipv6Only: false }, () => console.log(`Listening on [${host}]:${port} (IPv4 and IPv6). Local: ${origin}`));
