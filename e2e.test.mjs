// ════════════════════════════════════════════════════════
//  E2E — שחזור התקלות שנצפו בבדיקה החיה בענן
//  ----------------------------------------------------------
//  מריצים את handleIncoming האמיתי (bot.js) מקצה לקצה, כשטוויליו
//  ו-Claude מוחלפים ב-mock. כל בדיקה משחזרת תרחיש אמיתי שנכשל.
//
//  הרצה:  npm run test:e2e
//  (דורש --experimental-test-module-mocks כדי להחליף מודולים ב-ESM)
// ════════════════════════════════════════════════════════
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DB זמני — הבדיקות לא נוגעות ב-hotel.db האמיתי.
process.env.DB_PATH              = path.join(os.tmpdir(), `hotel-test-${process.pid}.db`);
process.env.TWILIO_ACCOUNT_SID   = "ACtest";
process.env.TWILIO_AUTH_TOKEN    = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.ANTHROPIC_API_KEY    = "sk-test";
process.env.BASE_URL             = "http://test.local";

// ── mocks ──────────────────────────────────────────────
const sent = [];            // כל ההודעות שנשלחו בוואטסאפ
let aiReply = "שלום!";      // מה ש-Claude "יחזיר" בקריאה הבאה
let aiCalls = 0;

mock.module("twilio", {
  exports: {
    default: () => ({
      messages: {
        create: async ({ to, body }) => {
          // טוויליו האמיתי זורק על body ריק — משחזרים כדי לתפוס "שקט".
          if (!body) throw new Error("Twilio: body is required");
          sent.push({ to, body });
          return { sid: "SMtest" };
        },
      },
    }),
  },
});

mock.module("@anthropic-ai/sdk", {
  exports: {
    default: class Anthropic {
      messages = {
        create: async () => {
          aiCalls++;
          return { content: [{ type: "text", text: aiReply }] };
        },
      };
    },
  },
});

// אימות הזהות — נשלט מהבדיקה (לא קוראים ל-AI/רשת אמיתיים).
let idResult = { success: true, status: "verified", documentId: "d1", documentType: "id_card", storedPath: "/demo/id.jpg", reasonHe: "", reasonEn: "" };
mock.module("./idverify/index.js", {
  exports: { idVerify: { verifyDocument: async () => idResult } },
});

let bot;
before(async () => { bot = await import("./bot.js"); });

const GUEST = "whatsapp:+972500000001";
let phoneSeq = 0;
function freshGuest() { return `whatsapp:+9725000000${String(++phoneSeq).padStart(2, "0")}`; }

beforeEach(() => { sent.length = 0; aiCalls = 0; });

const lastBody  = () => sent.at(-1)?.body ?? "";
const allBodies = () => sent.map(s => s.body).join("\n---\n");
const IMG = { url: "https://api.twilio.com/media/ME1", contentType: "image/jpeg" };

// מריץ צ'ק אין עד שלב מסוים ומחזיר את מספר הטלפון.
async function checkinUpTo(stage, { lang = "he" } = {}) {
  const p = freshGuest();
  await bot.handleIncoming(p, lang === "he" ? "צק אין" : "check in");
  if (stage === "waiting_name") return p;
  await bot.handleIncoming(p, lang === "he" ? "אופק כהן" : "John Smith");
  if (stage === "waiting_reservation") return p;
  await bot.handleIncoming(p, "1234");
  if (stage === "waiting_id") return p;
  await bot.handleIncoming(p, "", IMG);
  return p; // waiting_payment
}

// ════════════════════════════════════════════════════════
//  בעיה 1 — תג פנימי דלף לאורח
// ════════════════════════════════════════════════════════
test("בעיה 1: [CHECKIN] מה-AI לעולם לא נשלח לאורח — גם בשלב הפיקדון", async () => {
  const p = await checkinUpTo("waiting_payment");
  sent.length = 0;

  // בדיוק התרחיש שנצפה: אורח בשלב הפיקדון כותב "להמשיך בצ'אק אין",
  // וה-AI מחזיר את התג בלבד.
  aiReply = "[CHECKIN]";
  await bot.handleIncoming(p, "להמשיך בצ'אק אין");

  assert.ok(sent.length > 0, "האורח חייב לקבל מענה");
  assert.ok(!allBodies().includes("[CHECKIN]"), `תג דלף לאורח: ${allBodies()}`);
  assert.match(lastBody(), /פיקדון/, "האורח אמור לקבל את שלב הפיקדון מחדש");
});

test("בעיה 1: תג פנימי כלשהו מסונן גם אם הקוד פספס אותו (רשת ביטחון ב-wa)", async () => {
  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  sent.length = 0;

  aiReply = "בוודאי, אטפל בזה. [HK:נשפך קפה בחדר] [SOMETHING_NEW:x]";
  await bot.handleIncoming(p, "נשפך לי קפה על הרצפה");

  assert.ok(!allBodies().includes("["), `תג דלף לאורח: ${allBodies()}`);
  assert.match(lastBody(), /בוודאי/);
});

test("בעיה 1: תשובת AI שכולה תגים → האורח מקבל אישור אנושי, לא הודעה ריקה", async () => {
  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  sent.length = 0;

  aiReply = "[HK:טאולים נוספים]";
  await bot.handleIncoming(p, "אפשר עוד מגבות?");

  assert.equal(sent.length > 0, true, "אסור שקט");
  assert.ok(lastBody().length > 5, `הודעה ריקה/חסרת משמעות: "${lastBody()}"`);
  assert.ok(!lastBody().includes("["));
});

// ════════════════════════════════════════════════════════
//  בעיה 2 — הבוט הפסיק לענות
// ════════════════════════════════════════════════════════
test("בעיה 2: קריסת AI → האורח עדיין מקבל תשובה (אף פעם לא שקט)", async () => {
  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  sent.length = 0;

  const orig = Object.getOwnPropertyDescriptor(globalThis, "__none__");
  aiReply = null; // יגרום ל-content ריק → "empty AI response" → נתיב השגיאה
  await bot.handleIncoming(p, "מה שעות הבריכה?");

  assert.ok(sent.length > 0, "אסור להשאיר את האורח בלי מענה");
  void orig;
});

test("בעיה 2: שגיאה בלתי צפויה בזרימה → הודעת גיבוי לאורח + הסלמה לקבלה", async () => {
  const p = await checkinUpTo("waiting_reservation");
  sent.length = 0;

  // מפילים בכוונה את שלב אימות הזהות
  const saved = idResult;
  idResult = null; // → result.status ייקרא מ-null → TypeError בתוך הזרימה
  await bot.handleIncoming(p, "1234");   // → waiting_id
  await bot.handleIncoming(p, "", IMG);  // → קורס בפנים
  idResult = saved;

  assert.ok(sent.some(s => s.to === p), "האורח חייב לקבל הודעה כלשהי");
  assert.ok(!sent.some(s => s.to === p && !s.body), "אין הודעות ריקות");
});

test("בעיה 2 (שורש): תמונה בלי טקסט לא מרעילה את ההיסטוריה — הבוט ממשיך לענות לתמיד", async () => {
  const { sessions } = await import("./state.js");
  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");

  // התרחיש שהרג את הבוט: אורח שולח תמונה אקראית בלי טקסט (מחוץ לצ'ק אין).
  aiReply = "תמונה יפה!";
  await bot.handleIncoming(p, "", IMG);

  const history = sessions[p].history;
  assert.ok(history.length > 0, "היסטוריה נשמרה");
  assert.ok(
    history.every(h => typeof h.content === "string" && h.content.trim().length > 0),
    `הודעה ריקה נכנסה להיסטוריה → 400 מ-Claude בכל הודעה הבאה: ${JSON.stringify(history)}`
  );

  // ההודעה הבאה חייבת עדיין לעבוד (זה מה שנשבר בשטח)
  sent.length = 0;
  aiReply = "ארוחת הבוקר מוגשת 07:00–11:00 🍳";
  await bot.handleIncoming(p, "מתי ארוחת בוקר?");
  assert.match(lastBody(), /07:00/);
});

// ════════════════════════════════════════════════════════
//  בעיה 3 + 9 — אימות קלט
// ════════════════════════════════════════════════════════
test("בעיה 3: מספר הזמנה עם טקסט חופשי נדחה — השלב נשמר, לא מתחילים מהתחלה", async () => {
  const p = await checkinUpTo("waiting_reservation");
  sent.length = 0;

  // בדיוק הקלט מהבדיקה החיה
  await bot.handleIncoming(p, "10\nיותר נוח לי בעברית");

  assert.ok(!allBodies().includes("10 יותר"), `מספר הזמנה קיבל טקסט חופשי: ${allBodies()}`);
  assert.ok(!/שמך המלא/.test(allBodies()), "אסור לחזור לשלב השם");
});

test("בעיה 3: שם מלא לא מקבל מספרים — מבקש שוב באותו שלב", async () => {
  const p = await checkinUpTo("waiting_name");
  sent.length = 0;

  await bot.handleIncoming(p, "12345");
  assert.match(lastBody(), /שם/, "אמור לבקש שוב את השם");

  await bot.handleIncoming(p, "אופק כהן");
  assert.match(lastBody(), /מספר ההזמנה/, "אחרי שם תקין — ממשיכים לשלב הבא");
});

test("בעיה 3: תעודת זהות חייבת להיות תמונה — טקסט מבקש שוב", async () => {
  const p = await checkinUpTo("waiting_id");
  sent.length = 0;

  await bot.handleIncoming(p, "אין לי עכשיו");
  assert.match(lastBody(), /תמונה|תעודת/, "אמור לבקש שוב תמונה");
  assert.ok(!/פיקדון/.test(lastBody()), "אסור להתקדם לפיקדון בלי תמונה");
});

// ════════════════════════════════════════════════════════
//  בעיה 4 + 5 + 6 — שפה
// ════════════════════════════════════════════════════════
test("בעיה 4: בקשה לעברית → מעבר מיידי בלי תירוץ ובלי AI", async () => {
  const p = freshGuest();
  await bot.handleIncoming(p, "hello");
  sent.length = 0;
  aiCalls = 0;

  await bot.handleIncoming(p, "can you speak to me in Hebrew?");

  assert.equal(aiCalls, 0, "בקשת שפה טהורה לא צריכה לעבור ב-AI (שם נולדו התירוצים)");
  assert.match(lastBody(), /[֐-׿]/, "התשובה חייבת להיות בעברית");
  assert.ok(!/[A-Za-z]{4,}/.test(lastBody()), `ערבוב שפות: ${lastBody()}`);
});

test("בעיה 5: מעבר לעברית בשלב הפיקדון → אותו שלב נשלח מחדש בעברית, לא מתחילים מהתחלה", async () => {
  const p = await checkinUpTo("waiting_payment", { lang: "en" });
  sent.length = 0;

  await bot.handleIncoming(p, "אפשר בעברית בבקשה?");

  assert.match(lastBody(), /פיקדון/, "השלב הנוכחי (פיקדון) חייב להישלח מחדש בעברית");
  assert.match(lastBody(), /http/, "כולל קישור התשלום");
  assert.ok(!/full name|שמך המלא/i.test(allBodies()), "אסור לחזור לשלב השם");
});

test("בעיה 5: מעבר שפה + קלט באותה הודעה → מחליף שפה וגם מתקדם", async () => {
  const p = await checkinUpTo("waiting_reservation", { lang: "en" });
  sent.length = 0;

  // "10" + בקשת שפה יחד — התרחיש מהבדיקה החיה
  await bot.handleIncoming(p, "10\nיותר נוח לי בעברית");

  assert.match(lastBody(), /הזמנה מספר 10 אותרה/, `אמור לקלוט 10 ולהתקדם בעברית: ${lastBody()}`);
  assert.ok(!lastBody().includes("יותר נוח"), "טקסט חופשי לא נכנס למספר ההזמנה");
});

test("בעיה 6: אחרי מעבר לעברית — שלב הזהות נשלח בעברית בלבד", async () => {
  const p = await checkinUpTo("waiting_reservation", { lang: "en" });
  await bot.handleIncoming(p, "בעברית");
  sent.length = 0;

  await bot.handleIncoming(p, "1234");
  assert.match(lastBody(), /תעודת הזהות|הדרכון/, "השלב הבא בעברית");
  assert.ok(!/please|photo|Reservation/i.test(lastBody()), `ערבוב שפות: ${lastBody()}`);
});

// ════════════════════════════════════════════════════════
//  בעיה 7 + 8 — תעודת זהות
// ════════════════════════════════════════════════════════
test("בעיה 7: תמונה שאינה תעודה נדחית — לא 'אומתה בהצלחה'", async () => {
  const p = await checkinUpTo("waiting_id");
  sent.length = 0;

  idResult = { success: false, status: "rejected", documentId: null, documentType: "other",
               storedPath: null, reasonHe: "התמונה נראית כמו נוף, לא כמו תעודה.", reasonEn: "" };
  await bot.handleIncoming(p, "", IMG);
  idResult = { success: true, status: "verified", documentId: "d1", documentType: "id_card", storedPath: "/demo/id.jpg", reasonHe: "", reasonEn: "" };

  assert.ok(!/אומתה בהצלחה/.test(allBodies()), `תמונה מזויפת אושרה: ${allBodies()}`);
  assert.ok(!/פיקדון/.test(allBodies()), "אסור להתקדם לפיקדון עם תמונה שנדחתה");
  assert.match(lastBody(), /נוף|תעודת/, "הסבר מנומס + בקשה חוזרת");
});

test("בעיה 7: אחרי דחייה — התמונה הנכונה ממשיכה כרגיל (השלב לא אבד)", async () => {
  const p = await checkinUpTo("waiting_id");

  idResult = { success: false, status: "rejected", documentType: "other", storedPath: null,
               reasonHe: "לא תעודה.", reasonEn: "" };
  await bot.handleIncoming(p, "", IMG);
  idResult = { success: true, status: "verified", documentId: "d1", documentType: "id_card", storedPath: "/demo/id.jpg", reasonHe: "", reasonEn: "" };
  sent.length = 0;
  await bot.handleIncoming(p, "", IMG);

  assert.match(allBodies(), /אומתה בהצלחה/);
  assert.match(allBodies(), /פיקדון/);
});

test("בעיה 8: אימות מוצלח → התראה לקבלה עם שם האורח + מיקום המסמך", async () => {
  const p = await checkinUpTo("waiting_id");
  sent.length = 0;
  await bot.handleIncoming(p, "", IMG);

  const staff = sent.filter(s => s.to !== p);
  assert.ok(staff.length > 0, "הקבלה חייבת לקבל התראה");
  const msg = staff.map(s => s.body).join("\n");
  assert.match(msg, /אופק כהן/, "כולל שם אורח");
  assert.match(msg, /אימות זהות הושלם/);
  assert.match(msg, /demo\/id\.jpg/, "כולל היכן נשמר המסמך");
});

test("בעיה 7: תקלה טכנית בבדיקה → לא מכריזים 'אומת', אבל הזרימה ממשיכה", async () => {
  const p = await checkinUpTo("waiting_id");
  sent.length = 0;

  idResult = { success: true, status: "manual_review", documentId: "d2", documentType: "id",
               storedPath: "/demo/x.jpg", reasonHe: "", reasonEn: "" };
  await bot.handleIncoming(p, "", IMG);
  idResult = { success: true, status: "verified", documentId: "d1", documentType: "id_card", storedPath: "/demo/id.jpg", reasonHe: "", reasonEn: "" };

  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.ok(!/אומתה בהצלחה/.test(guest), "אסור להכריז 'אומת' כשלא נבדק");
  assert.match(guest, /פיקדון/, "הזרימה ממשיכה — האורח לא נתקע");
});

test("בעיה 7: תקלה בהורדת התמונה → מבקשים לשלוח שוב, בלי להכריז 'אומת'", async () => {
  const p = await checkinUpTo("waiting_id");
  sent.length = 0;

  const saved = idResult;
  idResult = { success: false, status: "retry", documentType: "id", storedPath: null,
               reasonHe: "לא הצלחתי לפתוח את התמונה. אפשר לשלוח אותה שוב?", reasonEn: "" };
  await bot.handleIncoming(p, "", IMG);

  assert.match(lastBody(), /לפתוח את התמונה/, "מבקש לשלוח שוב");
  assert.ok(!/אומתה בהצלחה|פיקדון/.test(allBodies()), "לא מתקדמים ולא מכריזים על אימות");

  // אחרי 3 ניסיונות כושלים — לא מענישים את האורח: ממשיכים, הקבלה תשלים.
  await bot.handleIncoming(p, "", IMG);
  await bot.handleIncoming(p, "", IMG);
  idResult = saved;

  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(guest, /פיקדון/, "האורח לא נשאר תקוע בגלל תקלה שלנו");
  assert.ok(!/אומתה בהצלחה/.test(guest), "עדיין לא מכריזים 'אומת'");
});

// ניקוי קובץ ה-DB הזמני
process.on("exit", () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* ignore */ }
  }
});
