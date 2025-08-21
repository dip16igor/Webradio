document.addEventListener('DOMContentLoaded', () => {

    // --- CONFIGURATION ---
    const API_BASE_PATH = 'api/radio';
    const POLLING_INTERVAL_MS = 2000;
    const TOTAL_STATIONS = 82; // Updated station count

    const stationData = [
        { name: "Silver Rain", genre: "radio" },
        { name: "Relax", genre: "relax" },
        { name: "Relax FM", genre: "relax" },
        { name: "RFM Queen", genre: "rock" },
        { name: "ProBeat FM", genre: "electronic" },
        { name: "Cafe_off", genre: "radio" },
        { name: "chantefrance70s", genre: "radio" },
        { name: "Prodigy", genre: "electronic" },
        { name: "blackstation", genre: "electronic" },
        { name: "Ibiza Radio", genre: "electronic" },
        { name: "Kiss Kiss Rock", genre: "rock" },
        { name: "Relax web radio", genre: "relax" },
        { name: "prog", genre: "rock" },
        { name: "Smooth Jazz", genre: "jazz" },
        { name: "Spokoinoe Radio", genre: "relax" },
        { name: "Enigmatic robot", genre: "lounge" },
        { name: "COVER", genre: "rock" },
        { name: "PUNK", genre: "rock" },
        { name: "Nirvana", genre: "rock" },
        { name: "JAZZ", genre: "jazz" },
        { name: "NRJ LOUNGE", genre: "lounge" },
        { name: "90s", genre: "radio" },
        { name: "Adore jazz", genre: "jazz" },
        { name: "Ambient Psychill", genre: "ambient" },
        { name: "Bossa Nova", genre: "radio" },
        { name: "Brazilian Birds", genre: "nature" },
        { name: "Classic Country", genre: "radio" },
        { name: "Chillout Lounge", genre: "lounge" },
        { name: "Costa Delmar", genre: "lounge" },
        { name: "High Voltage", genre: "rock" },
        { name: "Italia On Air", genre: "radio" },
        { name: "America's Best Ballads", genre: "radio" },
        { name: "Radio Gaia", genre: "relax" },
        { name: "Rock Classics", genre: "rock" },
        { name: "Smooth Jazz", genre: "jazz" },
        { name: "Spa", genre: "relax" },
        { name: "186mph HQ", genre: "electronic" },
        { name: "Mini HQ", genre: "electronic" },
        { name: "Ambient", genre: "ambient" },
        { name: "Spacemusic", genre: "ambient" },
        { name: "Sector Space", genre: "ambient" },
        { name: "Cadillac", genre: "radio" },
        { name: "Chil", genre: "lounge" },
        { name: "Chillhouse", genre: "lounge" },
        { name: "Ibiza", genre: "electronic" },
        { name: "Summer Lounge", genre: "lounge" },
        { name: "Lounge", genre: "jazz" },
        { name: "Real FM Radio Relax", genre: "relax" },
        { name: "rouge-rockpop-high", genre: "rock" },
        { name: "Aplus.FM Relax", genre: "relax" },
        { name: "Kiss FM", genre: "rock" },
        { name: "1.FM - Kids FM", genre: "radio" },
        { name: "bigfm-sunsetlounge", genre: "lounge" },
        { name: "ZaycevFM Relax", genre: "relax" },
        { name: "Zvuki", genre: "nature" },
        { name: "Relax Morning Birds", genre: "nature" },
        { name: "90s Rock Hits", genre: "rock" },
        { name: "Bird Sounds", genre: "nature" },
        { name: "BL Rock", genre: "rock" },
        { name: "CDMR", genre: "lounge" },
        { name: "Complete Relaxation", genre: "relax" },
        { name: "LFCH", genre: "jazz" },
        { name: "Lounge", genre: "lounge" },
        { name: "Mellow Jazz", genre: "jazz" },
        { name: "Nature", genre: "nature" },
        { name: "NGMTCBR", genre: "relax" },
        { name: "NWAGEWV", genre: "lounge" },
        { name: "Smooth Jazz", genre: "jazz" },
        { name: "~~ Море ~~", genre: "nature" },
        { name: "Blues N Rock", genre: "rock" },
        { name: "LoFi Radio", genre: "lounge" },
        { name: "VoltageFM GOLD", genre: "radio" },
        { name: "Mixdance Relax", genre: "relax" },
        { name: "Relax Cafe", genre: "relax" },
        { name: "Sleep Kids", genre: "relax" },
        { name: "WebRadio0007", genre: "relax" },
        { name: "YOGA", genre: "relax" },
        { name: "dip16", genre: "rock" }
    ];

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
    const alarmTimeInput = document.getElementById('alarm-time');
    const setAlarmBtn = document.getElementById('btn-set-alarm');
    const cancelAlarmBtn = document.getElementById('btn-cancel-alarm');

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
        const alarmValue = data.Alarm;
        if (alarmValue && !isNaN(alarmValue) && parseInt(alarmValue, 10) > 0) {
            const totalSeconds = parseInt(alarmValue, 10);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const formattedHours = String(hours).padStart(2, '0');
            const formattedMinutes = String(minutes).padStart(2, '0');
            alarmEl.textContent = `${formattedHours}:${formattedMinutes}`;
        } else {
            alarmEl.textContent = alarmValue || 'N/A';
        }
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
        postCommand('/command', { command: 'b1' });
    });

    volDownBtn.addEventListener('click', () => {
        postCommand('/command', { command: 'vol-' });
    });

    volUpBtn.addEventListener('click', () => {
        postCommand('/command', { command: 'vol+' });
    });

    chDownBtn.addEventListener('click', () => {
        postCommand('/command', { command: 'b4' });
    });

    chUpBtn.addEventListener('click', () => {
        postCommand('/command', { command: 'b3' });
    });

    sleepBtn.addEventListener('click', () => {
        postCommand('/command', { command: 'b2' });
    });

    setAlarmBtn.addEventListener('click', async () => {
        const timeValue = alarmTimeInput.value;
        if (timeValue) {
            const [hours, minutes] = timeValue.split(':').map(Number);
            const totalSeconds = hours * 3600 + minutes * 60;
            await postCommand('/command', { command: `s${totalSeconds}` });
            alert(`Alarm set for ${timeValue}.`);
            // Request status update immediately
            setTimeout(() => postCommand('/command', { command: '?' }), 200);
        } else {
            alert('Please select a time for the alarm.');
        }
    });

    cancelAlarmBtn.addEventListener('click', async () => {
        await postCommand('/command', { command: 's0' });
        alert('Alarm cancelled.');
        // Request status update immediately
        setTimeout(() => postCommand('/command', { command: '?' }), 200);
    });

    // --- INITIALIZATION ---
    const createStationButtons = () => {
        for (let i = 1; i <= TOTAL_STATIONS; i++) {
            const btn = document.createElement('button');
            btn.className = 'btn';
            btn.textContent = i;

            const stationInfo = stationData[i - 1];
            if (stationInfo) {
                btn.title = `Name: ${stationInfo.name}\nGenre: ${stationInfo.genre}`;
            }

            btn.addEventListener('click', () => {
                postCommand('/command', { command: `c${i}` });
            });
            stationGrid.appendChild(btn);
        }
    };

    const init = () => {
        postCommand('/command', { command: '?' });
        createStationButtons();
        pollStatus(); // Initial fetch
        setInterval(pollStatus, POLLING_INTERVAL_MS); // Start polling
    };

    init();
});