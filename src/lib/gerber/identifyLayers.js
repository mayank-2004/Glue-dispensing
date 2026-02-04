export function identifyLayers(files) {
  // Extract basenames to handle paths in ZIPs (e.g. "folder/file.gbr" -> "file.gbr")
  const basenames = files.map(f => f.name.replace(/^.*[\\\/]/, ''));
  const mapping = window.whatsThatGerber(basenames);

  return files.map((f, i) => {
    const basename = basenames[i];
    const meta = mapping[basename] || {};
    return {
      filename: f.name, // Keep original full path for display/uniqueness
      text: f.text,
      side: meta.side ?? null,
      type: meta.type ?? null,
      enabled: meta.type ? true : false
    };
  }).filter(l => l.type);
}
