# LLM eval: which model should generate our cards?

§4.1a of `docs/SPEC.md` turns one typed word into a full flashcard
(`GeneratedCard` in `src/llm/types.ts`). This harness runs that task on many
models through [OpenRouter](https://openrouter.ai), checks the answers
mechanically, has a strong model judge them blind, and prints the
quality-per-dollar table so we can pick one.

Georgian is the decision driver: 60 of the 120 cases are `ka`, because masdars,
ejectives and Mkhedruli are where cheap models fall apart.

## 1. Get an OpenRouter key

1. Sign in at <https://openrouter.ai>.
2. **Credits → Add credits**: OpenRouter is prepaid. A full sweep of the default
   line-up plus judging costs roughly **$10–15** (see §6), so **top up $20** and
   you can run it twice. Calls fail with a 402 the moment the balance hits zero,
   and the harness will record those as errors rather than crashing.
3. **Keys → Create key**. Copy it once; it is not shown again.
4. If a specific model answers 404 or "no endpoints found", check
   **Settings → Privacy**: some providers are only reachable once you allow
   prompt logging, and a few need a minimum balance.

```sh
export OPENROUTER_API_KEY=sk-or-v1-...
```

`OPENROUTER_BASE_URL` overrides the API host (a corporate proxy, or a local
fake while developing the harness). Nothing else reads the network.

## 2. The three commands

```sh
OPENROUTER_API_KEY=... pnpm eval:run      # call every model on every case
OPENROUTER_API_KEY=... pnpm eval:judge    # blind pairwise-style scoring
pnpm eval:report                          # tables, decision, REPORT.md
```

They are separate because `eval:run` is the expensive part and you will want to
re-judge or re-report without paying for it again.

### `pnpm eval:run`

| flag | default | meaning |
| --- | --- | --- |
| `--models a,b` | the 9 ids in `run.ts` | comma-separated OpenRouter ids |
| `--cases path` | `cases.json` | a different case file |
| `--out dir` | `results/` | results root |
| `--run id` | new timestamp | reuse an id to **resume** |
| `--repeat n` | `1` | calls per case, for measuring flakiness |
| `--concurrency n` | `4` | parallel requests |

Model ids are validated against `GET /models` before anything is spent; an
unknown id is skipped with a warning that lists the closest real ids. Every
(model, case, repeat) triple is written to
`results/<run-id>/<model-slug>.json` as it completes, so `Ctrl-C` costs you at
most one call: re-run with the same `--run <id>` and it picks up where it
stopped.

Requests ask for `response_format: json_schema` with `strict: true`. Providers
that reject it with a 400 are retried once with `json_object` and the schema
pasted into the system prompt; the record says which mode worked, and the
per-model summary counts the fallbacks. 429s and 5xx are retried up to three
times with exponential backoff; the timeout is 60 s per attempt.

### `pnpm eval:judge`

| flag | default | meaning |
| --- | --- | --- |
| `--run id` | newest run | which run to judge |
| `--judge id` | `anthropic/claude-opus-5` | the judge model |
| `--out dir` | `results/` | results root |
| `--concurrency n` | `4` | parallel requests |

One call per case: every model's card for that case is shuffled (deterministically,
seeded by the case id), labelled A/B/C…, and scored 1–5 on **translation
accuracy**, **canonical form**, **example naturalness** and **transcription
correctness**, plus a one-line issue per label. The judge sees the input and the
reference expectations but never a model name — the label→model map is resolved
afterwards and stored in `judge.json` for auditing. Resumable, and it prints the
judge's total cost.

### `pnpm eval:report`

Reads what the other two wrote (no key needed), prints a summary table and
writes `results/<run-id>/REPORT.md` with per-language tables and the ten
lowest-scored Georgian cards for each of the top two models — hand those to a
native speaker before committing to anything.

**Decision rule** (printed and written): among models with **100% schema
validity**, take the **cheapest** one whose **Georgian judge total is ≥ 95% of
the best Georgian total**. Schema validity is a hard gate because production has
no fallback: a card that does not parse is a broken user flow.

## 3. What is measured

Automatic checks (`checks.ts`, all pure and unit-tested — a check that does not
apply to a case is not counted):

| check | passes when |
| --- | --- |
| `schema` | the reply parsed and validated as `GeneratedCard` |
| `front_script` | `front` is non-empty and in `langFrom`'s script (ka → Mkhedruli only) |
| `detected_lang` | matches `expect.detectedLang` |
| `front` | equals `expect.front`, case- and whitespace-insensitive |
| `pos` / `pos_expected` | in the allowed list / equals `expect.pos` |
| `back` | contains one of `expect.backIncludesAny` (ё = е, substring match) |
| `transcription` | no slashes or brackets; for `ka`, non-empty and built only from our letter table |
| `example_uses_front` | the example contains the word or a form sharing its first three letters |
| `example_tr_cyrillic` | `exampleTr` is written in Cyrillic |

The Georgian letter table lives in `src/llm/prompt.ts` (`KA_LETTER_TABLE`) and is the
same one `data/decks/ka-ru-*.json` uses: aspirates marked `ʰ`, ejectives marked
`ʼ`, affricates with the tie bar, `ɑ ɛ ɔ` for `ა ე ო`. The prompt teaches the
table and the check enforces it, so a model that writes `kitxva` instead of
`kʼitʰxvɑ` is being marked against a rule it was given.

Four cases are junk (an emoji, a twelve-word sentence, `asdfgh`, a URL). For
them only `schema` is checked: we care that the model returns a valid object
instead of crashing the flow. Since the v2 prompt they should answer
`detectedLang: "und"` with empty fields — production reads that as "not a card"
and falls back to asking the user for a translation.

## 4. Adding models

Edit `DEFAULT_MODELS` in `run.ts`, or just pass `--models`:

```sh
pnpm eval:run --models openai/gpt-5-mini,qwen/qwen3-max --run 2026-09-06T12-00-00
```

Reusing an existing `--run` id adds the new model to that run without re-calling
the models already on disk, and `pnpm eval:judge --run <id>` will then re-judge
only cases it has not judged yet. (To fold a late model into an existing
judgement, delete `judge.json` and judge again — the judge scores all labels of
a case in one call.)

## 5. Adding cases

`cases.json` is a flat array of:

```jsonc
{
  "id": "ka-conj-vkitxulob",        // unique, prefix with the language
  "text": "ვკითხულობ",              // exactly what the user types
  "langFrom": "ka",                 // the language being learned
  "langTo": "ru",                   // always ru for now
  "category": "inflected",          // see CASE_CATEGORIES in types.ts
  "expect": {                       // every field optional
    "detectedLang": "ka",
    "front": "კითხვა",              // only when the canonical form is unambiguous
    "pos": "verb",
    "backIncludesAny": ["чита"]     // substrings, ё-insensitive
  },
  "note": "1sg present of 'read'; masdar is კითხვა."
}
```

Only add `expect.front` when there is one right answer — a wrong expectation
silently punishes good models. `test/llm-eval-cases.test.ts` enforces the
inventory: 120 cases, 20 en / 20 de / 20 es / 60 ka, unique ids, four junk
cases, and every Georgian `expect.front` written in Mkhedruli.

## 6. What a run costs

Token profile per card, measured against the prompt in `src/llm/prompt.ts`:

- input ≈ **740** tokens (≈ 700 system, including the Georgian letter table and
  four few-shot examples, plus ≈ 40 for the user turn),
- output ≈ **130** tokens.

So **one model over 120 cases ≈ 0.089 M input + 0.016 M output**, and the whole
nine-model sweep ≈ **0.80 M input + 0.14 M output**.

Cost for one model over the full case set is therefore
`0.089 × $in_per_M + 0.016 × $out_per_M`:

| price tier ($/M in, $/M out) | 120 cases |
| --- | --- |
| budget (0.10 / 0.40) | ≈ $0.02 |
| mid (1 / 5) | ≈ $0.17 |
| large (3 / 15) | ≈ $0.50 |
| frontier (15 / 75) | ≈ $2.50 |

The default line-up is roughly one frontier, three mid/large and five budget
models, so **`eval:run` ≈ $3–6**.

Judging is 120 calls of ≈ 2.5 k input (the case plus every model's card) and
≈ 0.5 k output → **0.30 M input + 0.06 M output**: ≈ **$9 on a frontier judge**,
≈ $2 on a large one, cents on a budget one. Judge quality is what the decision
rests on, so pay for the good judge.

**Total ≈ $10–15**, and `--repeat 2` doubles the `eval:run` half.

These are estimates for budgeting only. Every record stores the real
`usage.cost` OpenRouter billed, and the report's `$/1000 cards` column is
extrapolated from that — trust the report, not this table.

## 7. Caveats

- The judge only sees cards that parsed. A model that fails to produce valid
  JSON is not penalised in the judge means — it is disqualified by the 100%
  schema-validity gate instead.
- `usage.cost` is per-request and provider-dependent; a model routed to a free
  endpoint reports `$0` and shows `—` in the cost column.
- Latency is wall-clock through OpenRouter's router at concurrency 4, so treat
  p50/p95 as relative, not as an SLA.
- `results/` is gitignored except `REPORT.md`, so a run's conclusions can be
  committed without the raw dumps.

## 8. Files

The prompt and the OpenRouter client are **not** copies: they live in `src/llm/`
and the bot imports the very same modules (see `docs/DEV.md`, "Слой LLM"), so a
run here measures exactly what production sends. Changing the prompt therefore
changes the bot; re-run the eval when it does.

| file | what it is |
| --- | --- |
| `cases.json` | the 120 evaluation inputs |
| `../../src/llm/prompt.ts` | the production system prompt, JSON schema, zod validation, post-processing |
| `../../src/llm/openrouter.ts` | the production `fetch` client: structured output, fallback, retries, limiter, `listModels()` |
| `checks.ts` | the automatic checks (pure) |
| `judgePrompt.ts` | judge prompt, reply schema, blinding shuffle (pure) |
| `aggregate.ts` | aggregation, decision rule, Markdown rendering (pure) |
| `run.ts` / `judge.ts` / `report.ts` | the three commands |
| `store.ts` / `cli.ts` | results-on-disk layout and argument parsing |

## Запуск в контейнере (Railway)

`Dockerfile.eval` собирает образ, который при старте выполняет `run → judge → report`
и поднимает HTTP-сервер (`scripts/llm-eval/serve.ts`):

- `/report` — `REPORT.md` текущего прогона, `/log` — лог пайплайна, `/results/<файл>` — сырые JSON.
- Переменные: `OPENROUTER_API_KEY` (обязательно), `EVAL_OUT` (папка результатов, на Railway — волюм `/data/results`),
  `EVAL_RUN_ID` (по умолчанию `railway`), `EVAL_MODELS`, `EVAL_JUDGE` (необязательно).
- Все стадии возобновляемые: повторный деплой продолжает прерванный прогон, а не платит заново.
  `EVAL_RETRY_FAILED=1` (или `pnpm eval:run --retry-failed`) заново вызывает только неудачные записи.
  После каждой модели в лог печатается сводка самых частых ошибок.
  Чтобы начать с нуля, задайте новый `EVAL_RUN_ID`.
