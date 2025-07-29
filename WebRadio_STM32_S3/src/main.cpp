#include "Arduino.h"
#include "WiFi.h"
#include "secrets.h"
#include "Audio.h"
// #include <Wire.h>
#include <U8g2lib.h> // текст и графика, с видеобуфером
#include <EncButton.h>

#include <TimeLib.h>
#include <TimeAlarms.h>
#include <NTPClient.h>
#include <WiFiUdp.h>
#include <FastBot.h>
#include <PubSubClient.h>
#include <EEPROM.h>

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

#define OffsetTime 5 * 60 * 60 // разница с UTC

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
#endif

FastBot bot(BOT_TOKEN);
#define TelegramDdosTimeout 5000     // таймаут
const unsigned long BOT_MTBS = 3600; // mean time between scan messages

boolean MQTT_available;

Audio audio;

WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP);

Button b0(KEY_POWER);
Button b1(KEY_SLEEP);
Button b2(KEY_UP);
Button b3(KEY_DOWN);
VirtButton b4; // виртуальная кнопка

WiFiClient wclient;
PubSubClient client(wclient);

String WiFi_SSID = "-----";
bool WiFiFail = 1;

int NEWStation = 0;
uint8_t OLDStation = 1;

uint8_t Channel = 0;
String NameStation = "-----";
String StreamTitle = "-----";
int Bitrate = 0;
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
bool RequestFail = 0;
int CounterFail = 0;
bool ReconnectLater = 0;
const char *subString1 = "dropouts";
bool Dropouts = 0;
const char *subString2 = "403";
const char *subString3 = "500";
// int counterSleep;

unsigned long previousMillis = 0; // переменная для хранения предыдущего значения millis()
const long interval = 60000;      // интервал в миллисекундах (1 минута). Общее время выключения по SLEEP = 18 минут

unsigned long lastUpdateTime = 0;
const unsigned long updateInterval = 2000; // 2 секунда

unsigned long lastUpdateTimeMQTT = 0;
const unsigned long updateIntervalMQTT = 5000; // 5 секунда

int targetVol = 12; // целевое значение для vol
int step = 1;       // шаг изменения vol

unsigned long currentMillis1 = 0;
unsigned long previousMillis1 = 0; // переменная для хранения предыдущего значения millis()
unsigned long previousMillis2 = 0; // переменная для хранения предыдущего значения millis()
unsigned long interval1 = 200;     // интервал в миллисекундах. шаг увеличения громкости
unsigned long interval2 = 10000;   // интервал в миллисекундах (10 сек)

bool restart = 0;
unsigned long uptime;
unsigned long currentMillis = 0;

char buffer[10]; // Буфер для хранения строки
char buffer1[300];

int sec_alarm_EEPROM = 0;

// OLED SSD1306
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, /* reset=*/U8X8_PIN_NONE); // настройки OLEDsdfsdf

// объявляем массив строк c радиостанциями
const char *listStation1[] = {
    "http://silverrain.hostingradio.ru/silver128.mp3", // 1 Серебряный Дождь
    "https://live.radiospinner.com/smthlng-64",        // 2
    "https://live.radiospinner.com/bird-sounds-64",    // птички
    //"http://streaming.radio.co/s5c5da6a36/listen",            // птички 2 Не работают
    "https://ice6.abradio.cz/relax-morning-birds128.mp3",       // птички 1
    "http://rautemusik-de-hz-fal-stream12.radiohost.de/lounge", //
    //"https://str.pcradio.ru/relax_fm_nature-hi",
    //"https://str.pcradio.ru/hirschmilch_chill-hi", // Хорошая, но не работает
    //"https://ice6.abradio.cz/relax-sea128.mp3",               // Море

    "https://stream.relaxfm.ee/cafe_HD",
    "http://streams.bigfm.de/bigfm-sunsetlounge-128-mp3", // 2
    "https://stream.relaxfm.ee/instrumental_HD",
    "https://stream.laut.fm/1000oldies",                  //
    "https://laut.fm/100090er",                           // 90е
    "http://icecast.pulsradio.com/relaxHD.mp3",           // Pulse Radio
    "http://streams.electronicmusicradiogroup.org:9050/", //

    "http://199.233.234.34:25373/listen.pls", // GOLD INSTRUMENTAL
    //"http://nap.casthost.net:8626/listen.pls",            // медитация
    //"https://101.ru/radio/channel/200",
    "https://live.radiospinner.com/complete-relaxation-64", // медитация
};

const char *listStation[] = {
    "http://silverrain.hostingradio.ru/silver128.mp3",                   // 1 Серебряный Дождь
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
    "http://jfm1.hostingradio.ru:14536/sjstream.mp3",                    // Smorh Jazz
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
    "https://live.radiospinner.com/sslp-64",                             // море ?
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

int findStation(const char *searchString)
{
  size_t listSize = sizeof(listStation) / sizeof(listStation[0]); // Определяем размер массива

  for (size_t i = 0; i < listSize; ++i)
  {
    if (strcmp(listStation[i], searchString) == 0)
    {           // Сравниваем строки
      return i; // Возвращаем индекс найденной строки
    }
  }
  return -1; // Если строка не найдена, возвращаем -1
}

// MQTT прием сообщения от брокера
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

  if (strncmp(topic, topic_in, strlen(topic_in)) == 0)
  {
    // Serial.println(payload[0]);
    // Serial.println(payload[1]);
    //  client.publish(topic_out, "mqtt message arrived to Action");
    //   bot.sendMessage("MQTT rx messadge", ADMIN_CHAT_ID);
    if (message == "?") // запрос состояния
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

      itoa(vol, buffer, 10); // Преобразование значения int в строку
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

      if (Alarm.readState(0)) // будильник запущен
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

    if (message == "b1") // ВКЛЮЧЕНИЕ
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
      vol = vol + 1;
      if (vol >= 21)
        vol = 21;
      audio.setVolume(vol);  // 0...21
      itoa(vol, buffer, 10); // Преобразование значения int в строку

      // client.publish(topic_out, "Vol +");
      client.publish(topic_volume, buffer);
    }
    if (message == "vol-") // VOL-
    {
      vol = vol - 1;
      if (vol <= 0)
        vol = 0;
      audio.setVolume(vol);  // 0...21
      itoa(vol, buffer, 10); // Преобразование значения int в строку

      // client.publish(topic_out, "Vol -");
      client.publish(topic_volume, buffer);
    }

    if (message == "0") // ВЫКЛЮЧЕНИЕ
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
      // digitalWrite(FMTX, LOW); // выкл питание FMTX

      digitalWrite(LED_BLUE, LOW); // выкл LED

      u8g2.setFont(u8g2_font_9x18B_tr);
      u8g2.clearBuffer();
      u8g2.setCursor(25, 32);
      u8g2.print("POWER OFF");
      u8g2.sendBuffer();
      delay(2000);
      u8g2.clearBuffer();
      u8g2.sendBuffer();
      u8g2.setContrast(1);
      audio.stopSong();
    }
    if (message == "1") // ВКЛЮЧЕНИЕ
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
      // digitalWrite(FMTX, HIGH); // вкл питание FMTX

      digitalWrite(LED_BLUE, HIGH); // вкл LED

      u8g2.setFont(u8g2_font_9x18B_tr);
      u8g2.clearBuffer();
      u8g2.setCursor(26, 32);
      u8g2.print("POWER ON");
      u8g2.sendBuffer();
      u8g2.setContrast(255);

      vol = 0;
      audio.setVolume(vol);                         // 0...21
      audio.connecttohost(listStation[NEWStation]); // переключаем станцию
      delay(2000);

      interval1 = 100; // шаг по времени для увеличения громкости в мс
      PowerOnFast = 1; // запуск быстрого увеличения громкости
      previousMillis1 = millis();

      // UpdateScreen();
    }

    if (payload[0] == '3') // ВКЛЮЧЕНИЕ ПТИЧКИ
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
      audio.setVolume(vol); // 0...21
      NEWStation = 57;
      Channel = NEWStation;
      OLDStation = NEWStation;
      audio.connecttohost(listStation[NEWStation]); // переключаем станцию ПТИЧКИ
      delay(2000);

      interval1 = 100; // шаг по времени для увеличения громкости в мс
      PowerOnFast = 1; // запуск быстрого увеличения громкости
      previousMillis1 = millis();
      // client.publish(topic_out, "WebRadio ON");
      client.publish(topic_state, "Power ON");
    }

    if (payload[0] == 'c') // включить питание и станцию number
    {
      String numberPart = message.substring(1); // отделяем оставшуюся часть строки

      int number = numberPart.toInt(); // преобразуем оставшуюся часть в int

      Serial.print("Set channel ");
      Serial.println(number);

      StatusPower = 1;
      StatusSleep = 0;

      digitalWrite(RELAY1, HIGH);
      digitalWrite(RELAY2, HIGH);

      client.publish(topic_state, "Power ON");
      digitalWrite(LED_BLUE, HIGH); // вкл LED

      vol = 0;
      audio.setVolume(vol); // 0...21
      NEWStation = number - 1;
      Channel = NEWStation;
      OLDStation = NEWStation;
      audio.connecttohost(listStation[NEWStation]); // переключаем станцию ПТИЧКИ
      delay(2000);

      interval1 = 100; // шаг по времени для увеличения громкости в мс
      PowerOnFast = 1; // запуск быстрого увеличения громкости
      previousMillis1 = millis();
    }

    if (payload[0] == 'h') // ссылка на станцию
    {
      // Преобразование в const char *
      const char *host = message.c_str();
      int nStation = findStation(host);
      if (nStation >= 0)
      {
        NEWStation = nStation;
        Channel = NEWStation;
        OLDStation = NEWStation;
      }
      audio.connecttohost(host); // переключаем станцию
    }

    if (payload[0] == 's')
    {
      Serial.println("Установка будильника..");

      int hours = 0;
      int minutes = 0;
      if (message.equals("sAlarm OFF"))
      {
        // Serial.println("Выключаем будильник.");
        // time_t tt11 = Alarm.read(0);
        // Serial.println(tt11);
        // tt11 = Alarm.read(1);
        // Serial.println(tt11);

        if (sec_alarm_EEPROM != -1)
        {
          Alarm.disable(0);

          Serial.print("Будильник выключен. Сохранение в EEPROM .. ");
          int address = 0; // адрес памяти для записи (от 0 до 511)
          int secc = -1;
          sec_alarm_EEPROM = -1;
          // Запись данных
          EEPROM.write(address, (secc >> 24) & 0xFF);     // Запись байта 3
          EEPROM.write(address + 1, (secc >> 16) & 0xFF); // Запись байта 2
          EEPROM.write(address + 2, (secc >> 8) & 0xFF);  // Запись байта 1
          EEPROM.write(address + 3, secc & 0xFF);         // Запись байта 0
          EEPROM.commit();                                // Сохранение изменений

          Serial.println("OK");
        }
      }
      else
      {
        // Удаляем первый символ 's'
        String timePart = message.substring(1); // Получаем "12345"

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
          Alarm.write(0, secc); // перенастройка будильника 0 и запуск

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

          Serial.print("Сохранение в EEPROM ..");
          int address = 0; // адрес памяти для записи (от 0 до 511)
          // Запись данных
          EEPROM.write(address, (secc >> 24) & 0xFF);     // Запись байта 3
          EEPROM.write(address + 1, (secc >> 16) & 0xFF); // Запись байта 2
          EEPROM.write(address + 2, (secc >> 8) & 0xFF);  // Запись байта 1
          EEPROM.write(address + 3, secc & 0xFF);         // Запись байта 0
          EEPROM.commit();                                // Сохранение изменений

          sec_alarm_EEPROM = secc;
          Serial.println(" OK ");
        }
        // Alarm.alarmRepeat(hours, minutes, 00, PowerON_1); // POWER_ON_1
      }

      Serial.println("Запущенные будильники:");
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
  int counter = 0;
  // Loop until we're reconnected
  while (!client.connected())
  {
    Serial.print("Attempting MQTT connection... ");
    // Create a client ID
    String clientId = MQTT_CLIENT;

    // Attempt to connect
    if (client.connect(clientId.c_str(), MQTT_LOGIN, MQTT_PASS))
    {
      // digitalWrite(LED2, LOW);
      Serial.println("connected");
      // Once connected, publish an announcement...
      client.publish(topic_out, "Reconnect");
      // ... and resubscribe
      client.subscribe(topic_in);
    }
    else
    {
      // digitalWrite(LED2, HIGH);
      Serial.print("failed, rc=");
      Serial.print(client.state());
      Serial.println(" try again in 1 seconds");

      // bot.sendMessage("connect to MQTT ..", ADMIN_CHAT_ID);
      //  Wait 5 seconds before retrying
      delay(1000);
    }

    counter++;
    Serial.print(counter);
    if (counter > 3)
      return 0;
  }
  return 1;
}

void UpdateScreen(void)
{
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
    u8g2.setCursor(14 + 20, 10); // ЧАСЫ
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

  if (hour() >= 6 && hour() < 22) // Время работы часов
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
    // digitalWrite(FMTX, HIGH); // вкл питание FMTX

    digitalWrite(LED_BLUE, HIGH); // вкл LED

    u8g2.setFont(u8g2_font_9x18B_tr);
    u8g2.clearBuffer();
    u8g2.setCursor(26, 32);
    u8g2.print("POWER ON");
    u8g2.sendBuffer();
    u8g2.setContrast(255);

    vol = 0;
    audio.setVolume(vol);                         // 0...21
    audio.connecttohost(listStation[NEWStation]); // переключаем станцию
    delay(2000);

    interval1 = 100; // шаг по времени для увеличения громкости в мс
    PowerOnFast = 1; // запуск быстрого увеличения громкости
    previousMillis1 = millis();

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
    // digitalWrite(FMTX, LOW); // выкл питание FMTX

    digitalWrite(LED_BLUE, LOW); // выкл LED

    u8g2.setFont(u8g2_font_9x18B_tr);
    u8g2.clearBuffer();
    u8g2.setCursor(25, 32);
    u8g2.print("POWER OFF");
    u8g2.sendBuffer();
    delay(2000);
    u8g2.clearBuffer();
    u8g2.sendBuffer();
    u8g2.setContrast(1);
    audio.stopSong();
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
      previousMillis = millis(); // запоминаем время
      // digitalWrite(RELAY, LOW);
      // digitalWrite(LED_BLUE, HIGH); // вкл LED
      UpdateScreen();
    }
    else if (StatusSleep == 1)
    {
      // client.publish(topic_out, "SLEEP mode Off");
      client.publish(topic_state, "Power ON");
      StatusSleep = 0;
      vol = 12;
      audio.setVolume(vol); // 0...21

      itoa(vol, buffer, 10); // Преобразование значения int в строку
      client.publish(topic_volume, buffer);
      // digitalWrite(RELAY, HIGH);
      // digitalWrite(LED_BLUE, LOW); // выкл LED
      UpdateScreen();
    }
  }
}
void button_ChUp(void)
{
  if (StatusPower)
  {
    // client.publish(topic_out, "Channel +");
    NEWStation++; // станция вперед
    if (NEWStation > sizeof(listStation) / sizeof(listStation[0]) - 1)
      NEWStation = 0; // станция 0
  }
}
void button_ChDn(void)
{
  if (StatusPower)
  {
    // client.publish(topic_out, "Channel -");
    NEWStation--; // станция назад
    if (NEWStation < 0)
      NEWStation = sizeof(listStation) / sizeof(listStation[0]) - 1; //
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

  pinMode(KEY_DOWN, INPUT_PULLUP);  // Станция назад
  pinMode(KEY_UP, INPUT_PULLUP);    // Станция вперед
  pinMode(KEY_SLEEP, INPUT_PULLUP); // SLEEP
  pinMode(KEY_POWER, INPUT_PULLUP); // POWER

#ifdef ESP_WROVER
  pinMode(RELAY1, OUTPUT);   // Реле
  digitalWrite(RELAY1, LOW); // выкл реле
  pinMode(RELAY2, OUTPUT);   // Реле
  digitalWrite(RELAY2, LOW); // выкл реле
#else
  pinMode(RELAY1, OUTPUT);   // Реле
  digitalWrite(RELAY1, LOW); // выкл реле
  pinMode(RELAY2, OUTPUT);   // Реле
  digitalWrite(RELAY2, LOW); // выкл реле
#endif

  if (digitalRead(KEY_UP) == 0)
    telegram_SW_upd_Mode = true;

  pinMode(LED_BLUE, OUTPUT);   // LED
  digitalWrite(LED_BLUE, LOW); // выкл LED

  pinMode(FMTX, OUTPUT);   //
  digitalWrite(FMTX, LOW); // питание FMTX

  audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
  audio.setVolume(vol); // 0...21

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

  // Подключение к первой доступной Wi-Fi сети из списка
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

  while (timeClient.update() == false)
  {
    Serial.println("Error update time!");
    delay(1000);
  }

  setTime(timeClient.getEpochTime());

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
  EEPROM.begin(32); // Инициализация EEPROM с размером 32 байт

  int address = 0; // адрес памяти для записи (от 0 до 511)
  // int value = 21600; // значение данных (от 0 до 65535)

  // // Запись данных
  // EEPROM.write(address, (value >> 24) & 0xFF);     // Запись байта 3
  // EEPROM.write(address + 1, (value >> 16) & 0xFF); // Запись байта 2
  // EEPROM.write(address + 2, (value >> 8) & 0xFF);  // Запись байта 1
  // EEPROM.write(address + 3, value & 0xFF);         // Запись байта 0
  // EEPROM.commit();                                 // Сохранение изменений

  // Чтение данных
  byte byte3 = EEPROM.read(address);     // Чтение байта 3
  byte byte2 = EEPROM.read(address + 1); // Чтение байта 2
  byte byte1 = EEPROM.read(address + 2); // Чтение байта 1
  byte byte0 = EEPROM.read(address + 3); // Чтение байта 0

  sec_alarm_EEPROM = (byte3 << 24) | (byte2 << 16) | (byte1 << 8) | byte0; // Объединение байтов в 32-битное значение

  Serial.print("EEPROM read:  ");
  Serial.println(sec_alarm_EEPROM); // Вывод прочитанного значения

  Alarm.alarmRepeat(6, 00, 00, PowerON_1);   // POWER_ON_1  будильник ID = 0
  Alarm.alarmRepeat(23, 00, 00, PowerOFF_1); // POWER_OFF_1 будильник ID = 1

  if (sec_alarm_EEPROM == -1)
  {
    Alarm.disable(0);
    Serial.println("Будильник выключен");
  }
  else
  {
    Alarm.write(0, sec_alarm_EEPROM); // перенастройка будильника 0 и запуск
    Serial.println("Будильник запущен");
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

  digitalWrite(FMTX, LOW); // выкл питание FMTX

  client.publish(topic_state, "Power OFF");

  digitalWrite(LED_BLUE, LOW); // выкл LED
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

  if ((currentMillis - previousMillis2 >= interval2) && ReconnectLater) // Переподключение раз в минуту, если нет связи
  {
    previousMillis2 = currentMillis;
    Serial.println("Reconnect to Host");
    // вызов функции, которую нужно выполнить каждую минуту
    audio.connecttohost(listStation[NEWStation]); // переключаем станцию
  }

  client.loop(); // MQTT client

  Alarm.service();

  b0.tick();
  b1.tick();
  b2.tick();
  b3.tick();

  // обработка одновременного нажатия двух кнопок
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
      digitalWrite(FMTX, HIGH); // вкл питание FMTX
      Serial.println("RF on");
      UpdateScreen();
    }
    else
    {
      StatusRF = 0;
      digitalWrite(FMTX, LOW); // выкл питание FMTX
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
    vol++; // увеличиваем vol
    if (vol >= 21)
      vol = 21;
    UpdateScreen();
    audio.setVolume(vol);

    itoa(vol, buffer, 10); // Преобразование значения int в строку
    client.publish(topic_volume, buffer);
  }
  if (b3.step() && StatusPower == 1)
  {
    vol--; // увеличиваем vol
    if (vol <= 0)
      vol = 0;
    UpdateScreen();
    audio.setVolume(vol);

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
    char buffer[10]; // Буфер для хранения строки
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
    char buffer[10]; // Буфер для хранения строки
    sprintf(buffer, "%d", freeHeap);
    client.publish(topic_heap, buffer);
  }

  //----------------------------------------------------------
  if (PowerOnFast) // режим нарастания громкости
  {
    currentMillis1 = millis();

    if (currentMillis1 - previousMillis1 >= interval1)
    {
      previousMillis1 = currentMillis1;

      if (vol < targetVol)
      {
        vol += step;          // увеличиваем vol на шаг, если не достигли цели
        audio.setVolume(vol); // устанавливаем новое значение громкости

        itoa(vol, buffer, 10); // Преобразование значения int в строку
        client.publish(topic_volume, buffer);
      }
      else
        PowerOnFast = 0;
    }
  }
  //------------------------------------------------------------ КНОПКИ -------------------
  if (b0.click()) // нажали POWER
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
      NEWStation--; // станция назад
      if (NEWStation < 0)
        NEWStation = sizeof(listStation) / sizeof(listStation[0]) - 1; //
    }
    if ((b2.click()))
    {
      NEWStation++; // станция вперед
      if (NEWStation > sizeof(listStation) / sizeof(listStation[0]) - 1)
        NEWStation = 0; // станция 0
    }
    // Если мы выбрали новую станцию
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

      audio.connecttohost(listStation[NEWStation]); // переключаем станцию

      // Serial.println(NEWStation);

      OLDStation = NEWStation; // действие должно выполниться только один раз
    }

    if (RequestFail && CounterFail < 10)
    {
      CounterFail++;
      Serial.print("Reconnect #");
      Serial.println(CounterFail);
      audio.connecttohost(listStation[NEWStation]); // переключаем станцию
      delay(100);
      previousMillis2 = millis();
    }
    else if (CounterFail >= 10)
    {
      ReconnectLater = 1; // переподключить через минуту
    }

    audio.loop();
  }
  else // питания выключено
  {
    bot.tick(); // тикаем в луп
  }

  // ------------------------------------------------
  if (StatusSleep)
  {
    PowerOnFast = 0;                        // выключение быстрого увеличения громкости
    unsigned long currentMillis = millis(); // получаем текущее значение millis()

    if (currentMillis - previousMillis >= interval)
    {
      // ваш код, который должен выполняться каждую секунду
      previousMillis = currentMillis; // обновляем значение previousMillis

      vol--;
      audio.setVolume(vol);

      itoa(vol, buffer, 10); // Преобразование значения int в строку
      client.publish(topic_volume, buffer);

      UpdateScreen();

      if (vol <= 1)
      {
        StatusSleep = 0;
        StatusPower = 0;

        digitalWrite(LED_BLUE, LOW); // выкл LED
        u8g2.setFont(u8g2_font_9x18B_tr);
        u8g2.clearBuffer();
        u8g2.setCursor(25, 32);
        u8g2.print("POWER OFF");
        u8g2.sendBuffer();
        digitalWrite(RELAY1, LOW);
        digitalWrite(RELAY2, LOW);
        delay(3000);
        u8g2.clearBuffer();
        u8g2.sendBuffer();
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
  if (strncmp(info, "BitRate", 7) == 0)
  {
    int length = strlen(info);      // BitRate: 128000
    char selectedChars[14 - 9 + 2]; // выделяем память для выбранных символов

    strncpy(selectedChars, info + 9, 14 - 9 + 1);
    selectedChars[14 - 9 + 1] = '\0'; // добавляем завершающий нулевой символ
    Bitrate = atoi(selectedChars);
  }

  if ((strstr(info, subString2) != NULL) || (strstr(info, subString3) != NULL)) // check for "failed"
  {
#ifdef DEBUG
    Serial.println("403/500");
#endif
    RequestFail = 1;
    client.publish(topic_out, "Request failed! (403/500)");
  }

  if (strstr(info, subString) != NULL) // check for "failed"
  {
#ifdef DEBUG
    Serial.println("Request failed!");
#endif
    RequestFail = 1;
    client.publish(topic_out, "Request failed!");
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

    if (startIndex != -1)
    {
      startIndex += searchString.length();           // Переход к началу формата
      int endIndex = input.indexOf(' ', startIndex); // Поиск пробела после формата

      // Если пробел не найден, берем до конца строки
      if (endIndex == -1)
      {
        endIndex = input.length();
      }

      format = input.substring(startIndex, endIndex); // Возвращаем найденный формат
    }
    else
      format = ""; // Возвращаем пустую строку, если формат не найден

    Serial.println("format is:");
    Serial.println(format);
  }

  if (strstr(info, "AACDecoder") != NULL)
  {
    format = "AAC";
    Serial.println("format is:");
    Serial.println(format);
  }

  if (strstr(info, "MP3Decoder") != NULL)
  {
    format = "MP3";
    Serial.println("format is:");
    Serial.println(format);
  }

  if (strstr(info, "Channels:") != NULL)
  {
    String input = String(info);
    String searchString = "Channels: ";
    int startIndex = input.indexOf(searchString);

    if (startIndex != -1)
    {
      startIndex += searchString.length();           // Переход к началу формата
      int endIndex = input.indexOf(' ', startIndex); // Поиск пробела после формата

      // Если пробел не найден, берем до конца строки
      if (endIndex == -1)
      {
        endIndex = input.length();
      }

      channels = input.substring(startIndex, endIndex); // Возвращаем найденный формат
    }
    else
      channels = ""; // Возвращаем пустую строку, если формат не найден
  }

  if (strstr(info, "SampleRate:") != NULL)
  {
    String input = String(info);
    String searchString = "SampleRate: ";
    int startIndex = input.indexOf(searchString);

    if (startIndex != -1)
    {
      startIndex += searchString.length();           // Переход к началу формата
      int endIndex = input.indexOf(' ', startIndex); // Поиск пробела после формата

      // Если пробел не найден, берем до конца строки
      if (endIndex == -1)
      {
        endIndex = input.length();
      }

      SampleRate = input.substring(startIndex, endIndex); // Возвращаем найденный формат
    }
    else
      SampleRate = ""; // Возвращаем пустую строку, если формат не найден
  }

  if (strstr(info, "BitsPerSample:") != NULL)
  {
    String input = String(info);
    String searchString = "BitsPerSample: ";
    int startIndex = input.indexOf(searchString);

    if (startIndex != -1)
    {
      startIndex += searchString.length();           // Переход к началу формата
      int endIndex = input.indexOf(' ', startIndex); // Поиск пробела после формата

      // Если пробел не найден, берем до конца строки
      if (endIndex == -1)
      {
        endIndex = input.length();
      }

      BitsPerSample = input.substring(startIndex, endIndex); // Возвращаем найденный формат
    }
    else
      BitsPerSample = ""; // Возвращаем пустую строку, если формат не найден

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
      startIndex += searchString.length();           // Переход к началу формата
      int endIndex = input.indexOf(' ', startIndex); // Поиск пробела после формата

      // Если пробел не найден, берем до конца строки
      if (endIndex == -1)
      {
        endIndex = input.length();
      }

      Bitrate1 = input.substring(startIndex, endIndex); // Возвращаем найденный формат
    }
    else
      Bitrate1 = ""; // Возвращаем пустую строку, если формат не найден

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
  }

  if (strstr(info, subString1) != NULL) // check for "dropouts"
  {
    Dropouts = 1;
  }

  UpdateScreen();
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
  NameStation = info;
  UpdateScreen();
  if (strlen(info))
  {
    // client.publish(topic_out, info);
    //  Форматируем строку и сохраняем результат в буфер
    snprintf(buffer1, sizeof(buffer1), "%d %s", Channel + 1, info);
    client.publish(topic_station, buffer1);
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
  StreamTitle = info;
  UpdateScreen();
  if (strlen(info))
  {
    // client.publish(topic_out, info);
    client.publish(topic_title, info);
  }

#ifdef DEBUG
  Serial.print("streamtitle ");
  Serial.println(info);
#endif
}
void audio_bitrate(const char *info)
{
  Bitrate = atoi(info);
  UpdateScreen();

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
  if (StatusPower == 0) // если выключен то плавно включаем по будильнику
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
    // digitalWrite(FMTX, HIGH); // вкл питание FMTX

    digitalWrite(LED_BLUE, HIGH); // вкл LED

    u8g2.setFont(u8g2_font_9x18B_tr);
    u8g2.clearBuffer();
    u8g2.setCursor(26, 32);
    u8g2.print("POWER ON");
    u8g2.sendBuffer();

    vol = 0;
    audio.setVolume(vol);                         // 0...21
    audio.connecttohost(listStation[NEWStation]); // переключаем станцию
    delay(2000);

    interval1 = 1000 * 10; // шаг по времени для увеличения громкости в мс
    PowerOnFast = 1;       // запуск быстрого увеличения громкости
    previousMillis1 = millis();

    UpdateScreen();
  }
}

void PowerOFF_1() //
{
  Serial.println("Alarm PowerOff1");
  if (StatusSleep == 0)
  {
    StatusSleep = 1;
    previousMillis = millis(); // запоминаем время

    UpdateScreen();
  }
}

void init_telegram(void)
{
  bot.setChatID("");  // передай "" (пустую строку) чтобы отключить проверку
  bot.skipUpdates();  // пропустить непрочитанные сообщения
  bot.attach(newMsg); // обработчик новых сообщений

  bot.sendMessage("WebRadio_bot Restart OK", ADMIN_CHAT_ID);
  Serial.println("Message to telegram was sended");
  // strip.setPixelColor(0, strip.Color(127, 0, 127));
  // strip.setPixelColor(1, strip.Color(127, 0, 127));

  bot.sendMessage(timeClient.getFormattedTime(), ADMIN_CHAT_ID);
}

// обработчик сообщений
void newMsg(FB_msg &msg)
{
  String chat_id = msg.chatID;
  String text = msg.text;
  String firstName = msg.first_name;
  String lastName = msg.last_name;
  String userID = msg.userID;
  String userName = msg.username;

  bot.notify(false);

  // выводим всю информацию о сообщении
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

    // обновление прошивки по воздуху из чата Telegram
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

      String time = "pong! Сообщение принято в ";
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
      bot.showMenuText("Команды:", "\ping \t \restart", chat_id, false);
      delay(300);
      // strip.setPixelColor(7, strip.Color(0, 0, 0));
      // strip.show();
    }
  }
}