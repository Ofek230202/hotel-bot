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
| `config.js` | **Single hotel** config: `DEFAULTS` (in code) + `overrides` (persisted in DB, table `config`) → `hotelConfig = deepMerge(DEFAULTS, overrides)`. Identity, dept numbers/emails, times, WiFi, **detailed services** (spa treatments+prices, restaurant, gym, room service, laundry, pool, bar, breakfast), parking, FAQ, welcome, `deposit_amount`, `terms`. `updateConfig` deep-merges + persists. ⚠️ All service/price/policy data is **sample data** — every hotel replaces it. | Works for 1 hotel only |
| `i18n.js` | `detectLang` / `detectLangSignal` (Hebrew unicode heuristic), `detectLanguageRequest` + `stripLanguageRequest` (בקשת מעבר שפה), `t` helper. | Works |
| `validate.js` | אימות קלט האורח: שם (דוחה גם *מילות פקודה* כמו "I want to check in"), מספר הזמנה, תמונת ת"ז, **תאריכי שהייה** (`validateStayDates` — פרסור חופשי HE/EN) ו**אישור תנאים** (`validateTermsConfirmation` — דורש נוסח מפורש). + `stripInternalTags`. | Works |
| `idverify/` | שכבת אימות זהות מבודדת. `vision.js` — בדיקת Claude vision אמיתית; `MockIdProvider` — אוכף `ACCEPTED_DOC_TYPES = {id_card, passport}` **בקוד** (לא רק ב-prompt) ושומר מקומית (דמו). רישיון נהיגה נדחה במפורש. נקודת החלפה אחת: `idverify/index.js`. | Works |
| `e2e.test.mjs` | בדיקות end-to-end לזרימת הצ'ק אין, השפה, התגים והזהות (`npm test`). | Works |
| `index.html` (50KB) | Standalone dashboard/landing UI. | Present, not wired into the server flow as a tracked file |
| `package.json` | Deps: `@anthropic-ai/sdk`, `twilio`, `stripe`, `express`, `dotenv`, `uuid`. ESM (`"type":"module"`). | OK |

### What WORKS today
- WhatsApp in/out via Twilio.
- Bilingual AI concierge answers (Claude `claude-sonnet-4-6`).
- AI-driven department routing via internal `[HK:...]` / `[MAINTENANCE:...]` / `[CONCIERGE:...]` /
  `[RECEPTION:...]` tags → `notifyStaff` sends WhatsApp to the dept + logs an alert.
- Check-in **conversation** state machine: name → reservation → **stay dates** → ID → **terms
  acceptance** → deposit. Every stage has exactly one phrasing source (`promptStage`), so a
  mid-flow language switch re-sends the *current* stage in the new language.
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
- **Still not collected at check-in:** number of guests, ETA, email, nationality/ID number,
  vehicle plate for parking, special requests. **Check-out** still lacks: invoice/receipt,
  minibar check, luggage storage, late-checkout offer, feedback.
- No logging/monitoring, no rate-limiting, no Twilio request validation (security).
- ~~No tests~~ **PARTIAL** — `e2e.test.mjs` (43 tests, `npm test`) מכסה צ'ק אין, אימות קלט, שפה,
  תגים, זהות, **מדיניות סוגי מסמכים, תאריכי שהייה, אישור תנאים, עקביות שפה מקצה לקצה**
  (כולל רינדור עמוד האישור), **המידע המובנה שמגיע ל-AI (system prompt), ומיזוג/שמירת הקונפיג**
  (כולל ריסטארט אמיתי בתהליך נפרד). עדיין חסרות בדיקות לצ'ק אאוט ולשכבת התשלום.

### ID document storage (אחסון תעודות זהות)
`idverify/MockIdProvider` שומר את התמונה ל-`id-documents/` (ב-`.gitignore`) —
**אחסון דמו בלבד: מקומי, לא מוצפן, בלי בקרת גישה ובלי retention.**
⚠️ אסור להריץ כך בפרודקשן עם אורחים אמיתיים. המעבר לאחסון מאובטח ומוצפן
נעשה במקום אחד: `idverify/index.js`.

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
- [x] **P2 — Make `getSession` side-effect free** (Bug #2). Done: `getSession` is now pure;
      per-message counting moved to `recordActivity`, called once in `handleIncoming`.
- [ ] **P2 — Full payment policy** (see §1): charge for the stay itself, advances/deposits
      (מקדמות) at booking, and payment at reception on a different card — all through the existing
      `payments/` abstraction. (Documented only; not built yet.)
- [ ] **P3 — Tests** — done for check-in / input validation / language / tags / ID
      (`e2e.test.mjs`, `npm test`). Still missing: check-out state machine + payment provider.

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
- **אף פעם לא שקט:** `handleIncoming` עוטף הכול ב-try/catch → הודעת גיבוי לאורח + הסלמה
  לקבלה. `wa()` לעולם לא שולח body ריק (טוויליו זורק על כך ומשתיק את הבוט).
- **קלט:** מאומת בכל שלב (`validate.js`); קלט לא תקין → בקשה חוזרת מנומסת *באותו שלב*.
- **שפה:** בקשת מעבר שפה גוברת על הכול (גם באמצע צ'ק אין) → `promptStage` שולח את השלב
  הנוכחי מחדש בשפה החדשה וממשיך משם. לכל שלב יש מקור ניסוח אחד — ולכן אין ערבוב שפות.
- **טקסט האורח לא נכנס להודעות המערכת:** הודעת כל שלב היא משפט שלם ועצמאי; פנייה בשם עוברת
  כ-`prefix` בשורה נפרדת. כך נולד בעבר "I want to check in, please enter your reservation
  number" — קלט האורח התקבל כשם והודבק לתחילת המשפט הבא. `validateFullName` דוחה מילות פקודה.

---

## 7. Tech / Run

- Node ESM, Express. Start: `npm start` (`node server.js`), dev: `npm run dev`.
- Env vars expected (no `.env` committed): `ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `BASE_URL`, `PORT`, `DASHBOARD_PASSWORD`.
- AI model in use: `claude-sonnet-4-6` (`bot.js`).

> Rule for future work: payments change in ONE place (the provider abstraction). Never re-couple
> business logic to a specific payment vendor.
