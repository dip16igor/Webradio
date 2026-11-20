// Rasterize world countries GeoJSON to a 144x72 land bitmap (base64).
// Usage: node gen_land.js  (writes landmask.js snippet to stdout)
const https = require('https');

const URL = 'https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json';
const COLS = 144, ROWS = 72;

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

// Even-odd over ALL rings (outer + holes) of a polygon.
function inPoly(lon, lat, poly) {
    let inside = false;
    for (const ring of poly) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
    }
    return inside;
}

(async () => {
    const gj = await fetchJson(URL);
    const polys = [];
    for (const f of gj.features) {
        const g = f.geometry;
        if (!g) continue;
        if (g.type === 'Polygon') polys.push(g.coordinates);
        else if (g.type === 'MultiPolygon') for (const p of g.coordinates) polys.push(p);
    }
    console.error(`polygons: ${polys.length}`);
    const bits = [];
    for (let r = 0; r < ROWS; r++) {
        const lat = 90 - (r + 0.5) * (180 / ROWS);
        for (let c = 0; c < COLS; c++) {
            const lon = -180 + (c + 0.5) * (360 / COLS);
            let land = false;
            for (const p of polys) { if (inPoly(lon, lat, p)) { land = true; break; } }
            bits.push(land ? 1 : 0);
        }
        if (r % 12 === 0) console.error(`row ${r}/${ROWS}`);
    }
    const bytes = Buffer.alloc(Math.ceil(bits.length / 8));
    bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 1 << (7 - (i & 7)); });
    const landCount = bits.reduce((a, b) => a + b, 0);
    console.error(`land cells: ${landCount}/${bits.length}`);
    console.log(`// ${COLS}x${ROWS} land bitmap, ${landCount} land cells`);
    console.log(`const LAND_COLS = ${COLS}, LAND_ROWS = ${ROWS};`);
    console.log(`const LAND_B64 = "${bytes.toString('base64')}";`);
})();
