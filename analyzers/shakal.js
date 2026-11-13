function analyze({ text, attachments }) {
  // Older imports could label Telegram GIFs as videos without saving the animation attribute.
  const isRelease = file => file.kind === 'subtitle' || (file.kind === 'video' &&
    file.mimeType !== 'image/gif' && !/\.gif$/i.test(file.fileName ?? '') &&
    !/(?:^|[\s_.-])gif(?:[\s_.-]|$)/i.test(file.fileName ?? ''));
  if (!attachments.some(isRelease)) {
    return { skip: true };
  }

  const lines = text.split(/\r?\n/).map(line => line.replace(/\\[ \t]*$/, '').trim()).filter(Boolean);
  const title = lines[0]?.match(/^[♦🔶]\uFE0F?\s*(.+)$/u)?.[1].trim() || null;
  const tags = [...new Set(lines.filter(line => /^#[\p{L}\p{N}_]/u.test(line))
    .flatMap(line => line.match(/#[\p{L}\p{N}_]+/gu) ?? [])
    .map(tag => tag.normalize('NFKC').toLowerCase().replaceAll('ё', 'е')))];

  const fields = new Map();
  for (const line of lines) {
    const field = line.match(/^(?:[🔹🔷]\uFE0F?\s*)?([^:]+?)\s*:\s*(.+)$/u);
    if (field) fields.set(field[1].toLowerCase(), field[2]);
  }
  const number = value => value && /^\d+$/.test(value) ? Number(value) : null;
  const year = (fields.get('выход') ?? fields.get('год') ?? '').match(/\b(?:19|20)\d{2}\b/)?.[0];

  const episode = number(fields.get('серия'));
  return {
    title,
    seriesKey: tags.length === 1 && (title || episode !== null) ? tags[0] : null,
    season: number(fields.get('сезон')),
    episode,
    voiceover: fields.get('озвучка') ?? null,
    year: number(year)
  };
}
