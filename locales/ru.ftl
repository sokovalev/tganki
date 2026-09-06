### tganki — русская локализация.
### Тон: на «ты», коротко, без канцелярита.

## Онбординг

onb-hello =
    Привет! Помогу выучить слова по карточкам.
    Язык интерфейса: { $lang }
onb-learn = Какой язык учим?
onb-target =
    На какой язык переводить?
    Интерфейс у тебя на { $lang } — обычно переводят на него.
onb-lang-ask = Напиши название языка — например «французский» или код fr.
onb-lang-unknown = Не знаю такого языка. Напиши по-другому или введи код, например fr.
onb-level = Какой у тебя уровень?
onb-tz = Сейчас у тебя { $time }?
onb-tz-ask = Напиши, сколько у тебя сейчас времени, например 21:15.
onb-tz-bad = Не понял время. Напиши в формате 21:15.
onb-tz-saved = Записал часовой пояс: { $offset }.
onb-reminder = Когда напоминать?
onb-ready = Готово. Попробуем? { $n ->
        [one] { $n } карточка
        [few] { $n } карточки
       *[other] { $n } карточек
    }, одна минута.
onb-unexpected = Сначала закончим настройку.

## Главное меню

menu-today = 📚 На сегодня: { $due ->
        [one] { $due } повторение
        [few] { $due } повторения
       *[other] { $due } повторений
    } · { $new ->
        [one] { $new } новая
        [few] { $new } новых
       *[other] { $new } новых
    }
menu-streak = 🔥 { $n ->
        [one] { $n } день
        [few] { $n } дня
       *[other] { $n } дней
    }
menu-decks = Активные деки: { $decks }
menu-no-decks = Пока ни одной деки. Загляни в каталог или добавь своё слово.

## Сессия

session-new = 🆕 новое
# Знакомство — первый показ новой карточки (§3.2)
session-intro-new = 🆕 новое слово
session-snowball = Сначала разгребём повторения — новые сегодня не добавляю.
card-actions-title = Что сделать с «{ $word }»?

# Выбор из четырёх (§3.2)
choice-question = Что это значит?
choice-right = ✅ Верно
choice-wrong = ❌ Неверно. Правильно: { $answer }

rating-again = Снова
rating-hard = Трудно
rating-good = Хорошо
rating-easy = Легко

iv-lt-min = <1м
iv-min = { $n }м
iv-hour = { $n }ч
iv-day = { $n }д
iv-month = { $n }мес
iv-year = { $n }г

summary-title = ✅ Сессия завершена · { $cards ->
        [one] { $cards } карточка
        [few] { $cards } карточки
       *[other] { $cards } карточек
    } · { $minutes } мин
summary-ratings = Снова { $again } · Трудно { $hard } · Хорошо { $good } · Легко { $easy }
summary-accuracy = Точность: { $accuracy } % · Новых выучено: { $new }
summary-streak = 🔥 Стрик: { $n ->
        [one] { $n } день
        [few] { $n } дня
       *[other] { $n } дней
    }
summary-remaining = Осталось на сегодня: { $n ->
        [one] { $n } повторение
        [few] { $n } повторения
       *[other] { $n } повторений
    }

empty-title = На сегодня всё!
empty-next = Следующие карточки: { $when } ({ $n ->
        [one] { $n } карточка
        [few] { $n } карточки
       *[other] { $n } карточек
    })
empty-none = Новых карточек тоже нет — добавь свои слова или подпишись на деку.

when-today = сегодня в { $time }
when-tomorrow = завтра в { $time }
when-date = { $date } в { $time }

leech-notice = Слово «{ $word }» никак не даётся. Что делаем?

## Всплывающие подсказки

toast-already-rated = Уже оценено
toast-session-gone = Сессия уже закрыта
toast-buried = Отложил до завтра
toast-suspended = Приостановил
toast-known = Отключил «{ $word }» во всех деках
toast-restored = Вернул { $n ->
        [one] { $n } карточку
        [few] { $n } карточки
       *[other] { $n } карточек
    }
toast-reported = Спасибо, посмотрим
toast-deleted = Удалено
toast-undone = Откатил
toast-nothing-to-undo = Нечего отменять
toast-freeze = 🧊 Заморозка спасла стрик
toast-cancelled = Отменил
toast-enriching = ✨ Дополняю карточку…
toast-unsubscribed = Отписался
toast-stale = Это старое сообщение, отправь слово ещё раз

## Добавление слов

add-prompt = Какое слово добавить?
add-ask-hint = Можно сразу парой: слово - перевод
add-ask-translation = Перевод для «{ $word }»?
add-target-deck = → в деку «{ $deck }»
add-duplicate-own = Уже есть в «{ $deck }»: { $word } — { $translation }.
add-duplicate-builtin = Есть в «{ $deck }»: { $word } — { $translation }.
add-done = ✅ Добавил в «{ $deck }»: { $word } — { $translation }
add-bulk-done = ✅ Добавил { $added ->
        [one] { $added } слово
        [few] { $added } слова
       *[other] { $added } слов
    }, пропустил { $skipped } (уже есть).
add-bulk-invalid = Не разобрал строк: { $n }.
add-cancelled = Ок, ничего не добавляю.
add-expired = Слово потерялось, напиши его ещё раз.
add-choose-deck = В какую деку добавить?
add-generating = ⏳ Подбираю перевод…
add-generate-failed = Не удалось подобрать перевод автоматически.
add-generate-limit = Автоподбор на сегодня закончился ({ $limit } в день). Напиши перевод сам.
add-example-line = { $example } — { $exampleTr }
pos-label = { $pos ->
        [noun] сущ.
        [verb] глаг.
        [adjective] прил.
        [adverb] нареч.
        [pronoun] мест.
        [numeral] числ.
        [preposition] предл.
        [postposition] послелог
        [conjunction] союз
        [particle] частица
        [interjection] межд.
        [determiner] опред.
        [phrase] фраза
        [letter] буква
       *[other] { "" }
    }

## Слова из текста (§4.3)

extract-ask = Пришли текст — найду в нём незнакомые слова.
extract-searching = 🔎 Ищу незнакомые слова…
extract-found = 📝 Нашёл { $n ->
        [one] { $n } слово
        [few] { $n } слова
       *[other] { $n } слов
    }
extract-dropped = Уже знаешь: { $n }
extract-in-deck = в деке «{ $deck }»
extract-all-known = { $n ->
        [one] Единственное найденное слово ты уже знаешь: { $words }
        [few] Все { $n } найденных слова ты уже знаешь: { $words }
       *[other] Все { $n } найденных слов ты уже знаешь: { $words }
    }
extract-none = Незнакомых слов не нашёл.
extract-truncated = Текст длинный — взял первые { $n } символов.
extract-native = Это твой родной язык ({ $langTo }). Нужен текст на языке, который ты учишь: { $lang }.
extract-wrong-lang = Похоже, это текст не на том языке. Нужен текст на языке, который ты учишь: { $lang }.
extract-wrong-lang-detected = Похоже, это не { $lang }, а { $detected }. Нужен текст на языке, который ты учишь: { $lang }.
extract-no-llm = Чтобы находить слова в тексте, нужен подключённый ИИ.
extract-limit = Разбор текста на сегодня закончился ({ $limit } в день). Слова можно добавлять по одному.
extract-failed = Не получилось разобрать текст. Попробуй ещё раз.
extract-adding = ⏳ Добавляю слова…
extract-nothing-selected = Ничего не выбрано
extract-added = ✅ Добавил { $n ->
        [one] { $n } новое слово
        [few] { $n } новых слова
       *[other] { $n } новых слов
    } в «{ $deck }»
extract-added-took = ✅ Добавил { $n ->
        [one] { $n } новое слово
        [few] { $n } новых слова
       *[other] { $n } новых слов
    } в «{ $deck }» и взял { $m } { $from } в ближайшую сессию
extract-took = ✅ Взял { $m ->
        [one] { $m } слово
        [few] { $m } слова
       *[other] { $m } слов
    } { $from } в ближайшую сессию
extract-from-deck = из деки «{ $deck }»
extract-from-decks = из твоих дек
extract-added-none = Ничего нового: все выбранные слова у тебя уже есть.
extract-skipped = { $n ->
        [one] { $n } слово уже было у тебя — пропустил.
        [few] { $n } слова уже были у тебя — пропустил.
       *[other] { $n } слов уже были у тебя — пропустил.
    }
extract-budget-skipped = { $n ->
        [one] Ещё { $n } слово
        [few] Ещё { $n } слова
       *[other] Ещё { $n } слов
    } не добавил: на сегодня закончился лимит ИИ.

add-limit-notes = На бесплатном плане { $limit ->
        [one] { $limit } слово
        [few] { $limit } слова
       *[other] { $limit } слов
    }. Дальше — в Pro.

## Деки

decks-title = 📖 Мои деки
decks-empty = Пока пусто.
decks-counts = 🆕 { $fresh } · ⏰ { $due } · всего { $total }
deck-stats = Новых: { $fresh } · На сегодня: { $due } · Выучено: { $learned } · Всего: { $total }
deck-settings = Новых в день: { $perDay } · Режимы: { $modes }
deck-disabled = Отключено: { $n }
deck-per-day-default = по умолчанию
deck-ask-per-day = Сколько новых карточек в день из этой деки?
deck-ask-modes = Какие режимы включить?
deck-ask-title = Как назовём деку?
deck-title-bad = Название не может быть пустым.
deck-created = Дека «{ $title }» создана.
deck-subscribed = Дека «{ $title }» добавлена.
deck-delete-confirm = Удалить деку «{ $title }» вместе со словами и прогрессом?
deck-share =
    Ссылка на деку «{ $title }»:
    { $link }
deck-limit = Лимит бесплатного плана: { $limit } своих дек. Дальше — в Pro.
deck-personal = Мои слова · { $lang }

catalog-title = 📚 Каталог · { $lang }
catalog-empty = Для этого языка встроенных дек пока нет — добавляй свои слова.
catalog-row = { $title } · { $level } · { $total } слов { $mark }

mode-recognition = слово → перевод
mode-recall = перевод → слово
mode-both = слово → перевод и обратно

## Статистика

stats-title = 📊 Статистика
stats-today = Сегодня: { $reviews ->
        [one] { $reviews } повторение
        [few] { $reviews } повторения
       *[other] { $reviews } повторений
    } · точность { $accuracy } %
stats-week = За 7 дней: { $reviews ->
        [one] { $reviews } повторение
        [few] { $reviews } повторения
       *[other] { $reviews } повторений
    } · { $new } новых · точность { $accuracy } %
stats-streak = 🔥 Стрик: { $n ->
        [one] { $n } день
        [few] { $n } дня
       *[other] { $n } дней
    } (рекорд { $best })
stats-cards =
    Карточки: { $fresh } новых · { $learning } в изучении · { $review } на повторении · { $mature } выучены
stats-forecast = Прогноз: завтра { $tomorrow } · за неделю { $week }
stats-by-deck-title = 📊 По декам
stats-deck-row = выучено { $learned } из { $total }, на сегодня { $due }

## Настройки

settings-title = ⚙️ Настройки
settings-off = выключено
settings-ui-lang = Язык интерфейса: { $value }
settings-learn = Учу: { $value }
settings-target = Переводить на: { $value }
settings-new-limit = Новых карточек в день: { $value }
settings-reminder = Напоминание: { $value }
settings-streak-nudge = Напоминать о стрике: { $value }
settings-tz = Часовой пояс: { $value } (сейчас { $time })
settings-intervals = Показывать интервалы: { $value }
settings-transcription = Транскрипция: { $value }
tr-mode-always = в вопросе и ответе
tr-mode-answer = только в ответе
tr-mode-never = не показывать
settings-new-style = Новые карточки: { $value }
new-style-choice = выбор из четырёх
new-style-reveal = показать ответ
settings-retention = Желаемая запоминаемость: { $value }
settings-ask-ui-lang = На каком языке говорить?
settings-ask-learn-lang = Какой язык учим?
settings-ask-target-lang = На какой язык переводить?
settings-ask-new-limit = Сколько новых карточек в день?
settings-ask-new-limit-custom = Напиши число от 0 до 999.
settings-ask-reminder = Когда напоминать?
settings-ask-retention = Чем выше значение, тем чаще повторения.
settings-retention-pro = Настройка запоминаемости доступна в Pro.
settings-new-style-pro = «Выбор из четырёх» доступен в Pro.
settings-new-limit-bad = Нужно число от 0 до 999.
settings-ask-delete =
    Это удалит аккаунт, все слова и весь прогресс. Отменить будет нельзя.
    Напиши { $word }, чтобы подтвердить.
settings-delete-cancelled = Не удаляю.
settings-deleted = Аккаунт и все данные удалены. Напиши /start, чтобы начать заново.

## Pro, помощь, платежи

pro-soon =
    Pro скоро появится: безлимитные деки и слова, все встроенные деки, тонкая настройка повторений.
    Пока всё бесплатно и без ограничений.
pro-title = ⭐ <b>tganki Pro</b>
pro-text =
    Что даёт Pro:
    • свои деки и слова без ограничений (на Free — { $decks } деки и { $notes } слов)
    • AI-карточки без дневного лимита
    • «Слова из текста» без лимита
    • «Выбор из четырёх» на новых карточках
    • своя желаемая запоминаемость в настройках
pro-plan-free = Сейчас у тебя: Free.
pro-plan-pro = Сейчас у тебя: Pro до { $until }.
pro-plan-lifetime = Сейчас у тебя: Pro навсегда.
pro-admin-note = Лимиты выключены (PRO_ENABLED=false); товары видны только админам — для проверки оплаты.
pro-item-month = tganki Pro — месяц
pro-item-month-desc = Подписка на месяц: свои деки и слова без ограничений, AI-карточки и разбор текстов без дневного лимита. Продлевается автоматически, отменить можно в Telegram.
pro-item-year = tganki Pro — год
pro-item-year-desc = 365 дней Pro одним платежом, без автопродления.
pro-item-lifetime = tganki Pro — навсегда
pro-item-lifetime-desc = Pro навсегда, один платёж.
pro-item-test = tganki Pro — тест
pro-item-test-desc = Тестовая покупка: 1 день Pro за 1 звезду. Только для админов.
pay-subscribe = Подписка Pro — { $stars } ⭐ в месяц. Нажми кнопку, чтобы оплатить в Telegram.
pay-thanks = ⭐ Спасибо! Pro включён.
pay-renewed = ⭐ Подписка продлена.
pay-unknown = Платёж прошёл, но я не узнал товар. Напиши /paysupport — разберёмся и вернём деньги.
pay-rejected = Не могу принять этот платёж. Открой /pro и начни заново.
paysupport-text =
    Вопросы по оплате — напиши прямо сюда: что покупал, когда и на какую сумму.
    Возврат за покупку звёздами возможен в течение 14 дней после оплаты — просто попроси, вернём звёзды.
    Подписку можно отменить в Telegram: профиль бота → «Управление подпиской».
help-text =
    Как это работает: бот показывает карточку, ты вспоминаешь перевод и честно оцениваешь себя.
    Дальше алгоритм FSRS сам решает, когда показать слово снова.

    /learn — учить
    /add — добавить слово (можно сразу парой: слово - перевод)
    /extract — найти незнакомые слова в тексте
    /decks — деки и каталог
    /stats — статистика
    /settings — настройки
    /undo — отменить последнюю оценку
unknown-command = Не знаю такой команды. Посмотри /help.

## Напоминание

reminder-text = 📬 На сегодня: { $due ->
        [one] { $due } повторение
        [few] { $due } повторения
       *[other] { $due } повторений
    } и { $new ->
        [one] { $new } новая
        [few] { $new } новых
       *[other] { $new } новых
    } · ~{ $minutes } мин.
reminder-streak = 🔥 Стрик { $n ->
        [one] { $n } день
        [few] { $n } дня
       *[other] { $n } дней
    } — не потеряй.
streak-nudge-text = 🔥 Стрик { $n ->
        [one] { $n } день
        [few] { $n } дня
       *[other] { $n } дней
    } сгорит через { $hours ->
        [one] { $hours } час
        [few] { $hours } часа
       *[other] { $hours } часов
    }. Сегодня ещё ни одной карточки. Хватит и пяти минут.
streak-nudge-freeze = Заморозка спасёт стрик один раз, но лучше не тратить.

## Недельный отчёт

weekly-title = 📈 Неделя { $from } – { $to }
weekly-reviews = Повторений: { $reviews } · Точность: { $accuracy } %
weekly-new = Новых слов: { $new } · Выучено (стабильность ≥ { $mature } д): { $learned }
weekly-days = Дней с занятиями: { $days } из { $total } · 🔥 Стрик: { $streak }
weekly-hardest = Самые трудные: { $words }
weekly-forecast = Ближайшая неделя: ~{ $reviews ->
        [one] { $reviews } повторение
        [few] { $reviews } повторения
       *[other] { $reviews } повторений
    }
weekly-idle =
    На этой неделе не было занятий. { $n ->
        [0] Начнём заново — хватит и пяти минут.
       *[other] 🔥 Стрик: { $n ->
            [one] { $n } день
            [few] { $n } дня
           *[other] { $n } дней
        } — вернись, пока он держится.
    }

## Кнопки

btn-learn = ▶️ Учить ({ $n })
btn-learn-deck = ▶️ Учить эту деку
btn-learn-now = ▶️ Учить сейчас
btn-add = ➕ Добавить слово
btn-add-more = ➕ Ещё слово
btn-add-anyway = ➕ Добавить всё равно
btn-add-generated = ➕ Добавить
btn-own-translation = ✏️ Свой перевод
btn-close = ✖
btn-enrich = ✨ Дополнить
btn-decks = 📖 Деки
btn-stats = 📊 Статистика
btn-stats-decks = По декам
btn-settings = ⚙️ Настройки
btn-menu = Меню
btn-back = ‹ Назад
btn-cancel = ✖ Отмена
btn-yes = Да
btn-no = Нет
btn-on = вкл
btn-off = выкл
btn-show-answer = 👁 Показать ответ
btn-skip = ⏭ Пропустить
btn-finish = ⏸ Закончить
btn-card-menu = ✏️
btn-undo = ↩️ Отменить
btn-choice-next = ▶️ Дальше
btn-intro-next = 📖 Не знаю
btn-continue = ▶️ Продолжить ({ $n })
btn-extra-new = ➕ Ещё { $n } новых
btn-known = ✅ Знаю
btn-known-menu = ✅ Уже знаю
btn-suspend = ⏸ Приостановить
btn-bury = 😴 Отложить до завтра
btn-report = ⚠️ Сообщить об ошибке
btn-delete-note = 🗑 Удалить
btn-keep = Оставить
btn-other-lang = Другой…
btn-other-deck = 📚 Другая дека
btn-extract = 📝 Слова из текста
btn-extract-add = ✅ Добавить выбранные ({ $n })
btn-select-all = Выбрать все
btn-select-none = Снять все
btn-learn-new = ▶️ Учить новые
btn-level-a0 = Начинаю с алфавита
btn-level-a1 = Начинаю (A1)
btn-level-a2 = Немного знаю (A2)
btn-level-b1 = Средний (B1)
btn-level-unknown = Не знаю
btn-reminder-morning = 🌅 08:00
btn-reminder-day = ☀️ 13:00
btn-reminder-evening = 🌙 20:00
btn-reminder-off = Не надо
btn-go = ▶️ Поехали
btn-later = Позже
btn-new-deck = ➕ Новая дека
btn-catalog = 📚 Каталог
btn-new-per-day = ⚙️ Новых в день
btn-per-day-default = По умолчанию
btn-modes = 🔁 Режимы
btn-share = 🔗 Поделиться
btn-restore-disabled = ↩️ Вернуть отключённые
btn-unsubscribe = ➖ Отписаться
btn-delete-deck = 🗑 Удалить деку
btn-delete-confirm = 🗑 Удалить
btn-set-ui-lang = Язык интерфейса
btn-set-learn-lang = Язык обучения
btn-set-target-lang = 🌐 Язык перевода
btn-set-new-limit = Новых в день
btn-set-reminder = Напоминание
btn-set-streak-nudge = 🔥 Про стрик
btn-set-tz = Часовой пояс
btn-set-intervals = Интервалы
btn-set-transcription = Транскрипция
btn-set-retention = Запоминаемость
btn-set-new-style = 🆕 Новые карточки
btn-delete-account = 🗑 Удалить аккаунт
btn-custom-number = Своё число
btn-pro = ⭐ Pro
btn-buy-month = ⭐ { $stars } / мес
btn-buy-year = ⭐ { $stars } / год
btn-buy-lifetime = ⭐ { $stars } навсегда
btn-buy-test = ⭐ { $stars } — тест на день
btn-start-learning = ▶️ Начать

## Админка

admin-title = 🛠 Админка
admin-users = Пользователей: { $total } (сегодня { $today })
admin-activity = Сегодня: сессий { $sessions }, оценок { $reviews }
admin-reports = Жалоб открыто: { $n }
admin-grant-usage = Использование: /admin pro <tg_id> [дней]
admin-granted = Выдал Pro для { $tgId } до { $until }.
admin-reset-usage = Использование: /admin reset <tg_id>. Удаляет карточки, историю повторений, сессии, известные слова и стрик; настройки, деки и свои слова остаются.
admin-reset-done = Сбросил прогресс для { $tgId }.
admin-refund-usage = Использование: /admin refund <charge_id>. Нужен telegram_payment_charge_id из таблицы payments.
admin-refund-failed = Telegram отказал в возврате: { $reason }
admin-refunded = Вернул { $stars } ⭐ пользователю { $tgId } за { $product }.
admin-refund-plan = План теперь: { $plan }, до { $until }.
admin-refund-plan-kept = План не трогал: это не последняя покупка.

## Команды Telegram

cmd-learn = учить карточки
cmd-add = добавить слово
cmd-decks = деки и каталог
cmd-stats = статистика
cmd-settings = настройки
cmd-undo = отменить последнюю оценку
cmd-pro = про Pro
cmd-help = как это работает
cmd-paysupport = вопросы по оплате
