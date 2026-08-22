#!/usr/bin/env python3
"""Fetch the canonical station list from the WebRadio web server and write
best.json in the format used by webradio.py (list of {"name", "url"}).

Usage:
    python fetch_stations.py [--url URL] [--token TOKEN] [--output FILE]

Defaults:
    --url     https://webradio.dip17.freemyip.com/webradio/api/radio/stations
    --token   $WEBRADIO_TOKEN (required if not passed)
    --output  best.json
"""

import argparse
import json
import os
import sys
import urllib.request

DEFAULT_URL = "https://webradio.dip17.freemyip.com/webradio/api/radio/stations"


def fetch_stations(url: str, token: str) -> list:
    req = urllib.request.Request(url, headers={"X-Auth-Token": token})
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.load(resp)
    if not payload.get("success"):
        raise RuntimeError(f"Bad server response: {payload}")
    stations = payload["data"]["stations"]
    if not isinstance(stations, list) or not stations:
        raise RuntimeError("Server returned an empty station list")
    return stations


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_URL, help="stations API URL")
    parser.add_argument("--token", default=os.environ.get("WEBRADIO_TOKEN"),
                        help="secret token (or set WEBRADIO_TOKEN)")
    parser.add_argument("--output", default="best.json", help="output file")
    args = parser.parse_args()

    if not args.token:
        print("Error: no token. Pass --token or set WEBRADIO_TOKEN.", file=sys.stderr)
        return 1

    try:
        stations = fetch_stations(args.url, args.token)
    except Exception as exc:
        print(f"Error: failed to fetch station list: {exc}", file=sys.stderr)
        return 1

    # webradio.py expects [{"name", "url"}]
    slim = [{"name": s["name"], "url": s["url"]} for s in stations]
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(slim, f, ensure_ascii=False, indent=4)
    print(f"Saved {len(slim)} stations to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
