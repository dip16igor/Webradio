# PlatformIO pre-script: carries our ESP32-audioI2S fixes across `pio pkg install`.
# .pio/libdeps is git-ignored and gets wiped on reinstall, so the patches live
# here and are re-applied (idempotently) before every build.
#
# 1) readMetadata(): guard against empty TCP read. _client->read() returns -1
#    when a chunked burst hasn't arrived yet; metalen = -1*16 = 65520 made the
#    parser eat up to 64KB of live audio as "metadata" and permanently desync
#    icy-metaint on chunked streams (relay stations replayed stale buffer).
# 2) HTTP/1.0 instead of 1.1 in both request builders. Infinite audio streams
#    gain nothing from chunked framing, and this legacy parser mishandles
#    chunk boundaries (sync loss + bogus bitrate + stale-buffer replay on
#    relay stations). Servers fall back to close-delimited bodies.
#
# Wired via `extra_scripts = pre:scripts/fix_audioI2S_chunked.py` in platformio.ini.

try:
    Import("env")
    project_dir = env["PROJECT_DIR"]
except Exception:
    import os
    project_dir = os.getcwd()  # manual run: execute from the project dir

import os

LIB = os.path.join(project_dir, ".pio", "libdeps", "wrover", "ESP32-audioI2S", "src", "Audio.cpp")

PATCH_1_OLD = "        int b = _client->read();   // First byte of metadata?"
PATCH_1_NEW = ("        int b = _client->read();   // First byte of metadata?\n"
               "        if(b < 0) return res;      // no data yet (chunked bursts) — retry next round, metacount stays 0")
PATCH_1_MARK = "if(b < 0) return res;"

V11 = 'rqh, " HTTP/1.1'
V10 = 'rqh, " HTTP/1.0'


def main():
    if not os.path.isfile(LIB):
        print("fix_audioI2S_chunked: lib not installed yet, skipping")
        return
    with open(LIB, "r", encoding="utf-8", errors="replace") as f:
        src = f.read()
    changed = []
    if PATCH_1_MARK not in src and PATCH_1_OLD in src:
        src = src.replace(PATCH_1_OLD, PATCH_1_NEW, 1)
        changed.append("readMetadata -1 guard")
    if V11 in src:
        n = src.count(V11)
        src = src.replace(V11, V10)
        changed.append("HTTP/1.0 x%d" % n)
    if changed:
        with open(LIB, "w", encoding="utf-8", newline="") as f:
            f.write(src)
        print("fix_audioI2S_chunked: applied (%s)" % ", ".join(changed))
    else:
        print("fix_audioI2S_chunked: already applied, nothing to do")


main()
