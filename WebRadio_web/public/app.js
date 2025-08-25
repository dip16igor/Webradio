document.addEventListener('DOMContentLoaded', () => {

    // --- CONFIGURATION ---
    const API_BASE_PATH = 'api/radio';
    const POLLING_INTERVAL_MS = 2000;
    const TOTAL_STATIONS = 78;
    const STATION_ITEM_HEIGHT = 50; // Corresponds to station-item height in CSS

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
        { name: "WebRadio0007", genre: "relax" }
    ];

    // --- DOM ELEMENTS ---
    const stateEl = document.getElementById('state');
    const stationEl = document.getElementById('station');
    const volumeEl = document.getElementById('volume');
    const volumeIconEl = document.getElementById('volume-icon');
    const titleEl = document.getElementById('title');
    const alarmEl = document.getElementById('alarm');
    const logEl = document.getElementById('log');
    const statusContainer = document.getElementById('status-container');
    
    // New Station Selector Elements
    const stationSelector = document.getElementById('station-selector');
    const stationWheel = document.getElementById('station-wheel');
    const playSelectedBtn = document.getElementById('btn-play-selected');

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
    let selectedStationId = 1;
    let scrollTimeout;
    let isWheeling = false;

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
    const updateVolumeIcon = (volume) => {
        const numBars = 7;
        const volumeLevel = parseInt(volume, 10);
        if (isNaN(volumeLevel)) {
            volumeIconEl.innerHTML = '';
            return;
        }

        const activeBars = Math.ceil((volumeLevel / 21) * numBars);
        let iconHTML = '';
        for (let i = 0; i < numBars; i++) {
            const barHeight = 4 + (i * 2);
            const activeClass = i < activeBars ? 'active' : '';
            iconHTML += `<span class="volume-bar ${activeClass}" style="height: ${barHeight}px;"></span>`;
        }
        volumeIconEl.innerHTML = iconHTML;
    };

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
        updateVolumeIcon(data.Volume);

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
        
        // Sync wheel with current station from device
        if (stationSelector.dataset.lastSyncedStation !== String(currentStationNum)) {
            const targetScrollTop = (currentStationNum - 1) * STATION_ITEM_HEIGHT;
            stationSelector.scrollTop = targetScrollTop;
            stationSelector.dataset.lastSyncedStation = String(currentStationNum);
            updateSelectedStation(false); // Update visuals without snapping
        }
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
            setTimeout(() => postCommand('/command', { command: '?' }), 200);
        } else {
            alert('Please select a time for the alarm.');
        }
    });

    cancelAlarmBtn.addEventListener('click', async () => {
        await postCommand('/command', { command: 's0' });
        alert('Alarm cancelled.');
        setTimeout(() => postCommand('/command', { command: '?' }), 200);
    });

    // --- STATION WHEEL LOGIC ---
    const updateSelectedStation = (snap = true) => {
        const scrollTop = stationSelector.scrollTop;
        const selectedIndex = Math.round(scrollTop / STATION_ITEM_HEIGHT);
        
        selectedStationId = selectedIndex + 1;

        // Update visual styles
        const items = stationWheel.children;
        for (let i = 0; i < items.length; i++) {
            if (i === selectedIndex) {
                items[i].classList.add('selected');
            } else {
                items[i].classList.remove('selected');
            }
        }

        if (snap) {
            // Debounce the snap scrolling
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                stationSelector.scrollTo({
                    top: selectedIndex * STATION_ITEM_HEIGHT,
                    behavior: 'smooth'
                });
            }, 150); // Adjust delay as needed
        }
    };

    // This listener handles touch scrolling and the final snap after any scroll.
    stationSelector.addEventListener('scroll', () => {
        if (!isWheeling) { // Don't run this logic during a mouse wheel scroll
            updateSelectedStation();
        }
    });

    // This listener specifically handles mouse wheel scrolling to be less sensitive.
    stationSelector.addEventListener('wheel', (e) => {
        e.preventDefault(); // Stop the default scroll

        if (isWheeling) return; // Throttle wheel events

        const scrollDirection = Math.sign(e.deltaY);
        const currentScrollTop = stationSelector.scrollTop;
        const targetScrollTop = currentScrollTop + (scrollDirection * STATION_ITEM_HEIGHT);

        stationSelector.scrollTo({
            top: targetScrollTop,
            behavior: 'smooth'
        });

        isWheeling = true;
        
        // Update selection after the smooth scroll is likely finished
        setTimeout(() => {
            updateSelectedStation(false); // Update visuals
            isWheeling = false;
        }, 200); // This timeout should be close to the smooth scroll duration
    });

    playSelectedBtn.addEventListener('click', () => {
        if (selectedStationId > 0 && selectedStationId <= TOTAL_STATIONS) {
            postCommand('/command', { command: `c${selectedStationId}` });
        }
    });

    // --- INITIALIZATION ---
    const createStationWheel = () => {
        stationWheel.innerHTML = ''; // Clear existing
        for (let i = 0; i < TOTAL_STATIONS; i++) {
            const station = stationData[i] || { name: 'Unknown', genre: 'N/A' };
            const item = document.createElement('div');
            item.className = 'station-item';
            item.dataset.stationId = i + 1;
            item.textContent = `${i + 1} - ${station.name} - ${station.genre}`;
            stationWheel.appendChild(item);
        }
        // Set initial selection
        updateSelectedStation(false);
    };

    const init = () => {
        postCommand('/command', { command: '?' });
        createStationWheel();
        pollStatus(); // Initial fetch
        setInterval(pollStatus, POLLING_INTERVAL_MS); // Start polling
    };

    init();
});