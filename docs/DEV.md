# Разработка

Стек: Node 22 · TypeScript (strict, ESM) · pnpm · PostgreSQL + Drizzle · Hono · grammY · ts-fsrs · vitest · Biome.

## Быстрый старт

```bash
corepack enable
pnpm install
cp .env.example .env          # укажите DATABASE_URL и BOT_TOKEN
pnpm migrate                  # применить миграции
pnpm seed                     # загрузить деки из data/decks/*.json
pnpm dev                      # http://localhost:3000/health
```

Нужен только Postgres (15+). Локально проще всего:

```bash
docker run -d --name tganki-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
```

## Переменные окружения

Валидируются zod-схемой в `src/config.ts`, процесс падает на старте с понятным сообщением.

| Переменная | Обяз. | По умолчанию | Назначение |
|---|---|---|---|
| `DATABASE_URL` | да | — | строка подключения к Postgres |
| `BOT_TOKEN` | да | — | токен бота от @BotFather |
| `PORT` | нет | `3000` | порт HTTP-сервера |
| `PUBLIC_URL` | нет | — | публичный https-origin, понадобится для вебхука Telegram |
| `ANTHROPIC_API_KEY` | нет | — | ключ для AI-генерации карточек (пока не используется) |
| `NODE_ENV` | нет | `development` | `development` включает pretty-логи |
| `LOG_LEVEL` | нет | `info` | уровень pino |

## Скрипты

| Команда | Что делает |
|---|---|
| `pnpm dev` | сервер в watch-режиме через tsx |
| `pnpm build` | компиляция `tsc` в `dist/` |
| `pnpm start` | `node dist/main.js` |
| `pnpm migrate` | применяет миграции из `drizzle/` (в проде — `node dist/db/migrate.js`) |
| `pnpm seed [dir]` | грузит деки из `data/decks` (или из указанной папки) |
| `pnpm db:generate` | генерирует SQL-миграцию из `src/db/schema.ts` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` / `pnpm format` | Biome: проверка / автоисправление |
| `pnpm test` | vitest |

## Структура

```
src/
  config.ts          env + zod
  logger.ts          pino
  app.ts             Hono: /health, сюда же встанет вебхук Telegram
  main.ts            точка входа
  bot/index.ts       createBot(token) — пока без хендлеров
  core/
    scheduler.ts     обёртка над ts-fsrs: превью интервалов, применение оценки
    queue.ts         очередь сессии: просроченные → новые, лимиты, re-queue
    streak.ts        граница дня 04:00 в таймзоне юзера, стрик и заморозка
    undo.ts          откат последней оценки по снимку из review_logs
  db/
    schema.ts        Drizzle-схема (единственный источник правды по БД)
    index.ts         фабрика клиента postgres.js + ping
    migrate.ts       программное применение миграций
    repos/*.ts       тонкие типизированные запросы
  seed/decks.ts      загрузка встроенных дек из JSON
drizzle/             SQL-миграции (коммитятся в репозиторий)
data/decks/*.json    исходники встроенных дек
test/                unit-тесты ядра (без БД, на in-memory фейках)
```

## Миграции

Схема описывается только в `src/db/schema.ts`; SQL не пишется руками.

```bash
# 1. поменяли src/db/schema.ts
pnpm db:generate            # появится drizzle/000N_<name>.sql + снапшот в drizzle/meta
# 2. посмотрели глазами получившийся SQL
pnpm migrate                # применили локально
git add drizzle src/db/schema.ts
```

Имя миграции можно задать: `pnpm db:generate --name add_leech_counter`.
Миграции применяются автоматически при старте контейнера (см. `CMD` в `Dockerfile`).
Откатов drizzle-kit не делает — для отката пишется новая миграция.

## Деки

`pnpm seed` читает все `data/decks/*.json`, валидирует их zod-схемой из `src/seed/decks.ts`
и делает идемпотентный upsert: дека находится по `slug`, заметка — по паре `(deck_id, front)`.
Поэтому повторный сид сохраняет `notes.id`, а значит и прогресс пользователей по карточкам;
`position` пересчитывается по порядку в файле, а заметки, исчезнувшие из файла, удаляются.
Дубли `front` внутри одного файла игнорируются (остаётся первый).

Формат файла — см. `deckFileSchema`:

```json
{
  "slug": "en-ru-top-1000-a1",
  "title": "English Top 1000 · A1",
  "description": "...",
  "lang_from": "en",
  "lang_to": "ru",
  "level": "A1",
  "notes": [
    { "front": "reluctant", "back": "неохотный", "transcription": "rɪˈlʌktənt",
      "example": "She was reluctant to go.", "example_tr": "Она не хотела идти.",
      "tags": ["adjective"] }
  ]
}
```

## Тесты

`pnpm test` — только чистая логика (scheduler, queue, streak, undo, парсер дек, конфиг).
Доступ к БД спрятан за интерфейсами (`QueueRepo`, `UndoRepo`), в тестах используются
in-memory фейки, поэтому Postgres для `pnpm test` не нужен.

## Деплой

Railway, Dockerfile-билд (`railway.json`, healthcheck `/health`).
Контейнер многостадийный (node:22-alpine, pnpm через corepack); при старте выполняется
`node dist/db/migrate.js && node dist/main.js`. В образ копируются `drizzle/` и `data/`,
так что `pnpm seed` можно запустить и в проде.
