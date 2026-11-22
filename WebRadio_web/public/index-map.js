/* Index page server map (Leaflet): follows the playing station via /geo.
 * Watches #station text ("N - name"), resolves the stream URL from the
 * station list, flies the map there. Token: same secret_token as app.js. */
(function () {
    'use strict';
    var BASE = window.location.pathname.replace(/\/[^/]*$/, '').replace(/\/$/, '');
    var API = BASE + '/api/radio';
    var map = null, marker = null, tileLayer = null, tileIsLight = null, lastNum = -1, stationsCache = null, stationsAt = 0;
    var coverSeq = 0, lastCoverTitle = '';

    function fetchCover(title) {
        if (title === lastCoverTitle) return;
        lastCoverTitle = title;
        var img = document.getElementById('idx-cover');
        if (!title || title === 'N/A' || title === '…' || !img) { if (img) img.src = 'radio.svg'; return; }
        var seq = ++coverSeq;
        var q = title.indexOf(' - ') > 0 ? title.replace(' - ', ' ') : title;
        fetch('https://itunes.apple.com/search?term=' + encodeURIComponent(q) + '&media=music&entity=song&limit=1')
            .then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (j) {
                if (seq !== coverSeq) return;
                var art = j && j.results && j.results[0] && j.results[0].artworkUrl100;
                img.src = art ? art.replace('100x100', '300x300') : 'radio.svg';
            })
            .catch(function () { if (seq === coverSeq && img) img.src = 'radio.svg'; });
    }

    function tileUrl(light) {
        var base = light ? 'World_Light_Gray_Base' : 'World_Dark_Gray_Base';
        return 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/' + base + '/MapServer/tile/{z}/{y}/{x}';
    }

    function isLightTheme() {
        try { return document.documentElement.getAttribute('data-theme') === 'light'; }
        catch (e) { return false; }
    }

    function applyTiles() {
        if (!map || typeof L === 'undefined') return;
        var light = isLightTheme();
        if (tileLayer && light === tileIsLight) return;
        if (tileLayer) map.removeLayer(tileLayer);
        tileIsLight = light;
        tileLayer = L.tileLayer(tileUrl(light), { attribution: 'Esri', maxZoom: 12 }).addTo(map);
    }

    var mapEl = function () { return document.getElementById('idx-map'); };
    var locEl = function () { return document.getElementById('idx-loc'); };

    function token() {
        try { return localStorage.getItem('secret_token') || ''; } catch (e) { return ''; }
    }

    function initMap() {
        if (map || typeof L === 'undefined' || !mapEl()) return;
        map = L.map('idx-map', { zoomControl: false, minZoom: 1, maxZoom: 12, worldCopyJump: true, zoomSnap: 0.25, attributionControl: true });
        map.attributionControl.setPrefix(false);
        applyTiles();
        map.setView([25, 0], 1);
        if (typeof MutationObserver !== 'undefined') {
            new MutationObserver(function () { applyTiles(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        }
    }

    function markIcon() {
        return L.divIcon({
            className: '', html: '<div style="width:10px;height:10px;background:var(--map-mark);border-radius:50%;box-shadow:0 0 8px var(--map-mark);"></div>',
            iconSize: [10, 10], iconAnchor: [5, 5]
        });
    }

    function showPlace(lat, lon, info) {
        if (!map) return;
        if (!marker) marker = L.marker([lat, lon], { icon: markIcon(), interactive: false }).addTo(map);
        else marker.setLatLng([lat, lon]);
        map.flyTo([lat, lon], 7, { duration: 2.8 });
        if (locEl()) locEl().textContent = [info.city, info.country].filter(Boolean).join(', ') || info.ip || '';
    }

    function showUnknown() {
        if (!map) return;
        if (marker) { map.removeLayer(marker); marker = null; }
        map.setView([25, 0], 1);
        if (locEl()) locEl().textContent = '';
    }

    function loadStations(cb) {
        if (stationsCache && Date.now() - stationsAt < 60000) return cb(stationsCache);
        fetch(API + '/stations', { headers: token() ? { 'X-Auth-Token': token() } : {} })
            .then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (j) {
                if (j && j.success && j.data && Array.isArray(j.data.stations)) {
                    stationsCache = j.data.stations; stationsAt = Date.now(); cb(stationsCache);
                }
            })
            .catch(function () { /* offline: keep old cache */ });
    }

    function fmtKHz(hz) {
        if (!hz || hz <= 0) return null;
        return hz >= 1000 ? String(parseFloat((hz / 1000).toFixed(1))).replace('.', ',') + ' кГц' : Math.round(hz) + ' Гц';
    }

    function fetchProbe(url, num) {
        var pel = document.getElementById('now-params');
        fetch(API + '/probe?url=' + encodeURIComponent(url), {
            headers: token() ? { 'X-Auth-Token': token() } : {}
        })
            .then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (j) {
                if (num !== lastNum) return;
                var d = j && j.data;
                if (!(j && j.success && d)) { if (pel) pel.textContent = '—'; return; }
                var br = d.bitrate ? d.bitrate + ' kbps' : (d.icyBr ? d.icyBr + ' kbps' : (d.measuredKbps ? '~' + d.measuredKbps + ' kbps' : null));
                var ch = d.channels === 2 ? 'Stereo' : (d.channels === 1 ? 'Mono' : (d.channels ? d.channels + 'ch' : null));
                var sr = fmtKHz(d.sampleRate);
                var parts = [d.codec, br, sr, ch].filter(Boolean);
                if (pel) pel.textContent = parts.length ? parts.join(' · ') : '—';
            })
            .catch(function () {
                if (num !== lastNum) return;
                var pel2 = document.getElementById('now-params');
                if (pel2) pel2.textContent = '—';
            });
    }

    function onStationNum(num) {
        if (num === lastNum) return;
        lastNum = num;
        loadStations(function (list) {
            var st = list[num - 1];
            if (!st || !st.url) return;
            fetch(API + '/geo?url=' + encodeURIComponent(st.url), {
                headers: token() ? { 'X-Auth-Token': token() } : {}
            })
                .then(function (r) { return r.json().catch(function () { return {}; }); })
                .then(function (j) {
                    var d = j && j.data;
                    if (j && j.success && d && !d.unknown && typeof d.lat === 'number' && typeof d.lon === 'number') {
                        showPlace(d.lat, d.lon, { city: d.city, country: d.country, ip: d.ip });
                    } else { showUnknown(); }
                })
                .catch(function () { showUnknown(); });
            fetchProbe(st.url, num);
        });
    }

    function readNum() {
        var el = document.getElementById('station');
        if (!el) return 0;
        var mt = (el.textContent || '').match(/^(\d+)/);
        return mt ? parseInt(mt[1], 10) : 0;
    }

    function boot() {
        initMap();
        if (typeof MutationObserver !== 'undefined') {
            var titleEl = document.getElementById('title');
            if (titleEl) new MutationObserver(function () { fetchCover((titleEl.textContent || '').trim()); }).observe(titleEl, { childList: true, characterData: true, subtree: true });
            fetchCover(((titleEl && titleEl.textContent) || '').trim());
        }
        if (!map) return;
        var el = document.getElementById('station');
        if (el && typeof MutationObserver !== 'undefined') {
            new MutationObserver(function () { onStationNum(readNum()); }).observe(el, { childList: true, characterData: true, subtree: true });
        }
        onStationNum(readNum());
        setInterval(function () { onStationNum(readNum()); }, 15000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
