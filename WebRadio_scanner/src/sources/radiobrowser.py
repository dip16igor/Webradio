"""Источник: radio-browser.info API (требует User-Agent)."""
import json
import urllib.parse
import urllib.request

UA = "WebRadio_scanner/1.0"


def search(host, name=None, tag=None, country=None, limit=100, timeout=15,
           hidebroken=True):
    params = {"limit": limit, "hidebroken": "true" if hidebroken else "false",
              "order": "clickcount", "reverse": "true"}
    if name:
        endpoint, params["name"] = "search", name
    elif tag:
        endpoint, params["tag"] = "stations/bytag", tag
    elif country:
        endpoint, params["country"] = "stations/bycountry", country
    else:
        raise ValueError("нужен name, tag или country")
    # bytag/bycountry идут отдельными путями без query-параметра tag/country
    if endpoint == "stations/bytag":
        url = f"https://{host}/json/{endpoint}/{urllib.parse.quote(params.pop('tag'))}"
    elif endpoint == "stations/bycountry":
        url = f"https://{host}/json/{endpoint}/{urllib.parse.quote(params.pop('country'))}"
    else:
        url = f"https://{host}/json/stations/{endpoint}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.load(resp)
    out = []
    for s in data:
        stream = s.get("url_resolved") or s.get("url")
        if not stream or not stream.startswith(("http://", "https://")):
            continue
        out.append({
            "url": stream.strip(),
            "name": (s.get("name") or "").strip()[:120] or None,
            "description": (s.get("description") or s.get("comment") or "").strip()[:300] or None,
            "genre": (s.get("tags") or "").strip()[:200] or None,
            "codec": (s.get("codec") or "").strip() or None,
            "bitrate": s.get("bitrate") or None,
            "country": s.get("country") or None,
            "source": "radio-browser",
        })
    return out
