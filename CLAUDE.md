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

Node/Express app, **מולטי-טננט**. שני מלונות מוגדרים ומאומתים מקצה לקצה:
**LALA Boutique** (בוטיק, דרך בן צבי 78, קוד לדלת) ו-**The David Kempinski**
(מלון מלא, הירקון 51, כרטיס בקבלה) — עם בידול מלא ביניהם (ראה §9).
זהות המלון נפתרת מהמספר שאליו האורח כתב, ולכן מספר Twilio אחד יכול לשרת
מלון אחר בכל יום (`demo-switch.mjs`, §9.4).

### Files
| File | What it does | Status |
|------|--------------|--------|
| `server.js` | Express server. Twilio WhatsApp webhook (`POST /webhook`), dashboard API (`/api/*`), session reset, payment webhook mount (`checkin-routes`), onboarding מלון (`POST /api/hotels`), `GET /api/tenant/resolve` + `POST /api/tenant/reload` (החלפת מלון בלי restart), static dashboard. בעלייה: טבלת ניתוב, בדיקת אנשי קשר, **בדיקת בידוד בין מלונות**, smoke-check ל-Google Places. | Works |
| `bot.js` | **The brain.** `handleIncoming` orchestrates: language detect → welcome → check-in/out intent → check-in state machine → AI concierge (Claude) → `runActions` parses `[HK:...]`/`[MAINTENANCE:...]` tags and notifies staff. | Works, but fragile (see bugs) |
| `checkin.js` | Check-in / deposit / folio (bill) / check-out logic. Stay dates (`stayCheckIn`/`stayCheckOut`/`nights`) + accepted terms version live on the reservation. Deposit amount + hotel strings come from `config.js`. | Works |
| `checkin-routes.js` | Deposit / success / cancel / balance HTML pages + payment webhook. **All pages bilingual** — `pageLang()` picks HE/EN per guest (session → Accept-Language → HE), `shellPage()` is the shared HE/EN shell. | Works |
| `state.js` | State עם **write-through ל-SQLite** (`sessions`, `staffAlerts`, `incidents`, `stats`). כל סשן ממופתח ב-`tenantKey(hotelId, phone)` — אותו טלפון בשני מלונות = **שני סשנים נפרדים**. `getSession` (טהור), `peekSession`, `patchSession`, `recordActivity`, `logAlert`, `logIncident`. | Works · מתמיד · מולטי-טננט |
| `payments/` | **שכבת התשלום המבודדת** — `PaymentProvider` (ממשק) · `MockProvider` (דמו, בלי חיוב) · `CardComProvider` (סליקה ישראלית). `paymentsFor(hotelId)` בוחר ספק **פר-מלון**. ראה §5. | Works (mock; CardCom מוכן) |
| `email/` | **ניתוב מייל למחלקות** — `EmailProvider` · `MockEmailProvider` (לוג) · `HttpEmailProvider` (Resend/SendGrid אמיתי לפי `EMAIL_API_KEY`). `notifyStaff` שולח **וואטסאפ + מייל** לכל בקשה. `emailIsLive` מתריע בעלייה אם רק מוק. | Works |
| `invoices/` | **חשבונית מס-קבלה** — `InvoiceProvider` · `MockInvoiceProvider` (כל שדות החובה בישראל, מספר סידורי רץ פר-מלון, מע"מ 18% לתושב / 0% לתייר חוץ). נקודת החלפה אחת לספק אמיתי (Green Invoice/iCount/CardCom). | Works (mock) |
| `tenant.js` | **גבול הטננט** — `resolveHotelId(To)` (טבלת `hotel_numbers`), `runInTenant` (AsyncLocalStorage), `currentHotelId`, `fromNumberFor` (כל מלון עונה מהמספר שלו), `tenantKey`, `registerHotelNumber`, `reloadHotelNumbers`. | Works |
| `demo-switch.mjs` | **מפנה את מספר ה-Twilio היחיד למלון אחד** (`npm run demo:lala` / `demo:kempinski` / `demo:status`). כותב קונפיג ל-DB, משאיר מיפוי אחד, מנקה סשנים, מרענן שרת רץ, ומדפיס כרטיס הדגמה. ראה §9.4. | Works |
| `verify-number.mjs` | אימות חי של המספר האמיתי מול ה-DB האמיתי (`npm run demo:verify`) — בלי לשלוח הודעה. | Works |
| `preflight.mjs` | בדיקת ענק לפני הדגמה (`npm run preflight`) — בידול קונסיירז' × N, עומס, תהליכים מלאים, איכות פלט. ראה §9.5. | Works |
| `simulate-demo.mjs` | סימולציית שני המלונות מקצה לקצה (`npm run demo`). | Works |
| `sample-hotels.mjs` | 7 מלוני דוגמה, כולל **LALA** המוגדרת במלואה (אנשי קשר, עוסק, מרחב מוגן, מבנה, FAQ). | Works |
| `config.js` | **קונפיג פר-מלון**: `DEFAULTS` (בקוד) + `overrides` (DB, טבלת `config`, לפי `hotel_id`) → `configFor(hotelId)`. גם `welcomeFor` (הודעת פתיחה שנבנית מהמלון), `hotelModel` (בוטיק/מלא), `departmentContacts`, ו-**`checkTenantIsolation`** שתופס מלון שיורש שדות ממלון ברירת המחדל. מכיל: זהות המלון, אנשי קשר של המחלקות (מספרים+מיילים), שעות, WiFi, **שירותים מפורטים** (ספא+מחירים, מסעדה, חדר כושר, שירות חדרים, כביסה, בריכה, בר, ארוחת בוקר), חניה, מרחב מוגן, מבנה המלון, **`local_area`** (ידע הקונסיירז' *מחוץ* למלון), FAQ, `deposit_amount`, `terms`, `business` (פרטי העוסק לחשבונית), `vat_rate`, בחירת ספקים (`payment_provider`/`whatsapp_provider`/`pms_provider`/`invoice_provider`), **תפריט שירות החדרים** (`services.room_service.menu`), ו**טבלת הניתוב** (`TAG_DEPARTMENTS` + `routingTable`/`printRoutingTable`). `updateConfigFor` ממזג עמוק ושומר. ⚠️ כל נתוני השירותים/מחירים/מדיניות/אזור הם **נתוני דוגמה** — כל מלון מחליף אותם. | Works · פר-מלון |
| `concierge/` | שכבת בקשות הקונסיירז' המבודדת. `ConciergeProvider` — הממשק + `REQUEST_TYPES` (taxi/restaurant/spa/tour/transfer/rental/gift/other); `MockConciergeProvider` — מקצה אסמכתא (`CNG-XXXXXX`) ומחזיר `status:"received"`, **לא מזמין כלום בפועל** — הביצוע הוא של הקונסיירז' האנושי שמקבל את ההתראה. נקודת החלפה אחת: `concierge/index.js`. | Works (mock) |
| `places/` | שכבת **חיפוש מקומות אמיתיים** מבודדת (Google Places API New — Text Search). `PlacesProvider` — הממשק + `PLACE_CATEGORIES` (מיפוי קטגוריה→`includedType`); `GooglePlacesProvider` — קורא ל-`places:searchText` עם `X-Goog-Api-Key` מ-`process.env.GOOGLE_PLACES_API_KEY` (**המפתח לעולם לא בקוד/לוג/גוף בקשה**), מנרמל שם/כתובת/דירוג/מחיר ומחשב מרחק (haversine); `MockPlacesProvider` — תוצאות דמו בלי רשת/מפתח, פורמט זהה. מושך גם **שעות פתיחה** (`currentOpeningHours`/`regularOpeningHours` → `openingHours` לשבוע + `todayHours` להיום **לפי אזור הזמן של המלון** — `config.location.timezone`, קריטי לרשת בינלאומית: מלון בניו יורק מקבל את "היום" של ניו יורק, לא של ישראל), **טלפון**, **אתר** ו**סוג המקום/המטבח**. **המיקום תמיד פר-מלון** — `runPlacesTool` קורא `configFor(currentHotelId()).location`, ולכן אין ערבוב בין מלונות (אורח בת"א מקבל מסעדות בת"א, בניו יורק — בניו יורק). `cache.js` (`CachedPlaces`) עוטף כל ספק: **cache לפי מיקום+שאילתה+שפה** (בידוד מלונות מובנה במפתח), **single-flight** (בקשות זהות בו-זמנית → קריאה אחת לספק), ו**הגבלת קצב גלובלית** (הגנת מכסת Google) — כך פרץ של אלפי אורחים מ-100 מלונות לא חורג ולא קורס (`openNow` לא נשמר — תלוי-רגע). `util.js` — haversine + פורמט מרחק/מחיר + `todayHoursLine` (מקבל `timeZone`; השבוע של גוגל מתחיל ב**יום שני** באנגלית / **ראשון** בעברית). נקודת החלפה אחת: `places/index.js`. ה-AI מקבל את הכלי `search_nearby_places` (tool-use) ומכבד בקשה מדויקת (בשרי/כשר/טבעוני) דרך שדה `query`. **אומת חי מול Google — ראה §7.1.** | Works (verified live) |
| `i18n.js` | `detectLang` / `detectLangSignal` (Hebrew unicode heuristic), `detectLanguageRequest` + `stripLanguageRequest` (בקשת מעבר שפה), `t` helper. | Works |
| `numbers.js` | **מספרים שנכתבו במילים** — `wordsToDigits` ממיר "שתי לילות"→"2 לילות", "עשרה אורחים"→"10 אורחים", "in three days"→"in 3 days", בעברית ובאנגלית (כולל 11–20). התחילית נשמרת ("לשלושה"→"ל3") כדי שמילות התפקיד לא ייעלמו, ו"יום שני" נשאר יום בשבוע. נקודת נרמול אחת שכל הפרסורים (`validateStayDates`, אורחים, ETA) עוברים דרכה. | Works |
| `validate.js` | אימות קלט האורח: שם (דוחה גם *מילות פקודה* כמו "I want to check in"), מספר הזמנה, תמונת ת"ז, **תאריכי שהייה** (`validateStayDates` — פרסור חופשי HE/EN **מבוסס-תפקיד**: "עד"/"until" לפני תאריך = עזיבה) ו**אישור תנאים** (`validateTermsConfirmation` — דורש נוסח מפורש). קורא **מספרים במילים** דרך `numbers.js`, ועוצר **תאריך שעבר מיד** (גם כשנמסר תאריך יחיד — מחזיר `pastDate`/`today` כדי לומר לאורח *איזה* תאריך). + `stripInternalTags` (כולל תג **קטוע**). | Works |
| `idverify/` | שכבת אימות זהות מבודדת. **ברירת המחדל: verify-then-discard** — מאמתים, מחלצים רק את השדות הנדרשים, ו**מוחקים את התמונה מיד** (עמדת כל רשויות הפרטיות; ראה `SECURITY.md`). `policy.js` — מקור אמת אחד (`resolveIdPolicy` מכריע discard/שמירה פר-מלון לפי `config.id_policy`; `idCollectionNotice` = הודעת האיסוף לאורח). `vision.js` — בדיקת Claude vision אמיתית **ומחמירה** (`shows_document`: סלפי/צילום מסך → `is_id=false`; סף 0.7) **+ חילוץ שדות מינימליים** באותה קריאה; `MockIdProvider` — אוכף `ACCEPTED_DOC_TYPES = {id_card, passport}` **בקוד**. שמירת תמונה קורית **רק** עם `id_policy.legal_basis` מתועד (למשל מע"מ 0% לתייר) — ואז **מוצפנת at-rest** (`crypto.js`, AES-256-GCM, `.enc`) עם retention אוטומטי ו-audit. הסבר הדחייה לאורח **גנרי**. נקודת החלפה אחת: `idverify/index.js` (גם ה-hand-off העתידי ל-PMS). | Works |
| `e2e.test.mjs` | בדיקות end-to-end לזרימת הצ'ק אין, השפה, התגים והזהות (`npm test`). | Works |
| `index.html` (50KB) | Standalone dashboard/landing UI. | Present, not wired into the server flow as a tracked file |
| `package.json` | Deps: `@anthropic-ai/sdk`, `twilio`, `express`, `dotenv`, `uuid`. ESM (`"type":"module"`). **אין `stripe`** — הוסר (§5). | OK |

### What WORKS today
- WhatsApp in/out via Twilio.
- Bilingual AI concierge answers (Claude `claude-sonnet-4-6`).
- **שני מלונות במקביל, עם בידול מלא** — LALA (בוטיק, בן צבי 78, קוד לדלת, בלי צוות
  במקום) ו-קמפינסקי (מלון מלא, הירקון 51, כרטיס בקבלה, צוות 24/7). לכל אחד המיקום,
  הקונסיירז', המחלקות, פרטי העוסק והשירותים שלו. אין מסלול שבו פרט של מלון אחד מגיע
  לאורח של השני (§9, `tenant-isolation.test.mjs`, `preflight.mjs`).
- **מספר Twilio אחד יכול לשרת מלון אחר בכל יום** — `npm run demo:lala` /
  `npm run demo:kempinski` מפנים אותו, כולל ריענון שרת רץ בלי restart (§9.4).
- **תשלומים מבודדים** — `payments/` עם Mock (דמו) ו-CardCom (סליקה ישראלית), בבחירה
  פר-מלון. Stripe הוסר (§5).
- **ניתוב מייל + וואטסאפ** לכל מחלקה, ליעדים של אותו מלון (`email/`).
- **חשבונית מס-קבלה** בצ'ק אאוט, עם מע"מ 18% לתושב ו-0% לתייר חוץ (`invoices/`).
- **Full concierge role** — not just a receptionist: local recommendations (restaurants,
  attractions, tours, nightlife, shopping) from **two real sources** — `config.local_area`
  (hotel-vetted) *and* **live Google Places search** (`places/`, tool `search_nearby_places`) for
  real nearby places when the curated list doesn't cover the exact request. The bot honours the
  exact ask (meat/kosher/dairy/vegan/cuisine) via the tool's `query`, and still may name *only*
  places one of those two sources actually returned — never invents. **החיפוש החי אומת מול Google
  עם מפתח אמיתי, כולל השוואת הכתובות שהבוט מסר מול הפלט הגולמי — ראה §7.1.** Arranging requests (taxi,
  table, spa, tour, rental, gifts/special requests) via `[CONCIERGE:<type>|<details>]` →
  `concierge/` layer, and proactive luxury-hotel closing offers.
  The prompt forbids promising a booking is *done* — the mock only passes the request to a human,
  so the bot says "I've passed it on", never "your table is reserved".
- **WhatsApp-clean output** — markdown tables are banned in the prompt (WhatsApp can't render
  them; guests saw `|---|---|`). Lists render as `• *name* (duration) — price`, and a
  conditional price (e.g. couples massage = for two people) must be spelled out in words.
- AI-driven department routing to **all 7 standard 5-star departments**, understanding-based (by
  meaning, not keywords). Internal tags → `notifyStaff` (WhatsApp + email + alert log):
  `[HK:...]`/`[HK_URGENT:...]` → housekeeping, `[MAINTENANCE:...]` → maintenance,
  `[ROOMSERVICE:...]` → room service, `[SECURITY:...]` → security (non-emergency),
  `[RECEPTION:...]` → reception, `[CONCIERGE:...]` → concierge, `[EMERGENCY:...]` → security
  (+ the deterministic emergency flow). The prompt (HE+EN) describes each department's scope with
  routing examples (coffee→room service, spill→housekeeping, blown bulb→maintenance, suspicious
  person→security, injury→emergency), so the AI always routes and never leaves a request unanswered.
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
- ~~No real payment isolation~~ **DONE** — Stripe הוסר לחלוטין. כל התשלומים עוברים דרך
  `payments/` (`PaymentProvider` + `MockProvider` + `CardComProvider`), ובחירת הספק היא
  **פר-מלון** ב-`paymentsFor(hotelId)` לפי `config.payment_provider`. מלון בלי credentials
  נופל ל-Mock עם אזהרה, כדי לא לשבור צ'ק אין.
- ~~Check-in loops back to "full name"~~ **DONE** — נבע מכשל Stripe שאיפס את הזרימה (באג #1).
- ~~No persistence~~ **DONE** — state now persists to SQLite (`db.js`, `node:sqlite`); survives restart.
- ~~Not multi-tenant~~ **DONE** — `tenant.js` (AsyncLocalStorage + `hotel_numbers`), סשנים
  והזמנות ממופתחים ב-`hotelId`, קונפיג פר-מלון. ראה §8.2 ו-§9.
- ~~Email routing not implemented~~ **DONE** — `email/` (`MockEmailProvider` /
  `HttpEmailProvider` ל-Resend/SendGrid). `notifyStaff` שולח **וואטסאפ + מייל** לכל מחלקה.
- **No `.env` in repo** — כל הסודות מוגדרים בסביבה בלבד (ANTHROPIC, TWILIO, BASE_URL,
  GOOGLE_PLACES_API_KEY, ID_ENCRYPTION_KEY, EMAIL_*).
- ~~Safety/emergency flow not implemented~~ **DONE** — `emergency.js`: זיהוי דטרמיניסטי (לא תלוי
  ב-AI, רץ לפני כל זרימה אחרת) → הנחיית 101/102/100 לאורח → הסלמה כפולה לביטחון *ולקבלה* →
  `logIncident` מובנה ומתמיד. **זיהוי דו-דרגתי** (`HARD`/`SOFT` + `isInquiry`): מילה חד-משמעית
  ("שריפה", "נפצעתי", "unconscious") מפעילה תמיד — גם בתוך שאלה; מילה דו-משמעית ("אש", "smoke",
  "police", "dangerous") לא מפעילה כששואלים עליה ("Can I smoke on the balcony?" / "איפה יציאת
  החירום?"). **מיקום:** בלי מספר חדר האורח נשאל איפה הוא, ההתראה אומרת "מיקום לא ידוע — התקשרו
  עכשיו", והתשובה הבאה מועברת לביטחון מיד (`emergencyAwaitLocation`) ולא ל-AI.
  ⚠️ עדיין חסר: אישור-קבלה מהצוות (ack), re-send, וסגירת אירוע — ההסלמה נשלחת אך איש לא מאשר קבלה.
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
- ~~No tests~~ **PARTIAL** — `e2e` + `places` + `safety` + `scale` + `idsecurity` + `hoteltype` + `tenant-isolation` + `demo-switch` (**316 tests**, `npm test`) מכסה צ'ק אין, אימות קלט, שפה,
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

### Bug #1 — Check-in loops on "מה השם המלא?" — ✅ FIXED
> תוקן עם שכבת התשלום המבודדת. השורש: `startCheckin()` קרא ל-Stripe ישירות, ובלי מפתח
> תקף (ישראל) הקריאה זרקה; ה-`catch` אפס את `checkinStage` והמכונה חזרה לשלב הראשון,
> כך שכל ניסיון חוזר נראה כלולאה אינסופית של "מה השם המלא?".
> הפתרון: כל התשלומים עוברים דרך `payments/` (Mock/CardCom פר-מלון), ולכן שלב הפיקדון
> מצליח; וכשלון אינו מחזיר את האורח לשלב הראשון.

### Bug #2 — `getSession` has side effects (increments `messageCount` on every call) — ✅ FIXED
> `getSession` הוא כעת קריאה/יצירה טהורה; מונה ההודעות עבר ל-`recordActivity`, שנקרא
> **פעם אחת בדיוק** בראש `handleIncoming`.

### Bug #3 — Checkout unreachable — ✅ FIXED
> `completeCheckin` מסמן את הסשן `checked_in` ושומר עליו `reservationId`/`roomNumber`,
> ולכן כוונת הצ'ק אאוט נתפסת. הזרימה: הצגת חשבון מפורט → אישור → סליקת הפיקדון
> (שלושת המקרים) → חשבונית מס-קבלה → בקשת משוב.

> **שלושת הבאגים המקוריים סגורים.** מה שנותר פתוח מתועד ב-§6 (לא באגים אלא עבודה
> שלא נעשתה): אישור-קבלה מהצוות בחירום, hardening של ה-webhook, וספקי קונסיירז' אמיתיים.

---

## 4. State storage (איך נשמר ה-state)

- **Now persisted to SQLite** (`db.js`, built-in `node:sqlite`). `state.js` (sessions, alerts,
  incidents, stats) and `checkin.js` (reservations + folio) keep a live in-memory **write-through
  cache** that is hydrated from the DB on startup and saved on every mutation. Survives restart.
- כל טבלה נושאת `hotel_id`, וכל שאילתה מסוננת לפיו.
- ~~Not persisted — restart wipes everything~~ (resolved).
- **מולטי-טננט — עובד**: סשנים ממופתחים ב-`tenantKey(hotelId, phone)`, הזמנות נושאות
  `res.hotelId` והחיפושים מסוננים, הקונפיג נטען פר-מלון, וההתראות יוצאות למחלקות של
  אותו מלון בלבד. אותו טלפון בשני מלונות = שני סשנים נפרדים. אומת בעומס: 600 שיחות
  במקביל ב-6 מלונות, בלי דליפה (§9.5).
- **מה שעוד נדרש לסקייל אמיתי** (100 מלונות × 1000 אורחים, ראה `SCALING.md`):
  Postgres מנוהל (המעבר דורש הפיכת שכבת ה-state ל-async), Redis לסשנים ולנעילות
  מבוזרות בריבוי תהליכים, מספר Twilio לכל מלון, ו-vault/S3+KMS למסמכי זיהוי.

---

## 5. Payment code structure (מבנה קוד התשלום) — ✅ מבודד

**Stripe הוסר לחלוטין מהפרויקט.** אין `import Stripe` באף קובץ, ואין מפתח Stripe ב-env.
כל התשלומים עוברים דרך שכבה אחת:

| קובץ | תפקיד |
|---|---|
| `payments/PaymentProvider.js` | הממשק: `authorizeDeposit`, `capture`, `cancel`, `chargeSameCard`, `createBalancePayment`, `verifyWebhook` |
| `payments/MockProvider.js` | ברירת המחדל — "תופס" פיקדון ומאשר, **בלי חיוב אמיתי**. זה מה שרץ בהדגמות |
| `payments/CardComProvider.js` | סליקה ישראלית אמיתית (CardCom). מלון בלי `payment_credentials` נופל ל-Mock **עם אזהרה בקול**, כדי לא לשבור צ'ק אין |
| `payments/index.js` | **נקודת החיבור היחידה.** `paymentsFor(hotelId)` בוחר ספק לפי `config.payment_provider` של אותו מלון |

- **הבחירה היא פר-מלון**: מלון עובר לסליקה אמיתית בשינוי **שורת קונפיג אחת**
  (`payment_provider: "cardcom"` + `payment_credentials`), בלי נגיעה בקוד עסקי.
- מטבע: **ILS** (`PAYMENT_CURRENCY`), סכומים באגורות (50000 = ₪500).
- `settleFolio` (`checkin.js`) הוא צעד-אידמפוטנטי: כל פעולה חיצונית מוגנת בדגל משלה
  ונשמרת ל-DB מיד אחריה, כדי שריצה חוזרת אחרי קריסה לא תחייב פעמיים.
- ⚠️ ה-credentials הם **סודות** — מ-env/DB מוצפן בפרודקשן, לא בקוד. `redactConfig`
  מסתיר אותם מכל תגובת API.

---

## 6. Task list (משימות שנשארו)

Priority order (to be decided together):

- [x] **P0 — Payment abstraction + Mock provider.** Done: Stripe הוסר; הכול עובר דרך
      `payments/` עם `MockProvider` (דמו) ו-`CardComProvider` (אמיתי), בבחירה **פר-מלון**
      (`paymentsFor(hotelId)`). מתקן את לולאת באג #1. ראה §5.
- [x] **P0 — Safety / emergency flow.** Done: `emergency.js` — זיהוי דטרמיניסטי לפני כל
      זרימה אחרת, הנחיית 101/102/100, הסלמה כפולה (ביטחון + קבלה), ו-`logIncident` מתמיד.
      הניסוח מותאם לסוג המלון: בוטיק → "המנהל התורן עודכן, שירותי החירום הם שיטפלו";
      מלון מלא → "צוות הביטחון בדרך". ⚠️ עדיין חסר: אישור-קבלה (ack) מהצוות וסגירת אירוע.
- [x] **P0 — Persistence.** Done: sessions, reservations+folio, alerts, incidents and stats now
      persist to SQLite (`db.js`, built-in `node:sqlite` — no native deps) via a write-through cache
      in `state.js`/`checkin.js`; survives restart. Every table has a `hotel_id` column (ready for
      multi-tenant). `settleFolio` is step-idempotent (no double-charge on restart/re-run).
- [x] **P1 — Multi-tenant.** Done: `tenant.js` — זהות המלון נפתרת מ-`To` של Twilio
      (`hotel_numbers`) ומוזרקת ל-AsyncLocalStorage; סשנים והזמנות ממופתחים ב-`hotelId`,
      קונפיג ואנשי קשר פר-מלון, וכל מלון עונה מהמספר שלו. **שני מלונות מאומתים
      מקצה לקצה עם בידול מלא** (§9), כולל 600 שיחות במקביל ב-6 מלונות.
      `checkTenantIsolation` תופס מלון שיורש שדות ממלון ברירת המחדל.
- [x] **P1 — Fix checkout reachability** (set `session.stage` correctly; link session↔reservation).
      Done: `completeCheckin` now marks the session `checked_in` + stores `reservationId`/`roomNumber`;
      checkout shows the full bill, asks for confirmation, then charges the deposit (3 cases).
- [x] **P1 — Email routing.** Done: `email/` — `MockEmailProvider` (לוג) ו-`HttpEmailProvider`
      (Resend/SendGrid אמיתי לפי `EMAIL_API_KEY`). `notifyStaff` שולח **וואטסאפ + מייל**
      לכל בקשה, לכתובת של המחלקה *באותו מלון*. `emailIsLive` מתריע בעלייה אם רק מוק.
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
      (316 tests, `npm test`). Still missing: deeper coverage of the isolated payment provider layer
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
- **פקודות (`package.json`):**

| פקודה | מה היא עושה |
|---|---|
| `npm test` | **316 בדיקות** — `e2e` · `places` · `safety` · `scale` · `idsecurity` · `hoteltype` · `tenant-isolation` · `demo-switch` |
| `npm run preflight` | בדיקת ענק לפני הדגמה (§9.5) — 78 בדיקות עם Claude ו-Google אמיתיים |
| `npm run demo` | סימולציית שני המלונות מקצה לקצה |
| `npm run demo:lala` / `demo:kempinski` | **מפנה את מספר ה-Twilio למלון** (§9.4) |
| `npm run demo:status` / `demo:verify` | מי פעיל עכשיו / אימות חי מול המספר האמיתי |

- **Env vars** (אין `.env` ב-repo): `ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`, `BASE_URL`, `PORT`, `DASHBOARD_PASSWORD`,
  `GOOGLE_PLACES_API_KEY` (בלעדיו `places/` נופל ל-mock), `PLACES_PROVIDER` (אופציונלי),
  `ID_ENCRYPTION_KEY` (32 בייט hex/base64), `EMAIL_API_KEY` + `EMAIL_PROVIDER` + `EMAIL_FROM`
  (מייל אמיתי למחלקות; בלעדיהם מוק עם אזהרה), `DB_PATH` (ברירת מחדל `hotel.db`),
  `HOTEL_ID` (מלון ברירת המחדל), `AI_MAX_CONCURRENCY`, `VALIDATE_TWILIO`.
  **⚠️ אין יותר `STRIPE_*`** — Stripe הוסר מהפרויקט (§5).
- AI model in use: `claude-sonnet-4-6` (`bot.js`). הקונסיירז' רץ עם tool-use — הכלי
  `search_nearby_places` (`places/`) זמין לו בכל תור להמלצות מקומות אמיתיים.

### 7.1 Google Places — אימות חי (20.07.2026) ✅

החיבור **נבדק חי מול Google Places API (New)** עם מפתח אמיתי, ולא רק ביחידה/מוק.

- **השאילתה:** `"מסעדת בשר"`, `category=restaurant`, `languageCode=he`, `locationBias` סביב
  מיקום המלון בקונפיג (הירקון ת"א, `32.09 / 34.77`).
- **התוצאה:** `ok=true`, 6 תוצאות, **655ms**. מסעדות תל אביביות אמיתיות עם כתובות מדויקות,
  דירוגים ומספרי מדרגים: הלבנטיני (בן יהודה 170 · 4.6 · 440 מ׳), מיטבר (שדרות ח"ן 52 · 4.5),
  M25 שוק הכרמל (סמטת הכרמל 30 · 4.5), B12 TLV (קרליבך 12 · 4.6), טריגר (מונטיפיורי 21 · 4.3),
  מקום של בשר (שבזי 64 · 4.5). מיון לפי מרחק עובד, `distanceText`/`priceSymbol`/`mapsUri` תקינים.
- **מקצה לקצה:** הורצה שיחה מלאה דרך `handleIncoming` עם Claude אמיתי + Places אמיתי, בעברית
  ובאנגלית. **הכתובות שהבוט מסר זהות בדיוק לפלט הגולמי של ה-API** — לא המציא ולא שינה. במקביל
  הוא שילב מקום מ-`config.local_area` וציין שהוא כשר, כלומר שני המקורות עובדים יחד כמתוכנן.
- המפתח הועבר כמשתנה סביבה לפקודה בודדת — **לא נכתב לשום קובץ**, ואומת אחר כך שחיפוש תבנית
  המפתח על כל הריפו מחזיר אפס תוצאות ו-`git status` נקי.

### 7.2 smoke-check בהפעלה — מפתח פסול לא שותק ✅

**המלכודת:** `places/index.js` בוחר את הספק החי לפי **קיום** המפתח בלבד. מפתח שגוי / API לא
מופעל / מפתח מוגבל — נבחר בדיוק כמו תקין, כל חיפוש חוזר `400`, והבוט אומר בנימוס "אבדוק
ואחזור" **בלי שום סימן חיצוני שמשהו שבור**. בהדגמה זה נראה כאילו הקונסיירז' פשוט לא יודע.

**הפתרון (ממומש):** `smokePlaces(location)` ב-`places/index.js`, נקרא מ-`server.js` אחרי
`listen` — חיפוש אמיתי אחד, **לא חוסם** את עליית השרת ולעולם לא מפיל אותה. שלוש התנהגויות:

| מצב | לוג |
|---|---|
| מפתח תקין | `✅ Places smoke-check עבר — Google החזיר N תוצאה` |
| מפתח פסול (`invalid_key`) | בלוק שגיאה בולט + 4 דברים לבדוק לפי סדר |
| תקלה חולפת (429/5xx/רשת) | אזהרה מרוככת בלבד — לא מאשימים את המפתח |
| אין מפתח / `PLACES_PROVIDER=mock` | דילוג שקט (רץ על מוק במכוון) |

התנאי לכך הוא הפרדה חדשה ב-`GooglePlacesProvider`: **`400`/`403` → `reason:"invalid_key"`**
(תקלת הגדרות קבועה) לעומת `429` → `rate_limited` ו-`5xx`/רשת → `unavailable` (חולפות). בלי
ההבחנה הזו אי אפשר לדעת מתי לצעוק ומתי רק להזהיר. המפתח לעולם לא מודפס בלוג — יש בדיקה על כך.

שלושת המסלולים אומתו בהרצת `node server.js` אמיתית (מפתח תקין / מפתח פסול / בלי מפתח).

### 7.2.1 תאריכים שכבר עברו / לא הגיוניים ✅

`validateStayDates` מתנהג כמו פקיד קבלה: לעולם לא רושם הזמנה לא הגיונית, ותמיד אומר
*מה בדיוק* הבעיה (הודעה שגויה מבלבלת יותר מאשר לא לענות).

| קלט | תוצאה |
|---|---|
| הגעה שעברה (`10.7` ביולי 20) | `past` — נדחה |
| אתמול | **קביל** — אורח שמאחר בלילה |
| תאריך בלי שנה, עמוק בעבר (`10.5`) | מתפרש כשנה הבאה, ומאושר מול האורח עם השנה המלאה |
| עזיבה לפני הגעה (`25.7 - 23.7`) | `not_after` |
| אותו יום (`25.7 - 25.7`) | `not_after` (אפס לילות אינה שהייה) |
| `28.12 - 3.1` | **תקין** — שהייה שחוצה את השנה |
| `32.13`, `30.2` | `bad_date` |
| `1.1.2050` | `too_far` (אופק `MAX_AHEAD_DAYS` = שנתיים) |
| `25.7.2026 - 28.7.2027` | `too_long` (זו באמת שהייה ארוכה) |
| היום / מחר / מחרתיים / עוד שבוע / בעוד N ימים / today / tomorrow / in a week / next week / in N days | מחושבים לפי שעון ישראל |

שתי מלכודות שתוקנו ומכוסות בבדיקות:
1. **`not_after` מול `too_long`** — בטווח הפוך בלי שנה (`25.7 - 23.7`) השנה גולגלה קדימה
   והשהייה הפכה ל-363 לילות, ולכן האורח קיבל "שהייה ארוכה מ-60 לילות". `resolveToken`
   מחזיר עכשיו `rolled`, וכך מבחינים בין טווח הפוך לשהייה שחוצה את השנה.
2. **ביטוי יחסי אחד בלבד** — `findRelToken` החזיר את הראשון בלבד, ולכן "מהיום עד מחר"
   נקרא כתאריך יחיד. הוחלף ב-`findRelTokens` (רבים) עם `REL_PATTERNS`.

**שעת הגעה (ETA):** תצוגה בלבד — נשמרת כהערה לצוות ואינה משפיעה על תאריכים, תוקף כרטיס
או no-show. שעה שעברה אינה חוסמת; שעה לא חוקית (`25:00`) פשוט אינה נקלטת.

### 7.2.2 תיקוני הבדיקה החיה (21.07.2026) ✅

שבע תקלות שנצפו בשיחה אמיתית בוואטסאפ, וכולן תוקנו ברמה הדטרמיניסטית (ולא
רק ב-prompt) היכן שהיה אפשר:

| מה נצפה | השורש | התיקון |
|---|---|---|
| "שתי לילות" לא הובן | הפרסור חיפש ספרות בלבד | `numbers.js` — נרמול מילים→ספרות לפני **כל** פרסור (לילות, אורחים, שעות, "בעוד שלושה ימים"). "יום שני" מוגן במפורש |
| "בשמונה בערב" נקלט כ-08:00 | `\b` אינו עובד אחרי מילה עברית, ולכן זיהוי "בערב" נכשל בשקט | `DAY_PARTS` בלי `\b` על עברית; ETA מילולי → 20:00 |
| 10.7 (תאריך שעבר) נקלט כ"תאריך אחד" | בדיקת ה-past רצה רק כששני התאריכים ידועים | תאריך יחיד שעבר נדחה **מיד**, וההודעה נוקבת בתאריך ובתאריך של היום (`pastDate`/`today`) |
| "פסטה" → "מעביר לשירות החדרים" | לבוט לא היה תפריט, ולכן לא היה מה לשאול | תפריט מלא ב-`config` + פרוטוקול מלצר ב-prompt: מציעים מנות → משלימים רוטב/גודל/תוספות/אלרגיות → קוראים את ההזמנה → `[ROOMSERVICE:...]` מפורט |
| המלצה בלי שעות פתיחה; "אין לי מידע על שעות" | ה-FieldMask לא ביקש שעות מגוגל | `weekdayDescriptions` + טלפון + אתר ב-FieldMask; `todayHours` לפי שעון ישראל **ולפי שם היום** (ראה §7.2.3); ה-prompt מחייב למסור שעות ולחפש שוב במקום לומר "אין לי" |
| הזמנת שולחן בלי תאריך | רשימת הפרטים דרשה "היום והשעה" בלבד | תאריך/יום הוא פרט חובה בכל סוגי ההזמנות, התג נושא תאריך מפורש (22/07 ולא "מחר"), ותאריך/שעה שעברו נתפסים מול השעה הנוכחית. רשת ביטחון: `missingBookingParts` מסמן לצוות "חסר תאריך/שעה" |
| "חדר שקט" כדוגמה לבקשה מיוחדת | דוגמה מטופשת — כל החדרים שקטים | קומה גבוהה · נוף לים · מיטה זוגית או שתי מיטות · קרבה למעלית |

**ניתוב מחלקות — נבדק מקצה לקצה:** `TAG_DEPARTMENTS` עבר מ-`bot.js` ל-`config.js`
ליד אנשי הקשר, ולכן יש שרשרת אחת שאפשר להדפיס ולבדוק: תג → מחלקה → וואטסאפ +
מייל. `printRoutingTable()` רץ בעליית השרת, `GET /api/routing` מחזיר את אותה
טבלה, ובדיקה אוטומטית מוודאת שכל אחד משמונת התגים מגיע לשני הערוצים של המחלקה
הנכונה, עם מספר החדר, ובלי שהתג ידלוף לאורח.

| תג | מחלקה | וואטסאפ (דמו) | מייל (דמו) |
|---|---|---|---|
| `[HK]` / `[HK_URGENT]` | משק בית | +9721234567 | housekeeping@kempinski-demo.co.il |
| `[MAINTENANCE]` | אחזקה | +9729876543 | maintenance@kempinski-demo.co.il |
| `[ROOMSERVICE]` | שירות חדרים | +9724445566 | roomservice@kempinski-demo.co.il |
| `[CONCIERGE]` | קונסיירז' | +9721112233 | concierge@kempinski-demo.co.il |
| `[RECEPTION]` | קבלה | +9727654321 | reception@kempinski-demo.co.il |
| `[SECURITY]` / `[EMERGENCY]` | ביטחון | +9725556677 | security@kempinski-demo.co.il |

⚠️ אלה **מספרים ומיילים לדוגמה**. לפני הדגמה מול לקוח יש להחליף אותם במספרים
האמיתיים של המלון (`config.js` או `POST /api/config`) — אחרת ההתראות נשלחות
למספרים שאינם קיימים.

### 7.2.3 שעות פתיחה — אומת חי, ותפס באג של יום שלם (21.07.2026) ✅

הרצה חיה מול Google עם מפתח אמיתי (`places-live-check.mjs "מסעדת בשר"`, 6 תוצאות,
686ms) חשפה מיד באג שאף בדיקת יחידה לא הייתה תופסת:

**סדר הימים ש-Google מחזיר תלוי בשפה.** באנגלית `weekdayDescriptions` מתחיל ביום
שני (כמו שמתועד), אבל ב-`languageCode=he` הוא מתחיל ב**יום ראשון**. הקוד הראשון
חישב אינדקס לפי סדר קבוע — וב-21.07 (יום שלישי) מסר לאורח את השעות של **יום שני**.
שעות שגויות גרועות משעות חסרות: אורח הולך למסעדה סגורה בגלל מידע שנמסר לו בביטחון.

**התיקון:** `todayHoursLine` לא מניח שום סדר. הוא מחשב את שם היום *בשפת התוצאה*
(`Intl`, שעון ישראל) ומחפש את השורה שמתחילה בו; אם לא נמצא — מנסה את השפה השנייה,
ורק אז מוותר ומחזיר `null`. המוק עודכן לשקף את הסדר האמיתי (עברית מתחילה בראשון),
אחרת בדיקה שעוברת עליו מסתירה בדיוק את הבאג הזה. יש בדיקה על שני הסדרים ועל
הנסיגה בין השפות.

**אימות מקצה לקצה (Claude אמיתי + Google אמיתי):**
- "אני מחפש מסעדת בשר טובה באזור" → *M25 שוק הכרמל · סמטת הכרמל 30 · פתוח עד
  23:00 · 4.5 · 770 מ׳*, ועוד שתיים — כל כתובת, שעה, דירוג ומרחק **זהים בדיוק
  לפלט הגולמי של ה-API**.
- "עד איזו שעה הראשונה פתוחה?" → הבוט **קרא לכלי שוב** עם שם המקום וענה "עד 23:00"
  (זו בדיוק השאלה שקיבלה בעבר "אין לי מידע מדויק על שעות").
- "ומה הכתובת והטלפון שלה?" → כתובת מלאה + 03-558-0425, ישירות מגוגל.

### 7.2.4 הזמנת אוכל — רשת ביטחון מעל ה-AI ✅

הרצת כל התרחישים מול Claude אמיתי חשפה ש**ה-prompt לבדו אינו עקבי** בהזמנות
אוכל. באותה שיחה בדיוק, בהרצות שונות, ה-AI התנהג בשלוש דרכים: שלח את ההזמנה,
*או* ענה "כריך קלאב, לחם מלא — מושלם. לצרף משהו לשתות?" בלי תג (האורח בטוח
שהזמין, המטבח לא קיבל דבר), *או* שלח את אותה הזמנה **פעמיים** (שני כריכים).

לכן שלוש שכבות, כמו בכל שאר הזרימות הקריטיות בפרויקט:

1. **ה-prompt** — שני כללים הפוכים שחיים יחד, זה לצד זה: אסור להעביר הזמנה
   חלקית, **ואסור לעכב הזמנה שלמה**. אין הודעה שמאשרת מנה בלי `[ROOMSERVICE:...]`
   באותה הודעה; שתייה/קינוח/שעת הגשה הם תוספת שמציעים *אחרי* שההזמנה יצאה.
2. **שורת מצב דינמית** (`session.openFoodOrder`) — כשהאורח כבר נקב במנה ולא
   נשלחה הזמנה, ה-prompt של התור הבא נפתח ב"⚠️ מצב עכשיו: האורח בחר X,
   ההזמנה לא נשלחה". תיאור המצב *הנוכחי* חזק בהרבה מכלל כללי שקבור בהוראות.
3. **הסלמה מובטחת** (`trackFoodOrder`) — מנה ידועה + שני תורות בלי תג, או
   אישור מנה בלי שאלה ובלי תג, → הבקשה עוברת לשירות החדרים כ"הזמנה שלא
   נסגרה בצ'אט, נא ליצור קשר עם האורח". אורח לעולם לא ממתין לאוכל שלא הוזמן.

**הזמנה כפולה** (`flagDuplicateOrder`): תג שני עם אותה מנה בתוך 10 דקות אינו
נמחק (אולי האורח באמת רוצה עוד אחד) ואינו עובר בשקט — הוא מגיע למטבח עם
"⚠️ ייתכן שזו אותה הזמנה שכבר נשלחה לפני כ-N דק׳ — נא לוודא לפני הכנה כפולה".
מנה *אחרת* אינה כפילות, כדי שאורח שמוסיף קינוח יקבל אותו.

### 7.3 סימולציית הדגמה — `simulate.mjs` ✅

`node --experimental-test-module-mocks simulate.mjs [תרחיש]` מריץ את **כל** הזרימות
מקצה לקצה עם Claude אמיתי, Places אמיתי (אם יש מפתח) ו-DB זמני, ומדפיס בדיוק את מה
שהאורח רואה ואת מה שכל מחלקה מקבלת (וואטסאפ + מייל). רק שני דברים מוחלפים: טוויליו
(אין שליחה אמיתית) ואימות הזהות (דורש URL מדיה אמיתי של טוויליו).

תרחישים: `checkin`, `concierge`, `emergency`, `checkout`, `english`, `routing`, `followups`,
`dates`, `food` (הזמנת פסטה עד הסוף), `booking` (שולחן — כולל שאלת תאריך), `words`
(מספרים במילים), `hours` (שאלת המשך על שעות/כתובת/טלפון של מקום).
בלי ארגומנט — הכול. משמש לבדיקה לפני הדגמה מול לקוח, כשאי אפשר לבדוק בוואטסאפ.

### 7.4 מולטי-טננט — נקודת ההפרדה בין מלונות

`notifyStaff` **אינו** קורא יותר ל-`hotelConfig.<dept>_number` ישירות. כל אנשי הקשר
נשלפים דרך `departmentContacts(dept, hotelId)` ב-`config.js` — הנקודה **היחידה** בקוד
שיודעת לאיזה מספר/מייל הולכת התראה. `configFor(hotelId)` טוען קונפיג מלא של מלון
מסוים מטבלת `config` (מפתח `hotel_id`) מעל ה-`DEFAULTS` שבקוד, עם cache.

לכן מלון נוסף = **שורה נוספת ב-DB**, בלי שינוי בלוגיקה: ההתראה נשלחת עם `hotelId`,
ומכאן חוזרים אנשי הקשר של אותו מלון בלבד. אין מסלול שבו בקשה של מלון א' מגיעה
למחלקה של מלון ב' — כי אין יותר גלובל אחד שכולם קוראים ממנו. מה שעוד **חסר** כדי
להריץ מלונות במקביל: זיהוי הטננט מהמספר הנכנס (`To` של טוויליו → `hotelId`) והעברתו
דרך הסשן לכל הקריאות. `checkDepartmentContacts()` רץ ב-`server.js` בעלייה ומתריע
בקול על מחלקה בלי מספר או בלי מייל — אחרת הבקשה נעלמת בשקט.

## 8. ארכיטקטורת עומס, מולטי-טננט מלא ואבטחת מסמכי זיהוי (23.07.2026)

סבב "לבנות נכון ל-100 מלונות × 1000 אורחים". **כל 316 הבדיקות עוברות.**
מסמכי עומק: **`SCALING.md`** (יכולת נוכחית, מה נדרש לסקייל, עלויות) ו-**`SECURITY.md`**
(מסמכי זיהוי — GDPR + דין ישראלי).

### 8.1 עומס ומקביליות — `concurrency.js` (חדש)
- **`withLock(key, fn)`** — נעילה תורית per-key. `handleIncoming` מריץ כל הודעה
  תחת `withLock(tenantKey(hotelId, phone))`: שתי הודעות מהירות של אותו אורח
  מעובדות **בזו אחר זו** — אין דריסת מצב, אין כפילויות, אין אובדן. אורחים/מלונות
  שונים רצים במקביל.
- **`createSemaphore(max)`** — תקרת מקביליות לקריאות Claude (`AI_MAX_CONCURRENCY`, ברירת
  מחדל 24). 1000 אורחים לא פותחים 1000 חיבורים ל-Anthropic.
- **`retryWithBackoff` + `withTimeout`** — קריאות Google Places עטופות ב-timeout קשיח
  (9ש') + 3 ניסיונות עם backoff על תקלה חולפת (רשת/429/5xx). שירות איטי לא תוקע ולא מפיל.
- **`createRateLimiter`** — דלי אסימונים per-guest נגד הצפה/abuse (נדיב; לבלימת flood אמיתי).

### 8.2 מולטי-טננט מלא — `tenant.js` (חדש) + AsyncLocalStorage
- זהות המלון (`hotelId`) נפתרת מ-**`To` של Twilio** (`resolveHotelId`, טבלת `hotel_numbers`)
  ומוזרקת ל-**AsyncLocalStorage** ב-`handleIncoming` → `runInTenant(hotelId, …)`. כל
  קריאה פנימית קוראת `currentHotelId()` בלי לחווט פרמטר דרך 54 קריאות. הקשרים מקבילים
  מבודדים אוטומטית.
- **סשנים והזמנות ממופתחים/נושאים `hotelId`** (`state.js`: מפתח `tenantKey(hotelId,phone)`;
  `checkin.js`: `res.hotelId` + סינון חיפושים). אותו מספר טלפון בשני מלונות = **שני סשנים
  נפרדים**. `getSession/patchSession/pushHistory/peekSession` מקבלים `hotelId` (ברירת מחדל
  `currentHotelId()` → תואם-לאחור מלא למלון בודד).
- **תשובות יוצאות מהמספר של המלון** (`wa()` → `fromNumberFor(hotelId)`), הודעות צוות
  למחלקות של המלון בלבד, קונפיג פר-מלון (`hcfg()` = `configFor(currentHotelId())` בכל
  bot.js/checkin.js/checkin-routes.js). `updateConfigFor(hotelId, patch)` — onboarding מלון חדש.
- מלון חדש = `registerHotelNumber(number, hotelId)` + `updateConfigFor(hotelId, {...})`. בלי קוד.

### 8.3 אבטחת מסמכי זיהוי — `idverify/registry.js` (חדש) + `SECURITY.md`
- **ממצא מחקר שמעצב את המדיניות:** כל רשויות הפרטיות (CNIL/AEPD/Garante/DPC + הרשות
  הישראלית) — **verify-then-discard**: לאמת ולא לשמור את התמונה. AEPD קנסה מלון €30k על
  שמירת סריקה; ה-Garante מסמן איסוף ת"ז דרך WhatsApp כאסור.
- **מצב `ID_STORE_MODE=verify_discard`** (מומלץ לפרודקשן): מאמתים, שומרים רק *רישום אימות*
  (proof) — בלי תמונה. `store_encrypted` (דמו, ברירת מחדל) נשאר להדגמה.
- **retention** אוטומטי (`ID_RETENTION_DAYS`, ברירת מחדל 30; job כל 6ש'), **גישה מבוקרת
  + audit** (טבלאות `id_documents`/`id_access_log`; endpoints `/api/id-document*`), **בידוד
  מלון** (מלון א' לא פותח מסמך של מלון ב' — נחסם ונרשם). הצפנה AES-256-GCM נשארת.
- ⚠️ דגל כן: האימות שולח את התמונה ל-Claude vision (Anthropic, ארה"ב) — נדרש DPA/region.

### 8.4 בדיקות (חדש)
- **`scale.test.mjs`** (16) — פרימיטיבי מקביליות, בידוד tenant, ו**עומס: 300 הודעות במקביל
  בשני מלונות** — בלי קריסה, בלי דליפה, בלי אובדן, כל תשובה מהמספר הנכון, סמפור ≤24.
- **`idsecurity.test.mjs`** (7) — round-trip הצפנה, מטא-דטא בלבד, audit, בידוד חוצה-מלונות,
  verify-then-discard, ו-retention.

### 8.5 מה עדיין דורש תשתית חיצונית (ראה SCALING.md, בכנות)
המצב הנוכחי (תהליך בודד + SQLite) מספיק לפיילוט של כמה מלונות. ל-100×1000 בפרודקשן
נדרש: **PostgreSQL** מנוהל (המעבר מרוכז אך דורש הפיכת שכבת ה-state ל-async — 2–4 ימים,
לא "שורה"), **Redis** (סשנים+נעילות מבוזרות לריבוי תהליכים), עותקים מרובים + LB, מספר
Twilio לכל מלון, ו-**vault/S3+KMS** למסמכי זיהוי. עלות תשתית התחלתית ~$80–440/חודש;
המשתנים הדומיננטיים בסקייל הם Twilio ו-Anthropic לפי נפח.

## 9. שני מלונות במקביל — מה שההרצה החיה חשפה (29.07.2026)

הרצה מלאה של **שני מלונות באותו תהליך** לקראת הדגמות ללקוחות (LALA בוטיק,
דרך בן צבי 78 · קמפינסקי מלא, הירקון 51), עם Claude אמיתי ו-Google אמיתי.
כלי ההרצה: **`simulate-demo.mjs`** (`npm run demo [lala|kempinski|isolation|geography]`).

### 9.1 מחלקת התקלות שהתגלתה: **ירושה שקטה מ-DEFAULTS**
קונפיג של מלון נטען כ-overrides **מעל** `DEFAULTS`, ולכן כל שדה שהמלון לא
הגדיר נשאר *של מלון ברירת המחדל*. שום דבר לא חסר, שום בדיקה לא נכשלת, ואף
לוג לא צועק — ולכן זה נראה תקין לחלוטין עד שלקוח שואל "למה לא הגיע?".

חמישה מקרים אמיתיים שנתפסו ותוקנו (כולם ב-LALA, שהוגדרה חלקית):

| מה קרה | מדוע זה חמור |
|---|---|
| בקשת אחזקה של אורח ב-LALA נשלחה לאחזקה **של קמפינסקי** | הבקשה נעלמת. האורח קיבל "העברתי", ואיש לא טיפל |
| חשבונית המס של LALA נשאה את **שם העוסק ומספר הח.פ. של קמפינסקי** | מסמך מס שגוי, לא רק תצוגה |
| הודעת הפתיחה: *"ברוכים הבאים למלון קמפינסקי"* לאורח של LALA | ההודעה הראשונה שאורח רואה |
| LALA ירשה את **מסעדות המלון** ואת ה-FAQ של קמפינסקי | הקונסיירז' ממליץ על מסעדה שאינה קיימת |
| `building.key_areas` הבטיח **בריכה בקומה 12 וספא בקומה 3** במלון בן 4 קומות | מידע שגוי שנמסר בביטחון |

⚠️ **`{}` אינו מנקה שדה — רק `null` מנקה.** `restaurants: {}` השאיר את מסעדות
ברירת המחדל במקומן. זו המלכודת שיצרה שניים מהמקרים למעלה.

### 9.2 התיקונים
- **`checkTenantIsolation(hotelId)` / `reportTenantIsolation`** (`config.js`) — משווה כל
  מלון מול `DEFAULTS`: אנשי קשר של 6 מחלקות, פרטי עוסק, מיקום, **ומקטעים שלמים**
  (`restaurants`/`faq`/`building`/`services`/`local_area`/`wifi`/`arrival`/`parking`/`safety`).
  רץ בעליית השרת על **כל** מלון רשום, ומוחזר גם מ-`POST /api/hotels` (`isolated`,
  `sharedWithDefault`) — כך שמלון חדש לא עולה לאוויר עם ההגדרות של מלון אחר.
  זה ההבדל מ-`checkDepartmentContacts`, שבודק רק מה *חסר*, ולכן פספס את כל אלה.
- **`welcomeFor(hotelId, lang)`** (`config.js`) — הודעת הפתיחה **נבנית מהמלון**: שמו שלו,
  ורק השירותים שבאמת קיימים אצלו (מלון בלי בריכה/ספא/חדר כושר לא מציע אותם, וגם לא
  "טיפול בספא"). `DEFAULTS.welcome` הוא `null`; מלון עם נוסח שיווקי משלו עדיין גובר,
  עם `{hotel}`.
- **LALA הוגדרה במלואה** (`sample-hotels.mjs`) — אנשי קשר, עוסק, מרחב מוגן, מבנה מלא,
  FAQ משלה, `restaurants: null`.
- **`flagDuplicateOrder`** (`bot.js`) — עבר מ"רשימות מנות זהות" ל**חפיפה**. נצפה חי:
  אורח הזמין לינגוויני, ואז הוסיף כוס יין — וה-AI שלח את ההזמנה *כולה* מחדש. הרשימות
  לא היו זהות (1 מול 2), אז שום דגל לא הודלק, והמטבח קיבל **שתי מנות פסטה**.
- **`addDemoCharges`** (`checkin.js`) — חיובי ההדגמה נגזרים מהשירותים שקיימים במלון
  (חשבון של בוטיק בלי ספא לא כולל "עיסוי שוודי").

### 9.3 מה אומת בהרצה החיה
צ'ק אין מלא בשני המלונות (קוד דלת מול כרטיס בקבלה), אימות ת"ז ודרכון,
**מע"מ 18% לתושב מול 0% לתייר חוץ** (`assessTourist` מהדרכון), קונסיירז' עם מקומות
אמיתיים סביב *כל* מלון בנפרד, שירות חדרים מהתפריט, חירום (בוטיק → 101 + מנהל תורן
ו"אין צוות במקום"; מלון מלא → "צוות הביטחון בדרך"), ניתוב מחלקות בוואטסאפ+מייל,
וצ'ק אאוט מלא עם חשבונית מס-קבלה בשני המלונות. **17 בדיקות בידוד — כולן עברו.**
הבידוד נעול ב-`tenant-isolation.test.mjs` (11 בדיקות דטרמיניסטיות, בלי AI ובלי רשת).

### 9.4 מספר Twilio אחד, שני מלונות — `demo-switch.mjs`

**המצב:** יש מספר Twilio **אחד**, ומדגימים מלון אחר בכל יום. המערכת כבר מזהה
מלון לפי המספר שאליו האורח כתב (`hotel_numbers`: number → hotel_id), ולכן
ההחלפה היא בפועל **שורה אחת ב-DB**. הבעיה היא מה שקל לשכוח סביבה:

| מלכודת | מה היה קורה בלעדיה |
|---|---|
| הקונפיג של המלון לא ב-DB | המספר מצביע על `lala`, `configFor` לא מוצא שורה → נופל ל-DEFAULTS = **עונה כקמפינסקי** |
| נשאר מיפוי של מספר דמו לאותו מלון | `fromNumberFor` בוחר את המספר הישן → תשובות יוצאות ממספר שלא קיים ב-Twilio |
| סשן ישן של אותו טלפון באותו מלון | אין הודעת פתיחה, ואולי המשך של צ'ק אין ישן שנתקע |
| השרת כבר רץ | `numberMap` ו-`configCache` בזיכרון התהליך — ההחלפה "לא קורית" עד restart |

`demo-switch.mjs` מטפל בארבעתן:

```
npm run demo:lala        # המספר עונה כ-LALA
npm run demo:kempinski   # המספר עונה כקמפינסקי
npm run demo:status      # מי פעיל עכשיו
```

הכלי כותב את הקונפיג ל-DB, ממפה את המספר (ומוחק מיפויים יתומים כך שנשארת
**שורה אחת בדיוק**), מנקה את הסשנים של אותו מלון, קורא ל-`POST /api/tenant/reload`
כדי שהשרת הרץ יקלוט מיד (בלי restart), ואז מדפיס **כרטיס הדגמה**: שם המלון,
המיקום שסביבו הקונסיירז' מחפש, קוד-דלת מול כרטיס, פיקדון ומע"מ, פרטי העוסק
לחשבונית, אנשי הקשר של שש המחלקות, והודעת הפתיחה המלאה שהאורח יקבל. בסוף —
אזהרה אם אנשי הקשר עדיין לדוגמה, ואם המלון חולק שדות עם ברירת המחדל.

דגלים: `--number=+972…` (אם אין `TWILIO_WHATSAPP_NUMBER`), `--keep-sessions`,
`--fresh` (מוחק גם הזמנות ישנות של אותו מלון).

מכוסה ב-`demo-switch.test.mjs` (6 בדיקות): מעבר לשני הכיוונים דרך נתיב ה-webhook
האמיתי, אפס פרטים של המלון הקודם, איפוס סשן, מיפוי יחיד, וחשבונית שנושאת את
העוסק של המלון הפעיל.

**אימות מול המספר האמיתי** (`npm run demo:verify [lala|kempinski]`) —
`verify-number.mjs` רץ מול **hotel.db האמיתי** ומול `TWILIO_WHATSAPP_NUMBER`
האמיתי, מריץ הודעה דרך אותו נתיב בדיוק של webhook (`handleIncoming` עם `meta.to`),
ומדפיס את התשובה שהאורח יקבל. שליחת Twilio מוחלפת — **לא נשלחת שום הודעה**.
נבדק: הניתוב, שהמספר היוצא זהה לנכנס (אחרת Twilio דוחה), שהתשובה נושאת את זהות
המלון, ושאין בה אף פרט של המלון השני. הסשן הזמני נמחק בסוף.

**`GET /api/tenant/resolve?to=…`** (קריאה בלבד) מחזיר למי **השרת הרץ** מנתב מספר
נתון — **מהזיכרון שלו**, לא מה-DB. זו ההבחנה שמוכיחה שהריענון נקלט בלי restart.
אומת חי על מספר ה-Sandbox `+14155238886` (30.07.2026): השרת החזיק `lala` →
הורצה `demo-switch kempinski` → השרת ענה `kempinski` (כרטיס, ע.מ 514000000,
הירקון 51) → `demo-switch lala` → חזר ל-`lala` (קוד דלת, ע.מ 515111222, בן צבי 78).
בשלושת המצבים `replyFrom` נשאר `+14155238886`, ולוג השרת רשם את שני הריענונים.

### 9.5 `preflight.mjs` — בדיקת ענק אחת לפני הדגמה (`npm run preflight`)

`node --experimental-test-module-mocks preflight.mjs [סבבים]` מריץ ארבעה חלקים
עם Claude אמיתי ו-Google אמיתי, ומחזיר קוד יציאה 0/1:

| חלק | מה נבדק |
|---|---|
| **A · בידול קונסיירז'** | N סבבים (ברירת מחדל 20) שבהם שני המלונות שואלים את *אותה* שאלה **במקביל**. מאמת שכל חיפוש יצא עם הקואורדינטות של המלון שביקש, שהתוצאות קרובות אליו ולא לשני, ששם מקום שהוחזר רק לאחד לא הופיע בהודעת השני, ושהאורח לא ראה את שם המלון האחר |
| **B · עומס** | 6 מלונות × 100 אורחים = **600 שיחות במקביל** (מסלול דטרמיניסטי), ואז 30 הודעות **AI אמיתי** במקביל. מאמת שאין קריסה, שכל אורח קיבל סשן בשלב הנכון, שאין סשן שדלף למלון אחר, ושכל תשובה יצאה מהמספר הנכון |
| **C · תהליכים מלאים** | צ'ק אין בשני המלונות ובשתי השפות: **דחיית רישיון נהיגה** (והישארות בשלב הזהות), ת"ז מול דרכון, זיהוי תייר, **"כן" אינו אישור תנאים**, רישום ה-hash של הנוסח, פיקדון, אמצעי כניסה לפי סוג המלון, צ'ק אאוט, ועקביות החשבונית (עוסק, שיעור מע"מ, `net+vat=total`, סכום = folio) |
| **D · איכות פלט** | כל הודעה שנשלחה לאורח בכל החלקים: תגים פנימיים, טבלאות/כותרות/`**` שוואטסאפ לא מרנדר, `undefined`/`null`/`NaN`/`[object Object]`, placeholder שלא הוחלף, שורות ריקות כפולות, צורות לוכסן, רווח כפול, הודעה ריקה או מעל 1500 תווים, ועקביות שפה (אורח אנגלי בלי עברית, התראות צוות תמיד בעברית) |

**החלק שמגן על הבדיקה מעצמה:** סבב שבו ה-AI רק שאל שאלת הבהרה ולא חיפש אינו מוכיח
דבר על בידול. לכן A סופר כמה סבבים באמת הפעילו חיפוש בשני המלונות וכמה שמות מקומות
ייחודיים הושוו, ונכשל אם הכיסוי דליל. בהרצה של 25 סבבים: 20/25 סבבים עם חיפוש כפול,
170 שמות שהושוו, **78/78 בדיקות עברו**.

> Rule for future work: payments change in ONE place (the provider abstraction). Never re-couple
> business logic to a specific payment vendor. Same rule for the DB (`db.js` + the repository
> functions), the tenant boundary (`tenant.js`), and ID storage (`idverify/index.js`).
>
> **וכלל נוסף, מ-§9:** מלון חדש = **כל** השדות שלו, לא רק שם ומיקום. כל שדה שלא הוגדר
> שייך עדיין למלון ברירת המחדל. לפני כל הדגמה: `npm test` · `npm run preflight` · `npm run demo`.
