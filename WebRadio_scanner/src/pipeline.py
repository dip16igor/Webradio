"""Оркестрация: сиды -> probe -> geo -> запись в БД.

Использование:
  python -m src.pipeline --once [--limit N]
  python -m src.pipeline --collect-only [--limit N]   # только сбор URL без проб
  python -m src.pipeline --probe-only [--limit N]     # только перепроверка непроверенных/упавших
"""
import argparse
import concurrent.futures as cf
import datetime
import sys
import os
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import db as dbmod
from src import geo as geomod
from src import probe as probemod
from src import classify as clf
from src import config as cfgmod
from src.sources import radiobrowser as rb
from src.sources import icecast as ice

_DB_LOCK = threading.Lock()
_BL = set()  # URL в чёрном списке: не пробовать и не обновлять
_BL_LOCK = threading.Lock()


def refresh_blacklist(db_path):
    con = dbmod.connect(db_path)
    try:
        with _BL_LOCK:
            _BL.clear()
            _BL.update(r[0] for r in con.execute(
                "SELECT url FROM stations WHERE blacklisted = 1").fetchall())
    finally:
        con.close()


def is_blacklisted(url):
    with _BL_LOCK:
        return url in _BL


def next_rotation(db_path):
    """Сквозной счётчик сканов (в БД) -> параметры выборки radio-browser.
    Режимы по кругу: топ по кликам -> хвост -> алфавитные срезы со сдвигом."""
    con = dbmod.connect(db_path)
    try:
        con.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)")
        row = con.execute("SELECT v FROM meta WHERE k = 'scan_seq'").fetchone()
        seq = int(row[0]) if row else 0
        con.execute("INSERT INTO meta (k, v) VALUES ('scan_seq', ?) "
                    "ON CONFLICT(k) DO UPDATE SET v = excluded.v", (str(seq + 1),))
        con.commit()
    finally:
        con.close()
    m = seq % 3
    if m == 0:
        return {"order": "clickcount", "reverse": True, "offset": 0, "label": "топ"}
    if m == 1:
        return {"order": "clickcount", "reverse": False, "offset": 0, "label": "хвост"}
    k = seq // 3
    return {"order": "name", "reverse": bool(k % 2), "offset": (k * 100) % 500,
            "label": f"алфавит/{'я-а' if k % 2 else 'а-я'}+{((k * 100) % 500)}"}


def collect_seeds(cfg, rotation=None):
    seeds, seen = [], set()
    rot = rotation or {"order": "clickcount", "reverse": True, "offset": 0}

    def add(items):
        for it in items:
            u = (it.get("url") or "").strip()
            if u and u not in seen:
                seen.add(u)
                seeds.append(it)

    for tag in cfg.get("radiobrowser_tags", []):
        try:
            add(rb.search(cfg["radiobrowser_host"], tag=tag,
                          limit=cfg.get("radiobrowser_limit_per_tag", 100),
                          order=rot.get("order", "clickcount"),
                          reverse=rot.get("reverse", True),
                          offset=rot.get("offset", 0)))
        except Exception as e:
            print(f"[collect] radio-browser tag={tag}: {type(e).__name__}", flush=True)
    for srv in cfg.get("icecast_servers", []):
        try:
            add(ice.fetch_status(srv))
        except Exception as e:
            print(f"[collect] icecast {srv}: {type(e).__name__}", flush=True)
    return seeds


def process_one(db_path, item, cfg):
    if is_blacklisted(item["url"]):
        return None, 0, "blacklisted"
    url, row, check = scan_url(item, cfg)
    sid = store_result(cfg, url, row, check)
    return sid, check["ok"], check.get("http_code")


def scan_url(item, cfg):
    """Чисто сетевая часть (без БД). Возвращает (url, row, check)."""
    url = item["url"]
    pr = probemod.probe(url, timeout=cfg.get("timeout_sec", 12))
    ok = pr["ok"]
    # SomaFM-паттерн: https 403 на ice*.somafm.com перепроверяем по http
    if not ok and pr["http_code"] == "403" and "somafm.com" in url and url.startswith("https://"):
        pr2 = probemod.probe("http://" + url[len("https://"):], timeout=cfg.get("timeout_sec", 12))
        if pr2["ok"]:
            pr = pr2
            url = "http://" + item["url"][len("https://"):]
            ok = 1
    # Zeno-паттерн: голый запрос 401 + браузерный 302/200 -> auth-walled
    auth_walled = pr.get("auth_walled", 0)
    if not ok and pr["http_code"] in ("401", "403") and "zeno" in url:
        bare = probemod.bare_check(url, timeout=10)
        if bare.get("http_code") in ("401", "403"):
            auth_walled = 1

    genre = clf.map_genre(item.get("genre") or pr.get("icy_genre"))
    ads_score, _notes = clf.ads_heuristics(
        pr.get("icy_name") or item.get("name") or "",
        pr.get("icy_description") or item.get("description") or "",
        item.get("genre") or pr.get("icy_genre") or "",
        pr.get("streamtitle") or "")

    bitrate = pr.get("icy_br") or item.get("bitrate")
    if pr.get("measured_kbps") and (not bitrate):
        # Замер по бурсту на быстрых серверах врёт в разы — принимать только
        # значения внутри разумного диапазона, иначе оставлять NULL.
        m = int(round(pr["measured_kbps"]))
        if cfg.get("min_bitrate", 48) <= m <= cfg.get("max_bitrate", 320):
            bitrate = m

    row = {
        "url": url,
        "url_resolved": item["url"] if url != item["url"] else None,
        "name": (pr.get("icy_name") or item.get("name")) or None,
        "description": (pr.get("icy_description") or item.get("description")) or None,
        "genre": genre,
        "codec": pr.get("codec") or item.get("codec") or None,
        "bitrate": bitrate,
        "samplerate": pr.get("icy_sr"),
        "channels": pr.get("icy_ch"),
        "icy_br": pr.get("icy_br"),
        "server_ip": None,  # гео дописывается в store_result
        "country": None,    # только гео сервера; заявленная — в station_country
        "station_country": item.get("country"),
        "city": None,
        "lat": None,
        "lon": None,
        "source": item.get("source"),
        "auth_walled": auth_walled,
        "ads_score": ads_score,
        "talk_ratio": None,
        "streamtitle": pr.get("streamtitle"),
        "lastcheck": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "lastcheckok": ok,
    }
    check = {"ok": ok, "http_code": pr.get("http_code"),
             "kbps": pr.get("measured_kbps"), "title": pr.get("streamtitle")}
    return url, row, check


def store_result(cfg, url, row, check):
    """Запись результата + geo. Соединение своё, запись под локом
    (sqlite-соединение нельзя шарить между потоками)."""
    if is_blacklisted(url) or is_blacklisted(row.get("url_resolved") or ""):
        return None
    con = dbmod.connect(cfg["db_path"])
    try:
        with _DB_LOCK:
            geo = geomod.geo_lookup(con, url, cache_hours=cfg.get("geo_cache_hours", 24))
            row["server_ip"] = geo.get("ip")
            if geo.get("ip"):
                # Гео сервера перетирает страну целиком: иначе смешиваются
                # заявленная страна станции (каталог) и город сервера (ip-api).
                row["country"] = geo.get("country")
            row["city"] = geo.get("city")
            row["lat"] = geo.get("lat")
            row["lon"] = geo.get("lon")
            sid = dbmod.upsert_station(con, row)
            dbmod.add_check(con, sid, check["ok"], check.get("http_code"),
                            check.get("kbps"), check.get("title"))
            con.commit()
        return sid
    finally:
        con.close()


def cmd_once(cfg, limit=None, probe_only=False):
    con = dbmod.connect(cfg["db_path"])
    dbmod.init_db(con)
    # geo-кэш создаём заранее в главном потоке, чтобы воркеры не гонялись за DDL
    with _DB_LOCK:
        geomod._ensure_cache(con)
        con.commit()
    refresh_blacklist(cfg["db_path"])
    if probe_only:
        cur = con.execute(
            "SELECT url, name, description, genre, codec, bitrate, country, source "
            "FROM stations WHERE blacklisted = 0 AND (lastcheckok = 0 OR lastcheck IS NULL) ORDER BY id LIMIT ?",
            (limit or 500,))
        seeds = [dict(r) for r in cur.fetchall()]
    else:
        rotation = next_rotation(cfg["db_path"])
        print(f"[pipeline] mode: {rotation.get('label')}", flush=True)
        seeds = collect_seeds(cfg, rotation)
        if limit:
            seeds = seeds[:limit]
    print(f"[pipeline] seeds: {len(seeds)}", flush=True)
    ok_n = 0
    with cf.ThreadPoolExecutor(max_workers=cfg.get("workers", 8)) as ex:
        futs = [ex.submit(process_one, cfg["db_path"], s, cfg) for s in seeds]
        for f in cf.as_completed(futs):
            try:
                _sid, ok, _code = f.result()
                ok_n += ok
            except Exception as e:
                print(f"[pipeline] item failed: {type(e).__name__}: {e}", flush=True)
    # запись и commit — внутри process_one под _DB_LOCK; здесь только итог
    cur = con.execute("SELECT COUNT(*), SUM(lastcheckok) FROM stations")
    total, oks = cur.fetchone()
    print(f"[pipeline] done. ok in batch: {ok_n}. DB total: {total}, alive: {oks}.", flush=True)
    con.close()


def main():
    ap = argparse.ArgumentParser(description="WebRadio_scanner pipeline")
    ap.add_argument("--once", action="store_true", help="один прогон")
    ap.add_argument("--collect-only", action="store_true")
    ap.add_argument("--probe-only", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--config", default=None)
    args = ap.parse_args()
    cfg = cfgmod.load_config(args.config)

    if args.collect_only:
        con = dbmod.connect(cfg["db_path"])
        dbmod.init_db(con)
        refresh_blacklist(cfg["db_path"])
        seeds = collect_seeds(cfg)
        if args.limit:
            seeds = seeds[:args.limit]
        for s in seeds:
            if is_blacklisted(s["url"]):
                continue
            dbmod.upsert_station(con, {
                "url": s["url"], "name": s.get("name"), "description": s.get("description"),
                "genre": clf.map_genre(s.get("genre")), "codec": s.get("codec"),
                "bitrate": s.get("bitrate"), "country": s.get("country"),
                "source": s.get("source"), "lastcheckok": 0,
                "lastcheck": None, "auth_walled": 0,
            })
        con.commit()
        print(f"[collect] saved {len(seeds)} seeds (unchecked).", flush=True)
        con.close()
        return

    cmd_once(cfg, limit=args.limit, probe_only=args.probe_only)


if __name__ == "__main__":
    main()
