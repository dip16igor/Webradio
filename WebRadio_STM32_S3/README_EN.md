[Русская версия](README.md)

# ESP32 Wrover Web Radio

A multifunctional internet radio player based on the ESP32 Wrover module. The project allows you to listen to streaming audio from the internet, display information on an OLED screen, and control it using physical buttons, the MQTT protocol, and a Telegram bot.

## Features

- **Streaming Audio:** Plays internet radio stations from a predefined list.
- **High-Quality Sound:** Audio output via I2S to an external DAC (e.g., MAX98357A or PCM5102).
- **Informative Display:** A 128x64 SSD1306 OLED display shows status information:
  - Station number and name
  - Current track name (Stream Title)
  - Time (synchronized via NTP)
  - Volume level
  - WiFi signal strength (RSSI)
  - Power and sleep mode status
- **Flexible Control:**
  - **Physical Buttons:** Control power, sleep mode, and station switching.
  - **MQTT:** Full remote control and status monitoring.
  - **Telegram Bot:** Basic commands, status retrieval, and over-the-air (OTA) firmware updates.
- **Automation:**
  - **Alarms:** Set times for automatic power on and off.
  - **Sleep Timer:** Gradually decreases volume before shutting down.
- **Reliability:**
  - Automatic reconnection to WiFi and the audio stream if the connection is lost.
  - Alarm settings are saved in non-volatile memory (EEPROM).
- **Configuration:** Supports two hardware configurations via the `ESP_WROVER` macro.

## Hardware Components

- ESP32 Wrover module.
- I2S DAC (e.g., MAX98357A, PCM5102).
- I2C 128x64 OLED display with an SSD1306 controller.
- Tactile buttons (at least 4).
- Optional: A relay to control an external amplifier, FM transmitter.

### Pinout

| ESP32 Pin | Purpose           |
| :-------- | :---------------- |
| `25`      | I2S DOUT (DIN)    |
| `27`      | I2S BCLK          |
| `26`      | I2S LRC           |
| `19`      | Button POWER      |
| `15`      | Button SLEEP      |
| `18`      | Button CH+ (UP)   |
| `4`       | Button CH- (DOWN) |
| `2`       | LED (blue)        |
| `32`      | Relay 1           |
| `33`      | Relay 2           |
| `23`      | FM-TX Power       |
| `21`      | I2C SDA (OLED)    |
| `22`      | I2C SCL (OLED)    |

## Software and Libraries

The project is built using PlatformIO. Key dependencies include:

- `espressif/arduino-esp32`
- `schreibfaul/Audio`
- `olikraus/U8g2`
- `GyverLibs/EncButton`
- `PaulStoffregen/Time`
- `PaulStoffregen/TimeAlarms`
- `arduino-libraries/NTPClient`
- `GyverLibs/FastBot`
- `knolleary/PubSubClient`

## Configuration

All main settings are configured in the `src/main.cpp` file:

1.  **WiFi:** Add your network SSIDs and passwords to the `ssidList` and `passwordList` arrays.

    ```cpp
    const char *ssidList[] = {"your_ssid1", "your_ssid2"};
    const char *passwordList[] = {"your_pass1", "your_pass2"};
    ```

2.  **Telegram:** Set your bot's token in `BOT_TOKEN` and your admin ID in `idAdmin1`.

    ```cpp
    #define BOT_TOKEN "YOUR_TELEGRAM_BOT_TOKEN"
    String idAdmin1 = "YOUR_TELEGRAM_CHAT_ID";
    ```

3.  **MQTT:** Configure the server address, login, and password.

    ```cpp
    const char *mqtt_server = "your_mqtt_broker_ip";
    #define login "your_mqtt_login"
    #define pass "your_mqtt_password"
    ```

4.  **Radio Stations:** The list of radio station URLs is in the `listStation` array.

## Controls

### Physical Buttons

- **POWER:** Turn the device on/off. Hold to reboot.
- **SLEEP:** Activate/deactivate the sleep timer. Hold to toggle the FM transmitter.
- **CH+ / CH-:** Switch stations. Hold to change volume.

### MQTT

Topics depend on the `ESP_WROVER` macro (`WebRadio1` or `WebRadio2`).

- **Incoming commands (topic_in):** `Home/WebRadioX/Action`

  - `?`: Request current status.
  - `1` / `0`: Turn on / off.
  - `b1` / `b2` / `b3` / `b4`: Emulate button presses for Power / Sleep / CH+ / CH-.
  - `vol+` / `vol-`: Increase / decrease volume.
  - `c<N>`: Turn on and switch to station number `N`.
  - `h<url>`: Play stream from the specified `url`.
  - `s<seconds>`: Set alarm (time in seconds from midnight).
  - `sAlarm OFF`: Disable alarm.

- **Outgoing statuses (topic\_\*):**
  - `Home/WebRadioX/Log`: General messages and audio stream information.
  - `Home/WebRadioX/Station`: Current station (number and name).
  - `Home/WebRadioX/Title`: Track title.
  - `Home/WebRadioX/State`: State (Power ON/OFF, ON SLEEP).
  - `Home/WebRadioX/FreeHeap`: Free heap memory.
  - `Home/WebRadioX/Volume`: Volume level.
  - `Home/WebRadioX/Alarm`: Alarm status.

### Telegram Bot

- `/start`: Show command menu.
- `/ping`: Get status, uptime, and RSSI.
- `/restart`: Reboot the device.
- **Sending a `.bin` file:** Initiates a firmware update (OTA).

## Build and Flash

1.  Install Visual Studio Code with the PlatformIO IDE extension.
2.  Clone the repository.
3.  Open the project folder in VS Code.
4.  Configure the settings in `src/main.cpp` (see the 'Configuration' section).
5.  Build and flash the device using PlatformIO commands.
