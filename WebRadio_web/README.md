[Читать на русском](README.ru.md)

# WebRadio Web Interface

This is a web-based remote control for the ESP32 WebRadio project. It provides a user-friendly interface to control the radio from any device with a web browser.

## Features

- **Real-time Status Display**: Shows the current station, song title, volume level, and connection status.
- **Playback Control**: Control power, volume, and select preset radio stations.
- **Alarm Management**: Set and cancel alarms.
- **Central Station Manager**: A single `stations.json` list edited on this site is pushed to both radios (ESP32) and the Android app over MQTT. No more hardcoded lists in each client.
- **Responsive Design**: The interface is designed to work well on both desktop and mobile browsers.

## Technology Stack

- **Frontend**: HTML, CSS, JavaScript (no frameworks)
- **Backend**: Node.js with Express.js
- **Real-time Communication**: WebSocket (with a bridge to MQTT)
- **Deployment**: Docker, Docker Compose, Traefik (recommended)

## Installation and Running (Docker)

The project is designed to be run in a Docker container, which greatly simplifies deployment and enhances security.

### Prerequisites
- Docker
- Docker Compose

### Steps to Run

1.  **Clone the repository** to your server.

2.  **Create the configuration file** `.env` from the example:
    ```bash
    cp .env.example .env
    ```

3.  **Configure the variables in `.env`**:
    Open the `.env` file and set your values.
    ```dotenv
    # A secret token to access the WebSocket and API. Should be a long, complex, random string.
    SECRET_TOKEN=your_super_secret_token

    # The URL of your MQTT broker.
    # If the broker is running on the same host as Docker, use host.docker.internal
    MQTT_BROKER_URL=mqtt://host.docker.internal:1883

    # Credentials for your MQTT connection (if required)
    MQTT_USER=your_mqtt_username
    MQTT_PASSWORD=your_mqtt_password
    ```

4.  **Build and run the container**:
    Execute this command from the project's root folder:
    ```bash
    sudo docker compose up -d --build
    ```
    The application will be available at the address you configured in your reverse proxy (e.g., Traefik).

## First Use and Authentication

On your first visit to the site, the browser will prompt you for a secret token.

1. Copy the value of `SECRET_TOKEN` from your `.env` file.
2. Paste it into the prompt that appears in the browser.

The browser will save the token for future sessions.

## Station Manager

The station list is the single source of truth for all radio clients. It lives in `data/stations.json` (versioned, atomic writes) and is served at `GET /api/radio/stations`. On save, the server publishes the list to `Home/WebRadio1/Stations` and `Home/WebRadio2/Stations`; the ESP32 firmware and Android app apply it immediately. The web UI fetches it on load and updates live over WebSocket.

To edit stations:

1. Open `/admin.html` (e.g. `https://your-domain.com/webradio/admin.html`).
2. Add, remove, reorder stations; edit name / URL / genre. Array order == channel number (`c<N>` commands).
3. Press **Save** — the list is validated, persisted, and pushed to all devices.

The station list also ships with a `GET /api/radio/stations` (auth required) used by the Python `fetch_stations.py` utility. In Docker, `data/` must be mounted as a volume (see `docker-compose.yml`) or saved changes are lost on rebuild.

## Security

The following security measures have been implemented in this project:

- **Authentication**: All API and WebSocket endpoints are protected by a secret token.
- **Container Isolation**: The application runs inside a Docker container as a non-root user (`node`) for improved security.
- **Security Headers**: The `helmet` library is used to set standard security-related HTTP headers, helping to protect against common attacks like XSS and clickjacking.