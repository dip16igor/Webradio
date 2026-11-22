"""Проверка потока без сторонних зависимостей (urllib).

GET с Range 0-65535 и Icy-MetaData: 1, читаем заголовки + до ~64 КБ тела:
- icy-* заголовки (name/genre/description/url/br, metaint, audio-info),
- первый StreamTitle (если сервер отдал metaint),
- замер kbps только по аудиобайтам (без interleaved-метаданных) за время приёма,
- угадывание кодека по content-type + расширению URL.

Возвращает dict: ok, http_code, content_type, codec, icy_*, streamtitle,
measured_kbps, audio_bytes, auth_walled, error.
"""
import re
import time
import urllib.request
from urllib.parse import urlparse

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "Chrome/126.0.0.0 Safari/537.36")
BODY_LIMIT = 65535
AUDIO_HINTS = ("audio/", "mp3", "aac", "ogg", "mpeg", "octet-stream", "force-download")


def _guess_codec(url, content_type):
    ct = (content_type or "").lower()
    if "aac" in ct or url.lower().endswith((".aac", ".m4a")):
        return "AAC"
    if "ogg" in ct or url.lower().endswith((".ogg", ".oga")):
        return "OGG"
    if "mpeg" in ct or "mp3" in ct or "octet-stream" in ct:
        return "MP3"
    if "flac" in ct:
        return "FLAC"
    return None


def _parse_stream_title(chunk, metaint):
    """Достаёт первый StreamTitle из интерливинга icy-metadata."""
    if not metaint or metaint <= 0 or len(chunk) <= metaint:
        return None
    pos = metaint
    if pos >= len(chunk):
        return None
    blocks = chunk[pos]
    meta_len = blocks * 16
    meta = chunk[pos + 1:pos + 1 + meta_len]
    m = re.search(rb"StreamTitle='([^']*)'", meta)
    if m:
        try:
            return m.group(1).decode("utf-8", "replace").strip() or None
        except Exception:
            return None
    return None


def probe(url, timeout=12, with_metadata=True):
    t0 = time.time()
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Range": "bytes=0-65535",
            "Accept": "*/*",
            "Icy-MetaData": "1" if with_metadata else "0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            code = resp.status
            headers = {k.lower(): v for k, v in resp.headers.items()}
            ctype = headers.get("content-type", "")
            metaint = None
            try:
                metaint = int(headers.get("icy-metaint", "") or 0) or None
            except ValueError:
                metaint = None
            t_recv = time.time()
            try:
                body = resp.read(BODY_LIMIT + 4096)
            except Exception:
                body = b""
            dt = max(time.time() - t_recv, 0.001)
            title = _parse_stream_title(body, metaint) if with_metadata else None
            if metaint:
                meta_overhead = sum(
                    body[i] * 16 + 1
                    for i in range(metaint, len(body), metaint + 1)
                    if i < len(body)
                )
                audio_bytes = max(len(body) - meta_overhead, 0)
            else:
                audio_bytes = len(body)
            kbps = round(audio_bytes * 8 / dt / 1000, 1) if audio_bytes else None

            ct_low = ctype.lower()
            is_audio = code in (200, 206, 202) and (
                ct_low.startswith("audio/") or any(h in ct_low for h in AUDIO_HINTS)
            )
            auth_walled = 1 if code in (401, 403) else 0
            return {
                "ok": 1 if is_audio else 0,
                "http_code": str(code),
                "content_type": ctype,
                "codec": _guess_codec(url, ctype),
                "icy_name": headers.get("icy-name"),
                "icy_genre": headers.get("icy-genre"),
                "icy_description": headers.get("icy-description"),
                "icy_url": headers.get("icy-url"),
                "icy_br": _to_int(headers.get("icy-br")),
                "icy_sr": _to_int(headers.get("ice-samplerate") or headers.get("icy-samplerate")),
                "icy_ch": _to_int(headers.get("ice-channels")),
                "streamtitle": title,
                "measured_kbps": kbps,
                "audio_bytes": audio_bytes,
                "auth_walled": auth_walled,
                "error": None if is_audio else f"http-{code}:{ctype or 'no-ctype'}",
                "elapsed": round(time.time() - t0, 2),
            }
    except Exception as e:
        msg = str(e)
        kind = "timeout" if "timed out" in msg.lower() else "conn-fail"
        return {"ok": 0, "http_code": "000", "content_type": None, "codec": None,
                "icy_name": None, "icy_genre": None, "icy_description": None,
                "icy_url": None, "icy_br": None, "icy_sr": None, "icy_ch": None,
                "streamtitle": None, "measured_kbps": None, "audio_bytes": 0,
                "auth_walled": 0, "error": f"{kind}:{type(e).__name__}",
                "elapsed": round(time.time() - t0, 2)}


def _to_int(v):
    try:
        return int(str(v).strip().split()[0]) if v else None
    except (ValueError, IndexError):
        return None


def bare_check(url, timeout=10):
    """Голый запрос без UA: нужен, чтобы отличить auth-walled (Zeno-паттерн) от мёртвых."""
    req = urllib.request.Request(url, headers={"Range": "bytes=0-1023"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return {"http_code": str(resp.status),
                    "content_type": resp.headers.get("Content-Type")}
    except Exception as e:
        return {"http_code": "000", "content_type": None, "error": type(e).__name__}


def host_of(url):
    try:
        return urlparse(url).hostname or ""
    except Exception:
        return ""
