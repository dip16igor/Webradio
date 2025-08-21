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

4.  **Access the Web Interface**:
    Open your web browser and navigate to `http://<your_server_ip>:3000/<your_secret_token>` to access the web interface.
