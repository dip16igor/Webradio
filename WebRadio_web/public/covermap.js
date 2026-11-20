/* Cover globe map: monochrome hacker-HUD dot-matrix world with fly-to animation.
 * Landmask: 144x72 bitmap (2.5 deg cells), embedded base64. No external tiles. */
window.CoverMap = (() => {
    const COLS = 144, ROWS = 72;
    const LAND = (() => {
        const bin = atob('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/5///gAAAAAAAAAAAAAAAAEz/P//8ABwAAAADAAAAAAAABKZAP//8AAAAA4AH4AAAAAAADwDQAP/8AAAAGAH/4AIAAgEABfG/gH/4AAAAGHf//9/gAB///1Ds4H/gAAf4F6///////8/////w+H8BAB/0/////////AP////UcHwCAD3/////////+A////8BgDgAAPn////////74AeB//+B6AAAAPn///////4CAAIAf//h+AAACFP///////gOAAAAP//7/gAANH////////wMAAAAH////wAAD/////////wAAAAAD///04AAD/////////wAAAAAD///8AAAB//X3/////gAAAAAD///wAAAB6+Dv/////EAAAAAD///gAAAPhvbz////8IAAAAAB///AAAAPAp/z///+IIAAAAAB///AAAAA8Af/////EwAAAAAAf/+AAAAH8AP/////BAAAAAAAX/4AAAAP/uv/////gAAAAAAAP8EAAAAP///v////gAAAAAAAD4EAAAA///3z////AAAAAAAAB4AAAAA///3+H//+gAAAAAAAA4gAAAB///7/D+fgAAAAAAAAA9gYAAA///7+B8PQAAAAAAAAAHgAAAB///94B4HggAAAAAAAAA4AAAB////gAwHwwAAAAAAAAAAoAAA///+QAwFgAAAAAAAAAAF/AAAf///wAAEAIAAAAAAAAAB/gAAPv//wAICAAAAAAAAAAAB/8AAAD//gAAGGAAAAAAAAAAD/8AAAD//AAADOAAAAAAAAAAD//AAAD/+AAADOjAAAAAAAAAD//4AAD/8AAABAg8AAAAAAAAD//8AAB/8AAAAgAeAAAAAAAAD//8AAB/8AAAABoIAAAAAAAAB//4AAB/8AAAAAAAAAAAAAAAB//wAAB/8QAAAADAAAAAAAAAAf/wAAB/8wAAAAfkAAAAAAAAAP/wAAB/wwAAAAf+AAAAAAAAAP/wAAB/xgAAAD//AAAAAAAAAP/AAAA/xgAAAH//AAAAAAAAAP+AAAA/gAAAAH//gAAAAAAAAf8AAAAfgAAAAD//gAAAAAAAAf8AAAAfAAAAAD//gAAAAAAAAf4AAAAcAAAAADw/gAAAAAAAAfgAAAAAAAAAAAAPAAAAAAAAAfAAAAAAAAAAAAACACAAAAAAA8AAAAAAAAAAAAACAEAAAAAAAcAAAAAAAAAAAAAAAIAAAAAAA4AAAAAAAAAAAAAAAQAAAAAAA4AAAAAAAAAAAAAAAAAAAAAAAwgAAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAACAAAAAAAGAABEAAAAAAAAAAAEAAAAAAR/8f////gAAAAAAAA+AAAF////5//////wAAABAf+/AAB////////////gAAP////wAAP///////////+AAT////+ADj/////////////gAD/////4AH////////////8AAB/////////////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
        const out = new Uint8Array(COLS * ROWS);
        for (let i = 0; i < out.length; i++) {
            out[i] = (bin.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
        }
        return out;
    })();

    const GREEN = '#7ddb9b';
    const AMBER = '#f2c94d';

    let canvas = null, ctx = null, W = 0, H = 0;
    let running = false, rafId = 0, lastT = 0;
    let playing = false;
    let tG = 0;
    let nextGlitchAt = 0, glitchUntil = 0;

    const view = { lat: 25, lon: 0, zoom: 1 };
    const target = { lat: 25, lon: 0, zoom: 1 };
    let pendingFly = null;
    let marker = null; // {lat, lon, city, country, ip}
    let unknown = false;

    function project(lat, lon) {
        let dlon = lon - view.lon;
        while (dlon > 180) dlon -= 360;
        while (dlon < -180) dlon += 360;
        const sx = (W / 360) * view.zoom;
        const sy = (H / 180) * view.zoom;
        return [W / 2 + dlon * sx, H / 2 - (lat - view.lat) * sy];
    }

    function lerpAngle(a, b, k) {
        let d = b - a;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        return a + d * k;
    }

    function userHold() {
        pendingFly = null; // user takes over: cancel auto fly-to
    }

    function eventPx(e) {
        const r = canvas.getBoundingClientRect();
        const sx = canvas.width / Math.max(1, r.width);
        const sy = canvas.height / Math.max(1, r.height);
        return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sy];
    }

    function unproject(px, py) {
        const sx = (W / 360) * view.zoom;
        const sy = (H / 180) * view.zoom;
        let lon = view.lon + (px - W / 2) / sx;
        while (lon > 180) lon -= 360;
        while (lon < -180) lon += 360;
        const lat = Math.max(-85, Math.min(85, view.lat - (py - H / 2) / sy));
        return { lat, lon };
    }

    function bindPointer() {
        canvas.addEventListener('wheel', (e) => {
            if (e.ctrlKey) return; // let the browser page-zoom
            e.preventDefault();
            userHold();
            const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
            const nz = Math.min(12, Math.max(1, target.zoom * f));
            const [px, py] = eventPx(e);
            const g = unproject(px, py);
            target.zoom = nz;
            const sx = (W / 360) * nz;
            const sy = (H / 180) * nz;
            target.lon = g.lon - (px - W / 2) / sx;
            while (target.lon > 180) target.lon -= 360;
            while (target.lon < -180) target.lon += 360;
            target.lat = Math.max(-85, Math.min(85, g.lat + (py - H / 2) / sy));
        }, { passive: false });

        let dragging = false;
        let lx = 0, ly = 0;
        canvas.addEventListener('pointerdown', (e) => {
            dragging = true;
            const [px, py] = eventPx(e);
            lx = px;
            ly = py;
            try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
        });
        canvas.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            userHold();
            const [px, py] = eventPx(e);
            const sx = (W / 360) * view.zoom;
            const sy = (H / 180) * view.zoom;
            let dlon = -(px - lx) / sx;
            let dlat = (py - ly) / sy;
            lx = px;
            ly = py;
            view.lon += dlon;
            while (view.lon > 180) view.lon -= 360;
            while (view.lon < -180) view.lon += 360;
            view.lat = Math.max(-85, Math.min(85, view.lat + dlat));
            target.lon = view.lon;
            target.lat = view.lat;
        });
        const endDrag = () => { dragging = false; };
        canvas.addEventListener('pointerup', endDrag);
        canvas.addEventListener('pointercancel', endDrag);
    }

    function drawGraticule() {
        ctx.strokeStyle = 'rgba(125,219,155,0.16)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let lon = -180; lon <= 180; lon += 20) {
            let prev = null;
            for (let lat = -90; lat <= 90; lat += 3) {
                const p = project(lat, lon);
                if (prev && Math.abs(p[0] - prev[0]) < W / 2) { ctx.moveTo(prev[0], prev[1]); ctx.lineTo(p[0], p[1]); }
                prev = p;
            }
        }
        for (let lat = -80; lat <= 80; lat += 20) {
            let prev = null;
            for (let lon = -180; lon <= 180; lon += 3) {
                const p = project(lat, lon);
                if (prev && Math.abs(p[0] - prev[0]) < W / 2) { ctx.moveTo(prev[0], prev[1]); ctx.lineTo(p[0], p[1]); }
                prev = p;
            }
        }
        ctx.stroke();
    }

    function drawDots() {
        const cellPx = (W / COLS) * view.zoom;
        const r = Math.min(3, Math.max(0.6, cellPx * 0.3));
        ctx.fillStyle = 'rgba(125,219,155,0.7)';
        const step = view.zoom > 4 ? 1 : 1;
        for (let row = 0; row < ROWS; row += step) {
            const lat = 90 - (row + 0.5) * (180 / ROWS);
            for (let col = 0; col < COLS; col += step) {
                if (!LAND[row * COLS + col]) continue;
                const lon = -180 + (col + 0.5) * (360 / COLS);
                const p = project(lat, lon);
                if (p[0] < -4 || p[0] > W + 4 || p[1] < -4 || p[1] > H + 4) continue;
                ctx.fillRect(p[0] - r / 2, p[1] - r / 2, r, r);
            }
        }
    }

    function drawMarker() {
        if (!marker) return;
        const p = project(marker.lat, marker.lon);
        if (p[0] < -50 || p[0] > W + 50 || p[1] < -50 || p[1] > H + 50) return;
        // expanding rings
        for (let i = 0; i < 3; i++) {
            const ph = ((tG * 0.7 + i / 3) % 1);
            const rr = 6 + ph * 34;
            ctx.strokeStyle = `rgba(242,201,77,${(0.55 * (1 - ph)).toFixed(3)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(p[0], p[1], rr, 0, Math.PI * 2);
            ctx.stroke();
        }
        // crosshair + blinking core
        const blink = (tG % 1) < 0.6;
        ctx.strokeStyle = AMBER;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p[0] - 9, p[1]); ctx.lineTo(p[0] - 3, p[1]);
        ctx.moveTo(p[0] + 3, p[1]); ctx.lineTo(p[0] + 9, p[1]);
        ctx.moveTo(p[0], p[1] - 9); ctx.lineTo(p[0], p[1] - 3);
        ctx.moveTo(p[0], p[1] + 3); ctx.lineTo(p[0], p[1] + 9);
        ctx.stroke();
        if (blink) {
            ctx.fillStyle = AMBER;
            ctx.fillRect(p[0] - 2, p[1] - 2, 4, 4);
        }
    }

    function drawSweep() {
        if (!playing) return;
        const x = ((tG * 46) % (W + 80)) - 40;
        const g = ctx.createLinearGradient(x - 26, 0, x, 0);
        g.addColorStop(0, 'rgba(125,219,155,0)');
        g.addColorStop(1, 'rgba(125,219,155,0.14)');
        ctx.fillStyle = g;
        ctx.fillRect(x - 26, 0, 26, H);
        ctx.fillStyle = 'rgba(125,219,155,0.35)';
        ctx.fillRect(x, 0, 1, H);
    }

    function drawGlitch() {
        if (!playing || tG < nextGlitchAt) return;
        if (tG > glitchUntil) {
            if (tG > glitchUntil + 0.05) nextGlitchAt = tG + 3 + Math.random() * 6;
            glitchUntil = tG + 0.1 + Math.random() * 0.12;
            return;
        }
        for (let i = 0; i < 3; i++) {
            const sy = Math.random() * H;
            const sh = 3 + Math.random() * 9;
            const dx = (Math.random() - 0.5) * 28;
            try { ctx.drawImage(canvas, 0, sy, W, sh, dx, sy, W, sh); } catch (e) { /* noop */ }
        }
    }

    function text(str, x, y, color, align) {
        ctx.font = '11px "Courier New", monospace';
        ctx.fillStyle = color || GREEN;
        ctx.textAlign = align || 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(str, x, y);
    }

    function drawHud() {
        text('GEO-TRACE // ACTIVE', 8, 7, GREEN);
        const z = `Z x${view.zoom.toFixed(1)}`;
        text(z, W - 8, 7, GREEN, 'right');
        if (unknown) {
            ctx.font = 'bold 15px "Courier New", monospace';
            ctx.fillStyle = AMBER;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('NO SIGNAL', W / 2, H / 2 - 8);
            ctx.font = '11px "Courier New", monospace';
            ctx.fillStyle = GREEN;
            ctx.fillText('LOCATION UNKNOWN', W / 2, H / 2 + 12);
        } else if (marker) {
            const m = marker;
            text(`${(m.city || '?').toUpperCase()} / ${(m.country || '?').toUpperCase()}`, 8, H - 44, AMBER);
            text(`${m.lat.toFixed(2)}  ${m.lon.toFixed(2)}`, 8, H - 30, GREEN);
            if (m.ip) text(m.ip, 8, H - 16, 'rgba(125,219,155,0.6)');
        } else {
            text('ACQUIRING SIGNAL...', 8, H - 20, AMBER);
        }
    }

    function tick(now) {
        if (!running) return;
        const dt = Math.min(0.1, Math.max(0.001, (now - lastT) / 1000));
        lastT = now;
        tG += dt;
        const k = Math.min(1, dt * 2.4);
        view.zoom += (target.zoom - view.zoom) * k;
        view.lat += (target.lat - view.lat) * k;
        view.lon = lerpAngle(view.lon, target.lon, k);
        if (pendingFly && view.zoom < 1.35) {
            view.lat = pendingFly.lat;
            view.lon = pendingFly.lon;
            target.lat = pendingFly.lat;
            target.lon = pendingFly.lon;
            marker = pendingFly;
            pendingFly = null;
            unknown = false;
            target.zoom = 7;
        }
        ctx.fillStyle = '#050505';
        ctx.fillRect(0, 0, W, H);
        drawGraticule();
        drawDots();
        drawSweep();
        drawMarker();
        drawGlitch();
        drawHud();
        rafId = requestAnimationFrame(tick);
    }

    return {
        dbg() { return { view: { ...view }, target: { ...target }, pending: !!pendingFly }; },
        init(canvasEl) {
            canvas = canvasEl;
            ctx = canvas.getContext('2d');
            bindPointer();
            this.resize();
        },
        resize() {
            if (!canvas) return;
            const r = canvas.getBoundingClientRect();
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const w = Math.max(50, Math.round(r.width * dpr));
            const h = Math.max(50, Math.round(r.height * dpr));
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }
            W = canvas.width;
            H = canvas.height;
        },
        start() {
            if (running) return;
            running = true;
            lastT = performance.now();
            nextGlitchAt = 3;
            rafId = requestAnimationFrame(tick);
        },
        stop() {
            running = false;
            cancelAnimationFrame(rafId);
        },
        setPlaying(b) { playing = !!b; },
        acquiring() {
            marker = null;
            unknown = false;
            pendingFly = null;
            target.lat = 25;
            target.lon = 0;
            target.zoom = 1;
        },
        flyTo(lat, lon, info) {
            unknown = false;
            const same = marker && Math.abs(marker.lat - lat) < 0.5 && Math.abs(marker.lon - lon) < 0.5;
            if (same) {
                marker = { lat, lon, city: info.city, country: info.country, ip: info.ip };
                target.zoom = 7;
                return;
            }
            pendingFly = { lat, lon, city: info.city, country: info.country, ip: info.ip };
            target.zoom = 1;
        },
        showUnknown() {
            marker = null;
            pendingFly = null;
            unknown = true;
            target.lat = 25;
            target.lon = 0;
            target.zoom = 1;
        }
    };
})();
