export function parsePnpCsv(csvText) {
  const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return [];

  // Parse header
  let delimiter = ',';
  let headerLine = lines[0];
  
  // Try to detect semicolon delimiter if no commas found
  if (!headerLine.includes(',') && headerLine.includes(';')) {
    delimiter = ';';
  }

  const headers = headerLine.split(delimiter).map(h => h.trim().toLowerCase().replace(/["']/g, ''));
  
  // Common column name mappings
  const colMap = {
    designator: headers.findIndex(h => h === 'designator' || h === 'refdes' || h === 'reference'),
    x: headers.findIndex(h => h === 'mid x' || h === 'midx' || h === 'x (mm)' || h === 'center-x(mm)' || h === 'x'),
    y: headers.findIndex(h => h === 'mid y' || h === 'midy' || h === 'y (mm)' || h === 'center-y(mm)' || h === 'y'),
    layer: headers.findIndex(h => h === 'layer' || h === 'side'),
    footprint: headers.findIndex(h => h === 'footprint' || h === 'package'),
    val: headers.findIndex(h => h === 'comment' || h === 'value')
  };

  if (colMap.x === -1 || colMap.y === -1) {
    console.warn("PnP Parser: Could not find X or Y columns in CSV.", headers);
    return [];
  }

  const components = [];

  for (let i = 1; i < lines.length; i++) {
    // Basic CSV splitting (does not fully handle commas inside quotes, but fine for most PnP)
    const cols = lines[i].split(delimiter).map(c => c.trim().replace(/["']/g, ''));
    if (cols.length < Math.max(colMap.x, colMap.y) + 1) continue;

    const xStr = cols[colMap.x].replace(/[^\d.-]/g, '');
    const yStr = cols[colMap.y].replace(/[^\d.-]/g, '');
    const x = parseFloat(xStr);
    const y = parseFloat(yStr);

    if (isNaN(x) || isNaN(y)) continue;

    const designator = colMap.designator !== -1 ? cols[colMap.designator] : `C${i}`;
    let layer = colMap.layer !== -1 ? cols[colMap.layer].toLowerCase() : 'top';
    const footprint = colMap.footprint !== -1 ? cols[colMap.footprint] : '';

    if (layer.includes('bot')) layer = 'bottom';
    else if (layer.includes('top')) layer = 'top';
    else layer = 'top';

    // Estimate width/height based on footprint for glue volume scaling
    const { width, height } = estimateFootprintSize(footprint);

    components.push({
      id: designator,
      componentIdentifier: designator,
      x,
      y,
      width,
      height,
      side: layer,
      footprint,
      centerValid: true,
      centerMethod: 'pnp_csv',
      originalPad: { x, y, width, height, id: designator }
    });
  }

  return components;
}

function estimateFootprintSize(footprint) {
  const fp = footprint.toUpperCase();
  
  // Standard passives (EIA/Metric)
  if (fp.includes('0201')) return { width: 0.6, height: 0.3 };
  if (fp.includes('0402')) return { width: 1.0, height: 0.5 };
  if (fp.includes('0603')) return { width: 1.6, height: 0.8 };
  if (fp.includes('0805')) return { width: 2.0, height: 1.25 };
  if (fp.includes('1206')) return { width: 3.2, height: 1.6 };
  if (fp.includes('1210')) return { width: 3.2, height: 2.5 };
  if (fp.includes('1812')) return { width: 4.5, height: 3.2 };
  if (fp.includes('2010')) return { width: 5.0, height: 2.5 };
  if (fp.includes('2512')) return { width: 6.3, height: 3.2 };

  // SOIC / SOP
  if (fp.includes('SOIC-8') || fp.includes('SOP-8')) return { width: 5.0, height: 6.0 };
  if (fp.includes('SOIC-14') || fp.includes('SOP-14')) return { width: 8.6, height: 6.0 };
  if (fp.includes('SOIC-16') || fp.includes('SOP-16')) return { width: 10.0, height: 6.0 };
  
  // QFP / QFN / BGA (assume generic squares if we can't parse pin count)
  if (fp.includes('QFP') || fp.includes('QFN') || fp.includes('BGA')) {
    // Very rough heuristic: QFP32 is usually 7x7, QFP64 is 10x10.
    const match = fp.match(/\d+/);
    if (match) {
      const pins = parseInt(match[0]);
      if (pins <= 32) return { width: 7.0, height: 7.0 };
      if (pins <= 64) return { width: 10.0, height: 10.0 };
      return { width: 14.0, height: 14.0 };
    }
    return { width: 10.0, height: 10.0 }; // generic fallback
  }

  // SOT
  if (fp.includes('SOT23') || fp.includes('SOT-23')) return { width: 2.9, height: 1.3 };
  if (fp.includes('SOT223') || fp.includes('SOT-223')) return { width: 6.5, height: 3.5 };

  // DPAK / TO-252
  if (fp.includes('DPAK') || fp.includes('TO-252') || fp.includes('TO252')) return { width: 6.5, height: 6.0 };

  // Generic fallback: Assume it's a small standard component (approx 0805 equivalent area)
  // This is safe because we don't want to over-dispense glue if we don't know the size.
  return { width: 2.0, height: 1.25 };
}
