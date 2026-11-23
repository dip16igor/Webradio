"""HTTP-сервис сканера: JSON API + статика из public/.

Запуск:  python -m src.webapi [--port N]
Зависимостей нет (stdlib). За Caddy живёт под /scanner
(handle_path режет префикс, поэтому тут все пути корневые: /api/..., /app.js).

API:
  GET  /api/status                          счётчики, последний чек, прогресс скана
  GET  /api/stations?q=&genre=&country=&alive=1&approved=&sort=&limit=&offset=
  GET  /api/genres                           жанры с количеством
  GET  /api/export?... (те же фильтры)       [{name, url, genre}] для PUT /stations
  POST /api/scan {limit}                     фоновый прогон (без дублей)
  GET  /api/scan                             {running, done, total}
  POST /api/approve {ids:[...]}              пометить approved=1
  POST /api/recheck {ids:[...]}              перепроверить выбранные фоном
"""
import argparse
import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")

import sys
sys.path.insert(0, BASE_DIR)

from src import config as cfgmod
from src import db as dbmod
from src import pipeline as pipe

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json",
        ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon"}

_scan = {"running": False, "done": 0, "total": 0, "started_at": None, "error": None, "mode": None}
_scan_lock = threading.Lock()
_cfg = None
_cfg_path = None


def get_cfg(path=None):
    global _cfg
    if _cfg is None:
        _cfg = cfgmod.load_config(path or _cfg_path)
        con = dbmod.connect(_cfg["db_path"])
        dbmod.init_db(con)
        from src import geo as geomod
        geomod._ensure_cache(con)
        con.commit()
        con.close()
    return _cfg


SORTS = {
    "bitrate_desc": "bitrate IS NULL, bitrate DESC, id",
    "bitrate_asc": "bitrate IS NULL, bitrate ASC, id",
    "name": "COALESCE(name, url) COLLATE NOCASE",
    "recent": "lastcheck DESC NULLS LAST, id",
    "country": "country COLLATE NOCASE, COALESCE(name, url) COLLATE NOCASE",
}


def query_stations(con, params, for_export=False):
    where, args = [], []
    if params.get("q"):
        where.append("(COALESCE(name,'') LIKE ? OR url LIKE ? OR COALESCE(streamtitle,'') LIKE ?)")
        args += [f"%{params['q']}%"] * 3
    if params.get("genre"):
        where.append("genre = ?")
        args.append(params["genre"])
    if params.get("country"):
        where.append("country = ?")
        args.append(params["country"])
    if params.get("alive") == "1":
        where.append("lastcheckok = 1 AND fail_count = 0 AND auth_walled = 0")
    if params.get("approved") == "0":
        where.append("approved = 0")
    elif params.get("approved") == "1":
        where.append("approved = 1")
    if params.get("blacklisted") == "1":
        where.append("blacklisted = 1")
    else:
        where.append("COALESCE(blacklisted, 0) = 0")
    if for_export:
        where.append("lastcheckok = 1 AND fail_count = 0 AND auth_walled = 0")
    sql_where = ("WHERE " + " AND ".join(where)) if where else ""
    total = con.execute(f"SELECT COUNT(*) FROM stations {sql_where}", args).fetchone()[0]
    if for_export:
        cols = "name, url, play_url, genre"
        limit = min(int(params.get("limit", 500) or 500), 2000)
        rows = con.execute(
            f"SELECT {cols} FROM stations {sql_where} ORDER BY bitrate DESC NULLS LAST, id LIMIT ?",
            (*args, limit)).fetchall()
        return total, [{"name": r[0] or r[1], "url": r[2] or r[1], "genre": r[3] or "radio"} for r in rows]
    sort = SORTS.get(params.get("sort", "bitrate_desc"), SORTS["bitrate_desc"])
    limit = min(int(params.get("limit", 50) or 50), 500)
    offset = max(int(params.get("offset", 0) or 0), 0)
    rows = con.execute(
        f"""SELECT id, url, name, genre, codec, bitrate, samplerate, channels,
                   country, station_country, city, ads_score, streamtitle, lastcheck, lastcheckok,
                   fail_count, approved, blacklisted, play_url, auth_walled, source
            FROM stations {sql_where} ORDER BY {sort} LIMIT ? OFFSET ?""",
        (*args, limit, offset)).fetchall()
    return total, [dict(r) for r in rows]


def scan_worker(limit):
    cfg = get_cfg()
    pipe.refresh_blacklist(cfg["db_path"])
    rotation = pipe.next_rotation(cfg["db_path"])
    with _scan_lock:
        _scan["mode"] = rotation.get("label")
    try:
        seeds = pipe.collect_seeds(cfg, rotation)
        if limit:
            seeds = seeds[:limit]
        with _scan_lock:
            _scan["total"] = len(seeds)
            _scan["done"] = 0
        for s in seeds:
            try:
                url, row, check = pipe.scan_url(s, cfg)
                pipe.store_result(cfg, url, row, check)
            except Exception as e:
                print(f"[webapi/scan] {s.get('url')}: {type(e).__name__}: {e}", flush=True)
            with _scan_lock:
                _scan["done"] += 1
    except Exception as e:
        with _scan_lock:
            _scan["error"] = f"{type(e).__name__}: {e}"
    finally:
        with _scan_lock:
            _scan["running"] = False


def recheck_worker(ids):
    cfg = get_cfg()
    pipe.refresh_blacklist(cfg["db_path"])
    try:
        con = dbmod.connect(cfg["db_path"])
        rows = con.execute(
            f"SELECT url, name, description, genre, codec, bitrate, country, source FROM stations "
            f"WHERE id IN ({','.join('?' for _ in ids)})", ids).fetchall()
        con.close()
        with _scan_lock:
            _scan["total"] = len(rows)
            _scan["done"] = 0
        for r in rows:
            try:
                url, row, check = pipe.scan_url(dict(r), cfg)
                pipe.store_result(cfg, url, row, check)
            except Exception:
                pass
            with _scan_lock:
                _scan["done"] += 1
    finally:
        with _scan_lock:
            _scan["running"] = False


RELAY_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "Chrome/126.0.0.0 Safari/537.36")


def relay_open(url, timeout=12):
    """Открыть upstream для релея. Возвращает ответ urllib (с редиректами).
    Range от клиента НЕ пробрасываем и всегда отдаём 200: часть
    Shoutcast-серверов отвечает 403 на Range, а seek живому радио не нужен."""
    from src import geo as geomod
    from urllib.parse import urlparse as _up
    host = _up(url).hostname or ""
    if not host:
        raise ValueError("bad url")
    ip = geomod._resolve(host)
    if not ip or geomod._is_private_ip(ip):
        raise ValueError("private/blocked host")
    headers = {"User-Agent": RELAY_UA, "Accept": "*/*",
               "Accept-Encoding": "identity", "Connection": "close",
               "Icy-MetaData": "0"}  # важно: без интерливинга метаданных, иначе декодер зациклится
    last_err = None
    for attempt in (0, 1):
        try:
            return urllib.request.urlopen(
                urllib.request.Request(url, headers=headers), timeout=timeout)
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (401, 403) and attempt == 0:
                time.sleep(1.5)  # Zeno-волны 401: повтор часто проходит
                continue
            raise
    raise last_err


def wr_request(base, method, path, token, body=None, timeout=20):
    """Запрос к API WebRadio. 401 -> PermissionError, остальное -> dict."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"X-Auth-Token": token,
                                          "Content-Type": "application/json",
                                          "User-Agent": "WebRadio_scanner/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise PermissionError("bad token")
        try:
            return json.load(e)
        except Exception:
            raise RuntimeError(f"http {e.code}")


def push_to_webradio(cfg, ids, token):
    """Append отмеченных в конец списка WebRadio. Возвращает отчёт."""
    base = (cfg.get("webradio_api") or
            "https://mirrorhub.space:8443/webradio/api/radio").rstrip("/")  # через Caddy: порт 3000 слушает только 127.0.0.1 хоста, из контейнера недоступен
    cur = wr_request(base, "GET", "/stations", token)
    if not cur.get("success"):
        raise RuntimeError(cur.get("message") or "stations failed")
    live = cur["data"]["stations"]
    if len(live) >= 255:
        raise RuntimeError("list full (255)")
    existing = {s.get("url") for s in live}
    con = dbmod.connect(cfg["db_path"])
    rows = con.execute(
        f"SELECT id, name, url, play_url, genre, auth_walled, COALESCE(blacklisted, 0) FROM stations "
        f"WHERE id IN ({','.join('?' for _ in ids)})", ids).fetchall()
    con.close()
    by_id = {r[0]: r for r in rows}
    added, skipped_dup, skipped_auth, errors = [], [], [], []
    for i in ids:
        r = by_id.get(i)
        if r is None:
            continue
        _id, name, url, play_url, genre, auth_walled, blacklisted = r[0], r[1], r[2], r[3], r[4], r[5], r[6]
        if blacklisted:
            continue
        stream = play_url or url
        if url in existing or stream in existing:
            skipped_dup.append(name or url)
            continue
        if auth_walled:
            skipped_auth.append(name or url)
            continue
        if not stream or len(stream) > 200 or not stream.startswith(("http://", "https://")):
            errors.append({"name": name or url, "error": "bad url"})
            continue
        try:
            res = wr_request(base, "POST", "/stations", token,
                             {"name": (name or stream)[:60], "url": stream,
                              "genre": genre or "radio"})
        except Exception as e:
            errors.append({"name": name or url, "error": str(e)})
            continue
        if res.get("success"):
            added.append(name or stream)
            existing.add(stream)
        else:
            errors.append({"name": name or stream,
                           "error": res.get("message") or "rejected"})
    return {"added": added, "added_n": len(added),
            "skipped_dup": skipped_dup, "skipped_auth": skipped_auth,
            "errors": errors}


class Handler(BaseHTTPRequestHandler):
    server_version = "ScannerHTTP/1.0"

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _static(self, path):
        rel = path.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(PUBLIC_DIR, rel))
        if not full.startswith(PUBLIC_DIR) or not os.path.isfile(full):
            full = os.path.join(PUBLIC_DIR, "index.html")
            if not os.path.isfile(full):
                self.send_error(404)
                return
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/status":
            cfg = get_cfg()
            con = dbmod.connect(cfg["db_path"])
            total, alive = con.execute(
                "SELECT COUNT(*), COALESCE(SUM(lastcheckok),0) FROM stations").fetchone()
            appr = con.execute("SELECT COUNT(*) FROM stations WHERE approved = 1").fetchone()[0]
            last = con.execute("SELECT MAX(ts) FROM checks").fetchone()[0]
            genres = con.execute(
                "SELECT COUNT(DISTINCT genre) FROM stations WHERE genre IS NOT NULL").fetchone()[0]
            con.close()
            with _scan_lock:
                sc = dict(_scan)
            self._json({"total": total, "alive": alive, "approved": appr,
                        "genres": genres, "last_check": last, "scan": sc})
        elif u.path == "/api/stations":
            cfg = get_cfg()
            con = dbmod.connect(cfg["db_path"])
            params = {k: v[0] for k, v in parse_qs(u.query).items()}
            total, rows = query_stations(con, params)
            con.close()
            self._json({"total": total, "rows": rows})
        elif u.path == "/api/genres":
            cfg = get_cfg()
            con = dbmod.connect(cfg["db_path"])
            rows = con.execute(
                "SELECT genre, COUNT(*) FROM stations WHERE genre IS NOT NULL "
                "GROUP BY genre ORDER BY 2 DESC").fetchall()
            con.close()
            self._json([{"genre": r[0], "n": r[1]} for r in rows])
        elif u.path == "/api/export":
            cfg = get_cfg()
            con = dbmod.connect(cfg["db_path"])
            params = {k: v[0] for k, v in parse_qs(u.query).items()}
            total, rows = query_stations(con, params, for_export=True)
            con.close()
            self._json({"total": total, "stations": rows})
        elif u.path == "/api/scan":
            with _scan_lock:
                self._json(dict(_scan))
        elif u.path == "/relay":
            params = parse_qs(u.query)
            self._relay((params.get("url") or [""])[0])
        else:
            self._static(u.path)

    def _relay(self, url):
        if not url or not url.startswith(("http://", "https://")):
            return self._json({"error": "bad url"}, 400)
        try:
            up = relay_open(url)
        except ValueError:
            return self._json({"error": "blocked host"}, 403)
        except urllib.error.HTTPError as e:
            return self._json({"error": f"upstream {e.code}"}, 502)
        except Exception as e:
            return self._json({"error": f"upstream {type(e).__name__}"}, 502)
        try:
            ctype = up.headers.get("Content-Type", "audio/mpeg")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            while True:
                chunk = up.read(65536)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
        finally:
            try:
                up.close()
            except Exception:
                pass

    def do_POST(self):
        u = urlparse(self.path)
        try:
            ln = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            ln = 0
        try:
            data = json.loads(self.rfile.read(ln).decode("utf-8") or "{}") if ln else {}
        except (ValueError, UnicodeDecodeError):
            return self._json({"error": "bad json"}, 400)
        if u.path == "/api/scan":
            with _scan_lock:
                if _scan["running"]:
                    return self._json({"started": False, "reason": "already running"})
                _scan.update(running=True, done=0, total=0, started_at=time.time(), error=None, mode=None)
            limit = int(data.get("limit") or 200)
            threading.Thread(target=scan_worker, args=(limit,), daemon=True).start()
            self._json({"started": True, "limit": limit})
        elif u.path == "/api/recheck":
            ids = [int(i) for i in (data.get("ids") or [])]
            if not ids:
                return self._json({"error": "no ids"}, 400)
            with _scan_lock:
                if _scan["running"]:
                    return self._json({"started": False, "reason": "already running"})
                _scan.update(running=True, done=0, total=len(ids), started_at=time.time(), error=None)
            threading.Thread(target=recheck_worker, args=(ids,), daemon=True).start()
            self._json({"started": True, "n": len(ids)})
        elif u.path == "/api/approve":
            ids = [int(i) for i in (data.get("ids") or [])]
            if not ids:
                return self._json({"error": "no ids"}, 400)
            cfg = get_cfg()
            con = dbmod.connect(cfg["db_path"])
            con.executemany("UPDATE stations SET approved = 1 WHERE id = ?", [(i,) for i in ids])
            con.commit()
            n = con.total_changes
            con.close()
            self._json({"approved": n})
        elif u.path == "/api/push":
            # Дописать отмеченные в конец списка WebRadio (append, без перезаписи).
            # Токен приходит из браузера каждый раз, на сервере не хранится.
            ids = [int(i) for i in (data.get("ids") or [])]
            token = (data.get("token") or "").strip()
            if not ids:
                return self._json({"error": "no ids"}, 400)
            if not token:
                return self._json({"error": "no token"}, 401)
            try:
                self._json(push_to_webradio(get_cfg(), ids, token))
            except PermissionError:
                self._json({"error": "bad token"}, 401)
            except Exception as e:
                self._json({"error": f"webradio: {type(e).__name__}"}, 502)
        elif u.path == "/api/genre":
            # Смена жанра одной станции (строго белый список).
            from src import classify as clf
            sid = int(data.get("id") or 0)
            genre = (data.get("genre") or "").strip()
            if not sid or genre not in clf.WHITELIST:
                return self._json({"error": "bad genre"}, 422)
            cfg = get_cfg()
            con = dbmod.connect(cfg["db_path"])
            con.execute("UPDATE stations SET genre = ?, updated_at = datetime('now') WHERE id = ?",
                        (genre, sid))
            con.commit()
            n = con.total_changes
            con.close()
            self._json({"updated": n, "genre": genre})
        elif u.path == "/api/blacklist":
            # Чёрный список: скрыть из выдачи и больше не пробовать при сканах.
            ids = [int(i) for i in (data.get("ids") or [])]
            on = data.get("on", True)
            if not ids:
                return self._json({"error": "no ids"}, 400)
            cfg = get_cfg()
            con = dbmod.connect(cfg["db_path"])
            con.executemany("UPDATE stations SET blacklisted = ? WHERE id = ?",
                            [(1 if on else 0, i) for i in ids])
            con.commit()
            n = con.total_changes
            con.close()
            pipe.refresh_blacklist(cfg["db_path"])
            self._json({"blacklisted": n, "on": bool(on)})
        else:
            self._json({"error": "unknown endpoint"}, 404)


def main():
    global _cfg_path
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--config", default=None)
    args = ap.parse_args()
    _cfg_path = args.config
    cfg = get_cfg()
    port = args.port or cfg.get("web_port", 3100)
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"[webapi] scanner UI on :{port}, db={cfg['db_path']}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
