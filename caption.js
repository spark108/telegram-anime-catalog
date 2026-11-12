const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const readDefaultCaption = () => fs.readFileSync(path.join(__dirname, 'templates', 'caption.js'), 'utf8').trimEnd();
const defaultCaption = readDefaultCaption();

const legacyDefault = '{{title}}\n{{episodeLabel}}\n{{credits}}';
const legacyFields = new Set(['title', 'season', 'episode', 'year', 'voiceover', 'audioVariant',
  'subtitles.author', 'fileName', 'format', 'resolution', 'episodeLabel', 'credits']);
const placeholder = /\{\{\s*([^{}]+?)\s*\}\}/g;

function migrateCaption(template) {
  if (template == null || template === legacyDefault) return defaultCaption;
  const lines = template.split(/\r?\n/).map(line => {
    const parts = [];
    let start = 0;
    for (const match of line.matchAll(placeholder)) {
      if (match.index > start) parts.push(JSON.stringify(line.slice(start, match.index)));
      if (legacyFields.has(match[1])) {
        const field = match[1] === 'subtitles.author' ? 'data.subtitles?.author' : 'data.' + match[1];
        parts.push('String(' + field + ' ?? "")');
      }
      start = match.index + match[0].length;
    }
    if (start < line.length) parts.push(JSON.stringify(line.slice(start)));
    return parts.join(' + ') || '""';
  });
  return 'function caption(data) {\n  const lines = [\n' + lines.map(line => '    ' + line).join(',\n') +
    '\n  ];\n  return lines.join("\\n").trim().split(/\\r?\\n/);\n}';
}

function run(script, input) {
  return script.runInNewContext({ input }, {
    timeout: 100, microtaskMode: 'afterEvaluate',
    contextCodeGeneration: { strings: false, wasm: false }
  });
}

function compileCaption(source, checkDefinition = false) {
  if (typeof source !== 'string' || !source.trim() || source.length > 65536) {
    throw new Error('Введите JavaScript для подписи (до 65 536 символов).');
  }
  const definition = '"use strict"; (() => {\n' + source +
    '\nif (typeof caption !== "function") throw new Error("Определите функцию caption(data).");\n';
  if (checkDefinition) run(new vm.Script(definition + '})()'));
  return new vm.Script(definition + `
    const lines = caption(JSON.parse(input));
    if (!Array.isArray(lines)) throw new Error("Функция caption должна вернуть массив строк.");
    const present = lines.filter(line => line != null && line !== false);
    if (present.some(line => typeof line !== "string" || /[\\r\\n]/.test(line))) {
      throw new Error("Каждый элемент подписи должен содержать одну строку.");
    }
    return present.join("\\n");
  })()`);
}

function telegramHashtag(value, prefix) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').replace(/[^\p{L}\p{Nd}]+/gu, '_').replace(/^_|_$/g, '');
  if (!normalized) return null;
  const characters = Array.from(normalized);
  const limited = characters.slice(0, 256).join('').replace(/_$/, '');
  if (/\p{L}/u.test(limited)) return '#' + limited;
  const digits = characters.slice(0, 255 - prefix.length).join('').replace(/_$/, '');
  return '#' + prefix + '_' + digits;
}

function captionHashtags({ title, voiceover }) {
  return { title: telegramHashtag(title, 'Аниме'), voiceover: telegramHashtag(voiceover, 'Озвучка') };
}

function captionData(row, attachment, destination) {
  const result = row.result || {};
  const title = row.anime_title || result.title || result.fileTitle || null;
  const voiceover = result.voiceover ?? null;
  const season = result.season ?? null;
  const episode = result.episode ?? null;
  const episodeLabel = [season == null ? '' : 'Сезон ' + season,
    episode == null ? '' : 'Серия ' + episode].filter(Boolean).join(' · ');
  const creditLines = [
    result.voiceover && 'Озвучка — ' + result.voiceover,
    result.audioVariant,
    result.subtitles?.author && 'Субтитры — ' + result.subtitles.author
  ].filter(Boolean);
  return {
    title,
    season, episode, year: row.anime_year ?? result.year ?? null,
    voiceover, audioVariant: result.audioVariant ?? null, subtitles: result.subtitles ?? null,
    hashtags: captionHashtags({ title, voiceover }),
    fileName: attachment.fileName ?? null, format: attachment.fileName?.match(/\.([a-z0-9]+)$/i)?.[1].toUpperCase() ?? null,
    resolution: attachment.width && attachment.height ? attachment.width + '×' + attachment.height : null,
    episodeLabel, creditLines, credits: creditLines.join('\n'),
    attachment: { kind: attachment.kind, fileName: attachment.fileName, mimeType: attachment.mimeType,
      width: attachment.width, height: attachment.height },
    destination: { id: destination.id, title: destination.title, type: destination.type || 'channel',
      topicId: destination.topicId ?? null, topicTitle: destination.topicTitle ?? null }
  };
}

const captionExample = captionData(
  { anime_title: 'Пример аниме', anime_year: 2025, result: { season: 1, episode: 2, voiceover: 'Студия озвучки' } },
  { kind: 'video', fileName: 'Anime.S01E02.mkv', mimeType: 'video/x-matroska', width: 1920, height: 1080 },
  { id: '-1001234567890', title: 'Пример канала', type: 'channel' }
);

function previewCaption(source, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Данные для проверки подписи должны быть объектом JSON.');
  }
  return run(compileCaption(source), JSON.stringify({ ...data, hashtags: captionHashtags(data) }));
}

function renderCaption(script, row, attachment, destination) {
  return run(script, JSON.stringify(captionData(row, attachment, destination)));
}

module.exports = { defaultCaption, readDefaultCaption, compileCaption, migrateCaption, renderCaption, captionExample, previewCaption };
