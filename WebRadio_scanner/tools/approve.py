"""Экспорт кандидатов в формат WebRadio (PUT /stations) — только на ручной approve.

Выводит JSON-список [{name, url, genre}] для станций, прошедших фильтр:
живые (lastcheckok=1, fail_count=0), не auth-walled, не approved, битрейт в диапазоне.
Дальше — глазами сверить и залить через admin-морду или PUT /stations (version-safe).

Использование:
  python tools/approve.py --min-bitrate 48 --max-bitrate 192 --limit 30 [--mark-approved]
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import config as cfgmod
from src import db as dbmod


def main():
    ap = argparse.ArgumentParser(description="Экспорт кандидатов для WebRadio")
    ap.add_argument("--min-bitrate", type=int, default=48)
    ap.add_argument("--max-bitrate", type=int, default=320)
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--mark-approved", action="store_true",
                    help="пометить выведенные approved=1, чтобы не предлагать снова")
    ap.add_argument("--config", default=None)
    args = ap.parse_args()

    cfg = cfgmod.load_config(args.config)
    con = dbmod.connect(cfg["db_path"])
    dbmod.init_db(con)
    rows = dbmod.fetch_candidates(con, args.min_bitrate, args.max_bitrate, args.limit)
    out = [{"name": r["name"] or r["url"], "url": r["url"],
            "genre": r["genre"] or "radio"} for r in rows]
    print(json.dumps(out, ensure_ascii=False, indent=2))
    if args.mark_approved and rows:
        con.executemany("UPDATE stations SET approved = 1 WHERE id = ?",
                        [(r["id"],) for r in rows])
        con.commit()
        print(f"[approve] marked {len(rows)} as approved.", file=sys.stderr)
    con.close()


if __name__ == "__main__":
    main()
