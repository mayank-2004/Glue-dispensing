export function identifyLayers(files) {
  // Extract basenames to handle paths in ZIPs (e.g. "folder/file.gbr" -> "file.gbr")
  const basenames = files.map(f => f.name.replace(/^.*[\\\/]/, ''));
  const mapping = (typeof window !== 'undefined' && window.whatsThatGerber)
    ? (window.whatsThatGerber(basenames) || {})
    : {};

  return files.map((f, i) => {
    const basename = basenames[i];
    const meta = mapping[basename] || {};
    let type = meta.type ?? null;
    let side = meta.side ?? null;

    // Check Gerber X2 %TF.FileFunction header if type/side not yet known
    if ((!type || !side) && f.text) {
      const x2Match = f.text.match(/%TF\.FileFunction\s*,\s*([^%*]+)\*%/i);
      if (x2Match) {
        const parts = x2Match[1].split(',').map(s => s.trim().toLowerCase());
        const func = parts[0];
        if (func === 'copper') {
          type = type || 'copper';
          if (parts.includes('top') || parts.includes('l1') || parts.includes('front')) side = side || 'top';
          else if (parts.includes('bot') || parts.includes('bottom') || parts.includes('l2') || parts.includes('back')) side = side || 'bottom';
        } else if (func === 'paste' || func === 'solderpaste') {
          type = type || 'solderpaste';
          if (parts.includes('top') || parts.includes('front')) side = side || 'top';
          else if (parts.includes('bot') || parts.includes('bottom') || parts.includes('back')) side = side || 'bottom';
        } else if (func === 'soldermask' || func === 'mask') {
          type = type || 'soldermask';
          if (parts.includes('top') || parts.includes('front')) side = side || 'top';
          else if (parts.includes('bot') || parts.includes('bottom') || parts.includes('back')) side = side || 'bottom';
        } else if (func === 'profile' || func === 'outline' || func === 'edge' || func === 'edges' || func === 'cut') {
          type = type || 'outline';
          side = side || 'all';
        } else if (func === 'legend' || func === 'silkscreen' || func === 'silk') {
          type = type || 'silkscreen';
          if (parts.includes('top') || parts.includes('front')) side = side || 'top';
          else if (parts.includes('bot') || parts.includes('bottom') || parts.includes('back')) side = side || 'bottom';
        }
      }
    }

    // Filename regex fallback for common KiCad / Altium / Eagle naming conventions
    if (!type) {
      const lower = basename.toLowerCase();
      if (/\.(gtp|stp)$|[._-]paste[._-]?(top|t|f)?|[._-]f[._-]paste/i.test(lower)) {
        type = 'solderpaste'; side = side || 'top';
      } else if (/\.(gbp|sbp)$|[._-]paste[._-]?(bot|b)?|[._-]b[._-]paste/i.test(lower)) {
        type = 'solderpaste'; side = side || 'bottom';
      } else if (/\.(gtl|cmp)$|[._-](cu|copper|top)[._-]?(top|t|f)?|[._-]f[._-]cu/i.test(lower)) {
        type = 'copper'; side = side || 'top';
      } else if (/\.(gbl|sol)$|[._-](cu|copper|bot)[._-]?(bot|b)?|[._-]b[._-]cu/i.test(lower)) {
        type = 'copper'; side = side || 'bottom';
      } else if (/\.(gts|stc)$|[._-]mask[._-]?(top|t|f)?|[._-]f[._-]mask/i.test(lower)) {
        type = 'soldermask'; side = side || 'top';
      } else if (/\.(gbs|sts)$|[._-]mask[._-]?(bot|b)?|[._-]b[._-]mask/i.test(lower)) {
        type = 'soldermask'; side = side || 'bottom';
      } else if (/\.(gko|gm[0-9]|gml)$|outline|edge[._-]cuts/i.test(lower)) {
        type = 'outline'; side = 'all';
      } else if (/\.(gto|plc)$|[._-]silk[._-]?(top|t|f)?|[._-]f[._-]silk/i.test(lower)) {
        type = 'silkscreen'; side = side || 'top';
      } else if (f.text && (/%FS|%MO|D0[123]\*|M02\*/i.test(f.text))) {
        // Fallback for valid Gerber data with unrecognized filename
        type = 'copper'; side = side || 'top';
      }
    }

    return {
      filename: f.name, // Keep original full path for display/uniqueness
      text: f.text,
      side: side || 'top',
      type: type,
      enabled: !!type
    };
  }).filter(l => l.type);
}
