export async function stackupToSvg(layers, side = 'top') {
  const enabled = layers.filter(l => l.enabled).map(l => ({
    filename: l.filename,
    gerber: l.text
  }));
  const res = await window.pcbStackup(enabled);
  return side === 'bottom' ? res.bottom.svg : res.top.svg;
}
