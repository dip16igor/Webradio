const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
require('dotenv').config();

const app = express();
const port = 3000;

// --- Configuration ---
const SECRET_TOKEN = process.env.SECRET_TOKEN || crypto.randomBytes(32).toString('hex');
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://127.0.0.1:1883';
const MQTT_USER = process.env.MQTT_USER;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const MQTT_PREFIX = 'Home/WebRadio2';

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

const radioState = {
    State: "Offline",
    Volume: "N/A",
    Station: "N/A",
    Title: "N/A",
    Log: "N/A",
    FreeHeap: "N/A",
    Alarm: "N/A"
};

client.on('connect', () => {
    console.log('Connected to MQTT broker');
    // Subscribe to all status topics
    client.subscribe(`${MQTT_PREFIX}/#`, (err) => {
        if (err) {
            console.error('Subscription error:', err);
        } else {
            console.log(`Subscribed to topics under ${MQTT_PREFIX}`);
        }
    });
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

client.on('message', (topic, message) => {
    const topicSuffix = topic.replace(`${MQTT_PREFIX}/`, '');
    const value = message.toString();

    let updated = false;
    if (radioState[topicSuffix] !== undefined && radioState[topicSuffix] !== value) {
        radioState[topicSuffix] = value;
        updated = true;
    }

    if (updated) {
        broadcastUpdate();
    }
});

// --- Express Middleware ---
app.use(cors());
app.use(express.json());

// Middleware to protect all routes
const secretPathMiddleware = (req, res, next) => {
    if (req.path.startsWith(`/${SECRET_TOKEN}`)) {
        // Strip the secret token from the path for subsequent routing
        req.url = req.url.replace(`/${SECRET_TOKEN}`, '') || '/';
        return next();
    }
    // For WebSocket, the upgrade request is handled separately
    if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
        return next();
    }
    return res.status(404).send('Not Found');
};

app.use(secretPathMiddleware);

// --- API Routes ---
const apiRouter = express.Router();

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

apiRouter.post('/station', (req, res) => {
    const { station } = req.body;
    if (typeof station === 'undefined') {
        return res.status(400).json({ success: false, message: 'Missing "station" in request body' });
    }
    const command = `st${station}`;
    publishMqttCommand(res, command, { command, station });
});

apiRouter.post('/volume', (req, res) => {
    const { volume } = req.body;
    if (typeof volume === 'undefined' || volume < 0 || volume > 21) {
        return res.status(400).json({ success: false, message: 'Invalid "volume" in request body (must be 0-21)' });
    }
    const command = `v${volume}`;
    publishMqttCommand(res, command, { command, volume });
});

apiRouter.post('/power', (req, res) => {
    const { state } = req.body;
    if (!['on', 'off'].includes(state)) {
        return res.status(400).json({ success: false, message: 'Invalid "state" in request body (must be "on" or "off")' });
    }
    const command = `power_${state}`;
    publishMqttCommand(res, command, { command, state });
});

apiRouter.post('/alarm', (req, res) => {
    const { seconds } = req.body;
    if (typeof seconds === 'undefined' || seconds < 0 || seconds > 86400) {
        return res.status(400).json({ success: false, message: 'Invalid "seconds" in request body (must be 0-86400)' });
    }
    const command = `s${seconds}`;
    publishMqttCommand(res, command, { command, seconds });
});

apiRouter.post('/command', (req, res) => {
    const { command } = req.body;
    if (typeof command !== 'string' || command.trim() === '') {
        return res.status(400).json({ success: false, message: 'Invalid "command" in request body' });
    }
    publishMqttCommand(res, command, { command });
});

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
    // Authenticate WebSocket connection URL
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === `/${SECRET_TOKEN}/ws`) {
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
server.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);
    console.log(`Access the web interface at: http://YOUR_SERVER_IP:${port}/${SECRET_TOKEN}`);
    console.log(`WebSocket endpoint: ws://YOUR_SERVER_IP:${port}/${SECRET_TOKEN}/ws`);
});