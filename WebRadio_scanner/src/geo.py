"""Геолокация стрим-сервера: DNS хоста -> ip-api.com, кэш по хосту.

Кэш — таблица geo_cache в той же SQLite-БД (TTL настраивается, дефолт 24 ч).
На приватные/локальные IP не ходим (SSRF-гейт как в WebRadio /geo).
"""
import json
import socket
import time
import urllib.parse
import urllib.request
from .probe import host_of

_IP_API = "http://ip-api.com/json/{ip}?fields=status,country,countryCode,city,lat,lon,query"


def _is_private_ip(ip):
    try:
        import ipaddress
        return ipaddress.ip_address(ip).is_private
    except ValueError:
        return True


def _resolve(host):
    try:
        return socket.getaddrinfo(host, None, socket.AF_INET)[0][4][0]
    except (socket.gaierror, IndexError):
        return None


def _fetch(ip, timeout=10):
    req = urllib.request.Request(
        _IP_API.format(ip=urllib.parse.quote(ip)),
        headers={"User-Agent": "WebRadio_scanner/1.0"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def _ensure_cache(con):
    con.execute(
        """CREATE TABLE IF NOT EXISTS geo_cache (
             host TEXT PRIMARY KEY, ip TEXT, country TEXT, city TEXT,
             lat REAL, lon REAL, ts REAL)"""
    )


def geo_lookup(con, url, cache_hours=24):
    """Возвращает dict {ip, country, city, lat, lon} или {unknown, reason}."""
    host = host_of(url)
    if not host:
        return {"unknown": True, "reason": "no-host"}
    _ensure_cache(con)
    row = con.execute("SELECT * FROM geo_cache WHERE host = ?", (host,)).fetchone()
    if row and (time.time() - row["ts"]) < cache_hours * 3600:
        return {"ip": row["ip"], "country": row["country"], "city": row["city"],
                "lat": row["lat"], "lon": row["lon"]}
    ip = _resolve(host)
    if not ip:
        return {"unknown": True, "reason": "dns-fail"}
    if _is_private_ip(ip):
        return {"unknown": True, "reason": "private-ip"}
    try:
        data = _fetch(ip)
    except Exception as e:
        return {"unknown": True, "reason": f"geo-api:{type(e).__name__}"}
    if data.get("status") != "success":
        return {"unknown": True, "reason": "geo-fail"}
    con.execute(
        """INSERT INTO geo_cache (host, ip, country, city, lat, lon, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(host) DO UPDATE SET ip=excluded.ip, country=excluded.country,
             city=excluded.city, lat=excluded.lat, lon=excluded.lon, ts=excluded.ts""",
        (host, ip, data.get("country"), data.get("city"),
         data.get("lat"), data.get("lon"), time.time()),
    )
    con.commit()
    return {"ip": ip, "country": data.get("country"), "city": data.get("city"),
            "lat": data.get("lat"), "lon": data.get("lon")}
