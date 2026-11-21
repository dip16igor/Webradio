const express = require('express');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');


const app = express();
app.set('trust proxy', 1); // Trust the first proxy

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            // Cover search in admin.html (browser fetch) + artwork <img>.
            'connect-src': ["'self'", 'https://itunes.apple.com'],
            'img-src': ["'self'", 'data:', 'https://is1-ssl.mzstatic.com', 'https://is2-ssl.mzstatic.com', 'https://is3-ssl.mzstatic.com', 'https://is4-ssl.mzstatic.com', 'https://is5-ssl.mzstatic.com', 'https://server.arcgisonline.com'],
        },
    },
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
const MQTT_PREFIXES = ['Home/WebRadio1', 'Home/WebRadio2'];
const STATIONS_FILE = process.env.STATIONS_FILE || 'data/stations.json';
const MAX_STATIONS = 255;

// --- Public player: per-user accounts with cookie sessions, own station lists ---
// Disabled until PUB_JWT_SECRET is set (register/login answer 503 without it).
const PUB_JWT_SECRET = process.env.PUB_JWT_SECRET || '';
const PUB_INVITE_CODE = process.env.PUB_INVITE_CODE || '';
const PUB_DIR = process.env.PUB_DIR || 'data/pub';
const PUB_COOKIE = 'pub_session';
const getCookies = (req) => {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
};
const pubSessionUid = (req) => {
    try {
        const t = getCookies(req)[PUB_COOKIE];
        if (!t || !PUB_JWT_SECRET) return null;
        const p = jwt.verify(t, PUB_JWT_SECRET);
        return p && p.uid ? String(p.uid) : null;
    } catch (e) { return null; }
};
const pubSignUid = (uid) => jwt.sign({ uid: String(uid) }, PUB_JWT_SECRET, { expiresIn: '30d' });
const PUB_COOKIE_OPTS = 'HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000';
let pubUsers = null; // { users: [{id, login, hash, createdAt}] }
const pubUsersFile = () => path.join(PUB_DIR, 'users.json');
const pubLoadUsers = () => {
    if (pubUsers) return pubUsers;
    try {
        fs.mkdirSync(PUB_DIR, { recursive: true });
        pubUsers = JSON.parse(fs.readFileSync(pubUsersFile(), 'utf8'));
        if (!pubUsers || !Array.isArray(pubUsers.users)) pubUsers = { users: [] };
    } catch (e) { pubUsers = { users: [] }; }
    return pubUsers;
};
const pubSaveUsers = () => {
    const tmp = pubUsersFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(pubUsers, null, 2), 'utf8');
    fs.renameSync(tmp, pubUsersFile());
};
const pubStationsFile = (uid) => path.join(PUB_DIR, `stations_${String(uid).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
const pubLoadStations = (uid) => {
    try {
        const d = JSON.parse(fs.readFileSync(pubStationsFile(uid), 'utf8'));
        if (d && Array.isArray(d.stations)) return d;
    } catch (e) { /* fall through */ }
    return { version: 1, updatedAt: new Date().toISOString(), stations: [] };
};
const pubSaveStations = (uid, doc) => {
    doc.updatedAt = new Date().toISOString();
    const f = pubStationsFile(uid);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    fs.renameSync(tmp, f);
    return doc;
};
const pubCheckStation = (s) => {
    if (!s || typeof s.name !== 'string' || !s.name.trim() || s.name.trim().length > 60) return 'bad name';
    if (typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url) || s.url.length > 200) return 'bad url';
    if (s.genre !== undefined && (typeof s.genre !== 'string' || s.genre.length > 40)) return 'bad genre';
    return null;
};
const pubAuth = (req, res, next) => {
    const uid = pubSessionUid(req);
    if (!uid) return res.status(401).json({ success: false, message: 'Unauthorized: login required' });
    const u = pubLoadUsers().users.find((x) => x.id === uid);
    if (!u) return res.status(401).json({ success: false, message: 'Unauthorized: unknown user' });
    req.pubUser = u;
    next();
};

// --- Smart alarm: wake on a chosen station with volume ramp, then back ---
// Schedule page: alarm.html. All logic server-side; no firmware changes.
const ALARM_FILE = process.env.ALARM_FILE || 'data/alarm.json';
let alarmCfg = null; // { timezone, weekday:{...}, weekend:{...}, eveningStationId, runtime, lastRun }
let alarmAskedAt = 0; // last "?" probe sent while waiting for a first status snapshot

// A window is identified by (date, profile, t1): only a run that really covered
// THIS window blocks a refire. Aborts/skips/stale marks carry the same key so a
// new window (or an edited schedule) always fires.
const alarmFmt = (mins) => String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
const lastRunKey = (lr) => lr ? (lr.date + '|' + lr.profile + '|' + (lr.t1 || '')) : null;

const alarmDefaultProfile = (t1, t2) => ({
    enabled: true, t1, t2,
    stationId: null,      // wake station id (Relax Morning Birds by default, set on first save)
    startVolume: 1, targetVolume: 12, rampMin: 20,
});

const alarmDefaultSleep = () => ({
    enabled: false, at: '23:00', rampMin: 15,
});

const alarmDefaults = () => ({
    timezone: 'Asia/Yekaterinburg',
    weekday: alarmDefaultProfile('06:30', '07:30'),
    weekend: alarmDefaultProfile('07:00', '08:00'),
    eveningStationId: null,
    runtime: null,        // active scenario (persisted to survive restarts)
    lastRun: null,        // { date, profile, result }
    sleep: alarmDefaultSleep(),
});

const persistAlarmFile = () => {
    try {
        const dir = path.dirname(ALARM_FILE);
        const tmp = ALARM_FILE + '.tmp';
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(alarmCfg, null, 2), 'utf8');
        fs.renameSync(tmp, ALARM_FILE);
    } catch (err) {
        console.warn('Could not persist ' + ALARM_FILE + ': ' + err.message);
    }
};

const loadAlarm = () => {
    alarmCfg = alarmDefaults();
    try {
        const data = JSON.parse(fs.readFileSync(ALARM_FILE, 'utf8'));
        if (data && typeof data === 'object') {
            if (typeof data.timezone === 'string' && data.timezone) alarmCfg.timezone = data.timezone;
            for (const k of ['weekday', 'weekend']) {
                if (data[k] && typeof data[k] === 'object') alarmCfg[k] = { ...alarmCfg[k], ...data[k] };
            }
            if (data.sleep && typeof data.sleep === 'object') {
                alarmCfg.sleep = { ...alarmDefaultSleep(), ...data.sleep };
            }
            if (Number.isInteger(data.eveningStationId)) alarmCfg.eveningStationId = data.eveningStationId;
            if (data.lastRun && typeof data.lastRun === 'object') alarmCfg.lastRun = data.lastRun;
            // Keep a runtime only if it is still inside its window; otherwise drop it
            if (data.runtime && typeof data.runtime === 'object') alarmCfg.runtime = data.runtime;
        }
        console.log('Loaded alarm schedule from ' + ALARM_FILE);
    } catch (err) {
        console.warn('Could not load ' + ALARM_FILE + ': ' + err.message + ' (using defaults)');
    }
    // Default wake station: Relax Morning Birds if present
    const birds = stationList.stations.find(s => /morning birds/i.test(s.name));
    for (const k of ['weekday', 'weekend']) {
        if (!Number.isInteger(alarmCfg[k].stationId) && birds) alarmCfg[k].stationId = birds.id;
    }
};

// Local wall-clock in the configured timezone: { dateStr, dayIdx (0=Sun), nowMin }
const alarmNow = () => {
    const tz = alarmCfg.timezone || 'Asia/Yekaterinburg';
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    }).formatToParts(new Date());
    const get = (t) => (parts.find(p => p.type === t) || {}).value;
    const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get('weekday')] ?? 1;
    return {
        dateStr: get('year') + '-' + get('month') + '-' + get('day'),
        dayIdx: wd,
        nowMin: parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10),
    };
};

const alarmChannelById = (id) => {
    const i = stationList.stations.findIndex(s => s.id === id);
    return i >= 0 ? i + 1 : null;
};

const alarmPublish = (cmd) => {
    client.publish(MQTT_PREFIX + '/Action', cmd);
};

// Nudge volume toward target with a few vol steps (firmware accepts vol+/vol- only)
const alarmStepVolume = (target) => {
    const cur = parseInt(radioState.Volume, 10);
    if (Number.isNaN(cur)) { alarmPublish('?'); return false; }
    const delta = target - cur;
    if (delta === 0) return true;
    const step = delta > 0 ? 'vol+' : 'vol-';
    const n = Math.min(Math.abs(delta), 3);
    for (let i = 0; i < n; i++) client.publish(MQTT_PREFIX + '/Action', step);
    return false;
};

const alarmAbort = (reason) => {
    const rt = alarmCfg.runtime;
    if (!rt) return;
    console.log('Alarm scenario aborted in phase ' + ((rt && rt.phase) || '?') + ': ' + reason);
    alarmCfg.runtime = null;
    alarmCfg.lastRun = { date: rt.date, profile: rt.profile, t1: alarmFmt(rt.t1min), result: 'aborted: ' + reason };
    persistAlarmFile();
};

const alarmStart = (profileName, prof, now) => {
    const wakeCh = alarmChannelById(prof.stationId);
    if (!wakeCh) {
        alarmCfg.lastRun = { date: now.dateStr, profile: profileName, t1: t1str, result: 'failed: wake station not in list' };
        persistAlarmFile();
        return;
    }
    const t1 = parseInt(prof.t1.slice(0, 2), 10) * 60 + parseInt(prof.t1.slice(3), 10);
    const t2 = parseInt(prof.t2.slice(0, 2), 10) * 60 + parseInt(prof.t2.slice(3), 10);
    const t1str = prof.t1;
    // Don't hijack a radio the user already turned on themselves
    if (radioState.State && String(radioState.State).includes('Power ON')) {
        alarmCfg.lastRun = { date: now.dateStr, profile: profileName, t1: t1str, result: 'skipped: already on' };
        persistAlarmFile();
        console.log('Alarm skipped: radio already on');
        return;
    }
    alarmCfg.runtime = {
        date: now.dateStr, profile: profileName, phase: 'starting',
        wakeId: prof.stationId, wakeCh, t1min: t1, t2min: t2,
        startVol: prof.startVolume, targetVol: prof.targetVolume, rampMin: prof.rampMin,
        t0: Date.now(), nextVolAt: Date.now() + 45000,
        expectedCh: wakeCh, expectedVol: prof.startVolume,
        holdUntil: Date.now() + 90000,
    };
    alarmPublish('sAlarm OFF'); // our schedule replaces the device's own alarm
    alarmPublish('c' + wakeCh); // powers on + switches to the wake station
    alarmPublish('?');
    console.log('Alarm scenario started (' + profileName + '): ch' + wakeCh);
    persistAlarmFile();
};

const alarmTick = () => {
    if (!alarmCfg) return;
    const now = alarmNow();
    const rt = alarmCfg.runtime;
    if (!rt) {
        const isWknd = now.dayIdx === 0 || now.dayIdx === 6;
        const name = isWknd ? 'weekend' : 'weekday';
        const prof = alarmCfg[name];
        if (prof && prof.enabled && Number.isInteger(prof.stationId)) {
            const t1 = parseInt(prof.t1.slice(0, 2), 10) * 60 + parseInt(prof.t1.slice(3), 10);
            const already = lastRunKey(alarmCfg.lastRun) === (now.dateStr + '|' + name + '|' + prof.t1);
            // Fire only inside a 10-minute window after t1 (never "any time after t1"),
            // and never on an empty status snapshot (e.g. right after a server restart).
            if (now.nowMin >= t1 && now.nowMin < t1 + 10 && !already) {
                if (!radioState.State) {
                    if (Date.now() - alarmAskedAt > 5 * 60 * 1000) {
                        alarmAskedAt = Date.now();
                        alarmPublish('?');
                    }
                } else {
                    alarmStart(name, prof, now);
                }
            }
        }
        // Sleep timer: same window logic, keyed by (date, 'sleep', at).
        // Runs inside the same no-runtime branch as the wake profiles.
        {
            const sl = alarmCfg.sleep;
        if (sl && sl.enabled) {
            const at = parseInt(sl.at.slice(0, 2), 10) * 60 + parseInt(sl.at.slice(3), 10);
            const already = lastRunKey(alarmCfg.lastRun) === (now.dateStr + '|sleep|' + sl.at);
            if (now.nowMin >= at && now.nowMin < at + 10 && !already) {
                if (!radioState.State) {
                    if (Date.now() - alarmAskedAt > 5 * 60 * 1000) {
                        alarmAskedAt = Date.now();
                        alarmPublish('?');
                    }
                } else if (!String(radioState.State).includes('Power ON')) {
                    alarmCfg.lastRun = { date: now.dateStr, profile: 'sleep', t1: sl.at, result: 'skipped: already off' };
                    console.log('Sleep timer skipped: radio already off');
                    persistAlarmFile();
                } else {
                    const cur = parseInt(radioState.Volume, 10);
                    alarmCfg.runtime = {
                        date: now.dateStr, profile: 'sleep', kind: 'sleep', phase: 'fading',
                        t1min: at, startVol: Number.isNaN(cur) ? null : cur, rampMin: sl.rampMin,
                        t0: Date.now(), nextVolAt: Date.now() + 30000,
                        expectedCh: parseChannel(radioState.Station),
                        expectedVol: Number.isNaN(cur) ? null : cur,
                        holdUntil: Date.now() + 90000,
                    };
                    alarmPublish('?');
                    console.log('Sleep timer started, fading over ' + sl.rampMin + ' min');
                    persistAlarmFile();
                }
            }
        }
        }
        return;
    }
    // Active scenario
    if (rt.date !== now.dateStr || now.nowMin >= rt.t2min + 30) {
        alarmCfg.runtime = null;
        alarmCfg.lastRun = { date: rt.date, profile: rt.profile, t1: alarmFmt(rt.t1min), result: 'finished (stale)' };
        console.log('Alarm scenario stale, dropping: ' + rt.profile + ' ' + alarmFmt(rt.t1min));
        persistAlarmFile();
        return;
    }
    if (rt.phase === 'starting') {
        // Wait until the device reports the wake channel, then begin the ramp
        const ch = parseChannel(radioState.Station);
        if (ch === rt.expectedCh) {
            rt.phase = 'ramping';
            persistAlarmFile();
        } else if (Date.now() - rt.t0 > 5 * 60 * 1000) {
            alarmAbort('wake station did not start');
        }
        return;
    }
    if (rt.phase === 'fading') {
        // Linear fade: startVol -> 0 over rampMin, then power off.
        if (rt.startVol === null || rt.startVol === undefined) {
            const cur0 = parseInt(radioState.Volume, 10);
            if (Number.isNaN(cur0)) { alarmPublish('?'); return; }
            rt.startVol = cur0;
            rt.expectedVol = cur0;
            persistAlarmFile();
        }
        const elapsed = (Date.now() - rt.t0) / 1000;
        const total = Math.max(rt.rampMin * 60, 60);
        const want = Math.round(rt.startVol * (1 - Math.min(elapsed / total, 1)));
        rt.expectedVol = want;
        const cur = parseInt(radioState.Volume, 10);
        if (!Number.isNaN(cur) && cur <= 0) {
            rt.phase = 'powering_off';
            rt.t0 = Date.now();
            rt.holdUntil = Date.now() + 60000;
            alarmPublish('0'); // firmware power off
            console.log('Sleep timer: volume at 0, powering off');
            persistAlarmFile();
            return;
        }
        if (Date.now() >= rt.nextVolAt) {
            rt.nextVolAt = Date.now() + 60000;
            if (!alarmStepVolume(want)) {
                rt.holdUntil = Date.now() + 75000;
                console.log('Sleep timer: fading volume ' + radioState.Volume + ' -> ' + want);
            }
            persistAlarmFile();
        }
        return;
    }
    if (rt.phase === 'powering_off') {
        const st = String(radioState.State || '');
        if (st && !st.includes('Power ON')) {
            alarmCfg.runtime = null;
            alarmCfg.lastRun = { date: rt.date, profile: rt.profile, t1: alarmFmt(rt.t1min), result: 'finished' };
            console.log('Sleep timer finished: radio is off');
            persistAlarmFile();
            return;
        }
        if (Date.now() - rt.t0 > 90 * 1000) {
            alarmCfg.runtime = null;
            alarmCfg.lastRun = { date: rt.date, profile: rt.profile, t1: alarmFmt(rt.t1min), result: 'finished (power-off unconfirmed)' };
            console.log('Sleep timer finished, power-off unconfirmed');
            persistAlarmFile();
            return;
        }
        return;
    }
    if (rt.phase === 'ramping') {
        if (now.nowMin >= rt.t2min) {
            // Switchback to the evening station (resolved by id at this moment),
            // then verify the channel and the volume closed-loop.
            const ech = Number.isInteger(alarmCfg.eveningStationId)
                ? alarmChannelById(alarmCfg.eveningStationId) : null;
            if (ech) {
                rt.phase = 'switching';
                rt.t0 = Date.now();
                rt.expectedCh = ech;
                rt.expectedVol = rt.targetVol;
                rt.holdUntil = Date.now() + 120000;
                alarmPublish('c' + ech);
                console.log('Alarm switchback to ch' + ech);
            } else {
                console.log('Alarm: no evening station known, staying on wake station');
                rt.phase = 'verifying';
                rt.verifyUntil = Date.now() + 300000;
            }
            persistAlarmFile();
            return;
            }
            if (rt.phase === 'switching') {
                const ch = parseChannel(radioState.Station);
                if (ch === rt.expectedCh) {
                    rt.phase = 'verifying';
                    rt.verifyUntil = Date.now() + 300000;
                    console.log('Alarm: evening station confirmed on ch' + ch + ', verifying volume');
                    persistAlarmFile();
                } else if (Date.now() - rt.t0 > 3 * 60 * 1000) {
                    rt.phase = 'verifying';
                    rt.verifyUntil = Date.now() + 120000;
                    console.log('Alarm: evening station did not confirm, verifying volume anyway');
                    persistAlarmFile();
                }
                return;
            }
            if (rt.phase === 'verifying') {
                const cur = parseInt(radioState.Volume, 10);
                const ch = parseChannel(radioState.Station);
                const okVol = !Number.isNaN(cur) && Math.abs(cur - rt.targetVol) <= 1;
                if (okVol && ch === rt.expectedCh) {
                    alarmCfg.runtime = null;
                    alarmCfg.lastRun = { date: rt.date, profile: rt.profile, t1: alarmFmt(rt.t1min), result: 'finished' };
                    console.log('Alarm finished: ch' + ch + ' vol ' + cur);
                    persistAlarmFile();
                    return;
                }
                if (Date.now() > rt.verifyUntil) {
                    alarmCfg.runtime = null;
                    alarmCfg.lastRun = { date: rt.date, profile: rt.profile, t1: alarmFmt(rt.t1min), result: 'finished (volume unverified, vol=' + radioState.Volume + ')' };
                    console.log('Alarm finished unverified: ch' + ch + ' vol ' + radioState.Volume);
                    persistAlarmFile();
                    return;
                }
                if (!okVol) {
                    if (alarmStepVolume(rt.targetVol)) {
                        console.log('Alarm verify: volume already ' + cur);
                    } else {
                        rt.holdUntil = Date.now() + 60000;
                        console.log('Alarm verify: nudging volume ' + cur + ' -> ' + rt.targetVol);
                    }
                    persistAlarmFile();
                }
                return;
        }
        // Volume ramp: linear startVol -> targetVol over rampMin
        const elapsed = (Date.now() - rt.t0) / 1000;
        const total = Math.max(rt.rampMin * 60, 60);
        const want = Math.round(rt.startVol + (rt.targetVol - rt.startVol) * Math.min(elapsed / total, 1));
        rt.expectedVol = want;
        if (Date.now() >= rt.nextVolAt) {
            rt.nextVolAt = Date.now() + 60000;
            if (alarmStepVolume(want)) {
                // already there; check again soon
                rt.nextVolAt = Date.now() + 60000;
            } else {
                rt.holdUntil = Date.now() + 75000;
                    console.log('Alarm ramp: nudging volume ' + radioState.Volume + ' -> ' + want);
            }
            persistAlarmFile();
        }
    }
};

// Watch user interference: any Station/Volume change that is not ours aborts the scenario
const trackAlarmUpdate = (suffix, value) => {
    const rt = alarmCfg && alarmCfg.runtime;
    if (suffix === 'Station' && !rt) {
        // Remember the last user-tuned station as the "evening" one
        const ch = parseChannel(value);
        const s = ch ? stationList.stations[ch - 1] : null;
        if (s && alarmCfg.eveningStationId !== s.id) {
            alarmCfg.eveningStationId = s.id;
            persistAlarmFile();
        }
        return;
    }
    if (!rt || Date.now() < rt.holdUntil) return;
    if (suffix === 'Station') {
        const ch = parseChannel(value);
        if (ch && rt.expectedCh && ch !== rt.expectedCh) alarmAbort('station changed by user to ch' + ch);
        return;
    }
    if (suffix === 'Volume') {
        const v = parseInt(value, 10);
        if (!Number.isNaN(v) && Math.abs(v - rt.expectedVol) > 1) {
            alarmAbort('volume changed by user to ' + v);
        }
        return;
    }
    if (suffix === 'State' && !String(value).includes('Power ON')) {
        if (rt && rt.kind === 'sleep' && (rt.phase === 'fading' || rt.phase === 'powering_off')) {
            alarmCfg.runtime = null;
            alarmCfg.lastRun = { date: rt.date, profile: rt.profile, t1: alarmFmt(rt.t1min), result: 'finished (turned off by user)' };
            console.log('Sleep timer finished: turned off by user');
            persistAlarmFile();
            return;
        }
        alarmAbort('powered off by user');
        return;
    }
};

setInterval(alarmTick, 20000);


// --- Usage statistics (per stable station id, not channel number) ---
const STATS_FILE = process.env.STATS_FILE || 'data/stats.json';
let usageStats = { version: 1, updatedAt: null, stations: {} };
let statsDirty = false;
let currentListenKey = null;

const statsEntry = (key, name, url) => {
    let e = usageStats.stations[key];
    if (!e) {
        e = usageStats.stations[key] = {
            id: key, name: name || key, url: url || '',
            listenSec: 0, switches: 0,
            dropSamples: 0, dropSum: 0, dropMax: 0,
            errCount: 0, lastError: null,
            lastStream: null, lastTitle: null, lastSeen: null,
        };
        statsDirty = true;
    } else {
        if (name && e.name !== name) { e.name = name; statsDirty = true; }
        if (url !== undefined && e.url !== url) { e.url = url; statsDirty = true; }
    }
    return e;
};

// Channel N (1-based position) -> stable station id at this moment
const statsKeyForChannel = (ch) => {
    const s = stationList.stations[ch - 1];
    if (s) return { key: 's' + s.id, name: s.name, url: s.url };
    return null;
};

const parseChannel = (stationStr) => {
    const m = String(stationStr || '').match(/^\s*(\d+)/);
    return m ? parseInt(m[1], 10) : null;
};

const LOG_ERROR_RE = /failed|failure|error|timeout|timed out|disconnected|abort|\b40[134]\b|\b50[03]\b|unable|couldn/i;

const trackStatusUpdate = (suffix, value) => {
    if (suffix === 'Station') {
        const ch = parseChannel(value);
        const r = ch ? statsKeyForChannel(ch) : null;
        const key = r ? r.key : (ch ? 'ch' + ch : null);
        if (!key) { currentListenKey = null; return; }
        const e = r ? statsEntry(key, r.name, r.url) : statsEntry(key, String(value).slice(0, 60), '');
        if (currentListenKey !== key) {
            e.switches += 1;
            currentListenKey = key;
            statsDirty = true;
        }
        return;
    }
    if (suffix === 'State') {
        if (!String(value).includes('Power ON')) currentListenKey = null;
        return;
    }
    if (!currentListenKey) return;
    const e = usageStats.stations[currentListenKey];
    if (!e) return;
    if (suffix === 'Dropouts') {
        const v = parseInt(value, 10);
        if (!Number.isNaN(v)) {
            e.dropSamples += 1;
            e.dropSum += v;
            if (v > e.dropMax) e.dropMax = v;
            statsDirty = true;
        }
        return;
    }
    if (suffix === 'Log') {
        const s = String(value);
        if (LOG_ERROR_RE.test(s) && e.lastError !== s) {
            e.errCount += 1;
            e.lastError = s.slice(0, 160);
            statsDirty = true;
        }
        if (/kb\/s/i.test(s) && e.lastStream !== s) {
            e.lastStream = s.slice(0, 120);
            statsDirty = true;
        }
        return;
    }
    if (suffix === 'Title') {
        const s = String(value).slice(0, 160);
        if (e.lastTitle !== s) { e.lastTitle = s; statsDirty = true; }
    }
};

// Refresh stored names/urls after a station list write (ids are stable)
const refreshStatsNames = () => {
    for (const s of stationList.stations) {
        const e = usageStats.stations['s' + s.id];
        if (e) {
            if (e.name !== s.name) { e.name = s.name; statsDirty = true; }
            if (e.url !== s.url) { e.url = s.url; statsDirty = true; }
        }
    }
};

const persistStatsFile = () => {
    if (!statsDirty) return;
    try {
        const dir = path.dirname(STATS_FILE);
        const tmp = STATS_FILE + '.tmp';
        fs.mkdirSync(dir, { recursive: true });
        usageStats.updatedAt = new Date().toISOString();
        fs.writeFileSync(tmp, JSON.stringify(usageStats, null, 2), 'utf8');
        fs.renameSync(tmp, STATS_FILE);
        statsDirty = false;
    } catch (err) {
        console.warn('Could not persist ' + STATS_FILE + ': ' + err.message);
    }
};

const loadStats = () => {
    try {
        const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
        if (data && typeof data === 'object' && data.stations && typeof data.stations === 'object') {
            usageStats = { version: 1, updatedAt: data.updatedAt || null, stations: data.stations };
            console.log('Loaded usage stats for ' + Object.keys(usageStats.stations).length + ' entries from ' + STATS_FILE);
            return;
        }
    } catch (err) {
        console.warn('Could not load ' + STATS_FILE + ': ' + err.message);
    }
    usageStats = { version: 1, updatedAt: null, stations: {} };
};

// Every 10 s: credit listening time to the current station; persist once a minute
setInterval(() => {
    if (currentListenKey && radioState.State && String(radioState.State).includes('Power ON')) {
        const e = usageStats.stations[currentListenKey];
        if (e) {
            e.listenSec += 10;
            e.lastSeen = new Date().toISOString();
            statsDirty = true;
        }
    }
    if (!persistStatsFile._n) persistStatsFile._n = 0;
    if (++persistStatsFile._n >= 6) { persistStatsFile._n = 0; persistStatsFile(); }
}, 10000);


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
    refreshStatsNames();
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

    trackStatusUpdate(topicSuffix, value);
    trackAlarmUpdate(topicSuffix, value);
    if (updated) {
        broadcastUpdate();
    }
});

// --- API Routes ---
const apiRouter = express.Router();

// Middleware for API authentication
const apiAuth = (req, res, next) => {
    // /preview authenticates itself (previewAuth allows a query-string token
    // because <audio> tags cannot set headers) - let it through here.
    if (req.path === '/preview') return next();
    // Public player: logged-in users reach probe/geo/preview with their session
    // cookie (<audio> and fetch send it automatically, no headers needed).
    if ((req.path === '/preview' || req.path === '/probe' || req.path === '/geo') && pubSessionUid(req)) {
        return next();
    }
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

// Accumulated listening statistics, keyed by stable station id ('s<ID>').
apiRouter.get('/stats', (req, res) => {
    res.json({
        success: true,
        data: usageStats,
    });
});

// Reset accumulated listening statistics (admin action, confirmed in UI).
apiRouter.delete('/stats', (req, res) => {
    const n = Object.keys(usageStats.stations).length;
    usageStats = { version: 1, updatedAt: new Date().toISOString(), stations: {} };
    statsDirty = true;
    persistStatsFile();
    res.json({ success: true, data: { cleared: n } });
});

// Smart alarm schedule (server-side scenario; needs no firmware changes)
apiRouter.get('/alarm/schedule', (req, res) => {
    const { runtime, ...rest } = alarmCfg;
    res.json({
        success: true,
        data: { ...rest, active: !!runtime, phase: runtime ? runtime.phase : null },
    });
});

apiRouter.put(
    '/alarm/schedule',
    (req, res) => {
        const b = req.body || {};
        const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
        const checkProfile = (p, name) => {
            if (!p || typeof p !== 'object') return name + ': must be an object';
            if (typeof p.enabled !== 'boolean') return name + '.enabled must be boolean';
            if (!timeRe.test(p.t1 || '')) return name + '.t1 must be HH:MM';
            if (!timeRe.test(p.t2 || '')) return name + '.t2 must be HH:MM';
            const m1 = parseInt(p.t1.slice(0, 2), 10) * 60 + parseInt(p.t1.slice(3), 10);
            const m2 = parseInt(p.t2.slice(0, 2), 10) * 60 + parseInt(p.t2.slice(3), 10);
            if (m2 <= m1) return name + '.t2 must be later than t1';
            if (!Number.isInteger(p.stationId)) return name + '.stationId must be an integer id';
            if (!stationList.stations.some(s => s.id === p.stationId)) {
                return name + '.stationId ' + p.stationId + ' is not in the station list';
            }
            for (const k of ['startVolume', 'targetVolume']) {
                if (!Number.isInteger(p[k]) || p[k] < 0 || p[k] > 21) return name + '.' + k + ' must be 0..21';
            }
            if (p.startVolume > p.targetVolume) return name + ': startVolume must not exceed targetVolume';
            if (!Number.isInteger(p.rampMin) || p.rampMin < 5 || p.rampMin > 60) {
                return name + '.rampMin must be 5..60 minutes';
            }
            return null;
        };
        if (b.timezone !== undefined) {
            try { new Intl.DateTimeFormat('en-US', { timeZone: String(b.timezone) }); }
            catch (e) { return res.status(422).json({ success: false, message: 'bad timezone' }); }
            alarmCfg.timezone = String(b.timezone);
        }
        if (b.sleep !== undefined) {
            const p = b.sleep;
            if (!p || typeof p !== 'object') return res.status(422).json({ success: false, message: 'sleep must be an object' });
            if (typeof p.enabled !== 'boolean') return res.status(422).json({ success: false, message: 'sleep.enabled must be boolean' });
            if (!timeRe.test(p.at || '')) return res.status(422).json({ success: false, message: 'sleep.at must be HH:MM' });
            if (!Number.isInteger(p.rampMin) || p.rampMin < 5 || p.rampMin > 60) {
                return res.status(422).json({ success: false, message: 'sleep.rampMin must be 5..60 minutes' });
            }
            alarmCfg.sleep = { enabled: p.enabled, at: p.at, rampMin: p.rampMin };
        }
        for (const k of ['weekday', 'weekend']) {
            if (b[k] !== undefined) {
                const err = checkProfile(b[k], k);
                if (err) return res.status(422).json({ success: false, message: err });
                alarmCfg[k] = {
                    enabled: b[k].enabled, t1: b[k].t1, t2: b[k].t2,
                    stationId: b[k].stationId, startVolume: b[k].startVolume,
                    targetVolume: b[k].targetVolume, rampMin: b[k].rampMin,
                };
            }
        }
        // A schedule edit cancels a running scenario so the new times take effect cleanly
        alarmCfg.runtime = null;
        persistAlarmFile();
        const { runtime, ...rest } = alarmCfg;
        res.json({ success: true, data: { ...rest, active: false, phase: null } });
    }
);

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

// Public player router: accounts + per-user station lists (cookie sessions).
const pubRouter = express.Router();
const pubLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
pubRouter.post('/register', pubLoginLimiter, async (req, res) => {
    if (!PUB_JWT_SECRET) return res.status(503).json({ success: false, message: 'Public player disabled' });
    const login = String(req.body && req.body.login || '').trim().toLowerCase();
    const password = String(req.body && req.body.password || '');
    const invite = String(req.body && req.body.invite || '');
    if (!/^[a-z0-9_-]{3,32}$/.test(login)) return res.status(422).json({ success: false, message: 'Login: 3-32 chars, a-z 0-9 _ -' });
    if (password.length < 8 || password.length > 200) return res.status(422).json({ success: false, message: 'Password: 8+ chars' });
    if (PUB_INVITE_CODE && invite !== PUB_INVITE_CODE) return res.status(403).json({ success: false, message: 'Invite code required' });
    const store = pubLoadUsers();
    if (store.users.some((x) => x.login === login)) return res.status(409).json({ success: false, message: 'Login taken' });
    const u = { id: crypto.randomBytes(8).toString('hex'), login, hash: await bcrypt.hash(password, 10), createdAt: new Date().toISOString() };
    store.users.push(u);
    try { pubSaveUsers(); } catch (e) { return res.status(500).json({ success: false, message: 'Failed to persist user' }); }
    // seed: copy of the current shared station list
    try {
        const shared = JSON.parse(fs.readFileSync(STATIONS_FILE, 'utf8'));
        if (shared && Array.isArray(shared.stations)) pubSaveStations(u.id, { version: 1, updatedAt: new Date().toISOString(), stations: shared.stations });
    } catch (e) { /* seed is best-effort */ }
    res.setHeader('Set-Cookie', `${PUB_COOKIE}=${pubSignUid(u.id)}; ${PUB_COOKIE_OPTS}`);
    res.json({ success: true, data: { login: u.login } });
});
pubRouter.post('/login', pubLoginLimiter, async (req, res) => {
    if (!PUB_JWT_SECRET) return res.status(503).json({ success: false, message: 'Public player disabled' });
    const login = String(req.body && req.body.login || '').trim().toLowerCase();
    const password = String(req.body && req.body.password || '');
    const u = pubLoadUsers().users.find((x) => x.login === login);
    if (!u || !(await bcrypt.compare(password, u.hash))) {
        return res.status(401).json({ success: false, message: 'Bad login or password' });
    }
    res.setHeader('Set-Cookie', `${PUB_COOKIE}=${pubSignUid(u.id)}; ${PUB_COOKIE_OPTS}`);
    res.json({ success: true, data: { login: u.login } });
});
pubRouter.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${PUB_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ success: true });
});
pubRouter.get('/me', pubAuth, (req, res) => {
    res.json({ success: true, data: { login: req.pubUser.login } });
});
pubRouter.get('/stations', pubAuth, (req, res) => {
    res.json({ success: true, data: pubLoadStations(req.pubUser.id) });
});
pubRouter.put('/stations', pubAuth, (req, res) => {
    const list = req.body && req.body.stations;
    if (!Array.isArray(list) || list.length > MAX_STATIONS) return res.status(422).json({ success: false, message: 'stations[] required, max 255' });
    const seen = new Set();
    let nextId = 1;
    for (const s of list) {
        const err = pubCheckStation(s);
        if (err) return res.status(422).json({ success: false, message: err });
        if (s.id === undefined || s.id === null) { s.id = nextId; }
        if (!Number.isInteger(s.id) || seen.has(s.id)) return res.status(422).json({ success: false, message: 'bad/duplicate id' });
        seen.add(s.id);
        if (s.id >= nextId) nextId = s.id + 1;
    }
    const doc = pubLoadStations(req.pubUser.id);
    doc.version = (doc.version || 0) + 1;
    doc.stations = list.map((s) => ({ id: s.id, name: s.name.trim(), url: s.url, ...(s.genre ? { genre: s.genre } : {}) }));
    res.json({ success: true, data: pubSaveStations(req.pubUser.id, doc) });
});
pubRouter.post('/stations', pubAuth, (req, res) => {
    const err = pubCheckStation(req.body || {});
    if (err) return res.status(422).json({ success: false, message: err });
    const doc = pubLoadStations(req.pubUser.id);
    if (doc.stations.length >= MAX_STATIONS) return res.status(422).json({ success: false, message: 'station limit reached' });
    if (doc.stations.some((x) => x.url === req.body.url)) return res.status(409).json({ success: false, message: 'duplicate url' });
    const id = doc.stations.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
    doc.stations.push({ id, name: req.body.name.trim(), url: req.body.url, ...(req.body.genre ? { genre: req.body.genre } : {}) });
    doc.version = (doc.version || 0) + 1;
    res.json({ success: true, data: pubSaveStations(req.pubUser.id, doc) });
});
pubRouter.patch('/stations/:id', pubAuth, (req, res) => {
    const doc = pubLoadStations(req.pubUser.id);
    const st = doc.stations.find((x) => String(x.id) === String(req.params.id));
    if (!st) return res.status(404).json({ success: false, message: 'No such station' });
    const upd = {};
    if (req.body.name !== undefined) upd.name = req.body.name;
    if (req.body.url !== undefined) upd.url = req.body.url;
    if (req.body.genre !== undefined) upd.genre = req.body.genre;
    const err = pubCheckStation({ name: upd.name !== undefined ? upd.name : st.name, url: upd.url !== undefined ? upd.url : st.url, genre: upd.genre !== undefined ? upd.genre : st.genre });
    if (err) return res.status(422).json({ success: false, message: err });
    if (upd.url && doc.stations.some((x) => x !== st && x.url === upd.url)) return res.status(409).json({ success: false, message: 'duplicate url' });
    Object.assign(st, upd.name !== undefined ? { name: upd.name.trim() } : {}, upd.url !== undefined ? { url: upd.url } : {}, upd.genre !== undefined ? (upd.genre ? { genre: upd.genre } : { genre: undefined }) : {});
    if ('genre' in st && st.genre === undefined) delete st.genre;
    doc.version = (doc.version || 0) + 1;
    res.json({ success: true, data: pubSaveStations(req.pubUser.id, doc) });
});
pubRouter.delete('/stations/:id', pubAuth, (req, res) => {
    const doc = pubLoadStations(req.pubUser.id);
    const i = doc.stations.findIndex((x) => String(x.id) === String(req.params.id));
    if (i < 0) return res.status(404).json({ success: false, message: 'No such station' });
    if (doc.stations.length <= 1) return res.status(422).json({ success: false, message: 'Cannot delete the last station' });
    doc.stations.splice(i, 1);
    doc.version = (doc.version || 0) + 1;
    res.json({ success: true, data: pubSaveStations(req.pubUser.id, doc) });
});
app.use('/api/pub', pubRouter);

// --- Audio relay for auth-walled streams (e.g. Zeno) ---
// The ESP32 firmware sends bare requests (no Referer/UA) and cannot follow
// tokenized redirects, so Zeno answers it 401. This relay fetches the upstream
// with browser headers, follows the redirect itself and pipes plain audio back.
// Allowlist only: no user-supplied URLs, so it cannot be used as an open proxy.
// Relay allowlist lives in data/relays.json (bind-mounted): {"name": "https://upstream..."}.
// New relays apply immediately — no rebuild needed. Hardcoded map is the fallback.
const RELAYS_FILE = process.env.RELAYS_FILE || 'data/relays.json';
const AUDIO_RELAYS_FALLBACK = {
    oriental: 'https://stream.zeno.fm/73vzetzmswhuv',
};
const loadRelays = () => {
    try {
        const data = JSON.parse(fs.readFileSync(RELAYS_FILE, 'utf8'));
        if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch (err) { /* missing/unreadable -> fallback */ }
    return AUDIO_RELAYS_FALLBACK;
};
const RELAY_UPSTREAM_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,audio/*,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://zeno.fm/',
    'Icy-MetaData': '1',
};
// Plain https/http client (NOT global fetch): Zeno answers fetch-style
// requests 401, but the same headers over https.get get 302 + token.
const fetchUpstreamRaw = (url, timeoutMs) => new Promise((resolve, reject) => {
    const mod = new URL(url).protocol === 'https:' ? https : http;
    const req = mod.get(url, { headers: RELAY_UPSTREAM_HEADERS, timeout: timeoutMs }, resolve);
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
});
const fetchUpstreamFollow = async (url, timeoutMs, maxRedirects = 5) => {
    let current = url;
    for (let i = 0; i <= maxRedirects; i++) {
        const up = await fetchUpstreamRaw(current, timeoutMs);
        if ([301, 302, 303, 307, 308].includes(up.statusCode) && up.headers.location) {
            up.resume(); // discard redirect body
            current = new URL(up.headers.location, current).toString();
            continue;
        }
        return up;
    }
    throw new Error('too many redirects');
};

// Open the upstream with one retry: transient timeouts and the token wall
// (401/403) both deserve a second attempt with a fresh token.
const openUpstream = async (url, timeoutMs, attempts = 2) => {
    let last = null;
    for (let i = 0; i < attempts; i++) {
        try {
            const up = await fetchUpstreamFollow(url, timeoutMs);
            if (up.statusCode !== 401 && up.statusCode !== 403) return up;
            up.resume();
            last = up;
        } catch (err) {
            last = err;
        }
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500));
    }
    if (last && typeof last.statusCode === 'number') return last;
    throw (last || new Error('upstream unavailable'));
};

// --- Browser preview: same-origin audio pipe + metadata probe (admin page) ---
// Browsers block http:// streams on an https:// page (mixed content), so the
// admin preview plays through this same-origin pipe. SSRF guard: only public
// http(s) hosts, no private/loopback/link-local addresses, max 3 redirects.
const PREVIEW_UPSTREAM_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'Accept': 'audio/*,*/*;q=0.9',
    'Accept-Language': 'en-US,en;q=0.9',
    // Deliberately NO Icy-MetaData here: interleaved metadata blocks break
    // browser <audio> decoding (plays ~2 s then loops). Titles come from /probe.
};
const dns = require('dns').promises;
const net = require('net');

const isPublicHttpUrl = async (raw) => {
    let u;
    try {
        u = new URL(raw);
    } catch (e) { return { ok: false, reason: 'bad url' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'only http(s)' };
    if (u.username || u.password) return { ok: false, reason: 'no credentials in url' };
    let addrs;
    try {
        addrs = await dns.lookup(u.hostname, { all: true });
    } catch (e) { return { ok: false, reason: 'dns failed' }; }
    for (const a of addrs) {
        const ip = a.address;
        if (net.isIP(ip) === 4) {
            const p = ip.split('.').map(Number);
            const first = p[0], second = p[1];
            if (first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31) ||
                (first === 192 && second === 168) || (first === 169 && second === 254) ||
                first === 0 || (first === 100 && second >= 64 && second <= 127) ||
                first >= 224) return { ok: false, reason: 'non-public ip' };
        } else {
            // IPv6: block loopback, link-local, unique-local, multicast
            const low = ip.toLowerCase();
            if (low === '::1' || low.startsWith('fe80') || low.startsWith('fec0') ||
                low.startsWith('fc') || low.startsWith('fd') || low.startsWith('ff')) {
                return { ok: false, reason: 'non-public ip' };
            }
        }
    }
    return { ok: true, url: u.toString() };
};

// Open upstream with manual redirect following (max 3). Returns the response
// object positioned at the audio body (redirects already consumed).
const openPreviewUpstream = (url, timeoutMs, wantMeta) => new Promise((resolve, reject) => {
    const headers = { ...PREVIEW_UPSTREAM_HEADERS };
    if (wantMeta) {
        headers['Range'] = 'bytes=0-65535';
        // Probe-only: ask for interleaved StreamTitle blocks. The /preview
        // player path (wantMeta=false) keeps this header OFF on purpose.
        headers['Icy-MetaData'] = '1';
    }
    let current = url;
    let hops = 0;
    const step = () => {
        const mod = new URL(current).protocol === 'https:' ? https : http;
        const req = mod.get(current, { headers, timeout: timeoutMs }, (up) => {
            if ([301, 302, 303, 307, 308].includes(up.statusCode) && up.headers.location && hops < 3) {
                up.resume();
                try {
                    current = new URL(up.headers.location, current).toString();
                } catch (e) { reject(new Error('bad redirect')); return; }
                hops += 1;
                step();
                return;
            }
            resolve({ up, finalUrl: current });
        });
        req.on('timeout', () => req.destroy(new Error('upstream timeout')));
        req.on('error', reject);
    };
    step();
});

// Sniff a live response: de-interleave ICY metadata (if any), capture the
// first StreamTitle and up to 16 KB of clean audio for frame parsing.
const sniffStream = (up, metaint) => new Promise((resolve) => {
    const out = { title: null, audio: Buffer.alloc(0) };
    let audioTotal = 0;
    let state = metaint > 0 ? 'audio' : 'raw';
    let need = metaint;
    let metaNeed = 0;
    let metaBuf = Buffer.alloc(0);
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { up.removeListener('data', onData); } catch (e) { /* noop */ }
        resolve(out);
    };
    const timer = setTimeout(finish, 8000);
    const haveEnough = () => audioTotal >= 8192 && (metaint === 0 || out.title !== null);
    const onData = (chunk) => {
        let off = 0;
        while (off < chunk.length) {
            if (state === 'audio') {
                const take = Math.min(need, chunk.length - off);
                if (out.audio.length < 16384) out.audio = Buffer.concat([out.audio, chunk.slice(off, off + take)]);
                off += take;
                audioTotal += take;
                need -= take;
                if (need === 0) state = 'len';
            } else if (state === 'len') {
                const n = chunk[off] * 16;
                off += 1;
                if (n === 0) { state = 'audio'; need = metaint; }
                else { state = 'meta'; metaNeed = n; metaBuf = Buffer.alloc(0); }
            } else if (state === 'meta') {
                const take = Math.min(metaNeed, chunk.length - off);
                metaBuf = Buffer.concat([metaBuf, chunk.slice(off, off + take)]);
                off += take;
                metaNeed -= take;
                if (metaNeed === 0) {
                    const m = metaBuf.toString('utf8').replace(/\0+$/, '').match(/StreamTitle='([^']*)'/);
                    if (m && m[1]) out.title = m[1];
                    state = 'audio';
                    need = metaint;
                }
            } else {
                if (out.audio.length < 16384) out.audio = Buffer.concat([out.audio, chunk]);
                audioTotal += chunk.length - off;
                off = chunk.length;
            }
        }
        if (haveEnough() || audioTotal >= 131072) finish();
    };
    up.on('data', onData);
    up.on('error', finish);
    up.on('end', finish);
});

// Parse the first MP3 or ADTS/AAC frame header: real sample rate + channels.
const parseAudioFrame = (buf) => {
    const SFR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const MP3SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
    for (let i = 0; i + 4 < buf.length; i++) {
        if (buf[i] !== 0xFF || (buf[i + 1] & 0xE0) !== 0xE0) continue;
        const b1 = buf[i + 1];
        if ((b1 & 0xF0) === 0xF0 && (b1 & 0x06) === 0 && i + 7 < buf.length) {
            const sfi = (buf[i + 2] & 0x3C) >> 2;
            const ch = ((buf[i + 2] & 0x01) << 2) | ((buf[i + 3] & 0xC0) >> 6);
            if (sfi <= 12 && ch >= 1 && ch <= 7) {
                const prof = (buf[i + 2] & 0xC0) >> 6;
                return { container: 'ADTS', codec: prof === 1 ? 'AAC-LC' : 'AAC', sampleRate: SFR[sfi], channels: ch };
            }
        }
        const ver = (b1 & 0x18) >> 3;
        const layer = (b1 & 0x06) >> 1;
        if (ver !== 1 && layer !== 0 && MP3SR[ver]) {
            const srIdx = (buf[i + 2] & 0x0C) >> 2;
            if (srIdx <= 2) {
                const mode = (buf[i + 3] & 0xC0) >> 6;
                return { container: 'MP3', codec: 'MP3', sampleRate: MP3SR[ver][srIdx], channels: mode === 3 ? 1 : 2 };
            }
        }
    }
    return null;
};

const previewAuth = (req, res, next) => {
    const token = req.headers['x-auth-token'] || req.query.token;
    if (token && token === SECRET_TOKEN) return next();
    return res.status(401).json({ success: false, message: 'Unauthorized: Invalid or missing token' });
};

// Geolocation of the stream server IP (powers the cover globe map).
// Cache per hostname, 24 h. Unknown (private IP, DNS/geo fail) -> {unknown:true}.
const geoCache = new Map();
const GEO_TTL = 24 * 3600 * 1000;
const lookupGeo = (ip) => new Promise((resolve) => {
    const q = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,city,lat,lon,query`;
    http.get(q, { timeout: 8000 }, (up) => {
        let body = '';
        up.on('data', (c) => { body += c; });
        up.on('end', () => {
            try {
                const j = JSON.parse(body);
                if (j.status === 'success' && typeof j.lat === 'number' && typeof j.lon === 'number') {
                    return resolve({ ip: j.query || ip, country: j.country || null, countryCode: j.countryCode || null, city: j.city || null, lat: j.lat, lon: j.lon });
                }
                resolve({ unknown: true, reason: j.message || 'geo failed' });
            } catch (e) { resolve({ unknown: true, reason: 'bad geo response' }); }
        });
    }).on('timeout', function () { this.destroy(new Error('geo timeout')); })
      .on('error', () => resolve({ unknown: true, reason: 'geo unreachable' }));
});
apiRouter.get('/geo', async (req, res) => {
    const gate = await isPublicHttpUrl(req.query.url || '');
    if (!gate.ok) return res.status(422).json({ success: false, message: gate.reason });
    let host;
    try { host = new URL(gate.url).hostname.toLowerCase(); }
    catch (e) { return res.status(422).json({ success: false, message: 'bad url' }); }
    const hit = geoCache.get(host);
    if (hit && Date.now() - hit.ts < GEO_TTL) return res.json({ success: true, data: hit.data, cached: true });
    try {
        const addrs = await dns.lookup(host, { all: true });
        const v4 = addrs.find((a) => a.family === 4);
        const ip = (v4 && v4.address) || (addrs[0] && addrs[0].address);
        if (!ip) return res.json({ success: true, data: { unknown: true, reason: 'dns failed' } });
        const g = await lookupGeo(ip);
        const data = g.unknown ? { unknown: true, reason: g.reason, ip } : g;
        geoCache.set(host, { ts: Date.now(), data });
        return res.json({ success: true, data });
    } catch (e) { return res.json({ success: true, data: { unknown: true, reason: 'dns failed' } }); }
});

// Metadata probe: headers + codec guess + first StreamTitle + measured kbps.
apiRouter.get('/probe', async (req, res) => {
    const gate = await isPublicHttpUrl(req.query.url || '');
    if (!gate.ok) return res.status(422).json({ success: false, message: gate.reason });
    const t0 = Date.now();
    let up = null;
    try {
        ({ up } = await openPreviewUpstream(gate.url, 10000, true));
        if (up.statusCode !== 200 && up.statusCode !== 206) {
            const code = up.statusCode;
            up.resume();
            return res.status(502).json({ success: false, message: 'upstream ' + code });
        }
        const h = up.headers || {};
        const ct = String(h['content-type'] || '');
        let codec = null;
        if (/mpeg|mp3/i.test(ct)) codec = 'MP3';
        else if (/aac|mp4/i.test(ct)) codec = 'AAC';
        else if (/ogg|opus/i.test(ct)) codec = 'Ogg';
        else if (/flac/i.test(ct)) codec = 'FLAC';
        else if (/wav/i.test(ct)) codec = 'WAV';
        const metaint = parseInt(h['icy-metaint'], 10);
        const sniffed = await sniffStream(up, Number.isNaN(metaint) ? 0 : metaint);
        const title = sniffed.title;
        const fmt = parseAudioFrame(sniffed.audio);
        const ms = Math.max(Date.now() - t0, 1);
        const sockBytes = (up.socket && up.socket.bytesRead) || 0;
        const kbps = Math.round(sockBytes * 8 / ms * 10) / 10;
        const out = {
            success: true,
            data: {
                url: gate.url,
                httpStatus: up.statusCode,
                contentType: ct || null,
                codec,
                measuredKbps: kbps || null,
                sampleRate: fmt ? fmt.sampleRate : null,
                channels: fmt ? fmt.channels : null,
                icyUrl: h['icy-url'] || null,
                icyName: h['icy-name'] || null,
                icyGenre: h['icy-genre'] || null,
                icyBr: h['icy-br'] ? parseInt(h['icy-br'], 10) || null : null,
                icyDescription: h['icy-description'] || null,
                streamTitle: title || null,
            },
        };
        try { up.destroy(); } catch (e) { /* noop */ }
        res.json(out);
    } catch (err) {
        try { up && up.destroy(); } catch (e) { /* noop */ }
        res.status(502).json({ success: false, message: String(err.message || err) });
    }
});

// Same-origin audio pipe for browser preview (query-token auth: <audio> can't set headers).
apiRouter.get('/preview', previewAuth, async (req, res) => {
    const gate = await isPublicHttpUrl(req.query.url || '');
    if (!gate.ok) return res.status(422).json({ success: false, message: gate.reason });
    let up = null;
    try {
        ({ up } = await openPreviewUpstream(gate.url, 10000, false));
        if (up.statusCode !== 200) {
            const code = up.statusCode;
            up.resume();
            return res.status(502).type('text/plain').send('upstream unavailable');
        }
        res.status(200);
        res.set('Content-Type', up.headers['content-type'] || 'audio/mpeg');
        for (const [k, v] of Object.entries(up.headers)) {
            if (k.startsWith('icy-') && k !== 'icy-metaint') res.set(k, v);
        }
        res.set('Accept-Ranges', 'none');
        res.set('Cache-Control', 'no-store');
        // Same stall watchdog as the audio relay: re-open upstream with a
        // fresh token on the SAME response (up to 3 resumes), then fail fast.
        let cur = up;
        let resumes = 0;
        let alive = true;
        let resuming = false;
        let lastData = Date.now();
        const detach = () => {
            try { cur.unpipe(res); cur.removeAllListeners(); cur.destroy(); } catch (e) { /* noop */ }
        };
        const finish = () => {
            alive = false;
            resuming = false;
            clearInterval(watch);
            detach();
            try { res.end(); } catch (e) { /* noop */ }
        };
        const attach = () => {
            resuming = false;
            cur.on('data', () => { lastData = Date.now(); });
            cur.on('error', () => { if (alive) resumeOrEnd(); });
            cur.on('end', () => { if (alive) resumeOrEnd(); });
            cur.pipe(res, { end: false });
        };
        const resumeOrEnd = async () => {
            if (!alive || resuming) return;
            resuming = true;
            if (resumes >= 3) {
                console.error(`Preview [${gate.url.slice(0, 60)}]: still stalled, giving up`);
                finish();
                return;
            }
            resumes += 1;
            console.error(`Preview [${gate.url.slice(0, 60)}]: stall detected, resume #${resumes}`);
            detach();
            try {
                const r = await openPreviewUpstream(gate.url, 10000, false);
                if (!alive) { try { r.up.resume(); } catch (e) { /* noop */ } return; }
                if (r.up.statusCode !== 200) {
                    try { r.up.resume(); } catch (e) { /* noop */ }
                    finish();
                    return;
                }
                cur = r.up;
                lastData = Date.now();
                attach();
            } catch (err) {
                console.error(`Preview resume failed: ${err.message}`);
                finish();
            }
        };
        req.on('close', () => {
            alive = false;
            clearInterval(watch);
            detach();
        });
        const watch = setInterval(() => {
            if (!alive) { clearInterval(watch); return; }
            if (Date.now() - lastData > 10000) resumeOrEnd();
        }, 5000);
        attach();
    } catch (err) {
        console.error('Preview failed:', err.message);
        try { up && up.destroy(); } catch (e) { /* noop */ }
        if (!res.headersSent) {
            res.status(502).type('text/plain').send('preview failed');
        } else {
            try { res.end(); } catch (e) { /* noop */ }
        }
    }
});

app.get('/audio/:name', async (req, res) => {
    const upstream = loadRelays()[req.params.name];
    if (typeof upstream !== 'string' || !/^https?:\/\/.+/.test(upstream)) {
        return res.status(404).type('text/plain').send('unknown relay');
    }
    try {
        const up = await openUpstream(upstream, 8000, 2);
        if (up.statusCode !== 200) {
            console.error(`Audio relay [${req.params.name}]: upstream ${up.statusCode}`);
            up.resume();
            return res.status(502).type('text/plain').send('upstream unavailable');
        }
        res.status(200);
        res.set('Content-Type', up.headers['content-type'] || 'audio/mpeg');
        for (const [k, v] of Object.entries(up.headers)) {
            if (k.startsWith('icy-')) res.set(k, v);
        }
        res.set('Accept-Ranges', 'none');
        // Resilient piping: Zeno sometimes stalls mid-stream (no bytes, no
        // error, no close). Watchdog re-opens the upstream with a fresh token
        // on the SAME client response (up to 3 resumes); then ends the
        // response so the client fails fast instead of hanging forever.
        let cur = up;
        let resumes = 0;
        let alive = true;
        let resuming = false;
        let lastData = Date.now();
        const detach = () => {
            try { cur.unpipe(res); cur.removeAllListeners(); cur.destroy(); } catch (e) { /* noop */ }
        };
        const finish = () => {
            alive = false;
            resuming = false;
            clearInterval(watch);
            detach();
            try { res.end(); } catch (e) { /* noop */ }
        };
        const attach = () => {
            resuming = false;
            cur.on('data', () => { lastData = Date.now(); });
            cur.on('error', () => { if (alive) resumeOrEnd(); });
            cur.on('end', () => { if (alive) resumeOrEnd(); });
            cur.pipe(res, { end: false });
        };
        const resumeOrEnd = async () => {
            if (!alive || resuming) return;
            resuming = true;
            if (resumes >= 3) {
                console.error(`Audio relay [${req.params.name}]: still stalled, giving up`);
                finish();
                return;
            }
            resumes += 1;
            console.error(`Audio relay [${req.params.name}]: stall detected, resume #${resumes}`);
            detach();
            try {
                const r = await openUpstream(upstream, 8000, 2);
                if (!alive) { try { r.resume(); } catch (e) { /* noop */ } return; }
                if (r.statusCode !== 200) {
                    console.error(`Audio relay [${req.params.name}]: resume got upstream ${r.statusCode}`);
                    try { r.resume(); } catch (e) { /* noop */ }
                    finish();
                    return;
                }
                cur = r;
                lastData = Date.now();
                attach();
            } catch (err) {
                console.error(`Audio relay [${req.params.name}]: resume failed: ${err.message}`);
                finish();
            }
        };
        req.on('close', () => {
            alive = false;
            clearInterval(watch);
            detach();
        });
        const watch = setInterval(() => {
            if (!alive) { clearInterval(watch); return; }
            if (Date.now() - lastData > 10000) resumeOrEnd();
        }, 5000);
        attach();
    } catch (err) {
        console.error(`Audio relay [${req.params.name}] failed:`, err.message);
        if (!res.headersSent) {
            res.status(502).type('text/plain').send('relay failed');
        } else {
            try { res.end(); } catch (e) { /* noop */ }
        }
    }
});

// --- OpenAPI spec (API discovery for AI agents and tools) ---
apiRouter.get('/openapi.json', (req, res) => {
    res.json(require('./openapi.json'));
});

// --- Agent guide (human/agent-readable manual) ---
apiRouter.get('/guide', (req, res) => {
    res.type('text/markdown').send(fs.readFileSync('AGENT_GUIDE.md', 'utf8'));
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
loadStats();
loadAlarm();
server.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);
    console.log(`Access the web interface at: http://YOUR_SERVER_IP:${port}`);
    console.log(`WebSocket endpoint is protected and requires a token.`);
});