/* Cover globe map: monochrome hacker-HUD dot-matrix world with fly-to animation.
 * Landmask: 144x72 bitmap (2.5 deg cells), embedded base64. No external tiles. */
window.CoverMap = (() => {
    const COLS = 144, ROWS = 72;
    const LAND = (() => {
        const bin = atob('__LAND_B64__');
        const out = new Uint8Array(COLS * ROWS);
        for (let i = 0; i < out.length; i++) {
            out[i] = (bin.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
        }
        return out;
    })();

    const GREEN = '#7ddb9b';
    const AMBER = '#f2c94d';
    const CYAN = '#00f0ff';
    const MAGENTA = '#ff00a0';
    const BORDERS = __BORDERS_JSON__;

    let canvas = null, ctx = null, W = 0, H = 0;
    let running = false, rafId = 0, lastT = 0, lastDrawT = 0;
    let playing = false;
    let mapStyle = 'dots'; // 'dots' | 'borders'
    let tG = 0;
    let nextGlitchAt = 0, glitchUntil = 0;

    const view = { lat: 25, lon: 0, zoom: 1 };
    const target = { lat: 25, lon: 0, zoom: 1 };
    let pendingFly = null;
    let zoomTween = null; // {from, to, t, dur}: smooth zoom-in after pan
    function startZoomTween(to, dur) {
        zoomTween = { from: view.zoom, to, t: 0, dur };
    }
    let panTween = null; // {fromLat, fromLon, toLat, dlon, t, dur}: panoramic flight
    function startPanTween(to) {
        let dlon = to.lon - view.lon;
        while (dlon > 180) dlon -= 360;
        while (dlon < -180) dlon += 360;
        const dist = Math.hypot(to.lat - view.lat, dlon);
        panTween = { fromLat: view.lat, fromLon: view.lon, toLat: to.lat, dlon, t: 0, dur: Math.min(2.4, 1.0 + dist / 180 * 1.4) };
    }
    let marker = null; // {lat, lon, city, country, ip}
    let unknown = false;
    let arriveCb = null;
    let arriveNotified = true;
    function notifyArrived() {
        if (arriveNotified) return;
        arriveNotified = true;
        const cb = arriveCb;
        arriveCb = null;
        if (cb) { try { cb(); } catch (e) { /* noop */ } }
    }

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
        zoomTween = null;
        panTween = null;
        notifyArrived(); // don't hold pending transitions hostage
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

    function drawGraticule(color) {
        ctx.strokeStyle = color || 'rgba(125,219,155,0.16)';
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
        const step = 1;
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

    function traceBorders() {
        ctx.beginPath();
        for (const ring of BORDERS) {
            let prev = null;
            for (let i = 0; i < ring.length; i++) {
                const p = project(ring[i][1], ring[i][0]); // rings store [lon, lat]
                if (prev && Math.abs(p[0] - prev[0]) < W / 2) {
                    ctx.moveTo(prev[0], prev[1]);
                    ctx.lineTo(p[0], p[1]);
                }
                prev = p;
            }
        }
    }
    function drawBorders() {
        // fake glow: wide soft pass + thin core pass. No shadowBlur:
        // a shadow on a 6k-point path every frame is the top CPU sink.
        const w = Math.max(1, Math.min(2, view.zoom * 0.3));
        ctx.lineWidth = w * 2.5;
        ctx.strokeStyle = 'rgba(0,240,255,0.16)';
        traceBorders();
        ctx.stroke();
        ctx.lineWidth = w;
        ctx.strokeStyle = 'rgba(0,240,255,0.6)';
        traceBorders();
        ctx.stroke();
    }

    // Cyberpunk scan band sweeping top->bottom; returns band center Y.
    function drawScan() {
        const bandH = Math.max(26, H * 0.14);
        const y = ((tG * 55) % (H + bandH * 2)) - bandH;
        const g = ctx.createLinearGradient(0, y - bandH, 0, y + bandH);
        g.addColorStop(0, 'rgba(0,240,255,0)');
        g.addColorStop(0.5, 'rgba(0,240,255,0.13)');
        g.addColorStop(1, 'rgba(0,240,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, Math.max(0, y - bandH), W, bandH * 2);
        ctx.fillStyle = 'rgba(0,240,255,0.5)';
        ctx.fillRect(0, Math.max(0, Math.min(H - 1, y)), W, 1);
        return y;
    }

    let lastScanSide = 0;
    let pingT = -10;
    function drawMarker(scanY) {
        if (!marker) return;
        const p = project(marker.lat, marker.lon);
        if (p[0] < -50 || p[0] > W + 50 || p[1] < -50 || p[1] > H + 50) return;
        const cyber = mapStyle === 'borders';
        const main = cyber ? CYAN : AMBER;
        const fade = (a) => cyber ? `rgba(0,240,255,${a})` : `rgba(242,201,77,${a})`;
        let glow = 1;
        if (cyber && typeof scanY === 'number') {
            glow = Math.max(0.25, 1 - Math.abs(p[1] - scanY) / (H * 0.3));
            const side = (p[1] >= scanY) ? 1 : -1;
            if (side !== lastScanSide) { pingT = tG; lastScanSide = side; }
        }
        // expanding rings
        for (let i = 0; i < 3; i++) {
            const ph = ((tG * 0.7 + i / 3) % 1);
            const rr = 6 + ph * 34;
            ctx.strokeStyle = fade((0.55 * (1 - ph) * glow).toFixed(3));
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(p[0], p[1], rr, 0, Math.PI * 2);
            ctx.stroke();
        }
        // scan ping ring, emitted each time the band passes the dot
        if (cyber && tG - pingT < 1.2) {
            const ph = (tG - pingT) / 1.2;
            ctx.strokeStyle = fade((0.8 * (1 - ph)).toFixed(3));
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(p[0], p[1], 4 + ph * 46, 0, Math.PI * 2);
            ctx.stroke();
        }
        // crosshair + blinking core, brightness synced with the scan
        const blink = (tG % 1) < 0.6;
        ctx.strokeStyle = main;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p[0] - 9, p[1]); ctx.lineTo(p[0] - 3, p[1]);
        ctx.moveTo(p[0] + 3, p[1]); ctx.lineTo(p[0] + 9, p[1]);
        ctx.moveTo(p[0], p[1] - 9); ctx.lineTo(p[0], p[1] - 3);
        ctx.moveTo(p[0], p[1] + 3); ctx.lineTo(p[0], p[1] + 9);
        ctx.stroke();
        if (blink) {
            ctx.globalAlpha = glow;
            ctx.fillStyle = cyber ? MAGENTA : AMBER;
            ctx.fillRect(p[0] - 2, p[1] - 2, 4, 4);
            ctx.globalAlpha = 1;
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
        const hud = mapStyle === 'borders' ? CYAN : GREEN;
        text('GEO-TRACE // ACTIVE', 8, 7, hud);
        text(`Z x${view.zoom.toFixed(1)}`, W - 8, H - 16, hud, 'right');
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
        if (zoomTween) {
            zoomTween.t += dt;
            let p = Math.min(1, zoomTween.t / zoomTween.dur);
            p = p * p * p * (p * (p * 6 - 15) + 10); // smootherstep: gentle in/out
            view.zoom = target.zoom = zoomTween.from + (zoomTween.to - zoomTween.from) * p;
            if (p >= 1) zoomTween = null;
        } else {
            view.zoom += (target.zoom - view.zoom) * k;
        }
        if (panTween) {
            panTween.t += dt;
            let p = Math.min(1, panTween.t / panTween.dur);
            p = p * p * p * (p * (p * 6 - 15) + 10); // smootherstep pan
            view.lat = panTween.fromLat + (panTween.toLat - panTween.fromLat) * p;
            view.lon = panTween.fromLon + panTween.dlon * p;
            while (view.lon > 180) view.lon -= 360;
            while (view.lon < -180) view.lon += 360;
            if (p >= 1) {
                view.lat = panTween.toLat;
                let fl = panTween.fromLon + panTween.dlon;
                while (fl > 180) fl -= 360;
                while (fl < -180) fl += 360;
                view.lon = fl;
                target.lat = panTween.toLat;
                target.lon = fl;
                panTween = null;
                startZoomTween(7, 2.8);
            }
        } else {
            view.lat += (target.lat - view.lat) * k;
            view.lon = lerpAngle(view.lon, target.lon, k);
        }
        if (pendingFly && !zoomTween && !panTween && view.zoom < 2.15) {
            // zoomed out to z=2: start panoramic flight, dive in on arrival
            marker = pendingFly;
            target.lat = pendingFly.lat;
            target.lon = pendingFly.lon;
            const dest = pendingFly;
            pendingFly = null;
            unknown = false;
            startPanTween(dest);
        }
        if (!arriveNotified && !pendingFly && !zoomTween && !panTween && Math.abs(view.zoom - target.zoom) < 0.05) {
            notifyArrived();
        }
        if (now - lastDrawT >= 33) { // 30fps draw gate: motion state still ticks every rAF
            lastDrawT = now;
        ctx.fillStyle = mapStyle === 'borders' ? '#07070f' : '#050505';
        ctx.fillRect(0, 0, W, H);
        if (mapStyle === 'borders') {
            drawGraticule('rgba(0,240,255,0.12)');
            drawBorders();
            const scanY = drawScan();
            drawMarker(scanY);
        } else {
            drawGraticule();
            drawDots();
            drawSweep();
            drawMarker(null);
        }
        drawGlitch();
        drawHud();
        } // end 30fps draw gate
        rafId = requestAnimationFrame(tick);
    }

    return {
        dbg() { return { view: { ...view }, target: { ...target }, pending: !!pendingFly }; },
        setStyle(s) { if (s === 'dots' || s === 'borders') mapStyle = s; },
        getStyle() { return mapStyle; },
        whenArrived(cb) {
            if (arriveNotified) { setTimeout(cb, 0); return; }
            arriveCb = cb;
        },
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
            zoomTween = null;
            panTween = null;
            arriveCb = null;
            arriveNotified = true;
            target.lat = 25;
            target.lon = 0;
            target.zoom = 1;
        },
        flyTo(lat, lon, info) {
            unknown = false;
            arriveNotified = false;
            const same = marker && Math.abs(marker.lat - lat) < 0.5 && Math.abs(marker.lon - lon) < 0.5;
            if (same) {
                marker = { lat, lon, city: info.city, country: info.country, ip: info.ip };
                target.zoom = 7;
                return;
            }
            pendingFly = { lat, lon, city: info.city, country: info.country, ip: info.ip };
            target.zoom = 2;
        },
        showUnknown() {
            marker = null;
            pendingFly = null;
            zoomTween = null;
            panTween = null;
            unknown = true;
            notifyArrived(); // no zoom-in coming: release pending transitions
            target.lat = 25;
            target.lon = 0;
            target.zoom = 1;
        }
    };
})();
