# WebRadio_scanner — поисковик web-радиостанций

Сканер/накопитель кандидатов интернет-радио: сбор URL из каталогов,
проверка живости потоков, обогащение метаданными + гео, хранение в SQLite.

## Принцип изоляции

- Живой сервис `webradio-web-de` (`/opt/webradio`, `:3000`) НЕ трогается:
  сканер живёт отдельно — `/opt/radioscanner`, свой volume `/opt/radioscanner/data`,
  свой контейнер `radioscanner` (без публикуемых портов в v1, только CLI).
- Связь со станциями WebRadio — только чтением `stations.json` как сида
  и экспортом одобренных кандидатов в формате `PUT /stations`
  (ручной approve, правилом «подборка показывается до записи»).
- Жанры — только из белого списка (см. `src/classify.py`, 14 значений).

## Структура

```
WebRadio_scanner/
  schema.sql            # SQLite-схема (stations + checks)
  config.example.json   # пример конфига (копия → config.json, не в git)
  src/
    config.py           # загрузка конфига
    db.py               # SQLite-обёртка
    probe.py            # проверка потока: Range-запрос + icy-заголовки + StreamTitle + замер kbps
    geo.py              # DNS → ip-api.com, кэш по хосту 24 ч
    classify.py         # маппинг жанров на белый список + эвристики рекламы
    pipeline.py         # оркестрация: сиды → probe → geo → запись в БД
    webapi.py           # HTTP-сервис: JSON API + UI (порт web_port, дефолт 3100)
  public/               # веб-интерфейс: таблица, фильтры, скан, approve, экспорт
    sources/
      radiobrowser.py   # radio-browser.info API (требует UA)
      icecast.py        # разбор status-json.xsl публичных Icecast-серверов
  tools/
    approve.py          # экспорт кандидатов в формат WebRadio (на approve вручную)
  deploy/
    germany.sh          # установка на VPS Германии в /opt/radioscanner (без касания /opt/webradio)
  data/.gitkeep         # БД живёт на сервере, в репозиторий не коммитится
```

## Быстрый старт (Windows, локально)

```bash
cd F:/NextCloud/Webradio/WebRadio_scanner
cp config.example.json config.json   # config.json в git не идёт
python -m src.webapi                 # UI: http://127.0.0.1:3100/
# или CLI: python -m src.pipeline --once --limit 20
python tools/approve.py --min-bitrate 48 --limit 30
```

UI умеет: фильтры (поиск/жанр/страна/только живые/approve, сортировки),
кнопку ▶ Скан с прогрессом, прослушивание https-потоков, Approve галочками,
перепроверку отмеченных, экспорт JSON для WebRadio.

Зависимостей вне stdlib нет (`requirements.txt` пуст, `requests` не нужен —
всё на `urllib`, чтобы работало и на сервере без pip).

## Деплой на Германию

```bash
scp -r WebRadio_scanner germany:/opt/radioscanner
ssh germany 'bash /opt/radioscanner/deploy/germany.sh'
```

Сервис: контейнер `radioscanner` (`--restart unless-stopped`,
`127.0.0.1:3100:3100`, volume `/opt/radioscanner/data`).
Caddy: добавить рядом с webradio-блоком (аддитивно, прод не трогаем):

```
	handle_path /scanner* {
		reverse_proxy localhost:3100
	}
```

после чего `caddy validate --config /etc/caddy/Caddyfile && systemctl restart caddy`.
UI: https://mirrorhub.space:8443/scanner/ — ссылка-кнопка Scanner в шапке
WebRadio (`WebRadio_web/public/index.html`).

Детали — в `deploy/germany.sh`. Проверка неубиваемости прод-сервиса:
`docker ps --format '{{.Names}} {{.Status}}'` — `webradio-web-de` должен остаться `Up`.

## Методика проверки «второй ракурс»

Массовый таймаут одного хоста ≠ смерть: перепроверять те же URL с VPS
(`ssh germany 'curl ...'`), чтобы отличить гео-блок РФ от глобальной смерти.
SomaFM `ice*.somafm.com` по https отвечает 403 — перед вердиктом повторить по http.
Zeno `stream.zeno.fm` 401-ит первую попытку волнами — помечать `auth_walled=1`,
на ESP32 такие только через relay.
