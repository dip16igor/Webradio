#!/bin/bash
# Деплой WebRadio_scanner на VPS Германии.
# Изоляция от прод-сервиса: свой каталог /opt/radioscanner, свой volume данных,
# контейнер 'radioscanner' БЕЗ публикуемых портов. /opt/webradio НЕ трогается.
set -euo pipefail

APP=/opt/radioscanner
DATA=$APP/data

echo "== radioscanner deploy =="
test -d "$APP" || { echo "Положи код в $APP (scp -r WebRadio_scanner germany:$APP) и повтори."; exit 1; }

# Прод-контейнер должен жить — сверяем ДО и ПОСЛЕ
echo "--- webradio-web-de ДО ---"
docker ps --format '{{.Names}} {{.Status}}' | grep -E 'webradio|radioscanner' || true

mkdir -p "$DATA"
cp -n "$APP/config.example.json" "$APP/config.json" 2>/dev/null || true

# Сервисный режим: долгоживущий HTTP-сервис (API + UI) на 127.0.0.1:3100.
# One-shot прогоны — кнопкой ▶ Скан из UI или tools/approve.py.
cd "$APP"
docker build -t radioscanner:1 .
docker rm -f radioscanner 2>/dev/null || true
docker run -d --name radioscanner --restart unless-stopped \
  -p 127.0.0.1:3100:3100 \
  --add-host host.docker.internal:host-gateway \
  -v "$DATA:/app/data" \
  radioscanner:1

echo "--- webradio-web-de ПОСЛЕ (должен быть Up) ---"
docker ps --format '{{.Names}} {{.Status}}' | grep -E 'webradio|radioscanner' || true
echo "Логи сканера: docker logs radioscanner | tail -20"
echo "БД: $DATA/scanner.db"
echo "Caddy: нужен handle_path /scanner* -> localhost:3100 (см. README)"
