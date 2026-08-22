const express = require('express');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');


const app = express();
app.set('trust proxy', 1); // Trust the first proxy

// Security headers
app.use(helmet());

// Middleware to parse JSON bodies
app.use(express.json());

// Rate limiting to prevent brute-force attacks
const apiLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 100, // Limit each IP to 100 requests per windowMs
	standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
	legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Apply the rate limiting middleware to API calls only
app.use('/api', apiLimiter);

const port = 3000;

// --- Configuration ---
const SECRET_TOKEN = process.env.SECRET_TOKEN || crypto.randomBytes(32).toString('hex');
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://127.0.0.1:1883';
const MQTT_USER = process.env.MQTT_USER;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const MQTT_PREFIX = 'Home/WebRadio2';
const MQTT_PREFIXES = ['Home/WebRadio1', 'Home/WebRadio2'];
const STATIONS_FILE = process.env.STATIONS_FILE || 'data/stations.json';
const MAX_STATIONS = 255;

// --- Station list (single source of truth) ---
let stationList = { version: 0, updatedAt: null, stations: [] };
let nextStationId = 1;

// Assign a stable id to any station missing one; keeps nextStationId above all ids
const ensureStationIds = (stations) => {
    for (const s of stations) {
        if (typeof s.id !== 'number' || !Number.isInteger(s.id) || s.id < 1) {
            s.id = nextStationId++;
        } else if (s.id >= nextStationId) {
            nextStationId = s.id + 1;
        }
    }
    return stations;
};

const persistStationsFile = () => {
    const dir = path.dirname(STATIONS_FILE);
    const tmp = `${STATIONS_FILE}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(stationList, null, 2), 'utf8');
    fs.renameSync(tmp, STATIONS_FILE);
};

const loadStations = () => {
    try {
        const data = JSON.parse(fs.readFileSync(STATIONS_FILE, 'utf8'));
        if (Array.isArray(data.stations)) {
            stationList = {
                version: typeof data.version === 'number' ? data.version : 0,
                updatedAt: data.updatedAt || null,
                stations: data.stations,
            };
            ensureStationIds(stationList.stations);
            try {
                persistStationsFile(); // persist the id migration so ids stay stable across restarts
            } catch (err) {
                console.warn(`Could not persist id migration for ${STATIONS_FILE}: ${err.message}`);
            }
            console.log(`Loaded ${stationList.stations.length} stations from ${STATIONS_FILE} (version ${stationList.version})`);
            return;
        }
    } catch (err) {
        console.warn(`Could not load ${STATIONS_FILE}: ${err.message}`);
    }
    console.warn(`Starting with an empty station list. Use the admin page (PUT /api/stations) to populate it.`);
    stationList = { version: 0, updatedAt: null, stations: [] };
};

// Validate a single station entry; returns an error string or null
const validateStationEntry = (s) => {
    if (!s || typeof s !== 'object') return 'station must be an object';
    if (s.id !== undefined && (!Number.isInteger(s.id) || s.id < 1)) return 'id must be a positive integer';
    if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 60) return 'name must be a non-empty string (max 60 chars)';
    if (typeof s.url !== 'string' || !/^https?:\/\/.+/.test(s.url) || s.url.length > 200) return 'url must start with http:// or https:// (max 200 chars)';
    if (typeof s.genre !== 'string' || !s.genre.trim() || s.genre.length > 30) return 'genre must be a non-empty string (max 30 chars)';
    return null;
};

// Merge an incoming list into canonical stations: keep a provided id if it exists,
// otherwise inherit by url match, otherwise assign a fresh id.
const mergeStationIds = (incoming) => {
    const byId = new Map(stationList.stations.map(s => [s.id, s]));
    const byUrl = new Map(stationList.stations.map(s => [s.url, s]));
    const usedIds = new Set();
    const out = [];
    for (const s of incoming) {
        let id;
        if (Number.isInteger(s.id) && s.id >= 1) {
            id = byId.has(s.id) ? s.id : nextStationId++;
        } else {
            id = byUrl.has(s.url) ? byUrl.get(s.url).id : nextStationId++;
        }
        if (usedIds.has(id)) id = nextStationId++;
        usedIds.add(id);
        out.push({ id, name: s.name.trim(), url: s.url, genre: (s.genre || 'radio').trim() });
    }
    for (const s of out) if (s.id >= nextStationId) nextStationId = s.id + 1;
    return out;
};

// Persist a new list, bump the version, push to devices, and reply
const saveStations = (nextStations, res) => {
    const nextVersion = stationList.version + 1;
    stationList = { version: nextVersion, updatedAt: new Date().toISOString(), stations: nextStations };
    try {
        persistStationsFile();
    } catch (err) {
        console.error(`Failed to persist ${STATIONS_FILE}:`, err);
        return res.status(500).json({ success: false, message: 'Failed to persist station list' });
    }
    console.log(`Station list saved: ${stationList.stations.length} stations (version ${nextVersion})`);
    MQTT_PREFIXES.forEach(publishStations);
    broadcastUpdate();
    res.json({ success: true, data: stationList });
};

if (!process.env.SECRET_TOKEN) {
    console.warn(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
    console.warn(`!!! WARNING: SECRET_TOKEN not set. Using a random token: ${SECRET_TOKEN} !!!`);
    console.warn(`!!! Set it via an .env file or environment variable for persistence. !!!`);
    console.warn(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
}

// --- MQTT Client ---
const mqttOptions = {
    clientId: `webradio_http_bridge_${Math.random().toString(16).slice(2, 10)}`,
    username: MQTT_USER,
    password: MQTT_PASSWORD,
};

const client = mqtt.connect(MQTT_BROKER_URL, mqttOptions);

// Publish the station list to a device prefix. Devices subscribe to {prefix}/Stations.
const publishStations = (prefix) => {
    if (client.connected && stationList.stations.length > 0) {
        const payload = JSON.stringify(stationList);
        client.publish(`${prefix}/Stations`, payload, { qos: 1 }, (err) => {
            if (err) {
                console.error(`Failed to publish station list to ${prefix}/Stations:`, err);
            } else {
                console.log(`Published ${stationList.stations.length} stations to ${prefix}/Stations (version ${stationList.version})`);
            }
        });
    }
};

client.on('connect', () => {
    console.log('Connected to MQTT broker');
    // Subscribe to all status topics (both radios; device-specific filtering in on('message'))
    client.subscribe('Home/#', (err) => {
        if (err) {
            console.error('Subscription error:', err);
        } else {
            console.log('Subscribed to topics under Home/');
        }
    });
    // Push the current list to both radios after a server (re)start
    MQTT_PREFIXES.forEach(publishStations);
});

client.on('error', (err) => {
    console.error('MQTT connection error:', err);
    radioState.State = "Offline";
    radioState.Log = `MQTT Error: ${err.message}`;
    broadcastUpdate();
});

client.on('close', () => {
    console.log('MQTT connection closed. Reconnecting...');
    radioState.State = "Offline";
    radioState.Log = "MQTT connection closed.";
    broadcastUpdate();
});

let radioState = {};

client.on('message', (topic, message) => {
    // Devices request the station list by publishing "list?" to their Action topic
    const prefixMatch = topic.match(/^(Home\/WebRadio[12])\/Action$/);
    if (prefixMatch) {
        if (message.toString() === 'list?') {
            publishStations(prefixMatch[1]);
        }
        return; // command topics are not part of the status view
    }

    if (!topic.startsWith(`${MQTT_PREFIX}/`)) {
        return;
    }
    const topicSuffix = topic.replace(`${MQTT_PREFIX}/`, '');
    const value = message.toString();

    let updated = false;
    if (radioState[topicSuffix] !== value) {
        radioState[topicSuffix] = value;
        updated = true;
    }

    if (updated) {
        broadcastUpdate();
    }
});

// --- API Routes ---
const apiRouter = express.Router();

// Middleware for API authentication
const apiAuth = (req, res, next) => {
    const token = req.headers['x-auth-token'];
    if (token && token === SECRET_TOKEN) {
        return next();
    } else {
        return res.status(401).json({ success: false, message: 'Unauthorized: Invalid or missing token' });
    }
};

// Protect all API routes
apiRouter.use(apiAuth);

apiRouter.get('/status', (req, res) => {
    res.json({
        success: true,
        timestamp: new Date().toISOString(),
        data: radioState
    });
});

const publishMqttCommand = (res, command, successData) => {
    const topic = `${MQTT_PREFIX}/Action`;
    client.publish(topic, command, (err) => {
        if (err) {
            console.error(`Failed to publish command '${command}':`, err);
            return res.status(500).json({ success: false, message: 'Failed to publish MQTT command' });
        }
        if (res) { // res will be null for WebSocket calls
            res.json({ success: true, ...successData });
        }
    });
};

const validateRequest = (req, res, next) => {
    const errors = validationResult(req);
    if (errors.isEmpty()) {
        return next();
    }
    const extractedErrors = [];
    errors.array().map(err => extractedErrors.push({ [err.param]: err.msg }));

    return res.status(422).json({
        errors: extractedErrors,
    });
};

apiRouter.get('/stations', (req, res) => {
    res.json({
        success: true,
        data: stationList,
    });
});

apiRouter.put(
    '/stations',
    body('stations').isArray({ min: 1, max: MAX_STATIONS }).withMessage(`must be an array of 1..${MAX_STATIONS} stations`),
    validateRequest,
    (req, res) => {
        if (req.body.expectedVersion !== undefined && req.body.expectedVersion !== stationList.version) {
            return res.status(409).json({
                success: false,
                message: `Version conflict: expected ${req.body.expectedVersion}, current ${stationList.version}`,
                currentVersion: stationList.version,
            });
        }
        const incoming = req.body.stations;
        const urls = new Set();
        for (let i = 0; i < incoming.length; i++) {
            const err = validateStationEntry(incoming[i]);
            if (err) {
                return res.status(422).json({ success: false, errors: [{ station: i, message: err }] });
            }
            if (urls.has(incoming[i].url)) {
                return res.status(422).json({ success: false, errors: [{ station: i, message: `duplicate url: ${incoming[i].url}` }] });
            }
            urls.add(incoming[i].url);
        }
        saveStations(mergeStationIds(incoming), res);
    }
);

// Append a single station (server assigns the id)
apiRouter.post(
    '/stations',
    (req, res) => {
        const err = validateStationEntry(req.body);
        if (err) return res.status(422).json({ success: false, errors: [{ station: null, message: err }] });
        if (stationList.stations.some(s => s.url === req.body.url)) {
            return res.status(422).json({ success: false, errors: [{ station: null, message: `duplicate url: ${req.body.url}` }] });
        }
        if (stationList.stations.length >= MAX_STATIONS) {
            return res.status(422).json({ success: false, errors: [{ station: null, message: `station list is full (max ${MAX_STATIONS})` }] });
        }
        const next = stationList.stations.concat([{
            id: nextStationId++,
            name: req.body.name.trim(),
            url: req.body.url,
            genre: (req.body.genre || 'radio').trim(),
        }]);
        saveStations(next, res);
    }
);

// Update a station by id (partial)
apiRouter.patch(
    '/stations/:id',
    (req, res) => {
        const id = Number(req.params.id);
        const idx = stationList.stations.findIndex(s => s.id === id);
        if (idx === -1) return res.status(404).json({ success: false, message: `no station with id ${id}` });
        const patch = req.body || {};
        if (patch.url !== undefined || patch.name !== undefined || patch.genre !== undefined) {
            const candidate = { ...stationList.stations[idx], ...patch };
            const err = validateStationEntry(candidate);
            if (err) return res.status(422).json({ success: false, errors: [{ station: id, message: err }] });
            if (patch.url !== undefined && stationList.stations.some(s => s.url === patch.url && s.id !== id)) {
                return res.status(422).json({ success: false, errors: [{ station: id, message: `duplicate url: ${patch.url}` }] });
            }
        }
        const next = stationList.stations.slice();
        next[idx] = {
            id,
            name: (patch.name !== undefined ? String(patch.name) : next[idx].name).trim(),
            url: patch.url !== undefined ? String(patch.url) : next[idx].url,
            genre: (patch.genre !== undefined ? String(patch.genre) : next[idx].genre).trim(),
        };
        saveStations(next, res);
    }
);

// Delete a station by id
apiRouter.delete(
    '/stations/:id',
    (req, res) => {
        const id = Number(req.params.id);
        const idx = stationList.stations.findIndex(s => s.id === id);
        if (idx === -1) return res.status(404).json({ success: false, message: `no station with id ${id}` });
        if (stationList.stations.length <= 1) {
            return res.status(422).json({ success: false, message: 'cannot delete the last station' });
        }
        const next = stationList.stations.slice();
        next.splice(idx, 1);
        saveStations(next, res);
    }
);

// Reorder stations by a full id list (must be a permutation of the current ids)
apiRouter.post(
    '/stations/order',
    (req, res) => {
        const ids = req.body.ids;
        if (!Array.isArray(ids) || ids.length !== stationList.stations.length) {
            return res.status(422).json({ success: false, message: `ids must be an array of exactly ${stationList.stations.length} ids` });
        }
        const byId = new Map(stationList.stations.map(s => [s.id, s]));
        const next = [];
        for (const id of ids) {
            if (!byId.has(id)) return res.status(422).json({ success: false, message: `unknown id: ${id}` });
            next.push(byId.get(id));
            byId.delete(id);
        }
        saveStations(next, res);
    }
);

apiRouter.post(
    '/station',
    body('station').isInt({ min: 1, max: MAX_STATIONS }).withMessage(`must be an integer between 1 and ${MAX_STATIONS}`),
    validateRequest,
    (req, res) => {
        const { station } = req.body;
        const command = `c${station}`; // firmware command: turn on and switch to channel N
        publishMqttCommand(res, command, { command, station });
    }
);

apiRouter.post(
    '/volume',
    body('volume').isInt({ min: 0, max: 21 }).withMessage('must be an integer between 0 and 21'),
    validateRequest,
    (req, res) => {
        const { volume } = req.body;
        // The firmware only accepts vol+ / vol-; compute the delta from the last known volume
        const current = parseInt(radioState.Volume, 10);
        if (Number.isNaN(current)) {
            return res.status(503).json({ success: false, message: 'current volume unknown; request status first (POST /command {"command":"?"})' });
        }
        const delta = volume - current;
        if (delta === 0) {
            return res.json({ success: true, command: null, volume, note: 'volume already at target' });
        }
        const step = delta > 0 ? 'vol+' : 'vol-';
        for (let i = 0; i < Math.abs(delta); i++) {
            client.publish(`${MQTT_PREFIX}/Action`, step);
        }
        res.json({ success: true, command: `${step}`.repeat(Math.abs(delta)), from: current, volume });
    }
);

apiRouter.post(
    '/power',
    body('state').isIn(['on', 'off']).withMessage('must be "on" or "off"'),
    validateRequest,
    (req, res) => {
        const { state } = req.body;
        const command = state === 'on' ? '1' : '0'; // firmware commands
        publishMqttCommand(res, command, { command, state });
    }
);

apiRouter.post(
    '/alarm',
    body('seconds').optional().isInt({ min: 0, max: 86400 }).withMessage('seconds must be an integer between 0 and 86400'),
    body('time').optional().matches(/^([01]?\d|2[0-3]):[0-5]\d$/).withMessage('time must be "HH:MM" (24h)'),
    validateRequest,
    (req, res) => {
        const hasSeconds = req.body.seconds !== undefined && req.body.seconds !== null && req.body.seconds !== '';
        const hasTime = req.body.time !== undefined && req.body.time !== null && req.body.time !== '';
        if (hasSeconds === hasTime) {
            return res.status(422).json({ success: false, message: 'provide exactly one of: seconds (0..86400) or time ("HH:MM")' });
        }
        let sec;
        if (hasSeconds) {
            sec = Number(req.body.seconds);
        } else {
            const [h, m] = String(req.body.time).split(':').map(Number);
            sec = h * 3600 + m * 60;
        }
        // seconds === 0 means "no alarm": the device treats "s0" as arming a midnight alarm
        const command = sec === 0 ? 'sAlarm OFF' : `s${sec}`;
        publishMqttCommand(res, command, { command, seconds: sec });
    }
);

apiRouter.post(
    '/command',
    body('command').isString().notEmpty().withMessage('must be a non-empty string'),
    validateRequest,
    (req, res) => {
        const { command } = req.body;
        publishMqttCommand(res, command, { command });
    }
);

app.use('/api/radio', apiRouter);

// --- OpenAPI spec (API discovery for AI agents and tools) ---
apiRouter.get('/openapi.json', (req, res) => {
    res.json(require('./openapi.json'));
});

// --- Static Frontend Hosting ---
app.use('/', express.static('public'));

// --- Server and WebSocket Setup ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const broadcastUpdate = () => {
    const message = JSON.stringify({
        type: 'statusUpdate',
        data: radioState
    });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
};

server.on('upgrade', (request, socket, head) => {
    // Correctly construct the URL for parsing
    const fullUrl = `ws://${request.headers.host}${request.url}`;
    const url = new URL(fullUrl);
    const token = url.searchParams.get('token');

    if (token === SECRET_TOKEN) {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        console.log('WebSocket connection rejected: Invalid token.');
        socket.destroy();
    }
});

wss.on('connection', (ws) => {
    console.log('WebSocket client connected');
    // Send initial state
    ws.send(JSON.stringify({ type: 'statusUpdate', data: radioState }));

    ws.on('message', (message) => {
        try {
            const parsed = JSON.parse(message);
            if (parsed.type === 'command' && parsed.payload) {
                // Allow frontend to send commands via WebSocket too
                publishMqttCommand(null, parsed.payload.command, {});
            }
        } catch (e) {
            console.error('Failed to parse WebSocket message:', e);
        }
    });

    ws.on('close', () => {
        console.log('WebSocket client disconnected');
    });
});

// --- Server Start ---
loadStations();
server.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);
    console.log(`Access the web interface at: http://YOUR_SERVER_IP:${port}`);
    console.log(`WebSocket endpoint is protected and requires a token.`);
});