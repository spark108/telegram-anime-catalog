function caption(data) {
  const seasonAndEpisode = [
    data.season != null && data.season !== "" ? `Сезон: ${data.season}` : null,
    data.episode != null && data.episode !== "" ? `Серия: ${data.episode}` : null,
  ].filter(Boolean).join(" ");

  const lines = [
    (data.title ?? "") + (data.year != null ? ` (${data.year})` : ""),
    seasonAndEpisode || null,
    "Озвучка: " + String(data.voiceover ?? ""),
  ];

  const tags = [data.hashtags.title, data.hashtags.voiceover].filter(Boolean).join(" ");
  const captionLines = lines.filter(line => line !== null).join("\n").trim().split(/\r?\n/);
  return tags ? [...captionLines, "", tags] : captionLines;
}
