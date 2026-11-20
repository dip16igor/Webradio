// Fetch countries GeoJSON, simplify rings, emit compact BORDERS JS.
// Usage: node gen_borders.js [epsilon]  (writes borders.js snippet + size report)
const https = require('https');

const URL = 'https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json';
const EPS = parseFloat(process.argv[2] || '1.0');

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
            if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
            let buf = '';
            res.on('data', (c) => { buf += c; });
            res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

// Douglas-Peucker on a ring (simple, no topology preservation - fine for 110m display).
function dp(points, eps) {
    if (points.length < 4) return points.slice();
    const keep = new Array(points.length).fill(false);
    keep[0] = keep[points.length - 1] = true;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        let dmax = 0, idx = -1;
        const [ax, ay] = points[a], [bx, by] = points[b];
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        for (let i = a + 1; i < b; i++) {
            const [px, py] = points[i];
            let d;
            if (len2 === 0) d = Math.hypot(px - ax, py - ay);
            else {
                let t = ((px - ax) * dx + (py - ay) * dy) / len2;
                t = Math.max(0, Math.min(1, t));
                d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
            }
            if (d > dmax) { dmax = d; idx = i; }
        }
        if (dmax > eps) { keep[idx] = true; stack.push([a, idx], [idx, b]); }
    }
    return points.filter((_, i) => keep[i]);
}

(async () => {
    const gj = await fetchJson(URL);
    const rings = [];
    for (const f of gj.features) {
        const g = f.geometry;
        if (!g) continue;
        const polys = g.type === 'Polygon' ? [g.coordinates] : (g.type === 'MultiPolygon' ? g.coordinates : []);
        for (const poly of polys) {
            for (const ring of poly) {
                if (ring.length < 4) continue;
                // quantize to 0.5deg grid first (dedup), then simplify
                const q = [];
                for (const [x, y] of ring) {
                    const qx = Math.round(x * 2) / 2, qy = Math.round(y * 2) / 2;
                    const last = q[q.length - 1];
                    if (!last || last[0] !== qx || last[1] !== qy) q.push([qx, qy]);
                }
                const s = dp(q, EPS);
                if (s.length >= 4) {
                    // round to 1 decimal, store [lon,lat]
                    rings.push(s.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]));
                }
            }
        }
    }
    const js = 'const BORDERS=' + JSON.stringify(rings).replace(/\.0(?=[,\]])/g, '') + ';';
    require('fs').writeFileSync('borders_snippet.js', 'const BORDERS_RINGS=' + rings.length + ';\n' + js + '\n');
    const pts = rings.reduce((a, r) => a + r.length, 0);
    console.error(`rings=${rings.length} points=${pts} bytes=${js.length} eps=${EPS}`);
})();
