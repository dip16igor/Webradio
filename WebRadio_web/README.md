[Читать на русском](README.ru.md)

# WebRadio Web Interface

This is a web-based remote control for the ESP32 WebRadio project. It provides a user-friendly interface to control the radio from any device with a web browser.

## Features

- **Real-time Status Display**: Shows the current station, song title, volume level, and connection status.
- **Playback Control**: Control power, volume, and select preset radio stations.
- **Alarm Management**: Set and cancel alarms.
- **Responsive Design**: The interface is designed to work well on both desktop and mobile browsers.

## Technology Stack

- **Frontend**: HTML, CSS, JavaScript (no frameworks)
- **Backend**: Node.js with Express.js
- **Real-time Communication**: MQTT (via a Node.js MQTT bridge)

## Setup and Configuration

1.  **Install Dependencies**:
    Navigate to the `WebRadio_web` directory and install the required Node.js packages:
    ```bash
    npm install
    ```

2.  **Configure Environment Variables**:
    Create a `.env` file in the `WebRadio_web` directory by copying the `.env.example` file. Then, edit the `.env` file to include your MQTT broker's URL, username, password, and a secret token for the web server.

    ```
    SECRET_TOKEN=your_secret_token
    MQTT_BROKER_URL=mqtt://your_broker_ip:1883
    MQTT_USER=your_mqtt_username
    MQTT_PASSWORD=your_mqtt_password
    ```

3.  **Start the Server**:
    Run the following command to start the web server:
    ```bash
    node server.js
    ```

## Deployment (Linux VPS with systemd)

To run the web interface as a persistent service on a Linux VPS, you can use the provided `webradio-web.service` file.

1.  **Copy the service file** to the systemd directory on your VPS:
    ```bash
    sudo cp webradio-web.service /etc/systemd/system/
    ```

2.  **Edit the service file** to match your project's path and user. You may need to change the `User`, `Group`, and `WorkingDirectory` directives.

3.  **Reload the systemd daemon** to recognize the new service:
    ```bash
    sudo systemctl daemon-reload
    ```

4.  **Start the service**:
    ```bash
    sudo systemctl start webradio-web
    ```

5.  **Enable the service to start on boot**:
    ```bash
    sudo systemctl enable webradio-web
    ```

6.  **Check the status of the service**:
    ```bash
    sudo systemctl status webradio-web
    ```
