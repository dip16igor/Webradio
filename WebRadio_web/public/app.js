document.addEventListener('DOMContentLoaded', () => {

    // --- CONFIGURATION ---
    const API_BASE_PATH = 'api/radio';
    const POLLING_INTERVAL_MS = 2000;
    const TOTAL_STATIONS = 22;

    // --- DOM ELEMENTS ---
    const stateEl = document.getElementById('state');
    const stationEl = document.getElementById('station');
    const volumeEl = document.getElementById('volume');
    const titleEl = document.getElementById('title');
    const alarmEl = document.getElementById('alarm');
    const logEl = document.getElementById('log');
    const statusContainer = document.getElementById('status-container');
    const stationGrid = document.getElementById('station-grid');

    // Control Buttons
    const powerBtn = document.getElementById('btn-power');
    const volDownBtn = document.getElementById('btn-vol-down');
    const volUpBtn = document.getElementById('btn-vol-up');
    const chDownBtn = document.getElementById('btn-ch-down');
    const chUpBtn = document.getElementById('btn-ch-up');
    const sleepBtn = document.getElementById('btn-sleep');

    // --- STATE ---
    let currentVolume = 0;
    let currentStationNum = 1;
    let isPowerOn = false;

    // --- API HELPERS ---
    const apiRequest = async (endpoint, options = {}) => {
        try {
            const response = await fetch(`${API_BASE_PATH}${endpoint}`, options);
            if (!response.ok) {
                const errorBody = await response.json().catch(() => ({ message: response.statusText }));
                throw new Error(`API Error: ${errorBody.message || 'Unknown error'}`);
            }
            return response.json();
        } catch (error) {
            console.error(error);
            updateStatusUI({ State: 'Offline', Log: error.message });
            return null;
        }
    };

    const postCommand = (endpoint, body) => {
        return apiRequest(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    };

    // --- UI UPDATE ---
    const updateStatusUI = (data) => {
        isPowerOn = data.State?.includes('Power ON');

        if (data.State === 'Offline') {
            statusContainer.className = 'status-offline';
        } else {
            statusContainer.className = 'status-online';
        }

        stateEl.textContent = data.State || 'N/A';
        stationEl.textContent = data.Station || 'N/A';
        volumeEl.textContent = data.Volume || 'N/A';
        titleEl.textContent = data.Title || 'N/A';
        alarmEl.textContent = data.Alarm || 'N/A';
        logEl.textContent = data.Log || 'N/A';

        // Store current state for controls
        currentVolume = parseInt(data.Volume, 10) || 0;
        const stationMatch = (data.Station || '').match(/^(\d+)/);
        currentStationNum = stationMatch ? parseInt(stationMatch[1], 10) : 1;
    };

    // --- POLLING ---
    const pollStatus = async () => {
        const response = await apiRequest('/status');
        if (response && response.success) {
            updateStatusUI(response.data);
        }
    };

    // --- EVENT HANDLERS ---
    powerBtn.addEventListener('click', () => {
        postCommand('/power', { state: isPowerOn ? 'off' : 'on' });
    });

    volDownBtn.addEventListener('click', () => {
        const newVolume = Math.max(0, currentVolume - 1);
        postCommand('/volume', { volume: newVolume });
    });

    volUpBtn.addEventListener('click', () => {
        const newVolume = Math.min(21, currentVolume + 1);
        postCommand('/volume', { volume: newVolume });
    });

    chDownBtn.addEventListener('click', () => {
        const newStation = currentStationNum <= 1 ? TOTAL_STATIONS : currentStationNum - 1;
        postCommand('/station', { station: newStation });
    });

    chUpBtn.addEventListener('click', () => {
        const newStation = currentStationNum >= TOTAL_STATIONS ? 1 : currentStationNum + 1;
        postCommand('/station', { station: newStation });
    });

    sleepBtn.addEventListener('click', () => {
        // Example: set a 15-minute sleep timer (900 seconds)
        const sleepSeconds = 900;
        const currentAlarm = alarmEl.textContent;
        // If alarm is already set, turn it off. Otherwise, set it.
        const command = (currentAlarm && currentAlarm !== 'Alarm OFF' && currentAlarm !== '0') ? 's0' : `s${sleepSeconds}`;
        postCommand('/command', { command });
        alert(command === 's0' ? 'Sleep timer cancelled.' : `Sleep timer set for 15 minutes.`);
    });

    // --- INITIALIZATION ---
    const createStationButtons = () => {
        for (let i = 1; i <= TOTAL_STATIONS; i++) {
            const btn = document.createElement('button');
            btn.className = 'btn';
            btn.textContent = i;
            btn.addEventListener('click', () => {
                postCommand('/station', { station: i });
            });
            stationGrid.appendChild(btn);
        }
    };

    const init = () => {
        createStationButtons();
        pollStatus(); // Initial fetch
        setInterval(pollStatus, POLLING_INTERVAL_MS); // Start polling
    };

    init();
});
