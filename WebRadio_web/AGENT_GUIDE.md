# WebRadio — Agent Guide

Manual for AI agents and automation tools interacting with the ESP32 WebRadio
system through its web app and REST API.

## 1. What this system is

A DIY internet radio. The **web app** is the control plane:

- **Web UI** — human control page and the Station Manager (`admin.html`).
- **REST API** — machine interface (this guide + OpenAPI spec).
- **MQTT broker** (`31.59.120.209:1883`) — relays commands/status between the
  web server, the ESP32 radios, and the Android app.

Devices: `WebRadio1` (Chelyabinsk) and `WebRadio2` (Kusa). The web app's live
control commands target **WebRadio2**; the **station list** is pushed to both.

## 2. Access

| Item | Value |
|---|---|
| Base URL | `https://dip17.freemyip.com:8443/webradio` (replace with your deployment) |
| Auth | header `X-Auth-Token: <SECRET_TOKEN>` (or `Authorization: Bearer <token>`) |
| OpenAPI spec | `GET {base}/api/radio/openapi.json` |
| This guide | `GET {base}/api/radio/guide` |

The token is the `SECRET_TOKEN` from the server's `.env`; the operator provides
it. All endpoints return `401` without it. API rate limit: 100 requests /
15 min per IP.

## 3. Core concepts

### Station list

- Single source of truth: `data/stations.json` on the server (persistent
  Docker volume).
- **Array order == channel number** (1-based) used by `c<N>` commands and
  shown on all clients.
- Every station has a stable integer **`id`** (server-assigned, never changes).
  Address stations by id for update/delete/reorder.
- `version` increments on **every** write; `updatedAt` is the last-write time.
- Every successful write is atomic, persisted, and published to
  `Home/WebRadio1/Stations` + `Home/WebRadio2/Stations` — connected ESP32s and
  the Android app apply it immediately.

Station shape: `{ "id": 1, "name": "Silver Rain", "url": "http://…", "genre": "radio" }`
Constraints: `name` ≤ 60 chars; `url` must start `http://`/`https://` and ≤ 200
chars; `genre` ≤ 30 chars; urls unique; max 255 stations.

### Radio status

`GET /api/radio/status` returns the **last known** MQTT status topics:

| Key | Meaning |
|---|---|
| `State` | `Power ON` / `Power OFF` / `ON SLEEP` |
| `Station` | `"<channel> <name>"` e.g. `"11 Relax Web Radio"` |
| `Title` | current track |
| `Volume` | integer 0–21 |
| `Alarm` | seconds-from-midnight or `"Alarm OFF"` |
| `Log` | stream info / messages |
| `FreeHeap` | free RAM |

The snapshot is stale until the device publishes. For fresh data: `POST
/command` with `{"command": "?"}` (device answers with a full status dump),
wait ~1 s, then `GET /status`.

## 4. Common agent workflows

All examples use `BASE=https://…/webradio/api/radio` and `TOKEN=…`.

### Read the list and find a station by name

```bash
curl -s -H "X-Auth-Token: $TOKEN" $BASE/stations | jq '.data.stations[] | select(.name | contains("LoFi"))'
```
Remember the `id` and `version`.

### Add a station

```bash
curl -X POST -H "X-Auth-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"My Station","url":"http://stream.example/radio.mp3","genre":"relax"}' \
  $BASE/stations
```
Server assigns the id; response contains the whole new list.

### Rename / change URL / genre

```bash
curl -X PATCH -H "X-Auth-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"My Station 2"}' $BASE/stations/42
```

### Delete a station

```bash
curl -X DELETE -H "X-Auth-Token: $TOKEN" $BASE/stations/42
```
The last station cannot be deleted (422). Unknown id → 404.

### Reorder (move station X to position N)

```bash
# 1) read current ids
curl -s -H "X-Auth-Token: $TOKEN" $BASE/stations | jq '[.data.stations[].id]'
# 2) build the full id sequence with X first, e.g. [42, 1, 2, 3, …]
curl -X POST -H "X-Auth-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"ids":[42,1,2,3]}' $BASE/stations/order
```
`ids` must be a permutation of **all** current ids (else 422). The new order
becomes the channel numbering.

### Version-safe full replace (read-modify-write)

```bash
# read -> modify -> write with expectedVersion
curl -X PUT -H "X-Auth-Token: $TOKEN" -H "Content-Type: application/json" \
  -d "{\"expectedVersion\":$VERSION,\"stations\":$STATIONS}" $BASE/stations
```
`409` means the list changed since you read it: re-GET and retry. This prevents
silently clobbering a concurrent edit.

### Radio control

```bash
# power
curl -X POST -H "X-Auth-Token: $TOKEN" -H "Content-Type: application/json" -d '{"state":"on"}'  $BASE/power
# switch to channel 5 (turns power on)
curl -X POST -H "X-Auth-Token: $TOKEN" -H "Content-Type: application/json" -d '{"station":5}' $BASE/station
# set volume to 10 (absolute)
curl -X POST -H "X-Auth-Token: $TOKEN" -H "Content-Type: application/json" -d '{"volume":10}' $BASE/volume
# set alarm 06:30
curl -X POST -H "X-Auth-Token: $TOKEN" -H "Content-Type: application/json" -d '{"time":"06:30"}' $BASE/alarm
# cancel alarm
curl -X POST -H "X-Auth-Token: $TOKEN" -H "Content-Type: application/json" -d '{"seconds":0}' $BASE/alarm
# fresh status
curl -X POST -H "X-Auth-Token: $TOKEN" -H "Content-Type: application/json" -d '{"command":"?"}' $BASE/command
```

## 5. Endpoint reference

All under `{base}/api/radio`, all require auth.

| Method | Path | Body | Response / notes |
|---|---|---|---|
| GET | `/stations` | — | `{success, data: {version, updatedAt, stations[]}}` |
| PUT | `/stations` | `{expectedVersion?, stations[]}` | full replace; `409` version conflict; `422` validation |
| POST | `/stations` | `{name, url, genre?}` | append; assigns id |
| PATCH | `/stations/{id}` | any of `{name?, url?, genre?}` | partial update; `404` unknown id |
| DELETE | `/stations/{id}` | — | remove; `422` if last station |
| POST | `/stations/order` | `{ids[]}` | reorder; must be a permutation |
| GET | `/status` | — | last known device status |
| POST | `/station` | `{station}` | `c<N>` (power on + switch) |
| POST | `/volume` | `{volume}` | absolute 0–21; `503` if current unknown |
| POST | `/power` | `{state: on\|off}` | `1`/`0` |
| POST | `/alarm` | exactly one of `{seconds}` or `{time:"HH:MM"}` | `0`/`00:00` cancels |
| POST | `/command` | `{command}` | raw device payload passthrough |
| GET | `/openapi.json` | — | OpenAPI 3 spec |
| GET | `/guide` | — | this document (text/markdown) |

## 6. Gotchas and rules

1. **Volume needs a known current level.** `/volume` computes `vol+`/`vol-`
   deltas (the firmware has no absolute set). If the server has no recent
   `Volume` (e.g. right after a server restart) it returns `503` — publish
   `{"command":"?"}` first, then retry.
2. **Alarm `0` means OFF.** Never send `s0` via raw `/command` expecting
   "off" — the device interprets it as a 00:00 alarm. Use the `/alarm`
   endpoint (it maps 0 → `sAlarm OFF`) or raw `sAlarm OFF`.
3. **`/command` raw payloads** (firmware protocol): `?` status, `1`/`0` power,
   `b1`–`b4` buttons (power/sleep/ch+/ch-), `vol+`/`vol-`, `c<N>` channel,
   `h<url>` play arbitrary url, `s<seconds>` alarm, `sAlarm OFF`. Unknown
   payloads are ignored by the device.
4. **Control commands target WebRadio2 only.** Station-list writes reach both
   radios; live control (power/volume/station/alarm/command) publishes to
   `Home/WebRadio2/Action`.
5. **Channel numbers are positional.** After reordering, `c<N>` refers to the
   new order on every client. Station *buttons* in the Android app send URLs
   (`h<url>`), so they keep working regardless of order.
6. **Ids are stable; positions are not.** Prefer id-based operations; treat the
   array order as mutable channel numbering.
7. **ESP32 firmware versions.** Radios flashed with the new firmware apply the
   pushed list live; older firmware ignores the `Stations` topic harmlessly
   (it keeps its compiled fallback list).
8. **Concurrent edits.** Always pass `expectedVersion` on full-replace PUTs;
   handle `409` by re-reading.
9. **Status is "last known".** For authoritative state, request `?` and wait
   ~1 s before reading `/status`.

## 7. Optional: MQTT-level access

Advanced agents can talk to the broker directly instead of the HTTP API.

- Broker: `31.59.120.209:1883` (TCP). Credentials are the operator's
  `MQTT_LOGIN` / `MQTT_PASSWORD` (also in `WebRadio_android/…/Secrets.kt`).
- Commands: publish to `Home/WebRadio2/Action` (same payloads as `/command`).
- Status: subscribe `Home/WebRadio2/#` (`State`, `Station`, `Title`,
  `Volume`, `Alarm`, `Log`, `FreeHeap`).
- Station list: subscribe `Home/{WebRadio1|WebRadio2}/Stations`; request a
  fresh copy by publishing `list?` to the device's `Action` topic (the web
  server answers with the current list JSON).

Prefer the HTTP API unless you specifically need push events — it handles
validation, versioning, persistence, and id management for you.
