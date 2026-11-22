"""Загрузка конфига: config.json рядом с проектом, иначе дефолты из config.example.json."""
import json
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEFAULTS = {
    "db_path": "data/scanner.db",
    "timeout_sec": 12,
    "workers": 8,
    "radiobrowser_host": "de1.api.radio-browser.info",
    "radiobrowser_tags": ["chillout", "ambient", "lounge", "jazz", "downtempo", "lofi"],
    "radiobrowser_limit_per_tag": 100,
    "icecast_servers": ["https://tower.hayva.ru/status-json.xsl"],
    "geo_cache_hours": 24,
    "min_bitrate": 48,
    "max_bitrate": 320,
}


def load_config(path=None):
    cfg = dict(DEFAULTS)
    for cand in (path, os.path.join(BASE_DIR, "config.json"),
                 os.path.join(BASE_DIR, "config.example.json")):
        if cand and os.path.isfile(cand):
            try:
                with open(cand, encoding="utf-8") as f:
                    cfg.update(json.load(f))
                break
            except (OSError, ValueError):
                continue
    db = cfg.get("db_path", "data/scanner.db")
    if not os.path.isabs(db):
        cfg["db_path"] = os.path.join(BASE_DIR, db)
    return cfg
