### tganki — русская локализация.
### Тон: на «ты», коротко, без канцелярита.

## Онбординг

onb-hello =
    Привет! Помогу выучить слова по карточкам.
    Язык интерфейса: { $lang }
onb-learn = Какой язык учим?
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
session-snowball = Сначала разгребём повторения — новые сегодня не добавляю.
card-actions-title = Что сделать с «{ $word }»?

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
toast-reported = Спасибо, посмотрим
toast-deleted = Удалено
toast-undone = Откатил
toast-nothing-to-undo = Нечего отменять
toast-freeze = 🧊 Заморозка спасла стрик
toast-cancelled = Отменил
toast-unsubscribed = Отписался

## Добавление слов

add-prompt = Какое слово добавить?
add-ask-hint = Можно сразу парой: слово - перевод
add-ask-translation = Перевод для «{ $word }»?
add-target-deck = → в деку «{ $deck }»
add-duplicate-own = Уже есть в «{ $deck }»: { $word } — { $translation }.
add-duplicate-builtin =
    Есть в «{ $deck }», позиция { $position }: { $word } — { $translation }.
add-done = ✅ Добавил в «{ $deck }»: { $word } — { $translation }
add-bulk-done = ✅ Добавил { $added ->
        [one] { $added } слово
        [few] { $added } слова
       *[other] { $added } слов
    }, пропустил { $skipped } (уже есть).
add-bulk-invalid = Не разобрал строк: { $n }.
add-too-long = Пока умею добавлять только короткие слова и фразы — до 40 символов.
add-cancelled = Ок, ничего не добавляю.
add-expired = Слово потерялось, напиши его ещё раз.
add-choose-deck = В какую деку добавить?
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
settings-pair = Учу: { $from } → { $to }
settings-new-limit = Новых карточек в день: { $value }
settings-reminder = Напоминание: { $value }
settings-tz = Часовой пояс: { $value } (сейчас { $time })
settings-intervals = Показывать интервалы: { $value }
settings-retention = Желаемая запоминаемость: { $value }
settings-ask-ui-lang = На каком языке говорить?
settings-ask-learn-lang = Какой язык учим?
settings-ask-new-limit = Сколько новых карточек в день?
settings-ask-new-limit-custom = Напиши число от 0 до 999.
settings-ask-reminder = Когда напоминать?
settings-ask-retention = Чем выше значение, тем чаще повторения.
settings-retention-pro = Настройка запоминаемости доступна в Pro.
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
pro-text =
    Pro снимает лимиты бесплатного плана: { $decks } своих деки и { $notes } слов.
    Оплата — звёздами Telegram.
paysupport-text =
    Вопросы по оплате — напиши сюда же, разберёмся.
    Возврат за покупку звёздами возможен в течение 14 дней по запросу.
help-text =
    Как это работает: бот показывает карточку, ты вспоминаешь перевод и честно оцениваешь себя.
    Дальше алгоритм FSRS сам решает, когда показать слово снова.

    /learn — учить
    /add — добавить слово (можно сразу парой: слово - перевод)
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

## Кнопки

btn-learn = ▶️ Учить ({ $n })
btn-learn-deck = ▶️ Учить эту деку
btn-learn-now = ▶️ Учить сейчас
btn-add = ➕ Добавить слово
btn-add-more = ➕ Ещё слово
btn-add-anyway = ➕ Добавить всё равно
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
btn-continue = ▶️ Продолжить ({ $n })
btn-extra-new = ➕ Ещё { $n } новых
btn-suspend = ⏸ Приостановить
btn-bury = 😴 Отложить до завтра
btn-report = ⚠️ Сообщить об ошибке
btn-delete-note = 🗑 Удалить
btn-keep = Оставить
btn-other-lang = Другой…
btn-other-deck = 📚 Другая дека
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
btn-unsubscribe = ➖ Отписаться
btn-delete-deck = 🗑 Удалить деку
btn-delete-confirm = 🗑 Удалить
btn-set-ui-lang = Язык интерфейса
btn-set-learn-lang = Язык обучения
btn-set-new-limit = Новых в день
btn-set-reminder = Напоминание
btn-set-tz = Часовой пояс
btn-set-intervals = Интервалы
btn-set-retention = Запоминаемость
btn-delete-account = 🗑 Удалить аккаунт
btn-custom-number = Своё число
btn-pro = ⭐ Pro
btn-start-learning = ▶️ Начать

## Админка

admin-title = 🛠 Админка
admin-users = Пользователей: { $total } (сегодня { $today })
admin-activity = Сегодня: сессий { $sessions }, оценок { $reviews }
admin-reports = Жалоб открыто: { $n }
admin-grant-usage = Использование: /admin pro <tg_id> [дней]
admin-granted = Выдал Pro для { $tgId } до { $until }.

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
