document.addEventListener('DOMContentLoaded', () => {

    // --- CONFIGURATION ---
    // Strip the page filename to get the base path (works under /webradio/ subpath and at root)
    const BASE_PATH = window.location.pathname.replace(/\/[^/]*$/, '');
    const API_BASE_PATH = `${BASE_PATH}/api/radio`;

    // --- DOM ELEMENTS ---
    const tbody = document.querySelector('#station-table tbody');
    const metaEl = document.getElementById('meta');
    const statusEl = document.getElementById('status');
    const genreList = document.getElementById('genre-list');
    const addBtn = document.getElementById('btn-add');
    const saveBtn = document.getElementById('btn-save');
    const exportBtn = document.getElementById('btn-export');
    const reloadBtn = document.getElementById('btn-reload');
    const importFile = document.getElementById('import-file');
    const audioEl = document.getElementById('preview-audio');
    const panelStateEl = document.getElementById('preview-state');
    const panelStationEl = document.getElementById('preview-station');
    const panelCodecEl = document.getElementById('preview-codec');
    const panelTrackEl = document.getElementById('preview-track');
    const panelExtraEl = document.getElementById('preview-extra');
    const panelCoverEl = document.getElementById('preview-cover');
    const coverNoiseEl = document.getElementById('cover-noise');
    const coverTrackEl = document.getElementById('cover-track');
    const mapCanvasEl = document.getElementById('cover-map');
    const globeBtn = document.getElementById('cover-globe-btn');
    const mapStyleBtn = document.getElementById('map-style-btn');
    const leafletBoxEl = document.getElementById('cover-leaflet');
    const lfZoomEl = document.getElementById('lf-zoom');
    const lfLabelEl = document.getElementById('lf-label');

    // Cover appearance FX: genre picks the world (CRT / glitch / Moon shot).
    const COVER_FX = ['fx-tv', 'fx-glitch', 'fx-moon'];
    let coverFxTimer = 0;
    const coverFxForGenre = (genre) => {
        const g = String(genre || '').toLowerCase();
        if (/electro|techno|dance|house|trance|edm|synth|industrial|ebm|rave|dnb|dubstep/.test(g)) return 'fx-glitch';
        if (/jazz|classic|ambient|chill|lofi|lo-fi|lounge|acoustic|folk|blues|soul|opera|symph/.test(g)) return 'fx-tv';
        return 'fx-moon';
    };
    const clearCoverFx = () => {
        clearTimeout(coverFxTimer);
        panelCoverEl.classList.remove('fx-tv', 'fx-glitch', 'fx-moon', 'fx-dropout');
        coverNoiseEl.classList.remove('on');
        coverTrackEl.classList.remove('on');
    };
    const triggerCoverFx = (genre) => {
        panelCoverEl.classList.remove('fx-tv', 'fx-glitch', 'fx-moon');
        void panelCoverEl.offsetWidth;
        panelCoverEl.classList.add(coverFxForGenre(genre));
        coverNoiseEl.classList.add('on');
        clearTimeout(coverFxTimer);
        coverFxTimer = setTimeout(() => {
            panelCoverEl.classList.remove('fx-tv', 'fx-glitch', 'fx-moon');
            if (!panelCoverEl.classList.contains('fx-dropout')) coverNoiseEl.classList.remove('on');
        }, 3000);
    };
    const applyCover = (url, genre) => {
        const pre = new Image();
        pre.onload = () => {
            stopCoverWait();
            coverNoiseEl.classList.remove('dark');
            coverCardEl.classList.remove('nosignal');
            hasCoverArt = true;
            panelCoverEl.src = url;
            if (!mapPinned) setCoverView('cover');
            triggerCoverFx(genre);
        };
        pre.onerror = () => { /* keep current cover */ };
        pre.src = url;
    };
    const showDropoutFx = (on) => {
        if (on) {
            panelCoverEl.classList.add('fx-dropout');
            coverNoiseEl.classList.add('on');
            coverTrackEl.classList.add('on');
        } else {
            panelCoverEl.classList.remove('fx-dropout');
            coverTrackEl.classList.remove('on');
            if (!COVER_FX.some((c) => panelCoverEl.classList.contains(c))) coverNoiseEl.classList.remove('on');
        }
    };

    // Cover wait: old image dissolves into noise at once, then black + faint noise.
    let coverWaiting = false;
    let coverWaitTimers = [];
    const startCoverWait = () => {
        stopCoverWait();
        coverWaiting = true;
        coverCardEl.classList.remove('nosignal');
        coverNoiseEl.classList.remove('snow', 'dark');
        void coverNoiseEl.offsetWidth;
        coverCardEl.classList.add('nosignal');
        coverNoiseEl.classList.add('ramp-fast');
        coverWaitTimers.push(setTimeout(() => {
            if (!coverWaiting) return;
            coverNoiseEl.classList.remove('ramp-fast');
            coverNoiseEl.classList.add('snow');
        }, 2000));
        coverWaitTimers.push(setTimeout(() => {
            if (!coverWaiting) return;
            coverNoiseEl.classList.remove('snow');
            coverNoiseEl.classList.add('dark');
        }, 4500));
    };
    const stopCoverWait = () => {
        coverWaiting = false;
        coverWaitTimers.forEach(clearTimeout);
        coverWaitTimers = [];
        coverNoiseEl.classList.remove('ramp-fast', 'snow');
    };

    // Cover card views: album art vs server geo map.
    let coverView = 'cover';
    let mapPinned = false;
    let hasCoverArt = false;
    let coverHoldForMap = false;
    let pendingCover = null;
    let coverHoldSeq = 0;
    let mapStyle = 'dots';
    const MAP_STYLES = ['dots', 'borders', 'leaflet'];
    const MAP_TITLES = { dots: 'Карта: точки', borders: 'Карта: границы', leaflet: 'Карта: Leaflet' };
    try {
        const s = localStorage.getItem('webradio_mapstyle');
        if (MAP_STYLES.includes(s)) mapStyle = s;
    } catch (e) { /* noop */ }
    const applyMapStyle = () => {
        if (mapStyle !== 'leaflet') CoverMap.setStyle(mapStyle);
        mapStyleBtn.title = MAP_TITLES[mapStyle] || 'Карта';
    };
    const updateMapNoise = () => {
        coverNoiseEl.classList.toggle('hud', coverView === 'map' && playingIndex !== -1);
    };
    // --- Leaflet map style (dark tiles, no labels) ---
    let lfMap = null, lfMarker = null, lfFlying = false, lfArriveCb = null;
    let lastGeo = null;
    const lfMarkIcon = () => L.divIcon({ className: 'lf-mark-wrap', html: '<div class="lf-mark"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
    const setLfLabel = (html, amber) => {
        lfLabelEl.innerHTML = html;
        lfLabelEl.classList.toggle('amber', !!amber);
    };
    const updateLfHud = () => {
        if (!lfMap) return;
        lfZoomEl.textContent = `Z x${lfMap.getZoom().toFixed(1)}`;
    };
    const lfInit = () => {
        if (lfMap || typeof L === 'undefined') return;
        lfMap = L.map('lf-map', { zoomControl: false, minZoom: 1, maxZoom: 12, worldCopyJump: true, zoomSnap: 0.25 });
        lfMap.attributionControl.setPrefix(false);
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Esri', maxZoom: 12
        }).addTo(lfMap);
        lfMap.setView([25, 0], 1);
        lfMap.on('zoomend moveend', () => {
            updateLfHud();
            if (lfFlying) {
                lfFlying = false;
                const cb = lfArriveCb;
                lfArriveCb = null;
                if (cb) cb();
            }
        });
        lfMap.on('dragstart', () => {
            if (lfFlying) {
                lfFlying = false;
                const cb = lfArriveCb;
                lfArriveCb = null;
                if (cb) cb();
            }
        });
    };
    const lfShowPlace = (lat, lon, info, animate) => {
        lastGeo = { lat, lon, info };
        setLfLabel(`${escHtml(info.city || '?').toUpperCase()} / ${escHtml(info.country || '?').toUpperCase()}<br>${lat.toFixed(2)} ${lon.toFixed(2)}${info.ip ? `<br>${escHtml(info.ip)}` : ''}`, false);
        if (!lfMap) return;
        if (!lfMarker) {
            lfMarker = L.marker([lat, lon], { icon: lfMarkIcon(), interactive: false }).addTo(lfMap);
        } else {
            lfMarker.setLatLng([lat, lon]);
        }
        if (animate && coverView === 'map') {
            lfFlying = true;
            lfMap.flyTo([lat, lon], 7, { duration: 2.8 });
        } else {
            lfFlying = false;
            lfMap.setView([lat, lon], 7);
        }
        updateLfHud();
    };
    const lfOnArrived = (cb) => {
        if (!lfFlying) { setTimeout(cb, 0); return; }
        lfArriveCb = cb;
    };
    const lfAcquiring = () => {
        setLfLabel('ACQUIRING…', true);
        if (!lfMap) return;
        lfFlying = false;
        lfArriveCb = null;
        lfMap.setView([25, 0], 1);
        updateLfHud();
    };
    const lfShowUnknown = () => {
        setLfLabel('LOCATION UNKNOWN', true);
        if (!lfMap) return;
        lfFlying = false;
        const cb = lfArriveCb;
        lfArriveCb = null;
        lfMap.setView([25, 0], 1);
        updateLfHud();
        if (cb) cb();
    };
    const setCoverView = (which) => {
        coverView = which;
        const isMap = which === 'map';
        const useLeaflet = isMap && mapStyle === 'leaflet';
        panelCoverEl.hidden = isMap;
        mapCanvasEl.hidden = !isMap || useLeaflet;
        leafletBoxEl.hidden = !useLeaflet;
        globeBtn.classList.toggle('active', isMap);
        mapStyleBtn.hidden = !isMap;
        if (useLeaflet) {
            lfInit();
            if (lfMap) {
                requestAnimationFrame(() => {
                    if (!lfMap) return;
                    lfMap.invalidateSize();
                    updateLfHud();
                });
            }
            coverNoiseEl.classList.remove('on', 'ramp-fast', 'snow');
            CoverMap.stop();
            if (lastGeo && lastGeo.info) lfShowPlace(lastGeo.lat, lastGeo.lon, lastGeo.info, true);
            else lfAcquiring();
        } else if (isMap) {
            coverNoiseEl.classList.remove('on', 'ramp-fast', 'snow');
            CoverMap.resize();
            CoverMap.start();
        } else {
            CoverMap.stop();
        }
        updateMapNoise();
    };
    const noteNoCover = () => {
        hasCoverArt = false;
        if (!mapPinned && playingIndex !== -1) setCoverView('map');
    };
    const fetchStationGeo = (url, index) => {
        if (coverView === 'map') {
            if (mapStyle === 'leaflet') lfAcquiring();
            else CoverMap.acquiring();
        }
        const token = getToken();
        if (!token) return;
        fetch(`${API_BASE_PATH}/geo?url=${encodeURIComponent(url)}`, {
            headers: { 'X-Auth-Token': token }
        })
            .then((res) => res.json().catch(() => ({})))
            .then((json) => {
                if (index !== playingIndex) return;
                const d = json && json.data;
                if (json && json.success && d && !d.unknown && typeof d.lat === 'number' && typeof d.lon === 'number') {
                    const info = { city: d.city, country: d.country, ip: d.ip };
                    CoverMap.flyTo(d.lat, d.lon, info);
                    lastGeo = { lat: d.lat, lon: d.lon, info };
                    if (lfMap) lfShowPlace(d.lat, d.lon, info, coverView === 'map' && mapStyle === 'leaflet');
                } else {
                    CoverMap.showUnknown();
                    lastGeo = null;
                    if (lfMap) lfShowUnknown();
                }
            })
            .catch(() => { if (index !== playingIndex) return; CoverMap.showUnknown(); lastGeo = null; if (lfMap) lfShowUnknown(); });
    };
    globeBtn.addEventListener('click', () => {
        if (coverView === 'map') {
            mapPinned = false;
            if (hasCoverArt) setCoverView('cover');
        } else {
            mapPinned = true;
            setCoverView('map');
        }
    });
    mapStyleBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const order = ['dots', 'borders', 'leaflet'];
        const cur = MAP_STYLES.includes(mapStyle) ? mapStyle : CoverMap.getStyle();
        mapStyle = order[(order.indexOf(cur) + 1) % order.length];
        try { localStorage.setItem('webradio_mapstyle', mapStyle); } catch (e) { /* noop */ }
        applyMapStyle();
        // a style switch means the user wants to look at the map: drop any pending cover hold
        pendingCover = null;
        coverHoldForMap = false;
        if (coverView === 'map') setCoverView('map');
    });
    CoverMap.init(mapCanvasEl);
    applyMapStyle();
    const panelStopBtn = document.getElementById('preview-stop');
    const panelPrevBtn = document.getElementById('preview-prev');
    const panelNextBtn = document.getElementById('preview-next');
    const panelVolEl = document.getElementById('preview-vol');
    const panelCanvasEl = document.getElementById('preview-spectrum');

    // Cover card stays square with side = right column height.
    const coverCardEl = document.querySelector('.card-cover');
    const rightColEl = document.querySelector('.preview-right');
    const fitCover = () => {
        if (!coverCardEl || !rightColEl) return;
        if (coverView === 'map' && mapStyle === 'leaflet' && lfMap) lfMap.invalidateSize();
        if (window.innerWidth <= 700) { coverCardEl.style.width = ''; CoverMap.resize(); return; }
        const h = Math.round(rightColEl.getBoundingClientRect().height);
        if (h > 60 && Math.abs(h - coverCardEl.getBoundingClientRect().width) > 1) {
            coverCardEl.style.width = `${h}px`;
        }
        CoverMap.resize();
    };
    if (window.ResizeObserver && rightColEl) {
        new ResizeObserver(() => fitCover()).observe(rightColEl);
    }
    window.addEventListener('resize', fitCover);

    // --- STATE ---
    let stations = []; // working copy: [{name, url, genre}]
    let playingIndex = -1;
    let probeTimer = null;
    let lastProbeUrl = '';

    // --- TOKEN ---
    const getToken = () => {
        let token = localStorage.getItem('secret_token');
        if (!token) {
            token = prompt('Please enter the secret token');
            if (token) localStorage.setItem('secret_token', token);
        }
        return token;
    };

    // --- UI HELPERS ---
    const showStatus = (ok, text) => {
        statusEl.className = ok ? 'ok' : 'err';
        statusEl.textContent = text;
    };

    const updateGenres = () => {
        const genres = [...new Set(stations.map(s => s.genre).filter(Boolean))].sort();
        genreList.innerHTML = genres.map(g => `<option value="${g.replace(/"/g, '&quot;')}">`).join('');
    };

    // --- COUNTRY FLAGS (lazy, throttled: ip-api allows 45 req/min) ---
    const geoCcCache = (() => { try { return JSON.parse(localStorage.getItem('webradio_geo_cc') || '{}'); } catch (e) { return {}; } })();
    const geoPending = [];
    let geoPumpOn = false;
    const pumpGeoFlags = () => {
        if (geoPumpOn) return; geoPumpOn = true;
        const step = () => {
            const url = geoPending.shift();
            if (!url) { geoPumpOn = false; return; }
            const done = () => { setTimeout(step, 1500); };
            fetch(API_BASE_PATH + '/geo?url=' + encodeURIComponent(url), { headers: { 'X-Auth-Token': getToken() } })
                .then(r => r.json().catch(() => ({})))
                .then(j => {
                    const cc = ((j && j.data && j.data.countryCode) || '').toLowerCase();
                    if (/^[a-z]{2}$/.test(cc)) {
                        geoCcCache[url] = cc;
                        try { localStorage.setItem('webradio_geo_cc', JSON.stringify(geoCcCache)); } catch (e) {}
                        tbody.querySelectorAll('img.st-flag').forEach(im => {
                            if (im.dataset.geoUrl === url && !im.getAttribute('src')) {
                                im.src = 'https://flagcdn.com/w20/' + cc + '.png';
                                im.srcset = 'https://flagcdn.com/w40/' + cc + '.png 2x';
                            }
                        });
                    }
                })
                .catch(() => {})
                .finally(done);
        };
        step();
    };
    const geoFlagImg = (url) => {
        const img = document.createElement('img');
        img.className = 'st-flag';
        img.alt = '';
        img.dataset.geoUrl = url || '';
        const cc = url && geoCcCache[url];
        if (cc) {
            img.src = 'https://flagcdn.com/w20/' + cc + '.png';
            img.srcset = 'https://flagcdn.com/w40/' + cc + '.png 2x';
        } else if (url && !geoPending.includes(url)) {
            geoPending.push(url);
            pumpGeoFlags();
        }
        return img;
    };

    const move = (index, delta) => {
        const target = index + delta;
        if (target < 0 || target >= stations.length) return;
        [stations[index], stations[target]] = [stations[target], stations[index]];
        render();
    };

    const remove = (index) => {
        if (stations.length <= 1) {
            showStatus(false, 'Cannot delete the last station.');
            return;
        }
        stations.splice(index, 1);
        render();
    };

    const addRow = () => {
        stations.push({ name: '', url: '', genre: 'radio' });
        render();
        // Focus the newly added name input
        const rows = tbody.querySelectorAll('tr');
        const last = rows[rows.length - 1];
        if (last) last.querySelector('.col-name input').focus();
    };

    const render = () => {
        tbody.innerHTML = '';
        stations.forEach((station, index) => {
            const tr = document.createElement('tr');

            const numTd = document.createElement('td');
            numTd.className = 'num';
            numTd.textContent = index + 1;
            tr.appendChild(numTd);

            const nameTd = document.createElement('td');
            nameTd.className = 'col-name';
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = station.name || '';
            nameInput.placeholder = 'Station name';
            nameInput.addEventListener('input', () => { station.name = nameInput.value; });
            nameTd.appendChild(nameInput);
            nameTd.appendChild(geoFlagImg(station.url));
            tr.appendChild(nameTd);

            const urlTd = document.createElement('td');
            urlTd.className = 'col-url';
            const urlInput = document.createElement('input');
            urlInput.type = 'text';
            urlInput.value = station.url || '';
            urlInput.placeholder = 'http://stream.example.com/radio';
            urlInput.addEventListener('input', () => { station.url = urlInput.value; });
            urlTd.appendChild(urlInput);
            tr.appendChild(urlTd);

            const genreTd = document.createElement('td');
            genreTd.className = 'col-genre';
            const genreSel = document.createElement('select');
            // Белый список жанров (сервис + Android знают ровно эти 14)
            const GENRES = ['ambient', 'chill', 'chillout', 'downtempo', 'electronic', 'jazz', 'lofi', 'lounge', 'nature', 'pop', 'radio', 'relax', 'rock', 'trip-hop'];
            const curGenre = (station.genre || 'radio').trim();
            if (!GENRES.includes(curGenre)) GENRES.push(curGenre); // legacy-значение не теряем
            for (const g of GENRES) {
                const o = document.createElement('option');
                o.value = g;
                o.textContent = g;
                if (g === curGenre) o.selected = true;
                genreSel.appendChild(o);
            }
            genreSel.addEventListener('change', () => { station.genre = genreSel.value; });
            genreTd.appendChild(genreSel);
            tr.appendChild(genreTd);

            const actionsTd = document.createElement('td');
            actionsTd.className = 'col-actions';

            const upBtn = document.createElement('button');
            upBtn.className = 'icon-btn';
            upBtn.textContent = '\u2191';
            upBtn.title = 'Move up';
            upBtn.disabled = index === 0;
            upBtn.addEventListener('click', () => move(index, -1));

            const downBtn = document.createElement('button');
            downBtn.className = 'icon-btn';
            downBtn.textContent = '\u2193';
            downBtn.title = 'Move down';
            downBtn.disabled = index === stations.length - 1;
            downBtn.addEventListener('click', () => move(index, 1));

            const delBtn = document.createElement('button');
            delBtn.className = 'icon-btn danger';
            delBtn.textContent = '\u2715';
            delBtn.title = 'Delete';
            delBtn.addEventListener('click', () => remove(index));

            const playBtn = document.createElement('button');
            playBtn.className = 'icon-btn';
            const isPlaying = index === playingIndex;
            playBtn.textContent = isPlaying ? '\u25a0' : '\u25b6';
            playBtn.title = isPlaying ? 'Stop preview' : 'Play preview in browser';
            playBtn.addEventListener('click', () => {
                if (index === playingIndex) stopPlayback();
                else playStation(index);
            });

            actionsTd.append(playBtn, upBtn, downBtn, delBtn);
            if (isPlaying) tr.classList.add('playing');
            tr.appendChild(actionsTd);

            tbody.appendChild(tr);
        });
        const hasStations = stations.length > 0;
        panelStopBtn.textContent = playingIndex === -1 ? '▶' : '⏹';
        panelStopBtn.classList.toggle('danger', playingIndex !== -1);
        panelStopBtn.disabled = !hasStations;
        panelPrevBtn.disabled = !hasStations;
        panelNextBtn.disabled = !hasStations;
        updateGenres();
    };

    // --- API ---
    const loadStations = async () => {
        const token = getToken();
        if (!token) return;
        metaEl.textContent = 'Loading station list...';
        try {
            const res = await fetch(`${API_BASE_PATH}/stations`, {
                headers: { 'X-Auth-Token': token }
            });
            if (res.status === 401) {
                localStorage.removeItem('secret_token');
                showStatus(false, 'Unauthorized. Token cleared - reload to re-enter.');
                return;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (!json.success) throw new Error('Bad response');
            stations = json.data.stations.map(s => ({ id: s.id, name: s.name, url: s.url, genre: s.genre || 'radio' }));
            metaEl.textContent = `${stations.length} stations \u00b7 version ${json.data.version} \u00b7 updated ${json.data.updatedAt || 'n/a'}`;
            render();
        } catch (err) {
            metaEl.textContent = 'Failed to load station list.';
            showStatus(false, `Error: ${err.message}`);
        }
    };

    const saveStations = async () => {
        const token = getToken();
        if (!token) return;
        const empty = stations.findIndex(s => !s.name.trim() || !s.url.trim());
        if (empty !== -1) {
            showStatus(false, `Station #${empty + 1} has an empty name or URL.`);
            return;
        }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        try {
            const res = await fetch(`${API_BASE_PATH}/stations`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
                body: JSON.stringify({ stations: stations.map(s => ({ id: s.id, name: s.name.trim(), url: s.url.trim(), genre: s.genre.trim() })) })
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                const detail = json.errors ? json.errors.map(e => `#${e.station + 1}: ${e.message}`).join('; ') : (json.message || `HTTP ${res.status}`);
                showStatus(false, `Save failed: ${detail}`);
                return;
            }
            stations = json.data.stations.map(s => ({ id: s.id, name: s.name, url: s.url, genre: s.genre || 'radio' }));
            metaEl.textContent = `${stations.length} stations \u00b7 version ${json.data.version} \u00b7 updated ${json.data.updatedAt}`;
            showStatus(true, `Saved ${stations.length} stations (version ${json.data.version}). Published to devices.`);
            render();
        } catch (err) {
            showStatus(false, `Save failed: ${err.message}`);
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
        }
    };

    const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // --- BROWSER PREVIEW (plays through the server pipe, same-origin) ---
    const setPanel = (state, station, codec, track, coverUrl, extra) => {
        panelStateEl.textContent = state;
        panelStateEl.className = 'preview-state'
            + (state === 'Loading...' ? ' loading' : '')
            + (state === 'Error' ? ' error' : '');
        panelStationEl.textContent = station || '—';
        panelStationEl.title = station || '';
        panelCodecEl.textContent = codec || '—';
        panelTrackEl.textContent = track || '—';
        panelTrackEl.title = track || '';
        if (extra !== undefined) {
            if (extra) panelExtraEl.innerHTML = extra;
            else panelExtraEl.textContent = '—';
        }
        if (coverUrl !== undefined) {
            panelCoverEl.src = coverUrl || 'radio.svg';
        }
        panelStopBtn.disabled = (playingIndex === -1);
    };

    const fetchCover = async (streamTitle) => {
        if (!streamTitle || !streamTitle.includes('-')) return null;
        const dash = streamTitle.indexOf(' - ');
        const q = dash > 0 ? `${streamTitle.slice(0, dash)} ${streamTitle.slice(dash + 3)}` : streamTitle;
        try {
            const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=1`);
            if (!res.ok) return null;
            const json = await res.json();
            const art = json.results && json.results[0] && json.results[0].artworkUrl100;
            return art ? art.replace('100x100', '300x300') : null;
        } catch (e) {
            return null;
        }
    };

    const probeStation = async (url, listName) => {
        const token = getToken();
        if (!token || playingIndex === -1) return;
        const myIndex = playingIndex;
        try {
            const res = await fetch(`${API_BASE_PATH}/probe?url=${encodeURIComponent(url)}`, {
                headers: { 'X-Auth-Token': token }
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json.success) throw new Error((json && json.message) || `HTTP ${res.status}`);
            const d = json.data;
            if (myIndex !== playingIndex) return;
            const stationLabel = d.icyName || listName || d.url;
            const bitrate = d.icyBr ? `${d.icyBr} kbps` : (d.measuredKbps ? `~${Math.round(d.measuredKbps)} kbps` : null);
            const ch = d.channels === 1 ? 'Mono' : (d.channels === 2 ? 'Stereo' : (d.channels ? `${d.channels} ch` : null));
            lastStream = { codec: d.codec || 'audio', bitrate, srHz: d.sampleRate || 0, ch };
            const extraParts = [d.icyGenre, d.icyDescription].filter(Boolean).map(escHtml);
            if (d.icyUrl && /^https?:\/\//i.test(d.icyUrl)) {
                extraParts.push(`<a href="${escHtml(d.icyUrl)}" target="_blank" rel="noopener">site</a>`);
            }
            const extraHtml = extraParts.join(' · ');
            setPanel('Playing', stationLabel, '', d.streamTitle || '(no track info)', undefined, extraHtml);
            refreshCodecLine();
            if (d.streamTitle) {
                const genre = (stations[myIndex] && stations[myIndex].genre) || '';
                fetchCover(d.streamTitle).then((cover) => {
                    if (myIndex !== playingIndex) return;
                    setPanel('Playing', stationLabel, '', d.streamTitle, undefined, extraHtml);
                    refreshCodecLine();
                    if (!cover) { noteNoCover(); return; }
                    if (coverView === 'map' && coverHoldForMap && !mapPinned) {
                        // map is open after a switch: hold the cover until the
                        // fly-to finishes, then transition with the intro FX.
                        pendingCover = { url: cover, genre, seq: coverHoldSeq, index: myIndex };
                        const mapArrivedGo = () => {
                            setTimeout(() => {
                                if (!pendingCover || pendingCover.seq !== coverHoldSeq || pendingCover.index !== playingIndex) return;
                                const pc = pendingCover;
                                pendingCover = null;
                                coverHoldForMap = false;
                                setCoverView('cover');
                                applyCover(pc.url, pc.genre);
                            }, 2000);
                        };
                        if (mapStyle === 'leaflet') {
                            lfOnArrived(mapArrivedGo);
                            setTimeout(mapArrivedGo, 9000); // safety: never hold the cover hostage on a missed moveend
                        } else {
                            CoverMap.whenArrived(mapArrivedGo);
                        }
                        return;
                    }
                    hasCoverArt = true;
                    if (!mapPinned) setCoverView('cover');
                    applyCover(cover, genre);
                });
            } else {
                noteNoCover();
            }
        } catch (err) {
            console.warn('Probe failed:', err.message);
        }
    };

    const stopProbeLoop = () => {
        if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
    };

    const stopPlayback = () => {
        stopProbeLoop();
        try { audioEl.pause(); } catch (e) { /* noop */ }
        audioEl.removeAttribute('src');
        try { audioEl.load(); } catch (e) { /* noop */ }
        playingIndex = -1;
        lastProbeUrl = '';
        lastStream = null;
        setPanel('Stopped', '—', '—', '—', null, '');
        clearCoverFx();
        pendingCover = null;
        coverHoldForMap = false;
        stopCoverWait();
        coverNoiseEl.classList.remove('dark');
        coverCardEl.classList.remove('nosignal');
        CoverMap.setPlaying(false);
        updateMapNoise();
        drawSpectrumIdle();
        render();
    };

    // --- SPECTRUM ANALYZER (Web Audio API on the same <audio> element) ---
    let audioCtx = null;
    let analyserNode = null;
    let analyserData = null;
    let spectrumRaf = 0;
    let peakVals = null;
    let peakVel = null;
    let peakLastT = 0;
    let barVals = null;
    let bandMax = 0;
    let lastStream = null;
    let logMap = null;

    // Logarithmic bar layout: bar i covers [fMin, Nyquist] in equal log steps.
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

    const ensureAudioGraph = () => {
        if (!audioCtx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return false;
            audioCtx = new AC();
            analyserNode = audioCtx.createAnalyser();
            analyserNode.fftSize = tune.fft;
            analyserNode.minDecibels = tune.dbMin;
            analyserNode.maxDecibels = tune.dbMax;
            analyserNode.smoothingTimeConstant = 0.8;
            const srcNode = audioCtx.createMediaElementSource(audioEl);
            srcNode.connect(analyserNode);
            analyserNode.connect(audioCtx.destination);
            analyserData = new Uint8Array(analyserNode.frequencyBinCount);
        }
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        return true;
    };

    const fitCanvas = () => {
        const r = panelCanvasEl.getBoundingClientRect();
        const w = Math.max(80, Math.round(r.width));
        const h = Math.max(28, Math.round(r.height));
        if (panelCanvasEl.width !== w * 2) { panelCanvasEl.width = w * 2; panelCanvasEl.height = h * 2; }
    };

    const drawSpectrumIdle = () => {
        const ctx2d = panelCanvasEl.getContext('2d');
        ctx2d.clearRect(0, 0, panelCanvasEl.width, panelCanvasEl.height);
    };

    const fmtKHz = (hz) => {
        if (!hz || hz <= 0) return '—';
        return hz >= 1000 ? `${String(parseFloat((hz / 1000).toFixed(1))).replace('.', ',')} кГц` : `${Math.round(hz)} Гц`;
    };

    const refreshCodecLine = () => {
        if (!lastStream) return;
        let srPart = lastStream.srHz ? fmtKHz(lastStream.srHz) : null;
        if (lastStream.srHz && bandMax > 0) srPart += ` (${fmtKHz(bandMax)} макс)`;
        panelCodecEl.textContent = [lastStream.codec, lastStream.bitrate, srPart, lastStream.ch].filter(Boolean).join(' · ');
    };

    const drawSpectrum = () => {
        if (!analyserNode || playingIndex === -1) {
            spectrumRaf = 0; // idle: stop the loop instead of spinning rAF for nothing
            drawSpectrumIdle();
            return;
        }
        spectrumRaf = requestAnimationFrame(drawSpectrum); // full rate: bars stay lively, FFT is cheap
        analyserNode.getByteFrequencyData(analyserData);
        const ctx2d = panelCanvasEl.getContext('2d');
        const W = panelCanvasEl.width;
        const H = panelCanvasEl.height;
        const n = tune.bars;
        if (!peakVals || peakVals.length !== n) {
            peakVals = new Float32Array(n);
            peakVel = new Float32Array(n);
            barVals = new Float32Array(n);
            peakLastT = performance.now();
            bandMax = 0;
            logMap = buildLogMap(n);
        }
        const nowT = performance.now();
        const dt = Math.min(0.1, Math.max(0.001, (nowT - peakLastT) / 1000));
        peakLastT = nowT;
        // Gravity for the peak caps, from the slider: full-scale fall in tune.grav seconds.
        const GRAV = (2 * H) / (tune.grav * tune.grav);
        const bw = W / n;
        const capH = Math.max(2, H * 0.03);
        let topBin = -1;
        ctx2d.clearRect(0, 0, W, H);
        for (let i = 0; i < n; i++) {
            const lb0 = logMap[i][0];
            const lb1 = logMap[i][1];
            let v = 0;
            for (let j = lb0; j <= lb1; j++) v = Math.max(v, analyserData[j] || 0);
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
            const g = ctx2d.createLinearGradient(0, H - h, 0, H);
            g.addColorStop(0, '#7ddb9b');
            g.addColorStop(1, '#1d5c33');
            ctx2d.fillStyle = g;
            ctx2d.fillRect(i * bw + 1, H - h, Math.max(1, bw - 2), h);
            ctx2d.fillStyle = '#f2c94d';
            ctx2d.fillRect(i * bw + 1, Math.min(H - capH, H - peakVals[i]), Math.max(1, bw - 2), capH);
        }
        const occHz = topBin >= 0 ? logMap[topBin][2] : 0;
        if (occHz > bandMax) {
            bandMax = occHz;
            refreshCodecLine();
        }
    };

    const rememberLastPlayed = () => {
        try {
            const st = stations[playingIndex];
            if (st && st.id !== undefined) localStorage.setItem('webradio_admin_last', String(st.id));
        } catch (e) { /* noop */ }
    };
    const resolveStartIndex = () => {
        if (!stations.length) return -1;
        if (playingIndex >= 0 && playingIndex < stations.length) return playingIndex;
        try {
            const id = localStorage.getItem('webradio_admin_last');
            const i = stations.findIndex((s) => String(s.id) === String(id));
            if (i >= 0) return i;
        } catch (e) { /* noop */ }
        return 0;
    };
    const stepStation = (dir) => {
        if (!stations.length) return;
        const base = resolveStartIndex();
        if (base === -1) return;
        playStation((base + dir + stations.length) % stations.length);
    };
    const playStation = (index) => {
        const station = stations[index];
        const token = getToken();
        if (!station || !station.url || !token) return;
        stopProbeLoop();
        playingIndex = index;
        rememberLastPlayed();
        clearCoverFx();
        startCoverWait();
        coverHoldSeq++;
        pendingCover = null;
        hasCoverArt = false;
        mapPinned = false;
        coverHoldForMap = (coverView === 'map');
        peakVals = null;
        peakVel = null;
        bandMax = 0;
        lastStream = null;
        const url = station.url.trim();
        lastProbeUrl = url;
        setPanel('Loading...', station.name || url, 'connecting…', '—', undefined, '');
        panelStopBtn.disabled = false;
        fitCanvas();
        ensureAudioGraph();
        if (!spectrumRaf) drawSpectrum();
        audioEl.src = `${API_BASE_PATH}/preview?url=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}`;
        audioEl.play().catch((err) => {
            stopProbeLoop();
            setPanel('Error', station.name || url, '—', String(err.message || err));
            playingIndex = -1;
            render();
        });
        probeStation(url, station.name);
        fetchStationGeo(url, index);
        probeTimer = setInterval(() => {
            if (playingIndex === index) probeStation(url, station.name);
        }, 25000);
        render();
    };

    audioEl.addEventListener('error', () => {
        if (playingIndex === -1) return;
        const station = stations[playingIndex];
        setPanel('Error', (station && station.name) || '—', '—', 'stream failed to play (see console)');
        playingIndex = -1;
        stopProbeLoop();
        showDropoutFx(true);
        render();
    });
    audioEl.addEventListener('waiting', () => { if (playingIndex !== -1) showDropoutFx(true); });
    audioEl.addEventListener('stalled', () => { if (playingIndex !== -1) showDropoutFx(true); });
    audioEl.addEventListener('playing', () => {
        showDropoutFx(false);
        CoverMap.setPlaying(true);
        updateMapNoise();
    });

    // --- IMPORT / EXPORT ---
    const exportJson = () => {
        const blob = new Blob([JSON.stringify({ stations }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'stations.json';
        a.click();
        URL.revokeObjectURL(a.href);
    };

    importFile.addEventListener('change', () => {
        const file = importFile.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const parsed = JSON.parse(reader.result);
                const list = Array.isArray(parsed) ? parsed : parsed.stations;
                if (!Array.isArray(list)) throw new Error('expected an array or {stations: [...]}');
                stations = list.map(s => ({
                    name: String(s.name || '').trim(),
                    url: String(s.url || '').trim(),
                    genre: String(s.genre || 'radio').trim()
                }));
                render();
                showStatus(true, `Imported ${stations.length} stations. Press Save to publish.`);
            } catch (err) {
                showStatus(false, `Import failed: ${err.message}`);
            }
        };
        reader.readAsText(file);
        importFile.value = '';
    });

    // --- EVENT WIRING ---
    addBtn.addEventListener('click', addRow);
    saveBtn.addEventListener('click', saveStations);
    exportBtn.addEventListener('click', exportJson);
    reloadBtn.addEventListener('click', loadStations);
    panelStopBtn.addEventListener('click', () => {
        if (playingIndex !== -1) stopPlayback();
        else { const i = resolveStartIndex(); if (i !== -1) playStation(i); }
    });
    panelPrevBtn.addEventListener('click', () => stepStation(-1));
    panelNextBtn.addEventListener('click', () => stepStation(1));
    panelVolEl.addEventListener('input', () => {
        audioEl.volume = Math.min(1, Math.max(0, (parseInt(panelVolEl.value, 10) || 0) / 100));
    });
    audioEl.volume = (parseInt(panelVolEl.value, 10) || 100) / 100;
    // --- Spectrum settings popup (persisted in localStorage) ---
    const FFT_SIZES = [256, 512, 1024, 2048, 4096, 8192];
    const tune = { grav: 0.6, atk: 0, rel: 0, dbMax: -6, dbMin: -80, fft: 4096, bars: 48 };
    try {
        const saved = JSON.parse(localStorage.getItem('webradio_admin_tune') || '{}');
        if (saved.grav >= 0.2 && saved.grav <= 2) tune.grav = saved.grav;
        if (saved.atk >= 0 && saved.atk <= 900) tune.atk = saved.atk;
        if (saved.rel >= 0 && saved.rel <= 900) tune.rel = saved.rel;
        if (saved.dbMax >= -30 && saved.dbMax <= 0) tune.dbMax = saved.dbMax;
        if (saved.dbMin >= -120 && saved.dbMin <= -40) tune.dbMin = saved.dbMin;
        if (FFT_SIZES.includes(saved.fft)) tune.fft = saved.fft;
        if (saved.bars >= 16 && saved.bars <= 96) tune.bars = saved.bars;
    } catch (e) { /* noop */ }
    if (tune.dbMin >= tune.dbMax) tune.dbMin = tune.dbMax - 10;
    const $ = (id) => document.getElementById(id);
    const tuneGravEl = $('tune-grav');
    const tuneAtkEl = $('tune-atk');
    const tuneRelEl = $('tune-rel');
    const tuneDbMaxEl = $('tune-dbmax');
    const tuneDbMinEl = $('tune-dbmin');
    const tuneFftEl = $('tune-fft');
    const tuneBarsEl = $('tune-bars');
    const tuneGravV = $('tune-grav-v');
    const tuneAtkV = $('tune-atk-v');
    const tuneRelV = $('tune-rel-v');
    const tuneDbMaxV = $('tune-dbmax-v');
    const tuneDbMinV = $('tune-dbmin-v');
    const tuneFftV = $('tune-fft-v');
    const tuneBarsV = $('tune-bars-v');
    const specMenuEl = $('spec-menu');
    const specMenuBtn = $('spec-menu-btn');
    const saveTune = () => {
        try { localStorage.setItem('webradio_admin_tune', JSON.stringify(tune)); } catch (e) { /* noop */ }
    };
    const fmtDb = (v) => String(v).replace('-', '−');
    const applyTuneToInputs = () => {
        tuneGravEl.value = tune.grav;
        tuneAtkEl.value = tune.atk;
        tuneRelEl.value = tune.rel;
        tuneDbMaxEl.value = tune.dbMax;
        tuneDbMinEl.value = tune.dbMin;
        tuneFftEl.value = Math.max(0, FFT_SIZES.indexOf(tune.fft));
        tuneBarsEl.value = tune.bars;
        tuneGravV.textContent = `${parseFloat(tune.grav.toFixed(1))} с`;
        tuneAtkV.textContent = `${tune.atk} мс`;
        tuneRelV.textContent = `${tune.rel} мс`;
        tuneDbMaxV.textContent = fmtDb(tune.dbMax);
        tuneDbMinV.textContent = fmtDb(tune.dbMin);
        tuneFftV.textContent = `${tune.fft}`;
        tuneBarsV.textContent = `${tune.bars}`;
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
    tuneGravEl.addEventListener('input', () => {
        tune.grav = parseFloat(tuneGravEl.value) || 0.6;
        tuneGravV.textContent = `${parseFloat(tune.grav.toFixed(1))} с`;
        saveTune();
    });
    tuneAtkEl.addEventListener('input', () => {
        tune.atk = parseInt(tuneAtkEl.value, 10) || 0;
        tuneAtkV.textContent = `${tune.atk} мс`;
        saveTune();
    });
    tuneRelEl.addEventListener('input', () => {
        tune.rel = parseInt(tuneRelEl.value, 10) || 0;
        tuneRelV.textContent = `${tune.rel} мс`;
        saveTune();
    });
    tuneDbMaxEl.addEventListener('input', () => {
        tune.dbMax = parseInt(tuneDbMaxEl.value, 10);
        if (Number.isNaN(tune.dbMax)) tune.dbMax = -6;
        if (tune.dbMin >= tune.dbMax) {
            tune.dbMin = tune.dbMax - 10;
            tuneDbMinEl.value = tune.dbMin;
            tuneDbMinV.textContent = fmtDb(tune.dbMin);
        }
        tuneDbMaxV.textContent = fmtDb(tune.dbMax);
        applyDb();
        saveTune();
    });
    tuneDbMinEl.addEventListener('input', () => {
        tune.dbMin = parseInt(tuneDbMinEl.value, 10);
        if (Number.isNaN(tune.dbMin)) tune.dbMin = -80;
        if (tune.dbMin >= tune.dbMax) {
            tune.dbMax = tune.dbMin + 10;
            if (tune.dbMax > 0) { tune.dbMax = 0; tune.dbMin = -10; }
            tuneDbMaxEl.value = tune.dbMax;
            tuneDbMinEl.value = tune.dbMin;
            tuneDbMaxV.textContent = fmtDb(tune.dbMax);
            tuneDbMinV.textContent = fmtDb(tune.dbMin);
        } else {
            tuneDbMinV.textContent = fmtDb(tune.dbMin);
        }
        applyDb();
        saveTune();
    });
    tuneFftEl.addEventListener('input', () => {
        const idx = Math.min(FFT_SIZES.length - 1, Math.max(0, parseInt(tuneFftEl.value, 10) || 0));
        tune.fft = FFT_SIZES[idx];
        tuneFftV.textContent = `${tune.fft}`;
        if (analyserNode && analyserNode.fftSize !== tune.fft) {
            analyserNode.fftSize = tune.fft;
            reallocSpectrum();
        }
        saveTune();
    });
    tuneBarsEl.addEventListener('input', () => {
        tune.bars = parseInt(tuneBarsEl.value, 10) || 48;
        tuneBarsV.textContent = `${tune.bars}`;
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

    loadStations();
});
