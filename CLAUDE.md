# StayBot — WhatsApp Hotel Reception Bot

> בוט וואטסאפ למלונות שמחליף את הקבלה. עובד 24/7, עברית + אנגלית, רב-מלונות (multi-tenant) בהמשך.
> A WhatsApp bot that fully replaces the hotel front desk. 24/7, Hebrew + English.

---

## 1. Project Goal (המטרה)

A production-grade WhatsApp concierge that replaces a hotel's front desk:

1. **Full check-in over WhatsApp** — collect guest details + stay details.
2. **Credit deposit at check-in** — pre-authorize a security deposit.
3. **AI concierge** — answer any guest question (hours, services, hotel info) in HE/EN.
4. **Smart department routing** — *understanding-based*, not a hard keyword list.
   "נשפך קפה" → housekeeping; "צריך מברשת שיניים" → housekeeping/supplies;
   "המזגן לא עובד" → maintenance. Routes email + WhatsApp to the dept, and updates the guest.
5. **Full check-out** — review every charge from the stay with the guest, then close.
6. **Safety / emergencies (קריטי)** — on injury, medical event, or danger (fire/gas):
   (a) immediately instruct the guest to call **101 / מד"א**, (b) immediately escalate to a
   **human** staff member (security/manager), never rely on the bot alone.
   Every urgent request must have a human-escalation path, and every incident must be logged.

**Payments note:** No live payment provider yet (Stripe is restricted in Israel; will move to an
Israeli provider such as **CardCom** after registering a business / עוסק). Therefore **all payment
code must live behind one isolated abstraction layer with a MOCK implementation** for now — it
behaves as if a deposit was taken and shows a confirmation, without charging. Swapping in a real
provider later must touch **one place only**.

**Future — full payment policy (לתעד, לא לבנות עכשיו):** today payments cover only the
check-in **security deposit** (authorize → capture/cancel at check-out). A complete system will
need a real **payment policy** on top of the same isolated provider layer:
- **Payment for the stay itself** (room nights / the actual reservation amount), not just a deposit.
- **Advances / deposits up front** (מקדמות) — partial pre-payment at booking, balance later.
- **Payment at reception on a different card** — let the guest settle (or top up) with a card other
  than the one used for the deposit authorization.
All of this must still flow through the single `payments/` abstraction (one place to swap providers)
— do not re-couple stay/advance/alternate-card charging to a specific vendor.

**Near-term target:** run **multiple hotels in parallel (multi-tenant)** with correct isolation
between hotels and stable state.

---

## 2. Current State (מצב נוכחי)

Single-file Node/Express app. Functional demo for ONE hotel ("Kempinski"), hardcoded.

### Files
| File | What it does | Status |
|------|--------------|--------|
| `server.js` | Express server. Twilio WhatsApp webhook (`POST /webhook`), dashboard API (`/api/*`), session reset endpoints, Stripe webhook mount, static dashboard. | Works (demo) |
| `bot.js` | **The brain.** `handleIncoming` orchestrates: language detect → welcome → check-in/out intent → check-in state machine → AI concierge (Claude) → `runActions` parses `[HK:...]`/`[MAINTENANCE:...]` tags and notifies staff. | Works, but fragile (see bugs) |
| `checkin.js` | Check-in / deposit / folio (bill) / check-out logic. Stay dates (`stayCheckIn`/`stayCheckOut`/`nights`) + accepted terms version live on the reservation. Deposit amount + hotel strings come from `config.js`. | Works |
| `checkin-routes.js` | Deposit / success / cancel / balance HTML pages + payment webhook. **All pages bilingual** — `pageLang()` picks HE/EN per guest (session → Accept-Language → HE), `shellPage()` is the shared HE/EN shell. | Works |
| `state.js` | **In-memory state** (`sessions`, `staffAlerts`, `stats`). `getSession`, `pushHistory`, `patchSession`, `logAlert`. Comment even says "swap for Redis/DB in production". | Works, NOT persistent, NOT multi-tenant |
| `config.js` | **Single hotel** config: `DEFAULTS` (in code) + `overrides` (persisted in DB, table `config`) → `hotelConfig = deepMerge(DEFAULTS, overrides)`. Identity, dept numbers/emails, times, WiFi, **detailed services** (spa treatments+prices, restaurant, gym, room service, laundry, pool, bar, breakfast), parking, **`local_area`** (concierge knowledge *outside* the hotel: nearby restaurants, attractions, tours, nightlife, shopping, transport), FAQ, welcome, `deposit_amount`, `terms`. `updateConfig` deep-merges + persists. ⚠️ All service/price/policy/area data is **sample data** — every hotel replaces it. | Works for 1 hotel only |
| `concierge/` | שכבת בקשות הקונסיירז' המבודדת. `ConciergeProvider` — הממשק + `REQUEST_TYPES` (taxi/restaurant/spa/tour/transfer/rental/gift/other); `MockConciergeProvider` — מקצה אסמכתא (`CNG-XXXXXX`) ומחזיר `status:"received"`, **לא מזמין כלום בפועל** — הביצוע הוא של הקונסיירז' האנושי שמקבל את ההתראה. נקודת החלפה אחת: `concierge/index.js`. | Works (mock) |
| `places/` | שכבת **חיפוש מקומות אמיתיים** מבודדת (Google Places API New — Text Search). `PlacesProvider` — הממשק + `PLACE_CATEGORIES` (מיפוי קטגוריה→`includedType`); `GooglePlacesProvider` — קורא ל-`places:searchText` עם `X-Goog-Api-Key` מ-`process.env.GOOGLE_PLACES_API_KEY` (**המפתח לעולם לא בקוד/לוג/גוף בקשה**), מנרמל שם/כתובת/דירוג/מחיר ומחשב מרחק (haversine); `MockPlacesProvider` — תוצאות דמו בלי רשת/מפתח, פורמט זהה. `util.js` — haversine + פורמט מרחק/מחיר. נקודת החלפה אחת: `places/index.js` (בוחר Google אם יש מפתח, אחרת mock; `PLACES_PROVIDER=mock` כופה mock). ה-AI מקבל את הכלי `search_nearby_places` (tool-use) ומכבד בקשה מדויקת (בשרי/כשר/טבעוני) דרך שדה `query`. | Works |
| `i18n.js` | `detectLang` / `detectLangSignal` (Hebrew unicode heuristic), `detectLanguageRequest` + `stripLanguageRequest` (בקשת מעבר שפה), `t` helper. | Works |
| `validate.js` | אימות קלט האורח: שם (דוחה גם *מילות פקודה* כמו "I want to check in"), מספר הזמנה, תמונת ת"ז, **תאריכי שהייה** (`validateStayDates` — פרסור חופשי HE/EN **מבוסס-תפקיד**: "עד"/"until" לפני תאריך = עזיבה) ו**אישור תנאים** (`validateTermsConfirmation` — דורש נוסח מפורש). + `stripInternalTags` (כולל תג **קטוע**). | Works |
| `idverify/` | שכבת אימות זהות מבודדת. `vision.js` — בדיקת Claude vision אמיתית **ומחמירה** (בודקת `shows_document`: סלפי/צילום מסך/תמונה אקראית → `is_id=false`; סף ביטחון 0.7); `MockIdProvider` — אוכף `ACCEPTED_DOC_TYPES = {id_card, passport}` **בקוד** (לא רק ב-prompt), ושומר את המסמך **מוצפן at-rest** (`crypto.js`, AES-256-GCM, קובץ `.enc`) — דמו מקומי, לא plaintext. הסבר הדחייה לאורח **גנרי** (לא נוקב בשם המסמך שנשלח). נקודת החלפה אחת: `idverify/index.js` (שם גם ה-hand-off העתידי ל-PMS). | Works |
| `e2e.test.mjs` | בדיקות end-to-end לזרימת הצ'ק אין, השפה, התגים והזהות (`npm test`). | Works |
| `index.html` (50KB) | Standalone dashboard/landing UI. | Present, not wired into the server flow as a tracked file |
| `package.json` | Deps: `@anthropic-ai/sdk`, `twilio`, `stripe`, `express`, `dotenv`, `uuid`. ESM (`"type":"module"`). | OK |

### What WORKS today
- WhatsApp in/out via Twilio.
- Bilingual AI concierge answers (Claude `claude-sonnet-4-6`).
- **Full concierge role** — not just a receptionist: local recommendations (restaurants,
  attractions, tours, nightlife, shopping) from **two real sources** — `config.local_area`
  (hotel-vetted) *and* **live Google Places search** (`places/`, tool `search_nearby_places`) for
  real nearby places when the curated list doesn't cover the exact request. The bot honours the
  exact ask (meat/kosher/dairy/vegan/cuisine) via the tool's `query`, and still may name *only*
  places one of those two sources actually returned — never invents. Arranging requests (taxi,
  table, spa, tour, rental, gifts/special requests) via `[CONCIERGE:<type>|<details>]` →
  `concierge/` layer, and proactive luxury-hotel closing offers.
  The prompt forbids promising a booking is *done* — the mock only passes the request to a human,
  so the bot says "I've passed it on", never "your table is reserved".
- **WhatsApp-clean output** — markdown tables are banned in the prompt (WhatsApp can't render
  them; guests saw `|---|---|`). Lists render as `• *name* (duration) — price`, and a
  conditional price (e.g. couples massage = for two people) must be spelled out in words.
- AI-driven department routing via internal `[HK:...]` / `[MAINTENANCE:...]` / `[CONCIERGE:...]` /
  `[RECEPTION:...]` tags → `notifyStaff` sends WhatsApp to the dept + logs an alert.
- Check-in **conversation** state machine: name → reservation → **stay dates** → **date
  confirmation** → **extra details** (guests/ETA/vehicle/requests — optional, one message,
  skippable) → ID → **terms acceptance** → deposit. Every stage has exactly one phrasing
  source (`promptStage`), so a mid-flow language switch re-sends the *current* stage in the new
  language.
- **Stay dates are role-based, never positional, and always confirmed.** "4 לילות עד ה-21/7"
  means check-*out* on 21/7 and check-*in* on 17/7 — the word before the date ("עד"/"until"/
  "מ-"/"from") decides the role; position is only the fallback ("20/7 - 23/7"). Ambiguous or
  self-contradicting input (`ambiguous` / `conflict`) is re-asked, never guessed. The parsed
  stay is then read back to the guest in full words for an explicit yes/no before it locks in
  (`waiting_dates_confirm`) — a wrong date means a key card valid for the wrong days.
- Folio/billing math + check-out summary logic (capture ≤ deposit, balance link if over).
- Dashboard API + session reset endpoints.

### What is MISSING / broken (חסר)
- **No real payment isolation** — Stripe is imported and called directly in `checkin.js` /
  `checkin-routes.js`. No abstraction layer, no mock. Will not work in Israel.
- **Check-in loops back to "full name"** — see bug #1 below.
- ~~No persistence~~ **DONE** — state now persists to SQLite (`db.js`, `node:sqlite`); survives restart.
- **Not multi-tenant** — one global `hotelConfig`, one global `sessions` map keyed only by phone.
- **No `.env` in repo** — all secrets (ANTHROPIC, TWILIO, STRIPE, BASE_URL) unset locally; with no
  Stripe key, `new Stripe(undefined)` / `startCheckin` fails.
- **Email routing not implemented** — goal #4 wants email + WhatsApp to departments; only WhatsApp
  exists.
- **Safety/emergency flow not implemented** — no 101/מד"א instruction, no guaranteed human
  escalation, no structured incident log. This is a hard requirement and is currently absent.
- **Check-out intent never fires** — it requires `session.stage === "checked_in"`, but check-in
  sets that flag on the *reservation* object, never on the *session*. So checkout is unreachable
  via chat.
- **Hardcoded room "304"** (assigned in `checkin-routes.js`; in production comes from the PMS).
  ~~hardcoded currency `gbp`~~ → ILS via `payments/index.js`. ~~hardcoded hotel name/deposit~~ →
  now read from `config.js` (`name`, `name_he`, `deposit_amount`, `wifi`, `services`).
- **Now collected at check-in** (stage `waiting_details`, all optional/skippable): number of
  guests, ETA, vehicle plate for parking, special requests — parsed best-effort from one free
  message (`parseCheckinDetails`), stored on the reservation, shown in the confirmation + staff
  alert. **Still not collected:** email, nationality/ID number.
- **Check-out** now shows a **grouped, itemised bill** (per-category with subtotals; minibar is
  its own section) and asks the guest for **feedback** (1–5 rating and/or a note; skippable) —
  saved on the reservation, escalated to management (low ratings → high priority). Still lacks:
  formal invoice/receipt PDF, minibar check, luggage storage, late-checkout offer.
- No logging/monitoring, no rate-limiting, no Twilio request validation (security).
- ~~No tests~~ **PARTIAL** — `e2e.test.mjs` (103 tests, `npm test`) מכסה צ'ק אין, אימות קלט, שפה,
  תגים, זהות, **מדיניות סוגי מסמכים, תאריכי שהייה, אישור תנאים, עקביות שפה מקצה לקצה**
  (כולל רינדור עמוד האישור), **המידע המובנה שמגיע ל-AI (system prompt), ומיזוג/שמירת הקונפיג**
  (כולל ריסטארט אמיתי בתהליך נפרד), **וזרימת הצ'ק אאוט המלאה** (הצגת חשבון → אישור → שלושת
  מקרי הפיקדון + ביטול + עקביות שפה). עדיין חסרות בדיקות לשכבת התשלום המבודדת עצמה.

### ID document storage (אחסון תעודות זהות)
`idverify/MockIdProvider` שומר את התמונה ל-`id-documents/` (ב-`.gitignore`) **מוצפנת**
(`idverify/crypto.js`, AES-256-GCM, קובץ `.enc`; מפתח מ-`ID_ENCRYPTION_KEY`, ואם חסר —
מפתח דמו נגזר עם אזהרה). **עדיין אחסון דמו: מקומי, בלי בקרת גישה ובלי retention.**
⚠️ אסור להריץ כך בפרודקשן עם אורחים אמיתיים. במלון אמיתי המסמך יישלח ל-**PMS/vault
מאובטח** של המלון — נקודת ה-hand-off מסומנת ב-`MockIdProvider.#store`, וההחלפה נעשית
במקום אחד: `idverify/index.js`.

---

## 3. Known Bugs

### Bug #1 — Check-in loops on "מה השם המלא?" (asks for full name repeatedly)
The check-in state machine itself advances correctly (name → reservation → payment). The loop is
caused by the **payment step failing and resetting the flow**:
- In `bot.js` → `handleCheckin`, stage `waiting_reservation` calls `startCheckin()` (`checkin.js`).
- `startCheckin()` calls Stripe (`stripe.checkout.sessions.create`). With no valid Stripe key
  (Israel / no `.env`), this **throws**.
- The `catch` block sets `checkinStage = null` and tells the guest "error, contact reception".
- The guest retries check-in → `checkinStage` is null again → the state machine **starts over at
  "full name"**. Repeated retries look like an infinite "what is your full name" loop.

Fix direction: replace the direct Stripe call with the **mock payment provider** (abstraction
layer) so the deposit step succeeds; also make failures not silently dump the user back to step 1.

### Bug #2 — `getSession` has side effects (increments `messageCount` on every call) — ✅ FIXED
> Fixed during the persistence work: `getSession` is now a pure read/create; the per-message
> counter increment lives in `recordActivity`, called exactly once at the top of `handleIncoming`.
`getSession` mutates `messageCount`/`stats` every call, and it is called multiple times per
incoming message (in `handleIncoming`, again in `handleCheckin`, again inside `pushHistory`). The
`messageCount === 1` welcome gate happens to still work, but the counter is unreliable. State reads
should be side-effect free.

### Bug #3 — Checkout unreachable
`session.stage` is never set to `"checked_in"` (only `reservation.stage` is), so the
`isCheckoutIntent && session.stage === "checked_in"` guard is always false.

---

## 4. State storage (איך נשמר ה-state)

- **Now persisted to SQLite** (`db.js`, built-in `node:sqlite`). `state.js` (sessions, alerts,
  incidents, stats) and `checkin.js` (reservations + folio) keep a live in-memory **write-through
  cache** that is hydrated from the DB on startup and saved on every mutation. Survives restart.
- Tables are namespaced by `hotel_id` (constant `"kempinski"` for now) — ready for multi-tenant.
- ~~Not persisted — restart wipes everything~~ (resolved).
- **Multi-tenant capacity:** essentially zero as-is. Sessions are keyed by phone only (no hotel id),
  config is a single global object, and nothing isolates one hotel from another. It can hold many
  guests of ONE hotel in RAM until the process restarts, but cannot safely run multiple hotels.
- **Needed:** a datastore (Redis for sessions / Postgres for reservations+config), keys namespaced
  by `hotelId`, and per-hotel config loaded from the store.

---

## 5. Payment code structure (מבנה קוד התשלום)

- **Currently NOT isolated — it is spread out and hardcoded to Stripe:**
  - `checkin.js`: `import Stripe`, `new Stripe(...)`, `startCheckin` (create checkout session,
    manual capture), `processCheckout` (cancel/capture/balance link) — all call Stripe directly.
  - `checkin-routes.js`: `import Stripe`, `new Stripe(...)`, webhook signature verification,
    success page calls `completeCheckin`.
- No provider interface, no mock, currency is `gbp`, amounts in minor units (50000 = "500").
- **Target architecture:** a single `payments/` abstraction (e.g. `PaymentProvider` interface:
  `authorizeDeposit`, `capture`, `cancel`, `createBalancePayment`, `verifyWebhook`) with a
  `MockProvider` now and `CardComProvider` later — wired in exactly one place.

---

## 6. Task list (משימות שנשארו)

Priority order (to be decided together):

- [ ] **P0 — Payment abstraction + Mock provider.** Move all Stripe code behind one interface;
      ship a mock that "takes" the deposit and confirms without charging. Fixes Bug #1 loop.
- [ ] **P0 — Safety / emergency flow.** Detect injury/medical/fire/gas → instruct 101/מד"א +
      guaranteed human escalation (security/manager) + structured incident log.
- [x] **P0 — Persistence.** Done: sessions, reservations+folio, alerts, incidents and stats now
      persist to SQLite (`db.js`, built-in `node:sqlite` — no native deps) via a write-through cache
      in `state.js`/`checkin.js`; survives restart. Every table has a `hotel_id` column (ready for
      multi-tenant). `settleFolio` is step-idempotent (no double-charge on restart/re-run).
- [ ] **P1 — Multi-tenant.** Per-hotel config + `hotelId`-namespaced state + tenant resolution
      from the inbound number.
- [x] **P1 — Fix checkout reachability** (set `session.stage` correctly; link session↔reservation).
      Done: `completeCheckin` now marks the session `checked_in` + stores `reservationId`/`roomNumber`;
      checkout shows the full bill, asks for confirmation, then charges the deposit (3 cases).
- [ ] **P1 — Email routing** for department dispatch (email + WhatsApp), per goal #4.
- [x] **P1 — Stay dates.** Done: guest supplies arrival/departure (or arrival + nights) at
      check-in; `validateStayDates` parses free-form HE/EN ("20.7-23.7", "היום, 2 לילות",
      "tomorrow until 23/07"). Stored on the reservation; drives room-key validity and the
      no-show moment (`israelDateTime` → checkout time in Israel, DST-aware). Replaces the
      `NIGHTS = 3` constant that gave every guest a 3-night stay.
      **Parsing is role-based + confirmed** (fixed after a live test read "4 לילות עד ה-21/7"
      as arrival 21/7 / departure 25/7 — the exact inverse of what the guest said). See §6
      "הגנות רוחב" and the `waiting_dates_confirm` stage.
- [x] **P1 — Stay terms gate.** Done: mandatory acceptance step before the deposit. Terms live
      in `config.js` (`terms.he`/`terms.en` + `version`, `{hotel}`/`{checkout_time}`/`{deposit}`
      placeholders). Requires explicit "אני מאשר" / "I confirm" — "כן"/"yes" is not accepted.
      `termsVersion` + `termsAcceptedAt` persist on the reservation. Refusal → polite stop +
      escalation to reception. ⚠️ Sample text — each hotel must supply real, lawyer-approved terms.
- [x] **P1 — Full language consistency** (see §6 "שפה"). Every page bilingual; guest name via
      `nameFor(holder, lang)`.
- [x] **P1 — ID policy: ID card or passport only.** Enforced in code
      (`ACCEPTED_DOC_TYPES` in `MockIdProvider`), not just in the vision prompt — a driver's
      license is a genuine government document, so the AI returns `is_id=true` for it and the
      old `valid` check let it through. Now declined with an explicit bilingual explanation and
      never stored.
- [ ] **P2 — Harden:** Twilio webhook signature validation, rate limiting, idempotency/dedup of
      inbound webhooks, structured logging, remove the hardcoded room "304".
      (Done: currency → ILS; hotel name / deposit / WiFi / services now read from `config.js`.)
- [x] **P2 — Persist `hotelConfig`.** Done: `config.js` now layers `DEFAULTS` (code) under
      `overrides` (DB table `config`, per `hotel_id`). `updateConfig` deep-merges and persists —
      survives restart; `{services:{spa:{he:{hours}}}}` no longer wipes the other services.
      Only the *overrides* are stored, so new fields added in code still reach edited hotels.
      Arrays are replaced wholesale (no index merging). `resetConfig()` + `POST /api/config/reset`
      clear overrides. `__proto__`/`constructor` keys are dropped from patches.
- [x] **P2 — Prompt loses labels for config values.** Done: `buildPrompt` renders every config
      value through `renderFields`/`labelFor` — each value carries its label, list items keep
      name+duration+price on one line, and an unmapped key falls back to its own name (so a new
      config field reaches the AI with its meaning intact, no code change). `parking.available:
      false` is now honoured instead of ignored.
- [ ] **P2 — Remaining check-in/out data:** guests count, ETA, email, nationality/ID number,
      vehicle plate, special requests; check-out invoice, minibar check, luggage, feedback.
- [x] **P2 — Full concierge (recommendations + arranging).** Done: `config.local_area` holds the
      area knowledge (per-hotel, bilingual, same labelled rendering as `services` — a new category
      reaches the AI with no code change). `concierge/` is the isolated request layer with a mock.
      ⚠️ Sample area data — every hotel replaces it with places it actually stands behind.
- [ ] **P2 — Real concierge integrations.** The mock only assigns a reference and hands off to a
      human. Wire real providers (taxi API, Tabit/OpenTable, spa/PMS, florist) in **one place** —
      `concierge/index.js` — including per-type routing. Only then may the bot tell a guest a
      booking is *confirmed* (`status: "confirmed"`); until then it says "passed to the concierge".
- [x] **P2 — Make `getSession` side-effect free** (Bug #2). Done: `getSession` is now pure;
      per-message counting moved to `recordActivity`, called once in `handleIncoming`.
- [ ] **P2 — Full payment policy** (see §1): charge for the stay itself, advances/deposits
      (מקדמות) at booking, and payment at reception on a different card — all through the existing
      `payments/` abstraction. (Documented only; not built yet.)
- [ ] **P3 — Tests** — done for check-in / input validation / language / tags / ID /
      **service rendering + concierge (area knowledge, request types, provider failure)** /
      **stay-date parsing (every HE/EN phrasing + the ambiguous cases) + date confirmation +
      truncated-tag leak + deposit wording** / **check-out state machine (bill preview →
      confirm → all three deposit outcomes + cancel + HE/EN consistency)**
      (`e2e.test.mjs`, 103 tests, `npm test`). Still missing: the isolated payment provider layer
      itself.

### שפה — עקביות מקצה לקצה (ממומש)
אורח שפתח באנגלית מקבל אנגלית ב**כל** נקודה: כל שלבי הצ'אט, עמוד הפיקדון, **עמוד האישור**
(היה עברית קשיחה), עמודי ביטול/יתרה/שגיאה, והודעת "צ'ק אין אושר". שלושה כללים:
1. **מקור שפה אחד לעמודים** — `pageLang(req, reservation)`: סשן → Accept-Language → עברית.
2. **שם האורח לפי שפת ההקשר** — תמיד דרך `nameFor(holder, lang)`, לעולם לא `guestName` הגולמי
   (שהוא הצורה העברית, לצוות). אורח אנגלי לא יראה "ברוכים הבאים, ג'ון סמית'".
3. **הצוות תמיד בעברית** — `notifyStaff` בעברית ללא קשר לשפת האורח (כולל שורת "שפת האורח").

### הגנות רוחב (מהבדיקה החיה — כולן ממומשות)
- **תג פנימי לעולם לא לאורח:** כל ענף של `[CHECKIN]`/`[CHECKOUT]` מסתיים בפעולה + `return`,
  ו-`wa()` מסנן גנרית כל `[TAG]`/`[TAG:...]` כרשת ביטחון אחרונה.
- **תג קטוע (`[CONCIERGE:restaurant|` בלי סוגר):** נצפה בשטח. השורש — `max_tokens` נגמר באמצע
  כתיבת התג, ולכן הרגקסים שדרשו `]` לא התאימו: התג *גם* לא סונן (ודלף לאורח) *וגם* לא עובד
  (הבקשה נעלמה). מטופל בשלוש שכבות: `max_tokens` הוכפל ל-1000; `runActions` תופס תג בלי סוגר
  (`(\]|$)`), מעביר את הבקשה לאדם בעדיפות גבוהה ומסמן אותה כחלקית; `stripInternalTags` מסיר
  תג קטוע בסוף מחרוזת. `[CHECKIN`/`[CHECKOUT` קטועים מנותבים גם הם.
- **אף פעם לא שקט:** `handleIncoming` עוטף הכול ב-try/catch → הודעת גיבוי לאורח + הסלמה
  לקבלה. `wa()` לעולם לא שולח body ריק (טוויליו זורק על כך ומשתיק את הבוט).
- **קלט:** מאומת בכל שלב (`validate.js`); קלט לא תקין → בקשה חוזרת מנומסת *באותו שלב*.
- **שפה:** בקשת מעבר שפה גוברת על הכול (גם באמצע צ'ק אין) → `promptStage` שולח את השלב
  הנוכחי מחדש בשפה החדשה וממשיך משם. לכל שלב יש מקור ניסוח אחד — ולכן אין ערבוב שפות.
- **טקסט האורח לא נכנס להודעות המערכת:** הודעת כל שלב היא משפט שלם ועצמאי; פנייה בשם עוברת
  כ-`prefix` בשורה נפרדת. כך נולד בעבר "I want to check in, please enter your reservation
  number" — קלט האורח התקבל כשם והודבק לתחילת המשפט הבא. `validateFullName` דוחה מילות פקודה.
- **ניסוח:** אותה מחלה בדיוק פגעה גם ב-AI — "אגיד לי לאיזה יום ושעה" נולד מהדבקת פריט מרשימת
  ההוראות לתוך משפט. לכן רשימות הפרטים ב-prompt מנוסחות כ**שמות עצם** ("היעד · שעת האיסוף"),
  ויש כלל מפורש: הרשימות אומרות *מה* לדעת, לא *איך* לנסח. בנוסף — אין צורות עם לוכסן
  ("אנא הקלד/י") בהודעות לאורח; מנסחים ניטרלית ("מה שמך המלא?", "נא להשיב *כן*").
- **הקונסיירז' לא ממציא ולא מבטיח:** אסור לנקוב בשם עסק שאינו ב-`config.local_area`, ואסור
  להמציא כתובת/שעה/מחיר. אין המלצה מתאימה → "אשמח לבדוק ולחזור אליך" + `[RECEPTION:...]`
  ("אני לא יודע" בלי המשך היא תשובה פסולה). בקשה = *העברה* ("אעביר את בקשתך ואחזור עם
  אישור"), לעולם לא ביצוע ("הזמנתי לך מונית"). רק כשספק אמיתי יחזיר `status:"confirmed"`
  (`concierge/index.js`) מותר יהיה לומר שההזמנה בוצעה.
- **הפיקדון לא מבטיח החזר שלא בטוח:** כל ניסוח (הסבר, תנאי שהייה, עמודי התשלום) מפרט את
  שלושת המקרים — אין חיובים / חיובים ≤ פיקדון / חיובים > פיקדון (אין יתרה, ההפרש מחויב).
  מקור אמת אחד: `depositExplainer` ב-`checkin.js`; התנאים ב-`config.js` תואמים לו.

---

## 7. Tech / Run

- Node ESM, Express. Start: `npm start` (`node server.js`), dev: `npm run dev`.
- Env vars expected (no `.env` committed): `ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `BASE_URL`, `PORT`, `DASHBOARD_PASSWORD`, `GOOGLE_PLACES_API_KEY` (חיפוש מקומות חי; בלעדיו
  `places/` נופל אוטומטית ל-mock), `PLACES_PROVIDER` (אופציונלי; `mock` כופה את המוק גם כשיש מפתח),
  `ID_ENCRYPTION_KEY` (32 בייט hex/base64 להצפנת מסמכי זיהוי; בלעדיו — מפתח דמו נגזר, לא לפרודקשן).
- AI model in use: `claude-sonnet-4-6` (`bot.js`). הקונסיירז' רץ עם tool-use — הכלי
  `search_nearby_places` (`places/`) זמין לו בכל תור להמלצות מקומות אמיתיים.

> Rule for future work: payments change in ONE place (the provider abstraction). Never re-couple
> business logic to a specific payment vendor.
