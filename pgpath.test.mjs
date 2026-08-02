// ════════════════════════════════════════════════════════
//  מסלול POSTGRES — האם באמת זורם בו מידע?
//  ----------------------------------------------------------
//  🔴 עד עכשיו "מסלול Postgres" היה סכימה + ping + מונה חשבוניות, ו**אף
//     סשן אחד** לא עבר בו: כל `db.prepare` בפרויקט דיבר ישירות עם SQLite.
//     מסלול שאינו מקבל נתונים אינו מסלול. הבדיקות כאן מוכיחות שהוא כן.
//
//  ── למה לקוח מזויף ולא Postgres אמיתי ──────────────────
//  אין שרת Postgres בסביבה הזו. אבל לקוח מזויף שרק *מחזיר מה ששאלו* לא
//  מוכיח כלום — הוא היה עובר גם אם ה-SQL שנוצר שבור לגמרי. לכן הלקוח כאן
//  מריץ את ה-SQL **באמת**, מול SQLite: הוא ממיר `$1,$2` בחזרה לפוזיציוני
//  ומבצע. כך כל דבר שמתורגם לא נכון — `@name` שלא הומר, `?` שנשאר,
//  `INSERT OR IGNORE` — **נכשל כאן**, כמו שהיה נכשל מול pg.
//
//  ⚠️ מה זה עדיין לא מכסה: הבדלי דיאלקט שאין ל-SQLite דעה עליהם (טיפוסים,
//     נעילות, עסקאות מקביליות). לחיבור אמיתי: `psql -f store/pg-schema.sql`.
// ════════════════════════════════════════════════════════
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH = freshTestDbPath("pgpath");
process.env.TWILIO_ACCOUNT_SID     = "ACtest";
process.env.TWILIO_AUTH_TOKEN      = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.ANTHROPIC_API_KEY      = "sk-test";
process.env.BASE_URL               = "http://test.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);

mock.module("twilio", {
  exports: { default: () => ({ messages: { create: async () => ({ sid: "SMtest" }) } }) },
});
const { email } = await import("./email/index.js");
email.send = async () => ({ success: true });

const { db } = await import("./db.js");

// ── לקוח pg מזויף שמריץ SQL אמיתי ──────────────────────
class FakePgClient {
  constructor() { this.queries = []; }

  async query(text, params = []) {
    this.queries.push(text);

    // הסכימה כבר קיימת (db.js יצר אותה). ה-DDL של Postgres אינו תקף
    // ב-SQLite, ולכן מדלגים — זה לא מה שנבדק כאן.
    if (/CREATE\s+TABLE|CREATE\s+INDEX/i.test(text)) return { rows: [], rowCount: 0 };
    if (/^\s*SELECT\s+1\s*$/i.test(text)) return { rows: [{ "?column?": 1 }], rowCount: 1 };

    // 🔴 כאן נתפסות שגיאות תרגום. `$1` חוזר ל-`?`, ולכן פרמטר שנשאר
    //    בסגנון SQLite (`@name`) או `?` שלא הומר — יזרוק, בדיוק כמו
    //    ש-pg היה זורק.
    assert.ok(!/@[A-Za-z_]/.test(text.replace(/'(?:[^']|'')*'/g, "''")),
      `🔴 פרמטר בסגנון SQLite (@name) הגיע ל-pg: ${text.slice(0, 120)}`);
    assert.ok(!/\?/.test(text.replace(/'(?:[^']|'')*'/g, "''")),
      `🔴 סימן שאלה לא הומר ל-$n: ${text.slice(0, 120)}`);

    // `$1` יכול לחזור יותר מפעם אחת — מרחיבים לפי סדר ההופעה בפועל.
    const order = [...text.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
    const sql   = text.replace(/\$\d+/g, "?");
    const args  = order.map(i => params[i - 1] ?? null);

    const stmt = db.prepare(sql);
    if (/^\s*(SELECT|WITH)/i.test(sql) || /RETURNING/i.test(sql)) {
      const rows = stmt.all(...args);
      // pg מחזיר BIGINT כמחרוזת. מדמים את זה — אחרת הבדיקה מפספסת בדיוק
      // את הבאג שבגללו `coerceRow` קיים.
      for (const r of rows) for (const k of Object.keys(r)) {
        if (typeof r[k] === "bigint") r[k] = String(r[k]);
        if (k === "n" && typeof r[k] === "number") r[k] = String(r[k]);
      }
      return { rows, rowCount: rows.length };
    }
    const out = stmt.run(...args);
    return { rows: [], rowCount: Number(out?.changes ?? 0) };
  }
}

const client = new FakePgClient();
const { initPersistence, persistenceKind, flushPersistence } = await import("./store/persistence.js");
await initPersistence({ client, url: "postgres://fake/test" });

const state   = await import("./state.js");
const checkin = await import("./checkin.js");
const config  = await import("./config.js");
const tenant  = await import("./tenant.js");
const repo    = await import("./store/Repo.js");

const HID = tenant.DEFAULT_HOTEL_ID;

test("המסלול באמת Postgres, לא נפילה שקטה חזרה ל-SQLite", () => {
  assert.equal(persistenceKind(), "postgres");
  assert.equal(repo.repoKind(), "postgres");
});

// ════════════════════════════════════════════════════════
//  סשנים — הדבר שקודם לא עבר במסלול הזה בכלל
// ════════════════════════════════════════════════════════
test("סשן: נכתב דרך התור ונקרא בחזרה עם כל השדות", async () => {
  const phone = "whatsapp:+972500900001";
  // בדיוק מה ש-`handleIncoming` עושה: חימום לפני הקוד הסינכרוני.
  await state.ensureSessionLoaded(phone, HID);
  state.patchSession(phone, {
    lang: "he", guestName: "מיכל לוי", roomNumber: "1204",
    stage: "checked_in", checkinStage: "waiting_terms",
  }, HID);
  state.pushHistory(phone, "user", "שלום", HID);
  state.pushHistory(phone, "assistant", "ברוכה הבאה למלון", HID);

  await flushPersistence();           // ממתינים לתור הכתיבות
  state.sessionCache.clear();         // ומאלצים קריאה אמיתית מה-DB

  const s = await state.ensureSessionLoaded(phone, HID);
  assert.ok(s, "🔴 הסשן לא נשמר ל-Postgres בכלל");
  assert.equal(s.guestName, "מיכל לוי");
  assert.equal(s.roomNumber, "1204");
  assert.equal(s.checkinStage, "waiting_terms");
  assert.equal(s.history.length, 2, "🔴 ההיסטוריה אבדה במסלול Postgres");
  assert.equal(s.history[0].content, "שלום");
});

test("🔴 קריאה סינכרונית בלי חימום זורקת — ולא ממציאה אורח חדש", async () => {
  const phone = "whatsapp:+972500900002";
  await state.ensureSessionLoaded(phone, HID);
  state.patchSession(phone, { guestName: "אורח קיים", roomNumber: "5" }, HID);
  await flushPersistence();
  state.sessionCache.clear();

  // זו ההחלטה המרכזית בארכיטקטורה: עדיף שיישבר בקול מאשר שהאורח יאבד
  // את השם, החדר וההיסטוריה ויתחיל צ'ק אין מהתחלה.
  assert.throws(() => state.getSession(phone, HID), /SyncReadUnavailable|סינכרונית/,
    "🔴 getSession החזיר סשן חדש במקום לזרוק — זו בדיוק דליפת המידע השקטה");

  // ואחרי חימום — הכול עובד סינכרונית כרגיל.
  await state.ensureSessionLoaded(phone, HID);
  const s = state.getSession(phone, HID);
  assert.equal(s.guestName, "אורח קיים");
  assert.equal(s.roomNumber, "5");
});

test("אורח חדש לגמרי: החימום מוודא שאינו קיים — ואז היצירה מותרת", async () => {
  const phone = "whatsapp:+972500900003";

  // 🔴 המלכודת ההפוכה: אם "אי אפשר לקרוא" היה חוסם תמיד, אורח חדש לא היה
  //    יכול לפתוח שיחה בכלל — ההודעה הראשונה שלו הייתה נכשלת.
  const before = await state.ensureSessionLoaded(phone, HID);
  assert.equal(before, null, "אין סשן קודם — זה באמת אורח חדש");

  const s = state.getSession(phone, HID);   // לא זורק: כבר נבדק מול ה-DB
  assert.equal(s.stage, "new");
  state.patchSession(phone, { guestName: "אורח ראשון" }, HID);

  await flushPersistence();
  state.sessionCache.clear();
  const back = await state.ensureSessionLoaded(phone, HID);
  assert.equal(back?.guestName, "אורח ראשון", "🔴 האורח החדש לא נשמר");
});

test("סשן: ספירה מחזירה מספר, לא מחרוזת (BIGINT של pg)", async () => {
  const n = await state.sessionCountAsync();
  assert.equal(typeof n, "number", `🔴 COUNT חזר כ-${typeof n} — השוואות גודל היו שגויות`);
  assert.ok(n >= 2);
});

test("סשן: סריקות אסינכרוניות עובדות מול Postgres", async () => {
  const list = await state.allSessionsAsync(HID, { limit: 10 });
  assert.ok(list.length >= 2);
  assert.ok(list.every(s => s.hotelId === HID));

  const byRoom = await state.sessionByRoomAsync("1204", HID);
  assert.ok(byRoom, "🔴 חיפוש לפי חדר נכשל במסלול Postgres");
  assert.equal(byRoom.guestName, "מיכל לוי");
});

// ════════════════════════════════════════════════════════
//  הזמנות
// ════════════════════════════════════════════════════════
test("הזמנה: נשמרת ונטענת דרך Postgres (כולל @named params)", async () => {
  const phone = "whatsapp:+972500900010";
  const { reservationId } = await tenant.runInTenant(HID, () => checkin.startCheckin(
    phone, { guestName: "רון", guestNameHe: "רון", guestNameEn: "Ron" },
    "RES-PG-1", { stay: { checkIn: "2099-10-01", checkOut: "2099-10-04", nights: 3 } },
  ));
  await flushPersistence();

  // ה-upsert של ההזמנות משתמש ב-`@id`/`@hotel_id`. אם התרגום לא עבד,
  // הלקוח המזויף כבר זרק למעלה.
  const r = await checkin.ensureReservationLoaded(reservationId);
  assert.ok(r, "🔴 ההזמנה לא הגיעה ל-Postgres");
  assert.equal(r.guestNameHe, "רון");
  assert.equal(r.id, reservationId);
});

test("הזמנה: חיפושים אסינכרוניים מוצאים הזמנה מאוכלסת", async () => {
  const phone = "whatsapp:+972500900011";
  const { reservationId } = await tenant.runInTenant(HID, () => checkin.startCheckin(
    phone, { guestName: "נועה", guestNameHe: "נועה", guestNameEn: "Noa" },
    "RES-PG-2", { stay: { checkIn: "2099-10-01", checkOut: "2099-10-03", nights: 2 } },
  ));
  await tenant.runInTenant(HID, () => checkin.completeCheckin(reservationId, "808"));
  await flushPersistence();

  const active = await checkin.getActiveReservationAsync(phone, HID);
  assert.ok(active, "🔴 צ'ק אאוט לא היה נמצא — האורח 'אינו מאוכלס'");
  assert.equal(active.roomNumber, "808");

  assert.ok(await checkin.getReservationByRoomAsync("808", HID));
  assert.equal(typeof (await checkin.activeReservationCountAsync(HID)), "number");
});

// ════════════════════════════════════════════════════════
//  עמודי HTTP — המסלול שאינו עובר ב-handleIncoming
// ════════════════════════════════════════════════════════
test("עמוד הפיקדון נטען מ-Postgres — כולל הסשן והקונפיג, לא רק ההזמנה", async () => {
  // 🔴 זו הייתה מלכודת אמיתית: המסלול טען את ההזמנה בלבד, אבל העמוד קורא
  //    **גם** את הסשן (דרך pageLang) ו**גם** את הקונפיג של המלון. אורח
  //    שנחת על עמוד התשלום היה מקבל 500 — או, גרוע יותר, עמוד שממותג
  //    בשם מלון ברירת המחדל במקום המלון שלו.
  const express = (await import("express")).default;
  const router  = (await import("./checkin-routes.js")).default;

  const phone = "whatsapp:+972500900030";
  await state.ensureSessionLoaded(phone, HID);
  state.patchSession(phone, { lang: "en" }, HID);
  const { reservationId } = await tenant.runInTenant(HID, () => checkin.startCheckin(
    phone, { guestName: "Page Guest", guestNameHe: "אורח עמוד", guestNameEn: "Page Guest" },
    "RES-PG-PAGE", { stay: { checkIn: "2099-11-01", checkOut: "2099-11-03", nights: 2 } },
  ));
  await flushPersistence();

  // מרוקנים הכול — כאילו העמוד נפתח בתהליך אחר, שעות אחרי הצ'ק אין.
  state.sessionCache.clear();
  config.clearConfigCache();

  const app = express();
  app.use(router);
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res  = await fetch(`${base}/checkin/pay?rid=${reservationId}`);
    assert.equal(res.status, 200, "🔴 עמוד הפיקדון נפל");
    const html = await res.text();

    // ההזמנה נמצאה: מזהה ההזמנה מופיע בטופס (ולא עמוד "הזמנה לא נמצאה").
    assert.ok(html.includes(reservationId), "🔴 העמוד לא מצא את ההזמנה");
    // הסשן נטען מה-DB: השפה היא של השיחה, לא ברירת המחדל.
    assert.match(html, /lang="en"/,
      "🔴 שפת הסשן אבדה — אורח שדיבר אנגלית קיבל עמוד בעברית");
    // הקונפיג נטען: העמוד ממותג בשם המלון ולא נופל לברירות המחדל בשקט.
    const cfg = config.configFor(HID);
    assert.ok(html.includes(cfg.name) || html.includes(cfg.name_he),
      "🔴 העמוד לא ממותג בשם המלון — הקונפיג לא נטען");
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
});

// ════════════════════════════════════════════════════════
//  קונפיג — הדבר שהיה נשאר ריק בשקט
// ════════════════════════════════════════════════════════
test("קונפיג: נשמר ונטען פר-מלון, בלי ערבוב בין מלונות", async () => {
  await config.updateConfigForAsync("pg_hotel_a", { name: "PG Hotel A", name_he: "מלון א׳" });
  await config.updateConfigForAsync("pg_hotel_b", { name: "PG Hotel B", name_he: "מלון ב׳" });
  await flushPersistence();
  config.clearConfigCache();

  const a = await config.ensureConfigLoaded("pg_hotel_a");
  const b = await config.ensureConfigLoaded("pg_hotel_b");
  assert.equal(a.name, "PG Hotel A");
  assert.equal(b.name, "PG Hotel B");
  assert.notEqual(a.name_he, b.name_he, "🔴 שני המלונות קיבלו את אותו קונפיג");
});

test("קונפיג: hydrateConfig טוען מ-Postgres אחרי בחירת ה-DB", async () => {
  await config.updateConfigForAsync(HID, { wifi: { password: "pg-only-password" } });
  await flushPersistence();
  const cfg = await config.hydrateConfig();
  assert.equal(cfg.wifi.password, "pg-only-password",
    "🔴 השרת היה עולה עם קונפיג ברירת מחדל במקום זה של המלון");
});

// ════════════════════════════════════════════════════════
//  התראות ומיפוי מספרים
// ════════════════════════════════════════════════════════
test("התראות: נכתבות ונטענות מחדש (hydrateState)", async () => {
  state.logAlert({ hotelId: HID, dept: "maintenance", priority: "high", message: "מזגן בחדר 1204" });
  await flushPersistence();

  const out = await state.hydrateState();
  assert.ok(out.alerts >= 1, "🔴 ההתראות היו חוזרות ריקות אחרי עלייה מחדש");
  assert.ok(state.staffAlerts.some(a => a.message?.includes("1204")));
});

test("מספרים: מיפוי המלונות נטען מ-Postgres", async () => {
  tenant.registerHotelNumber("+15551230000", "pg_hotel_a");
  await flushPersistence();
  await tenant.reloadHotelNumbersAsync();
  assert.equal(tenant.resolveHotelId("whatsapp:+15551230000"), "pg_hotel_a",
    "🔴 הודעה הייתה מנותבת למלון ברירת המחדל במקום למלון הנכון");
});

// ════════════════════════════════════════════════════════
//  אירועי חירום — אישור קבלה על אירוע שכבר לא בזיכרון
// ════════════════════════════════════════════════════════
test("אישור קבלה עובד על אירוע ישן (אחרי ריסטארט) מול Postgres", async () => {
  // 🔴 המקרה שבו זה הכי חשוב: deploy באמצע אירוע חירום. האירוע כבר לא
  //    ב-cache החי, ואיש הביטחון לוחץ על הקישור שבהתראה. אם האישור נכשל
  //    כאן, האירוע יוסלם שוב — או שהצוות יחשוב שאישר כשלא.
  const esc = await import("./escalation.js");
  const inc = state.logIncident({
    hotelId: HID, phone: "whatsapp:+972500900040", roomNumber: "1801",
    guestName: "אורח חירום", kind: "injury", description: "[injury] נפילה",
  });
  esc.armIncident(inc.id);
  await flushPersistence();

  state.incidents.length = 0;               // "ריסטארט" — האירוע רק ב-DB

  const ack = await esc.acknowledgeIncident(inc.id, { actor: "משה (ביטחון)" });
  assert.equal(ack.ok, true, "🔴 אישור קבלה נכשל על אירוע שאינו בזיכרון");
  assert.equal(ack.incident.ackBy, "משה (ביטחון)");

  await flushPersistence();
  state.incidents.length = 0;
  const fromDb = await state.getIncidentAsync(inc.id);
  assert.equal(fromDb.ackBy, "משה (ביטחון)", "🔴 האישור לא נשמר ל-Postgres");
  assert.equal(fromDb.ackDeadline, null, "🔴 הסולם לא נוטרל — האירוע יוסלם שוב");
});

// ════════════════════════════════════════════════════════
//  סדר הכתיבות — ההבטחה המרכזית של התור
// ════════════════════════════════════════════════════════
test("סדר: עדכונים רצופים לאותה שורה נשמרים בסדר שנוצרו", async () => {
  const phone = "whatsapp:+972500900020";
  await state.ensureSessionLoaded(phone, HID);
  for (let i = 1; i <= 25; i++) state.patchSession(phone, { roomNumber: String(i) }, HID);
  await flushPersistence();
  state.sessionCache.clear();

  const s = await state.ensureSessionLoaded(phone, HID);
  assert.equal(s.roomNumber, "25",
    "🔴 כתיבות התהפכו — הערך האחרון אינו האחרון שנשמר");
});

test("מונה חשבוניות אטומי: כל קריאה מחזירה מספר חדש", async () => {
  const { nextInvoiceSeqSafe } = await import("./db.js");
  const seqs = [];
  for (let i = 0; i < 5; i++) seqs.push(await nextInvoiceSeqSafe("pg_hotel_a", 2099));
  assert.equal(new Set(seqs).size, 5, "🔴 שתי חשבוניות מס עם אותו מספר סידורי");
  assert.ok(seqs.every(n => typeof n === "number" && Number.isFinite(n)));
});
