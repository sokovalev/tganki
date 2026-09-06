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
| `PUBLIC_URL` | нет | — | публичный https-origin. Задан → бот работает через вебхук, пуст → long polling |
| `WEBHOOK_SECRET` | нет | — | секрет в пути вебхука и в заголовке `X-Telegram-Bot-Api-Secret-Token` |
| `ADMIN_TG_IDS` | нет | — | Telegram-id через запятую, кому доступна `/admin` |
| `PRO_ENABLED` | нет | `false` | включает лимиты бесплатного плана (`true`/`1`/`yes`/`on`) |
| `OPENROUTER_API_KEY` | нет | — | ключ OpenRouter. Задан → работают AI-заполнение карточек (§4.1a спеки) и «слова из текста» (§4.3), пуст → только ручной ввод |
| `LLM_MODEL` | нет | `google/gemini-3.7-flash` | id модели в OpenRouter |
| `LLM_REASONING_EFFORT` | нет | — | `low`/`medium`/`high`; отправляется только если задан (нужно моделям с рассуждением) |
| `LLM_TIMEOUT_MS` | нет | `15000` | таймаут одной попытки генерации |
| `LLM_BASE_URL` | нет | — | замена базового URL OpenRouter (прокси или мок) |
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
| `pnpm eval:run` / `eval:judge` / `eval:report` | офлайн-оценка моделей генерации, см. `scripts/llm-eval/README.md` |

## Запуск бота локально

1. Заведите **отдельного тестового бота** в @BotFather (`/newbot`), скопируйте токен в `BOT_TOKEN`.
2. Оставьте `PUBLIC_URL` пустым — тогда бот поднимается на long polling и никакой публичный
   адрес не нужен. `pnpm dev` сам вызовет `deleteWebhook` и начнёт опрашивать Telegram.
3. `pnpm migrate && pnpm seed`, затем `pnpm dev` — и пишите боту в личку `/start`.
4. Свой Telegram-id (узнать можно у @userinfobot) добавьте в `ADMIN_TG_IDS`, чтобы работала `/admin`.

### Вебхук против long polling

| | Когда | Что происходит на старте |
|---|---|---|
| long polling | `PUBLIC_URL` пуст (локальная разработка) | `deleteWebhook`, затем `bot.start()` |
| вебхук | `PUBLIC_URL` задан (прод) | `setWebhook` на `<PUBLIC_URL>/telegram/<WEBHOOK_SECRET>` c `secret_token`, `drop_pending_updates: false` |

Хендлер вебхука монтируется в тот же Hono-app, что и `/health`
(`webhookCallback(bot, "hono")`), поэтому отдельный процесс не нужен.
`setWebhook` идемпотентен и вызывается при каждом старте.

Напоминания крутит `startReminderCron` — `setInterval` раз в минуту, тики не накладываются
друг на друга, при ошибке тик логируется и цикл продолжается.

## Локализация

Строки лежат в `locales/<locale>.ftl` (Fluent, плагин `@grammyjs/i18n`), русский — основной.
Добавить язык = добавить файл и код в `SUPPORTED_LOCALES` (`src/i18n/index.ts`).

Одно ограничение Fluent, о которое легко споткнуться: **термы не принимают переменные**
(`{ -days(n: $n) }` не парсится, и `@fluent/bundle` молча выкидывает такое сообщение).
Поэтому плюрализация написана инлайн, селектом прямо в сообщении. Тест
`test/i18n.test.ts` проверяет, что каждое объявленное сообщение действительно попало
в бандл, что наборы ключей в ru и en совпадают и что все ключи из кода существуют.

Список языков обучения — статическая таблица `src/i18n/languages.ts` (код, флаг, эндоним,
названия ru/en, синонимы). LLM для этого не нужен: `createStaticLanguageResolver()`
(`src/llm/generator.ts`) закрывает контракт `LanguageResolver` этой же таблицей.

## Слой LLM

```
src/llm/
  types.ts       контракт с ботом: GenerateCardInput, GeneratedCard, GenerationError, CardGenerator,
                 ExtractWordsInput, ExtractedWords, WordExtractor
  prompt.ts      оба системных промпта (карточка и «слова из текста»), JSON Schema, zod-схемы,
                 постобработка, таблица IPA грузинского, проверка письменности языка
  openrouter.ts  клиент: json_schema + fallback на json_object, ретраи, Retry-After, таймаут, лимитер
  generator.ts   createOpenRouterCardGenerator(): промпт + клиент → CardGenerator
  extractor.ts   createOpenRouterWordExtractor(): §4.3, max_tokens 4000, без кэша
  cache.ts       withCache(): чтение-сквозь-кэш поверх generated_cache, generateWithMeta → { card, cached }
```

`prompt.ts` и `openrouter.ts` живут в `src/`, но их же импортирует харнесс оценки
(`scripts/llm-eval/*`) — так прогон меряет ровно то, что уходит в проде. В рантайм-образ
`scripts/` не попадает: `tsconfig.build.json` компилирует только `src/`.

Собирается всё в `createBot()` (`src/bot/index.ts`): при наличии `OPENROUTER_API_KEY`
создаётся `createOpenRouterCardGenerator(...)`, оборачивается в `withCache(..., createDbCacheStore(db))`
и передаётся в `createAddService(port, limits, llm)`. Тот же ключ и та же модель включают §4.3:
`createOpenRouterWordExtractor(...)` едет вместе с кэшируемым генератором в
`createExtractService({port, limits, add, llm})`. Без ключа оба сервиса получают `null`: бот
работает по ручному пути §4.1, а длинный текст отвечает «нужен подключённый ИИ» — ни один
экран больше не меняется.

**Как поменять модель.** Обычно достаточно `LLM_MODEL=<id>` (список — `GET /models` OpenRouter);
для моделей с рассуждением добавьте `LLM_REASONING_EFFORT=low`, иначе они тратят все токены на
размышления и возвращают пустой ответ. Прежде чем менять модель всерьёз, прогоните оценку:
`OPENROUTER_API_KEY=... pnpm eval:run --models a,b` → `pnpm eval:judge` → `pnpm eval:report`.
Правка промпта — только в `src/llm/prompt.ts`; она инвалидирует кэш промпта у провайдера
и делает прогоны разных дней несравнимыми, а если меняются сами карточки — поднимите
`CACHE_VERSION` в `src/llm/cache.ts`, чтобы `generated_cache` не отдавал старые ответы.

## Структура

```
src/
  config.ts          env + zod
  logger.ts          pino
  app.ts             Hono: /health, сюда же встанет вебхук Telegram
  main.ts            точка входа
  bot/               слой Telegram (см. ниже)
  i18n/              Fluent-обёртка и таблица языков
  llm/               генерация карточек и разбор текста: контракт, промпты, клиент OpenRouter, кэш
  services/          оркестрация поверх репозиториев (сессия, /add, лимиты, напоминания)
  reminders/         крон напоминаний и отправка
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
locales/*.ftl        строки интерфейса
test/                unit-тесты (без БД, на in-memory фейках)
```

Слой бота разложен по фичам, хендлеры тонкие, вся работа с БД — в `src/services`:

```
bot/
  index.ts           createBot({config, db, logger}) → {bot, start, stop, runReminders}
  context.ts         BotContext (grammY + i18n + ctx.user) и BotDeps
  middleware/user.ts загрузка/создание пользователя, выбор локали
  callbacks.ts       кодирование и разбор callback data (≤ 64 байт, `ns:action:args`)
  keyboards.ts       общие клавиатуры и таблица неймспейсов
  ui.ts              answer/show/send, распознавание ошибок Telegram
  format.ts          HTML-экранирование, интервалы, проценты
  time.ts            «сколько у тебя сейчас времени» → фиксированное смещение
  draft.ts           ревизии черновиков: `pending_payload` один на пользователя, поэтому каждая
                     кнопка везёт ревизию и тап по старому экрану отбивается тостом (§4.1, §11)
  extract.ts         «Слова из текста» (§4.3): чек-лист, переключатели, итог
  onboarding.ts menu.ts session.ts add.ts decks.ts stats.ts settings.ts admin.ts misc.ts
  router.ts          обычный текст: ожидаемый ввод важнее «добавить слово»
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

`pnpm test` — только чистая логика: ядро (scheduler, queue, streak, undo), парсер дек,
конфиг, разбор callback data, рендер экранов сессии, деки и меню на обоих языках, сервис сессии
(оценка → возврат в очередь → итог → продолжение, отмена, двойной пропуск = «до завтра»,
двойной тап игнорируется, «✅ Знаю» и отсев известных/дублирующихся слов — §3.7 спеки),
`/add` (обычный путь, дубликаты, пакетная вставка, лимиты),
генерацию карточек (кэш: попадание/промах/нормализация ключа/битый payload, маппинг ошибок
генератора на `GenerationError` через фейковый `fetch`, превью → сохранение, обратное направление,
дубликаты до и после генерации, откат на ручной ввод, дневной лимит и рендер превью),
ревизии черновиков (тап по старой кнопке ничего не делает, теряет клавиатуру и отвечает тостом),
«слова из текста» (§4.3: промпт и схема через фейковый `fetch`, постобработка и письменность,
длинный текст → чек-лист, переключатели, добавление выбранного с фейковым генератором, отсев
известных слов, чужой язык, вырезание ссылок, дневной лимит, поведение без ключа),
выбор пользователей для напоминаний и крон с фейковыми таймерами.

Доступ к БД спрятан за интерфейсами (`QueueRepo`, `UndoRepo`, `SessionPort`, `AddPort`,
`ExtractPort`, `ReminderPort`), в тестах используются in-memory фейки — Postgres для `pnpm test` не нужен.

## Деплой

Railway, Dockerfile-билд (`railway.json`, healthcheck `/health`).
Контейнер многостадийный (node:22-alpine, pnpm через corepack); при старте выполняется
`node dist/db/migrate.js && node dist/main.js`. В образ копируются `drizzle/` и `data/`,
так что `pnpm seed` можно запустить и в проде.
