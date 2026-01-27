export function planPath({ from, to, algo = "linear", zsafe = 6, zwork = 0.4}) {
    const p = [];
    const s = { x: from.x, y: from.y, z: from.z ?? zsafe };
    if ((s.z ?? zsafe) !== zsafe) p.push({ x: s.x, y: s.y, z: zsafe });
    if (algo === "linear") {
        p.push({ x: to.x, y: to.y, z: zsafe });
    } else {
        p.push({ x: to.x, y: s.y, z: zsafe });
        p.push({ x: to.x, y: to.y, z: zsafe });
    }
    p.push({ x: to.x, y: to.y, z: zwork });
    return p;
}

export function samplePath(points, stepXY = 0.5) {
    if (!points?.length) return [];
    const out = [{ ...points[0]}];
    for (let i = 1; i < points.length; i++) {
        const a = points[i-1], b = points[i];
        const dx = b.x - a.x, dy = b.y - a.y, dz = (b.z ?? 0) - (a.z ?? 0);
        const Lxy = Math.hypot(dx, dy);
        const steps = Math.max(1, Math.ceil(Lxy / stepXY));
        for (let k = 1; k <= steps; k++) {
            const t = k / steps;
            out.push({
                x: a.x + dx * t,
                y: a.y + dy * t,
                z: (a.z ?? 0) + dz * t,
            });
        }
    }
    return out;
}

export function pathLengthXY(points) {
    let L = 0;
    for (let i = 1; i < points.length; i++) {
        const a = points[i-1], b = points[i];
        L += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return L;
}