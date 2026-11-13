function analyze({ text, attachments }) {
  if (!attachments.some(file => file.kind === 'video' || file.kind === 'subtitle')) {
    return { skip: true };
  }

  const lines = text.split(/\r?\n/).map(line => line.replace(/\\[ \t]*$/, '').trim()).filter(Boolean);
  return parseInlineHashtag(lines, attachments)
    ?? parseSeparateHashtag(lines, attachments)
    ?? parseLeadingHashtag(lines, attachments)
    ?? parseSlashHashtag(lines, attachments)
    ?? parseBilingualTitle(lines, attachments)
    ?? parsePlainTitle(lines, attachments)
    ?? parseRelease(lines, attachments);
}

/*
RAW #2
Бедствие вархайта | #Magatsu_Wahrheit_Zuerst
Серия: 1
Озвучка от студийной банды "WAKANIM"
=========================================================
Наша группа: https://vk.com/refot_tv
*/
function parseInlineHashtag(lines, attachments) {
  const header = lines[0]?.match(/^(?!\\?#)(.+?)\s*\|\s*\\?#[\p{L}\p{N}_]+[.!?]*$/u)?.[1];
  return header ? parseRelease(lines.slice(1), attachments, header) : null;
}

/*
RAW #8
Наша с тобою последняя битва положит начало лучшему миру
#Our_Last_Crusade_or_the_Rise_of_a_New_World
Серия: 2
Озвучка от студийной банды "WAKANIM"
=========================================================
Наша группа: https://vk.com/refot_tv
*/
function parseSeparateHashtag(lines, attachments) {
  if (!lines[0] || /^\\?#/.test(lines[0]) || !/^\\?#[\p{L}\p{N}_]+[.!?]*$/u.test(lines[1] ?? '')) return null;
  return parseRelease(lines.slice(2), attachments, lines[0].replace(/\s*\|$/, ''));
}

/*
RAW #24
#Пламенная_бригада_пожарных | Enen no Shouboutai
Сезон: 2 - Серия 16
Дубляж от студийной банды "WAKANIM"
=========================================================
Наша группа: ——————
*/
function parseLeadingHashtag(lines, attachments) {
  const match = lines[0]?.match(/^\\?#(.+?)\s*\|\s*(.+)$/u);
  if (!match) return null;
  const label = match[1].replaceAll('_', ' ').trim();
  const title = /\p{Script=Cyrillic}/u.test(label) ? label : match[2].trim();
  return parseRelease(lines.slice(1), attachments, title);
}

/*
RAW #2575
Повседневная жизнь в фотостудии времени / #Shiguang_Zhaoxiangguan_de_Richang
Серия: 1
Озвучка от студийной банды.
=========================================================
Наша группа: https://vk.com/ftuna02
*/
function parseSlashHashtag(lines, attachments) {
  const header = lines[0]?.match(/^(.+?)\s+\/\s*\\?#[\p{L}\p{N}_]+[.!?]*$/u)?.[1];
  return header ? parseRelease(lines.slice(1), attachments, header) : null;
}

/*
RAW #192
Ди Грэй-мен / D.Gray-man
Серия: 1
Дубляж от double rec.
=========================================================
Наша группа: https://vk.com/ftuna01
*/
function parseBilingualTitle(lines, attachments) {
  const header = lines[0]?.match(/^([^#]+?)\s+[|/]\s+[^#]+$/u)?.[1];
  if (!header || !/^(?:Сезон\s*:|Серия\s*:?\s*\d)/i.test(lines[1] ?? '')) return null;
  return parseRelease(lines.slice(1), attachments, header);
}

/*
RAW #1583
Re-Main
Серия: 1
Озвучка от студийной банды.
=========================================================
Наша группа: https://vk.com/ftuna02
*/
function parsePlainTitle(lines, attachments) {
  const [header, next] = lines;
  if (!header || /[#|]/.test(header) || /^(?:Сезон|Серия)(?:\s|:|$)/i.test(header) ||
      !/^(?:Сезон\s*:|Серия\s*:?\s*\d)/i.test(next ?? '')) return null;
  return parseRelease(lines.slice(1), attachments, header);
}

// Общие поля релиза. Формат заголовка определяет только соответствующая функция.
function parseRelease(lines, attachments, header) {
  const titleYear = header?.match(/\s*\(((?:19|20)\d{2})\)$/);
  const title = header?.replace(/\s*\((?:19|20)\d{2}\)$/, '').trim();
  const episodeLine = lines.find(line => /(?:^|[-–—])\s*Серия(?:\s*:|\s+\d)/i.test(line)) ?? '';
  const episode = episodeLine.match(/(?:^|[-–—])\s*Серия(?:\s*:\s*|\s+)(\d+)(?:\s*\(([^)]+)\))?(?:\s*[-–—]\s*Последняя)?\s*\.?$/i);
  const season = lines.map(line => line.match(/^Сезон\s*:\s*(\d+)\s*\.?(?:\s*[-–—]\s*Серия(?:\s*:|\s+\d)|$)/i)?.[1]).find(Boolean);
  const year = lines.map(line => line.match(/^Год(?: выхода)?\s*:\s*(\d{4})\s*\.?$/i)?.[1]).find(Boolean);
  const voiceCredit = lines.find(line => /^(?:Озвучка|Дубляж)(?:\s*:|\s+от\s+)/i.test(line));
  const subtitleCredit = lines.find(line => /^(?:[СC]убтитры|[СC]офтсабы)\s*(?::|[.!?]*$)/i.test(line));

  const files = attachments.map(({ fileName, kind, mimeType }) => {
    const format = fileName?.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
    const name = fileName?.match(/^\[(?:FT|FortunaTV)\]\s+(.+?)(?:\s+S(\d+))?\s*[-–—]\s*(\d+)\s+\[([^\]]+)\]\.[a-z0-9]+$/i);
    const tags = (name?.[4] ?? fileName?.match(/\[([^\]]+)\](?=\.[a-z0-9]+$)/i)?.[1] ?? '').toUpperCase().split(/\s+/);
    return {
      title: name?.[1].trim(),
      season: name?.[2],
      episode: name?.[3],
      tags,
      subtitle: kind === 'subtitle' || ['ass', 'ssa', 'srt', 'vtt', 'sub', 'sup'].includes(format),
      video: kind === 'video' || mimeType?.startsWith('video/') || ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v'].includes(format)
    };
  });
  const common = field => {
    const values = new Set(files.map(file => file[field]).filter(value => value !== undefined));
    return values.size === 1 ? [...values][0] : undefined;
  };
  const number = value => value === undefined ? null : Number(value);
  const film = lines.some(line => /^#?фильм\s*[.!?:]*$/i.test(line));
  const fileTitle = common('title');
  const fileYear = fileTitle?.match(/\s*\(((?:19|20)\d{2})\)$/)?.[1];
  const separate = files.some(file => file.subtitle);
  const video = files.some(file => file.video);
  const hasSubtitles = Boolean(subtitleCredit || separate || files.some(file => file.tags.includes('SUB')));
  const variant = episode?.[2]?.trim();
  const fileVariants = {
    'JA-DUB': 'Японский дубляж',
    'FR-DUB': 'Французский дубляж'
  };
  const namedVariants = new Set(files.flatMap(file => file.tags.map(tag => fileVariants[tag])).filter(Boolean));
  const audioVariant = variant && /дубляж|озвучк/i.test(variant) ? variant
    : namedVariants.size === 1 ? [...namedVariants][0] : null;

  function creditedName(line) {
    const value = line?.match(/^(?:[^:]+?\s*:\s*|(?:Озвучка|Дубляж)\s+от\s+)(.*)$/i)?.[1].trim();
    if (!value) return null;
    if (/^студийной банды(?:\s+"[^"]+")?\.?$/i.test(value)) return 'Студийная Банда';
    const quoted = value?.match(/^(?:"([^"]+)"|«([^»]+)»)/);
    return quoted?.[1] ?? quoted?.[2] ?? value?.replace(/\s*\[[^\]]+\]\s*\.?$/, '').replace(/\.$/, '').trim() ?? null;
  }

  const subtitleAuthor = creditedName(subtitleCredit);
  return {
    title: title && (episode || fileTitle || film) ? title : null,
    fileTitle: fileTitle ?? null,
    season: number(season ?? common('season')),
    episode: number(episode?.[1] ?? common('episode')),
    voiceover: creditedName(voiceCredit),
    audioVariant,
    year: number(year ?? titleYear?.[1] ?? fileYear),
    subtitles: hasSubtitles ? {
      author: /^[cс]runchyroll$/i.test(subtitleAuthor ?? '') ? 'Crunchyroll' : subtitleAuthor,
      mode: separate ? 'file' : video ? 'video' : null,
      styled: /\[\s*с оформлением\s*\]/i.test(subtitleCredit ?? '') ? true : null
    } : null
  };
}
