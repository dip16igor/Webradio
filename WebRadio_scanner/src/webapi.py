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

_scan = {"running": False, "done": 0, "total": 0, "started_at": None, "error": None}
_scan_lock = threading.Lock()
_cfg = None


def get_cfg():
    global _cfg
    if _cfg is None:
        _cfg = cfgmod.load_config()
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
    if for_export:
        where.append("lastcheckok = 1 AND fail_count = 0 AND auth_walled = 0")
    sql_where = ("WHERE " + " AND ".join(where)) if where else ""
    total = con.execute(f"SELECT COUNT(*) FROM stations {sql_where}", args).fetchone()[0]
    if for_export:
        cols = "name, url, genre"
        limit = min(int(params.get("limit", 500) or 500), 2000)
        rows = con.execute(
            f"SELECT {cols} FROM stations {sql_where} ORDER BY bitrate DESC NULLS LAST, id LIMIT ?",
            (*args, limit)).fetchall()
        return total, [{"name": r[0] or r[1], "url": r[1], "genre": r[2] or "radio"} for r in rows]
    sort = SORTS.get(params.get("sort", "bitrate_desc"), SORTS["bitrate_desc"])
    limit = min(int(params.get("limit", 50) or 50), 500)
    offset = max(int(params.get("offset", 0) or 0), 0)
    rows = con.execute(
        f"""SELECT id, url, name, genre, codec, bitrate, samplerate, channels,
                   country, station_country, city, ads_score, streamtitle, lastcheck, lastcheckok,
                   fail_count, approved, auth_walled, source
            FROM stations {sql_where} ORDER BY {sort} LIMIT ? OFFSET ?""",
        (*args, limit, offset)).fetchall()
    return total, [dict(r) for r in rows]


def scan_worker(limit):
    cfg = get_cfg()
    try:
        seeds = pipe.collect_seeds(cfg)
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


def relay_open(url, range_hdr=None, timeout=12):
    """Открыть upstream для релея. Возвращает ответ urllib (с редиректами)."""
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
    if range_hdr:
        headers["Range"] = range_hdr
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
            self._relay((params.get("url") or [""])[0], self.headers.get("Range"))
        else:
            self._static(u.path)

    def _relay(self, url, range_hdr):
        if not url or not url.startswith(("http://", "https://")):
            return self._json({"error": "bad url"}, 400)
        try:
            up = relay_open(url, range_hdr)
        except ValueError:
            return self._json({"error": "blocked host"}, 403)
        except urllib.error.HTTPError as e:
            return self._json({"error": f"upstream {e.code}"}, 502)
        except Exception as e:
            return self._json({"error": f"upstream {type(e).__name__}"}, 502)
        try:
            ctype = up.headers.get("Content-Type", "audio/mpeg")
            if up.status == 206 and up.headers.get("Content-Range"):
                self.send_response(206)
                self.send_header("Content-Range", up.headers["Content-Range"])
                if up.headers.get("Content-Length"):
                    self.send_header("Content-Length", up.headers["Content-Length"])
            else:
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
                _scan.update(running=True, done=0, total=0, started_at=time.time(), error=None)
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
        else:
            self._json({"error": "unknown endpoint"}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=None)
    args = ap.parse_args()
    cfg = get_cfg()
    port = args.port or cfg.get("web_port", 3100)
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"[webapi] scanner UI on :{port}, db={cfg['db_path']}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
