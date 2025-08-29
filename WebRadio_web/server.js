const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1); // Trust the first proxy

// Security headers
app.use(helmet({
    strictTransportSecurity: false,
    contentSecurityPolicy: false,
}));

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


// Middleware to protect all routes
const authMiddleware = (req, res, next) => {
    const token = req.headers['x-auth-token'];

    if (token && token === SECRET_TOKEN) {
        return next();
    }

    // For WebSocket, the upgrade request is handled separately
    if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
        return next();
    }

    return res.status(401).send('Unauthorized');
};

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

app.use('/api/radio', authMiddleware, apiRouter);

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
    const url = new URL(request.url, `http://${request.headers.host}`);
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
server.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);
    console.log(`Access the web interface at: http://YOUR_SERVER_IP:${port}/${SECRET_TOKEN}`);
    console.log(`WebSocket endpoint: ws://YOUR_SERVER_IP:${port}/${SECRET_TOKEN}/ws`);
});