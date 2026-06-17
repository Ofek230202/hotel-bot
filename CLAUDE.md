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
| `checkin.js` | Check-in / deposit / folio (bill) / check-out logic. **Directly coupled to Stripe.** Reservations stored in an in-memory `reservations` object. | Works only with a live Stripe key |
| `checkin-routes.js` | Stripe success/cancel HTML pages + Stripe webhook handler. Calls `completeCheckin` after payment. | Coupled to Stripe |
| `state.js` | **In-memory state** (`sessions`, `staffAlerts`, `stats`). `getSession`, `pushHistory`, `patchSession`, `logAlert`. Comment even says "swap for Redis/DB in production". | Works, NOT persistent, NOT multi-tenant |
| `config.js` | **Single hotel** config object (`hotelConfig`): identity, dept WhatsApp numbers, times, WiFi, services, parking, FAQ, welcome messages. `updateConfig` mutates it globally. | Works for 1 hotel only |
| `i18n.js` | `detectLang` (Hebrew unicode range heuristic) + `t` helper. | Works |
| `index.html` (50KB) | Standalone dashboard/landing UI. | Present, not wired into the server flow as a tracked file |
| `package.json` | Deps: `@anthropic-ai/sdk`, `twilio`, `stripe`, `express`, `dotenv`, `uuid`. ESM (`"type":"module"`). | OK |

### What WORKS today
- WhatsApp in/out via Twilio.
- Bilingual AI concierge answers (Claude `claude-sonnet-4-6`).
- AI-driven department routing via internal `[HK:...]` / `[MAINTENANCE:...]` / `[CONCIERGE:...]` /
  `[RECEPTION:...]` tags → `notifyStaff` sends WhatsApp to the dept + logs an alert.
- Check-in **conversation** state machine (name → reservation → payment).
- Folio/billing math + check-out summary logic (capture ≤ deposit, balance link if over).
- Dashboard API + session reset endpoints.

### What is MISSING / broken (חסר)
- **No real payment isolation** — Stripe is imported and called directly in `checkin.js` /
  `checkin-routes.js`. No abstraction layer, no mock. Will not work in Israel.
- **Check-in loops back to "full name"** — see bug #1 below.
- **No persistence** — all state in RAM; a restart wipes every session, reservation, and stat.
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
- **Hardcoded room "304"**, hardcoded currency `gbp` (should be ILS), hardcoded hotel name in
  several strings.
- No tests, no logging/monitoring, no rate-limiting, no Twilio request validation (security).

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

### Bug #2 — `getSession` has side effects (increments `messageCount` on every call)
`getSession` mutates `messageCount`/`stats` every call, and it is called multiple times per
incoming message (in `handleIncoming`, again in `handleCheckin`, again inside `pushHistory`). The
`messageCount === 1` welcome gate happens to still work, but the counter is unreliable. State reads
should be side-effect free.

### Bug #3 — Checkout unreachable
`session.stage` is never set to `"checked_in"` (only `reservation.stage` is), so the
`isCheckoutIntent && session.stage === "checked_in"` guard is always false.

---

## 4. State storage (איך נשמר ה-state)

- **In-memory only**, in `state.js`: `sessions` (phone → session), `reservations` (in `checkin.js`),
  `staffAlerts`, `stats`. Pure JS objects in the Node process.
- **Not persisted** — restart/redeploy/crash wipes everything.
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
- [ ] **P0 — Persistence.** Move sessions/reservations/alerts out of RAM into a datastore.
- [ ] **P1 — Multi-tenant.** Per-hotel config + `hotelId`-namespaced state + tenant resolution
      from the inbound number.
- [x] **P1 — Fix checkout reachability** (set `session.stage` correctly; link session↔reservation).
      Done: `completeCheckin` now marks the session `checked_in` + stores `reservationId`/`roomNumber`;
      checkout shows the full bill, asks for confirmation, then charges the deposit (3 cases).
- [ ] **P1 — Email routing** for department dispatch (email + WhatsApp), per goal #4.
- [ ] **P2 — Harden:** Twilio webhook signature validation, rate limiting, idempotency/dedup of
      inbound webhooks, structured logging, currency → ILS, remove hardcoded room/hotel strings.
- [ ] **P2 — Make `getSession` side-effect free**; separate read vs. mutate.
- [ ] **P2 — Full payment policy** (see §1): charge for the stay itself, advances/deposits
      (מקדמות) at booking, and payment at reception on a different card — all through the existing
      `payments/` abstraction. (Documented only; not built yet.)
- [ ] **P3 — Tests** for the check-in/out state machine and payment provider.

---

## 7. Tech / Run

- Node ESM, Express. Start: `npm start` (`node server.js`), dev: `npm run dev`.
- Env vars expected (no `.env` committed): `ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `BASE_URL`, `PORT`, `DASHBOARD_PASSWORD`.
- AI model in use: `claude-sonnet-4-6` (`bot.js`).

> Rule for future work: payments change in ONE place (the provider abstraction). Never re-couple
> business logic to a specific payment vendor.
