export async function stackupToSvg(layers, side = 'top') {
  const enabled = layers.filter(l => {
    if (!l.enabled) return false;
    if (l.type === 'drill' || l.type === 'outline') return true;
    return l.side === side;
  }).map(l => {
    const base = {
      filename: l.filename.replace(/^.*[\\\/]/, ''),
      gerber: l.text,
      side: side, // keep the real side so pcb-stackup renders correct orientation
      type: l.type,
      id: l.filename
    };

    // Colors based on layer side for visual contrast
    if (l.side === 'bottom') {
      if (l.type === 'soldermask') base.color = '#4b0082'; // Indigo
      else if (l.type === 'copper') base.color = '#008080'; // Teal
      else if (l.type === 'silkscreen') base.color = '#f0e68c'; // Khaki
      else if (l.type === 'solderpaste') base.color = '#cd853f'; // Peru
    } else {
      if (l.type === 'soldermask') base.color = '#006400'; // Dark Green
      else if (l.type === 'copper') base.color = '#cc0000'; // Red
      else if (l.type === 'silkscreen') base.color = '#ffffff'; // White
      else if (l.type === 'solderpaste') base.color = '#a9a9a9'; // Dark Gray
    }

    return base;
  });

  const options = {
    color: {
      fr4: '#666666',
      cu: '#c0c0c0',
      ss: '#ffffff',
      sm: '#006400',
      sp: '#999999'
    }
  };

  console.log(`Sending ${enabled.length} layers to pcbStackup. Requesting view: ${side}`);

  try {
    const res = await window.pcbStackup(enabled, options);
    console.log('pcbStackup Result:', {
      hasTop: !!res.top,
      hasBottom: !!res.bottom,
      sideRequested: side
    });
    return side === 'bottom' ? res.bottom.svg : res.top.svg;
  } catch (err) {
    console.error("Error in pcbStackup:", err);
    return "";
  }
}
