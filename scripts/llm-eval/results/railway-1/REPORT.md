# LLM card-generation eval — run `railway-1` (2026-09-06)

Judge: `anthropic/claude-opus-5` ($4.31). Generation: 9 models × 120 cases, all resumed after OpenRouter's
20 rpm new-account limit was hit; every model ended with 120/120 schema-valid cards. Judge scored all
models on the same 117 cases (3 junk cases had no comparable output). Total run cost ≈ $8.2.

## Decision (formal rule)

**Pick: `openai/gpt-5.6-luna`** — the cheapest schema-perfect model within 5 % of the best Georgian
total (`anthropic/claude-opus-5`, 19.54/20; threshold 18.57/20).

| model | ka judge total | ≥ threshold | $/1000 cards |
| --- | --- | --- | --- |
| `anthropic/claude-opus-5` | 19.54 | yes | $15.93 |
| `anthropic/claude-sonnet-5` | 19.42 | yes | $6.71 |
| `google/gemini-3.7-flash` | 19.40 | yes | $2.01 |
| `openai/gpt-5.6-luna` | 19.09 | yes | $0.20 |
| `google/gemini-3.1-flash-lite` | 18.63 | yes | $0.48 |
| `deepseek/deepseek-v4-pro` | 18.61 | yes | $1.60 |
| `deepseek/deepseek-v4-flash` | 18.42 | no | $0.17 |
| `openai/gpt-5-mini` | 18.21 | no | $0.99 |
| `anthropic/claude-haiku-4.5` | 16.18 | no | $2.30 |

## Overall

| model | schema valid | auto checks | judge total | p50 ms | p95 ms | total $ | $/1000 cards |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `anthropic/claude-haiku-4.5` | 100.0% | 96.5% | 17.39/20 | 6427 | 7523 | $0.2757 | $2.2975 |
| `anthropic/claude-opus-5` | 100.0% | 99.5% | 19.65/20 | 6499 | 9787 | $1.9118 | $15.9314 |
| `anthropic/claude-sonnet-5` | 100.0% | 99.3% | 19.36/20 | 6712 | 10266 | $0.8049 | $6.7075 |
| `deepseek/deepseek-v4-flash` | 100.0% | 98.3% | 18.73/20 | 9331 | 25933 | $0.0202 | $0.1681 |
| `deepseek/deepseek-v4-pro` | 100.0% | 98.4% | 19.03/20 | 9140 | 23583 | $0.1916 | $1.5971 |
| `google/gemini-3.1-flash-lite` | 100.0% | 98.1% | 18.88/20 | 1045 | 1295 | $0.0573 | $0.4773 |
| `google/gemini-3.7-flash` | 100.0% | 99.3% | 19.46/20 | 5568 | 7998 | $0.2406 | $2.0051 |
| `openai/gpt-5-mini` | 100.0% | 98.8% | 18.60/20 | 6633 | 9275 | $0.1184 | $0.9863 |
| `openai/gpt-5.6-luna` | 100.0% | 99.6% | 18.94/20 | 5594 | 8636 | $0.0235 | $0.1955 |

Latency measured through OpenRouter with `max_tokens: 4000`; reasoning effort was capped only for OpenAI ids.

## Judge criteria (mean of 1–5, n = 117 for every model)

| model | translation | canonical | example | transcription | total |
| --- | --- | --- | --- | --- | --- |
| `anthropic/claude-haiku-4.5` | 4.43 | 4.68 | 4.17 | 4.12 | 17.39 |
| `anthropic/claude-opus-5` | 4.85 | 4.94 | 4.91 | 4.95 | 19.65 |
| `anthropic/claude-sonnet-5` | 4.86 | 4.92 | 4.80 | 4.77 | 19.36 |
| `deepseek/deepseek-v4-flash` | 4.58 | 4.81 | 4.68 | 4.66 | 18.73 |
| `deepseek/deepseek-v4-pro` | 4.80 | 4.83 | 4.63 | 4.76 | 19.03 |
| `google/gemini-3.1-flash-lite` | 4.73 | 4.80 | 4.81 | 4.54 | 18.88 |
| `google/gemini-3.7-flash` | 4.91 | 4.94 | 4.79 | 4.82 | 19.46 |
| `openai/gpt-5-mini` | 4.69 | 4.80 | 4.57 | 4.53 | 18.60 |
| `openai/gpt-5.6-luna` | 4.82 | 4.93 | 4.82 | 4.37 | 18.94 |

## Per language (judge total)

| model | en | de | es | ka |
| --- | --- | --- | --- | --- |
| `anthropic/claude-haiku-4.5` | 18.55 | 18.40 | 18.70 | 16.18 |
| `anthropic/claude-opus-5` | 19.75 | 19.55 | 19.95 | 19.54 |
| `anthropic/claude-sonnet-5` | 19.50 | 19.35 | 19.05 | 19.42 |
| `deepseek/deepseek-v4-flash` | 19.25 | 19.45 | 18.35 | 18.42 |
| `deepseek/deepseek-v4-pro` | 19.45 | 19.50 | 19.30 | 18.61 |
| `google/gemini-3.1-flash-lite` | 18.85 | 18.95 | 19.55 | 18.63 |
| `google/gemini-3.7-flash` | 19.70 | 19.60 | 19.25 | 19.40 |
| `openai/gpt-5-mini` | 18.85 | 19.15 | 18.90 | 18.21 |
| `openai/gpt-5.6-luna` | 19.20 | 19.75 | 17.45 | 19.09 |

## Weakest Georgian cards (native check needed)

### `anthropic/claude-opus-5`

| case | input | front | back | example | exampleTr | judge | issue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ka-poly-kitxva | კითხვა | კითხვა | чтение, вопрос, читать | მასწავლებელს კითხვა დავუსვი. | Я задал учителю вопрос. | 17/20 | pos «noun»; перевод немного перегружен |
| ka-verb-tsera | წერა | წერა | писать, письмо (процесс) | წერილს ვწერ დედას. | Я пишу письмо маме. | 17/20 | порядок слов неестественный; форма წერა не использована |
| ka-conj-vtser | ვწერ | წერა | писать, письмо (процесс) | წერილს ვწერ დედას. | Я пишу письмо маме. | 18/20 | «письмо (процесс)» лишнее |
| ka-post-shi | -ში | -ში | в, внутри (где-то, куда-то) | სახლში ვარ. | Я дома. | 18/20 | лишний комментарий в переводе |
| ka-verb-daxmareba | დახმარება | დახმარება | помощь, помогать, поддержка | მადლობა დახმარებისთვის! | Спасибо за помощь! | 18/20 | смешение частей речи; pos=noun |
| ka-conj-vcham | ვჭამ | ჭამა | есть, кушать, еда | ვაშლს ვჭამ. | Я ем яблоко. | 19/20 | «еда» лишний третий смысл |
| ka-conj-vstsavlob | ვსწავლობ | სწავლა | учить, учиться, изучение | ქართულს ვსწავლობ. | Я учу грузинский. | 19/20 | смесь глагольных и именных значений |
| ka-ejective-mtsvadi | მწვადი | მწვადი | шашлык, мцвади | მწვადი ძალიან გემრიელია. | Шашлык очень вкусный. | 19/20 | «мцвади» — транслитерация |
| ka-ejective-qveli | ყველი | ყველი | сыр | მე ყველი მიყვარს. | Я люблю сыр. | 19/20 | порядок слов слегка неестественный |

### `anthropic/claude-sonnet-5`

| case | input | front | back | example | exampleTr | judge | issue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ka-verb-tsera | წერა | წერა | писать, письмо | მე წიგნს წერა მიყვარს. | Я люблю писать книгу. | 16/20 | неграмматично: должно быть «წიგნის წერა» |
| ka-number-otsi | ოცი | ოცი | двадцать | მას ოცი წელი აქვს. | Ему двадцать лет. | 17/20 | калька, неестественно для возраста |
| ka-post-shi | -ში | -ში | в, внутри | წიგნი მაგიდაში დევს. | Книга лежит в столе. | 17/20 | нужно მაგიდაზე |
| ka-post-tvis | -თვის | -თვის | для | შენთვის ეს საჩუქარია. | Этот подарок для тебя. | 18/20 | порядок слов |
| ka-reverse-kitxva | читать | კითხვა | читать | მე წიგნს ვკითხულობ. | Я читаю книгу. | 18/20 | пример со спряжённой формой |
| ka-typo-madlba | მადლბა | მადლობა | спасибо, благодарность | დიდი მადლობა შენ. | Большое спасибо тебе. | 18/20 | «დიდი მადლობა შენ» неестественно |
| ka-verb-gageba | გაგება | გაგება | понимание, понять | ენის გაგება მნიშვნელოვანია. | Понимание языка важно. | 18/20 | pos=noun вместо verb |

## Method notes

- First pass hit OpenRouter's 20 rpm limit for new accounts (78–100 failures per model) and GPT-5-mini
  returned empty content until reasoning effort was capped and `max_tokens` raised; all failures were
  re-run, and cases judged while some models lacked output were re-judged with the full set.
- Cost per 1000 cards is extrapolated from billed `usage.cost`, no prompt caching. Direct provider APIs
  with prompt caching would roughly halve the input part.
