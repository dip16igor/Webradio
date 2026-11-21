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
        try { localStorage.setItem('pub_theme', next); } catch (e) { /* noop */ }
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
        if (directMode && playingId !== -1) {
            // direct upstream failed (mixed content, dead host, cert) -> relay
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
    const playStation = (st) => {
        stopProbeLoop();
        directMode = /^https:/i.test(st.url);
        playingId = st.id;
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
            const parts = [d.codec, d.bitrate, d.srHz ? `${d.srHz} Гц` : null, d.ch].filter(Boolean);
            setStatus(title + (directMode ? '' : ' · релей'), parts.join(' · '));
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

    // --- Spectrum (slim: bars + attack/release, no tune panel) ---
    let audioCtx = null, analyserNode = null, analyserData = null, spectrumRaf = 0;
    let barVals = null;
    const specCtx = specCanvas.getContext('2d');
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
                const src = audioCtx.createMediaElementSource(audioEl);
                analyserNode = audioCtx.createAnalyser();
                analyserNode.fftSize = 2048;
                analyserNode.smoothingTimeConstant = 0.8;
                analyserData = new Uint8Array(analyserNode.frequencyBinCount);
                src.connect(analyserNode);
                analyserNode.connect(audioCtx.destination);
            }
            if (audioCtx.state === 'suspended') audioCtx.resume();
            fitSpec();
            if (!spectrumRaf) drawSpectrum();
        } catch (e) { /* WebAudio unavailable: play without spectrum */ }
    };
    const drawSpectrumIdle = () => {
        specCtx.clearRect(0, 0, specCanvas.width, specCanvas.height);
    };
    const cssAccent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7ddb9b';
    const drawSpectrum = () => {
        if (!analyserNode || playingId === -1) {
            spectrumRaf = 0;
            drawSpectrumIdle();
            return;
        }
        spectrumRaf = requestAnimationFrame(drawSpectrum);
        analyserNode.getByteFrequencyData(analyserData);
        const W = specCanvas.width, H = specCanvas.height;
        const n = 48;
        if (!barVals || barVals.length !== n) barVals = new Float32Array(n);
        specCtx.clearRect(0, 0, W, H);
        const dark = document.documentElement.getAttribute('data-theme') !== 'light';
        const g = specCtx.createLinearGradient(0, H, 0, 0);
        if (dark) { g.addColorStop(0, '#1d5c33'); g.addColorStop(1, '#7ddb9b'); }
        else { g.addColorStop(0, '#bfe6cc'); g.addColorStop(1, '#1d7c3f'); }
        specCtx.fillStyle = g;
        // log-spaced bins from ~40 Hz to Nyquist
        const sr = audioCtx.sampleRate, nyq = sr / 2, f0 = 40;
        const bw = W / n;
        for (let i = 0; i < n; i++) {
            const fLo = f0 * Math.pow(nyq / f0, i / n);
            const fHi = f0 * Math.pow(nyq / f0, (i + 1) / n);
            const bLo = Math.floor((fLo / nyq) * analyserData.length);
            const bHi = Math.max(bLo, Math.ceil((fHi / nyq) * analyserData.length) - 1);
            let v = 0;
            for (let j = bLo; j <= bHi && j < analyserData.length; j++) if (analyserData[j] > v) v = analyserData[j];
            const target = ((v - 80) / (255 - 80)) * H; // -80 dBFS floor-ish window
            let bh = barVals[i];
            if (target > bh) bh = Math.min(target, bh + H * 0.25);
            else bh = Math.max(target, bh - H * 0.12);
            barVals[i] = Math.max(0, bh);
            const h = Math.max(2, barVals[i]);
            specCtx.fillRect(i * bw + 1, H - h, Math.max(1, bw - 2), h);
        }
    };
    window.addEventListener('resize', () => { if (playingId !== -1) fitSpec(); });

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
