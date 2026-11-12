const { setTimeout: wait } = require('node:timers/promises');

const origin = 'https://shikimori.io';
const userAgent = 'TelegramAnimeCatalog/0.1';
const hour = 60 * 60_000;
const maxImageSize = 2 * 1024 * 1024;

function createShikimori(catalog) {
  let priority = new Set();
  const posterRequests = new Map();
  let nextRequest = 0;
  let pausedUntil = 0;
  let nextPosterLookup = 0;

  async function request(route, params, body) {
    const url = new URL(route, origin);
    if (params) url.search = new URLSearchParams(params);
    await wait(Math.max(0, nextRequest - Date.now()));
    nextRequest = Date.now() + 850;
    const response = await fetch(url, {
      ...(body && { method: 'POST', body: JSON.stringify(body) }),
      headers: { 'User-Agent': userAgent, Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }) },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      if (response.status === 429) {
        const value = response.headers.get('Retry-After');
        const retryAfter = /^\d+$/.test(value || '') ? Number(value) * 1000 : Date.parse(value) - Date.now();
        pausedUntil = Date.now() + Math.max(30_000, retryAfter || 0);
      }
      await response.body?.cancel();
      throw new Error('Shikimori HTTP ' + response.status);
    }
    return response.json();
  }

  async function lookup(target) {
    const previous = JSON.parse(target.metadata);
    if (Number.isSafeInteger(previous?.id) && previous.id > 0) {
      const info = normalize(await request('/api/animes/' + previous.id));
      info.poster ??= posterUrl(previous.poster);
      return info;
    }
    const titles = [target.title, ...target.aliases];
    const queries = new Map(titles.map(title => [titleKey(title), title]));
    // Preserve the local display title as the primary search query.
    queries.set(titleKey(target.title), target.title);
    for (const search of [...queries.values()].slice(0, 3)) {
      const results = await request('/api/animes', { search, limit: 12 });
      if (!Array.isArray(results)) throw new Error('Неожиданный ответ Shikimori.');
      const match = selectMatch(results, target);
      if (!match) continue;
      const info = await request('/api/animes/' + match.id);
      return normalize(info);
    }
    return null;
  }

  async function lookupPosters(targets) {
    const ids = [...new Set(targets.map(target => target.shikimoriId))];
    const result = await request('/api/graphql', null, {
      query: 'query Posters($ids: String!, $limit: PositiveInt!) { animes(ids: $ids, limit: $limit) { id poster { mainUrl originalUrl } } }',
      variables: { ids: ids.join(','), limit: ids.length }
    });
    if (result.errors?.length || !Array.isArray(result.data?.animes)) throw new Error('Не удалось получить постеры Shikimori.');
    const posters = new Map(result.data.animes.map(({ id, poster }) => [Number(id),
      posterUrl(poster?.mainUrl) ?? posterUrl(poster?.originalUrl)]));
    for (const { id, shikimoriId } of targets) catalog.cacheShikimoriPoster(id, shikimoriId, posters.get(shikimoriId) ?? null);
  }

  async function work() {
    let target;
    try {
      if (Date.now() < pausedUntil) return;
      if (Date.now() >= nextPosterLookup) {
        const targets = catalog.shikimoriPosterTargets(priority);
        if (targets.length) {
          try { await lookupPosters(targets); } catch (error) {
            nextPosterLookup = Date.now() + 60_000;
            console.warn('Shikimori:', error.message);
          }
          return;
        }
      }
      for (const id of priority) {
        priority.delete(id);
        target = catalog.shikimoriTarget(Date.now(), id);
        if (target) break;
      }
      target ??= catalog.shikimoriTarget(Date.now());
      if (!target) return;
      const info = await lookup(target);
      catalog.cacheShikimori(target, info && JSON.stringify(info), Date.now() + (info ? 7 * 24 : 24) * hour);
    } catch (error) {
      pausedUntil = Math.max(pausedUntil, Date.now() + 15_000);
      if (target) catalog.cacheShikimori(target, target.metadata, Date.now() + 10 * 60_000);
      console.warn('Shikimori:', error.message);
    } finally {
      setTimeout(work, 650).unref();
    }
  }

  setTimeout(work, 200).unref();

  return {
    prioritize(ids, first = false) {
      if (first) priority = new Set([...ids, ...priority]);
      else for (const id of ids) priority.add(id);
    },
    async poster(id) {
      const cached = catalog.shikimoriPoster(id);
      if (!cached?.url) return null;
      if (cached.poster && cached.poster_url === cached.url) return { type: cached.poster_type, image: cached.poster };
      if (!posterRequests.has(id)) {
        const pending = downloadPoster(cached.url).then(poster => {
          catalog.cachePoster(id, cached.url, poster.type, poster.image);
          return poster;
        }).finally(() => posterRequests.delete(id));
        posterRequests.set(id, pending);
      }
      return posterRequests.get(id);
    }
  };
}

function titleKey(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е')
    .replace(/\s*\((?:19|20)\d{2}\)\s*$/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function selectMatch(rows, target) {
  const primary = titleKey(target.title);
  const aliases = new Set(target.aliases.map(titleKey).filter(Boolean));
  const ranked = rows.flatMap(row => {
    if (!Number.isSafeInteger(row.id) || row.id < 1 || (target.year && releaseYear(row) !== target.year)) return [];
    const names = [row.russian, row.name, ...(row.synonyms || [])].map(titleKey).filter(Boolean);
    const rank = names.includes(primary) ? 2 : names.some(name => aliases.has(name)) ? 1 : 0;
    return rank ? [{ row, rank }] : [];
  }).sort((a, b) => b.rank - a.rank);
  return ranked[0] && ranked[0].rank !== ranked[1]?.rank ? ranked[0].row : null;
}

function releaseYear(info) {
  return Number(String(info.aired_on || info.released_on || '').match(/^\d{4}/)?.[0]) || null;
}

function posterUrl(value) {
  if (!value || /\/missing_/.test(value)) return null;
  try {
    const url = new URL(value, origin);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !/(?:^|\.)(?:shikimori\.(?:io|one)|shiki\.one)$/i.test(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalize(info) {
  const description = String(info.description || '').replace(/\[\/?(?:\*|anime|manga|character|person|b|i|u|s|url|spoiler|quote|color|size|list|center)(?:=[^\]]*)?\]/gi, '').trim();
  const poster = posterUrl(info.image?.original) ?? posterUrl(info.image?.preview);
  return {
    id: info.id, originalTitle: info.name, russian: info.russian || null,
    year: releaseYear(info), status: info.status, kind: info.kind, score: Number(info.score) || null,
    episodes: Number(info.episodes) || null, description, poster,
    genres: (info.genres || []).map(genre => genre.russian || genre.name).filter(Boolean),
    studios: (info.studios || []).map(studio => studio.name).filter(Boolean)
  };
}

async function downloadPoster(value) {
  const signal = AbortSignal.timeout(10_000);
  let url = posterUrl(value);
  for (let redirects = 0; url && redirects < 4; redirects++) {
    const response = await fetch(url, { headers: { 'User-Agent': userAgent }, signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location');
      await response.body?.cancel();
      url = location ? posterUrl(new URL(location, url).href) : null;
      continue;
    }
    const type = response.headers.get('Content-Type')?.split(';')[0];
    if (!response.ok || !/^image\/(?:jpeg|png|webp|avif|gif)$/.test(type || '') ||
        Number(response.headers.get('Content-Length')) > maxImageSize || !response.body) {
      await response.body?.cancel();
      break;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxImageSize) throw new Error('Слишком большой постер.');
      chunks.push(chunk);
    }
    return { type, image: Buffer.concat(chunks, size) };
  }
  throw new Error('Постер Shikimori недоступен.');
}

module.exports = { createShikimori };
