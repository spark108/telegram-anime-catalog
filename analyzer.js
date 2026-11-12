const vm = require('node:vm');

const example = `function analyze({ text, attachments }) {
  const [first = ''] = text.split(/\\r?\\n/).map(line => line.trim()).filter(Boolean);
  const field = name => text.match(new RegExp('^' + name + '[ \\t]*:[ \\t]*([^\\r\\n]+)', 'im'))?.[1].trim();
  const files = new Set(attachments.flatMap(({ fileName }) => {
    const match = fileName?.match(/(?:^|[. _-])S(\\d+)E(\\d+)(?=$|[. _-])/i);
    return match ? [Number(match[1]) + '/' + Number(match[2])] : [];
  }));
  const [season, episode] = files.size === 1 ? [...files][0].split('/').map(Number) : [];
  const number = value => /^\\d+$/.test(value ?? '') ? Number(value) : null;
  return {
    title: /^🎬/u.test(first) ? first.replace(/^🎬\\s*/u, '').trim() : null,
    season: number(field('Сезон')) ?? season ?? null,
    episode: number(field('Серия')) ?? episode ?? null,
    voiceover: field('Озвучка') ?? null,
    year: number(field('Год'))
  };
}`;

function compile(source) {
  return new vm.Script(`"use strict"; (() => {
    ${source}
    return JSON.stringify(analyze(JSON.parse(input)));
  })()`);
}

function analyze(script, message) {
  const input = JSON.stringify({ text: message.text, attachments: message.attachments });
  const output = script.runInNewContext({ input }, {
    timeout: 100,
    contextCodeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate'
  });
  return normalize(JSON.parse(output));
}

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Анализатор должен вернуть объект с полями тайтла.');
  }
  const string = value => typeof value === 'string' ? value.trim().slice(0, 500) || null : null;
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const subtitles = value.subtitles;
  return {
    title: string(value.title),
    fileTitle: string(value.fileTitle),
    season: integer(value.season),
    episode: integer(value.episode),
    voiceover: string(value.voiceover),
    audioVariant: string(value.audioVariant),
    year: integer(value.year),
    subtitles: subtitles && typeof subtitles === 'object' && !Array.isArray(subtitles)
      ? {
          author: string(subtitles.author),
          mode: ['file', 'video'].includes(subtitles.mode) ? subtitles.mode : null,
          styled: typeof subtitles.styled === 'boolean' ? subtitles.styled : null
        }
      : null
  };
}

module.exports = { analyze, compile, example, normalize };
