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


def collect_seeds(cfg):
    seeds, seen = [], set()

    def add(items):
        for it in items:
            u = (it.get("url") or "").strip()
            if u and u not in seen:
                seen.add(u)
                seeds.append(it)

    for tag in cfg.get("radiobrowser_tags", []):
        try:
            add(rb.search(cfg["radiobrowser_host"], tag=tag,
                          limit=cfg.get("radiobrowser_limit_per_tag", 100)))
        except Exception as e:
            print(f"[collect] radio-browser tag={tag}: {type(e).__name__}", flush=True)
    for srv in cfg.get("icecast_servers", []):
        try:
            add(ice.fetch_status(srv))
        except Exception as e:
            print(f"[collect] icecast {srv}: {type(e).__name__}", flush=True)
    return seeds


def process_one(db_path, item, cfg):
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
        "server_ip": None,  # geo дописывается под локом ниже
        "country": item.get("country"),
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
    con = dbmod.connect(cfg["db_path"])
    try:
        with _DB_LOCK:
            geo = geomod.geo_lookup(con, url, cache_hours=cfg.get("geo_cache_hours", 24))
            row["server_ip"] = geo.get("ip")
            if not row.get("country"):
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
    if probe_only:
        cur = con.execute(
            "SELECT url, name, description, genre, codec, bitrate, country, source "
            "FROM stations WHERE lastcheckok = 0 OR lastcheck IS NULL ORDER BY id LIMIT ?",
            (limit or 500,))
        seeds = [dict(r) for r in cur.fetchall()]
    else:
        seeds = collect_seeds(cfg)
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
        seeds = collect_seeds(cfg)
        if args.limit:
            seeds = seeds[:args.limit]
        for s in seeds:
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
