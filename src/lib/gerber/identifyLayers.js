export function identifyLayers(files) {
  const mapping = window.whatsThatGerber(files.map(f => f.name));
  return files.map(f => {
    const meta = mapping[f.name] || {};
    return {
      filename: f.name,
      text: f.text,
      side: meta.side ?? null,     
      type: meta.type ?? null,     
      enabled: meta.type ? true : false
    };
  }).filter(l => l.type); 
}
