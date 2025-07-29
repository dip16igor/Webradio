[Читать на русском](README.ru.md)

# WebRadio Android Remote

This is an Android application that serves as a remote control for a custom-built ESP32-based internet radio. It uses the MQTT protocol to communicate with the hardware device, allowing users to control playback, manage stations, and set alarms.

## Features

- **Remote Control**: Control basic functions like Power, Volume Up/Down, Channel Up/Down, and Sleep Timer.
- **Station Presets**: Select from a predefined list of favorite radio stations.
- **Alarm Management**: Set and disable alarms directly from the app.
- **Multi-Device Support**: Switch control between two different radio devices (e.g., "Kusa" and "Chelyabinsk").
- **Real-time Status**: The UI displays the current station, song title, volume level, and MQTT connection status.
- **Persistent Settings**: The app remembers the last selected radio device using Jetpack DataStore.

## Screenshots

_(Add screenshots of the application UI here)_

## Technology Stack

- **Language**: [Kotlin](https://kotlinlang.org/)
- **UI**: [Jetpack Compose](https://developer.android.com/jetpack/compose)
- **Asynchronous Programming**: [Kotlin Coroutines & Flow](https://developer.android.com/kotlin/coroutines)
- **Networking**: [Paho MQTT Client for Android](https://www.eclipse.org/paho/index.php?page=clients/android/index.php)
- **Data Persistence**: [Jetpack DataStore](https://developer.android.com/topic/libraries/architecture/datastore)
- **Architecture**: A simple, state-driven architecture within a single Activity.

## Setup and Configuration

1.  **Clone the repository**:

    ```bash
    git clone <repository-url>
    ```

2.  **Configure Credentials**:
    The project uses a `Secrets.kt` file to store MQTT credentials, which is excluded from version control. You need to create this file yourself.

    Create a new file at `app/src/main/java/com/dip16/webradio/Secrets.kt` with the following content:

    ```kotlin
    package com.dip16.webradio

    /**
     * This file contains the secret credentials for the application.
     * It should be added to .gitignore to prevent committing secrets.
     */
    object Secrets {
        const val MQTT_BROKER_URL = "tcp://YOUR_BROKER_IP:1883"
        const val MQTT_LOGIN = "YOUR_MQTT_LOGIN"
        const val MQTT_PASSWORD = "YOUR_MQTT_PASSWORD"
    }
    ```

    Replace the placeholder values with your actual MQTT broker details.

3.  **Build the Project**:
    Open the project in Android Studio and run the build.

## MQTT Protocol

The application communicates with a hardware device identified by `radioName` (e.g., "WebRadio1" or "WebRadio2").

### Topics Published by the App (App -> Device)

- **Topic**: `Home/{radioName}/Action`
- **Payloads**:
  - `?`: Request the current status from the device.
  - `b1`: Toggle power.
  - `b2`: Activate sleep timer.
  - `b3`: Next channel.
  - `b4`: Previous channel.
  - `vol+`: Increase volume.
  - `vol-`: Decrease volume.
  - `s<seconds>`: Set an alarm. The payload is the total seconds from midnight (e.g., `s19800` for 5:30 AM).
  - `sAlarm OFF`: Disable the alarm.
  - `<station_url>`: Play a specific station by its URL (e.g., `http://silverrain.hostingradio.ru/silver128.mp3`).

### Topics Subscribed to by the App (Device -> App)

The app subscribes to several topics to receive real-time status updates from the device.

- `Home/{radioName}/State`: The current power state (e.g., "Power ON", "Power OFF").
- `Home/{radioName}/Station`: The name of the currently playing station.
- `Home/{radioName}/Title`: The title of the currently playing track.
- `Home/{radioName}/Volume`: The current volume level.
- `Home/{radioName}/Alarm`: The current alarm setting (in seconds from midnight or the string "Alarm OFF").
- `Home/{radioName}/Log`: General log messages from the device for debugging.

## How to Build

You can build the project directly from Android Studio or use the Gradle wrapper from the command line:

```bash
# Build a debug APK
./gradlew assembleDebug

# Build a release APK
./gradlew assembleRelease
```

The generated APKs will be located in `app/build/outputs/apk/`.

---

_This README was generated based on the project's source code._
