// ════════════════════════════════════════════════════════
//  READ-THROUGH — הסרת תקרת הזיכרון, בלי לאבד מידע
//  ----------------------------------------------------------
//  הסיכון היחיד בפינוי הוא **אובדן שקט**: אורח שהסשן שלו פונה מהזיכרון
//  ומתחיל מחדש כאילו הוא אורח חדש — היסטוריה, שם, מספר חדר, שלב הצ'ק
//  אין, הכול נעלם באמצע שיחה. הבדיקות כאן מכריחות פינוי בפועל (cache
//  קטן במכוון) ומוודאות שהכול חוזר מה-DB.
// ════════════════════════════════════════════════════════
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH = freshTestDbPath("readthrough");
process.env.TWILIO_ACCOUNT_SID     = "ACtest";
process.env.TWILIO_AUTH_TOKEN      = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.ANTHROPIC_API_KEY      = "sk-test";
process.env.BASE_URL               = "http://test.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);
// 🔴 cache זעיר בכוונה — כך הפינוי קורה **בוודאות** ולא במקרה.
process.env.SESSION_CACHE_MAX      = "3";
process.env.RESERVATION_CACHE_MAX  = "3";

mock.module("twilio", {
  exports: { default: () => ({ messages: { create: async () => ({ sid: "SMtest" }) } }) },
});
const { email } = await import("./email/index.js");
email.send = async () => ({ success: true });

const state   = await import("./state.js");
const checkin = await import("./checkin.js");
const tenant  = await import("./tenant.js");

const HID = tenant.DEFAULT_HOTEL_ID;

// ════════════════════════════════════════════════════════
//  סשנים
// ════════════════════════════════════════════════════════
test("סשן: פינוי אינו מאבד מידע — הכול חוזר מה-DB", () => {
  const phone = "whatsapp:+972500001001";
  state.patchSession(phone, {
    lang: "he", guestName: "דנה כהן", roomNumber: "7", stage: "checked_in", checkinStage: "waiting_terms",
  }, HID);
  state.pushHistory(phone, "user", "שלום", HID);
  state.pushHistory(phone, "assistant", "ברוכה הבאה", HID);

  // דוחפים אורחים אחרים עד שהראשון בוודאות פונה (cache=3).
  for (let i = 0; i < 10; i++) state.getSession(`whatsapp:+97250000${2000 + i}`, HID);
  assert.ok(state.sessionCache.size <= 3, `🔴 ה-cache לא חסום: ${state.sessionCache.size}`);

  // ועכשיו האורח כותב שוב.
  const s = state.getSession(phone, HID);
  assert.equal(s.guestName, "דנה כהן", "🔴 השם אבד — האורח נראה כאורח חדש");
  assert.equal(s.roomNumber, "7");
  assert.equal(s.stage, "checked_in");
  assert.equal(s.checkinStage, "waiting_terms", "🔴 שלב הצ'ק אין אבד באמצע התהליך");
  assert.equal(s.history.length, 2, "🔴 היסטוריית השיחה אבדה");
  assert.equal(s.history[0].content, "שלום");
});

test("סשן: peekSession גם הוא read-through", () => {
  const phone = "whatsapp:+972500001100";
  state.patchSession(phone, { lang: "en", guestName: "John" }, HID);
  for (let i = 0; i < 10; i++) state.getSession(`whatsapp:+97250000${3000 + i}`, HID);

  const s = state.peekSession(phone, HID);
  assert.ok(s, "🔴 peek החזיר undefined על סשן שקיים ב-DB");
  assert.equal(s.guestName, "John");
});

test("סשן: peekSession על אורח שבאמת לא קיים מחזיר undefined", () => {
  assert.equal(state.peekSession("whatsapp:+972500009999", HID), undefined);
});

test("סשן: הזיכרון נשאר חסום גם אחרי אלפי אורחים", () => {
  for (let i = 0; i < 3000; i++) state.getSession(`whatsapp:+9725001${String(i).padStart(4, "0")}`, HID);
  assert.ok(state.sessionCache.size <= 3, `🔴 ה-cache גדל ל-${state.sessionCache.size}`);
  assert.ok(state.sessionCache.info().evictions > 2000, "פינוי אכן קרה");
});

test("סשן: מונה וסריקות עובדים מול ה-DB ולא מול הזיכרון", () => {
  const n = state.sessionCount();
  assert.ok(n > 3000, `🔴 הספירה מגיעה מה-cache (${n}) ולא מה-DB`);
  // allSessions מוגבל אך מחזיר מה-DB
  const list = state.allSessions(HID, { limit: 50 });
  assert.equal(list.length, 50);
  assert.ok(list.every(s => s.hotelId === HID));
});

test("סשן: חיפוש לפי חדר מוצא אורח שפונה מהזיכרון", () => {
  const phone = "whatsapp:+972500001200";
  state.patchSession(phone, { roomNumber: "911", guestName: "אורח חדר" }, HID);
  for (let i = 0; i < 10; i++) state.getSession(`whatsapp:+97250000${4000 + i}`, HID);

  const found = state.sessionByRoom("911", HID);
  assert.ok(found, "🔴 הקבלה מקבלת 'לא נמצא' על אורח שקיים");
  assert.equal(found.guestName, "אורח חדר");
});

test("סשן: מחיקה מדווחת נכון גם על סשן מפונה", () => {
  const phone = "whatsapp:+972500001300";
  state.patchSession(phone, { guestName: "למחיקה" }, HID);
  for (let i = 0; i < 10; i++) state.getSession(`whatsapp:+97250000${5000 + i}`, HID);

  assert.equal(state.deleteSession(phone, HID), true, "🔴 דיווח 'לא היה' על סשן שקיים ב-DB");
  assert.equal(state.peekSession(phone, HID), undefined, "ואחריה באמת אין");
  assert.equal(state.deleteSession(phone, HID), false);
});

// ════════════════════════════════════════════════════════
//  הזמנות
// ════════════════════════════════════════════════════════
test("הזמנה: reservations[id] עובד גם אחרי פינוי", async () => {
  const { reservationId } = await tenant.runInTenant(HID, () => checkin.startCheckin(
    "whatsapp:+972500002001", { guestName: "דנה", guestNameHe: "דנה", guestNameEn: "Dana" },
    "RES-RT-1", { stay: { checkIn: "2099-09-01", checkOut: "2099-09-03", nights: 2 } },
  ));

  // דוחפים הזמנות נוספות עד לפינוי
  for (let i = 0; i < 8; i++) {
    await tenant.runInTenant(HID, () => checkin.startCheckin(
      `whatsapp:+97250000${6000 + i}`, { guestName: "X", guestNameHe: "X", guestNameEn: "X" },
      `RES-RT-F${i}`, { stay: { checkIn: "2099-09-01", checkOut: "2099-09-02", nights: 1 } }));
  }

  // 🔴 זו הגישה שעמוד הפיקדון עושה — חייבת לעבוד.
  const r = checkin.reservations[reservationId];
  assert.ok(r, "🔴 עמוד הפיקדון לא ימצא את ההזמנה");
  assert.equal(r.id, reservationId);
  assert.equal(r.guestNameHe, "דנה");
  assert.equal(r.nights ?? r.stay?.nights ?? 2, 2);
});

test("הזמנה: חיפושים מגובי-DB מוצאים הזמנות מפונות", async () => {
  const phone = "whatsapp:+972500002100";
  const { reservationId } = await tenant.runInTenant(HID, () => checkin.startCheckin(
    phone, { guestName: "פעיל", guestNameHe: "פעיל", guestNameEn: "Active" },
    "RES-RT-ACTIVE", { stay: { checkIn: "2099-09-01", checkOut: "2099-09-03", nights: 2 } },
  ));
  await tenant.runInTenant(HID, () => checkin.completeCheckin(reservationId, "555"));

  for (let i = 0; i < 8; i++) {
    await tenant.runInTenant(HID, () => checkin.startCheckin(
      `whatsapp:+97250000${7000 + i}`, { guestName: "X", guestNameHe: "X", guestNameEn: "X" },
      `RES-RT-G${i}`, { stay: { checkIn: "2099-09-01", checkOut: "2099-09-02", nights: 1 } }));
  }

  const active = tenant.runInTenant(HID, () => checkin.getActiveReservation(phone, HID));
  assert.ok(active, "🔴 צ'ק אאוט לא יימצא — האורח 'אינו מאוכלס'");
  assert.equal(active.roomNumber, "555");

  assert.ok(checkin.getReservationByRoom("555", HID), "🔴 חיפוש לפי חדר נכשל");
  assert.ok(checkin.activeReservationCount(HID) >= 1);
});

test("הזמנה: pending נמצאת גם אחרי פינוי (חידוש שלב הפיקדון)", async () => {
  const phone = "whatsapp:+972500002200";
  await tenant.runInTenant(HID, () => checkin.startCheckin(
    phone, { guestName: "ממתין", guestNameHe: "ממתין", guestNameEn: "Pending" },
    "RES-RT-PEND", { stay: { checkIn: "2099-09-05", checkOut: "2099-09-06", nights: 1 } },
  ));
  for (let i = 0; i < 8; i++) {
    await tenant.runInTenant(HID, () => checkin.startCheckin(
      `whatsapp:+97250000${8000 + i}`, { guestName: "X", guestNameHe: "X", guestNameEn: "X" },
      `RES-RT-H${i}`, { stay: { checkIn: "2099-09-01", checkOut: "2099-09-02", nights: 1 } }));
  }
  const pend = tenant.runInTenant(HID, () => checkin.getPendingReservation(phone, HID));
  assert.ok(pend, "🔴 האורח היה מתחיל צ'ק אין מהתחלה במקום לקבל שוב את קישור התשלום");
  assert.equal(pend.reservationNumber ?? "RES-RT-PEND", "RES-RT-PEND");
});

test("הזמנה: ה-cache חסום גם אחרי מאות הזמנות", () => {
  assert.ok(checkin.reservationCacheInfo().size <= 3,
    `🔴 cache ההזמנות גדל ל-${checkin.reservationCacheInfo().size}`);
  assert.ok(checkin.reservationCacheInfo().evictions > 10, "פינוי אכן קרה");
});

// ════════════════════════════════════════════════════════
//  בידוד מלונות שורד את הפינוי
// ════════════════════════════════════════════════════════
test("בידוד: אותו טלפון בשני מלונות נשאר מופרד גם אחרי פינוי", () => {
  const phone = "whatsapp:+972500003000";
  state.patchSession(phone, { guestName: "בקמפינסקי", roomNumber: "304" }, HID);
  state.patchSession(phone, { guestName: "בלאלה", roomNumber: "7" }, "lala");

  for (let i = 0; i < 10; i++) state.getSession(`whatsapp:+97250000${9000 + i}`, HID);

  assert.equal(state.getSession(phone, HID).guestName, "בקמפינסקי");
  assert.equal(state.getSession(phone, "lala").guestName, "בלאלה",
    "🔴 הפינוי ערבב בין המלונות");
  assert.equal(state.getSession(phone, HID).roomNumber, "304");
});
