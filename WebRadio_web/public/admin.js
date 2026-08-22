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

    // --- STATE ---
    let stations = []; // working copy: [{name, url, genre}]

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
            const genreInput = document.createElement('input');
            genreInput.type = 'text';
            genreInput.value = station.genre || 'radio';
            genreInput.setAttribute('list', 'genre-list');
            genreInput.addEventListener('input', () => { station.genre = genreInput.value.trim() || 'radio'; });
            genreTd.appendChild(genreInput);
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

            actionsTd.append(upBtn, downBtn, delBtn);
            tr.appendChild(actionsTd);

            tbody.appendChild(tr);
        });
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

    loadStations();
});
