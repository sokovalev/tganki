### tganki — English localization.

## Onboarding

onb-hello =
    Hi! I will help you learn words with flashcards.
    Interface language: { $lang }
onb-learn = Which language are we learning?
onb-target =
    Translate into?
    Your interface is in { $lang } — most people translate into that.
onb-lang-ask = Type the language name — for example "French" or the code fr.
onb-lang-unknown = I do not know that language. Try another name or a code, for example fr.
onb-level = What is your level?
onb-tz = Is it { $time } for you right now?
onb-tz-ask = Tell me your current time, for example 21:15.
onb-tz-bad = I could not read that time. Use the 21:15 format.
onb-tz-saved = Saved your timezone: { $offset }.
onb-reminder = When should I remind you?
onb-ready = All set. Shall we try? { $n ->
        [one] { $n } card
       *[other] { $n } cards
    }, one minute.
onb-unexpected = Let us finish the setup first.

## Main menu

menu-today = 📚 Today: { $due ->
        [one] { $due } review
       *[other] { $due } reviews
    } · { $new ->
        [one] { $new } new
       *[other] { $new } new
    }
menu-streak = 🔥 { $n ->
        [one] { $n } day
       *[other] { $n } days
    }
menu-decks = Active decks: { $decks }
menu-no-decks = No decks yet. Open the catalog or add your own word.

## Session

session-new = 🆕 new
# Introduction — the first showing of a new card (§3.2)
session-intro-new = 🆕 new word
session-snowball = Let us clear the backlog first — no new cards today.
card-actions-title = What should I do with "{ $word }"?

# Pick one of four (§3.2)
choice-question = What does it mean?
choice-right = ✅ Correct
choice-wrong = ❌ Wrong. The answer is: { $answer }

rating-again = Again
rating-hard = Hard
rating-good = Good
rating-easy = Easy

iv-lt-min = <1m
iv-min = { $n }m
iv-hour = { $n }h
iv-day = { $n }d
iv-month = { $n }mo
iv-year = { $n }y

summary-title = ✅ Session done · { $cards ->
        [one] { $cards } card
       *[other] { $cards } cards
    } · { $minutes } min
summary-ratings = Again { $again } · Hard { $hard } · Good { $good } · Easy { $easy }
summary-accuracy = Accuracy: { $accuracy } % · New learned: { $new }
summary-streak = 🔥 Streak: { $n ->
        [one] { $n } day
       *[other] { $n } days
    }
summary-remaining = Left for today: { $n ->
        [one] { $n } review
       *[other] { $n } reviews
    }

empty-title = Nothing left for today!
empty-next = Next cards: { $when } ({ $n ->
        [one] { $n } card
       *[other] { $n } cards
    })
empty-none = No new cards either — add your own words or subscribe to a deck.

when-today = today at { $time }
when-tomorrow = tomorrow at { $time }
when-date = { $date } at { $time }

leech-notice = The word "{ $word }" keeps slipping away. What now?

## Toasts

toast-already-rated = Already rated
toast-session-gone = This session is closed
toast-buried = Postponed until tomorrow
toast-suspended = Suspended
toast-known = Turned "{ $word }" off in every deck
toast-restored = Brought back { $n ->
        [one] { $n } card
       *[other] { $n } cards
    }
toast-reported = Thanks, we will look into it
toast-deleted = Deleted
toast-undone = Undone
toast-nothing-to-undo = Nothing to undo
toast-freeze = 🧊 A freeze saved your streak
toast-cancelled = Cancelled
toast-enriching = ✨ Filling the card in…
toast-unsubscribed = Unsubscribed
toast-stale = That message is outdated — send the word again

## Adding words

add-prompt = Which word should I add?
add-ask-hint = Or send a pair right away: word - translation
add-ask-translation = Translation for "{ $word }"?
add-target-deck = → into "{ $deck }"
add-duplicate-own = Already in "{ $deck }": { $word } — { $translation }.
add-duplicate-builtin = Found in "{ $deck }": { $word } — { $translation }.
add-done = ✅ Added to "{ $deck }": { $word } — { $translation }
add-bulk-done = ✅ Added { $added ->
        [one] { $added } word
       *[other] { $added } words
    }, skipped { $skipped } (already there).
add-bulk-invalid = Lines I could not parse: { $n }.
add-cancelled = Fine, nothing added.
add-expired = The word got lost, send it again.
add-choose-deck = Which deck should it go to?
add-generating = ⏳ Looking up a translation…
add-generate-failed = I could not fill the card in automatically.
add-generate-limit = No auto-fill left for today ({ $limit } a day). Send the translation yourself.
add-example-line = { $example } — { $exampleTr }
pos-label = { $pos ->
        [noun] noun
        [verb] verb
        [adjective] adj.
        [adverb] adv.
        [pronoun] pron.
        [numeral] num.
        [preposition] prep.
        [postposition] postp.
        [conjunction] conj.
        [particle] particle
        [interjection] interj.
        [determiner] det.
        [phrase] phrase
        [letter] letter
       *[other] { "" }
    }
## Words from a text (§4.3)

extract-ask = Send me a text and I will find the words you do not know yet.
extract-searching = 🔎 Looking for unknown words…
extract-found = 📝 Found { $n ->
        [one] { $n } word
       *[other] { $n } words
    }
extract-dropped = Already known: { $n }
extract-in-deck = in the "{ $deck }" deck
extract-all-known = { $n ->
        [one] The only word I found is one you already know: { $words }
       *[other] All { $n } words I found are ones you already know: { $words }
    }
extract-none = No unknown words in there.
extract-truncated = That is a long text — I took the first { $n } characters.
extract-native = That is your own language ({ $langTo }). Send me a text in the language you are learning: { $lang }.
extract-wrong-lang = This does not look like { $lang }. Send me a text in the language you are learning.
extract-wrong-lang-detected = This does not look like { $lang }, it looks like { $detected }. Send me a text in the language you are learning: { $lang }.
extract-no-llm = Finding words in a text needs the AI to be connected.
extract-limit = No text analysis left for today ({ $limit } per day). You can still add words one by one.
extract-failed = I could not read that text. Try again.
extract-adding = ⏳ Adding the words…
extract-nothing-selected = Nothing selected
extract-added = ✅ Added { $n ->
        [one] { $n } new word
       *[other] { $n } new words
    } to "{ $deck }"
extract-added-took = ✅ Added { $n ->
        [one] { $n } new word
       *[other] { $n } new words
    } to "{ $deck }" and took { $m } { $from } into your next session
extract-took = ✅ Took { $m ->
        [one] { $m } word
       *[other] { $m } words
    } { $from } into your next session
extract-from-deck = from the "{ $deck }" deck
extract-from-decks = from your decks
extract-added-none = Nothing new: you already have every word you picked.
extract-skipped = { $n ->
        [one] { $n } word was already yours — skipped it.
       *[other] { $n } words were already yours — skipped them.
    }
extract-budget-skipped = { $n ->
        [one] { $n } more word
       *[other] { $n } more words
    } left out: today's AI budget is spent.

add-limit-notes = The free plan holds { $limit ->
        [one] { $limit } word
       *[other] { $limit } words
    }. More comes with Pro.

## Decks

decks-title = 📖 My decks
decks-empty = Nothing here yet.
decks-counts = 🆕 { $fresh } · ⏰ { $due } · { $total } total
deck-stats = New: { $fresh } · Due today: { $due } · Learned: { $learned } · Total: { $total }
deck-settings = New per day: { $perDay } · Modes: { $modes }
deck-disabled = Switched off: { $n }
deck-per-day-default = default
deck-ask-per-day = How many new cards per day from this deck?
deck-ask-modes = Which modes should be on?
deck-ask-title = What should the deck be called?
deck-title-bad = The title cannot be empty.
deck-created = Deck "{ $title }" created.
deck-subscribed = Deck "{ $title }" added.
deck-delete-confirm = Delete the deck "{ $title }" with its words and progress?
deck-share =
    Link to "{ $title }":
    { $link }
deck-limit = Free plan limit: { $limit } own decks. More comes with Pro.
deck-personal = My words · { $lang }

catalog-title = 📚 Catalog · { $lang }
catalog-empty = No builtin decks for this language yet — add your own words.
catalog-row = { $title } · { $level } · { $total } words { $mark }

mode-recognition = word → translation
mode-recall = translation → word
mode-both = word → translation and back

## Statistics

stats-title = 📊 Statistics
stats-today = Today: { $reviews ->
        [one] { $reviews } review
       *[other] { $reviews } reviews
    } · accuracy { $accuracy } %
stats-week = Last 7 days: { $reviews ->
        [one] { $reviews } review
       *[other] { $reviews } reviews
    } · { $new } new · accuracy { $accuracy } %
stats-streak = 🔥 Streak: { $n ->
        [one] { $n } day
       *[other] { $n } days
    } (best { $best })
stats-cards =
    Cards: { $fresh } new · { $learning } learning · { $review } review · { $mature } learned
stats-forecast = Forecast: tomorrow { $tomorrow } · this week { $week }
stats-by-deck-title = 📊 By deck
stats-deck-row = learned { $learned } of { $total }, due today { $due }

## Settings

settings-title = ⚙️ Settings
settings-off = off
settings-ui-lang = Interface language: { $value }
settings-learn = Learning: { $value }
settings-target = Translate into: { $value }
settings-new-limit = New cards per day: { $value }
settings-reminder = Reminder: { $value }
settings-tz = Timezone: { $value } (now { $time })
settings-intervals = Show intervals: { $value }
settings-transcription = Transcription: { $value }
tr-mode-always = question and answer
tr-mode-answer = answer only
tr-mode-never = hidden
settings-new-style = New cards: { $value }
new-style-choice = pick one of four
new-style-reveal = show the answer
settings-retention = Desired retention: { $value }
settings-ask-ui-lang = Which language should I speak?
settings-ask-learn-lang = Which language are we learning?
settings-ask-target-lang = Which language should I translate into?
settings-ask-new-limit = How many new cards per day?
settings-ask-new-limit-custom = Send a number between 0 and 999.
settings-ask-reminder = When should I remind you?
settings-ask-retention = The higher the value, the more often cards come back.
settings-retention-pro = Retention tuning comes with Pro.
settings-new-style-pro = "Pick one of four" comes with Pro.
settings-new-limit-bad = I need a number between 0 and 999.
settings-ask-delete =
    This deletes your account, all words and all progress. It cannot be undone.
    Type { $word } to confirm.
settings-delete-cancelled = Nothing deleted.
settings-deleted = Your account and all data are gone. Send /start to begin again.

## Pro, help, payments

pro-soon =
    Pro is coming: unlimited decks and words, every builtin deck, finer control over reviews.
    Everything is free and unlimited for now.
pro-text =
    Pro lifts the free-plan limits: { $decks } own decks and { $notes } words.
    Paid with Telegram Stars.
paysupport-text =
    Questions about a payment — write here and we will sort it out.
    Star purchases can be refunded within 14 days on request.
help-text =
    How it works: the bot shows a card, you recall the translation and rate yourself honestly.
    The FSRS algorithm then decides when to show the word again.

    /learn — study
    /add — add a word (or send a pair: word - translation)
    /extract — find unknown words in a text
    /decks — decks and catalog
    /stats — statistics
    /settings — settings
    /undo — undo the last rating
unknown-command = I do not know that command. Check /help.

## Reminder

reminder-text = 📬 Today: { $due ->
        [one] { $due } review
       *[other] { $due } reviews
    } and { $new ->
        [one] { $new } new
       *[other] { $new } new
    } · ~{ $minutes } min.
reminder-streak = 🔥 A { $n ->
        [one] { $n } day
       *[other] { $n } days
    } streak — do not lose it.

## Buttons

btn-learn = ▶️ Study ({ $n })
btn-learn-deck = ▶️ Study this deck
btn-learn-now = ▶️ Study now
btn-add = ➕ Add a word
btn-add-more = ➕ One more
btn-add-anyway = ➕ Add anyway
btn-add-generated = ➕ Add
btn-own-translation = ✏️ My own translation
btn-close = ✖
btn-enrich = ✨ Fill in
btn-decks = 📖 Decks
btn-stats = 📊 Stats
btn-stats-decks = By deck
btn-settings = ⚙️ Settings
btn-menu = Menu
btn-back = ‹ Back
btn-cancel = ✖ Cancel
btn-yes = Yes
btn-no = No
btn-on = on
btn-off = off
btn-show-answer = 👁 Show answer
btn-skip = ⏭ Skip
btn-finish = ⏸ Finish
btn-card-menu = ✏️
btn-undo = ↩️ Undo
btn-choice-next = ▶️ Next
btn-intro-next = ▶️ Next
btn-continue = ▶️ Continue ({ $n })
btn-extra-new = ➕ { $n } more new
btn-known = ✅ I know it
btn-known-menu = ✅ Already know it
btn-suspend = ⏸ Suspend
btn-bury = 😴 Postpone to tomorrow
btn-report = ⚠️ Report a mistake
btn-delete-note = 🗑 Delete
btn-keep = Keep it
btn-other-lang = Other…
btn-other-deck = 📚 Another deck
btn-extract = 📝 Words from a text
btn-extract-add = ✅ Add selected ({ $n })
btn-select-all = Select all
btn-select-none = Clear all
btn-learn-new = ▶️ Learn the new ones
btn-level-a0 = Start with the alphabet
btn-level-a1 = Just starting (A1)
btn-level-a2 = Some basics (A2)
btn-level-b1 = Intermediate (B1)
btn-level-unknown = Not sure
btn-reminder-morning = 🌅 08:00
btn-reminder-day = ☀️ 13:00
btn-reminder-evening = 🌙 20:00
btn-reminder-off = No thanks
btn-go = ▶️ Let us go
btn-later = Later
btn-new-deck = ➕ New deck
btn-catalog = 📚 Catalog
btn-new-per-day = ⚙️ New per day
btn-per-day-default = Default
btn-modes = 🔁 Modes
btn-share = 🔗 Share
btn-restore-disabled = ↩️ Bring back
btn-unsubscribe = ➖ Unsubscribe
btn-delete-deck = 🗑 Delete deck
btn-delete-confirm = 🗑 Delete
btn-set-ui-lang = Interface language
btn-set-learn-lang = Learning language
btn-set-target-lang = 🌐 Translation language
btn-set-new-limit = New per day
btn-set-reminder = Reminder
btn-set-tz = Timezone
btn-set-intervals = Intervals
btn-set-transcription = Transcription
btn-set-retention = Retention
btn-set-new-style = 🆕 New cards
btn-delete-account = 🗑 Delete account
btn-custom-number = Custom number
btn-pro = ⭐ Pro
btn-start-learning = ▶️ Start

## Admin

admin-title = 🛠 Admin
admin-users = Users: { $total } (today { $today })
admin-activity = Today: { $sessions } sessions, { $reviews } reviews
admin-reports = Open reports: { $n }
admin-grant-usage = Usage: /admin pro <tg_id> [days]
admin-granted = Granted Pro to { $tgId } until { $until }.
admin-reset-usage = Usage: /admin reset <tg_id>. Deletes cards, review history, sessions, known words and the streak; settings, decks and own words stay.
admin-reset-done = Reset progress for { $tgId }.

## Telegram commands

cmd-learn = study cards
cmd-add = add a word
cmd-decks = decks and catalog
cmd-stats = statistics
cmd-settings = settings
cmd-undo = undo the last rating
cmd-pro = about Pro
cmd-help = how it works
cmd-paysupport = payment questions
