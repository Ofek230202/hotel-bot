// ════════════════════════════════════════════════════════
//  HANDOVER — בקשה לא עוברת חילופי משמרת בלי שמישהו יראה אותה
//  ----------------------------------------------------------
//  🔴 לחירום כבר יש סולם אישור-קבלה. לבקשה רגילה לא היה כלום: היא
//     נשלחת למחלקה, ואם איש לא הרים — היא **נעלמת**. האורח ביקש מגבות
//     ב-15:00, המשמרת התחלפה ב-16:00, ואיש אינו יודע שהבקשה קיימת.
//     זה נראה קטן ליד חירום, אבל הרבה יותר שכיח.
// ════════════════════════════════════════════════════════
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH = freshTestDbPath("handover");
process.env.TWILIO_ACCOUNT_SID     = "ACtest";
process.env.TWILIO_AUTH_TOKEN      = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.ANTHROPIC_API_KEY      = "sk-test";
process.env.BASE_URL               = "http://test.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);
process.env.REQUEST_ACK_MS = "60";      // מזעריים — כדי לשלוט בזמן
process.env.REQUEST_ESC_MS = "150";

mock.module("twilio", {
  exports: { default: () => ({ messages: { create: async () => ({ sid: "SM" }) } }) },
});
const { email } = await import("./email/index.js");
email.send = async () => ({ success: true });

const ho = await import("./handover.js");

const notes = [];
ho.setNotifier(async a => { notes.push(a); });

const HID = "kempinski";
const wait = ms => new Promise(r => setTimeout(r, ms));

function newRequest(summary = "מגבות נוספות", extra = {}) {
  notes.length = 0;
  return ho.trackRequest({
    hotelId: HID, dept: "housekeeping", phone: "whatsapp:+972571110001",
    room: "412", guestName: "דנה כהן", summary, ...extra,
  });
}

// ════════════════════════════════════════════════════════
test("בקשה נכנסת למעקב ומופיעה כפתוחה", async () => {
  const id = newRequest();
  assert.ok(id, "נוצר מזהה");
  const open = await ho.openRequests({ hotelId: HID });
  const mine = open.find(r => r.id === id);
  assert.ok(mine, "🔴 הבקשה אינה ברשימת הפתוחות — היא תיעלם");
  assert.equal(mine.unacknowledged, true);
  assert.equal(mine.room, "412");
  assert.equal(mine.dept, "housekeeping");
});

test("🔴 בקשה שאיש לא אישר מקבלת תזכורת — לאותה מחלקה", async () => {
  const id = newRequest("מגבות לחדר 412");
  await wait(90);
  const out = await ho.sweepRequests();

  assert.ok(out.reminded >= 1, "🔴 לא נשלחה תזכורת — הבקשה תישכח");
  const rem = notes.find(n => /ממתינה/.test(n.message));
  assert.ok(rem, "יש תזכורת");
  assert.equal(rem.dept, "housekeeping", "🔴 התזכורת הלכה למחלקה הלא נכונה");
  assert.match(rem.message, /412/, "מספר החדר בתזכורת — בלעדיו אין לאן ללכת");
  void id;
});

test("תזכורת נשלחת פעם אחת, לא כנדנוד", async () => {
  newRequest();
  await wait(90);
  await ho.sweepRequests();
  const after = notes.length;
  await ho.sweepRequests();
  await ho.sweepRequests();
  assert.equal(notes.length, after, "🔴 המחלקה מקבלת נדנוד — וזה מה שגורם להתעלם מהתראות");
});

test("🔴 בקשה שנשכחה מוסלמת לקבלה — ולא לכל המלון", async () => {
  newRequest("מגבות שנשכחו");
  await wait(90);
  await ho.sweepRequests();          // תזכורת
  await wait(90);
  const out = await ho.sweepRequests();  // הסלמה

  assert.ok(out.escalated >= 1, "🔴 בקשה נשכחה ולא הוסלמה");
  const esc = notes.find(n => /נשכחה/.test(n.message));
  assert.ok(esc, "יש הסלמה");
  assert.equal(esc.dept, "reception",
    "🔴 בקשה רגילה אינה חירום — היא לא צריכה להעיר את כל המלון");
  // אין הצפה לכל המחלקות, בניגוד לסולם החירום.
  assert.ok(!notes.some(n => n.dept === "security"), "🔴 ביטחון הוזעק על מגבות");
});

test("אישור קבלה עוצר תזכורות והסלמות", async () => {
  const id = newRequest();
  await ho.acknowledgeRequest(id, { by: "יעל (משק בית)" });
  notes.length = 0;
  await wait(200);
  await ho.sweepRequests();
  await ho.sweepRequests();
  assert.equal(notes.length, 0, "🔴 בקשה מאושרת המשיכה להתריע — אזעקת שווא");

  const open = await ho.openRequests({ hotelId: HID });
  assert.equal(open.find(r => r.id === id).ackedBy, "יעל (משק בית)",
    "🔴 בלי שם המאשר אין שרשרת אחריות");
});

test("אישור כפול אינו דורס את מי שאישר ראשון", async () => {
  const id = newRequest();
  await ho.acknowledgeRequest(id, { by: "ראשון" });
  const second = await ho.acknowledgeRequest(id, { by: "שני" });
  assert.equal(second.alreadyAcked, true);
  assert.equal(second.by, "ראשון");
});

test("סימון כטופל מוציא את הבקשה מהרשימה", async () => {
  const id = newRequest();
  await ho.completeRequest(id, { by: "יעל" });
  const open = await ho.openRequests({ hotelId: HID });
  assert.ok(!open.some(r => r.id === id), "🔴 בקשה שטופלה עדיין מופיעה כפתוחה");
});

test("סגירה ישירה בלי אישור נחשבת גם כאישור", async () => {
  const id = newRequest();
  await ho.completeRequest(id, { by: "מנהל" });
  notes.length = 0;
  await wait(200);
  await ho.sweepRequests();
  assert.equal(notes.length, 0, "🔴 בקשה סגורה הוסלמה");
});

// ════════════════════════════════════════════════════════
//  דוח מסירת המשמרת
// ════════════════════════════════════════════════════════
test("🔴 דוח המשמרת מדרג לפי דחיפות — לא לפי זמן", async () => {
  // מנקים ואז יוצרים שתיים: אחת מאושרת וישנה, אחת חדשה ולא מאושרת.
  for (const r of await ho.openRequests({ hotelId: HID })) await ho.completeRequest(r.id, { by: "ניקוי" });

  const oldAcked = newRequest("ישנה אך מאושרת");
  await ho.acknowledgeRequest(oldAcked, { by: "מישהו" });
  await wait(40);
  newRequest("חדשה ולא אושרה");

  const rep = await ho.shiftReport({ hotelId: HID });
  assert.equal(rep.open, 2);
  assert.equal(rep.unacknowledged, 1);
  assert.match(rep.items[0].summary, /לא אושרה/,
    "🔴 הפריט הראשון חייב להיות מה שאיש לא לקח אחריות עליו — הדוח נקרא בקול בחילופי משמרת");
});

test("בידוד: דוח המשמרת של מלון אחד אינו כולל בקשות של אחר", async () => {
  ho.trackRequest({ hotelId: "ho_other", dept: "maintenance", room: "9", summary: "מזגן" });
  const mine = await ho.shiftReport({ hotelId: HID });
  assert.ok(!mine.items.some(i => i.summary === "מזגן"),
    "🔴 בקשה של מלון אחר דלפה לדוח");
});

test("בקשה בלי מחלקה אינה נרשמת", () => {
  assert.equal(ho.trackRequest({ hotelId: HID, summary: "בלי מחלקה" }), null);
});
