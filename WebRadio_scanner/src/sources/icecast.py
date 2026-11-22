"""Источник: status-json.xsl публичных Icecast-серверов.

Один запрос отдаёт все маунты сервера (listenurl + server_name + genre).
Проверено на tower.hayva.ru (250+ маунтов). Не все станции сети там есть —
это дополнение к radio-browser, а не замена.
"""
import json
import urllib.request

UA = "WebRadio_scanner/1.0"


def fetch_status(server_url, timeout=15):
    req = urllib.request.Request(server_url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.load(resp)
    icestats = data.get("icestats", {})
    sources = icestats.get("source", [])
    if isinstance(sources, dict):
        sources = [sources]
    out = []
    for s in sources:
        url = s.get("listenurl")
        if not url or not url.startswith(("http://", "https://")):
            continue
        out.append({
            "url": url.strip(),
            "name": (s.get("server_name") or s.get("server_description") or "").strip()[:120] or None,
            "description": (s.get("server_description") or "").strip()[:300] or None,
            "genre": (s.get("genre") or "").strip()[:200] or None,
            "codec": (s.get("server_type") or "").replace("audio/", "").strip() or None,
            "bitrate": s.get("bitrate") or None,
            "country": None,
            "source": "icecast:" + _host(server_url),
        })
    return out


def _host(url):
    try:
        return urllib.request.urlparse(url).hostname or url
    except Exception:
        return url
