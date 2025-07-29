[Читать на русском](README.ru.md)

# WebRadio: A DIY IoT Internet Radio Project

This repository contains the complete project for a DIY Internet Radio system, built around an ESP32 microcontroller and controlled by a dedicated Android application via MQTT.

## Project Components

The project is divided into two main parts:

### 1. ESP32 Firmware (`/WebRadio_STM32_S3`)

This is the core of the radio player, running on an ESP32. It is responsible for connecting to the internet, streaming radio stations, and receiving commands.

**Features:**

- Plays internet radio streams from URLs.
- Controlled remotely via the MQTT protocol.
- Physical controls using a rotary encoder with a button (thanks to the `EncButton` library).
- (Likely) Integration with a Telegram bot for additional control and status updates (inferred from the `FastBot` library).

For detailed instructions on building the hardware, configuring, and flashing the firmware, please see the **firmware's subdirectory**. A dedicated README for it should be created.

### 2. Android Remote Control (`/WebRadio_android`)

A native Android application that serves as a user-friendly remote control for the radio.

**Features:**

- Connects to the MQTT broker to send commands and receive status updates in real-time.
- Select from a list of preset radio stations.
- Control power, volume, and channels.
- Set and manage alarms.
- Switch between controlling different radio devices.

For setup, configuration, and build instructions, please refer to the **Android app's README**.

## System Architecture

The components communicate over a local network using the lightweight MQTT messaging protocol. A central MQTT broker is required to relay messages between the Android app and the ESP32 radio.

```
+------------------+           +----------------+           +-----------------+
|                  |           |                |           |                 |
|  Android Remote  | <-------> |  MQTT Broker   | <-------> |   ESP32 Radio   |
|      (App)       |           |(e.g., Mosquitto)|           |    (Device)     |
|                  |           |                |           |                 |
+------------------+           +----------------+           +-----------------+
```

- The **Android App** publishes commands (e.g., change station, volume up) to specific MQTT topics.
- The **ESP32 Radio** subscribes to these topics, listens for commands, and executes them.
- The **ESP32 Radio** also publishes its status (e.g., current station, song title, volume) to other topics.
- The **Android App** subscribes to the status topics to display real-time information.

## Getting Started

To get the entire system up and running, you will need to:

1.  **Set up an MQTT Broker**: Install and run an MQTT broker like Mosquitto on a device in your local network (e.g., a Raspberry Pi or your computer).
2.  **Build and Flash the Firmware**:
    - Navigate to the `WebRadio_STM32_S3` directory.
    - Configure your Wi-Fi and MQTT broker credentials in the source code.
    - Build and upload the firmware to your ESP32 device.
3.  **Build and Install the Android App**:
    - Open the `WebRadio_android` project in Android Studio.
    - Create the `Secrets.kt` file and add your MQTT broker credentials.
    - Build the project and install the APK on your Android device.

Once all components are configured and running, the app should be able to connect to the broker and control the radio.
