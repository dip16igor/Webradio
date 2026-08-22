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
const loadStations = () => {
    try {
        const data = JSON.parse(fs.readFileSync(STATIONS_FILE, 'utf8'));
        if (Array.isArray(data.stations)) {
            stationList = {
                version: typeof data.version === 'number' ? data.version : 0,
                updatedAt: data.updatedAt || null,
                stations: data.stations,
            };
            console.log(`Loaded ${stationList.stations.length} stations from ${STATIONS_FILE} (version ${stationList.version})`);
            return;
        }
    } catch (err) {
        console.warn(`Could not load ${STATIONS_FILE}: ${err.message}`);
    }
    console.warn(`Starting with an empty station list. Use the admin page (PUT /api/stations) to populate it.`);
    stationList = { version: 0, updatedAt: null, stations: [] };
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
        const stations = req.body.stations;
        const urls = new Set();
        for (let i = 0; i < stations.length; i++) {
            const s = stations[i];
            if (!s || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 60) {
                return res.status(422).json({ success: false, errors: [{ station: i, message: 'name must be a non-empty string (max 60 chars)' }] });
            }
            if (typeof s.url !== 'string' || !/^https?:\/\/.+/.test(s.url) || s.url.length > 200) {
                return res.status(422).json({ success: false, errors: [{ station: i, message: 'url must start with http:// or https:// (max 200 chars)' }] });
            }
            if (urls.has(s.url)) {
                return res.status(422).json({ success: false, errors: [{ station: i, message: `duplicate url: ${s.url}` }] });
            }
            urls.add(s.url);
            if (typeof s.genre !== 'string' || !s.genre.trim()) s.genre = 'radio';
            if (s.genre.length > 30) s.genre = s.genre.slice(0, 30);
        }

        const nextVersion = stationList.version + 1;
        stationList = {
            version: nextVersion,
            updatedAt: new Date().toISOString(),
            stations: stations.map((s) => ({ name: s.name.trim(), url: s.url, genre: s.genre.trim() })),
        };

        const dir = path.dirname(STATIONS_FILE);
        const tmp = `${STATIONS_FILE}.tmp`;
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(stationList, null, 2), 'utf8');
            fs.renameSync(tmp, STATIONS_FILE);
        } catch (err) {
            console.error(`Failed to persist ${STATIONS_FILE}:`, err);
            return res.status(500).json({ success: false, message: 'Failed to persist station list' });
        }

        console.log(`Station list saved: ${stationList.stations.length} stations (version ${nextVersion})`);
        MQTT_PREFIXES.forEach(publishStations);
        broadcastUpdate(); // reflect the new version in the web UI state
        res.json({ success: true, data: stationList });
    }
);

apiRouter.post(
    '/station',
    body('station').isNumeric().withMessage('must be a number'),
    validateRequest,
    (req, res) => {
        const { station } = req.body;
        const command = `st${station}`;
        publishMqttCommand(res, command, { command, station });
    }
);

apiRouter.post(
    '/volume',
    body('volume').isInt({ min: 0, max: 21 }).withMessage('must be an integer between 0 and 21'),
    validateRequest,
    (req, res) => {
        const { volume } = req.body;
        const command = `v${volume}`;
        publishMqttCommand(res, command, { command, volume });
    }
);

apiRouter.post(
    '/power',
    body('state').isIn(['on', 'off']).withMessage('must be "on" or "off"'),
    validateRequest,
    (req, res) => {
        const { state } = req.body;
        const command = `power_${state}`;
        publishMqttCommand(res, command, { command, state });
    }
);

apiRouter.post(
    '/alarm',
    body('seconds').isInt({ min: 0, max: 86400 }).withMessage('must be an integer between 0 and 86400'),
    validateRequest,
    (req, res) => {
        const { seconds } = req.body;
        const command = `s${seconds}`;
        publishMqttCommand(res, command, { command, seconds });
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