// ════════════════════════════════════════════════════════
//  SCHEDULE — מנוע הזמן וההודעות היזומות
//  ----------------------------------------------------------
//  🔴 הודעה יזומה היא הדבר היחיד שהמערכת שולחת **בלי שאורח ביקש**, ולכן
//     כל טעות בה נראית לאורח כרשלנות של המלון. הבדיקות כאן נכתבו סביב
//     ארבע הדרכים שבהן זה יכול להשתבש: כפילות, שעת לילה, הודעה לאורח
//     שכבר עזב, והודעה מהמספר של מלון אחר.
// ════════════════════════════════════════════════════════
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH = freshTestDbPath("schedule");
process.env.TWILIO_ACCOUNT_SID     = "ACtest";
process.env.TWILIO_AUTH_TOKEN      = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.ANTHROPIC_API_KEY      = "sk-test";
process.env.BASE_URL               = "http://test.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);

const outgoing = [];
mock.module("twilio", {
  exports: { default: () => ({ messages: { create: async ({ to, body, from }) => { outgoing.push({ to, body, from }); return { sid: "SM" }; } } }) },
});
const { email } = await import("./email/index.js");
email.send = async () => ({ success: true });

const sched   = await import("./schedule.js");
const msgs    = await import("./messages.js");
const checkin = await import("./checkin.js");
const tenant  = await import("./tenant.js");
const state   = await import("./state.js");
const config  = await import("./config.js");
await import("./bot.js");           // מחווט composer/sender/guard

const HID  = tenant.DEFAULT_HOTEL_ID;
const K    = sched.MESSAGE_KINDS;
const YMD  = d => d.toISOString().slice(0, 10);
const plus = n => YMD(new Date(Date.now() + n * 86_400_000));

async function makeReservation(phone, { inDays = 5, nights = 2 } = {}) {
  const { reservationId } = await tenant.runInTenant(HID, () => checkin.startCheckin(
    phone, { guestName: "דנה כהן", guestNameHe: "דנה כהן", guestNameEn: "Dana Cohen" },
    `RES-SCH-${phone.slice(-5)}`,
    { stay: { checkIn: plus(inDays), checkOut: plus(inDays + nights), nights } },
  ));
  return checkin.reservations[reservationId];
}

// ════════════════════════════════════════════════════════
//  זמן — אזור זמן, שעות שקטות
// ════════════════════════════════════════════════════════
test("🔴 שעת שליחה מחושבת בשעון **המלון**, לא בשעון השרת", () => {
  const israel = sched.hotelDateTime("2026-07-01", "18:00", "Asia/Jerusalem");
  const ny     = sched.hotelDateTime("2026-07-01", "18:00", "America/New_York");
  // 18:00 בניו יורק הוא רגע אחר לגמרי מ-18:00 בישראל.
  assert.notEqual(israel.getTime(), ny.getTime());
  assert.equal(sched.hourInHotel(israel, "Asia/Jerusalem"), 18);
  assert.equal(sched.hourInHotel(ny, "America/New_York"), 18,
    "🔴 מלון בניו יורק חייב לשלוח לפי השעון שלו");
});

test("🔴 הודעה שנופלת בלילה נדחית לשעה תרבותית — ולא מתפספסת", () => {
  const tz    = "Asia/Jerusalem";
  const night = sched.hotelDateTime("2026-07-01", "23:30", tz);
  const fixed = sched.shiftOutOfQuietHours(night, tz);
  const h     = sched.hourInHotel(fixed, tz);
  assert.ok(h >= sched.QUIET_TO && h < sched.QUIET_FROM,
    `🔴 הודעה הייתה נשלחת ב-${h}:00 ומעירה אורח`);
  assert.ok(fixed.getTime() > night.getTime(), "נדחתה קדימה, לא הוקדמה");
});

test("שעה תקינה אינה זזה", () => {
  const tz = "Asia/Jerusalem";
  const ok = sched.hotelDateTime("2026-07-01", "14:00", tz);
  assert.equal(sched.shiftOutOfQuietHours(ok, tz).getTime(), ok.getTime());
});

// ════════════════════════════════════════════════════════
//  תזמון
// ════════════════════════════════════════════════════════
test("הזמנה חדשה מתזמנת את ציר הזמן המלא", async () => {
  const res  = await makeReservation("whatsapp:+972521110001");
  const rows = await sched.scheduleForReservation(res.id);
  const kinds = rows.map(r => r.kind);

  for (const k of [K.BOOKING_CONFIRMED, K.DAY_BEFORE, K.ARRIVAL_DAY, K.DEPARTURE_EVE, K.POST_STAY]) {
    assert.ok(kinds.includes(k), `🔴 חסרה הודעה מתוזמנת: ${k}`);
  }
  assert.ok(rows.every(r => r.status === "pending"));
  // הסדר הכרונולוגי הוא סדר המסע.
  const times = rows.map(r => new Date(r.send_at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "🔴 ציר הזמן אינו כרונולוגי");
});

test("🔴 תזמון כפול אינו יוצר הודעה כפולה", async () => {
  const res = await makeReservation("whatsapp:+972521110002");
  sched.scheduleStayTimeline(res);
  sched.scheduleStayTimeline(res);          // שוב, ושוב
  sched.scheduleMessage(res, K.DAY_BEFORE);

  const rows = await sched.scheduleForReservation(res.id);
  const dayBefore = rows.filter(r => r.kind === K.DAY_BEFORE);
  assert.equal(dayBefore.length, 1,
    `🔴 ${dayBefore.length} עותקים — האורח היה מקבל את אותה הודעה פעמיים`);
});

test("מועד שכבר עבר אינו מתוזמן (הזמנה של הרגע האחרון)", async () => {
  const res  = await makeReservation("whatsapp:+972521110003", { inDays: 0, nights: 1 });
  const rows = await sched.scheduleForReservation(res.id);
  // "יום לפני" של הזמנה שמתחילה היום כבר עבר — לא שולחים "נתראה מחר" בדיעבד.
  assert.ok(!rows.some(r => r.kind === K.DAY_BEFORE),
    "🔴 תוזמנה הודעת 'יום לפני' רטרואקטיבית");
});

test("ביטול מסיר את כל מה שממתין", async () => {
  const res = await makeReservation("whatsapp:+972521110004");
  sched.cancelScheduled(res.id);
  const rows = await sched.scheduleForReservation(res.id);
  assert.ok(rows.every(r => r.status !== "pending"), "🔴 נשארו הודעות ממתינות אחרי ביטול");
});

// ════════════════════════════════════════════════════════
//  שליחה
// ════════════════════════════════════════════════════════
test("הודעה שהגיע זמנה נשלחת — פעם אחת בדיוק", async () => {
  outgoing.length = 0;
  const phone = "whatsapp:+972521110010";
  const res   = await makeReservation(phone);

  const future = new Date(Date.now() + 400 * 86_400_000);   // אחרי הכול
  const first  = await sched.deliverDue(future);
  assert.ok(first.sent >= 1, "🔴 שום דבר לא נשלח");

  const mine = outgoing.filter(o => o.to === phone);
  assert.ok(mine.length >= 1);

  // סבב שני — אין כפילות.
  const before = outgoing.length;
  await sched.deliverDue(future);
  assert.equal(outgoing.length, before,
    "🔴 סבב שני שלח שוב — האורח מקבל את אותן הודעות פעמיים");
});

test("🔴 ההודעה יוצאת מהמספר של המלון הנכון", async () => {
  outgoing.length = 0;
  config.updateConfigFor("sched_hotel_b", { name: "Hotel B", name_he: "מלון ב׳" });
  tenant.registerHotelNumber("+15557770001", "sched_hotel_b");
  tenant.reloadHotelNumbers();

  const phone = "whatsapp:+972521110020";
  const { reservationId } = await tenant.runInTenant("sched_hotel_b", () => checkin.startCheckin(
    phone, { guestName: "אורח ב", guestNameHe: "אורח ב", guestNameEn: "Guest B" },
    "RES-SCH-B", { stay: { checkIn: plus(3), checkOut: plus(5), nights: 2 } },
  ));
  void reservationId;

  await sched.deliverDue(new Date(Date.now() + 400 * 86_400_000));
  const mine = outgoing.filter(o => o.to === phone);
  assert.ok(mine.length >= 1, "נשלחה הודעה");
  assert.ok(mine.every(o => String(o.from).includes("15557770001")),
    `🔴 הודעה יצאה מהמספר הלא נכון: ${mine[0]?.from} — אורח של מלון אחד קיבל הודעה ממלון אחר`);
});

test("🔴 אורח שכבר עזב אינו מקבל הודעות שהות", async () => {
  outgoing.length = 0;
  const phone = "whatsapp:+972521110030";
  const res   = await makeReservation(phone);
  await tenant.runInTenant(HID, () => checkin.completeCheckin(res.id, "501"));

  // מסמנים כעזב, ומשאירים במכוון הודעת "ערב לפני עזיבה" ממתינה.
  const live = checkin.reservations[res.id];
  live.stage = "checked_out";
  sched.scheduleMessage(live, K.DEPARTURE_EVE);

  outgoing.length = 0;
  await sched.deliverDue(new Date(Date.now() + 400 * 86_400_000));
  const bodies = outgoing.filter(o => o.to === phone).map(o => o.body).join("\n");
  assert.ok(!/צ'ק אאוט עד|Check-out by/.test(bodies),
    "🔴 אורח שעזב קיבל 'מחר יום העזיבה'");
});

// ════════════════════════════════════════════════════════
//  תוכן — רמת קמפינסקי, מהקונפיג של אותו מלון
// ════════════════════════════════════════════════════════
test("התוכן נבנה מהמלון עצמו — שם, כתובת, שעות", async () => {
  const res = await makeReservation("whatsapp:+972521110040");
  const cfg = config.configFor(HID);
  const built = msgs.composeScheduled(K.DAY_BEFORE, res);

  assert.ok(built?.text, "נבנתה הודעה");
  assert.ok(built.text.includes(cfg.name_he || cfg.name), "🔴 שם המלון חסר");
  assert.ok(built.text.includes(cfg.checkin_time), "שעת הכניסה מופיעה");
  assert.ok(!/undefined|null|NaN|\[object/.test(built.text),
    `🔴 ערך לא מוגדר דלף לאורח: ${built.text}`);
});

test("🔴 שדה שאין לו ערך פשוט אינו מופיע", () => {
  // מלון בלי בריכה/ספא/כתובת — אסור שיופיעו שורות ריקות או "undefined".
  config.updateConfigFor("sched_bare", {
    name: "Bare Hotel", name_he: "מלון ריק",
    location: { address: null, address_he: null, lat: null, lng: null, timezone: "Asia/Jerusalem" },
    services: { spa: null, restaurant: null, breakfast: null },
    parking: { available: false },
  });
  const res = {
    id: "r1", hotelId: "sched_bare", phone: "whatsapp:+972521110050",
    guestName: "דנה", guestNameHe: "דנה", guestNameEn: "Dana",
    stayCheckIn: plus(2), stayCheckOut: plus(4), nights: 2,
  };
  for (const kind of Object.values(K)) {
    const built = msgs.composeScheduled(kind, res);
    if (!built) continue;
    assert.ok(!/undefined|null|NaN|\[object/.test(built.text), `🔴 ${kind}: ${built.text}`);
    assert.ok(!/\n\s*\n\s*\n/.test(built.text), `🔴 ${kind}: שורות ריקות כפולות`);
  }
});

test("אופן הכניסה נגזר מסוג המלון — קוד מול כרטיס", () => {
  const base = {
    id: "r2", phone: "whatsapp:+972521110060",
    guestName: "דנה", guestNameHe: "דנה", guestNameEn: "Dana",
    stayCheckIn: plus(1), stayCheckOut: plus(3), nights: 2, roomNumber: "12",
  };
  config.updateConfigFor("sched_boutique", { name_he: "בוטיק", hotel_type: "boutique" });
  config.updateConfigFor("sched_full",     { name_he: "מלא",   hotel_type: "full_service" });

  const b = msgs.composeScheduled(K.ARRIVAL_DAY, { ...base, hotelId: "sched_boutique", doorCode: "4821" });
  const f = msgs.composeScheduled(K.ARRIVAL_DAY, { ...base, hotelId: "sched_full" });

  assert.match(b.text, /4821/, "🔴 מלון בוטיק חייב למסור קוד דלת");
  assert.match(f.text, /קבלה/, "🔴 מלון מלא מכוון לקבלה");
  assert.ok(!/4821/.test(f.text), "🔴 קוד דלת דלף למלון שעובד עם כרטיס");
});

test("כל ההודעות עומדות בתקן הניסוח", async () => {
  const { auditAll } = await import("./voice.js");
  const res = await makeReservation("whatsapp:+972521110070");
  const built = Object.values(K).map(k => msgs.composeScheduled(k, res)).filter(Boolean);
  assert.ok(built.length >= 5, "נבנו הודעות");

  const result = auditAll(built.map(b => ({ body: b.text })));
  assert.equal(result.bySeverity.error, 0,
    `🔴 הפרות תקן: ${result.violations.filter(v => v.severity === "error").map(v => `${v.rule}: ${v.sample}`).join(" | ")}`);
});
