# StayBot — WhatsApp Hotel Reception Bot

> בוט וואטסאפ למלונות שמחליף את הקבלה. עובד 24/7, עברית + אנגלית, **רב-מלונות (multi-tenant) — ממומש**.
> A WhatsApp bot that fully replaces the hotel front desk. 24/7, Hebrew + English.

---

## 0. מצב נוכחי — קרא את זה קודם (04.08.2026)

| | |
|---|---|
| **בדיקות** | **628 עוברות, 0 נכשלות** (`npm test`, 32 קבצים) · voice 0 שגיאות · demo 17/17 · preflight 65/65 · **עומס: מיליון הודעות** |
| **סקירה אחרונה** | 04.08 — סקירה עצמית מלאה לפני הדגמה. חמישה ממצאים, כולם תוקנו ונעולים בבדיקות. ראה **§8.15** |
| **מלונות מוגדרים** | **LALA Boutique** (בוטיק · דרך בן צבי 78 · קוד לדלת · בלי צוות במקום) · **The David Kempinski** (מלון מלא · הירקון 51 · כרטיס בקבלה · צוות 24/7) |
| **בידול** | מלא ומאומת — מיקום, קונסיירז', מחלקות, עוסק לחשבונית, שירותים. אין מסלול שבו פרט של מלון אחד מגיע לאורח של השני |
| **ענן (פרודקשן)** | Railway · `https://hotel-bot-production-0230.up.railway.app` · **auto-deploy מ-main פעיל ומאומת** |
| **מלון פעיל בענן** | **קמפינסקי — מקובע.** `DEMO_HOTEL=kempinski` מוגדר ב-Railway, ולכן **שורד redeploy**. אומת ב-`cloud:check` |
| **מלון פעיל מקומית** | קמפינסקי (`npm run demo:kempinski`) |
| **מספר וואטסאפ** | `whatsapp:+14155238886` (Twilio Sandbox) — מספר **אחד** שמשרת מלון אחר בכל יום |
| **מסד נתונים** | SQLite (ברירת מחדל) **או Postgres** לפי `DATABASE_URL` — נקודת החלפה אחת. כל גישה עוברת ב-`store/Repo.js`. ⚠️ מסלול PG טרם נבדק מול שרת אמיתי |
| **זיכרון** | חסום — LRU + TTL לסשנים/הזמנות/קונפיג, עם read-through. אין יותר תקרת RAM |
| **חירום** | זיהוי דטרמיניסטי → הנחיית 101 → הסלמה → **סולם אישור-קבלה** (`escalation.js`, §8.6) |
| **תשלומים** | `payments/` — Mock (דמו) / CardCom (סליקה ישראלית), בחירה פר-מלון. **Stripe הוסר לגמרי** |
| **PMS** | `pms/` — Mock פעיל. **13 מערכות נתמכות** (אופטימה · אורקל/OHIP · Mews · Cloudbeds · Apaleo · protel · Fidelio · Guestline · RoomRaccoon · StayNTouch · Clock · Hotelogix · eZee). ראה `PMS_GUIDE.md` ו-`OPTIMA_PMS.md` |
| **סטטוס עסקי** | הודגם ל-LALA (30.07) — התקבל היטב. השלב הבא: חיבורי PMS אמיתיים |

**⚠️ שני מסלולי החלפת מלון — לא לבלבל ביניהם:**

| מסלול | מה הוא משנה | מתי משתמשים |
|---|---|---|
| `npm run demo:lala` / `demo:kempinski` | **המחשב המקומי בלבד** (`hotel.db`) | פיתוח, ובדיקה מקומית עם ngrok |
| `DEMO_HOTEL` ב-Railway + redeploy | **הענן — ומתמיד** | פרודקשן. זו הדרך היחידה ששורדת redeploy |
| `node cloud-set-hotel.mjs <url> <hotel>` | **הענן — מיידית, בלי redeploy** | הצלת הדגמה. ⚠️ נמחק ב-redeploy הבא אם אין `DEMO_HOTEL` |

> 🔴 **כלל שנולד מבאג אמיתי (31.07):** כל קוד ששולח הודעה לאורח **חייב** לרוץ
> בתוך `runInTenant(hotelId)`. בקשת HTTP (עמודי הפיקדון/החשבונית) אינה רצה
> בהקשר טננט, ולכן `wa()` היה גוזר את המספר היוצא ממלון ברירת המחדל — ואורח
> של LALA היה מקבל את אישור הצ'ק אין **מהמספר של קמפינסקי**. עם מספר אחד זה
> בלתי נראה לחלוטין. תוקן ב-`checkin-routes.js`, ומכוסה בשתי בדיקות.

**למה `demo-switch` לא משפיע על הענן:** הוא כותב ל-DB של המכונה שמריצה אותו. הענן
מכונה אחרת, עם DB אחר, ועל Railway מערכת הקבצים **בת-חלוף** — לכן ההגדרה חייבת
להיגזר ממשתנה סביבה. ראה `DEPLOY.md` ו-§9.4.

### שכבת ה-PMS (30.07.2026)

| קובץ | תפקיד |
|---|---|
| `pms/PmsProvider.js` | הממשק + **capability flags** — כל אדפטר מצהיר מה הוא תומך, והקוד העסקי **מדרדר בחן** במקום ליפול |
| `pms/normalize.js` | **המבנה הקנוני**. JSON של ספק לעולם לא יוצא מהאדפטר. כסף באגורות, תאריכים `YYYY-MM-DD`, סטטוסים מאוחדים |
| `pms/http.js` | timeout · retry **רק על תקלה חולפת** · סיווג שגיאות (auth/not_found/rate_limit/unavailable) · **הסתרת סודות בכותרות וב-URL** |
| `pms/OptimaPmsProvider.js` | **מימוש מלא** — REST או XML, מיפוי שדות עם שמות חלופיים, `describe()` לאבחון בלי סודות |
| **`pms/vendors.js`** | **רישום 13 מערכות ה-PMS.** כל ספק הוא **מפרט** (הזדהות, נתיבים, מיפוי, יכולות, ומה לבקש מהמלון) — לא מחלקה |
| **`pms/RestPmsProvider.js`** | **מנוע גנרי** שמריץ כל מפרט. תומך ב-oauth2 / bearer / basic / body_tokens (Mews) + כותרות ייחודיות (`x-app-key` של OHIP) |
| `pms/index.js` | `pmsFor(hotelId)` — ספק **פר-מלון** · `pmsReadiness(hotelId)` — מה מוגדר ומה חסר · נפילה בטוחה ל-Mock |

**למה רישום ולא מחלקה לכל ספק:** 13 מחלקות כמעט-זהות הן 13 מקומות לתקן כשמשהו
משתנה. כאן תיקון ב-retry או במיפוי מתקן את **כל** הספקים בבת אחת, והוספת ספק
חדש היא **אובייקט ב-`vendors.js`** — בלי קוד ובלי בדיקות חדשות למנוע.

### תקן הניסוח — `voice.js` (31.07.2026)

"טון חם ואלגנטי" לא עוצר אף הודעה גרועה. התקן הפך ל**20 כללים בדוקים**:
ריסון (עד 4 אמוג׳י · עד 2 סימני קריאה) · ודאות (בלי "אולי"/"אין לי מידע") ·
זהות (לעולם לא "אני בוט") · טיפוגרפיה (`…` ולא `...`) · נקיון (markdown,
placeholders, `undefined`, תגים).

| כלי | מה הוא עושה |
|---|---|
| `voice.js` | הכללים — **מקור אמת אחד**, משמש גם את `preflight` חלק D |
| `npm run voice` | מריץ את כל הזרימות ומדרג כל הודעה **וכל עמוד**. **77 לאורח + 21 לצוות + 16 עמודי HTML → 0 שגיאות** |
| `auditHtml` | עמודי הפיקדון/אישור/חשבונית — נרנדרים דרך **HTTP אמיתי** ונבדקים: `lang`/`dir`/viewport/charset/title, קישורים מתים, **ושהעמוד ממותג במלון הנכון ומוביל לוואטסאפ שלו** |
| `tidyForWhatsApp` | רשת ביטחון דטרמיניסטית לפני כל שליחה (`...`→`…`, `!!`→`!`, רווח כפול) |

**שלוש שכבות** (כמו בכל זרימה קריטית): prompt → נורמליזציה דטרמיניסטית →
בדיקה מול Claude אמיתי. הנחיה לבדה אינה מספיקה — נצפה חי ש-Claude כתב `...`
למרות ההוראה.

> 🔴 **שלושה באגים רב-מלוניים בעמודי ה-HTML (31.07):** עמוד הפיקדון — שבו האורח
> מוסר פרטי כרטיס — היה ממותג **בשם מלון ברירת המחדל** (`hotelConfig.name` במקום
> `configFor(reservation.hotelId)`); כפתור "חזרה לצ'אט" נשא **מספר וואטסאפ קשיח**
> בחמישה עמודים, כך שאורח של מלון שני היה נשלח לצ'אט של מלון אחר; ובמלון בלי
> בריכה עמוד האישור הציג לאורח שורה **"בריכה — undefined"**. כולם תוקנו ומכוסים.

> 🔴 **מלכודת שחזרה:** `\b` ב-regex **אינו עובד על עברית** (`\w` הוא ASCII).
> כללי "אני בוט" ו"אולי…אולי" נכתבו עם `\b` ולכן **לא תפסו כלום** — המבקר
> דיווח "נקי" בלי לבדוק. זו אותה מלכודת שכבר תועדה ב-§7.2.2. אין `\b` סביב
> עברית, אף פעם.

### סקייל אופקי — `store/` (31.07.2026)

**התקלה השקטה שזה פותר:** `withLock` מגן על **תהליך אחד**. ברגע שמוסיפים
instance, שתי הודעות של אותו אורח רצות במקביל בשני תהליכים → צ'ק אין נדרס
או **הזמנה נשלחת פעמיים**. בלי שגיאה ובלי לוג.

| קובץ | תפקיד |
|---|---|
| `store/index.js` | נקודת החלפה יחידה — `MemoryStore` (ברירת מחדל) או `RedisStore` לפי `REDIS_URL` |
| `store/lock.js` | **`withGuestLock`** — נעילה מקומית *וגם* מבוזרת · `checkSharedRate` |
| `store/pg-schema.sql` | סכימת Postgres מלאה (JSONB, TIMESTAMPTZ, מפתחות `(hotel_id,…)`) |

`bot.js` עבר ל-`withGuestLock`. **בלי `REDIS_URL` ההתנהגות זהה לחלוטין להיום**;
איתו — בטוח להריץ כמה עותקים. השרת מתריע בעלייה כשרצים בלי Redis.

### מסד נתונים — Postgres (31.07.2026)

`node:sqlite` סינכרוני ו-`pg` אסינכרוני, ואי אפשר לעטוף אחד בשני. המעבר נשען
על שלוש עובדות שכבר קיימות: הקריאות בזמן ריצה מגיעות מה-cache (לא מה-DB),
הכתיבות הן write-through ולא נקראות בחזרה מיד, והקריאות הבודדות שכן נוגעות
ב-DB יושבות בהקשר אסינכרוני.

| קובץ | תפקיד |
|---|---|
| `store/PgDriver.js` | דרייבר + **תור כתיבות מסודר** (API סינכרוני מבחוץ) |
| `store/persistence.js` | `initPersistence()` — נקודת ההחלפה. בלי `DATABASE_URL` → SQLite, **התנהגות זהה** |
| `store/pg-schema.sql` | סכימה מלאה, מפתחות `(hotel_id,…)` — בידוד נאכף ע"י ה-DB |

**התור מבטיח:** סדר · אי-עצירה בשגיאה · אי-חסימה של הקורא.
**לא מבטיח:** קריסה פתאומית עלולה לאבד כתיבות שטרם נשטפו → מסלולי כסף
והכיבוי החינני קוראים `flush()` במפורש.

> 🔴 **מונה החשבוניות** היה אטומי ב-SQLite רק כי התהליך חד-חוטי. עם Postgres
> ומספר עותקים, שני צ'ק אאוטים בו-זמנית היו מקבלים **אותו מספר** — שתי
> חשבוניות מס זהות, בעיה חוקית. `nextInvoiceSeqSafe` עוברת ל-`UPDATE … RETURNING`.

### `store/Repo.js` — התפר שגרם למידע *באמת* לזרום ל-Postgres (02.08.2026)

**מה היה שבור:** `PgDriver` היה קיים, הסכימה נוצרה, ה-ping עבר — ו**אף סשן
אחד לא עבר שם**. כל `db.prepare` בפרויקט (50 מקומות) דיבר ישירות עם SQLite.
מסלול שאינו מקבל נתונים אינו מסלול.

`prepare(sql)` מחזיר משפט שמדבר עם שניהם:

| | SQLite | Postgres |
|---|---|---|
| `.run()` | סינכרוני | נכנס לתור מסודר (לא חוסם) |
| `.get()` / `.all()` | סינכרוני | 🔴 **זורק** |
| `.getAsync()` / `.allAsync()` / `.runAsync()` | עטוף | `await` אמיתי |

**למה כתיבה יכולה להישאר סינכרונית וקריאה לא:** כתיבה היא write-through
ואיש אינו קורא אותה מיד, ולכן מותר לתור אותה כל עוד הסדר נשמר. קריאה
מחזירה ערך — ואין דרך להמתין לו בלי `await`.

> 🔴 **`.get()` זורק ולא מחזיר `null`.** `null` שקט פירושו "אין אורח כזה":
> סשן שקיים ב-Postgres היה נראה כאורח חדש, והאורח היה מאבד שם, חדר,
> היסטוריה ושלב צ'ק אין באמצע שיחה. שגיאה רועשת בבדיקה עדיפה.

**איפה נטען המידע בפועל:** `handleIncoming` מחמם `ensureConfigLoaded` +
`ensureSessionLoaded` לפני כל הקוד הסינכרוני — זו הנקודה היחידה שיש בה
גם הקשר אסינכרוני וגם ידיעה מי האורח ומאיזה מלון. מסלולי HTTP שאינם עוברים
שם (עמוד הפיקדון, הצלחה, חשבונית) מחממים `ensureReservationLoaded`.

**"נבדק ואינו קיים" (`confirmedAbsent`):** בלעדיו אורח **חדש** לא היה יכול
לפתוח שיחה — ההודעה הראשונה שלו הייתה נכשלת. `ensureSessionLoaded` שבדק
את ה-DB ולא מצא מסמן זאת, ורק אז `getSession` רשאי ליצור.

**שלושה באגים אמיתיים שהבדיקה החדשה חשפה** (`pgpath.test.mjs` — לקוח pg
מזויף שמריץ את ה-SQL **באמת**, ולכן תרגום שגוי נכשל בו כמו מול pg):
1. `completeCheckin` (עמוד הצלחת התשלום) ו-`autoChargeOnNoShow` (cron)
   נגעו בסשן שאיש לא חימם — הצ'ק אאוט בצ'אט לא היה נגיש.
2. הידרציה ברמת המודול קראה מ-SQLite תמיד; ב-Postgres הקונפיג, ההתראות
   ומיפוי המספרים היו **ריקים** והשרת היה עונה כמלון ברירת המחדל לכל מספר.
3. `invoice_counters` היה `(hotel_id)` ב-SQLite ו-`(hotel_id, year)`
   ב-Postgres. המספר מודפס כ-2026-00042 — כלומר **מספר חשבונית מס שונה
   לפי מסד הנתונים שבמקרה הוגדר**. הושווה, עם מיגרציה ששומרת על הרצף.

⚠️ **עדיין לא נבדק מול שרת Postgres אמיתי** (אין PG/Docker בסביבה). לפני
שימוש: `psql "$DATABASE_URL" -f store/pg-schema.sql` והרצת הבדיקות מולו.

### read-through cache — תקרת הזיכרון הוסרה (01.08.2026)

**זו הייתה התקרה האמיתית, לא מסד הנתונים.** `state.js` ו-`checkin.js` החזיקו את
**כל** הסשנים וההזמנות של **כל** המלונות בזיכרון, לנצח. עובד למלון–שניים,
קורס במיליוני מלונות — בגלל RAM, לא בגלל ה-DB.

| רכיב | חסם |
|---|---|
| `store/LruCache.js` | LRU + TTL, פינוי לפי שימוש אחרון |
| סשנים (`state.js`) | `SESSION_CACHE_MAX` (50k) · TTL 24ש' |
| הזמנות (`checkin.js`) | `RESERVATION_CACHE_MAX` (20k) · TTL 48ש' |
| קונפיג (`config.js`) | `CONFIG_CACHE_MAX` (5k) |

**למה הפינוי בטוח:** הכתיבה היא **write-through** — כל שינוי כבר ב-DB לפני
שהפינוי אפשרי. פינוי מרוקן זיכרון בלבד; החטאה טוענת מחדש מה-DB.

> 🔴 **הסכנה שנסגרה:** החטאה ב-cache **אינה** "אורח חדש". יצירת סשן חדש
> בהחטאה הייתה **מוחקת לאורח את ההיסטוריה, השם, החדר ושלב הצ'ק אין באמצע
> שיחה**. `getSession`/`peekSession` טוענים מה-DB *לפני* שהם יוצרים.

**כל סריקה הוחלפה בשאילתת DB** — `allSessions`, `sessionByRoom`, `sessionCount`,
`getActiveReservation`, `getPendingReservation`, `getReservationByRoom`,
`findNoShowReservations`, `activeReservationCount`. סריקת זיכרון אחרי פינוי
הייתה מחזירה רק את ה"חמים": אורח קיים היה נראה כלא-מאוכלס, ו-no-show לא היה
מחויב. `reservations[id]` נשאר עובד דרך Proxy עם read-through, כדי שעמוד
הפיקדון ימצא הזמנה גם אחרי פינוי.

מכוסה ב-`lru.test.mjs` (12) ו-`readthrough.test.mjs` (12) — עם cache בגודל 3
שמכריח פינוי אמיתי, כולל בידוד מלונות אחרי פינוי.

**המסמכים לעסק (בסדר הקריאה):**
1. **`PMS_START_HERE.md`** — 🚪 **נקודת הכניסה.** שאלה אחת למלון, טבלת ניתוב
   לפי התשובה, ושלושת המשפטים שחוסכים שבועיים.
2. **`OPTIMA_PMS.md`** — צלילה לאופטימה (רוב המקרים בישראל): בעלות, המייל
   המדויק למלון, וצ'קליסט קבלה.
3. **`PMS_GUIDE.md`** — כל 13 המערכות. **נוצר אוטומטית** מ-`vendors.js`
   (`npm run pms:guide`), ולכן לא יכול להתיישן — יש בדיקה שנכשלת אם המדריך
   מפגר אחרי הקוד.

### וידוא רב-מלונות — `all-hotels.test.mjs` (31.07.2026)

**כל תקלה רב-מלונית בסבב הזה נראתה תקינה עד שנבדקה על מלון שני** — עמוד פיקדון
ממותג במלון אחר, כפתור צ'אט שהוביל למלון אחר, "בריכה: undefined" במלון בלי
בריכה. לכן הבדיקות כאן רצות **בלולאה על כל המלונות**, ומלון חדש שיתווסף
ל-`sample-hotels.mjs` נבדק אוטומטית ולא יישכח.

נבדק לכל מלון: זהות ומיקום ייחודיים · בידוד מלא · אנשי קשר שלמים ולא משותפים
**בין** מלונות (שיתוף *בתוך* מלון לגיטימי — בבוטיק אותו אדם מקבל קונסיירז'
ושירות חדרים) · שכבות PMS/סליקה נפתרות · הפתיחה בשמו ובלי שירות שאין לו ·
מרחב מוגן מוגדר · חשבונית עם העוסק שלו ומע"מ נכון (תושב ותייר) · ומודל
התפעול עקבי (בוטיק ⇒ קוד דלת + מנהל תורן).

**ובנוסף:** בדיקה שמקימה **מלון חדש לגמרי** מקונפיג בלבד ומריצה עליו את כל
השכבות — הוכחה שמלון עתידי לא דורש שורת קוד.

**בדיקה מהירה לפני כל הדגמה:**
```
npm test                                              # 613 בדיקות
npm run cloud:check -- <railway-url> --expect=lala    # מה הענן באמת מחזיק
npm run demo:verify lala                              # מה האורח יקבל (בלי לשלוח)
```

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
| `state.js` | State עם **write-through ל-DB** (`sessions`, `staffAlerts`, `incidents`, `stats`). כל סשן ממופתח ב-`tenantKey(hotelId, phone)` — אותו טלפון בשני מלונות = **שני סשנים נפרדים**. `getSession` (טהור, read-through), `peekSession`, `patchSession`, `recordActivity`, `logAlert`, `logIncident`, `updateIncident(Async)`, `hydrateState`. ה-cache **חסום** (LRU+TTL) — ראה §"read-through". | Works · מתמיד · מולטי-טננט |
| **`store/Repo.js`** | **התפר היחיד בין הקוד ל-DB.** `prepare(sql)` מחזיר משפט שמדבר גם עם SQLite וגם עם Postgres: כתיבה סינכרונית (תור מסודר), קריאה סינכרונית **זורקת** ב-PG, ו-`*Async()` עובד בשניהם. בלעדיו Postgres קיבל סכימה ולא נתונים. | Works |
| **`escalation.js`** | **סולם הסלמת חירום** — מועד יעד לאישור קבלה, הסלמה לדרג הבא, סגירת אירוע עם תיעוד. מגובה-DB (שורד ריסטארט) ונעול per-incident (שורד ריבוי עותקים). ראה §8.6. | Works |
| `server-pages.js` | עמודי HTML של **הצוות** (אישור קבלה על אירוע חירום). מודול נפרד כדי שביקורת הניסוח תוכל לבדוק אותם בלי להרים שרת. | Works |
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
  ✅ **נסגר (02.08.2026) — `escalation.js`:** אישור-קבלה, הסלמה חוזרת וסגירת אירוע. ראה §8.6.
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
- ~~No logging/monitoring~~ · ~~no rate-limiting~~ · ~~no Twilio request validation~~ — **חלקית**:
  יש `createRateLimiter` per-guest, `VALIDATE_TWILIO` (opt-in), ודדופ של הודעות נכנסות
  (`MessageSid`). **עדיין חסר:** לוגים מובנים (JSON) ומוניטורינג חיצוני.
- ~~No tests~~ **DONE** — **510 בדיקות ב-20 קבצים** (`npm test`), ראה הטבלה ב-§7.
  מכסות צ'ק אין, אימות קלט, שפה, תגים, זהות, מדיניות מסמכים, תאריכי שהייה, אישור תנאים,
  עקביות שפה מקצה לקצה, זרימת צ'ק אאוט מלאה, **שכבת התשלום** (`payments.test.mjs`),
  **מסלול Postgres** (`pgpath.test.mjs`), **cache ופינוי** (`lru` + `readthrough`),
  **הסלמת חירום** (`escalation.test.mjs`), ו**כל המלונות בלולאה** (`all-hotels.test.mjs`).

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

- **מתמיד ל-SQLite או ל-Postgres** — הבחירה לפי `DATABASE_URL`, דרך נקודת החלפה אחת
  (`store/persistence.js`). כל גישה ל-DB עוברת ב-**`store/Repo.js`** (`prepare(sql)`),
  ולכן אין קוד עסקי שיודע מול איזה מסד הוא מדבר.
- `state.js` (sessions, alerts, incidents, stats) ו-`checkin.js` (reservations + folio)
  מחזיקים **cache חסום** (LRU + TTL) בכתיבת write-through, עם **read-through** בהחטאה.
  שורד ריסטארט; הזיכרון חסום גם במיליוני מלונות.
- כל טבלה נושאת `hotel_id`, וכל שאילתה מסוננת לפיו.
- ~~Not persisted — restart wipes everything~~ (resolved).
- **מולטי-טננט — עובד**: סשנים ממופתחים ב-`tenantKey(hotelId, phone)`, הזמנות נושאות
  `res.hotelId` והחיפושים מסוננים, הקונפיג נטען פר-מלון, וההתראות יוצאות למחלקות של
  אותו מלון בלבד. אותו טלפון בשני מלונות = שני סשנים נפרדים. אומת בעומס: 600 שיחות
  במקביל ב-6 מלונות, בלי דליפה (§9.5).
- **מה שעוד נדרש לסקייל אמיתי** (100 מלונות × 1000 אורחים, ראה `SCALING.md`):
  ~~Postgres (המעבר דורש הפיכת שכבת ה-state ל-async)~~ **✅ נעשה** (`store/Repo.js`) —
  נותר רק להריץ מול שרת אמיתי; ~~Redis לנעילות מבוזרות~~ **✅ נעשה** (`store/lock.js`,
  מופעל עם `REDIS_URL`). **עדיין נדרש:** מספר Twilio לכל מלון, ו-vault/S3+KMS
  למסמכי זיהוי.

---

## 5. Payment code structure (מבנה קוד התשלום) — ✅ מבודד

**Stripe הוסר לחלוטין מהפרויקט.** אין `import Stripe` באף קובץ, ואין מפתח Stripe ב-env.
כל התשלומים עוברים דרך שכבה אחת:

| קובץ | תפקיד |
|---|---|
| `payments/PaymentProvider.js` | הממשק: `authorizeDeposit`, `capture`, `cancel`, `chargeSameCard`, `createBalancePayment`, `verifyWebhook` |
| `payments/MockProvider.js` | ברירת המחדל — "תופס" פיקדון ומאשר, **בלי חיוב אמיתי**. זה מה שרץ בהדגמות |
| `payments/CardComProvider.js` | **סליקה ישראלית אמיתית — ממומשת** (CardCom API v11). עמוד סליקה מתארח (LowProfile) כך שפרטי הכרטיס **לא עוברים דרך השרת שלנו**. מלון בלי `payment_credentials` נופל ל-Mock **עם אזהרה בקול** |
| `payments/index.js` | **נקודת החיבור היחידה.** `paymentsFor(hotelId)` בוחר ספק לפי `config.payment_provider` של אותו מלון |

- **הבחירה היא פר-מלון**: מלון עובר לסליקה אמיתית בשינוי **שורת קונפיג אחת**
  (`payment_provider: "cardcom"` + `payment_credentials`), בלי נגיעה בקוד עסקי.
- מטבע: **ILS** (`PAYMENT_CURRENCY`), סכומים באגורות (50000 = ₪500).
- `settleFolio` (`checkin.js`) הוא צעד-אידמפוטנטי: כל פעולה חיצונית מוגנת בדגל משלה
  ונשמרת ל-DB מיד אחריה, כדי שריצה חוזרת אחרי קריסה לא תחייב פעמיים.
- ⚠️ ה-credentials הם **סודות** — מ-env/DB מוצפן בפרודקשן, לא בקוד. `redactConfig`
  מסתיר אותם מכל תגובת API.

> 🔴 **שתי מלכודות ב-CardCom שנסגרו (31.07):**
> **(א)** CardCom מחזירה **HTTP 200 גם על כשל** — ההבחנה היא `ResponseCode !== 0`.
> בלי הבדיקה הזו כרטיס שנדחה נראה כתשלום מוצלח, והאורח מקבל חדר בלי פיקדון.
> **(ב)** אימות webhook **חייב** להיות שאילתה חוזרת ל-CardCom (`GetLpResult`) —
> כל אחד יכול לשלוח POST ולטעון שעסקה הצליחה. `verifyWebhook` הסינכרוני מסרב
> במפורש ומפנה ל-`verifyWebhookAsync`.
>
> 🔴 **חוזה התשובה אוחד:** `MockProvider` החזיר `{success}` ו-CardCom `{ok}` —
> שני ספקים מאחורי ממשק אחד שמדברים אחרת. הסטנדרט הוא **`ok`**, ו-`success`
> נשמר כשם נרדף. כל הסכומים **באגורות**.

---

## 6. Task list (משימות שנשארו)

Priority order (to be decided together):

- [x] **P0 — Payment abstraction + Mock provider.** Done: Stripe הוסר; הכול עובר דרך
      `payments/` עם `MockProvider` (דמו) ו-`CardComProvider` (אמיתי), בבחירה **פר-מלון**
      (`paymentsFor(hotelId)`). מתקן את לולאת באג #1. ראה §5.
- [x] **P0 — Safety / emergency flow.** Done: `emergency.js` — זיהוי דטרמיניסטי לפני כל
      זרימה אחרת, הנחיית 101/102/100, הסלמה כפולה (ביטחון + קבלה), ו-`logIncident` מתמיד.
      הניסוח מותאם לסוג המלון: בוטיק → "המנהל התורן עודכן, שירותי החירום הם שיטפלו";
      מלון מלא → "צוות הביטחון בדרך". ✅ אישור-קבלה וסגירת אירוע — ראה §8.6.
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
- [~] **P2 — Harden — רובו נעשה.** ✅ אימות חתימת Twilio (`VALIDATE_TWILIO`, opt-in) ·
      ✅ הגבלת קצב per-guest (`createRateLimiter`) + משותפת ב-Redis · ✅ דדופ של הודעות
      נכנסות לפי `MessageSid` (retry של טוויליו לא יעובד פעמיים) · ✅ מטבע ILS ·
      ✅ שם/פיקדון/WiFi/שירותים מהקונפיג · ✅ סודות מוסתרים מה-API ומהלוגים.
      **עדיין פתוח:** לוגים מובנים (JSON) + מוניטורינג חיצוני, והחדר הקשיח "304"
      (יש כבר נקודת חיבור ל-PMS ב-`checkin-routes.js`; יוחלף כשמלון יחבר PMS אמיתי).
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
- [x] **P3 — Tests. Done — 510 בדיקות ב-20 קבצים** (`npm test`), ובנוסף שלושה כלים
      שרצים מול Claude ו-Google אמיתיים: `npm run voice` (ניסוח + 20 עמודי HTML),
      `npm run demo` (17 בדיקות בידוד), `npm run preflight` (65 בדיקות).
      הפער שהיה רשום כאן — כיסוי שכבת התשלום — **נסגר** (`payments.test.mjs`).

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
| `npm test` | **628 בדיקות ב-32 קבצים** (`npm run test:audit` מוודא שאף קובץ לא נשמט) — `e2e` · `places` · `safety` · `scale` · `idsecurity` · `hoteltype` · `tenant-isolation` · `demo-switch` · `demo-bootstrap` · `pms-optima` · `pms-vendors` · `store` · `voice` · `persistence` · `payments` · `all-hotels` · `lru` · `readthrough` · `pgpath` · `escalation` · `settlement` · `httpasync` · `jobs` · `schedule` · `takeover` · **`concierge-budget`** · **`media`** |
| `node --experimental-test-module-mocks stress.mjs [n] [hotels]` | **בדיקת עומס** — ברירת מחדל מיליון הודעות ב-200 מלונות (§8.7) |
| `npm run voice` | ביקורת ניסוח — 77 הודעות לאורח + 21 לצוות + **20 עמודי HTML** |
| `npm run preflight` | בדיקת ענק לפני הדגמה (§9.5) — 65 בדיקות עם Claude ו-Google אמיתיים (המספר גדל עם מספר הסבבים) |
| `npm run demo` | סימולציית שני המלונות מקצה לקצה |
| `npm run demo:lala` / `demo:kempinski` | **מפנה את מספר ה-Twilio למלון** (§9.4) |
| `npm run demo:status` / `demo:verify` | מי פעיל עכשיו / אימות חי מול המספר האמיתי |

- **Env vars** (אין `.env` ב-repo): `ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`, `BASE_URL`, `PORT`, `DASHBOARD_PASSWORD`,
  `GOOGLE_PLACES_API_KEY` (בלעדיו `places/` נופל ל-mock), `PLACES_PROVIDER` (אופציונלי),
  `ID_ENCRYPTION_KEY` (32 בייט hex/base64), `EMAIL_API_KEY` + `EMAIL_PROVIDER` + `EMAIL_FROM`
  (מייל אמיתי למחלקות; בלעדיהם מוק עם אזהרה), `DB_PATH` (ברירת מחדל `hotel.db`),
  `HOTEL_ID` (מלון ברירת המחדל), `AI_MAX_CONCURRENCY`, `VALIDATE_TWILIO`,
  **`STAFF_TOKENS`** (תפקידים והרשאות — ראה §8.13).
  **כוונון וקשיחות (§8.7):** `SQLITE_SYNCHRONOUS` (ברירת מחדל `NORMAL` — פי 17
  מהר יותר מ-`FULL`), `MAX_INBOUND_CHARS` (4000), `PROVIDER_CACHE_MAX` (5k),
  `SESSION_CACHE_MAX` (50k), `RESERVATION_CACHE_MAX` (20k), `CONFIG_CACHE_MAX` (5k),
  `EMERGENCY_ACK_TIMEOUT_MS` (3 דק׳), `DATABASE_URL` (מעבר ל-Postgres),
  `REDIS_URL` (נעילה מבוזרת לריבוי עותקים),
  **`PLACES_BUDGET_MS`** (12ש׳ — תקרת זמן **כוללת** לחיפוש המקומות, כולל
  retry; §8.15) ו-**`PLACES_ATTEMPT_MS`** (6ש׳ לניסיון בודד).
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

סבב "לבנות נכון ל-100 מלונות × 1000 אורחים". **כל 323 הבדיקות עוברות.**
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
*(עודכן 02.08.2026: המעבר ל-async נעשה — ראה `store/Repo.js`.)*

### 8.6 `escalation.js` — אף אירוע חירום לא נשאר בלי אדם שאישר קבלה (02.08.2026)

**הפער המסוכן ביותר שהיה בפרויקט.** זרימת החירום זיהתה, הנחתה את האורח
להתקשר 101, והסלימה לביטחון ולקבלה — ואז כלום. **איש לא אישר קבלה.** טלפון
ביטחון כבוי, משמרת שהתחלפה, הודעה שנבלעה → האורח פצוע בחדר, המערכת מדווחת
"טופל", ואף אחד אינו בדרך. שקט שנראה כמו הצלחה.

**סולם הסלמה עם מועד יעד לאישור** (`EMERGENCY_ACK_TIMEOUT_MS`, ברירת מחדל 3 דק׳):

| דרג | למי | מתי |
|---|---|---|
| 0 | ביטחון + קבלה | ההסלמה המקורית, עם שורת "נא לאשר קבלה" + קישור |
| 1 | מנהל תורן (`duty_manager_number`) | לא אושר תוך 3 דק׳ |
| 2 | **כל** המחלקות + הכרזה "אף אחד לא אישר קבלה" | לא אושר תוך 6 דק׳ |

- **אישור:** `GET /incident/:id/ack` (קישור בהתראה — לחיצה מהטלפון) או
  `POST /api/incident/:id/ack`. נרשם **מי** אישר; אישור שני אינו דורס את הראשון
  (שרשרת אחריות).
- **סגירה:** `POST /api/incident/:id/close` — **דורשת תיאור מה נעשה**. אירוע
  שנסגר בלי תיעוד אינו סגור.
- **סולם מוצה:** מפסיקים להציף, אבל האירוע **אינו** מסומן כמאושר ואינו נסגר.

> 🔴 **למה זה מגובה-DB ולא `setTimeout`:** טיימר חי בזיכרון תהליך אחד. ריסטארט —
> ו-deploy קורה בדיוק כשמשהו נשבר — היה מוחק את כל הטיימרים ואירוע פתוח היה
> **נשכח בשקט**. `ackDeadline` נשמר על האירוע, וסורק כל 30ש' מוצא כל מי שעבר
> את מועדו. גם האישור נשמר ל-DB: אישור שחי רק בזיכרון היה גורם להסלמה חוזרת
> אחרי deploy — אזעקת שווא על אירוע שטופל, וזה שוחק את אמון הצוות בהתראות.

ריבוי תהליכים: `withGuestLock` על מזהה האירוע — אחרת שלושה עותקים היו שולחים
שלוש אזעקות על אותו אירוע. הבידוד מלא: ההסלמה הולכת למלון של האירוע בלבד.

⚠️ מודע: זה מבטיח ש**נשלחה** התראה ושמישהו אישר קבלה בערוץ. זה אינו מבטיח
שאדם באמת יצא לחדר — אין תחליף לנוהל מלון. אבל עכשיו אי אפשר שאיש לא יידע.
מכוסה ב-`escalation.test.mjs` (13 בדיקות) + בדיקת אישור-קבלה אחרי ריסטארט ב-`pgpath.test.mjs`.

## 8.7 סקירת קוד מלאה + עומס קיצוני (02.08.2026)

מעבר על כל 16.4k שורות הקוד, ובדיקת עומס של **מיליון הודעות**. מה שנמצא
הוא בדיוק מה שבדיקות רגילות לא תופסות: מרוצי-תנאים, חסמים חסרים, ותקלות
שמופיעות רק בנפח.

### 🔴 חיוב כפול — הממצא החמור ביותר

`settleFolio` מגן על כל פעולת תשלום בדגל (`captured`/`overageCharged`),
אבל **הדגל נקבע רק אחרי ה-await** שחוזר מספק הסליקה. זה מגן מפני ריצה
*חוזרת* (קריסה ואז ריצה שנייה) — אבל לא מפני שתי ריצות **במקביל**:
שתיהן רואות `false`, שתיהן קוראות ל-`capture`, האורח מחויב פעמיים.

לא תיאורטי: צ'ק אאוט בצ'אט רץ תחת נעילת האורח (`handleIncoming`), אבל
`autoChargeOnNoShow` מופעל מ-cron — **מחוץ** לנעילה. אורח שכותב
"צ'ק אאוט" בדיוק כשה-cron מחייב אותו על no-show הוא ההצטלבות המדויקת.

**התיקון:** `withGuestLock("reservation:<id>")` סביב הסליקה — מסדר את
שתי הריצות בזו אחר זו, וגם בין תהליכים (עם `REDIS_URL`).

> ✅ **הבדיקה אומתה מול הקוד השבור.** ביטלתי זמנית את הנעילה: 4 מתוך 5
> בדיקות נכשלו, `capture` נקרא פעמיים. בדיקת רגרסיה שעוברת גם על הקוד
> השבור אינה מוכיחה דבר.

**ועוד שכבה, שבלעדיה התיקון היה חלקי — `failClosed`:** `withGuestLock`
נכשל **פתוח** בכוונה — אם Redis איטי, ההודעה מטופלת בכל זאת, כי אורח
בלי מענה הוא נזק ודאי וכפילות היא סיכון נדיר. במסלול כסף ההיגיון
**הפוך**: אם אי אפשר להבטיח בלעדיות, עדיף **לא לסלוק כלל** מאשר לחייב
פעמיים. `settleFolio` רץ עם `failClosed: true` (ו-TTL של 60ש', כי יש בו
עד שתי קריאות רשת לספק) — נכשל בקול, וה-cron של no-show ינסה שוב.
בלי זה, נעילה שלא נתפסה הייתה מחזירה בדיוק את החיוב הכפול.

**ובנוסף:** `res.overageChargedTo = "deposit_card"` ישב **מחוץ** ל-try,
ולכן כרטיס שנדחה עדיין הותיר רשומה שמצהירה "ההפרש חויב מכרטיס הפיקדון" —
רישום כספי שקרי שהצוות היה מברר מולו את האורח.

### 🔴 פי 17 על מסד הנתונים — `PRAGMA synchronous`

ברירת המחדל של SQLite היא `FULL`: **fsync בכל כתיבה**. נמדד: 917
כתיבות/שנייה מול **15,625** עם `NORMAL`. כל הודעת אורח מבצעת כמה כתיבות,
ולכן זה היה החסם היחיד על קצב המערכת — **106 → 834 הודעות/שנייה, פי 8**.

`NORMAL` הוא ההמלצה הרשמית של SQLite יחד עם WAL. מה זה מוותר עליו,
בכנות: קריסת *אפליקציה* בטוחה לחלוטין; רק נפילת חשמל/מערכת הפעלה עלולה
לאבד את העסקאות האחרונות, והמסד לעולם לא נפגם. ניתן להחזיר עם
`SQLITE_SYNCHRONOUS=FULL`.

### 🔴 בקשת HTTP שנתקעת לנצח — `http-async.js`

ב-Express 4 (בניגוד ל-5) **דחיית promise בהאנדלר אינה נתפסת**. התוצאה
אינה 500 — היא *כלום*: הבקשה נשארת פתוחה עד שהדפדפן מוותר. היו **13
נתיבים אסינכרוניים בלי הגנה**, כולל עמוד הפיקדון שהאורח נוחת עליו.

התיקון הוא עטיפה של ה-router עצמו (`catchAsyncRoutes`) ולא 13 בלוקים של
try/catch — כי הנתיב ה-14 שייכתב בעתיד ייכתב בלי, ואיש לא ישים לב.
בתוספת `errorHandler` שמחזיר JSON ל-API ועמוד דו-לשוני קצר לאורח.

### 🔴 ארבעה cache-ים פר-מלון בלי גבול

`payments` · `invoices` · `pms` · `whatsapp` החזיקו `Map` פתוח עם מופע
ספק **לכל מלון שאי פעם נגעו בו, לנצח** — בדיוק התקרה שהוסרה מהסשנים
וההזמנות, ונשארה כאן. עברו ל-`LruCache` (`PROVIDER_CACHE_MAX`, 5k).
פינוי חינמי: מופע ספק מחזיק credentials בלבד ונבנה מחדש בהחטאה.
(`places/cache.js` כבר היה חסום, ו-`withLock` כבר מנקה את מפתחותיו —
שניהם נבדקו, לא הונחו.)

### 🔴 הודעה נכנסת בלי חסם אורך

`/webhook` הוא נתיב HTTP פתוח, ואימות חתימת Twilio **כבוי כברירת מחדל**
— כלומר כל אחד יכול לשלוח "הודעה" של 100KB. היא נכנסה להיסטוריית הסשן
(30 הודעות לאורח), נשמרה ל-DB, **ונשלחה ל-Claude על חשבון המלון**.
`MAX_INBOUND_CHARS` (4000, יותר מפי שניים מהמקסימום של וואטסאפ) חותך
בכניסה, בנקודה אחת שכל הערוצים עוברים דרכה.

### 🔴 זיהוי מנות תפס מילים שאינן מנות

`namedDish` השווה אסימון בן 4+ תווים כ**תת-מחרוזת**: `"rice"` בתוך
`"price"`. אורח ששואל *"what is the price of the spa?"* נרשם כמי שהזמין
מנת אורז. נצפה בעומס: טקסט שהכיל `LAMB` סווג כהזמנת "Hummus & lamb kebab".
עכשיו נדרשים גבולות מילה — **בלי `\b`**, שאינו עובד על עברית (המלכודת
שכבר תועדה פעמיים), אלא בדרישה שמשני הצדדים יהיה תו שאינו אות/ספרה.

### `stress.mjs` — בדיקת העומס (`node --experimental-test-module-mocks stress.mjs [הודעות] [מלונות]`)

**מיליון הודעות · 200 מלונות · 660 הודעות/שנייה · עד 814MB זיכרון.**

| מה | מצב |
|---|---|
| טננט · נעילות · סשנים · DB · cache · בידוד | ✅ **רץ באמת**, מיליון פעם |
| קריאת ה-AI ושליחת הוואטסאפ | 🔬 מדומים |

⚠️ **הכנות שחייבת להיאמר:** מיליון קריאות אמיתיות ל-Anthropic אינן
אפשריות (עלות, מכסה, שעות) — והן היו בודקות את השרת של Anthropic, לא את
הקוד הזה. במקומן יש מודל מזויף **דטרמיניסטי** שמחזיר חתימה ייחודית לכל
אורח, וזה מה שמאפשר לוודא שכל אורח קיבל את **תשובתו שלו**. איכות הניסוח
נבדקת בנפרד מול Claude אמיתי (`npm run voice`, `npm run preflight`).

נבדק ואומת: אפס קריסות · **אפס תשובות שהתחלפו בין אורחים** · אפס דליפות
בין מלונות · אפס הודעות ריקות · הזיכרון נשאר חסום · מיליון סשנים נשמרו
ונטענו בחזרה אחרי פינוי · ו-1,200 אורחים שהחליפו שפה באמצע שיחה קיבלו
את השפה הנכונה ושמרו עליה.

> 🔴 **שלושה לקחים על הכלי עצמו, לא על המוצר** — כולם מקרים שבהם הכלי
> שיקר, לטובה או לרעה:
> **(א)** הגרסה הראשונה ספרה `noReply` ו**לא בדקה אותו** — היא הכריזה
> "אפס כשלים" בזמן ששני אורחים לא קיבלו תשובה. כלי בדיקה ששותק על כשל
> גרוע מכלי שלא קיים.
> **(ב)** המודל המזויף ניחש שפה לפי תווי הטקסט, אבל `stripLanguageRequest`
> מסיר את בקשת המעבר — כך ש"דבר איתי בעברית בבקשה" הגיע אליו בלי אף אות
> עברית. הכלי דיווח על 600 כשלי שפה **שאינם קיימים במוצר**. עכשיו הוא
> קורא את השפה מה-system prompt, כמו המודל האמיתי.
> **(ג)** החתימות נוצרו ב-`toString(36)`, ושתיים מתוך מיליון יצאו
> **"FIRE"** ו-**"AZAA"**. `detectEmergency` תפס אותן — וזו התנהגות
> **נכונה לחלוטין**: מילה חד-משמעית חייבת להפעיל חירום גם בתוך משפט על
> מזגן. הבוט השיב בהנחיות חירום (בלי חתימה), והכלי ספר "לא קיבלו תשובה"
> — כשהם קיבלו את התשובה הטובה ביותר האפשרית. נתוני בדיקה לא ייצרו
> מילים לעולם; החתימות הן ספרות בלבד. **אותם שני אורחים בדיוק נכשלו
> בשתי ריצות עצמאיות של מיליון** — הדטרמיניזם הזה הוא מה שאיפשר למצוא.

## 8.8 `jobs.js` — עבודות מחזוריות שבאמת רצות (03.08.2026)

שלושה באגים מאותה משפחה: משהו שמתועד כעובד, ששום דבר לא הפעיל.

| מה | מה קרה בפועל |
|---|---|
| **הדשבורד לא הוגש** | `index.html` (50KB, ממשק שלם עם מסך כניסה) ישב בשורש, ו-`express.static` הצביע על `dashboard/public` — **תיקייה שלא קיימת** |
| **חיוב no-show לא רץ** | הקוד קיים, נבדק, ומתועד כ"cron יריץ" — ואיש לא הריץ. אורח שעזב בלי צ'ק אאוט **לא חויב, בשקט** |
| **no-show ללא הקשר טננט** | שולח 3 הודעות לאורח דרך `wa()`, מ-cron/API — **מחוץ** ל-`runInTenant`. אורח של מלון א' היה מקבל את החיוב **מהמספר של מלון ב'** |

> 🔴 **"יש cron" בתיעוד בלי cron בקוד גרוע מפיצ'ר חסר** — כולם מניחים
> שהוא עובד. ההוכחה שזה היה אמיתי: בהפעלה הראשונה העבודה חייבה הזמנה
> תקועה אמיתית, וההתראות לקבלה ולמשק הבית יצאו.

**`jobs.js` — משגיח אחד במקום `setInterval` מפוזרים.** לכל עבודה מחזורית
דרושים אותם ארבעה דברים, ואם כל אחת מממשת אותם לבד — אחת תשכח:
אי-חפיפה עם עצמה · לא מפילה את התהליך · `unref` · **מצב גלוי**.
`GET /api/jobs` הופך עבודה מתה לנראית במקום למשוערת.

הדשבורד הועבר ל-`dashboard/public/` ולא הוגש מהשורש — הגשת השורש הייתה
חושפת את `.env` ואת `hotel.db`.

**ובנוסף — הבדיקות היו אדומות לסירוגין.** לא assertion: מריץ הבדיקות של
Node משבש את ערוץ ה-IPC שלו במקביליות מלאה (8 קבצים). אותן 533 בדיקות
עוברות כך או כך, אבל **סוויטה שנצבעת אדום באקראי היא בדיוק מה שמלמד
להתעלם ממנה**. נעוץ ל-`--test-concurrency=4`, אומת ביציבות בשלוש ריצות.

## 8.9 `schedule.js` — המערכת יוזמת, לא רק עונה (03.08.2026)

**זה השינוי שהופך "בוט שעונה" ל"פקידת קבלה".** עד כאן המערכת הייתה עונה
מצוינת: אורח כותב, היא משיבה. פקידת קבלה אמיתית אינה מחכה שישאלו אותה.

**ציר הזמן של השהייה** — שש הודעות, כולן נבנות מהקונפיג של אותו מלון:

| הודעה | מתי | מה יש בה |
|---|---|---|
| אישור הזמנה | דקה אחרי ההזמנה | שם, תאריכים, ומה יגיע בהמשך |
| **יום לפני** | 18:00 מקומי | כתובת · ניווט · חניה · שעת כניסה · **ההצעה היחידה** |
| בוקר ההגעה | 09:00 מקומי | חדר · קוד דלת **או** כרטיס בקבלה · WiFi |
| **"הכול כרצונך?"** | שעתיים אחרי הכניסה בפועל | שאלה אחת קצרה |
| ערב לפני עזיבה | 19:00 מקומי | שעת פינוי · יציאה מאוחרת · ארוחת בוקר |
| אחרי העזיבה | 11:00 למחרת | תודה · חשבונית · ביקורת · חפצים שנשכחו |

**למה "יום לפני" הוא גם מנוע ההכנסה:** זה הרגע היחיד שבו האורח מתרגש
ועוד לא הגיע — ולכן שם ההצעה (ספא, ואם אין — מסעדה), **אחת בלבד**, ורק
אם המלון באמת מציע את השירות.

### 🔴 ארבע ההגנות — כי הודעה יזומה נשלחת בלי שביקשו

הודעה יזומה היא הדבר היחיד שהמערכת שולחת ביוזמתה, ולכן **כל טעות בה
נראית לאורח כרשלנות של המלון, לא כתקלה טכנית**:

| הסיכון | ההגנה |
|---|---|
| הודעה כפולה → "המלון מבולגן" | `UNIQUE(reservation_id, kind)` + נעילה |
| הודעה ב-03:00 → מעירה אורח | **שעות שקטות** 21:00–08:00, **נדחית** ולא מתפספסת |
| הודעה לאורח שעזב/ביטל | ביטול מדורג + שומר לפני כל שליחה |
| נשכחת ב-deploy | **מגובה-DB**, לא `setTimeout` |

> 🔴 **אזור זמן פר-מלון.** "יום לפני, בשש בערב" חייב להיות שש בערב **אצל
> האורח**. מלון בניו יורק אינו שולח לפי שעון ישראל — כל חישוב עובר דרך
> `location.timezone` של אותו מלון.

> 🔴 **שני באגים שהבדיקות תפסו מיד:** `parking.he` ו-`arrival.he` הם
> **אובייקטים** ולא מחרוזות, ושרשור ישיר הפיק `🅿️ [object Object]` —
> בדיוק מחלקת "בריכה: undefined" שכבר תועדה. `oneLine()` בוחר את השדות
> המועילים ומחזיר שורה אחת. ובנוסף, מפרידי השורות הריקות סוננו יחד עם
> השדות הריקים, וההודעה יצאה כגוש צפוף — ההפך מרושם של מלון יוקרה.

> 🔴 **כלל ניסוח חדש — `gendered-address`:** כתבתי "אם תרצי", "השיבי",
> "תזכירי". **המערכת אינה יודעת את מגדר האורח** — שם פרטי אינו מעיד עליו.
> פנייה בנטייה מפורשת פוגעת בחצי מהאורחים בהודעה הראשונה שהם מקבלים.
> הכלל תופס נטיות נקבה בגוף שני בלבד; "אותך", "שלך", "שבחרת" נכתבות זהה
> לשני המגדרים ולכן אינן נתפסות, ובצדק. (ובלי `\b` — ראה §7.2.2.)

## 8.10 `takeover.js` + הדשבורד — אדם נכנס לשיחה (03.08.2026)

יש רגעים שבהם התשובה הנכונה היא **אדם**: אורח כועס, תלונה רגישה, מקרה
חריג. בלי המנגנון הזה מנהל יכול רק להתקשר בנפרד, והשיחה בוואטסאפ ממשיכה
להיענות אוטומטית במקביל — האורח רואה שני גורמים שלא מדברים ביניהם.

**בזמן השתלטות הבוט אינו עונה, אבל כן:** שומר את ההודעה בהיסטוריה (כדי
שאיש הצוות יראה הכול) ומתריע לצוות שהאורח כתב — אחרת "השתלטות" פירושה
אורח שכותב לחלל ריק.

> 🔴 **פקיעה אוטומטית — ההחלטה החשובה במודול.** גיא ביקש "עצירה" ו"החזרה"
> כשני כפתורים. זו מלכודת: מנהל שעוצר ושוכח משאיר אורח מול **שקט מוחלט**,
> וזה גרוע בהרבה מבוט שעונה בסדר. אורח שכתב ולא נענה כלל הוא הכישלון
> החמור ביותר של מערכת שירות.
> לכן: השתלטות פגה אחרי `TAKEOVER_TTL_MS` (30 דק׳), הצוות מקבל תזכורת
> 5 דק׳ לפני, וכשהיא פגה — **הצוות מקבל הודעה שהבוט חזר**. אחרת מנהל
> בטוח שהוא מטפל בזמן שהבוט כבר עונה במקומו.

> 🔴 **חירום גובר על השתלטות, תמיד.** אורח שכותב "נפלתי" בזמן שמנהל
> "מחזיק" את השיחה ואינו מסתכל בטלפון — זרימת החירום רצה. אין שיקול
> תפעולי שדוחה הנחיית 101. הבדיקה על כך מפורשת.

**במסך:** סרגל שמראה תמיד **מי** מטפל ו**כמה זמן נשאר** (מתרענן חי),
ותיבת השליחה מוצגת **רק** בזמן השתלטות — שליחה ידנית בזמן שהבוט עונה
פירושה שני קולות סותרים באותה שיחה. הודעת צוות נרשמת כ-`assistant`
בהיסטוריה, אחרת ה-AI היה חוזר לענות בלי לדעת מה הצוות כבר הבטיח.

## 8.11 מדיניות המלון — סוף ל"אבדוק ואחזור" על מה שידוע (04.08.2026)

הבוט **אינו ממציא** — זו תכונה. אבל אורח ששואל "יש מיטת תינוק?" ומקבל
"אבדוק ואחזור" מרגיש שהמלון אינו מאורגן. הפתרון אינו לרופף את כלל
האמינות, אלא **לתת לבוט את התשובה**.

תשע מדיניות חדשות ב-`config.policies`, כולן בשתי שפות ופר-מלון: מיטת
תינוק · ילדים · מיטה נוספת · נגישות · בעלי חיים · שמירת מזוודות · ביטול
הזמנה · עישון · שעות מנוחה. בנוסף, `early_checkin`/`late_checkout` עברו
מ-`true` למבנה עשיר — **מאיזו שעה, בכמה, ובאילו תנאים**; "כן" בלבד מחייב
את האורח לשאול שוב.

ה-prompt אומר במפורש: *"אלה תשובות ודאיות — אל תאמר 'אבדוק ואחזור' על
משהו שכתוב כאן"*. מדיניות שלילית נאמרת בנימוס עם חלופה; שירות עם
`available:false` נאמר במפורש כלא-קיים, ולא נעלם (אחרת הבוט מבטיח משהו
שאין).

> 🔴 **שני ממצאים על הסוויטה עצמה, שנתפסו תוך כדי:**
> **(א)** `package.json` נכתב עם **BOM** בעריכה קודמת — מספיק כדי לשבור
> כלים שקוראים אותו כ-JSON.
> **(ב)** `concierge-scale.test.mjs` **מעולם לא רץ** — הוא קיים בדיסק
> ואינו רשום בסוויטה. קובץ בדיקות שאינו רץ הוא ביטחון מדומה.
> רשימת הבדיקות נגזרת עכשיו **מהדיסק**, ו-`npm run test:audit` נכשל אם
> קובץ נשמט.

> 🔴 **יציבות הסוויטה:** `idsecurity.test.mjs` (הצפנה אמיתית + קבצים)
> הפיל לסירוגין את ערוץ ה-IPC של מריץ Node תחת מקביליות. הוא עובר לבדו
> תמיד. במקום להאט את הכול — הוא רץ בהרצה נפרדת. אומת ביציבות.

## 8.12 `insights.js` — ארבעה דוחות, ולא עשרה (04.08.2026)

רשימת הדוחות המקורית הייתה של **מנהל מלון** שרוצה לנהל את המלון שלו:
תקלות בכל חדר, ביקורות גוגל, פניות לחודש. אלה כלי תפעול של מלון — לא של
המוצר. נבנו רק הדוחות שמשפרים את הבוט עצמו:

| הדוח | למה דווקא הוא |
|---|---|
| ⭐ **מה הבוט לא ידע** | כל שורה היא **שדה קונפיג חסר** — רשימת המשימות לשיפור. הערך **מצטבר**: ככל שיותר מלונות, המוצר נעשה חכם יותר |
| **אחוז ההעברות לאדם** | מדד הבריאות. יורד = הבוט משתפר. זה המספר שמוכיח ערך, לא "כמה הודעות טיפלנו" |
| **בקשות שלא טופלו** | בטיחות תפעולית — הרחבה של סולם ההסלמה |
| **שביעות רצון + הכנסה** | לא "כמה הזמנות ספא" אלא **כמה כסף הבוט הכניס** — הטיעון מול המלון הבא |

**איך נאסף הדוח החשוב:** כל `[RECEPTION:...]` שנשלח כשהבוט **לא ידע**
לענות נרשם כפער. נרשמת **שאלת האורח** ולא נוסח התג — התג הוא מה שה-AI
כתב, והשאלה היא מה שבאמת חסר.

> 🔴 **הקיבוץ הוא מה שהופך רשימה לתובנה.** 300 שאלות שונות באותו נושא
> חסרות ערך; חמישה נושאים מדורגים הם רשימת משימות. הנרמול משתמש
> במילות-עצירה **ואז בשתי המילים הארוכות ביותר** — כי רשימה מתוחזקת
> ביד תמיד תפספס מילה ("לכם" פספסה), וכל פספוס מפצל נושא לשניים.
> ההיוריסטיקה גסה בכוונה; לצד כל נושא נשמרת **דוגמה לשאלה האמיתית**,
> כך ששום ניואנס לא אובד.

> 🔴 **כל שאילתה מסוננת ב-`hotel_id`.** דוח שמערבב מלונות אינו רק שגוי —
> הוא **דליפת מידע עסקי בין לקוחות**. יש בדיקה מפורשת על כך.

**ניהול תוכן — `POST /api/config/preview`:** מלון שמעדכן שעות ושובר
בטעות את הודעת הפתיחה הוא בדיוק סוג התקלה שהורסת הדגמה. התצוגה המקדימה
מרנדרת **דרך מסלול הייצור עצמו** (מלון-צל זמני, נמחק מיד) ולא דרך עותק
של הלוגיקה — נתיב רינדור שני היה מתיישן, והתצוגה הייתה מבטיחה משהו אחר
ממה שהאורח יקבל. `voice.js` מדרג את התוצאה, והמערכת **מסרבת לשמור**
תוכן שאינו עומד בתקן.

## 8.13 `auth.js` — תפקידים והרשאות (04.08.2026)

**מה שהיה: סיסמה אחת לכל המערכת.** מי שיש לו אותה רואה שיחות של אורחים,
**מסמכי זהות מוצפנים** וחשבוניות, ויכול למחוק סשנים ולחייב כרטיסים.
במלון עם עשרים עובדים זה לא עומד בשום תקן — ומספיק שעובד אחד עוזב כדי
שהסיסמה תהיה בחוץ.

**הרשאה מינימלית — לכל תפקיד רק מה שהוא צריך:**

| תפקיד | רואה | **אינו** רואה |
|---|---|---|
| `housekeeping` / `maintenance` | בקשות בלבד | שיחות · חשבוניות · ת"ז |
| `reception` | שיחות · השתלטות · בקשות | כספים · ת"ז |
| `accounting` | חשבוניות · דוחות | **שיחות של אורחים** |
| `viewer` | דוחות · בקשות | הכול השאר |
| `manager` | הכול כולל ת"ז | איפוסים גורפים |
| `admin` | הכול | — |

הגדרה: `STAFF_TOKENS="manager:<טוקן>:שם,reception:<טוקן>:קבלה,…"`
44 נתיבי API עברו מ-`auth` גורף ל-`requireCap(<יכולת>)`.

> 🔴 **תאימות לאחור בכוונה.** בלי `STAFF_TOKENS`, ה-`DASHBOARD_PASSWORD`
> הישן ממשיך לעבוד כ-admin — פריסה קיימת לא נשברת, והמעבר לתפקידים הוא
> **הוספת משתנה סביבה**, לא שינוי קוד. וגם כשתפקידים פעילים, סיסמת
> ה-admin נשארת תקפה — אחרת אפשר להינעל מחוץ למערכת שלך.

> 🔴 **401 מול 403 אינו קוסמטי.** 401 = "לא זוהית", ואיש צוות ינסה
> להתחבר שוב ושוב. 403 = "זוהית ואינך מורשה" — ואומר לו לפנות למנהל.
> התשובה מציינת **איזו יכולת חסרה**, וכל ניסיון חריגה נרשם בלוג.

> 🔴 **הממשק מסתיר, השרת אוכף.** `GET /api/me` מאפשר לדשבורד להסתיר
> מסכים — אבל זו נוחות בלבד. ממשק שמסתיר כפתור אינו אבטחה; שרת שדוחה
> בקשה כן. הבדיקות תוקפות את ה-API ישירות, לא את המסך.

**הבדיקה החשובה היא השלילית:** שמשק בית *אינו* מגיע למסמכי זהות, ושהנהלת
חשבונות *אינה* קוראת שיחות. הרשאה שנבדקת רק בכיוון החיובי אינה נבדקת.

## 8.14 `handover.js` — בקשה לא עוברת חילופי משמרת בשקט (04.08.2026)

לאירוע חירום יש סולם אישור-קבלה (§8.6). **לבקשה רגילה לא היה כלום**:
היא נשלחת למחלקה, ואם איש לא הרים — היא נעלמת. האורח ביקש מגבות ב-15:00,
המשמרת התחלפה ב-16:00, ואיש אינו יודע שהבקשה קיימת. האורח בטוח שהמלון
התעלם ממנו.

🔴 זה נראה קטן ליד חירום, אבל זה **הרבה יותר שכיח** — וזה בדיוק ההבדל
בין מלון שמרגיש מסודר לבין מלון ששוכח.

| | חירום (§8.6) | בקשה רגילה (כאן) |
|---|---|---|
| ממתינים לאישור | 3 דק׳ | **15 דק׳** |
| דרג ראשון | מנהל תורן | **תזכורת לאותה מחלקה** |
| דרג שני | **כל** המחלקות | **קבלה בלבד** |

> 🔴 **התגובה חייבת להיות פרופורציונלית.** בקשה שנשכחה אינה חירום —
> אסור שהיא תעיר את כל המלון על מגבות. אבל היא כן צריכה עין של מי
> שאחראי על המשמרת. ותזכורת **אחת**, לא נדנוד: נדנוד הוא בדיוק מה
> שגורם לצוות להתעלם מהתראות.

**`GET /api/shift` — דוח מסירת משמרת.** לא "עוד רשימה": זו רשימה שמישהו
**קורא בקול** בחילופי משמרת, ולכן היא ממוינת לפי **מה שאיש לא לקח
אחריות עליו**, ולא לפי זמן.

> 🔴 **התראות המערכת עצמן אינן נכנסות למעקב** (`isSystemNotice`). תזכורת
> שנכנסת למעקב מייצרת תזכורת על עצמה — לולאה שמציפה את הצוות.

⚠️ מודע: המערכת יודעת רק אם מישהו **אישר במסך**. היא אינה יודעת אם
המגבות הגיעו. זה מה שאפשר לדעת ממערכת הודעות — וזה עדיין ההבדל בין
"נשלח" לבין "מישהו לקח אחריות".

**זיכרון אורח חוזר** (`profiles.js`) כבר היה מחובר ל-prompt: מספר השהייה,
דגל VIP והעדפה מביקור קודם. זה מה שהופך בוט לקונסיירז' שמכיר אותך.

## 8.15 סקירה עצמית לפני הדגמה — ארבעה ממצאים (04.08.2026)

סבב "הכל בנוי, תוודא שהכל מושלם" לפני הדגמה ללקוח. **613 הבדיקות עברו
מההתחלה ועד הסוף** — ולכן כל הממצאים כאן הם דברים שהבדיקות הקיימות לא
יכלו לתפוס. שלושה מתוך ארבעה נמצאו בהרצה **חיה** מול Claude וגוגל
אמיתיים, לא ביחידה.

### 🔴 הקונסיירז' סיפר לאורח על תקלות פנימיות

הכלי החדש: **מבחן עמידות** שמכריח את שכבת המקומות להיכשל בשמונה דרכים
(`invalid_key` · `rate_limited` · `unavailable` · אפס תוצאות · חריגה ·
תקיעה · JSON פגום · `null`) ומריץ שיחה אמיתית מול Claude בכל אחת.

הבשורה הטובה: בכל שמונת המצבים האורח קיבל המלצה טובה מהרשימה האצורה של
המלון — אפס קריסות, אפס המצאות. הבשורה הרעה, בשניים מהם:

> *"The **tool** didn't return live results just now…"*
> *"The **live search** is temporarily unavailable…"*

אורח בקמפינסקי לא יודע שקיים "כלי" או "חיפוש חי". הוא רק שומע שהמלון
לא מתפקד. **זו אותה מחלה שכבר תועדה פעמיים בפרויקט** — טקסט מרשימת
הוראות שנדבק להודעה שנשלחת (§7.2.2, §6 "הגנות רוחב") — הפעם בצד ה-AI,
ובאנגלית בלבד. הכלל הקיים כיסה עברית (`תקלה טכנית`), ולכן הדליפה
האנגלית עברה **בשקט**.

שלוש שכבות, כרגיל:

| שכבה | מה נעשה |
|---|---|
| מקור | `toolStatus()` — הודעת כשל אינה פרוזה שאפשר לצטט אלא **הוראה** שנפתחת ב-INTERNAL ואוסרת במפורש להזכיר את הכשל |
| prompt | כלל מפורש בעברית ובאנגלית: לעולם לא לספר לאורח על כלי/חיפוש/מערכת |
| דטרמיניסטי | כלל `forbidden-phrase` חדש ב-`voice.js` — **בשתי השפות**. `npm run voice` ו-preflight נכשלים על דליפה כזו |

> 🔴 **החצי השני של הכלל חשוב כמו הראשון.** הגרסה הראשונה שכתבתי תפסה
> גם **"room service is available 24/7"** — משפט מלונאי תקין לחלוטין.
> כלל שמסמן פלט נכון נכבה תוך יום, וזו הדרך הבטוחה לאבד מבקר. לכן
> `service` הוצא במפורש משמות העצם, ויש בדיקה על **עשרה** משפטים
> תקינים שאסור שיסומנו — לא פחות חשובה מהבדיקה על מה שכן.

### 🔴 36 שניות שקט כשגוגל נתקע

`retryWithBackoff` עם 3 ניסיונות × timeout 9ש׳ נתן, כששירות המקומות
*נתקע* במקום להיכשל, **36.7 שניות** עד שהאורח קיבל משהו. retry מרפא
תקלת רגע; מול שירות תקוע הוא רק מכפיל את ההמתנה. בוואטסאפ אורח נוטש
הרבה קודם וכותב שוב.

עכשיו יש **דדליין אחד לכל הכלי** (`PLACES_BUDGET_MS`, 12ש׳): כל ניסיון
נחתך לפי מה שנשאר, וכשהתקציב נגמר מפסיקים לנסות ונופלים לרשימה האצורה.
נמדד אחרי התיקון: **22.8ש׳** במקרה הקיצוני (12ש׳ חיפוש + תור AI).

### 🔴 הודעה קולית בוואטסאפ תוארה ל-AI כ"תמונה"

`userMsg` תיאר **כל** מדיה, מכל סוג, כ-"האורח שלח תמונה ללא טקסט".
בוואטסאפ בישראל הודעה קולית היא מהדרכים הנפוצות ביותר לפנות — ואורח
שדיבר קיבל תשובה על **צילום שמעולם לא שלח**. אף בדיקה לא שלחה
`audio/ogg`, ולכן הכל נראה ירוק.

`classifyMedia()` מסווג לפי מה שטוויליו מסר, ומדיה שאיננה תמונה נענית
בכנות + חלופה מיידית ("אפשר לכתוב לי כאן, ואם נוח יותר לדבר — אשמח
לבקש מהקבלה להתקשר"). חירום גובר, השתלטות גוברת, ובאמצע צ'ק אין השלב
הנוכחי נשלח מחדש כדי שהאורח לא יישאר תלוי באוויר.

> ⚠️ **אין תמלול, ואין הבטחה לתמלול.** Claude אינו מקבל אודיו ב-Messages
> API; תמיכה אמיתית דורשת ספק STT נפרד (Whisper/Deepgram) — שכבה חדשה,
> לא הגדרה. מה שיש עכשיו הוא **דגרדציה כנה**, לא יכולת קולית.

### 🔴 `default_lang` היה בקונפיג ואיש לא קרא אותו

מלון שהיה מגדיר `default_lang: "he"` לא היה מקבל כלום — ההגדרה קיימת
מהיום הראשון ומעולם לא חוברה. זו בדיוק המחלקה של §8.8 ("יש cron
בתיעוד בלי cron בקוד"): הגדרה שנראית קיימת גרועה מהגדרה חסרה.

זה נכנס לפעולה רק כשאין **שום** אות שפה — הודעה קולית או קובץ בלי
כיתוב, או הודעה שכולה ספרות ("304"). הקוד נפל אז ל-`"en"` קשיח, כך
שאורח ישראלי שפתח בהודעה קולית נענה **באנגלית במלון ישראלי**. עמודי
ה-HTML כבר נפלו לעברית במקרה המקביל (`pageLang`); עכשיו גם הצ'אט, דרך
`defaultLangFor()` — ו-`"auto"` = "זהה מההודעה, ואם אי אפשר — עברית".

### 🔴 ופנייה בלשון נקבה לאורח שלא הסגיר מגדר

נתפס ב-preflight חי: *"ספרי לי קצת יותר"* לאורח ששאל "יש בר נחמד
קרוב?". ה-prompt **כבר** אוסר את זה בפירוט רב (§8.9 + חוק המין ומספר),
וה-AI הפר אותו בכל זאת — שוב, ההוכחה שהנחיה לבדה אינה מספיקה.

`neutralizeImperatives()` ב-`voice.js` רץ בתוך `tidyForWhatsApp`, כלומר
על **כל** הודעה יוצאת, בדיוק כמו `...`→`…`.

> 🔴 **למה רק ציווי, ולא כל נטייה.** ה-prompt מורה לבוט להתאים את עצמו
> למגדר שהאורח *הסגיר בכתיבתו שלו* ("אני עייפה" → "תרצי") — התנהגות
> נכונה ורצויה. מחיקה גורפת של צורות נקבה הייתה שוברת אותה. **ציווי,
> לעומת זאת, אסור תמיד** — גם כשהמגדר ידוע — ולכן זו הצורה היחידה
> שמותר לתקן בעיוורון.

> 🔴 **ושכתוב אחד שלי היה שבור, ונתפס לפני שנשלח:** `"שתפי אותי"` הפך
> ל-`"אשמח לשמוע אותי"` — עברית שבורה, שנשלחת לאורח בדיוק כמו הבעיה
> המקורית. הוסר. כלל הברזל: **שכתוב חייב להיות נכון בכל הקשר**, אחרת
> הוא לא נכנס. אותו דין ל-"בואי"/"תגיעי" (עתיד, לא ציווי) ול-"תיהני
> מהערב". מה שאין לו תחליף בטוח נשאר באחריות ה-prompt, ונתפס **בקול**
> ע"י `gendered-address`.

**ובנוסף — הדוח עצמו תוקן:** `gendered-address` חתך את ההודעה ל-110
תווים, וכשההפרה נפלה אחריהם הדיווח אמר "יש בעיה" בלי לומר איזו מילה —
אבחון דרש הרצת preflight שלמה נוספת. עכשיו הדוח נוקב במילה.

### מה נבדק ועבר, בלי ממצא

| | |
|---|---|
| **בדיקות** | **628 עוברות** (613 + 15), 32 קבצים · `test:audit` ירוק |
| **עומס** | **200,000 הודעות · 100 מלונות · 351/שנייה** — אפס קריסות, אפס תשובות שהתחלפו, אפס דליפות בין מלונות, זיכרון חסום (20k), 204,000 סשנים נשמרו ונטענו, 4,000 מעברי שפה נכונים |
| **גוגל חי** | 638ms · 6 תוצאות אמיתיות · שעות "היום" נכונות ליום בשבוע · smoke-check עבר בעליית השרת |
| **דמו** | 17/17 בידוד · `voice` 0 שגיאות (77 לאורח + 21 לצוות + 20 עמודי HTML) |
| **שרת ו-DB** | עולה נקי · `integrity_check=ok` · WAL + `synchronous=NORMAL` · 6 עבודות מחזוריות רצות · no-show חייב בפועל |
| **חשיפה** | `/.env` · `/hotel.db` · `/server.js` → **404**. `payment_credentials` מוסתרים ב-`/api/config`. אין מפתחות בקוד המנוהל |
| **הרשאות (חי)** | משק בית **נחסם** ממסמכי זהות ומשיחות · הנהח **נחסמת** משיחות אורחים · 403 נוקב ביכולת החסרה · טוקן שגוי = 401 ולא 403 |
| **מע"מ** | 18% תושב · 0% תייר · `net+vat=total` · סכום = folio (48/48 בחלק C) |

> ⚠️ **מה שעדיין דורש החלטה לפני לקוח אמיתי** (לא באגים — הגדרות):
> `DASHBOARD_PASSWORD` הוא עדיין ברירת המחדל `hotel2024`; `STAFF_TOKENS`
> אינו מוגדר (ולכן אין תפקידים בפועל); `VALIDATE_TWILIO` כבוי;
> `ID_ENCRYPTION_KEY` חסר (נגזר מפתח דמו — רלוונטי רק אם מלון מפעיל
> `retain_image`); ומייל רץ על מוק. כולם מודפסים כאזהרה בעליית השרת.

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

#### ⚠️ פריסה בענן (Railway) — `demo-switch` **אינו** משנה את הענן
זו התקלה השקטה הכי מסוכנת בכל הסבב הזה. `demo-switch.mjs` כותב לבסיס הנתונים
של **המחשב שמריץ אותו**. שרת בענן הוא מכונה אחרת עם DB אחר, ולכן:

- בענן אין שורה ב-`hotel_numbers` → `resolveHotelId` נופל ל-`DEFAULT_HOTEL_ID`
  (`kempinski`), **וגם** אין שורת קונפיג ל-LALA — כך שאפילו מיפוי ידני לא היה
  מספיק, כי `configFor("lala")` היה מחזיר את `DEFAULTS` (התוכן של קמפינסקי).
- ועוד: על Railway מערכת הקבצים **בת-חלוף** (אין volume כברירת מחדל), ולכן כל
  הזרקה דרך ה-API נמחקת ב-redeploy הבא.

**הפתרון: `demo-bootstrap.js` + משתנה סביבה `DEMO_HOTEL`.** בכל עליית שרת, אם
`DEMO_HOTEL` מוגדר, נכתב הקונפיג המלא של אותו מלון (מ-`sample-hotels.mjs`)
ומספר `TWILIO_WHATSAPP_NUMBER` ממופה אליו — ורק אליו. אידמפוטנטי, ולכן שורד
כל redeploy. החלפת מלון בענן = שינוי משתנה סביבה אחד + redeploy.

⚠️ רץ **רק** כש-`DEMO_HOTEL` מוגדר במפורש, כדי שפריסה אמיתית (מלון לקוח
שהוגדר דרך `POST /api/hotels`) לא תידרס בכל restart.

**`cloud-check.mjs`** (`npm run cloud:check -- <url> --expect=lala`) שואל את
**הענן** מרחוק למי הוא מנתב את המספר, ומזהה במפורש 401 (טוקן שונה) ו-404
(הענן מריץ קוד ישן). אומת חי בשני הכיוונים על DB ריק לגמרי — בלי `DEMO_HOTEL`
העלייה מסתיימת ב-`kempinski`, ועם `DEMO_HOTEL=lala` ב-`lala`.
מכוסה ב-`demo-bootstrap.test.mjs` (7 בדיקות).

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
170 שמות שהושוו, **78/78 בדיקות עברו**. (מספר הבדיקות גדל עם מספר הסבבים; ב-14 סבבים
זה 65/65.)

> 🔴 **תוצאה חיובית-שגויה שתוקנה (02.08.2026):** חלק A דיווח על "דליפה" כי
> `"איזי קפה"` (שהוחזר לקמפינסקי) הוא **תת-מחרוזת** של `"איזי קפה פלורנטין"` —
> הסניף שבאמת קרוב ל-LALA. הבוט המליץ נכון; השוואת מחרוזות פשוטה קראה לזה
> דליפה. בעיר מלאת רשתות זה היה מצלצל כל הזמן ומאבד אמון בכלי. עכשיו שם
> נחשב "בלעדי למלון" רק אם אף שם בתוצאות של המלון השני אינו מכיל אותו ואינו
> מוכל בו.

> Rule for future work: payments change in ONE place (the provider abstraction). Never re-couple
> business logic to a specific payment vendor. Same rule for the DB (`db.js` + the repository
> functions), the tenant boundary (`tenant.js`), and ID storage (`idverify/index.js`).
>
> **וכלל נוסף, מ-§9:** מלון חדש = **כל** השדות שלו, לא רק שם ומיקום. כל שדה שלא הוגדר
> שייך עדיין למלון ברירת המחדל. לפני כל הדגמה: `npm test` · `npm run preflight` · `npm run demo`.

## 8.16 סבב 05–06.08.2026 — הדגמה, חירום רפואי, פרטיות ואבטחה

סבב של חמש משימות מהלקוח. שלוש מהן חשפו פערים אמיתיים שהבדיקות הירוקות
לא יכלו לתפוס, כי הן בדקו את מה שנבנה — לא את מה שלא נבנה.

### 🎬 פרטי הדגמה אישיים — `demo-contacts.js`

התראות מלון ההדגמה מופנות לטלפון ולמייל של הבעלים, כדי שבהדגמה מול
לקוח אפשר יהיה להראות **בזמן אמת** שההתראה באמת יוצאת, ולא רק "נשלחה"
למספר דמה שאינו קיים.

> 🔴 **למה זה לא ב-DEFAULTS, ולעולם לא יהיה שם.** `DEFAULTS` הוא שכבת
> הבסיס של **כל** המלונות (§9.1 — "ירושה שקטה מ-DEFAULTS"). אילו המספר
> האישי היה שם, מלון לקוח אמיתי שישכח להגדיר ולו מחלקה אחת היה שולח את
> בקשות האורחים שלו **לטלפון פרטי** — בשקט. לכן overlay מפורש עם
> **רשימת היתר** (`kempinski`, `lala`), ופונקציה שמסרבת בקול לכל מלון
> אחר. הבדיקה המרכזית כאן היא **השלילית**: מלון אמיתי שרץ במקביל
> להדגמה מקבל את אנשי הקשר שלו בלבד.

כיבוי: `DEMO_CONTACTS=off`. אזהרה רועשת בעליית השרת כל עוד זה פעיל.

### 🤒 חירום רפואי — ארבעה פערים, ואחד מהם מרכזי

בדיקה של ניסוחים שאורח **באמת** כותב חשפה:

| מה נכתב | מה קרה |
|---|---|
| "יש לי **כאב חזק** בחזה" | ❌ לא זוהה — הרשימה דרשה "כאב בחזה" צמוד, ותואר באמצע ניתק את ההתאמה |
| "אני לא מצליח לנשום" | ❌ לא זוהה ("לא נושם" בלבד היה ברשימה) |
| "my wife **fainted**" | ❌ "fainted" פשוט לא היה ברשימה |
| **"אשתי לא מרגישה טוב"** | ❌ **לא הפעיל כלום** |

האחרון הוא הפער החשוב: זה כנראה הניסוח הנפוץ ביותר שבו אורח מדווח
שמישהו חולה — והמלון שתק לחלוטין.

> 🔴 **למה זו דרגה נפרדת ולא עוד מילה ברשימת החירום.** "לא מרגיש טוב"
> הוא **טווח** — מכאב בטן ועד התקף לב מתחיל. "התקשרו 101!" על כאב ראש
> הוא אזעקת שווא, ואזעקות שווא הן בדיוק מה שמלמד צוות להתעלם מהתראות.
> התעלמות היא נטישת אורח חולה. לכן `detectMedicalConcern` — דרגה
> פרופורציונלית שרצה **רק** אחרי ש-`detectEmergency` החזירה null, כך
> שהמסלול הקריטי לא נגע ולא נחלש.

מה שקורה: אדם מהצוות מקבל התראה ויוצר קשר · האורח מקבל את **התסמינים
המדויקים** שמחייבים 101 בלי להמתין לנו (חזה · נשימה · הכרה · חולשה
חד-צדדית · דימום) · הבקשה נכנסת למעקב המשמרת · **אפס ייעוץ רפואי**.

ה-prompt הורחב בשתי השפות: אסור לאבחן, אסור להציע תרופה (כולל אקמול),
אסור "כנראה וירוס". מותר לוגיסטיקה בלבד — רופא למלון, בית מרקחת, מים.

### 🔐 מסמכי זיהוי — הפער החמור ביותר בפרטיות

המערכת הכריזה verify-then-discard ואמרה לאורח, בשחור על גבי לבן:
*"מוחקים את התמונה — היא אינה נשמרת"*. מקומית זה היה **נכון לחלוטין**:
בזרימת ה-discard הקובץ לא נכתב כלל.

> 🔴 **אבל התמונה לא הגיעה אלינו מהאוויר.** וואטסאפ העלה אותה
> ל-**Twilio**, ו-Twilio שומרת מדיה **עד שמוחקים אותה במפורש** דרך
> ה-API. `git grep deleteMedia` החזיר **אפס תוצאות** — שום קוד לא מחק
> שם כלום. כלומר צילום תעודת הזהות של האורח נשאר על שרתי Twilio
> (ארה"ב), ואנחנו הצהרנו בפניו שלא. **הצהרת פרטיות שגויה גרועה
> מהיעדר הצהרה** — היא הופכת מחדל טכני להטעיה.

`idverify/twilio-media.js` מוחק את העותק אצל הספק. נקודה **אחת**
(מיד אחרי שהבייטים בידינו) שמכסה את כל המסלולים — אומת, נדחה,
manual review, ותקלה — במקום חמש קריאות שאחת מהן תישכח. לא חוסמת ולא
זורקת (אורח לא נתקע בגלל מחיקה), אבל כישלון **רועש**, כי משמעותו PII
ששרד.

### 🛡️ אבטחה — הבלימה per-guest הייתה עקיפה בטריוויאליות

בדיקת חדירה חיה מול שרת אמיתי:

| נבדק | תוצאה |
|---|---|
| `/.env` · `/hotel.db` · `/server.js` · `/.git/config` · path traversal | ✅ 404 |
| כל `/api/*` בלי טוקן / עם טוקן שגוי | ✅ 401 |
| הרשאות: משק בית → ת"ז ושיחות · הנהח → שיחות | ✅ 403 עם היכולת החסרה |
| SQL injection · XSS · `eval` | ✅ אין וקטור (escape מלא, prepared statements) |
| קלט 100KB | ✅ נחתך ל-4000, לא נשמר ולא נשלח ל-AI |
| דדופ `MessageSid` | ✅ עובד |

> 🔴 **ומה שכן נמצא:** `/webhook` הוא נתיב HTTP פתוח, ו-`VALIDATE_TWILIO`
> **כבוי כברירת מחדל**. תוקף פשוט **מחליף את מספר ה-From** בכל בקשה,
> וכל מספר מזויף מקבל דלי אסימונים **חדש** של 60 — כלומר 10,000
> מספרים = 600,000 קריאות AI **בתשלום, על חשבון המלון**. נמדד מול שרת
> אמיתי: **40 מספרים מזויפים → 40/40 עובדו, אפס נחסמו.**
>
> הבלימה per-guest נועדה לאורח יחיד שמפציץ; היא מעולם לא נועדה לזה.
> נוספה תקרה שנייה **פר-מלון** (`HOTEL_BURST`/`HOTEL_RATE`), שאינה
> תלויה בזהות השולח. אחרי התיקון: 36/60 נחסמו.
>
> ⛑️ **ועם חריג אחד קדוש: חירום עוקף את שתי התקרות.** אורח שכותב
> "נפצעתי" בזמן שהמלון מוצף חייב לקבל את הנחיית 101. יש בדיקה מפורשת.

⚠️ זו **הגנת עומק, לא תחליף** ל-`VALIDATE_TWILIO=true`. עם אימות חתימה
מופעל, בקשה מזויפת נדחית ב-403 עוד לפני שהגיעה לשם.

### 💳 שכבת הסליקה — `payments/vendors.js` (06.08.2026)

השאלה הראשונה שמלון שואל היא "עם מי אתם עובדים?", והתשובה חייבת להיות
"עם מי שאתם כבר עובדים" — מלון לא מחליף חברת סליקה בשביל בוט. לכן
**שמונה** חברות רשומות, באותו דפוס בדיוק כמו `pms/vendors.js`: כל ספק
הוא **מפרט**, לא מחלקה.

| ספק | אזור | מצב |
|---|---|---|
| **קארדקום** | ישראל | ✅ **מאומת** — מימוש מלא (`CardComProvider`) |
| טרנזילה · פלאקארד · יעד שריג · פייפלוס · משולם (Grow) | ישראל | 🔧 שלד מוכן |
| Stripe · Adyen | בינלאומי | 🔧 שלד (רלוונטי לרשתות עם ישות בחו"ל) |

> 🔴 **הקו האדום: ספק שאינו `verified` לעולם אינו מחייב כרטיס של אורח.**
> נתיב מנוחש שמצליח *חלקית* גרוע פי כמה מנתיב שנכשל — הוא יוצר "תשלום
> שהצליח" מדומה, והאורח מקבל חדר בלי פיקדון. ספק שלד נופל ל-Mock, **ומדפיס
> בדיוק מה לבקש מהמלון ואיך משיגים את זה**. יש בדיקה מפורשת על כך.

`GET /api/payments/readiness` עונה על השאלה המעשית ב-onboarding: מה עוד
צריך כדי שהמלון הזה יסלוק באמת. `GET /api/payments/vendors` — הרשימה
המלאה עם מה לבקש מכל ספק.

> 🔴 **הבטחה לאורח חייבת להתאים ליכולת בפועל.** לא כל טרמינל ישראלי מוגדר
> ל**הקפאה (J5)** — זו הגדרה מול חברת האשראי, לא תכונה של הקוד. במלון כזה
> "פיקדון" מתבצע כ**חיוב מלא + זיכוי**: הכסף באמת יורד מהחשבון וחוזר תוך
> ימים. `depositExplainer` בודק את יכולת הספק ומנסח בהתאם — כי "זו הקפאה
> בלבד, לא חיוב" כשבפועל מחייבים היא בדיוק סוג ההצהרה השגויה שהפרויקט
> הזה נלחם בה.

### 🔐 מסמכי זיהוי — מה שהמחקר המשפטי שינה (06.08.2026)

מחקר מול מקורות ראשוניים אישר את הכיוון (**מוחקים מיד, שומרים רק שדות
מתומללים**) — וחשף **שלוש אמירות לא מדויקות במסמכים שלנו**, שתוקנו
ב-`SECURITY.md`. אמירה משפטית שגויה בתיק ציות גרועה מהיעדר אמירה:

1. **AEPD / Marins Playa** — תואר אצלנו כ"קנס על שמירת סריקה". **ההפך:**
   הסריקה לצורך חובת הרישום נמצאה **חוקית**; ההפרה הייתה **שימוש משני**
   בתצלום (זיהוי אורחים בטאבלטים של הצוות). הקנס גם **הופחת ל-€15,000**
   בערעור. הלקח הנכון הוא *הגבלת מטרה*, לא "כל שמירה אסורה".
2. **Garante** — הכיוון היה נכון אך חסר ציטוט. הציטוט המדויק חזק יותר:
   docweb 10244289 (29.04.2026) אוסר במפורש איסוף ת"ז **דרך שירותי מסרים
   מיידיים ("ad es. whatsapp")**.
3. **EDPB** — ההנחיה עוסקת ב**אימות בקשות גישה**, לא בצ'ק אין במלון.
   אנלוגיה חזקה, אך אינה מכשיר רגולטורי על מלונות.

> 🔴 **והממצא שמשנה את התמונה — וואטסאפ אינו E2EE מול עסק.**
> "וואטסאפ מוצפן מקצה לקצה" נכון בין שני *משתמשים*. מול עסק ב-Cloud API
> — ומכאן, מולנו — מהתיעוד של Meta עצמה: *"Cloud API **decrypts** the
> message… **manages the keys on behalf of the business**… maximum
> **retention period of 30 days**."* כלומר תמונת הדרכון יושבת **מפוענחת
> אצל Meta עד 30 יום**. Twilio מוסיפה עד 7 ימים משלה.
>
> **`verify_discard` מושלם אצלנו אינו מוחק את מה שאיננו מגיעים אליו.**
> לכן: (א) מוחקים במפורש אצל Twilio דרך ה-API — לא נשענים על תפוגה;
> (ב) שמירת Meta **מוצהרת לאורח** בהודעת האיסוף. הסתרת מגבלה כזו היא
> בדיוק ההצהרה החלקית שהפרויקט הזה נלחם בה.

**השורה התחתונה המשפטית, מאומתת:** למחוק את התמונה מיד אחרי האימות,
ולשמור רק **שדות מתומללים** ל-7 שנים (סעיף 25). תקנה 12(א)(2) דורשת
**רישום** של שם, כתובת ומספר דרכון — **לא תמונה**. כלומר ברירת המחדל
הקיימת (discard + שדות) כבר מספקת גם את חובת המס.

⚠️ **טרם נסגר:** האם רשות המסים מקבלת שדות-בלבד בביקורת בפועל; והאם קיימת
חובת רישום אורחים ישראלית במקור שלא נבדק (רישוי עסקים עירוני).

**נבדק בפועל (20 בדיקות, לא קריאת קוד):** ברירת המחדל אינה כותבת קובץ ·
בקשה לשמור בלי בסיס חוקי **נחסמת** · עם בסיס חוקי נשמר **מוצפן** ובלתי
קריא · retention פר-מלון נכבד · רישום אימות נשמר בלי תמונה · הבייטים
אינם ב-DB · והעותק אצל Twilio נמחק **בכל** מסלול.

### 🔑 J5 — מה שהמחקר מול מפרט שב"א חשף (06.08.2026)

✅ **המפרט הלאומי של שב"א (Ashrait v16.29) נוקב במלונות במפורש** כמקרה
השימוש של J5:

> *"(J5) בקשה לאישור ללא עסקה — אופציה זו נועדה לעסקים כגון: חברות
> להשכרת רכב, **בתי מלון** וכד'… העסקה תבוצע בשלב מאוחר יותר כאשר ידוע
> סכום העסקה המדויק (בעסקת השלמה)."*

כלומר `authorizeDeposit` → `capture` אינו דפוס שהמצאנו — הוא הדפוס
המאושר **ברמת המתג הלאומי**. הממשק לא נדרש לשינוי.

> 🔴 **וזו הנקודה שתיראה כבאג ב-2 בלילה בהדגמה:** J5 אינו דגל בקוד אלא
> **הרשאה מול חברות האשראי** — *"עבודה כזאת מתאפשרת רק לאחר קבלת אישורים
> מחברות האשראי"*. טרמינל שאינו מאושר מחזיר **שגיאה 349 או 044** בפיקדון
> הראשון. זו בעיה של **חשבון הסוחר**, לא של הקוד. לכן `j5Approved` הוא
> שדה onboarding מפורש: `vendorReadiness` מתריע כשלא ידוע, וכשהתשובה
> שלילית — **ההסבר לאורח יורד אוטומטית ל"נגבה ומזוכה"**.

> 🔴 **תיקון מינוח: "J4" אינו קיים בשכבת הפרוטוקול.** ערכי `parameterJ`
> של שב"א הם 2, 5, 6, 49 — וחיוב רגיל נשלח **בלי פרמטר J כלל**. "J4"
> הוא אוצר מילים של *שערי הסליקה*. לא לבקש מספק "תמיכה ב-J4"; לבקש
> **לכידה (capture) של J5**.

**שלוש שאלות שחייבים לשאול כל ספק לפני חתימה** (מלוות כל
`vendorReadiness`) — שלושתן משפיעות ישירות על `settleFolio`:
1. כיצד משחררים הקפאת J5 שלא נלכדה, שלושה ימים אחרי?
2. מה משך ההקפאה המרבי ל-**MCC 7011** (בתי מלון)?
3. האם נתמכת **לכידה חלקית** (partial capture)?

⚠️ **משך ההקפאה אינו קבוע של השער** — הוא נסגר פר-סוחר מול הרוכש ותלוי
MCC. לכן `holdDurationDays` הוא קונפיג, ולא מספר בקוד.

**עשרה ספקים רשומים.** דירוג לפי סבירות שמלון ישראלי באמת עובד איתם:
קארדקום (מאומת, רוכש מורשה) · PayPlus (J5 מתועד, מוסמך Oracle OPI) ·
פלאקארד (J5 מתועד, **ב-marketplace של אופטימה**) · HYP/CreditGuard
(מחזור החיים המתועד ביותר, כולל פרימיטיב שחרור J109) · טרנזילה (רוכש
מורשה; ⚠️ חלון ברירת מחדל ~4 ימים) · PayMe · Grow/משולם.
**Stripe — לא זמין בישראל (אומת).** איסראכרט/Max/CAL — אין API ציבורי.

### 🔬 preflight — מדד שהיה תנודתי ותוקן

חלק A נכשל לסירוגין על "רוב הסבבים הפעילו חיפוש כפול". נמדד על **אותו
קוד בדיוק**: 7, 8, 16, 16 מתוך 20.

> 🔴 **המדד היה שגוי, לא המוצר.** `dualSearchRounds` מודד **החלטה של
> ה-AI** — לחפש מול לשאול שאלת הבהרה — שהיא לגיטימית לחלוטין ומשתנה
> מהרצה להרצה. שער שנצבע אדום באקראי מלמד להתעלם ממנו, וזו בדיוק המחלה
> שכבר תועדה כאן (§8.11). בהרצה עם 7/20 סבבים הושוו **72 שמות מקומות**
> ואפס דלפו — הבדיקה הייתה כל דבר חוץ מריקה.
>
> המדד עבר ל-**`namesCompared`**, שמודד את מה שבאמת מוכיח בידול. כיסוי
> נמוך נותר כ**הערה** ("ההרצה הזו בדקה פחות ממה שיכלה"), לא ככשל.
