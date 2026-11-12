function analyze({ text, attachments }) {
  const lines = text.split(/\r?\n/).map(line => line.replace(/\\[ \t]*$/, '').trim()).filter(Boolean);
  const header = lines[0]?.match(/^(.+?)\s*\|\s*#[\p{L}\p{N}_]+[.!?]?$/u)?.[1];
  const titleYear = header?.match(/\s*\(((?:19|20)\d{2})\)$/);
  const title = header?.replace(/\s*\((?:19|20)\d{2}\)$/, '').trim();
  const episodeLine = lines.find(line => /(?:^|[-–—])\s*Серия\s*:/i.test(line)) ?? '';
  const episode = episodeLine.match(/(?:^|[-–—])\s*Серия\s*:\s*(\d+)(?:\s*\(([^)]+)\))?(?:\s*[-–—]\s*Последняя)?\s*\.?$/i);
  const season = lines.map(line => line.match(/^Сезон\s*:\s*(\d+)\s*\.?(?:\s*[-–—]\s*Серия\s*:|$)/i)?.[1]).find(Boolean);
  const year = lines.map(line => line.match(/^Год(?: выхода)?\s*:\s*(\d{4})\s*\.?$/i)?.[1]).find(Boolean);
  const voiceCredit = lines.find(line => /^(?:Озвучка|Дубляж)\s*:/i.test(line));
  const subtitleCredit = lines.find(line => /^(?:Субтитры|Софтсабы)\s*:/i.test(line));

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
    const value = line?.slice(line.indexOf(':') + 1).trim();
    const quoted = value?.match(/^(?:"([^"]+)"|«([^»]+)»)/);
    return quoted?.[1] ?? quoted?.[2] ?? value?.replace(/\s*\[[^\]]+\]\s*\.?$/, '').replace(/\.$/, '').trim() ?? null;
  }

  const subtitleAuthor = creditedName(subtitleCredit);
  return {
    title: title && (episode || fileTitle) ? title : null,
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
