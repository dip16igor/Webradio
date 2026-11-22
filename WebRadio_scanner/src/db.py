"""SQLite-обёртка: схема из schema.sql, upsert станций, история проб."""
import os
import sqlite3

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

STATION_COLS = (
    "url", "url_resolved", "name", "description", "genre", "codec",
    "bitrate", "samplerate", "channels", "icy_br", "server_ip",
    "country", "station_country", "city", "lat", "lon", "source", "auth_walled",
    "ads_score", "talk_ratio", "streamtitle", "lastcheck",
    "lastcheckok", "fail_count", "approved",
)


def connect(db_path):
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    return con


def init_db(con):
    with open(os.path.join(BASE_DIR, "schema.sql"), encoding="utf-8") as f:
        con.executescript(f.read())
    # Миграция старых БД: колонка заявленной страны станции
    cols = [r[1] for r in con.execute("PRAGMA table_info(stations)").fetchall()]
    if "station_country" not in cols:
        con.execute("ALTER TABLE stations ADD COLUMN station_country TEXT")
    con.commit()


def upsert_station(con, row):
    """row: dict с подмножеством STATION_COLS. Возвращает id."""
    cur = con.execute("SELECT id, fail_count FROM stations WHERE url = ?", (row["url"],))
    old = cur.fetchone()
    cols = [c for c in STATION_COLS if c in row]
    if old is None:
        placeholders = ", ".join("?" for _ in cols)
        cur = con.execute(
            f"INSERT INTO stations ({', '.join(cols)}) VALUES ({placeholders})",
            tuple(row[c] for c in cols),
        )
        return cur.lastrowid
    ok = row.get("lastcheckok", 0)
    fail = 0 if ok else (old["fail_count"] or 0) + 1
    sets = ", ".join(f"{c} = ?" for c in cols if c != "url")
    vals = [row[c] for c in cols if c != "url"]
    con.execute(
        f"UPDATE stations SET {sets}, fail_count = ?, updated_at = datetime('now') WHERE id = ?",
        (*vals, fail, old["id"]),
    )
    return old["id"]


def add_check(con, station_id, ok, http_code=None, kbps=None, title=None):
    con.execute(
        "INSERT INTO checks (station_id, ok, http_code, kbps, title) VALUES (?, ?, ?, ?, ?)",
        (station_id, 1 if ok else 0, http_code, kbps, title),
    )


def fetch_candidates(con, min_bitrate=48, max_bitrate=320, limit=50):
    cur = con.execute(
        """SELECT id, url, name, genre, codec, bitrate, samplerate, channels,
                  country, city, source, streamtitle
           FROM stations
           WHERE lastcheckok = 1 AND fail_count = 0 AND approved = 0
             AND auth_walled = 0
             AND (bitrate IS NULL OR (bitrate BETWEEN ? AND ?))
           ORDER BY bitrate DESC NULLS LAST, id
           LIMIT ?""",
        (min_bitrate, max_bitrate, limit),
    )
    return [dict(r) for r in cur.fetchall()]
