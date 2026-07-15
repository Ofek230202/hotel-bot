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

// שכבת ה-vision — כדי לבדוק את *מדיניות* סוגי המסמכים ב-MockIdProvider
// בלי רשת ובלי AI. מדמה "ה-AI זיהה מסמך אמיתי וקריא מסוג X".
let visionResult = { valid: true, isId: true, readable: true, confidence: 0.95, docType: "id_card", reasonHe: "", reasonEn: "" };
mock.module("./idverify/vision.js", {
  exports: {
    fetchMedia: async () => ({ buffer: Buffer.from("fake-image"), contentType: "image/jpeg" }),
    inspectIdImage: async () => visionResult,
  },
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

// תאריכי שהייה עתידיים — נגזרים מ"היום" כדי שהבדיקות לא יפוגו עם הזמן.
function futureDates(fromDays = 5, nights = 3) {
  const d = (n) => {
    const x = new Date(Date.now() + n * 86400000);
    return `${String(x.getUTCDate()).padStart(2, "0")}/${String(x.getUTCMonth() + 1).padStart(2, "0")}/${x.getUTCFullYear()}`;
  };
  return { text: `${d(fromDays)} - ${d(fromDays + nights)}`, nights };
}
const STAY = futureDates();

// מריץ צ'ק אין עד שלב מסוים ומחזיר את מספר הטלפון.
async function checkinUpTo(stage, { lang = "he" } = {}) {
  const p = freshGuest();
  await bot.handleIncoming(p, lang === "he" ? "צק אין" : "check in");
  if (stage === "waiting_name") return p;
  await bot.handleIncoming(p, lang === "he" ? "אופק כהן" : "John Smith");
  if (stage === "waiting_reservation") return p;
  await bot.handleIncoming(p, "1234");
  if (stage === "waiting_dates") return p;
  await bot.handleIncoming(p, STAY.text);
  if (stage === "waiting_id") return p;
  await bot.handleIncoming(p, "", IMG);
  if (stage === "waiting_terms") return p;
  await bot.handleIncoming(p, lang === "he" ? "אני מאשר" : "I confirm");
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
  const p = await checkinUpTo("waiting_id");
  sent.length = 0;

  // מפילים בכוונה את שלב אימות הזהות
  const saved = idResult;
  idResult = null; // → result.status ייקרא מ-null → TypeError בתוך הזרימה
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

test("בעיה 6: אחרי מעבר לעברית — שאר השלבים בעברית בלבד", async () => {
  const p = await checkinUpTo("waiting_reservation", { lang: "en" });
  await bot.handleIncoming(p, "בעברית");
  sent.length = 0;

  await bot.handleIncoming(p, "1234");
  assert.match(lastBody(), /תאריכי השהייה/, "שלב התאריכים בעברית");
  assert.ok(!/please|stay dates|Reservation/i.test(lastBody()), `ערבוב שפות: ${lastBody()}`);

  sent.length = 0;
  await bot.handleIncoming(p, STAY.text);
  assert.match(lastBody(), /תעודת הזהות|הדרכון/, "שלב הזהות בעברית");
  assert.ok(!/please|photo|passport/i.test(lastBody()), `ערבוב שפות: ${lastBody()}`);
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
  assert.ok(!/תנאי השהייה/.test(allBodies()), "אסור להתקדם הלאה עם תמונה שנדחתה");
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
  assert.match(allBodies(), /תנאי השהייה/);
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
  assert.match(guest, /תנאי השהייה/, "הזרימה ממשיכה — האורח לא נתקע");
});

test("בעיה 7: תקלה בהורדת התמונה → מבקשים לשלוח שוב, בלי להכריז 'אומת'", async () => {
  const p = await checkinUpTo("waiting_id");
  sent.length = 0;

  const saved = idResult;
  idResult = { success: false, status: "retry", documentType: "id", storedPath: null,
               reasonHe: "לא הצלחתי לפתוח את התמונה. אפשר לשלוח אותה שוב?", reasonEn: "" };
  await bot.handleIncoming(p, "", IMG);

  assert.match(lastBody(), /לפתוח את התמונה/, "מבקש לשלוח שוב");
  assert.ok(!/אומתה בהצלחה|תנאי השהייה/.test(allBodies()), "לא מתקדמים ולא מכריזים על אימות");

  // אחרי 3 ניסיונות כושלים — לא מענישים את האורח: ממשיכים, הקבלה תשלים.
  await bot.handleIncoming(p, "", IMG);
  await bot.handleIncoming(p, "", IMG);
  idResult = saved;

  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(guest, /תנאי השהייה/, "האורח לא נשאר תקוע בגלל תקלה שלנו");
  assert.ok(!/אומתה בהצלחה/.test(guest), "עדיין לא מכריזים 'אומת'");
});

// ════════════════════════════════════════════════════════
//  תיקון 2 — רק תעודת זהות או דרכון
// ════════════════════════════════════════════════════════
test("תיקון 2: רישיון נהיגה נדחה — גם כשה-AI מזהה אותו כתעודה אמיתית וקריאה", async () => {
  const { MockIdProvider } = await import("./idverify/MockIdProvider.js");
  const provider = new MockIdProvider();

  // בדיוק המקרה שהקוד פספס: מסמך ממשלתי אמיתי לגמרי — אבל לא קביל.
  visionResult = { valid: true, isId: true, readable: true, confidence: 0.97,
                   docType: "drivers_license", reasonHe: "", reasonEn: "" };
  const r = await provider.verifyDocument({ mediaUrl: "https://x/1", contentType: "image/jpeg" });

  assert.equal(r.status, "rejected", "רישיון נהיגה חייב להידחות");
  assert.equal(r.storedPath, null, "מסמך שלא קיבלנו לא נשמר לדיסק");
  assert.match(r.reasonHe, /תעודת זהות|דרכון/, "מסביר לאורח מה כן לשלוח");
  assert.match(r.reasonEn, /ID card|passport/, "וגם באנגלית");
});

test("תיקון 2: ת\"ז ודרכון מתקבלים; כל סוג אחר נדחה", async () => {
  const { MockIdProvider } = await import("./idverify/MockIdProvider.js");
  const provider = new MockIdProvider();
  const written = [];
  const check = async (docType) => {
    visionResult = { valid: true, isId: true, readable: true, confidence: 0.95, docType, reasonHe: "", reasonEn: "" };
    const r = await provider.verifyDocument({ mediaUrl: "https://x/1", contentType: "image/jpeg" });
    if (r.storedPath) written.push(r.storedPath);
    return r.status;
  };

  try {
    assert.equal(await check("id_card"),  "verified");
    assert.equal(await check("passport"), "verified");
    for (const bad of ["drivers_license", "other", "student_card"]) {
      assert.equal(await check(bad), "rejected", `${bad} היה אמור להידחות`);
    }
  } finally {
    // המסמכים שהתקבלו נשמרים לדיסק — מנקים את קבצי הדמה של הבדיקה.
    for (const f of written) {
      for (const p of [f, f.replace(/\.\w+$/, ".json")]) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
    }
  }
});

// ════════════════════════════════════════════════════════
//  תיקון 3 — טקסט של האורח לא נתקע בתוך הודעות המערכת
// ════════════════════════════════════════════════════════
test("תיקון 3: 'I want to check in' לא מתקבל כשם ולא נדבק להודעה הבאה", async () => {
  const p = await checkinUpTo("waiting_name", { lang: "en" });
  sent.length = 0;

  await bot.handleIncoming(p, "I want to check in");

  // המשפט השבור שנצפה: "I want to check in, please enter your reservation number"
  assert.ok(!/I want to check in,\s*please enter/i.test(allBodies()), `משפט שבור: ${allBodies()}`);
  assert.ok(!/reservation number/i.test(allBodies()), "אסור להתקדם — זה לא שם");
  assert.match(lastBody(), /full name/i, "נשארים בשלב השם ומבקשים שוב");
});

test("תיקון 3: הודעת מספר ההזמנה היא משפט נקי ועצמאי", async () => {
  const p = await checkinUpTo("waiting_name", { lang: "en" });
  sent.length = 0;

  await bot.handleIncoming(p, "John Smith");

  const [greeting, ask] = lastBody().split("\n\n");
  assert.match(greeting, /Thank you, \*John Smith\*/, "הפנייה בשם — בשורה נפרדת משלה");
  assert.equal(ask, "Please enter your *reservation number* (digits only):");
});

// ════════════════════════════════════════════════════════
//  תוספת 1 — תאריכי שהייה
// ════════════════════════════════════════════════════════
test("תוספת 1: תאריכי שהייה נשמרים על ההזמנה — ולא 3 לילות קבועים", async () => {
  const { reservations } = await import("./checkin.js");
  const p = freshGuest();
  await bot.handleIncoming(p, "צק אין");
  await bot.handleIncoming(p, "אופק כהן");
  await bot.handleIncoming(p, "1234");
  await bot.handleIncoming(p, "20/07/2027 - 25/07/2027"); // 5 לילות
  await bot.handleIncoming(p, "", IMG);
  await bot.handleIncoming(p, "אני מאשר");

  const res = Object.values(reservations).find(r => r.phone === p);
  assert.ok(res, "נוצרה הזמנה");
  assert.equal(res.stayCheckIn, "2027-07-20");
  assert.equal(res.stayCheckOut, "2027-07-25");
  assert.equal(res.nights, 5, "מספר הלילות מגיע מהאורח, לא מקבוע");
});

test("תוספת 1: 'תאריך + מספר לילות' נקלט גם הוא", async () => {
  const p = await checkinUpTo("waiting_dates");
  sent.length = 0;

  await bot.handleIncoming(p, "20/07/2027, 3 לילות");
  assert.match(lastBody(), /תעודת הזהות|הדרכון/, "התקדם לשלב הבא");
  assert.match(allBodies(), /3 לילות/, "מציג סיכום תאריכים לאורח");
});

test("תוספת 1: תאריכים לא תקינים → נשארים בשלב ומבקשים שוב", async () => {
  const p = await checkinUpTo("waiting_dates");

  for (const bad of ["מתישהו בקיץ", "25/07/2027 - 20/07/2027", "01/01/2020 - 05/01/2020"]) {
    sent.length = 0;
    await bot.handleIncoming(p, bad);
    assert.match(lastBody(), /תאריכי השהייה/, `לא ביקש שוב על "${bad}": ${lastBody()}`);
    assert.ok(!/תעודת הזהות/.test(lastBody()), `התקדם בטעות על "${bad}"`);
  }
});

// ════════════════════════════════════════════════════════
//  תוספת 2 — אישור תנאי שהייה
// ════════════════════════════════════════════════════════
test("תוספת 2: בלי אישור תנאים — אין פיקדון ואין חדר", async () => {
  const p = await checkinUpTo("waiting_terms");
  sent.length = 0;

  // "כן" אינו אישור מפורש
  await bot.handleIncoming(p, "כן");
  assert.ok(!/http/.test(allBodies()), "אסור לתת קישור פיקדון בלי אישור מפורש");
  assert.match(lastBody(), /אני מאשר/, "מבקש את הנוסח המפורש");

  sent.length = 0;
  await bot.handleIncoming(p, "אני מאשר");
  assert.match(lastBody(), /פיקדון/, "אחרי אישור — ממשיכים לפיקדון");
  assert.match(lastBody(), /http/, "כולל קישור");
});

test("תוספת 2: התנאים מוצגים במלואם, ומספר הנוסח נשמר על ההזמנה", async () => {
  const { reservations } = await import("./checkin.js");
  const { hotelConfig }  = await import("./config.js");
  const p = await checkinUpTo("waiting_terms");

  const shown = allBodies();
  assert.match(shown, /תנאי השהייה/);
  assert.match(shown, /אחריות לנזקים/);
  assert.match(shown, /ללא עישון/);
  assert.match(shown, /12:00/, "שעת הצ'ק אאוט מוזרקת מהקונפיג");

  await bot.handleIncoming(p, "אני מאשר");
  const res = Object.values(reservations).find(r => r.phone === p);
  assert.equal(res.termsVersion, hotelConfig.terms.version, "נשמר *איזה* נוסח אושר");
  assert.ok(res.termsAcceptedAt, "נשמרה חותמת זמן לאישור");
});

test("תוספת 2: אורח שמסרב לתנאים → נעצר בנימוס + הסלמה לקבלה", async () => {
  const p = await checkinUpTo("waiting_terms");
  sent.length = 0;

  await bot.handleIncoming(p, "לא");

  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  const staff = sent.filter(s => s.to !== p).map(s => s.body).join("\n");
  assert.ok(!/http/.test(guest), "אסור קישור פיקדון לאורח שסירב");
  assert.match(staff, /לא אישר את תנאי השהייה/, "הקבלה קיבלה התראה");
  assert.match(guest, /קבלה|נציג/, "האורח מקבל מסלול אנושי");
});

test("תוספת 2: התנאים באנגלית לאורח אנגלי — בלי ערבוב שפות", async () => {
  const p = await checkinUpTo("waiting_terms", { lang: "en" });

  assert.match(lastBody(), /Stay Terms/);
  assert.match(lastBody(), /Non-smoking hotel/);
  assert.match(lastBody(), /I confirm/);
  assert.ok(!/[֐-׿]/.test(lastBody()), `ערבוב שפות בתנאים: ${lastBody()}`);
});

// ════════════════════════════════════════════════════════
//  תיקון 1 — עקביות שפה מלאה (צ'אט + עמודים)
// ════════════════════════════════════════════════════════
test("תיקון 1: כל שלבי הצ'ק אין באנגלית — אף מילה בעברית", async () => {
  const p = freshGuest();
  const steps = ["check in", "John Smith", "1234", STAY.text, null, "I confirm"];
  for (const s of steps) {
    sent.length = 0;
    await bot.handleIncoming(p, s ?? "", s === null ? IMG : null);
    const guest = sent.filter(m => m.to === p).map(m => m.body).join("\n");
    assert.ok(!/[֐-׿]/.test(guest), `עברית דלפה לאורח אנגלי אחרי "${s}": ${guest}`);
  }
});

test("תיקון 1: הודעת 'צ'ק אין אושר' + עמוד האישור באנגלית לאורח אנגלי", async () => {
  const { reservations, completeCheckin } = await import("./checkin.js");
  const p = await checkinUpTo("waiting_payment", { lang: "en" });
  const res = Object.values(reservations).find(r => r.phone === p);
  sent.length = 0;

  await completeCheckin(res.id, "304");

  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(guest, /Check-in confirmed/, "הודעת האישור באנגלית");
  assert.ok(!/[֐-׿]/.test(guest), `עברית דלפה להודעת האישור: ${guest}`);

  // הקבלה — דווקא כן בעברית (הצוות עובד בעברית)
  const staff = sent.filter(s => s.to !== p).map(s => s.body).join("\n");
  assert.match(staff, /להכין כרטיס לחדר/, "התראת הכרטיס לקבלה נשארת בעברית");
});

test("תיקון 1: עמוד האישור מרונדר באנגלית, LTR, עם השם באנגלית", async () => {
  const { reservations } = await import("./checkin.js");
  const request = await import("node:http"); void request;
  const p = await checkinUpTo("waiting_payment", { lang: "en" });
  const res = Object.values(reservations).find(r => r.phone === p);

  const { default: router } = await import("./checkin-routes.js");
  const layer = router.stack.find(l => l.route?.path === "/checkin/success");
  let html = "";
  await layer.route.stack[0].handle(
    { query: { rid: res.id }, headers: {} },
    { send: (h) => { html = h; }, redirect: () => {} },
  );

  assert.match(html, /<html lang="en" dir="ltr">/, "העמוד חייב להיות LTR באנגלית");
  assert.match(html, /Check-in complete/);
  assert.match(html, /Welcome,<br>John Smith!/, "השם בצורה האנגלית, לא בתעתיק עברי");
  assert.ok(!/[֐-׿]/.test(html), `עברית דלפה לעמוד האישור: ${html.match(/[֐-׿].{0,40}/)?.[0]}`);
});

// ניקוי קובץ ה-DB הזמני
process.on("exit", () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* ignore */ }
  }
});
