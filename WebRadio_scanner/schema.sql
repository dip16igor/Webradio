-- WebRadio_scanner schema (SQLite)
-- stations: один ряд = один URL-кандидат, привязка по url (UNIQUE)
-- checks: история проб для отсева дохлых (3 фейла подряд -> карантин)

CREATE TABLE IF NOT EXISTS stations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  url           TEXT NOT NULL UNIQUE,
  url_resolved  TEXT,
  name          TEXT,
  description   TEXT,
  genre         TEXT,
  codec         TEXT,
  bitrate       INTEGER,
  samplerate    INTEGER,
  channels      INTEGER,
  icy_br        INTEGER,
  server_ip     TEXT,
  country       TEXT,
  station_country TEXT,
  city          TEXT,
  lat           REAL,
  lon           REAL,
  source        TEXT,
  auth_walled   INTEGER NOT NULL DEFAULT 0,
  ads_score     INTEGER,
  talk_ratio    REAL,
  streamtitle   TEXT,
  lastcheck     TEXT,
  lastcheckok   INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  approved      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stations_ok ON stations(lastcheckok, fail_count);
CREATE INDEX IF NOT EXISTS idx_stations_genre ON stations(genre);
CREATE INDEX IF NOT EXISTS idx_stations_source ON stations(source);

CREATE TABLE IF NOT EXISTS checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id  INTEGER NOT NULL REFERENCES stations(id),
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  ok          INTEGER NOT NULL,
  http_code   TEXT,
  kbps        REAL,
  title       TEXT
);

CREATE INDEX IF NOT EXISTS idx_checks_station ON checks(station_id, ts);
