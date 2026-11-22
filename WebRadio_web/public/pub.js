// Public WebRadio player: auth, own station list, direct-first playback.
(() => {
    'use strict';
    const API = 'api/pub';
    const RAPI = 'api/radio';

    // --- Theme (dark / light) ---
    const themeBtn = document.getElementById('theme-btn');
    const applyThemeIcon = () => {
        themeBtn.textContent = document.documentElement.getAttribute('data-theme') === 'light' ? '☀️' : '🌙';
    };
    themeBtn.addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
        const next = cur === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('webradio_theme', next); } catch (e) { /* noop */ }
        applyThemeIcon();
    });
    applyThemeIcon();

    // --- Elements ---
    const authCard = document.getElementById('auth-card');
    const playerCard = document.getElementById('player-card');
    const specCard = document.getElementById('spec-card');
    const listCard = document.getElementById('list-card');
    const authTitle = document.getElementById('auth-title');
    const authLogin = document.getElementById('auth-login');
    const authPass = document.getElementById('auth-pass');
    const authInvite = document.getElementById('auth-invite');
    const authError = document.getElementById('auth-error');
    const authGo = document.getElementById('auth-go');
    const authToggle = document.getElementById('auth-toggle');
    const authToggleText = document.getElementById('auth-toggle-text');
    const userEl = document.getElementById('pub-user');
    const logoutBtn = document.getElementById('logout-btn');
    const coverEl = document.getElementById('pub-cover');
    const trackEl = document.getElementById('pub-track');
    const metaEl = document.getElementById('pub-meta');
    const playBtn = document.getElementById('btn-play');
    const prevBtn = document.getElementById('btn-prev');
    const nextBtn = document.getElementById('btn-next');
    const volEl = document.getElementById('pub-vol');
    const specCanvas = document.getElementById('pub-spectrum');
    const stList = document.getElementById('st-list');
    const stCount = document.getElementById('st-count');
    const listError = document.getElementById('list-error');
    const audioEl = document.getElementById('pub-audio');

    let mode = 'login';
    let playSeq = 0, directSeq = 0;
    let stations = [];
    let playingId = -1;
    let directMode = false; // true = direct upstream, false = via relay
    let probeTimer = 0;

    const api = async (path, opts) => {
        const res = await fetch(path, opts);
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) throw new Error((json && json.message) || `HTTP ${res.status}`);
        return json.data;
    };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // --- Auth ---
    const setMode = (m) => {
        mode = m;
        authTitle.textContent = m === 'login' ? 'Вход' : 'Регистрация';
        authGo.textContent = m === 'login' ? 'Войти' : 'Создать аккаунт';
        authInvite.hidden = m === 'login';
        authToggleText.textContent = m === 'login' ? 'Нет аккаунта?' : 'Уже есть аккаунт?';
        authToggle.textContent = m === 'login' ? 'Регистрация' : 'Вход';
        authError.textContent = '';
    };
    authToggle.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));
    const enter = (login) => {
        authCard.hidden = true;
        playerCard.hidden = specCard.hidden = listCard.hidden = false;
        userEl.hidden = logoutBtn.hidden = false;
        userEl.textContent = login;
        loadStations();
    };
    const showAuth = () => {
        authCard.hidden = false;
        playerCard.hidden = specCard.hidden = listCard.hidden = true;
        userEl.hidden = logoutBtn.hidden = true;
        setMode('login');
    };
    authGo.addEventListener('click', async () => {
        authError.textContent = '';
        authGo.disabled = true;
        try {
            const body = { login: authLogin.value.trim(), password: authPass.value };
            if (mode === 'register') body.invite = authInvite.value.trim();
            const data = await api(`${API}/${mode}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            authPass.value = '';
            enter(data.login);
        } catch (err) {
            authError.textContent = err.message;
        } finally {
            authGo.disabled = false;
        }
    });
    authPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') authGo.click(); });
    logoutBtn.addEventListener('click', async () => {
        stopPlayback();
        try { await api(`${API}/logout`, { method: 'POST' }); } catch (e) { /* noop */ }
        showAuth();
    });

    // --- Stations ---
    const loadStations = async () => {
        try {
            const data = await api(`${API}/stations`);
            stations = data.stations || [];
            render();
        } catch (err) {
            if (String(err.message).includes('401')) showAuth();
            else listError.textContent = err.message;
        }
    };
    const saveOrder = async () => {
        try {
            const data = await api(`${API}/stations`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stations })
            });
            stations = data.stations || stations;
            render();
        } catch (err) {
            listError.textContent = err.message;
        }
    };
    const render = () => {
        stCount.textContent = `· ${stations.length}`;
        stList.innerHTML = '';
        stations.forEach((st, i) => {
            const row = document.createElement('div');
            row.className = 'st-row' + (st.id === playingId ? ' playing' : '');
            row.innerHTML = `<span class="name">${esc(st.name)}</span><span class="genre">${esc(st.genre || '')}</span><span class="ops"></span>`;
            const ops = row.querySelector('.ops');
            const mkBtn = (t, title, fn) => {
                const b = document.createElement('button');
                b.textContent = t;
                b.title = title;
                b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
                ops.appendChild(b);
            };
            mkBtn('↑', 'Выше', () => {
                if (i === 0) return;
                [stations[i - 1], stations[i]] = [stations[i], stations[i - 1]];
                saveOrder();
            });
            mkBtn('↓', 'Ниже', () => {
                if (i === stations.length - 1) return;
                [stations[i + 1], stations[i]] = [stations[i], stations[i + 1]];
                saveOrder();
            });
            mkBtn('✎', 'Переименовать', () => editRow(row, st));
            mkBtn('✕', 'Удалить', async () => {
                if (!confirm(`Удалить «${st.name}»?`)) return;
                try {
                    await api(`${API}/stations/${st.id}`, { method: 'DELETE' });
                    stations = stations.filter((x) => x.id !== st.id);
                    if (playingId === st.id) stopPlayback();
                    render();
                } catch (err) { listError.textContent = err.message; }
            });
            row.addEventListener('click', () => playStation(st));
            stList.appendChild(row);
        });
        playBtn.textContent = playingId === -1 ? '▶' : '⏹';
    };
    const editRow = (row, st) => {
        row.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'edit-row';
        wrap.innerHTML = `<input name="name" maxlength="60"><input name="url"><input name="genre" maxlength="40">`;
        const [nI, uI, gI] = wrap.querySelectorAll('input');
        nI.value = st.name;
        uI.value = st.url;
        gI.value = st.genre || '';
        const ok = document.createElement('button');
        ok.className = 'btn small';
        ok.textContent = 'OK';
        ok.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                await api(`${API}/stations/${st.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: nI.value.trim(), url: uI.value.trim(), genre: gI.value.trim() })
                });
                st.name = nI.value.trim();
                st.url = uI.value.trim();
                st.genre = gI.value.trim();
                render();
            } catch (err) { listError.textContent = err.message; }
        });
        wrap.appendChild(ok);
        row.appendChild(wrap);
        row.onclick = (e) => e.stopPropagation();
    };
    document.getElementById('btn-add').addEventListener('click', async () => {
        const inputs = document.querySelectorAll('.add-form input');
        const [nI, uI, gI] = inputs;
        listError.textContent = '';
        try {
            const data = await api(`${API}/stations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: nI.value.trim(), url: uI.value.trim(), genre: gI.value.trim() })
            });
            stations = data.stations || stations;
            nI.value = uI.value = gI.value = '';
            render();
        } catch (err) { listError.textContent = err.message; }
    });

    // --- Playback: direct-first, relay fallback ---
    const relayUrl = (url) => `${RAPI}/preview?url=${encodeURIComponent(url)}`;
    try { volEl.value = localStorage.getItem('pub_vol') || '80'; } catch (e) { /* noop */ }
    audioEl.volume = volEl.value / 100;
    volEl.addEventListener('input', () => {
        audioEl.volume = volEl.value / 100;
        try { localStorage.setItem('pub_vol', volEl.value); } catch (e) { /* noop */ }
    });
    const setStatus = (track, meta) => {
        trackEl.textContent = track;
        metaEl.textContent = meta;
    };
    audioEl.addEventListener('error', () => {
        if (directMode && playingId !== -1 && playSeq === directSeq) {
            // direct upstream failed (mixed content, dead host, cert, geo-block,
            // https->http downgrade) -> relay, and remember for a day
            try { localStorage.setItem('pub_relay_' + playingId, String(Date.now())); } catch (e) { /* noop */ }
            directMode = false;
            const st = stations.find((x) => x.id === playingId);
            if (st) {
                audioEl.src = relayUrl(st.url);
                audioEl.play().catch((err) => setStatus('Ошибка', String((err && err.message) || err)));
                return;
            }
        }
        if (playingId !== -1) setStatus('Ошибка', 'поток недоступен ни напрямую, ни через релей');
    });
    const relayRemembered = (id) => {
        try {
            const v = parseInt(localStorage.getItem('pub_relay_' + id) || '0', 10) || 0;
            return v > 0 && (Date.now() - v) < 86400000;
        } catch (e) { return false; }
    };
    const playStation = (st) => {
        stopProbeLoop();
        // direct-first, unless this station already proved unplayable directly
        directMode = /^https:/i.test(st.url) && !relayRemembered(st.id);
        directSeq = directMode ? ++playSeq : 0;
        if (!directMode) playSeq++;
        playingId = st.id;
        lastStream = null;
        bandMax = 0;
        peakVals = null; // realloc on next frame, resets session max
        setStatus(st.name, directMode ? 'прямое подключение…' : 'через релей…');
        coverEl.src = 'radio.svg';
        audioEl.src = directMode ? st.url : relayUrl(st.url);
        audioEl.play().catch((err) => setStatus('Ошибка', String((err && err.message) || err)));
        ensureAudioGraph();
        probeNow(st);
        probeTimer = setInterval(() => probeNow(st), 25000);
        render();
    };
    const stopPlayback = () => {
        stopProbeLoop();
        playingId = -1;
        directMode = false;
        audioEl.pause();
        audioEl.removeAttribute('src');
        audioEl.load();
        setStatus('—', '—');
        drawSpectrumIdle();
        render();
    };
    playBtn.addEventListener('click', () => {
        if (playingId !== -1) { stopPlayback(); return; }
        if (stations.length) playStation(stations[0]);
    });
    prevBtn.addEventListener('click', () => stepStation(-1));
    nextBtn.addEventListener('click', () => stepStation(1));
    const stepStation = (d) => {
        if (!stations.length) return;
        let i = stations.findIndex((x) => x.id === playingId);
        i = i < 0 ? (d > 0 ? 0 : stations.length - 1) : (i + d + stations.length) % stations.length;
        playStation(stations[i]);
    };

    // --- Probe: track title, codec, cover ---
    const stopProbeLoop = () => { if (probeTimer) { clearInterval(probeTimer); probeTimer = 0; } };
    const probeNow = async (st) => {
        try {
            const res = await fetch(`${RAPI}/probe?url=${encodeURIComponent(st.url)}`);
            const json = await res.json().catch(() => ({}));
            if (!json.success || playingId !== st.id) return;
            const d = json.data || {};
            const title = d.streamTitle || st.name;
            trackEl.textContent = title + (directMode ? '' : ' · релей');
            if (d.codec || d.bitrate || d.measuredKbps || d.sampleRate || d.channels || d.icyBr) {
                const br = d.bitrate ? `${d.bitrate} kbps` : (d.icyBr ? `${d.icyBr} kbps` : (d.measuredKbps ? `~${d.measuredKbps} kbps` : null));
                const ch = d.channels === 2 ? 'Stereo' : (d.channels === 1 ? 'Mono' : (d.channels ? `${d.channels}ch` : null));
                lastStream = { codec: d.codec, bitrate: br, srHz: d.sampleRate || null, ch };
                refreshMeta();
            }
            if (d.streamTitle) fetchCover(d.streamTitle);
        } catch (e) { /* keep playing on probe errors */ }
    };
    let coverSeq = 0;
    const fetchCover = async (title) => {
        const seq = ++coverSeq;
        try {
            const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(title)}&media=music&entity=song&limit=1`);
            const json = await res.json().catch(() => ({}));
            if (seq !== coverSeq || !json.results || !json.results.length) return;
            const art = json.results[0].artworkUrl100;
            if (art) coverEl.src = art.replace('100x100bb', '300x300bb');
        } catch (e) { /* no cover */ }
    };

    // --- Spectrum: log bars, peak caps on gravity, tune popup (persisted) ---
    const FFT_SIZES = [256, 512, 1024, 2048, 4096, 8192];
    const tune = { grav: 0.6, atk: 0, rel: 0, dbMax: -6, dbMin: -80, fft: 4096, bars: 48 };
    try {
        const saved = JSON.parse(localStorage.getItem('pub_tune') || '{}');
        if (saved.grav >= 0.2 && saved.grav <= 2) tune.grav = saved.grav;
        if (saved.atk >= 0 && saved.atk <= 900) tune.atk = saved.atk;
        if (saved.rel >= 0 && saved.rel <= 900) tune.rel = saved.rel;
        if (saved.dbMax >= -30 && saved.dbMax <= 0) tune.dbMax = saved.dbMax;
        if (saved.dbMin >= -120 && saved.dbMin <= -40) tune.dbMin = saved.dbMin;
        if (FFT_SIZES.includes(saved.fft)) tune.fft = saved.fft;
        if (saved.bars >= 16 && saved.bars <= 96) tune.bars = saved.bars;
    } catch (e) { /* noop */ }
    if (tune.dbMin >= tune.dbMax) tune.dbMin = tune.dbMax - 10;
    let audioCtx = null, analyserNode = null, analyserData = null, spectrumRaf = 0;
    let barVals = null, peakVals = null, peakVel = null, peakLastT = 0, logMap = null;
    let lastStream = null, bandMax = 0;
    const specCtx = specCanvas.getContext('2d');
    const buildLogMap = (n) => {
        const bins = analyserData.length;
        const binHz = audioCtx.sampleRate / analyserNode.fftSize;
        const nyq = audioCtx.sampleRate / 2;
        const fMin = 40;
        const map = [];
        for (let i = 0; i < n; i++) {
            const f0 = fMin * Math.pow(nyq / fMin, i / n);
            const f1 = fMin * Math.pow(nyq / fMin, (i + 1) / n);
            const b0 = Math.max(0, Math.floor(f0 / binHz));
            const b1 = Math.min(bins - 1, Math.max(b0, Math.ceil(f1 / binHz) - 1));
            map.push([b0, b1, f1]);
        }
        return map;
    };
    const fitSpec = () => {
        const r = specCanvas.getBoundingClientRect();
        const w = Math.max(80, Math.round(r.width));
        const h = Math.max(28, Math.round(r.height));
        if (specCanvas.width !== w * 2 || specCanvas.height !== h * 2) {
            specCanvas.width = w * 2;
            specCanvas.height = h * 2;
        }
    };
    const ensureAudioGraph = () => {
        try {
            if (!audioCtx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                audioCtx = new AC();
                analyserNode = audioCtx.createAnalyser();
                analyserNode.fftSize = tune.fft;
                analyserNode.minDecibels = tune.dbMin;
                analyserNode.maxDecibels = tune.dbMax;
                analyserNode.smoothingTimeConstant = 0.8;
                const src = audioCtx.createMediaElementSource(audioEl);
                src.connect(analyserNode);
                analyserNode.connect(audioCtx.destination);
                analyserData = new Uint8Array(analyserNode.frequencyBinCount);
            }
            if (audioCtx.state === 'suspended') audioCtx.resume();
            fitSpec();
            if (!spectrumRaf) drawSpectrum();
        } catch (e) { /* WebAudio unavailable: play without spectrum */ }
    };
    const drawSpectrumIdle = () => {
        specCtx.clearRect(0, 0, specCanvas.width, specCanvas.height);
    };
    const fmtKHz = (hz) => {
        if (!hz || hz <= 0) return '—';
        return hz >= 1000 ? `${String(parseFloat((hz / 1000).toFixed(1))).replace('.', ',')} кГц` : `${Math.round(hz)} Гц`;
    };
    const refreshMeta = () => {
        if (!lastStream) return;
        let srPart = lastStream.srHz ? fmtKHz(lastStream.srHz) : null;
        if (lastStream.srHz && bandMax > 0) srPart += ` (${fmtKHz(bandMax)} макс)`;
        const parts = [lastStream.codec, lastStream.bitrate, srPart, lastStream.ch].filter(Boolean);
        metaEl.textContent = parts.join(' · ') + (directMode ? '' : ' · релей');
    };
    const cssAccent = () => document.documentElement.getAttribute('data-theme') === 'light' ? ['#bfe6cc', '#1d7c3f'] : ['#1d5c33', '#7ddb9b'];
    const drawSpectrum = () => {
        if (!analyserNode || playingId === -1) {
            spectrumRaf = 0;
            drawSpectrumIdle();
            return;
        }
        spectrumRaf = requestAnimationFrame(drawSpectrum);
        analyserNode.getByteFrequencyData(analyserData);
        const W = specCanvas.width, H = specCanvas.height;
        const n = tune.bars;
        if (!peakVals || peakVals.length !== n) {
            peakVals = new Float32Array(n);
            peakVel = new Float32Array(n);
            barVals = new Float32Array(n);
            peakLastT = performance.now();
            bandMax = 0;
            logMap = buildLogMap(n);
            refreshMeta();
        }
        const nowT = performance.now();
        const dt = Math.min(0.1, Math.max(0.001, (nowT - peakLastT) / 1000));
        peakLastT = nowT;
        const GRAV = (2 * H) / (tune.grav * tune.grav);
        const bw = W / n;
        const capH = Math.max(2, H * 0.03);
        let topBin = -1;
        specCtx.clearRect(0, 0, W, H);
        const [c0, c1] = cssAccent();
        const g = specCtx.createLinearGradient(0, H, 0, 0);
        g.addColorStop(0, c0);
        g.addColorStop(1, c1);
        specCtx.fillStyle = g;
        for (let i = 0; i < n; i++) {
            const lb0 = logMap[i][0];
            const lb1 = logMap[i][1];
            let v = 0;
            for (let j = lb0; j <= lb1; j++) if (analyserData[j] > v) v = analyserData[j];
            if (v >= 12) topBin = i;
            const target = (v / 255) * H;
            let bh = barVals[i];
            if (tune.atk > 0 && target > bh) bh = Math.min(target, bh + (H * dt) / (tune.atk / 1000));
            else if (tune.rel > 0 && target < bh) bh = Math.max(target, bh - (H * dt) / (tune.rel / 1000));
            else bh = target;
            barVals[i] = bh;
            const h = Math.max(2, bh);
            if (h >= peakVals[i]) {
                peakVals[i] = h;
                peakVel[i] = 0;
            } else {
                peakVel[i] += GRAV * dt;
                peakVals[i] = Math.max(0, peakVals[i] - peakVel[i] * dt);
            }
            specCtx.fillRect(i * bw + 1, H - h, Math.max(1, bw - 2), h);
        }
        specCtx.fillStyle = '#f2c94d';
        for (let i = 0; i < n; i++) {
            specCtx.fillRect(i * bw + 1, Math.min(H - capH, H - peakVals[i]), Math.max(1, bw - 2), capH);
        }
        const occHz = topBin >= 0 ? logMap[topBin][2] : 0;
        if (occHz > bandMax) {
            bandMax = occHz;
            refreshMeta();
        }
    };
    window.addEventListener('resize', () => { if (playingId !== -1) fitSpec(); });

    // --- Tune popup wiring ---
    const $ = (id) => document.getElementById(id);
    const tDbMaxEl = $('p-tune-dbmax'), tDbMinEl = $('p-tune-dbmin'), tGravEl = $('p-tune-grav');
    const tAtkEl = $('p-tune-atk'), tRelEl = $('p-tune-rel'), tFftEl = $('p-tune-fft'), tBarsEl = $('p-tune-bars');
    const tDbMaxV = $('p-tune-dbmax-v'), tDbMinV = $('p-tune-dbmin-v'), tGravV = $('p-tune-grav-v');
    const tAtkV = $('p-tune-atk-v'), tRelV = $('p-tune-rel-v'), tFftV = $('p-tune-fft-v'), tBarsV = $('p-tune-bars-v');
    const specMenuEl = $('spec-menu');
    const specMenuBtn = $('spec-menu-btn');
    const saveTune = () => {
        try { localStorage.setItem('pub_tune', JSON.stringify(tune)); } catch (e) { /* noop */ }
    };
    const fmtDb = (v) => String(v).replace('-', '−');
    const applyTuneToInputs = () => {
        tGravEl.value = tune.grav;
        tAtkEl.value = tune.atk;
        tRelEl.value = tune.rel;
        tDbMaxEl.value = tune.dbMax;
        tDbMinEl.value = tune.dbMin;
        tFftEl.value = Math.max(0, FFT_SIZES.indexOf(tune.fft));
        tBarsEl.value = tune.bars;
        tGravV.textContent = `${parseFloat(tune.grav.toFixed(1))} с`;
        tAtkV.textContent = `${tune.atk} мс`;
        tRelV.textContent = `${tune.rel} мс`;
        tDbMaxV.textContent = fmtDb(tune.dbMax);
        tDbMinV.textContent = fmtDb(tune.dbMin);
        tFftV.textContent = `${tune.fft}`;
        tBarsV.textContent = `${tune.bars}`;
    };
    const applyDb = () => {
        if (!analyserNode) return;
        analyserNode.minDecibels = tune.dbMin;
        analyserNode.maxDecibels = tune.dbMax;
    };
    const reallocSpectrum = () => {
        if (analyserNode) analyserData = new Uint8Array(analyserNode.frequencyBinCount);
        peakVals = null;
    };
    tGravEl.addEventListener('input', () => {
        tune.grav = parseFloat(tGravEl.value) || 0.6;
        tGravV.textContent = `${parseFloat(tune.grav.toFixed(1))} с`;
        saveTune();
    });
    tAtkEl.addEventListener('input', () => {
        tune.atk = parseInt(tAtkEl.value, 10) || 0;
        tAtkV.textContent = `${tune.atk} мс`;
        saveTune();
    });
    tRelEl.addEventListener('input', () => {
        tune.rel = parseInt(tRelEl.value, 10) || 0;
        tRelV.textContent = `${tune.rel} мс`;
        saveTune();
    });
    tDbMaxEl.addEventListener('input', () => {
        tune.dbMax = parseInt(tDbMaxEl.value, 10);
        if (Number.isNaN(tune.dbMax)) tune.dbMax = -6;
        if (tune.dbMin >= tune.dbMax) {
            tune.dbMin = tune.dbMax - 10;
            tDbMinEl.value = tune.dbMin;
            tDbMinV.textContent = fmtDb(tune.dbMin);
        }
        tDbMaxV.textContent = fmtDb(tune.dbMax);
        applyDb();
        saveTune();
    });
    tDbMinEl.addEventListener('input', () => {
        tune.dbMin = parseInt(tDbMinEl.value, 10);
        if (Number.isNaN(tune.dbMin)) tune.dbMin = -80;
        if (tune.dbMin >= tune.dbMax) {
            tune.dbMax = tune.dbMin + 10;
            if (tune.dbMax > 0) { tune.dbMax = 0; tune.dbMin = -10; }
            tDbMaxEl.value = tune.dbMax;
            tDbMinEl.value = tune.dbMin;
            tDbMaxV.textContent = fmtDb(tune.dbMax);
            tDbMinV.textContent = fmtDb(tune.dbMin);
        } else {
            tDbMinV.textContent = fmtDb(tune.dbMin);
        }
        applyDb();
        saveTune();
    });
    tFftEl.addEventListener('input', () => {
        const idx = Math.min(FFT_SIZES.length - 1, Math.max(0, parseInt(tFftEl.value, 10) || 0));
        tune.fft = FFT_SIZES[idx];
        tFftV.textContent = `${tune.fft}`;
        if (analyserNode && analyserNode.fftSize !== tune.fft) {
            analyserNode.fftSize = tune.fft;
            reallocSpectrum();
        }
        saveTune();
    });
    tBarsEl.addEventListener('input', () => {
        tune.bars = parseInt(tBarsEl.value, 10) || 48;
        tBarsV.textContent = `${tune.bars}`;
        reallocSpectrum();
        saveTune();
    });
    specMenuBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        specMenuEl.hidden = !specMenuEl.hidden;
    });
    document.addEventListener('click', (ev) => {
        if (!specMenuEl.hidden && !specMenuEl.contains(ev.target) && ev.target !== specMenuBtn) {
            specMenuEl.hidden = true;
        }
    });
    applyTuneToInputs();

    // --- Boot ---
    (async () => {
        try {
            const data = await api(`${API}/me`);
            enter(data.login);
        } catch (e) {
            showAuth();
        }
    })();
})();
