#include "Arduino.h"
#include "WiFi.h"
#include "secrets.h"
#include "Audio.h"
#include <U8g2lib.h> // Text and graphics, with video buffer
#include <EncButton.h>

#include <TimeLib.h>
#include <TimeAlarms.h>
#include <NTPClient.h>
#include <WiFiUdp.h>
#include <FastBot.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <EEPROM.h>
#include "esp_wifi.h" // esp_wifi_set_ps() — управление Wi-Fi power save

#define I2S_DOUT 25 // DIN connection
#define I2S_BCLK 27 // Bit clock
#define I2S_LRC 26  // Left Right Clock

// #define LED_BLUE 2
// #define RELAY1 32
// #define RELAY2 33
// #define KEY_UP 18
// #define KEY_DOWN 4
// #define KEY_POWER 19
// #define KEY_SLEEP 15
// #define FMTX 23

#define DEBUG

#define OffsetTime 5 * 60 * 60 // difference with UTC

#ifdef ESP_WROVER
#define MQTT_CLIENT "WebRadio2" // todo
#define topic_in "Home/WebRadio2/Action"
#define topic_out "Home/WebRadio2/Log"
#define topic_station "Home/WebRadio2/Station"
#define topic_title "Home/WebRadio2/Title"
#define topic_state "Home/WebRadio2/State"
#define topic_heap "Home/WebRadio2/FreeHeap"
#define topic_volume "Home/WebRadio2/Volume"
#define topic_alarm "Home/WebRadio2/Alarm"
#define topic_stations "Home/WebRadio2/Stations"
#define topic_dropouts "Home/WebRadio2/Dropouts"
#else
#define MQTT_CLIENT "WebRadio1" // todo
#define topic_in "Home/WebRadio1/Action"
#define topic_out "Home/WebRadio1/Log"
#define topic_station "Home/WebRadio1/Station"
#define topic_title "Home/WebRadio1/Title"
#define topic_state "Home/WebRadio1/State"
#define topic_heap "Home/WebRadio1/FreeHeap"
#define topic_volume "Home/WebRadio1/Volume"
#define topic_alarm "Home/WebRadio1/Alarm"
#define topic_stations "Home/WebRadio1/Stations"
#define topic_dropouts "Home/WebRadio1/Dropouts"
#endif

FastBot bot(BOT_TOKEN);
#define TelegramDdosTimeout 5000     // timeout
const unsigned long BOT_MTBS = 3600; // mean time between scan messages

boolean MQTT_available;

Audio audio;

WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP);

Button b0(KEY_POWER);
Button b1(KEY_SLEEP);
Button b2(KEY_UP);
Button b3(KEY_DOWN);
VirtButton b4; // virtual button

WiFiClient wclient;
PubSubClient client(wclient);

String WiFi_SSID = "-----";
bool WiFiFail = 1;

int NEWStation = 0;
uint8_t OLDStation = 1;

uint8_t Channel = 0;
// Метаданные ниже — loop-сторона (отрисовка/композиция строк). Пишет их только
// syncMetaFromAudio() из loop по флагам audio-задачи; сами audio-колбэки
// кладут текст в meta* буферы под metaMutex. Прямая запись String из
// audioTask запрещена (String не потокобезопасен).
String NameStation = "-----";
String StreamTitle = "-----";
volatile int Bitrate = 0; // пишет audio_bitrate() из audioTask
int8_t rssi = -100;
uint8_t vol = 12;
String format;
String channels;
String BitsPerSample;
String SampleRate;
String Bitrate1;

bool StatusPower = 0;
bool StatusSleep = 0;
bool KeyPowerTrigger = 0;
bool KeySleepTrigger = 0;
bool PowerOnFast = 0;

bool StatusRF = 0;

const char *subString = "failed";
// Флаги ниже трогают обе задачи (audioTask на core 0 пишет, loop на core 1
// читает/пишет), поэтому volatile. ESP32 делит DRAM когерентно, атомарности
// чтения/записи bool/int достаточно.
volatile bool RequestFail = 0;
volatile int CounterFail = 0;
volatile bool ReconnectLater = 0;
const char *subString1 = "dropouts";
volatile bool Dropouts = 0;
// Dropout counter: number of audio buffer underruns in the current 10 s window,
// published to topic_dropouts only when the value changes (repeated 0 suppressed)
// (++ из audioTask, чтение/сброс из loop — volatile)
volatile unsigned int DropoutCount = 0;
// Метка последнего переключения станции (ставит loop в audioCmdPlay).
// Первые секунды после коннекта буфер заведомо пустой (накачивается) —
// "slow stream" в это время не считаем, иначе метрика шумит на каждом старте.
volatile unsigned long lastPlayAt = 0;
const unsigned long DropoutGraceMs = 10000; // 10 секунд тишины счётчика после PLAY
unsigned long DropoutWindowStart = 0;
const unsigned long DropoutWindowInterval = 10000; // 10 seconds
int LastDropoutPublished = 0;
const char *subString2 = "403";
const char *subString3 = "500";
// int counterSleep;

unsigned long previousMillis = 0; // variable to store the previous millis() value
const long interval = 60000;      // interval in milliseconds (1 minute). Total shutdown time for SLEEP = 18 minutes

unsigned long lastUpdateTime = 0;
const unsigned long updateInterval = 2000; // 2 seconds

unsigned long lastUpdateTimeMQTT = 0;
const unsigned long updateIntervalMQTT = 5000; // 5 seconds

int targetVol = 12; // target value for vol
int step = 1;       // vol change step

unsigned long currentMillis1 = 0;
unsigned long previousMillis1 = 0; // variable to store the previous millis() value
unsigned long previousMillis2 = 0; // variable to store the previous millis() value
unsigned long interval1 = 200;     // interval in milliseconds. volume increase step
unsigned long interval2 = 10000;   // interval in milliseconds (10 sec)

// --- Non-blocking timers (замена delay() в пути воспроизведения) ------------
// Раньше после connecttohost() стоял delay(2000): он останавливал весь loop(),
// за эти 2 с audio.loop() не вызывался и буфер не накачивался, а MQTT не
// обслуживался. Теперь старт нарастания громкости планируется по времени, а
// экран гасится отдельным таймером — loop() продолжает крутиться.
unsigned long PowerOnRampAt = 0;         // 0 = ничего не запланировано
unsigned long PowerOnRampInterval = 100; // шаг нарастания громкости при старте
unsigned long ScreenOffAt = 0;           // 0 = ничего не запланировано
unsigned long LastRetryAt = 0;           // время последней попытки переподключения
bool ScreenDirty = false;                // экран нужно перерисовать (из audio-callback)
unsigned long LastScreenDraw = 0;        // время последней отрисовки из loop()

// --- Audio task (core 0): сеть и декодер отдельно от UI -----------------------
// loop() крутится на core 1 (дефолт Arduino). ВСЕ вызовы Audio
// (connecttohost/setVolume/stopSong/loop) выполняются ТОЛЬКО в audioTask на
// core 0 — поэтому блокирующий коннект (DNS+TCP+TLS+HTTP-заголовки, до ~2 с
// на HTTPS) больше не останавливает кнопки, экран и MQTT. Связь между
// задачами — через очереди (FreeRTOS Queue, потокобезопасны):
//   audioCmdQ — команды loop -> audio (PLAY/STOP/VOL), FIFO на 24
//   mqttOutQ  — сообщения audio -> loop для публикации в MQTT
// (PubSubClient НЕ потокобезопасен: client.publish только из loop).
enum AudioCmdType : uint8_t { AUDIO_CMD_PLAY, AUDIO_CMD_STOP, AUDIO_CMD_VOL };
struct AudioCmd
{
  AudioCmdType type;
  uint8_t vol;     // для AUDIO_CMD_VOL
  char url[512];   // для AUDIO_CMD_PLAY (копия — исходная строка может умереть раньше)
};
enum MqttOutTopic : uint8_t { MQTT_OUT_LOG, MQTT_OUT_TITLE, MQTT_OUT_STATION };
struct MqttOutMsg
{
  MqttOutTopic topic;
  char text[240];
};
static QueueHandle_t audioCmdQ = NULL;
static QueueHandle_t mqttOutQ = NULL;
static SemaphoreHandle_t metaMutex = NULL;
// audio-сторона метаданных: колбэки пишут сюда под metaMutex, loop забирает
// в String'и через syncMetaFromAudio(). metaSeq растёт при каждом обновлении.
static char metaName[128] = "";
static char metaTitle[256] = "";
static char metaFormat[16] = "";
static char metaChannels[8] = "";
static char metaBps[8] = "";
static char metaRate[12] = "";
static volatile uint32_t metaSeq = 0;
static uint32_t lastMetaSeq = 0; // loop-сторона

// Команды аудио-задаче. Безопасны из любого контекста (loop, MQTT-колбэк):
// при живой очереди — через неё, иначе (очередь ещё не создана или переполнена)
// прямым вызовом как раньше.
inline void audioCmdPlay(const char *url)
{
  lastPlayAt = millis(); // глушим счётчик дропаутов на DropoutGraceMs (буфер накачивается)
  if (audioCmdQ)
  {
    AudioCmd c;
    c.type = AUDIO_CMD_PLAY;
    c.vol = 0;
    strncpy(c.url, url, sizeof(c.url) - 1);
    c.url[sizeof(c.url) - 1] = '\0';
    if (xQueueSend(audioCmdQ, &c, 0) == pdTRUE)
      return;
  }
  audio.connecttohost(url);
}
inline void audioCmdStop()
{
  if (audioCmdQ)
  {
    AudioCmd c;
    c.type = AUDIO_CMD_STOP;
    c.vol = 0;
    c.url[0] = '\0';
    if (xQueueSend(audioCmdQ, &c, 0) == pdTRUE)
      return;
  }
  audio.stopSong();
}
inline void audioCmdVol(uint8_t v)
{
  if (audioCmdQ)
  {
    AudioCmd c;
    c.type = AUDIO_CMD_VOL;
    c.vol = v;
    c.url[0] = '\0';
    if (xQueueSend(audioCmdQ, &c, 0) == pdTRUE)
      return;
  }
  audio.setVolume(v);
}
// Сообщение в MQTT из audio-контекста: только в очередь, публикует loop().
inline void mqttEnqueue(MqttOutTopic t, const char *s)
{
  if (!mqttOutQ || !s)
    return;
  MqttOutMsg m;
  m.topic = t;
  strncpy(m.text, s, sizeof(m.text) - 1);
  m.text[sizeof(m.text) - 1] = '\0';
  xQueueSend(mqttOutQ, &m, 0); // переполнение — дроп (информационные сообщения)
}
// Положить готовую строку в audio-буфер метаданных. loop заберёт её через
// syncMetaFromAudio(). Блокировка короткая (копия ~десятков байт).
inline void metaSet(char *dst, size_t dstSz, const char *src)
{
  if (!src)
    src = "";
  if (metaMutex && xSemaphoreTake(metaMutex, portMAX_DELAY) == pdTRUE)
  {
    strncpy(dst, src, dstSz - 1);
    dst[dstSz - 1] = '\0';
    metaSeq++;
    xSemaphoreGive(metaMutex);
  }
  else if (!metaMutex)
  {
    // мьютекса нет (только если колбэк случился до setup) — прямая запись
    strncpy(dst, src, dstSz - 1);
    dst[dstSz - 1] = '\0';
  }
  // мьютекс занят loop — дроп, следующий колбэк допишет
}
// Забрать метаданные из audio-буферов в loop-String'и. Вызывать из loop
// (UpdateScreen/UpdateScreen1). Без блокировок: если мьютекс занят,
// пропускаем — доберём в следующую отрисовку.
void syncMetaFromAudio()
{
  if (!metaMutex || lastMetaSeq == metaSeq)
    return;
  if (xSemaphoreTake(metaMutex, 0) != pdTRUE)
    return;
  NameStation = metaName;
  StreamTitle = metaTitle;
  format = metaFormat;
  channels = metaChannels;
  BitsPerSample = metaBps;
  SampleRate = metaRate;
  lastMetaSeq = metaSeq;
  xSemaphoreGive(metaMutex);
}
// Сама задача: команды -> вызовы Audio, затем накачка декодера.
// Коалесцинг PLAY: пока мы висели в блокирующем connecttohost(), loop мог
// накидать ещё переключений. Перед следующим коннектом забираем всё, что
// накопилось, и играем СРАЗУ ПОСЛЕДНЮЮ выбранную станцию — промежуточные
// не коннектим (иначе каждое давало щелчок и 0.03–1.7 с тишины).
// Одиночный клик при пустой очереди идёт без задержек, как раньше.
// STOP после PLAY отменяет коннект (выключили, пока переключалось).
// vTaskDelay(1) отдаёт время WiFi/IDLE; I2S DMA (16x512 фреймов ~190 мс)
// такой гранулярности хватает с запасом.
void audioTask(void *param)
{
  (void)param;
  AudioCmd cmd;
  for (;;)
  {
    if (xQueueReceive(audioCmdQ, &cmd, 0) == pdTRUE)
    {
      // Собираем всё накопившееся в один батч (первая команда + хвост очереди).
      // static: 32 команды x ~520 байт = ~16 КБ — на стек задачи не влезет.
      static AudioCmd batch[32];
      int n = 0;
      batch[n++] = cmd;
      while (n < 32 && xQueueReceive(audioCmdQ, &batch[n], 0) == pdTRUE)
        n++;
      // Последний PLAY в батче — тот, на котором остановились. STOP после него
      // отменяет коннект (выключили, пока переключалось).
      int lastPlayIdx = -1;
      for (int i = 0; i < n; i++)
        if (batch[i].type == AUDIO_CMD_PLAY)
          lastPlayIdx = i;
      bool stopAfter = false;
      for (int i = 0; i < n; i++)
        if (batch[i].type == AUDIO_CMD_STOP && i > lastPlayIdx)
          stopAfter = true;
      if (lastPlayIdx >= 0 && !stopAfter)
        audio.connecttohost(batch[lastPlayIdx].url);
      for (int i = 0; i < n; i++)
      {
        if (batch[i].type == AUDIO_CMD_STOP)
          audio.stopSong();
        else if (batch[i].type == AUDIO_CMD_VOL)
          audio.setVolume(batch[i].vol);
      }
    }
    audio.loop();
    vTaskDelay(1);
  }
}

bool restart = 0;
unsigned long uptime;
unsigned long currentMillis = 0;

char buffer[10]; // Buffer for storing a string
char buffer1[300];

int sec_alarm_EEPROM = 0;

// OLED SSD1306
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, /* reset=*/U8X8_PIN_NONE); // OLED settings

// --- Dynamic station list (pushed over MQTT topic_stations by the web server) ---
// The compiled listStation array below is the offline fallback. When a valid
// station list arrives on topic_stations, dynStationUrls (pointers into
// stationsDoc) takes precedence. Array position == channel number.
#define MAX_DYNAMIC_STATIONS 255
JsonDocument stationsDoc;
const char *dynStationUrls[MAX_DYNAMIC_STATIONS];
int dynStationCount = 0;

const char *listStation[] = {
    "http://silverrain.hostingradio.ru/silver128.mp3",                   // 1 Silver Rain
    "https://live.radiospinner.com/smthlng-64",                          // Relax
    "http://ic7.101.ru:8000/v13_1",                                      // Relax FM
    "http://rmfstream1.interia.pl:8000/rmf_queen",                       // RFM Queen
    "http://16bitfm.com:8000/main_mp3_128",                              // 16Bit FM ProBeat Channel
    "http://cafe.amgradio.ru/Cafe",                                      // Cafe_off
    "http://chantefrance70s.ice.infomaniak.ch/chantefrance70s-96.aac",   // chantefrance70s
    "http://dfm.hostingradio.ru/prodigy96.aacp",                         // Prodigy
    "http://getradio.me/blvckstation",                                   // blackstation
    "http://ibizaglobalradio.streaming-pro.com:8024/stream",             // Ibiza Global Radio
    "http://ice06.fluidstream.net:8080/kk_rock.mp3",                     // Radio Kiss Kiss Gold Rock
    "http://iis.ge:8000/relax.mp3",                                      // Relax web radio
    "http://jfm1.hostingradio.ru:14536/prog.mp3",                        // prog

    "http://listen1.myradio24.com:9000/6262",                            // SpokoinoeRadio
    "http://listen2.myradio24.com:9000/8226",                            // Enigmatic robot
    "http://maximum.hostingradio.ru/maxcover96.aacp",                    // COVER
    "http://maximum.hostingradio.ru/maxpunk96.aacp",                     // PUNK
    "http://maximum.hostingradio.ru/nirvana96.aacp",                     // Nirvana
    "http://montecarlo.hostingradio.ru/mcjazz96.aacp",                   // JAZZ
    "http://nrj.de/lounge",                                              // NRJ LOUNGE
    "http://prmstrm.1.fm:8000/90s",                                      // 90s
    "http://prmstrm.1.fm:8000/ajazz",                                    // Adore jazz
    "http://prmstrm.1.fm:8000/ambientpsy",                               // Ambient Psychill
    "http://prmstrm.1.fm:8000/bossanova",                                // Bossa Nova
    "http://prmstrm.1.fm:8000/brazilianbirds",                           // brazillianbirds
    "http://prmstrm.1.fm:8000/ccountry",                                 // Classic Country
    "http://prmstrm.1.fm:8000/chilloutlounge",                           // Chillout Lounge
    "http://prmstrm.1.fm:8000/costadelmarchillout",                      // Costa Delmar
    "http://prmstrm.1.fm:8000/highvoltage",                              // High Voltage
    "http://prmstrm.1.fm:8000/kidsfm",                                   // Italia On Air
    "http://prmstrm.1.fm:8000/onelive",                                  // America's Best Ballads
    "http://prmstrm.1.fm:8000/radiogaia",                                // Radio Gaia
    "http://prmstrm.1.fm:8000/rockclassics",                             // Rock Classics
    "http://prmstrm.1.fm:8000/smoothjazz",                               // Smooth jazz
    "http://prmstrm.1.fm:8000/spa",                                      // Spa
    "http://radio.promodj.com:8000/186mph-192",                          // 186mph HQ
    "http://radio.promodj.com:8000/mini-192",                            // Mini HQ
    "http://radiorecord.hostingradio.ru/ambient96.aacp",                 // ambient
    "http://79.111.119.111:8004/spacemusic",                             // Spacemusic
    "http://89.223.45.5:8000/space-160",                                 // SECTOR Space channel
    "http://radiorecord.hostingradio.ru/cadillac96.aacp",                // cadillac
    "http://radiorecord.hostingradio.ru/chil96.aacp",                    // chil
    "http://radiorecord.hostingradio.ru/chillhouse96.aacp",              // chillhouse
    "http://radiorecord.hostingradio.ru/ibiza96.aacp",                   // ibiza
    "http://radiorecord.hostingradio.ru/summerlounge96.aacp",            // summerlounge
    "http://rautemusik-de-hz-fal-stream12.radiohost.de/lounge",          // Lounge
    "http://realfm.net:9500/rfr",                                        // Real FM Radio Relax
    "http://rouge-rockpop.ice.infomaniak.ch/rouge-rockpop-high.mp3",     // rouge-rockpop-high
    "http://s.aplus.fm:9000/aplus_relax_128",                            // Aplus.FM Relax
    "http://s7.radioheart.ru:8015/nonstop",                              // Kiss FM
    "http://sc-kidsfm.1.fm:10112/",                                      // 1.FM - Kids FM
    "http://streams.bigfm.de/bigfm-sunsetlounge-128-mp3",                // bigfm-sunsetlounge
    "http://zaycevfm.cdnvideo.ru/ZaycevFM_relax_256.mp3",                // ZaycevFM_relax
    "http://zvuki.amgradio.ru/Zvuki",                                    // Zvuki
    "https://ice6.abradio.cz/relax-morning-birds128.mp3",                // relax-morning-birds128
    "https://live.radiospinner.com/90srckhts-64",                        // 90srckhts
    "https://live.radiospinner.com/bird-sounds-64",                      // bird-sounds
    "https://live.radiospinner.com/blsrck-64",                           // blsrk
    "https://live.radiospinner.com/cdmr-64",                             // cdmr
    "https://live.radiospinner.com/complete-relaxation-64",              // complete-relaxation
    "https://live.radiospinner.com/lfch-64",                             // lfch
    "https://live.radiospinner.com/lounge-64",                           // lounge
    "https://live.radiospinner.com/mellow-jazz-64",                      // mellow-jazz
    "https://live.radiospinner.com/nature-64",                           // nature
    "https://live.radiospinner.com/ngmtcbr-64",                          // ngmtcbr
    "https://live.radiospinner.com/nwagewv-64",                          // nwagewv
    "https://live.radiospinner.com/smooth-jazz-64",                      // smooth-jazz
    "https://live.radiospinner.com/sslp-64",                             // sea ?
    "https://ouifmbluesnrock.ice.infomaniak.ch/ouifmbluesnrock-128.mp3", // Blues N Rock
    "https://play.lofiradio.ru:8000/mp3_320",                            // LoFi Radio
    "https://radio.voltagefm.ru:9009/VoltageGOLD_64_aac",                // VoltageFM GOLD
    "https://stream.mixadance.fm/relax",                                 // Mixdance Relax
    "https://stream.relaxfm.ee/cafe_HD",                                 // Relax Cafe
    "https://streaming.positivity.radio/pr/sleepkids/icecast.audio",     // sleepkids
    "https://webradio0007.ice.infomaniak.ch/webradio0007-128.mp3",       // webradio0007
    "http://play.yogaradio.org.ua:8000/YOGAradio",                       // YOGA
    "http://80.211.205.234:8001/radio192",                               // dip16 mp3 192
    "http://80.211.205.234:8001/radio128",                               // dip16 mp3 128
};

void PowerON_1(void);
void PowerOFF_1(void);
void printDigits(int digits);
void printDigits1(int digits);
void init_telegram(void);
void newMsg(FB_msg &msg);
void button_Power(void);
void button_Sleep(void);
void button_ChUp(void);
void button_ChDn(void);
void resetDropoutStats(void);

// Total station count: dynamic list if loaded, else the compiled fallback
int getStationCount()
{
  if (dynStationCount > 0)
    return dynStationCount;
  return sizeof(listStation) / sizeof(listStation[0]);
}

// Station URL by channel index (0-based); clamps out-of-range indices
const char *getStationURL(int index)
{
  int count = getStationCount();
  if (count == 0)
    return listStation[0];
  if (index < 0)
    index = 0;
  if (index >= count)
    index = count - 1;
  if (dynStationCount > 0)
    return dynStationUrls[index];
  return listStation[index];
}

int findStation(const char *searchString)
{
  if (dynStationCount > 0)
  {
    for (int i = 0; i < dynStationCount; ++i)
    {
      if (strcmp(dynStationUrls[i], searchString) == 0)
        return i;
    }
  }
  size_t listSize = sizeof(listStation) / sizeof(listStation[0]); // Determine the size of the array
  for (size_t i = 0; i < listSize; ++i)
  {
    if (strcmp(listStation[i], searchString) == 0)
    {           // Compare strings
      return i; // Return the index of the found string
    }
  }
  return -1; // If the string is not found, return -1
}

// Parse the station list payload received on topic_stations
void handleStationsPayload(const byte *payload, unsigned int length)
{
  stationsDoc.clear();
  DeserializationError err = deserializeJson(stationsDoc, (const char *)payload, length);
  if (err)
  {
    Serial.print("Stations JSON error: ");
    Serial.println(err.c_str());
    client.publish(topic_out, "Station list parse error");
    return;
  }

  JsonArray arr = stationsDoc["stations"].as<JsonArray>();
  if (arr.isNull() || arr.size() == 0 || arr.size() > MAX_DYNAMIC_STATIONS)
  {
    Serial.println("Station list payload invalid");
    return;
  }

  int count = 0;
  for (JsonVariant v : arr)
  {
    const char *url = v["url"] | "";
    if (url[0] == '\0')
      continue;
    dynStationUrls[count++] = url; // pointer into stationsDoc (kept alive)
    if (count >= MAX_DYNAMIC_STATIONS)
      break;
  }

  if (count == 0)
  {
    Serial.println("Station list has no usable urls");
    return;
  }

  dynStationCount = count;
  Serial.print("Loaded ");
  Serial.print(dynStationCount);
  Serial.println(" stations from MQTT");
  client.publish(topic_out, "Station list updated");
}

// Reset dropout statistics on station switch: counter to zero, window restart,
// and an immediate "0" publish if the last sent value wasn't 0 (no repeated zeros)
void resetDropoutStats()
{
  DropoutCount = 0;
  DropoutWindowStart = millis();
  if (LastDropoutPublished != 0 && client.connected())
  {
    client.publish(topic_dropouts, "0");
    LastDropoutPublished = 0;
  }
}

// MQTT receive message from broker
void callback(char *topic, byte *payload, unsigned int length)
{
  Serial.print("Message arrived [");
  Serial.print(topic);
  Serial.print("] ");
  for (int i = 0; i < length; i++)
  {
    Serial.print((char)payload[i]);
  }
  Serial.println();
  Serial.print("Length: ");
  Serial.println(length);

  String message = "";
  for (int i = 0; i < length; i++)
  {
    message += (char)payload[i];
  }
  // Serial.println(message);

  syncMetaFromAudio(); // свежие названия/формат из audioTask перед обработкой команд

  if (strncmp(topic, topic_stations, strlen(topic_stations)) == 0) // station list from the web server
  {
    handleStationsPayload(payload, length);
    return;
  }

  if (strncmp(topic, topic_in, strlen(topic_in)) == 0)
  {
    // Serial.println(payload[0]);
    // Serial.println(payload[1]);
    //  client.publish(topic_out, "mqtt message arrived to Action");
    //   bot.sendMessage("MQTT rx messadge", ADMIN_CHAT_ID);
    if (message == "?") // status request
    {
      if (StatusPower)
        client.publish(topic_state, "Power ON");
      else
        client.publish(topic_state, "Power OFF");
      const char *myCString1 = NameStation.c_str();
      snprintf(buffer1, sizeof(buffer1), "%d %s", Channel + 1, myCString1);
      client.publish(topic_station, buffer1);
      // Serial.println(NameStation);
      // Serial.println(buffer1);
      if (StatusPower)
      {
        // snprintf(buffer1, sizeof(buffer1), "%s", StreamTitle);
        const char *myCString = StreamTitle.c_str();
        client.publish(topic_title, myCString);
      }

      itoa(vol, buffer, 10); // Convert int value to string
      client.publish(topic_volume, buffer);

      if (StatusSleep)
        client.publish(topic_state, "ON SLEEP");

      String info;

      String mode_audio;
      if (channels == "1")
        mode_audio = "MONO";
      else
        mode_audio = "STEREO";

      int SampleRateInt = SampleRate.toInt() / 1000;

      info = mode_audio + " " + BitsPerSample + " bit " + SampleRateInt + " kHz " + format + " " + String(Bitrate / 1000) + " kb/s";
      const char *myCString2 = info.c_str();
      client.publish(topic_out, myCString2);

      Serial.println("INFO:");
      Serial.println(info);
      // Serial.println(StreamTitle);
      // Serial.println(myCString);

      if (Alarm.readState(0)) // alarm is running
      {
        int ss2 = Alarm.read(0);
        String strNumber = String(ss2);
        const char *myCString3 = strNumber.c_str();
        client.publish(topic_alarm, myCString3);

        Serial.println(strNumber);
      }
      else
      {
        String strNumber = "Alarm OFF";
        const char *myCString3 = strNumber.c_str();
        client.publish(topic_alarm, myCString3);

        Serial.println(strNumber);
      }
    }

    if (message == "b1") // POWER ON
    {
      button_Power();
    }
    if (message == "b2") // SLEEP
    {
      button_Sleep();
    }
    if (message == "b3") // CH+
    {
      button_ChUp();
    }
    if (message == "b4") // CH-
    {
      button_ChDn();
    }
    if (message == "vol+") // VOL+
    {
      PowerOnFast = 0; // Stop automatic volume increase
      vol = vol + 1;
      if (vol >= 21)
        vol = 21;
      audioCmdVol(vol);  // 0...21 — в очередь audioTask, не блокирует loop
      itoa(vol, buffer, 10); // Convert int value to string

      // client.publish(topic_out, "Vol +");
      client.publish(topic_volume, buffer);
    }
    if (message == "vol-") // VOL-
    {
      PowerOnFast = 0; // Stop automatic volume increase
      if (vol > 0)
        vol = vol - 1; // защита от переполнения uint8_t (0-1=255)
      audioCmdVol(vol);  // 0...21 — в очередь audioTask, не блокирует loop
      itoa(vol, buffer, 10); // Convert int value to string

      // client.publish(topic_out, "Vol -");
      client.publish(topic_volume, buffer);
    }

    if (message == "0") // POWER OFF
    {
      // client.publish(topic_out, "WebRadio OFF");
      client.publish(topic_state, "Power OFF");
      StatusPower = 0;
      StatusSleep = 0;

#ifdef ESP_WROVER
      digitalWrite(RELAY1, LOW);
      digitalWrite(RELAY2, LOW);
#else
      digitalWrite(RELAY1, LOW);
      digitalWrite(RELAY2, LOW);
#endif
      // digitalWrite(FMTX, LOW); // turn off FMTX power

      digitalWrite(LED_BLUE, LOW); // turn off LED

      u8g2.setFont(u8g2_font_9x18B_tr);
      u8g2.clearBuffer();
      u8g2.setCursor(25, 32);
      u8g2.print("POWER OFF");
      u8g2.sendBuffer();
      // вместо delay(2000) + гашения экрана: гасим по таймеру в loop()
      ScreenOffAt = millis() + 2000;
      audioCmdStop(); // в очередь audioTask
    }
    if (message == "1") // POWER ON
    {
      // client.publish(topic_out, "WebRadio ON");
      client.publish(topic_state, "Power ON");
      StatusPower = 1;
      StatusSleep = 0;

#ifdef ESP_WROVER
      digitalWrite(RELAY1, HIGH);
      digitalWrite(RELAY2, HIGH);
#else
      digitalWrite(RELAY1, HIGH);
      digitalWrite(RELAY2, HIGH);
#endif
      // digitalWrite(FMTX, HIGH); // turn on FMTX power

      digitalWrite(LED_BLUE, HIGH); // turn on LED

      u8g2.setFont(u8g2_font_9x18B_tr);
      u8g2.clearBuffer();
      u8g2.setCursor(26, 32);
      u8g2.print("POWER ON");
      u8g2.sendBuffer();
      u8g2.setContrast(255);

      vol = 0;
      audioCmdVol(vol);                         // 0...21 — в очередь audioTask
      audioCmdPlay(getStationURL(NEWStation)); // switch station — не блокирует loop
      resetDropoutStats();
      // вместо delay(2000): старт нарастания громкости планируем на потом,
      // loop() при этом продолжает качать буфер и обслуживать MQTT
      PowerOnFast = 0;
      PowerOnRampInterval = 100; // time step for volume increase in ms
      PowerOnRampAt = millis() + 2000;

      // UpdateScreen();
    }

    if (payload[0] == '3') // TURN ON BIRDS
    {
      Serial.print("CH2 ON");
      StatusPower = 1;
      StatusSleep = 0;
#ifdef ESP_WROVER
      digitalWrite(RELAY1, HIGH);
      digitalWrite(RELAY2, HIGH);
#else
      digitalWrite(RELAY1, HIGH);
      digitalWrite(RELAY2, HIGH);
#endif
      vol = 0;
      audioCmdVol(vol); // 0...21 — в очередь audioTask
      // find the bird-sounds station by URL so the channel index stays valid after list changes
      NEWStation = findStation("https://live.radiospinner.com/bird-sounds-64");
      if (NEWStation < 0)
        NEWStation = 0;
      Channel = NEWStation;
      OLDStation = NEWStation;
      audioCmdPlay(getStationURL(NEWStation)); // switch to BIRDS station — не блокирует loop
      resetDropoutStats();
      PowerOnFast = 0;
      PowerOnRampInterval = 100; // time step for volume increase in ms
      PowerOnRampAt = millis() + 2000;

      // client.publish(topic_out, "WebRadio ON");
      client.publish(topic_state, "Power ON");
    }

    if (payload[0] == 'c') // turn on power and station number
    {
      String numberPart = message.substring(1); // separate the remaining part of the string

      int number = numberPart.toInt(); // convert the remaining part to int

      Serial.print("Set channel ");
      Serial.println(number);

      StatusPower = 1;
      StatusSleep = 0;

      digitalWrite(RELAY1, HIGH);
      digitalWrite(RELAY2, HIGH);

      client.publish(topic_state, "Power ON");
      digitalWrite(LED_BLUE, HIGH); // turn on LED

      vol = 0;
      audioCmdVol(vol); // 0...21 — в очередь audioTask
      NEWStation = number - 1;
      Channel = NEWStation;
      OLDStation = NEWStation;
      audioCmdPlay(getStationURL(NEWStation)); // switch to station — не блокирует loop
      resetDropoutStats();
      PowerOnFast = 0;
      PowerOnRampInterval = 100; // time step for volume increase in ms
      PowerOnRampAt = millis() + 2000;
    }

    if (payload[0] == 'h') // link to station
    {
      // Convert to const char *
      const char *host = message.c_str();
      int nStation = findStation(host);
      if (nStation >= 0)
      {
        NEWStation = nStation;
        Channel = NEWStation;
        OLDStation = NEWStation;
      }
      audioCmdPlay(host); // switch station — не блокирует loop (URL копируется в команду)
      resetDropoutStats();
    }

    if (payload[0] == 's')
    {
      Serial.println("Setting alarm..");

      int hours = 0;
      int minutes = 0;
      if (message.equals("sAlarm OFF"))
      {
        // Serial.println("Turning off alarm.");
        // time_t tt11 = Alarm.read(0);
        // Serial.println(tt11);
        // tt11 = Alarm.read(1);
        // Serial.println(tt11);

        if (sec_alarm_EEPROM != -1)
        {
          Alarm.disable(0);

          Serial.print("Alarm off. Saving to EEPROM .. ");
          int address = 0; // memory address for writing (from 0 to 511)
          int secc = -1;
          sec_alarm_EEPROM = -1;
          // Writing data
          EEPROM.write(address, (secc >> 24) & 0xFF);     // Write byte 3
          EEPROM.write(address + 1, (secc >> 16) & 0xFF); // Write byte 2
          EEPROM.write(address + 2, (secc >> 8) & 0xFF);  // Write byte 1
          EEPROM.write(address + 3, secc & 0xFF);         // Write byte 0
          EEPROM.commit();                                // Save changes

          Serial.println("OK");
        }
      }
      else
      {
        // Remove the first character 's'
        String timePart = message.substring(1); // Get "12345"

        int secc = timePart.toInt();

        if (secc != sec_alarm_EEPROM)
        {
          // // Разделяем строку на часы и минуты
          // int colonIndex = timePart.indexOf(':');
          // if (colonIndex != -1)
          // {
          //   // Извлекаем часы
          //   hours = timePart.substring(0, colonIndex).toInt();
          //   // Извлекаем минуты
          //   minutes = timePart.substring(colonIndex + 1).toInt();
          // }

          // Serial.print("Часы: ");
          // Serial.println(hours);
          // Serial.print("Минуты: ");
          // Serial.println(minutes);

          // int tt2 = hours * 60 * 60 + minutes * 60;
          Alarm.write(0, secc); // reconfigure alarm 0 and start

          // Serial.print("Секунды: ");
          // Serial.println(tt2);

          // for (int i = 0; i < 10; i++)
          // {
          //   Serial.print(Alarm.readType(i));
          //   Serial.print(" : ");
          //   Serial.print(Alarm.readState(i));
          //   Serial.print(" : ");
          //   Serial.println(Alarm.read(i));
          // }

          Serial.print("Saving to EEPROM ..");
          int address = 0; // memory address for writing (from 0 to 511)
          // Writing data
          EEPROM.write(address, (secc >> 24) & 0xFF);     // Write byte 3
          EEPROM.write(address + 1, (secc >> 16) & 0xFF); // Write byte 2
          EEPROM.write(address + 2, (secc >> 8) & 0xFF);  // Write byte 1
          EEPROM.write(address + 3, secc & 0xFF);         // Write byte 0
          EEPROM.commit();                                // Save changes

          sec_alarm_EEPROM = secc;
          Serial.println(" OK ");
        }
        // Alarm.alarmRepeat(hours, minutes, 00, PowerON_1); // POWER_ON_1
      }

      Serial.println("Running alarms:");
      for (int i = 0; i < 4; i++)
      {
        int hh = 0;
        int mm = 0;
        int ss = Alarm.read(i);

        hh = ss / 3600;
        mm = (ss - hh * 3600) / 60; // (Alarm.read(i) % 3600);

        Serial.print(Alarm.readType(i));
        Serial.print(" : ");
        Serial.print(Alarm.readState(i));
        Serial.print(" : ");
        Serial.print(ss);
        Serial.print("    ");
        Serial.print(hh);
        Serial.print(" : ");
        Serial.println(mm);
      }
    }
  }
}

uint8_t reconnect(void)
{
  // Неблокирующий вариант: ОДНА попытка за вызов, без delay() и без цикла.
  // Раньше здесь был while + delay(1000) до 4 попыток: при падении брокера
  // loop() вставал на несколько секунд, audio.loop() не вызывался и буфер
  // вычерпывался. Теперь вызывающий код (setup один раз + loop каждые 5 с)
  // сам задаёт темп повторов: не подключились — попробуем в следующий раз.
  if (client.connected())
    return 1;
  Serial.print("Attempting MQTT connection... ");
  // Create a client ID
  String clientId = MQTT_CLIENT;

  // Attempt to connect (сам connect блокирующий на время TCP, но без добавочных пауз)
  if (client.connect(clientId.c_str(), MQTT_LOGIN, MQTT_PASS))
  {
    Serial.println("connected");
    // Once connected, publish an announcement...
    client.publish(topic_out, "Reconnect");
    // ... and resubscribe
    client.subscribe(topic_in);
    client.subscribe(topic_stations);
    // request the current station list from the web server
    client.publish(topic_in, "list?");
    return 1;
  }

  Serial.print("failed, rc=");
  Serial.print(client.state());
  Serial.println(" try again later");
  return 0;
}

void UpdateScreen(void)
{
  syncMetaFromAudio(); // подтянуть названия/формат из audioTask (если обновились)
  rssi = WiFi.RSSI();

#ifdef DEBUG
// Serial.print("RSSI: ");
// Serial.print(rssi);
// Serial.println(" dBm ");
#endif

  u8g2.clearBuffer();

  u8g2.setCursor(0, 15);
  // u8g2.setFont(u8g2_font_10x20_tr);
  u8g2.setFont(u8g2_font_VCR_OSD_mn);
  u8g2.print(Channel + 1);

  if (Dropouts)
  {
    u8g2.setFont(u8g2_font_10x20_tr);
    u8g2.print("!");
    Dropouts = 0;
  }

  if (RequestFail)
  {
    u8g2.setFont(u8g2_font_10x20_tr);
    u8g2.print("?");
  }

  if (ReconnectLater)
  {
    u8g2.setCursor(23, 10);
    u8g2.setFont(u8g2_font_8x13B_tr);
    u8g2.print("R");
  }

  if (StatusSleep)
  {
    u8g2.setCursor(13 + 20, 10);
    u8g2.setFont(u8g2_font_8x13B_tr);
    u8g2.print("SLEEP");

    u8g2.setCursor(75, 16);
    u8g2.setFont(u8g2_font_5x7_tr);
    u8g2.print(vol);

    u8g2.drawFrame(13 + 20, 12, 18 * 2, 4);
    u8g2.drawBox(13 + 20, 12, vol * 2, 4);
  }
  else
  {
    u8g2.setCursor(14 + 20, 10); // CLOCK
    u8g2.setFont(u8g2_font_crox2hb_tn);
    if (timeStatus() == 2)
    {
      u8g2.print(hour());
      printDigits1(minute());
      // printDigits1(second());
      // u8g2.print();
    }
    u8g2.setCursor(56, 6);
    u8g2.setFont(u8g2_font_5x7_tr);
    // u8g2.print(vol);
    u8g2.drawFrame(13 + 20, 12, 18 * 2, 4);
    u8g2.drawBox(13 + 20, 12, vol * 2, 4);
  }

  // rssi = -35;
  u8g2.setCursor(71, 6);
  u8g2.setFont(u8g2_font_5x7_tr);
  // u8g2.print(rssi);

  // u8g2.setCursor(49, 6);
  // u8g2.setFont(u8g2_font_5x7_tr);
  // u8g2.print("WiFi");
  // u8g2.drawBox(80 - 30, 13, 5, 2);

  /*
    u8g2.drawFrame(86 - 34, 12, 5, 4); // RSSI
    u8g2.drawFrame(92 - 34, 10, 5, 6);
    u8g2.drawFrame(98 - 34, 8, 5, 8);
    u8g2.drawFrame(104 - 34, 6, 5, 10);
    u8g2.drawFrame(110 - 34, 4, 5, 12);
    u8g2.drawFrame(116 - 34, 2, 5, 14);
    u8g2.drawFrame(122 - 34, 0, 5, 16);

    if (rssi >= -100)
      u8g2.drawBox(86 - 34, 12, 5, 4);
    if (rssi >= -90)
      u8g2.drawBox(92 - 34, 10, 5, 6);
    if (rssi >= -80)
      u8g2.drawBox(98 - 34, 8, 5, 8);
    if (rssi >= -70)
      u8g2.drawBox(104 - 34, 6, 5, 10);
    if (rssi >= -60)
      u8g2.drawBox(110 - 34, 4, 5, 12);
    if (rssi >= -50)
      u8g2.drawBox(116 - 34, 2, 5, 14);
    if (rssi >= -40)
      u8g2.drawBox(122 - 34, 0, 5, 16);*/

  if (StatusRF)
  {
    u8g2.setCursor(74, 6);
    u8g2.setFont(u8g2_font_5x7_tr);
    u8g2.print("TX");
  }

  u8g2.drawFrame(122 - 34, 0, 5, 16); // RSSI
  if (rssi >= -100 && rssi <= -40)
    u8g2.drawBox(122 - 34, 16 - map(rssi, -100, -40, 0, 16), 5, map(rssi, -100, -40, 0, 16));
  else if (rssi > -40)
    u8g2.drawBox(122 - 34, 0, 5, 16);

  u8g2.setCursor(99, 13);
  u8g2.setFont(u8g2_font_9x18B_tr);
  if (Bitrate == 0)
    u8g2.print("---");
  else
    u8g2.print(Bitrate / 1000);

  u8g2.drawFrame(98 - 2, 0, 32, 16);

  // u8g2.drawHLine(0 + 30, 16, 128 - 60);

  if (RequestFail)
  {
    u8g2.setCursor(0, 30);
    u8g2.setFont(u8g2_font_9x18B_tr);
    u8g2.print("Request failed!");
  }

  if (ReconnectLater)
  {
    u8g2.setCursor(0, 57);
    u8g2.setFont(u8g2_font_9x18B_tr);
    u8g2.print("Reconnect ");
    u8g2.print((interval2 - (currentMillis - previousMillis2)) / 1000);
    u8g2.print(" sec");
  }

  u8g2.setFont(u8g2_font_9x18B_tr);

  if (NameStation.length() >= 14)
  {
    u8g2.setCursor(0, 27);
    u8g2.print(NameStation.substring(0, 14));
    u8g2.setCursor(0, 39);
    u8g2.print(NameStation.substring(14));
  }
  else
  {
    u8g2.setCursor(int((14 - NameStation.length()) * 9 / 2), 33);
    u8g2.print(NameStation);
  }

  u8g2.drawHLine(0 + 30, 40, 128 - 60);

  if (StreamTitle.length() >= 14)
  {
    u8g2.setCursor(0, 51);
    u8g2.print(StreamTitle.substring(0, 14));
    u8g2.setCursor(0, 63);
    u8g2.print(StreamTitle.substring(14));
  }
  else
  {
    u8g2.setCursor(int((14 - StreamTitle.length()) * 9 / 2), 57);
    u8g2.print(StreamTitle);
  }

  u8g2.sendBuffer();
}

void UpdateScreen1(void)
{
  u8g2.clearBuffer();

  if (hour() >= 6 && hour() < 22) // Clock operating time
  {
    if (hour() < 10)
    {
#ifdef ESP_WROVER
      u8g2.setCursor(16, 52);
#else
      u8g2.setCursor(16, 58);
#endif
    }
    else
    {
#ifdef ESP_WROVER
      u8g2.setCursor(2, 52);
#else
      u8g2.setCursor(2, 58);
#endif
    }

    u8g2.setFont(u8g2_font_logisoso42_tr);

    if (timeStatus() == 2)
    {
      u8g2.print(hour());
      printDigits1(minute());
      // printDigits1(second());
      //  u8g2.print();
    }
  }
  else
  {
  }
  u8g2.sendBuffer();
}

void button_Power(void)
{
  // if (KeyPowerTrigger == 0) // POWER ON
  // {
  if (StatusPower == 0)
  {
    // client.publish(topic_out, "WebRadio ON");
    client.publish(topic_state, "Power ON");

    StatusPower = 1;
    StatusSleep = 0;

#ifdef ESP_WROVER
    digitalWrite(RELAY1, HIGH);
    digitalWrite(RELAY2, HIGH);
#else
    digitalWrite(RELAY1, HIGH);
    digitalWrite(RELAY2, HIGH);
#endif
    // digitalWrite(FMTX, HIGH); // turn on FMTX power

    digitalWrite(LED_BLUE, HIGH); // turn on LED

    u8g2.setFont(u8g2_font_9x18B_tr);
    u8g2.clearBuffer();
    u8g2.setCursor(26, 32);
    u8g2.print("POWER ON");
    u8g2.sendBuffer();
    u8g2.setContrast(255);

    vol = 0;
    audioCmdVol(vol);                         // 0...21 — в очередь audioTask
    audioCmdPlay(getStationURL(NEWStation)); // switch station — не блокирует loop
    resetDropoutStats();
    PowerOnFast = 0;
    PowerOnRampInterval = 100; // time step for volume increase in ms
    PowerOnRampAt = millis() + 2000;

    UpdateScreen();
  }
  else if (StatusPower == 1) // POWER OFF
  {
    // client.publish(topic_out, "WebRadio OFF");
    client.publish(topic_state, "Power OFF");

    StatusPower = 0;
    StatusSleep = 0;

#ifdef ESP_WROVER
    digitalWrite(RELAY1, LOW);
    digitalWrite(RELAY2, LOW);
#else
    digitalWrite(RELAY1, LOW);
    digitalWrite(RELAY2, LOW);
#endif
    // digitalWrite(FMTX, LOW); // turn off FMTX power

    digitalWrite(LED_BLUE, LOW); // turn off LED

    u8g2.setFont(u8g2_font_9x18B_tr);
    u8g2.clearBuffer();
    u8g2.setCursor(25, 32);
    u8g2.print("POWER OFF");
    u8g2.sendBuffer();
    // вместо delay(2000) + гашения экрана: гасим по таймеру в loop()
    ScreenOffAt = millis() + 2000;
    audioCmdStop(); // в очередь audioTask
    // audio.stopSong();
  }
}
void button_Sleep(void)
{
  if (StatusPower)
  {
    if (StatusSleep == 0)
    {
      // client.publish(topic_out, "SLEEP mode On");
      client.publish(topic_state, "ON SLEEP");
      StatusSleep = 1;
      previousMillis = millis(); // remember the time
      // digitalWrite(RELAY, LOW);
      // digitalWrite(LED_BLUE, HIGH); // turn on LED
      UpdateScreen();
    }
    else if (StatusSleep == 1)
    {
      // client.publish(topic_out, "SLEEP mode Off");
      client.publish(topic_state, "Power ON");
      StatusSleep = 0;
      vol = 12;
      audioCmdVol(vol); // 0...21 — в очередь audioTask

      itoa(vol, buffer, 10); // Convert int value to string
      client.publish(topic_volume, buffer);
      // digitalWrite(RELAY, HIGH);
      // digitalWrite(LED_BLUE, LOW); // turn off LED
      UpdateScreen();
    }
  }
}
void button_ChUp(void)
{
  if (StatusPower)
  {
    // client.publish(topic_out, "Channel +");
    NEWStation++; // station forward
    if (NEWStation > getStationCount() - 1)
      NEWStation = 0; // station 0
  }
}
void button_ChDn(void)
{
  if (StatusPower)
  {
    // client.publish(topic_out, "Channel -");
    NEWStation--; // station back
    if (NEWStation < 0)
      NEWStation = getStationCount() - 1; //
  }
}

void telegram_loop(void)
{
  int counter = 1000;

  while (1)
  {
    bot.tick(); // тикаем в луп

    delay(100);
    counter--;

    if (counter <= 0)
    {
      ESP.restart();
    }

    if (restart)
    {
      bot.tickManual();
      ESP.restart();
    }

    u8g2.clearBuffer();

    u8g2.setCursor(0, 15);
    // u8g2.setFont(u8g2_font_10x20_tr);
    u8g2.setFont(u8g2_font_9x18B_tr);
    u8g2.print("FW UPDATE..");
    u8g2.setCursor(45, 45);
    u8g2.setFont(u8g2_font_VCR_OSD_mn);
    u8g2.print(counter);

    u8g2.sendBuffer();
  }
}

void setup() // ************************************************* SETUP **********************************************
{
  int count = 0;
  bool telegram_SW_upd_Mode = false;
  Serial.begin(115200);

  pinMode(KEY_DOWN, INPUT_PULLUP);  // Station back
  pinMode(KEY_UP, INPUT_PULLUP);    // Station forward
  pinMode(KEY_SLEEP, INPUT_PULLUP); // SLEEP
  pinMode(KEY_POWER, INPUT_PULLUP); // POWER

#ifdef ESP_WROVER
  pinMode(RELAY1, OUTPUT);   // Relay
  digitalWrite(RELAY1, LOW); // turn off relay
  pinMode(RELAY2, OUTPUT);   // Relay
  digitalWrite(RELAY2, LOW); // turn off relay
#else
  pinMode(RELAY1, OUTPUT);   // Relay
  digitalWrite(RELAY1, LOW); // turn off relay
  pinMode(RELAY2, OUTPUT);   // Relay
  digitalWrite(RELAY2, LOW); // turn off relay
#endif

  if (digitalRead(KEY_UP) == 0)
    telegram_SW_upd_Mode = true;

  pinMode(LED_BLUE, OUTPUT);   // LED
  digitalWrite(LED_BLUE, LOW); // turn off LED

  pinMode(FMTX, OUTPUT);   //
  digitalWrite(FMTX, LOW); // FMTX power

  // --- Явный размер входного буфера (PSRAM) --------------------------------
  // ESP32-audioI2S по умолчанию берёт 640 КБ в PSRAM (или 16 КБ в RAM, если
  // PSRAM не нашлась/не выделилась). 640 КБ — это ~40 с при 128 kbps, и при
  // любой длинной просадке канала буфер вычерпывается. Здесь размер выбираем
  // по фактическому объёму PSRAM платы, а сколько реально выделилось —
  // увидим в логе из audio_info() ("inputBufferSize: N bytes").
  {
    size_t psram_total = ESP.getPsramSize();
    size_t psram_buf = 0;
    if (psram_total >= 8 * 1024 * 1024)
      psram_buf = 4 * 1024 * 1024; // ~4.5 мин при 128 kbps
    else if (psram_total >= 4 * 1024 * 1024)
      psram_buf = 2 * 1024 * 1024;
    else if (psram_total >= 2 * 1024 * 1024)
      psram_buf = 1 * 1024 * 1024;
    audio.setBufsize(1600 * 10, psram_buf ? (int)psram_buf : -1); // -1 = оставить дефолт
    Serial.printf("PSRAM total %u, free %u; input buffer requested: %u bytes\n",
                  (unsigned)psram_total, (unsigned)ESP.getFreePsram(), (unsigned)psram_buf);
  }
  // -------------------------------------------------------------------------

  audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);

  // --- Запуск audioTask (core 0) ------------------------------------------------
  // Очереди и мьютекс живут с этого момента; все audioCmd*/mqttEnqueue после
  // этой точки идут через них. Если что-то не создалось — helpers тихо
  // откатываются на прямые вызовы (старое поведение).
  audioCmdQ = xQueueCreate(32, sizeof(AudioCmd));
  mqttOutQ = xQueueCreate(16, sizeof(MqttOutMsg));
  metaMutex = xSemaphoreCreateMutex();
  if (audioCmdQ && mqttOutQ && metaMutex)
  {
    if (xTaskCreatePinnedToCore(audioTask, "audio", 16384, NULL, 3, NULL, 0) != pdPASS)
      Serial.println("FATAL: audio task not created");
    else
      Serial.println("audio task started on core 0");
  }
  else
    Serial.println("FATAL: audio IPC not created");
  // ------------------------------------------------------------------------------
  audioCmdVol(vol); // 0...21 (через очередь — задача уже запущена)

  u8g2.begin();
  u8g2.setFont(u8g2_font_9x18B_tr);
  u8g2.clearBuffer();
  u8g2.setCursor(0, 15);
  if (telegram_SW_upd_Mode)
    u8g2.print("FW UPDATE");
  else
    u8g2.print("START");

  u8g2.sendBuffer();
  delay(300);

  u8g2.setCursor(0, 28);
  u8g2.print("scaning WiFi..");
  u8g2.sendBuffer();

  // Connecting to the first available Wi-Fi network from the list
  Serial.println("Scanning available networks...");
  int numNetworks = WiFi.scanNetworks();

  for (int i = 0; i < numNetworks; i++)
  {
    Serial.print("Network found: ");
    Serial.println(WiFi.SSID(i));
  }

  for (int i = 0; i < numNetworks; i++)
  {
    for (int j = 0; j < sizeof(ssidList) / sizeof(ssidList[0]); j++)
    {
      if (WiFi.SSID(i) == ssidList[j])
      {
        Serial.print("Connecting to: ");
        Serial.print(ssidList[j]);

        u8g2.clearBuffer();
        u8g2.setCursor(0, 15);
        u8g2.print("Connect to");
        u8g2.setCursor(0, 28);
        u8g2.print(ssidList[j]);
        u8g2.sendBuffer();

        WiFi.begin(ssidList[j], passwordList[j]);

        u8g2.setCursor(0, 63);
        while (WiFi.status() != WL_CONNECTED)
        {
          u8g2.print(".");
          u8g2.sendBuffer();
          delay(500);
          Serial.print(".");

          if (count++ >= 16)
          {
            u8g2.setCursor(0, 40);
            u8g2.print("Reset!    ");
            u8g2.sendBuffer();
            delay(1000);
            ESP.restart();
          }
        }
        WiFiFail = 0;
        Serial.println("Connected!");
        // --- Отключаем Wi-Fi power save (модемный сон) --------------------------
        // По умолчанию станция уходит в DTIM-сон: приёмник просыпается не на
        // каждый пакет, из-за чего TCP-окно простаивает по 100-300 мс. Для
        // потокового аудио это прямые underrun'ы. WIFI_PS_NONE держит радио
        // активным: расход ~20-40 мА больше, зато нет периодических залипаний.
        WiFi.setSleep(false);            // Arduino-обёртка
        esp_wifi_set_ps(WIFI_PS_NONE);   // то же на уровне IDF, до кучи
        Serial.print("WiFi power save: ");
        Serial.println(WiFi.getSleep() ? "ON" : "OFF");
        // ------------------------------------------------------------------------
        WiFi_SSID = ssidList[j];
      }
    }
  }
  if (WiFiFail)
  {
    u8g2.setCursor(0, 40);
    u8g2.print("WiFi Fail!");
    u8g2.sendBuffer();
    delay(2000);
    Serial.println("WiFi fail. Restart!");
    ESP.restart();
  }

  u8g2.setCursor(0, 40);
  u8g2.print(WiFi.localIP());
  u8g2.sendBuffer();
  delay(1000);

  // WiFi.disconnect();
  // WiFi.mode(WIFI_STA);
  // WiFi.begin(ssid.c_str(), password.c_str());

  // while (WiFi.status() != WL_CONNECTED)
  // {
  //   delay(50);
  //   //u8g2.print(".");
  //   //u8g2.sendBuffer();
  //   if (count++ >= 9)
  //   {
  //     u8g2.setCursor(0, 40);
  //     u8g2.print("Reset!    ");
  //     u8g2.sendBuffer();
  //     delay(1000);
  //     ESP.restart();
  //   }
  // }
  // u8g2.setCursor(0, 28);
  // u8g2.print("                 ");
  // u8g2.setCursor(0, 28);
  // u8g2.print(WiFi_SSID);

  u8g2.setCursor(0, 51);
  u8g2.print("Set time.. ");
  u8g2.sendBuffer();

  timeClient.begin();
  timeClient.setTimeOffset(OffsetTime);

  // Раньше: while(update()==false){delay(1000);} — вечное зависание старта,
  // если NTP недоступен. Теперь максимум 10 попыток (~5 с), дальше едем без
  // точного времени: будильник по ненастроенным часам не сработает точно,
  // но радио играть будет.
  bool ntpOk = false;
  for (int i = 0; i < 10; i++)
  {
    if (timeClient.update())
    {
      ntpOk = true;
      break;
    }
    Serial.println("Error update time!");
    delay(500);
  }

  if (ntpOk)
    setTime(timeClient.getEpochTime());
  else
    Serial.println("NTP failed, continuing without time");

  Serial.println(timeClient.getEpochTime());
  // setTime(5, 59, 00, 1, 1, 24); // set time to Saturday 8:29:00am Jan 1 2024

  if (timeStatus() == 2)
  {
    Serial.print(hour());
    printDigits(minute());
    printDigits(second());
    Serial.println();
    u8g2.print("OK");
  }
  else
  {
    Serial.println();
    Serial.println("ERROR! Unable set Time!");
    u8g2.print("ERROR");
  }
  u8g2.sendBuffer();
  delay(2000);

  Serial.println("EEPROM start");
  EEPROM.begin(32); // Initialize EEPROM with a size of 32 bytes

  int address = 0; // memory address for writing (from 0 to 511)
  // int value = 21600; // data value (from 0 to 65535)

  // // Writing data
  // EEPROM.write(address, (value >> 24) & 0xFF);     // Write byte 3
  // EEPROM.write(address + 1, (value >> 16) & 0xFF); // Write byte 2
  // EEPROM.write(address + 2, (value >> 8) & 0xFF);  // Write byte 1
  // EEPROM.write(address + 3, value & 0xFF);         // Write byte 0
  // EEPROM.commit();                                 // Save changes

  // Reading data
  byte byte3 = EEPROM.read(address);     // Read byte 3
  byte byte2 = EEPROM.read(address + 1); // Read byte 2
  byte byte1 = EEPROM.read(address + 2); // Read byte 1
  byte byte0 = EEPROM.read(address + 3); // Read byte 0

  sec_alarm_EEPROM = (byte3 << 24) | (byte2 << 16) | (byte1 << 8) | byte0; // Combine bytes into a 32-bit value

  Serial.print("EEPROM read:  ");
  Serial.println(sec_alarm_EEPROM); // Output the read value

  Alarm.alarmRepeat(6, 00, 00, PowerON_1);   // POWER_ON_1  alarm ID = 0
  Alarm.alarmRepeat(23, 00, 00, PowerOFF_1); // POWER_OFF_1 alarm ID = 1

  if (sec_alarm_EEPROM == -1)
  {
    Alarm.disable(0);
    Serial.println("Alarm is off");
  }
  else
  {
    Alarm.write(0, sec_alarm_EEPROM); // reconfigure alarm 0 and start
    Serial.println("Alarm is running");
  }
  if (telegram_SW_upd_Mode)
  {
    init_telegram();
    telegram_loop();
  }

  u8g2.clearBuffer();
  u8g2.setCursor(0, 15);
  u8g2.print("Connect to MQTT");
  u8g2.setCursor(0, 28);
  u8g2.print(MQTT_SERVER);
  u8g2.sendBuffer();

  client.setServer(MQTT_SERVER, 1883);
  client.setCallback(callback);
  u8g2.setCursor(0, 40);
  if (reconnect() == 1)
  {
    MQTT_available = true;
    u8g2.print("OK! ");
  }
  else
  {
    MQTT_available = false;
    u8g2.print("ERROR! ");
  }

  u8g2.sendBuffer();
  client.publish(topic_out, "Restart OK");

  delay(2000);

  u8g2.clearBuffer();
  u8g2.sendBuffer();

  // digitalWrite(RELAY1, HIGH);   // вкл реле
  // digitalWrite(RELAY2, HIGH);   // вкл реле
  // digitalWrite(LED_BLUE, HIGH); //

  StatusPower = 0;
  StatusSleep = 0;
  /*
  #ifdef ESP_WROVER
    digitalWrite(RELAY1, LOW);
    digitalWrite(RELAY2, LOW);
  #else
    digitalWrite(RELAY1, HIGH);
    digitalWrite(RELAY2, HIGH);
  #endif*/

  digitalWrite(FMTX, LOW); // turn off FMTX power

  client.publish(topic_state, "Power OFF");

  digitalWrite(LED_BLUE, LOW); // turn off LED
  u8g2.setFont(u8g2_font_9x18B_tr);
  u8g2.clearBuffer();
  u8g2.setCursor(25, 32);
  u8g2.print("POWER OFF");
  u8g2.sendBuffer();
  delay(1000);
  u8g2.clearBuffer();
  u8g2.sendBuffer();
  u8g2.setContrast(1);
}

void loop() //*************************************************** LOOP ******************************************
{
  currentMillis = millis();

  // --- Обслуживание отложенных действий (замена delay() в путях старта) ----
  if (PowerOnRampAt && (long)(currentMillis - PowerOnRampAt) >= 0)
  {
    PowerOnRampAt = 0;
    interval1 = PowerOnRampInterval; // шаг нарастания громкости
    PowerOnFast = 1;                 // start fast volume increase
    previousMillis1 = currentMillis;
  }
  if (ScreenOffAt && (long)(currentMillis - ScreenOffAt) >= 0)
  {
    ScreenOffAt = 0;
    u8g2.clearBuffer();
    u8g2.sendBuffer();
    u8g2.setContrast(1);
  }
  // Экран, помеченный «грязным» из audio-callback: рисуем здесь, а не внутри
  // колбэка декодера. Не чаще 500 мс, чтобы не забивать I2C-шину.
  if (ScreenDirty && (currentMillis - LastScreenDraw >= 500))
  {
    ScreenDirty = false;
    LastScreenDraw = currentMillis;
    if (StatusPower)
      UpdateScreen();
    else
      UpdateScreen1();
  }
  // ------------------------------------------------------------------------

  if ((currentMillis - previousMillis2 >= interval2) && ReconnectLater) // Reconnect once a minute if there is no connection
  {
    previousMillis2 = currentMillis;
    Serial.println("Reconnect to Host");
    // call the function to be executed every minute
    audioCmdPlay(getStationURL(NEWStation)); // switch station — не блокирует loop
  }

  client.loop(); // MQTT client

  // Исходящие MQTT из audioTask (метаданные/ошибки декодера): публикуем здесь,
  // PubSubClient живёт только в loop-контексте.
  {
    MqttOutMsg om;
    while (mqttOutQ && xQueueReceive(mqttOutQ, &om, 0) == pdTRUE)
    {
      if (!client.connected())
        break; // офлайн — дроп (статусы переспросятся командой "?", дропы накопятся)
      if (om.topic == MQTT_OUT_LOG)
        client.publish(topic_out, om.text);
      else if (om.topic == MQTT_OUT_TITLE)
        client.publish(topic_title, om.text);
      else if (om.topic == MQTT_OUT_STATION)
        client.publish(topic_station, om.text);
    }
  }

  Alarm.service();

  b0.tick();
  b1.tick();
  b2.tick();
  b3.tick();

  // handling simultaneous pressing of two buttons
  b4.tick(b2, b3);

  if (b0.click())
    Serial.println("b0 click");

  if (b0.hold())
  {
    ESP.restart();
  }

  if (b1.hold())
  {
    Serial.println("b1 hold");
    if (StatusRF == 0)
    {
      StatusRF = 1;
      digitalWrite(FMTX, HIGH); // turn on FMTX power
      Serial.println("RF on");
      UpdateScreen();
    }
    else
    {
      StatusRF = 0;
      digitalWrite(FMTX, LOW); // turn off FMTX power
      Serial.println("RF off");
      UpdateScreen();
    }
  }

  if (b2.click() && StatusPower == 0)
  {
    Serial.println("Contrast 255");
    u8g2.setContrast(255);
  }

  if (b2.step() && StatusPower == 1)
  {
    vol++; // increase vol
    if (vol >= 21)
      vol = 21;
    UpdateScreen();
    audioCmdVol(vol);

    itoa(vol, buffer, 10); // Преобразование значения int в строку
    client.publish(topic_volume, buffer);
  }
  if (b3.step() && StatusPower == 1)
  {
    if (vol > 0)
      vol--; // decrease vol, защита от переполнения uint8_t
    UpdateScreen();
    audioCmdVol(vol);

    itoa(vol, buffer, 10); // Преобразование значения int в строку
    client.publish(topic_volume, buffer);
  }

  if (b3.click() && StatusPower == 0)
  {
    Serial.println("Contrast 0");
    u8g2.setContrast(1);
  }

  // if (b1.hold())
  //   Serial.println("b1 hold");

  // if (b1.press())
  //   Serial.println("b1 press");

  // if (b1.release())
  //   Serial.println("b1 release");

  if (b4.click())
  {
    Serial.println("b0+b1 click");
    // client.publish(topic_out, "b0+b1 click");
  }
  if (b4.step())
    Serial.println("b0+b1 step");

  // ---------------------------------------- MQTT check ----------------------------
  if ((currentMillis - lastUpdateTimeMQTT >= updateIntervalMQTT) && MQTT_available)
  {
    lastUpdateTimeMQTT = currentMillis;
    if (!client.connected())
      reconnect();
  }

  // ----------------- Dropout counter: publish count per 10 s window, on change only -----
  if (currentMillis - DropoutWindowStart >= DropoutWindowInterval)
  {
    DropoutWindowStart = currentMillis;
    int n = (int)DropoutCount;
    if (n == LastDropoutPublished)
    {
      DropoutCount = 0; // no change (incl. repeated 0) — nothing to send
    }
    else if (client.connected())
    {
      char dropBuf[12];
      itoa(n, dropBuf, 10);
      client.publish(topic_dropouts, dropBuf);
      LastDropoutPublished = n;
      DropoutCount = 0;
    }
    // else: offline — keep accumulating, will send when reconnected
  }

  // -------------------------------------------------------------------------- SCREEN ----------------------------------
  if ((currentMillis - lastUpdateTime >= updateInterval) && StatusPower)
  {
    UpdateScreen();
    lastUpdateTime = currentMillis;
    // client.publish(topic_out, "ping..");
    // if (!client.connected())
    // reconnect();

    size_t freeHeap = ESP.getFreeHeap();
    // char myChar[25];
    // snprintf(myChar, sizeof(myChar), "ON Free Heap: %d", freeHeap);
    // client.publish(topic_out, myChar);
    char buffer[10]; // Buffer for storing a string
    sprintf(buffer, "%d", freeHeap);
    client.publish(topic_heap, buffer);
    // free((void *)myChar);
  }
  // if ((currentMillis - lastUpdateTime >= updateInterval) & StatusPower & ReconnectLater)

  if ((currentMillis - lastUpdateTime >= updateInterval) && !StatusPower)
  {
    UpdateScreen1();
    lastUpdateTime = currentMillis;
    // if (!client.connected())
    // reconnect();

    size_t freeHeap = ESP.getFreeHeap();
    // char myChar[25];
    // snprintf(myChar, sizeof(myChar), "OFF Free Heap: %d", freeHeap);
    // client.publish(topic_out, myChar);
    char buffer[10]; // Buffer for storing a string
    sprintf(buffer, "%d", freeHeap);
    client.publish(topic_heap, buffer);
  }

  //----------------------------------------------------------
  if (PowerOnFast) // volume ramp-up mode
  {
    currentMillis1 = millis();

    if (currentMillis1 - previousMillis1 >= interval1)
    {
      previousMillis1 = currentMillis1;

      if (vol < targetVol)
      {
        vol += step;          // increase vol by step if target not reached
        audioCmdVol(vol); // set new volume level

        itoa(vol, buffer, 10); // Convert int value to string
        client.publish(topic_volume, buffer);
      }
      else
        PowerOnFast = 0;
    }
  }
  //------------------------------------------------------------ BUTTONS -------------------
  if (b0.click()) // pressed POWER
  {
    button_Power();
  }

  //--------------------------------------------------- SLEEP
  if ((b1.click()) && StatusPower)
  {
    button_Sleep();
  }
  //--------------------------------------------------------
  if (StatusPower)
  {
    if ((b3.click()))
    {
      NEWStation--; // station back
      if (NEWStation < 0)
        NEWStation = getStationCount() - 1; //
    }
    if ((b2.click()))
    {
      NEWStation++; // station forward
      if (NEWStation > getStationCount() - 1)
        NEWStation = 0; // station 0
    }
    // If we have selected a new station
    if (NEWStation != OLDStation)
    {
      NameStation = " ";
      StreamTitle = " ";
      Bitrate = 0;

      RequestFail = 0;
      CounterFail = 0;
      ReconnectLater = 0;

      Channel = NEWStation;

      UpdateScreen();

      audioCmdPlay(getStationURL(NEWStation)); // switch station — коннект в audioTask, loop свободен

      // Serial.println(NEWStation);

      OLDStation = NEWStation; // the action should be performed only once
      resetDropoutStats();
    }

    // Попытка переподключения. Раньше здесь стоял delay(100) и попытки шли
    // каждая итерация loop(): connecttohost() сам блокирующий (DNS+TCP+TLS),
    // поэтому получался шторм переподключений, а буфер не накачивался.
    // Теперь не чаще одной попытки в 2 с, без блокирующей паузы.
    if (RequestFail && CounterFail < 10)
    {
      if (LastRetryAt == 0 || (millis() - LastRetryAt >= 2000))
      {
        LastRetryAt = millis();
        CounterFail++;
        Serial.print("Reconnect #");
        Serial.println(CounterFail);
        audioCmdPlay(getStationURL(NEWStation)); // switch station — коннект в audioTask
        previousMillis2 = millis();
      }
    }
    else if (CounterFail >= 10)
    {
      ReconnectLater = 1; // reconnect in a minute
    }

    // audio.loop() больше не здесь: декодер и сеть живут в audioTask (core 0),
    // этот блок loop() только ставит команды и мгновенно возвращается.
  }
  else // power is off
  {
    bot.tick(); // tick in the loop
  }

  // ------------------------------------------------
  if (StatusSleep)
  {
    PowerOnFast = 0;                        // disable fast volume increase
    unsigned long currentMillis = millis(); // get the current millis() value

    if (currentMillis - previousMillis >= interval)
    {
      // your code that should run every second
      previousMillis = currentMillis; // update the previousMillis value

      if (vol > 0)
        vol--; // защита от переполнения uint8_t (0-1=255, иначе сон никогда не кончится)
      audioCmdVol(vol);

      itoa(vol, buffer, 10); // Convert int value to string
      client.publish(topic_volume, buffer);

      UpdateScreen();

      if (vol <= 1)
      {
        StatusSleep = 0;
        StatusPower = 0;

        digitalWrite(LED_BLUE, LOW); // turn off LED
        u8g2.setFont(u8g2_font_9x18B_tr);
        u8g2.clearBuffer();
        u8g2.setCursor(25, 32);
        u8g2.print("POWER OFF");
        u8g2.sendBuffer();
        digitalWrite(RELAY1, LOW);
        digitalWrite(RELAY2, LOW);
        // вместо delay(3000) + гашения: гасим экран по таймеру в loop()
        ScreenOffAt = millis() + 3000;
        // audio.stopSong();

#ifdef ESP_WROVER
        digitalWrite(RELAY1, LOW);
        digitalWrite(RELAY2, LOW);
#else
        // digitalWrite(RELAY1, HIGH);
        // digitalWrite(RELAY2, HIGH);
#endif
      }
    }
  }

  if (restart)
  {
    Serial.println("Restart!");
    bot.tickManual();
    ESP.restart();
  }
}

// optional
void audio_info(const char *info)
{
  // Фактически выделенный входной буфер: библиотека сообщает его при инициализации
  // ("PSRAM found, inputBufferSize: N bytes" / "PSRAM not found, ..."). Публикуем
  // в MQTT-лог, чтобы было видно, какой буфер реально работает на устройстве.
  if (strstr(info, "inputBufferSize") != NULL)
  {
    Serial.print("BUF: ");
    Serial.println(info);
    char bufMsg[96];
    snprintf(bufMsg, sizeof(bufMsg), "Buffer: %s", info);
    mqttEnqueue(MQTT_OUT_LOG, bufMsg); // публикует loop (PubSubClient не потокобезопасен)
  }

  if (strncmp(info, "BitRate", 7) == 0)
  {
    int length = strlen(info);      // BitRate: 128000
    char selectedChars[14 - 9 + 2]; // allocate memory for selected characters

    strncpy(selectedChars, info + 9, 14 - 9 + 1);
    selectedChars[14 - 9 + 1] = '\0'; // add a null terminator
    Bitrate = atoi(selectedChars);
  }

  if ((strstr(info, subString2) != NULL) || (strstr(info, subString3) != NULL)) // check for "failed"
  {
#ifdef DEBUG
    Serial.println("403/500");
#endif
    RequestFail = 1;
    mqttEnqueue(MQTT_OUT_LOG, "Request failed! (403/500)"); // публикует loop
  }

  if (strstr(info, subString) != NULL) // check for "failed"
  {
#ifdef DEBUG
    Serial.println("Request failed!");
#endif
    RequestFail = 1;
    mqttEnqueue(MQTT_OUT_LOG, "Request failed!"); // публикует loop
  }
  else if (strstr(info, "established") != NULL)
  {
    RequestFail = 0;
    CounterFail = 0;
    ReconnectLater = 0;
  }

  if (strstr(info, "format is") != NULL)
  {
    String input = String(info);
    String searchString = "format is ";
    int startIndex = input.indexOf(searchString);
    String fmtParsed = "";

    if (startIndex != -1)
    {
      startIndex += searchString.length();           // Go to the beginning of the format
      int endIndex = input.indexOf(' ', startIndex); // Search for a space after the format

      // If space is not found, take until the end of the string
      if (endIndex == -1)
      {
        endIndex = input.length();
      }

      fmtParsed = input.substring(startIndex, endIndex); // Return the found format
    }

    metaSet(metaFormat, sizeof(metaFormat), fmtParsed.c_str()); // заберёт loop
    Serial.println("format is:");
    Serial.println(fmtParsed);
  }

  if (strstr(info, "AACDecoder") != NULL)
  {
    metaSet(metaFormat, sizeof(metaFormat), "AAC"); // заберёт loop
    Serial.println("format is:");
    Serial.println("AAC");
  }

  if (strstr(info, "MP3Decoder") != NULL)
  {
    metaSet(metaFormat, sizeof(metaFormat), "MP3"); // заберёт loop
    Serial.println("format is:");
    Serial.println("MP3");
  }

  if (strstr(info, "Channels:") != NULL)
  {
    String input = String(info);
    String searchString = "Channels: ";
    int startIndex = input.indexOf(searchString);
    String chParsed = "";

    if (startIndex != -1)
    {
      startIndex += searchString.length();           // Go to the beginning of the format
      int endIndex = input.indexOf(' ', startIndex); // Search for a space after the format

      // If space is not found, take until the end of the string
      if (endIndex == -1)
      {
        endIndex = input.length();
      }

      chParsed = input.substring(startIndex, endIndex); // Return the found format
    }
    metaSet(metaChannels, sizeof(metaChannels), chParsed.c_str()); // заберёт loop
  }

  if (strstr(info, "SampleRate:") != NULL)
  {
    String input = String(info);
    String searchString = "SampleRate: ";
    int startIndex = input.indexOf(searchString);
    String rateParsed = "";

    if (startIndex != -1)
    {
      startIndex += searchString.length();           // Go to the beginning of the format
      int endIndex = input.indexOf(' ', startIndex); // Search for a space after the format

      // If space is not found, take until the end of the string
      if (endIndex == -1)
      {
        endIndex = input.length();
      }

      rateParsed = input.substring(startIndex, endIndex); // Return the found format
    }
    metaSet(metaRate, sizeof(metaRate), rateParsed.c_str()); // заберёт loop
  }

  if (strstr(info, "BitsPerSample:") != NULL)
  {
    String input = String(info);
    String searchString = "BitsPerSample: ";
    int startIndex = input.indexOf(searchString);
    String bpsParsed = "";

    if (startIndex != -1)
    {
      startIndex += searchString.length();           // Go to the beginning of the format
      int endIndex = input.indexOf(' ', startIndex); // Search for a space after the format

      // If space is not found, take until the end of the string
      if (endIndex == -1)
      {
        endIndex = input.length();
      }

      bpsParsed = input.substring(startIndex, endIndex); // Return the found format
    }
    metaSet(metaBps, sizeof(metaBps), bpsParsed.c_str()); // заберёт loop

    // String info;
    // info = format + " " + channels + "x " + BitsPerSample + " bps " + SampleRate + " Hz " + String(Bitrate) + " bod";
    // const char *myCString2 = info.c_str();
    // client.publish(topic_out, myCString2);
  }

  if (strstr(info, "BitRate:") != NULL)
  {
    String input = String(info);
    String searchString = "BitRate: ";
    int startIndex = input.indexOf(searchString);

    if (startIndex != -1)
    {
      startIndex += searchString.length();           // Go to the beginning of the format
      int endIndex = input.indexOf(' ', startIndex); // Search for a space after the format

      // If space is not found, take until the end of the string
      if (endIndex == -1)
      {
        endIndex = input.length();
      }

      Bitrate1 = input.substring(startIndex, endIndex); // Return the found format
    }
    else
      Bitrate1 = ""; // Возвращаем пустую строку, если формат не найден

    // Композиция — из audio-буферов напрямую: loop-String'и (channels и др.)
    // здесь читать нельзя (их пишет syncMetaFromAudio из другой задачи).
    // Буферы пишет только эта задача, loop их лишь читает — гонки нет.
    String infoLine;
    String mode_audio;
    if (strcmp(metaChannels, "1") == 0)
      mode_audio = "MONO";
    else
      mode_audio = "STEREO";

    int SampleRateInt = atoi(metaRate) / 1000;

    infoLine = mode_audio + " " + metaBps + " bit " + SampleRateInt + " kHz " + metaFormat + " " + String(Bitrate / 1000) + " kb/s";
    mqttEnqueue(MQTT_OUT_LOG, infoLine.c_str()); // публикует loop
  }

  if (strstr(info, subString1) != NULL) // check for "dropouts"
  {
    // Первые DropoutGraceMs после PLAY не считаем: буфер накачивается,
    // "slow stream" в это время — норма, а не проблема канала.
    if ((long)(millis() - lastPlayAt) >= (long)DropoutGraceMs)
    {
      Dropouts = 1;
      DropoutCount++;
    }
  }

  ScreenDirty = true; // рисуем в loop(), не здесь
#ifdef DEBUG
  Serial.print("info        ");
  Serial.println(info);
#endif
}
void audio_id3data(const char *info)
{ // id3 metadata
#ifdef DEBUG
  Serial.print("id3data     ");
  Serial.println(info);
#endif
}
void audio_eof_mp3(const char *info)
{ // end of file
#ifdef DEBUG
  Serial.print("eof_mp3     ");
  Serial.println(info);
#endif
}
void audio_showstation(const char *info)
{

  if (strncmp(info, "This is my", 10) == 0)
    info = "Silver Rain";
  metaSet(metaName, sizeof(metaName), info); // заберёт loop через syncMetaFromAudio
  ScreenDirty = true; // рисуем в loop(), не здесь
  if (strlen(info))
  {
    //  Format the string and save the result to the buffer
    char stBuf[300]; // локальный: общий buffer1 трогает loop
    snprintf(stBuf, sizeof(stBuf), "%d %s", Channel + 1, info);
    mqttEnqueue(MQTT_OUT_STATION, stBuf); // публикует loop
  }
#ifdef DEBUG
  Serial.print("station     ");
  Serial.println(info);
#endif
}
void audio_showstreaminfo(const char *info)
{
#ifdef DEBUG
  Serial.print("streaminfo  ");
  Serial.println(info);
#endif
}
void audio_showstreamtitle(const char *info)
{
  metaSet(metaTitle, sizeof(metaTitle), info); // заберёт loop через syncMetaFromAudio
  ScreenDirty = true; // рисуем в loop(), не здесь
  if (strlen(info))
  {
    // client.publish(topic_out, info);
    mqttEnqueue(MQTT_OUT_TITLE, info); // публикует loop
  }

#ifdef DEBUG
  Serial.print("streamtitle ");
  Serial.println(info);
#endif
}
void audio_bitrate(const char *info)
{
  Bitrate = atoi(info);
  ScreenDirty = true; // было UpdateScreen() — нельзя из audioTask, рисует loop

#ifdef DEBUG
  Serial.print("bitrate     ");
  Serial.println(info);
#endif
}
void audio_commercial(const char *info)
{ // duration in sec
#ifdef DEBUG
  Serial.print("commercial  ");
  Serial.println(info);
#endif
}
void audio_icyurl(const char *info)
{ // homepage
#ifdef DEBUG
  Serial.print("icyurl      ");
  Serial.println(info);
#endif
}
void audio_lasthost(const char *info)
{ // stream URL played
#ifdef DEBUG
  Serial.print("lasthost    ");
  Serial.println(info);
#endif
}
void audio_eof_speech(const char *info)
{
#ifdef DEBUG
  Serial.print("eof_speech  ");
  Serial.println(info);
#endif
}

void printDigits(int digits)
{
  Serial.print(":");
  if (digits < 10)
    Serial.print('0');
  Serial.print(digits);
}

void printDigits1(int digits)
{
  u8g2.print(":");
  if (digits < 10)
    u8g2.print('0');
  u8g2.print(digits);
}

// functions to be called when an alarm triggers:
void PowerON_1()
{
  Serial.println("Alarm PowerOn1");
  if (StatusPower == 0) // if off, then smoothly turn on by alarm
  {
    Serial.println("Alarm!");

    StatusPower = 1;
    StatusSleep = 0;

#ifdef ESP_WROVER
    digitalWrite(RELAY1, HIGH);
    digitalWrite(RELAY2, HIGH);
#else
    digitalWrite(RELAY1, HIGH);
    digitalWrite(RELAY2, HIGH);
#endif
    // digitalWrite(FMTX, HIGH); // turn on FMTX power

    digitalWrite(LED_BLUE, HIGH); // turn on LED

    u8g2.setFont(u8g2_font_9x18B_tr);
    u8g2.clearBuffer();
    u8g2.setCursor(26, 32);
    u8g2.print("POWER ON");
    u8g2.sendBuffer();

    vol = 0;
    audioCmdVol(vol);                         // 0...21 — в очередь audioTask
    audioCmdPlay(getStationURL(NEWStation)); // switch station — не блокирует loop
    resetDropoutStats();
    PowerOnFast = 0;
    PowerOnRampInterval = 1000 * 10; // медленное нарастание для будильника
    PowerOnRampAt = millis() + 2000;

    UpdateScreen();
  }
}

void PowerOFF_1() //
{
  Serial.println("Alarm PowerOff1");
  if (StatusSleep == 0)
  {
    StatusSleep = 1;
    previousMillis = millis(); // remember the time

    UpdateScreen();
  }
}

void init_telegram(void)
{
  bot.setChatID("");  // pass "" (empty string) to disable check
  bot.skipUpdates();  // skip unread messages
  bot.attach(newMsg); // new message handler

  bot.sendMessage("WebRadio_bot Restart OK", ADMIN_CHAT_ID);
  Serial.println("Message to telegram was sended");
  // strip.setPixelColor(0, strip.Color(127, 0, 127));
  // strip.setPixelColor(1, strip.Color(127, 0, 127));

  bot.sendMessage(timeClient.getFormattedTime(), ADMIN_CHAT_ID);
}

// message handler
void newMsg(FB_msg &msg)
{
  String chat_id = msg.chatID;
  String text = msg.text;
  String firstName = msg.first_name;
  String lastName = msg.last_name;
  String userID = msg.userID;
  String userName = msg.username;

  bot.notify(false);

  // output all information about the message
  Serial.println(msg.toString());
  FB_Time t(msg.unix, 5);
  Serial.print(t.timeString());
  Serial.print(' ');
  Serial.println(t.dateString());

  if (chat_id == ADMIN_CHAT_ID)
  {
    if (text == "/restart" && msg.chatID == ADMIN_CHAT_ID)
    {
      Serial.println("Restart..");
      bot.sendMessage("Restart..", chat_id);
      restart = 1;
    }

    // firmware update over the air from Telegram chat
    if (msg.OTA && msg.chatID == ADMIN_CHAT_ID)
    {
      Serial.println("Update");
      // strip.setPixelColor(0, strip.Color(100, 0, 100));
      // strip.setPixelColor(1, strip.Color(100, 0, 100));
      // strip.show();
      bot.update();
      // strip.setPixelColor(0, strip.Color(0, 100, 0));
      // strip.setPixelColor(1, strip.Color(0, 100, 0));
      // strip.show();
      // delay(300);
    }

    if (text == "/ping")
    {
      // strip.setPixelColor(0, strip.Color(100, 0, 100));
      // strip.show();
      Serial.println("/ping");
      uptime = millis(); // + 259200000;
      int min = uptime / 1000 / 60;
      int hours = min / 60;
      int days = hours / 24;

      long rssi = WiFi.RSSI();
      int gasLevelPercent = 0; // map(gasLevel, GasLevelOffset, 1024, 0, 100);

      String time = "pong! Message received at ";
      time += t.timeString();
      time += ". Uptime: ";
      time += days;
      time += "d ";
      time += hours - days * 24;
      time += "h ";
      // time += min - days * 24 * 60 - (hours - days * 24) * 60;
      time += min - hours * 60;
      time += "m";

      time += ". RSSI: ";
      time += rssi;
      time += " dB";

      // time += ". Gas: ";
      // time += gasLevelPercent;
      // time += " %";

      bot.sendMessage(time, chat_id);
      Serial.println("Message is sended");

      // strip.setPixelColor(7, strip.Color(1, 0, 2));
      // strip.show();
    }
    if (text == "/start" || text == "/start@dip16_WebRadioWroom_bot") // todo
    {
      // strip.setPixelColor(7, strip.Color(100, 100, 0));
      // strip.show();
      bot.showMenuText("Commands:", "\ping \t \restart", chat_id, false);
      delay(300);
      // strip.setPixelColor(7, strip.Color(0, 0, 0));
      // strip.show();
    }
  }
}