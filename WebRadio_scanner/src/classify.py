"""Жанры и эвристики рекламы.

Белый список — те же 14 значений, что знают сервис и Android:
ambient, chill, chillout, downtempo, electronic, jazz, lofi, lounge,
nature, pop, radio, relax, rock, trip-hop.
"""
import re

WHITELIST = {"ambient", "chill", "chillout", "downtempo", "electronic",
             "jazz", "lofi", "lounge", "nature", "pop", "radio",
             "relax", "rock", "trip-hop"}

_ALIASES = {
    "chill-out": "chillout", "chill out": "chillout", "chillout": "chillout",
    "chill": "chill", "chillbeats": "chill", "chill beats": "chill",
    "downtempo": "downtempo", "downbeat": "downtempo",
    "trip hop": "trip-hop", "triphop": "trip-hop", "trip-hop": "trip-hop",
    "hiphop": "trip-hop", "hip-hop": "trip-hop",
    "lounge": "lounge", "bachelor": "lounge", "exotica": "lounge",
    "bossa": "lounge", "bossanova": "lounge", "bossa nova": "lounge",
    "ambient": "ambient", "drone": "ambient", "space": "ambient", "darkambient": "ambient",
    "electronic": "electronic", "electronica": "electronic", "edm": "electronic",
    "idm": "electronic", "house": "electronic", "deep house": "electronic",
    "techno": "electronic", "trance": "electronic", "vaporwave": "lofi",
    "lo-fi": "lofi", "lofi": "lofi",
    "jazz": "jazz", "smooth jazz": "jazz", "nu jazz": "jazz", "swing": "jazz",
    "funk": "jazz", "soul": "jazz",
    "rock": "rock", "indie": "rock", "alternative": "rock", "metal": "rock",
    "punk": "rock", "70s": "rock", "80s": "rock", "oldies": "rock",
    "pop": "pop", "top 40": "pop", "top40": "pop", "dance": "pop",
    "sleep": "relax", "meditation": "relax", "acoustic": "relax", "piano": "relax",
    "synthwave": "electronic", "synth": "electronic",
    "new age": "ambient", "new-age": "ambient",
    "world": "chill", "ethnic": "chill",
    "classical": "relax", "classic": "relax",
    "relax": "relax", "easy listening": "relax",
    "nature": "nature", "rain": "nature", "forest": "nature", "ocean": "nature",
    "birds": "nature", "talk": "radio", "news": "radio", "sports": "radio",
}

_TALK_HINTS = re.compile(
    r"talk|news|sport|podcast|interview|discussion|debate|sermon|preach", re.I)
_AD_HINTS = re.compile(
    r"\b(ad|ads|advert|commercial|sponsor|promo)\b|adbreak|advertisement", re.I)


def map_genre(raw):
    """Сырой icy-genre -> жанр белого списка или None."""
    if not raw:
        return None
    text = re.sub(r"[_\-/|;,+]", " ", raw.lower())
    for alias in sorted(_ALIASES, key=len, reverse=True):
        if alias in text:
            return _ALIASES[alias]
    for g in WHITELIST:
        if re.search(rf"\b{re.escape(g)}\b", text):
            return g
    return None


def ads_heuristics(name="", description="", genre="", streamtitle=""):
    """Грубые эвристики без прослушивания. Возвращает (ads_score 0-100, notes)."""
    blob = f"{name} {description} {genre} {streamtitle}"
    score, notes = 0, []
    if _TALK_HINTS.search(blob):
        score += 60
        notes.append("talk-hint")
    if _AD_HINTS.search(blob):
        score += 30
        notes.append("ads-hint")
    return min(score, 100), notes


def talk_ratio_placeholder():
    """Точное соотношение речь/музыка требует offline-аудиоанализа (VAD).
    Пока возвращаем None — поле talk_ratio заполнит будущий audio-пайплайн."""
    return None
