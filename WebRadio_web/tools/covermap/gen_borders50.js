// Extract single shared border arcs from world-atlas 50m TopoJSON.
// Usage: node gen_borders50.js [quant] [eps]  (writes borders_50m.js snippet)
const https = require('https');
const { mesh } = require('topojson-client');

const SRC_URL = 'https://unpkg.com/world-atlas@2/countries-50m.json';
const QUANT = parseFloat(process.argv[2] || '0.25');
const EPS = parseFloat(process.argv[3] || '0.3');

function fetchJson(url, hops) {
    hops = hops || 0;
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 4) {
                res.resume();
                resolve(fetchJson(new URL(res.headers.location, url).toString(), hops + 1));
                return;
            }
            if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
            let buf = '';
            res.on('data', (c) => { buf += c; });
            res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

function dp(points, eps) {
    if (points.length < 4) return points.slice();
    const keep = new Array(points.length).fill(false);
    keep[0] = keep[points.length - 1] = true;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        const [ax, ay] = points[a], [bx, by] = points[b];
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let dmax = 0, idx = -1;
        for (let i = a + 1; i < b; i++) {
            const [px, py] = points[i];
            let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
            t = Math.max(0, Math.min(1, t));
            const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
            if (d > dmax) { dmax = d; idx = i; }
        }
        if (dmax > eps) { keep[idx] = true; stack.push([a, idx], [idx, b]); }
    }
    return points.filter((_, i) => keep[i]);
}

(async () => {
    const topo = await fetchJson(SRC_URL);
    // mesh() already returns geographic [lon,lat] (transform applied internally).
    // Each shared border is a single arc -> one line between neighbors.
    const m = mesh(topo, topo.objects.countries, (a, b) => true);
    const js_rings = [];
    const seenSeg = new Set();
    for (const line of m.coordinates) {
        const pts = line;
        const q = [];
        for (const [x, y] of pts) {
            const qx = Math.round(x / QUANT) * QUANT, qy = Math.round(y / QUANT) * QUANT;
            const last = q[q.length - 1];
            if (!last || last[0] !== qx || last[1] !== qy) q.push([qx, qy]);
        }
        const s = dp(q, EPS);
        if (s.length < 2) continue;
        const r = s.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
        // drop segments already emitted (overlapping claim lines) -> each border once
        const cur = [r[0]];
        for (let i = 0; i + 1 < r.length; i++) {
            const ka = JSON.stringify(r[i]), kb = JSON.stringify(r[i + 1]);
            const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
            if (seenSeg.has(key)) {
                if (cur.length >= 2) js_rings.push(cur.slice());
                cur.length = 0;
                cur.push(r[i + 1]);
            } else {
                seenSeg.add(key);
                cur.push(r[i + 1]);
            }
        }
        if (cur.length >= 2) js_rings.push(cur);
    }
    const rings = js_rings;
    const js = 'const BORDERS=' + JSON.stringify(rings) + ';';
    require('fs').writeFileSync('borders_50m.js', 'const BORDERS_ARCS=' + rings.length + ';\n' + js + '\n');
    const pts = rings.reduce((a, r) => a + r.length, 0);
    console.error(`arcs=${rings.length} points=${pts} bytes=${js.length} quant=${QUANT} eps=${EPS}`);
})();
