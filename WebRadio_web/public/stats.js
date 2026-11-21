document.addEventListener('DOMContentLoaded', () => {

    // Same base-path logic as app.js: works at /webradio/, /webradio/stats.html, and /
    const BASE_PATH = window.location.pathname.replace(/\/[^/]*$/, '').replace(/\/$/, '');
    const API_BASE_PATH = `${BASE_PATH}/api/radio`;
    const REFRESH_MS = 30000;

    const summaryEl = document.getElementById('stats-summary');
    const tbody = document.getElementById('stats-body');

    let rows = [];
    let sortKey = 'listenSec';
    let sortDir = -1;

    const getToken = () => {
        let token = localStorage.getItem('secret_token');
        if (!token) {
            token = prompt('Please enter the secret token');
            if (token) localStorage.setItem('secret_token', token);
        }
        return token;
    };

    const fmtDur = (sec) => {
        sec = Math.max(0, Math.round(sec || 0));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
        return `${m}m`;
    };

    const fmtTime = (iso) => {
        if (!iso) return '—';
        try {
            const d = new Date(iso);
            return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        } catch (e) {
            return '—';
        }
    };

    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const render = () => {
        const sorted = rows.slice().sort((a, b) => {
            const av = a[sortKey], bv = b[sortKey];
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            if (typeof av === 'string') return sortDir * av.localeCompare(bv);
            return sortDir * (av - bv);
        });
        tbody.innerHTML = '';
        for (const r of sorted) {
            const tr = document.createElement('tr');
            if (r.removed) tr.classList.add('stats-removed');
            tr.innerHTML =
                `<td>${esc(r.name)}${r.removed ? ' <span class="stats-gone" title="No longer in the station list">(removed)</span>' : ''}</td>` +
                `<td class="num">${fmtDur(r.listenSec)}</td>` +
                `<td class="num">${r.switches || 0}</td>` +
                `<td class="num${(r.dropMax || 0) > 0 ? ' dropouts-bad' : ''}">${r.dropMax || 0}</td>` +
                `<td class="num">${r.dropPerHour == null ? '—' : r.dropPerHour.toFixed(1)}</td>` +
                `<td class="num${(r.errCount || 0) > 0 ? ' dropouts-bad' : ''}">${r.errCount || 0}</td>` +
                `<td class="small">${esc(r.lastStream || '—')}</td>` +
                `<td class="small">${fmtTime(r.lastSeen)}</td>`;
            tr.title = r.lastError ? `Last error: ${r.lastError}` : (r.url || r.id);
            tbody.appendChild(tr);
        }
        const totalSec = rows.reduce((s, r) => s + (r.listenSec || 0), 0);
        const totalErr = rows.reduce((s, r) => s + (r.errCount || 0), 0);
        summaryEl.textContent =
            `${rows.length} stations tracked, ${fmtDur(totalSec)} total listening, ${totalErr} stream errors recorded.`;
        document.querySelectorAll('#stats-table th[data-sort]').forEach((th) => {
            const k = th.getAttribute('data-sort');
            th.textContent = th.textContent.replace(/ [▲▼]/, '');
            if (k === sortKey) th.textContent += sortDir < 0 ? ' ▼' : ' ▲';
        });
    };

    const load = async () => {
        const token = getToken();
        if (!token) {
            summaryEl.textContent = 'No secret token provided.';
            return;
        }
        try {
            const [statsRes, stationsRes] = await Promise.all([
                fetch(`${API_BASE_PATH}/stats`, { headers: { 'X-Auth-Token': token } }),
                fetch(`${API_BASE_PATH}/stations`, { headers: { 'X-Auth-Token': token } }),
            ]);
            if (!statsRes.ok) throw new Error(`stats HTTP ${statsRes.status}`);
            const statsJson = await statsRes.json();
            let liveIds = new Set();
            if (stationsRes.ok) {
                const stJson = await stationsRes.json();
                if (stJson.success && stJson.data && Array.isArray(stJson.data.stations)) {
                    liveIds = new Set(stJson.data.stations.map((s) => 's' + s.id));
                }
            }
            const entries = statsJson.success && statsJson.data && statsJson.data.stations
                ? statsJson.data.stations : {};
            rows = Object.values(entries).map((e) => ({
                id: e.id,
                name: e.name || String(e.id),
                url: e.url || '',
                listenSec: e.listenSec || 0,
                switches: e.switches || 0,
                dropSamples: e.dropSamples || 0,
                dropSum: e.dropSum || 0,
                dropMax: e.dropMax || 0,
                // Dropouts per hour of actual listening, computed here from the
                // server's own time accounting (ESP only reports raw 10 s windows).
                dropPerHour: (e.listenSec || 0) > 0 ? (e.dropSum || 0) / (e.listenSec / 3600) : null,
                errCount: e.errCount || 0,
                lastError: e.lastError || null,
                lastStream: e.lastStream || null,
                lastSeen: e.lastSeen || null,
                removed: !liveIds.has(String(e.id)),
            }));
            render();
        } catch (err) {
            console.error('Failed to load statistics:', err);
            summaryEl.textContent = `Failed to load statistics: ${err.message}`;
        }
    };

    document.querySelectorAll('#stats-table th[data-sort]').forEach((th) => {
        th.style.cursor = 'pointer';
        th.addEventListener('click', () => {
            const k = th.getAttribute('data-sort');
            if (k === sortKey) {
                sortDir = -sortDir;
            } else {
                sortKey = k;
                sortDir = (k === 'name') ? 1 : -1;
            }
            render();
        });
    });

    document.getElementById('btn-reset-stats').addEventListener('click', async () => {
        if (!confirm('Delete ALL accumulated listening statistics? This cannot be undone.')) return;
        const btn = document.getElementById('btn-reset-stats');
        btn.disabled = true;
        try {
            const token = getToken();
            if (!token) return;
            const res = await fetch(`${API_BASE_PATH}/stats`, {
                method: 'DELETE',
                headers: { 'X-Auth-Token': token }
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json.success) throw new Error((json && json.message) || `HTTP ${res.status}`);
            await load();
        } catch (err) {
            alert(`Reset failed: ${err.message}`);
        } finally {
            btn.disabled = false;
        }
    });

    load();
    setInterval(load, REFRESH_MS);
});
