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
let aiParams = null;        // הפרמטרים של הקריאה האחרונה — כולל ה-system prompt

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

// aiScript — פונקציה אופציונלית(params, callIndex) שמחזירה תשובת AI
// מלאה (כולל tool_use). מאפשר לבדוק את לולאת הכלי: קריאה ראשונה מחזירה
// בקשת חיפוש, השנייה מנסחת תשובה. null → התנהגות ברירת המחדל (טקסט aiReply).
let aiScript = null;
mock.module("@anthropic-ai/sdk", {
  exports: {
    default: class Anthropic {
      messages = {
        create: async (params) => {
          const idx = aiCalls;
          aiCalls++;
          aiParams = params;
          if (aiScript) {
            const scripted = aiScript(params, idx);
            if (scripted) return scripted;
          }
          return { content: [{ type: "text", text: aiReply }] };
        },
      };
    },
  },
});

// ── places/ — שכבת חיפוש המקומות (נשלטת מהבדיקה, בלי רשת/מפתח) ──
let placesResult = { ok: true, provider: "mock", results: [] };
let placesCalls  = [];
mock.module("./places/index.js", {
  exports: {
    places: { searchNearby: async (p) => { placesCalls.push(p); return placesResult; } },
    placesLive: false,
    PLACE_CATEGORIES: Object.freeze({
      restaurant: "restaurant", cafe: "cafe", bar: "bar", bakery: "bakery",
      attraction: "tourist_attraction", museum: "museum", park: "park",
      nightlife: "night_club", shopping: "shopping_mall", store: "store",
      spa: "spa", pharmacy: "pharmacy",
    }),
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

// כל בדיקה מתחילה נקייה — כולל תשובת ה-AI. בלי איפוס aiReply, תשובה
// שנשארה מבדיקה קודמת "נדלקת" בבדיקה הבאה: תג [CONCIERGE:...] שדלף כך
// שלח התראות רפאים לצוות באמצע בדיקות אחרות.
beforeEach(() => {
  sent.length = 0; aiCalls = 0; aiParams = null; aiReply = "שלום!";
  aiScript = null;
  placesCalls = [];
  placesResult = { ok: true, provider: "mock", results: [] };
});

const lastBody  = () => sent.at(-1)?.body ?? "";
const allBodies = () => sent.map(s => s.body).join("\n---\n");

// ה-system prompt שנשלח ל-Claude בקריאה האחרונה — כאן נבדק שהמידע
// המובנה מה-config מגיע ל-AI שלם ומתויג.
const lastSystem = () => aiParams?.system ?? "";
async function askConcierge(question) {
  const p = freshGuest();
  await bot.handleIncoming(p, question);
  return lastSystem();
}
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
  if (stage === "waiting_dates_confirm") return p;
  // התאריכים תמיד מאושרים מול האורח לפני שממשיכים (באג התאריכים).
  await bot.handleIncoming(p, lang === "he" ? "כן" : "yes");
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

// ── התקלה שנצפתה: "[CONCIERGE:restaurant|" הגיע לאורח ──────
// שורש הבעיה: ה-AI נקטע באמצע כתיבת התג (max_tokens) ולכן לא נכתב "]"
// סוגר — והרגקס שסינן תגים דרש סוגר. התג לא סונן *וגם* הבקשה לא הועברה
// לאף אחד. שתי התוצאות נבדקות כאן.
test("דליפת תג: תג קטוע ('[CONCIERGE:restaurant|') לא מגיע לאורח", async () => {
  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  sent.length = 0;

  aiReply = "אשמח לסדר לך שולחן! [CONCIERGE:restaurant|";
  await bot.handleIncoming(p, "אפשר שולחן לשניים במסעדה?");

  const guestMsgs = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.ok(!guestMsgs.includes("[CONCIERGE"), `תג קטוע דלף לאורח: ${guestMsgs}`);
  assert.ok(!guestMsgs.includes("["), `סוגר מרובע דלף לאורח: ${guestMsgs}`);
  assert.match(guestMsgs, /אשמח לסדר/, "הטקסט האמיתי כן נשלח");
});

test("דליפת תג: בקשה בתג קטוע עדיין מגיעה לאדם — לא נעלמת בשקט", async () => {
  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  sent.length = 0;

  aiReply = "אשמח לסדר! [CONCIERGE:restaurant|שולחן ל-2 במסעדת ים";
  await bot.handleIncoming(p, "אפשר שולחן לשניים?");

  // הצוות מקבל את מה שנאסף, מסומן במפורש כבקשה חלקית לטיפול אנושי.
  const staffMsgs = sent.filter(s => s.to !== p).map(s => s.body).join("\n");
  assert.match(staffMsgs, /שולחן ל-2/, `הבקשה לא הועברה לצוות: ${staffMsgs}`);
  assert.match(staffMsgs, /נקטעה/, "הצוות חייב לדעת שהפרטים חלקיים");
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
  assert.match(lastBody(), /נכון\?/, "אישור התאריכים בעברית");
  assert.ok(!/correct|arrival|departure/i.test(lastBody()), `ערבוב שפות: ${lastBody()}`);

  sent.length = 0;
  await bot.handleIncoming(p, "כן");
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
  assert.equal(ask, "And what is your *reservation number*? (digits only)");
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
  await bot.handleIncoming(p, "כן");                      // אישור התאריכים
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
  assert.match(lastBody(), /נכון\?/, "מבקש אישור על התאריכים שהובנו");
  assert.match(allBodies(), /3 לילות/, "מציג סיכום תאריכים לאורח");

  await bot.handleIncoming(p, "כן");
  assert.match(lastBody(), /תעודת הזהות|הדרכון/, "אחרי אישור — ממשיך לשלב הבא");
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
//  באג התאריכים — "4 לילות עד ה-21/7" הובן הפוך
//  ----------------------------------------------------------
//  התקלה מהבדיקה החיה: הבוט הבין הגעה 21/7 ועזיבה 25/7, במקום
//  עזיבה 21/7 והגעה 17/7. תאריך שגוי = כרטיס חדר לימים הלא נכונים.
//  ה"עד" שלפני התאריך הוא כל ההבדל, ולכן הוא נבדק כאן ישירות.
// ════════════════════════════════════════════════════════
test("באג תאריכים: '4 לילות עד ה-21/7' = עזיבה 21/7, הגעה 17/7", async () => {
  const { validateStayDates } = await import("./validate.js");
  const now = new Date("2026-07-15T09:00:00Z");

  const v = validateStayDates("4 לילות עד ה-21/7", now);
  assert.ok(v.ok, `נדחה: ${v.reason}`);
  assert.equal(v.value.checkOut, "2026-07-21", "התאריך שאחרי 'עד' הוא העזיבה");
  assert.equal(v.value.checkIn,  "2026-07-17", "ההגעה מחושבת 4 לילות אחורה");
  assert.equal(v.value.nights, 4);
});

test("באג תאריכים: כל הניסוחים — עברית ואנגלית, ספרות ומילים", async () => {
  const { validateStayDates } = await import("./validate.js");
  const now = new Date("2026-07-15T09:00:00Z");

  const cases = [
    // [קלט, הגעה, עזיבה, לילות]
    ["4 לילות עד ה-21/7",        "2026-07-17", "2026-07-21", 4],
    ["4 לילות עד 21/7",          "2026-07-17", "2026-07-21", 4],
    ["עד ה-21/7, 4 לילות",       "2026-07-17", "2026-07-21", 4],
    ["3 nights until 21/7",      "2026-07-18", "2026-07-21", 3],
    ["4 nights to 21/07/2026",   "2026-07-17", "2026-07-21", 4],
    ["לילה אחד עד 21/7",         "2026-07-20", "2026-07-21", 1],
    ["אני עוזב ב-21/7, 4 לילות", "2026-07-17", "2026-07-21", 4],
    // ניסוחי הגעה — לא נגעו בהם, ואסור שיישברו
    ["מ-20/7 ל-23/7",            "2026-07-20", "2026-07-23", 3],
    ["20/7 - 23/7",              "2026-07-20", "2026-07-23", 3],
    ["20/7, 3 לילות",            "2026-07-20", "2026-07-23", 3],
    ["20/07/2026 - 23/07/2026",  "2026-07-20", "2026-07-23", 3],
    ["from 20/7 until 23/7",     "2026-07-20", "2026-07-23", 3],
    ["20/7 עד 23/7",             "2026-07-20", "2026-07-23", 3],
    ["היום, 2 לילות",            "2026-07-15", "2026-07-17", 2],
    ["tomorrow until 23/07",     "2026-07-16", "2026-07-23", 7],
  ];

  for (const [text, checkIn, checkOut, nights] of cases) {
    const v = validateStayDates(text, now);
    assert.ok(v.ok, `"${text}" נדחה: ${v.reason}`);
    assert.deepEqual(
      { checkIn: v.value.checkIn, checkOut: v.value.checkOut, nights: v.value.nights },
      { checkIn, checkOut, nights },
      `"${text}" הובן לא נכון`,
    );
  }
});

test("באג תאריכים: קלט סותר או דו-משמעי → נדחה, לא מנוחש", async () => {
  const { validateStayDates } = await import("./validate.js");
  const now = new Date("2026-07-15T09:00:00Z");

  // מספר לילות שלא מסתדר עם התאריכים — סתירה אמיתית, לא בוחרים צד.
  assert.equal(validateStayDates("20/7 - 23/7, 5 לילות", now).reason, "conflict");
  // שלושה תאריכים — אין דרך לדעת מה מה.
  assert.equal(validateStayDates("20/7 21/7 23/7", now).reason, "ambiguous");
  // שני תאריכים שסומנו שניהם כהגעה.
  assert.equal(validateStayDates("מ-20/7 מ-23/7", now).reason, "ambiguous");
  // "עד" שמייצר הגעה בעבר — נדחה במקום להיקלט.
  assert.equal(validateStayDates("4 לילות עד ה-16/7", now).reason, "past");
});

test("באג תאריכים: התרחיש המדויק מהבדיקה החיה — מקצה לקצה דרך הצ'אט", async () => {
  const { reservations } = await import("./checkin.js");
  const ymd = (d) => d.toISOString().slice(0, 10);
  const dm  = (d) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

  // עזיבה בעוד 10 ימים, 4 לילות → ההגעה חייבת לצאת בעוד 6 ימים.
  const out = new Date(Date.now() + 10 * 86400000);
  const inn = new Date(out.getTime() - 4 * 86400000);

  const p = await checkinUpTo("waiting_dates");
  await bot.handleIncoming(p, `4 לילות עד ה-${dm(out)}`);
  await bot.handleIncoming(p, "כן");
  await bot.handleIncoming(p, "", IMG);
  await bot.handleIncoming(p, "אני מאשר");

  const res = Object.values(reservations).find(r => r.phone === p);
  assert.ok(res, "נוצרה הזמנה");
  assert.equal(res.stayCheckOut, ymd(out), "'עד ה-X' = תאריך העזיבה");
  assert.equal(res.stayCheckIn,  ymd(inn), "ההגעה מחושבת אחורה — לא זהה לתאריך שנמסר");
  assert.equal(res.nights, 4);
});

test("באג תאריכים: הבוט מוודא מול האורח לפני שממשיך", async () => {
  const p = await checkinUpTo("waiting_dates");
  sent.length = 0;

  await bot.handleIncoming(p, "20/07/2027 - 23/07/2027");
  // חייב להציג את שני התאריכים במפורש ולשאול — לא להתקדם בשקט.
  assert.match(lastBody(), /נכון\?/, `לא ביקש אישור: ${lastBody()}`);
  assert.match(lastBody(), /20/, "מציג את תאריך ההגעה");
  assert.match(lastBody(), /23/, "מציג את תאריך העזיבה");
  assert.ok(!/תעודת הזהות/.test(lastBody()), "אסור להתקדם לפני אישור");

  // "לא" → חוזרים לשאול, בלי להתקדם
  sent.length = 0;
  await bot.handleIncoming(p, "לא");
  assert.match(lastBody(), /תאריכי השהייה/, "חזר לשאלת התאריכים");

  // תיקון ישיר בתאריכים חדשים → מאשרים מחדש את החדשים
  sent.length = 0;
  await bot.handleIncoming(p, "20/07/2027, 3 לילות");
  assert.match(lastBody(), /נכון\?/, "מבקש אישור על התאריכים המתוקנים");
});

// ════════════════════════════════════════════════════════
//  ניסוח הפיקדון — אסור להבטיח החזר שאינו בטוח
//  ----------------------------------------------------------
//  "היתרה תשוחרר" יוצר ציפייה שגויה: כשהחיובים גבוהים מהפיקדון אין
//  שום יתרה, ולהפך — המלון מחייב את ההפרש. שלושת המקרים חייבים
//  להיאמר במפורש, גם בהסבר וגם בתנאי השהייה שהאורח מאשר.
// ════════════════════════════════════════════════════════
test("פיקדון: ההסבר מכסה את שלושת המקרים, בשתי השפות", async () => {
  const { depositExplainer } = await import("./checkin.js");

  const he = depositExplainer("he");
  assert.match(he, /אין חיובים/,          "מקרה א' — אין חיובים");
  assert.match(he, /ינוכו מהפיקדון/,      "מקרה ב' — החיובים מנוכים");
  assert.match(he, /גדולים מהפיקדון/,     "מקרה ג' — חיובים מעל הפיקדון");
  assert.match(he, /ההפרש יחויב/,         "מקרה ג' — ההפרש מחויב בנפרד");

  const en = depositExplainer("en");
  assert.match(en, /no charges/i);
  assert.match(en, /deducted from the deposit/i);
  assert.match(en, /exceed the deposit/i);
});

test("פיקדון: תנאי השהייה לא מבטיחים יתרה שלא בטוח שקיימת", async () => {
  const { hotelConfig } = await import("./config.js");

  for (const lang of ["he", "en"]) {
    const clause = hotelConfig.terms[lang].find(t => /פיקדון|Deposit/i.test(t.title));
    assert.ok(clause, `לא נמצא סעיף פיקדון ב-${lang}`);
    // הסעיף חייב לכסות גם את המקרה שבו החיובים עולים על הפיקדון.
    assert.match(
      clause.body,
      lang === "he" ? /גבוהים מהפיקדון/ : /exceed the deposit/i,
      `סעיף הפיקדון ב-${lang} לא מזכיר חיובים מעל הפיקדון: ${clause.body}`,
    );
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

// ════════════════════════════════════════════════════════
//  מידע מובנה → AI  (התקלה: המחירים "נעלמו בדרך")
//  הרינדור הישן היה Object.values(...).join(" | "), ולכן הספא הגיע
//  ל-AI כ-"09:00–21:00 | ₪350 | ₪480" — מספרים בלי שם שדה. ה-AI לא
//  יכול היה לדעת איזה מחיר שייך לאיזה טיפול, ונתן לאורח מחיר שגוי.
// ════════════════════════════════════════════════════════

test("prompt: כל שדה מגיע ל-AI עם התווית שלו — לא ערכים ערומים", async () => {
  const sys = await askConcierge("מה יש במלון?");

  assert.match(sys, /שעות פעילות: 09:00–21:00/, "השעות מגיעות מתויגות");
  assert.match(sys, /▸ הספא/, "לכל שירות יש כותרת בשם שלו");
  assert.match(sys, /▸ מסעדת הגן/);
  assert.match(sys, /▸ מרכז הכושר/);

  // הרגרסיה עצמה: השרשור הישן הצמיד ערכים ללא מפתחות.
  assert.ok(
    !/09:00–21:00 \| ₪/.test(sys),
    "ערכים ערומים משורשרים — זו בדיוק התקלה שתוקנה",
  );
});

test("prompt: מחיר טיפול צמוד לשם ולמשך שלו — HE + EN", async () => {
  const he = await askConcierge("כמה עולה עיסוי?");
  assert.match(he, /עיסוי שוודי \| משך: 60 דקות \| מחיר: ₪350/);
  assert.match(he, /עיסוי רקמות עמוק \| משך: 90 דקות \| מחיר: ₪480/);
  assert.match(he, /טיפול פנים \| משך: 50 דקות \| מחיר: ₪280/);

  const en = await askConcierge("How much is a massage?");
  assert.match(en, /Swedish massage \| Duration: 60 min \| Price: ₪350/);
  assert.match(en, /Deep tissue massage \| Duration: 90 min \| Price: ₪480/);
  assert.match(en, /Signature facial \| Duration: 50 min \| Price: ₪280/);
});

test("prompt: אותו שם טיפול בשני משכים → שני מחירים נפרדים, בלי בלבול", async () => {
  const sys = await askConcierge("כמה עולה עיסוי שוודי?");
  // 60 ו-90 דקות של אותו טיפול — כל אחד עם המחיר שלו על שורה משלו.
  assert.match(sys, /עיסוי שוודי \| משך: 60 דקות \| מחיר: ₪350/);
  assert.match(sys, /עיסוי שוודי \| משך: 90 דקות \| מחיר: ₪470/);
});

test("prompt: שעות המסעדה והמידע המלא מגיעים ל-AI", async () => {
  const he = await askConcierge("מתי המסעדה פתוחה?");
  assert.match(he, /ארוחת בוקר 07:00–11:00 \| צהריים 12:00–16:00 \| ערב 18:00–23:00/);
  assert.match(he, /סוג מטבח: ים תיכונית ובינלאומית/);
  assert.match(he, /טווח מחירים:.*₪90–₪180/);

  const en = await askConcierge("When is the restaurant open?");
  assert.match(en, /Breakfast 07:00–11:00 \| Lunch 12:00–16:00 \| Dinner 18:00–23:00/);
  assert.match(en, /Cuisine: Mediterranean & International/);
});

test("prompt: שדה חדש ב-config מגיע ל-AI לבד — בלי לגעת בקוד", async () => {
  const { updateConfig, resetConfig } = await import("./config.js");
  try {
    updateConfig({ services: { spa: { he: { rooftop_cabana: "₪700 ליום" } } } });
    const sys = await askConcierge("מה יש בספא?");
    // אין ל-rooftop_cabana תווית ב-FIELD_LABELS — הוא נופל לשם המפתח,
    // אבל הערך *לא* מגיע ערום.
    assert.match(sys, /rooftop cabana: ₪700 ליום/);
  } finally {
    resetConfig();
  }
});

test("prompt: חניה מרונדרת מתויגת, ו-available:false באמת מסתיר אותה", async () => {
  const { updateConfig, resetConfig } = await import("./config.js");
  const sys = await askConcierge("יש חניה?");
  assert.match(sys, /▸ חניה/);
  assert.match(sys, /מחיר: ₪65 ללילה/);
  assert.match(sys, /טעינת רכב חשמלי: 6 עמדות — ₪0\.60 לקוט"ש/);

  try {
    updateConfig({ parking: { available: false } });
    const off = await askConcierge("יש חניה?");
    assert.match(off, /אין חניה במלון/);
    assert.ok(!/₪65 ללילה/.test(off), "מלון בלי חניה לא יציג מחיר חניה");
  } finally {
    resetConfig();
  }
});

// ════════════════════════════════════════════════════════
//  קונפיג — מיזוג עמוק + שמירה ל-DB
// ════════════════════════════════════════════════════════

test("config: מיזוג עמוק — עדכון שדה בודד לא מוחק את אחיו", async () => {
  const { hotelConfig, updateConfig, resetConfig } = await import("./config.js");
  const servicesBefore = Object.keys(hotelConfig.services).length;
  try {
    updateConfig({ services: { spa: { he: { hours: "10:00–23:00" } } } });
    const { hotelConfig: cfg } = await import("./config.js");

    assert.equal(cfg.services.spa.he.hours, "10:00–23:00", "השדה עודכן");
    assert.equal(Object.keys(cfg.services).length, servicesBefore, "שאר השירותים שרדו (המיזוג השטוח היה מוחק אותם)");
    assert.ok(cfg.services.restaurant?.he?.name, "המסעדה עדיין קיימת");
    assert.ok(cfg.services.spa.he.treatments.length > 0, "רשימת הטיפולים של הספא שרדה");
    assert.equal(cfg.services.spa.en.hours, "09:00–21:00, daily (last treatment starts at 20:00)", "האנגלית לא נגעה");
    assert.ok(cfg.wifi.name, "שדות שורש שרדו");
  } finally {
    resetConfig();
  }
});

test("config: מערך מוחלף כמכלול — לא ממוזג לפי אינדקס", async () => {
  const { updateConfig, resetConfig } = await import("./config.js");
  try {
    updateConfig({ services: { spa: { he: { treatments: [{ name: "עיסוי תאילנדי", duration: "60 דקות", price: "₪400" }] } } } });
    const { hotelConfig: cfg } = await import("./config.js");
    assert.equal(cfg.services.spa.he.treatments.length, 1, "הרשימה הוחלפה, לא מוזגה");
    assert.equal(cfg.services.spa.he.treatments[0].name, "עיסוי תאילנדי");
  } finally {
    resetConfig();
  }
});

test("config: prototype pollution דרך ה-API נחסם", async () => {
  const { updateConfig, resetConfig } = await import("./config.js");
  try {
    updateConfig(JSON.parse('{"__proto__":{"polluted":"yes"},"tagline":"ok"}'));
    const { hotelConfig: cfg } = await import("./config.js");
    assert.equal({}.polluted, undefined, "אסור שהפרוטוטייפ הגלובלי יזוהם");
    assert.equal(cfg.tagline, "ok", "שדה תקין באותו patch כן נשמר");
  } finally {
    resetConfig();
  }
});

// הטענה המרכזית של השינוי: עריכה כבר לא נמחקת בריסטארט. אי אפשר לבדוק
// זאת בתוך התהליך (המודול כבר טעון בזיכרון) — ולכן מריצים שני תהליכי
// node אמיתיים מעל אותו קובץ DB: אחד כותב, השני נולד מחדש וקורא.
test("config: עריכה שורדת ריסטארט של התהליך", async () => {
  const { execFileSync } = await import("node:child_process");
  const dbPath = path.join(os.tmpdir(), `hotel-cfg-restart-${process.pid}.db`);
  const run = (code) => execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, DB_PATH: dbPath }, encoding: "utf8", cwd: import.meta.dirname,
  });

  try {
    run(`import { updateConfig } from "./config.js"; updateConfig({ services: { spa: { he: { hours: "10:00–23:00" } } } });`);

    // תהליך חדש לגמרי — שום דבר בזיכרון, הכול מה-DB.
    const out = run(`import { hotelConfig as c } from "./config.js";
      console.log(JSON.stringify({
        hours:      c.services.spa.he.hours,
        services:   Object.keys(c.services).length,
        treatments: c.services.spa.he.treatments.length,
        wifi:       c.wifi.name,
      }));`);
    const got = JSON.parse(out.trim());

    assert.equal(got.hours, "10:00–23:00", "העריכה שרדה את הריסטארט");
    assert.equal(got.services, 8, "כל השירותים שרדו — ה-override לא החליף snapshot מלא");
    assert.equal(got.treatments, 12, "רשימת הטיפולים מברירת המחדל שרדה");
    assert.equal(got.wifi, "Kempinski_Guest", "שדות שלא נערכו מגיעים מברירות המחדל שבקוד");
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  }
});

test("config: updateConfig דוחה קלט שאינו אובייקט", async () => {
  const { updateConfig } = await import("./config.js");
  assert.throws(() => updateConfig("not an object"), TypeError);
  assert.throws(() => updateConfig(null), TypeError);
});

// ════════════════════════════════════════════════════════
//  תצוגת שירותים — נקייה, לוואטסאפ
//  התקלה: הבוט הציג טבלת markdown (|---|---|) שוואטסאפ לא מרנדר,
//  והאורח קיבל ערימת קווים במקום מחירי הספא.
// ════════════════════════════════════════════════════════

test("תצוגה: האיסור על טבלאות markdown מגיע ל-AI — HE + EN", async () => {
  const he = await askConcierge("כמה עולה עיסוי?");
  assert.match(he, /אסור להשתמש בטבלאות markdown/);
  assert.match(he, /• \*עיסוי שוודי\* \(60 דק'\) — ₪350/, "הפורמט הרצוי מודגם ל-AI");

  const en = await askConcierge("How much is a massage?");
  assert.match(en, /Never use markdown tables/);
  assert.match(en, /• \*Swedish massage\* \(60 min\) — ₪350/);
});

test("תצוגה: שגיאת הניסוח 'רקמות עומק' תוקנה ל'רקמות עמוק'", async () => {
  const sys = await askConcierge("כמה עולה עיסוי רקמות עמוק?");
  assert.match(sys, /עיסוי רקמות עמוק \| משך: 60 דקות \| מחיר: ₪390/);
  assert.ok(!/רקמות עומק/.test(sys), "הניסוח השגוי חזר ל-config");
});

test("תצוגה: מחיר לזוג מגיע ל-AI עם ההסבר המלא — לא מספר תלוש", async () => {
  const he = await askConcierge("כמה עולה עיסוי זוגי?");
  assert.match(he, /עיסוי זוגי \| משך: 60 דקות \| מחיר: ₪680/);
  assert.match(he, /לשני אנשים יחד/, "בלי זה האורח קורא ₪680 לאדם");
  assert.match(he, /₪340 לאדם/, "ההשוואה לאדם בודד מפורשת");
  assert.match(he, /כל המחירים למטה הם לאדם אחד/, "הכלל הכללי מגיע ל-AI");

  const en = await askConcierge("How much is a couples massage?");
  assert.match(en, /For two people together/);
  assert.match(en, /₪340 per person/);
  assert.match(en, /Every price below is for one person/);
});

// ════════════════════════════════════════════════════════
//  קונסיירז' — ידע על הסביבה (מחוץ למלון)
// ════════════════════════════════════════════════════════

test("קונסיירז': המלצות האזור מגיעות ל-AI מתויגות — HE", async () => {
  const sys = await askConcierge("איפה כדאי לאכול בערב?");

  assert.match(sys, /מסעדות מומלצות באזור:/);
  assert.match(sys, /אטרקציות ומקומות לבקר:/);
  assert.match(sys, /טיולים וסיורים:/);
  assert.match(sys, /חיי לילה:/);
  assert.match(sys, /קניות:/);
  assert.match(sys, /תחבורה והסעות:/);

  // פריט המלצה שלם — שם + מרחק + מחיר + למי מתאים + הטיפ, על שורה אחת.
  assert.match(sys, /סופיה \|.*מרחק מהמלון: 10 דקות הליכה \|.*₪90–₪140 לסועד/);
  assert.match(sys, /הטיפ שלי: כדאי לבקש שולחן במרפסת העליונה/);
  assert.match(sys, /מוניות: אפשר לבקש ממני להזמין/);
});

test("קונסיירז': אותו ידע קיים גם באנגלית", async () => {
  const sys = await askConcierge("Where should we eat tonight?");

  assert.match(sys, /Recommended restaurants nearby:/);
  assert.match(sys, /Attractions & places to visit:/);
  assert.match(sys, /Tours & day trips:/);
  assert.match(sys, /Sofia \|.*Distance from the hotel: 10 min walk/);
  assert.ok(!/[֐-׿]/.test(sys.split("Recommended restaurants nearby:")[1]?.slice(0, 2000) ?? ""),
    "עברית דלפה לידע האזור באנגלית");
});

test("קונסיירז': קטגוריה חדשה ב-local_area מגיעה ל-AI לבד — בלי לגעת בקוד", async () => {
  const { updateConfig, resetConfig } = await import("./config.js");
  try {
    updateConfig({ local_area: { he: { galleries: [{ name: "גלריה 7", distance: "5 דקות הליכה" }] } } });
    const sys = await askConcierge("יש גלריות באזור?");
    assert.match(sys, /גלריה 7 \| מרחק מהמלון: 5 דקות הליכה/);
    assert.match(sys, /מסעדות מומלצות באזור:/, "שאר הקטגוריות שרדו את המיזוג");
  } finally {
    resetConfig();
  }
});

// ════════════════════════════════════════════════════════
//  קונסיירז' — בקשות שדורשות סידור בפועל
//  היום המוק רק מקצה אסמכתא; הביצוע הוא של הקונסיירז' האנושי
//  שמקבל את ההתראה. נקודת ההחלפה: concierge/index.js.
// ════════════════════════════════════════════════════════

test("בקשה: [CONCIERGE:taxi|…] → מגיעה לקונסיירז' עם אסמכתא, והתג לא דולף לאורח", async () => {
  const { hotelConfig } = await import("./config.js");
  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  sent.length = 0;

  aiReply = "בשמחה 🚕 העברתי את הבקשה לקונסיירז' שלנו — אעדכן ברגע שיש אישור.\n" +
            "[CONCIERGE:taxi|מונית מהמלון לנמל הישן, היום ב-20:00, 2 נוסעים]";
  await bot.handleIncoming(p, "אפשר מונית לנמל הישן ב-20:00 לשני אנשים?");

  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.ok(!guest.includes("["), `תג דלף לאורח: ${guest}`);
  assert.match(guest, /העברתי את הבקשה לקונסיירז'/);

  const staff = sent.find(s => s.to === hotelConfig.concierge_number);
  assert.ok(staff, "הקונסיירז' חייב לקבל את הבקשה");
  assert.match(staff.body, /הזמנת מונית/, "הכותרת לפי סוג הבקשה");
  assert.match(staff.body, /לנמל הישן, היום ב-20:00, 2 נוסעים/, "כל הפרטים עוברים — הקונסיירז' לא רואה את השיחה");
  assert.match(staff.body, /אסמכתא: CNG-[A-Z0-9]{6}/, "אסמכתא מהשכבת המבודדת");
});

test("בקשה: כל סוג מקבל את הכותרת שלו אצל הצוות", async () => {
  const { hotelConfig } = await import("./config.js");
  const cases = [
    ["restaurant", "שולחן ל-2 במסעדת ים, מחר ב-20:30", /הזמנת שולחן במסעדה/],
    ["spa",        "עיסוי זוגי 60 דקות, שישי ב-16:00", /הזמנת טיפול בספא/],
    ["gift",       "זר פרחים לחדר עד 18:00",          /בקשה מיוחדת \/ מתנה/],
  ];

  for (const [type, details, expected] of cases) {
    const p = freshGuest();
    await bot.handleIncoming(p, "שלום");
    sent.length = 0;

    aiReply = `בשמחה, אני מעביר לקונסיירז'.\n[CONCIERGE:${type}|${details}]`;
    await bot.handleIncoming(p, "בבקשה");

    const staff = sent.find(s => s.to === hotelConfig.concierge_number);
    assert.ok(staff, `סוג ${type}: הקונסיירז' לא קיבל את הבקשה`);
    assert.match(staff.body, expected);
    assert.ok(staff.body.includes(details), `סוג ${type}: הפרטים לא עברו במלואם`);
  }
});

test("בקשה: פורמט לא צפוי → הבקשה עדיין מגיעה לאדם, בלי לאבד פרט", async () => {
  const { hotelConfig } = await import("./config.js");

  // (א) הפורמט הישן — תג בלי סוג בכלל.
  const p1 = freshGuest();
  await bot.handleIncoming(p1, "שלום");
  sent.length = 0;
  aiReply = "מעביר לקונסיירז'.\n[CONCIERGE:זר פרחים לחדר 304 עד 18:00]";
  await bot.handleIncoming(p1, "אפשר פרחים לחדר?");

  let staff = sent.find(s => s.to === hotelConfig.concierge_number);
  assert.ok(staff, "תג בפורמט הישן — הבקשה לא נעלמת");
  assert.match(staff.body, /בקשת קונסיירז'/, "נופל לסוג הכללי");
  assert.match(staff.body, /זר פרחים לחדר 304 עד 18:00/);

  // (ב) סוג שה-AI המציא — הפרטים נשמרים *במלואם*, כולל הסוג שהומצא.
  const p2 = freshGuest();
  await bot.handleIncoming(p2, "שלום");
  sent.length = 0;
  aiReply = "מעביר.\n[CONCIERGE:helicopter|מסוק לאילת מחר בבוקר]";
  await bot.handleIncoming(p2, "אפשר מסוק?");

  staff = sent.find(s => s.to === hotelConfig.concierge_number);
  assert.ok(staff, "סוג לא מוכר — הבקשה לא נעלמת");
  assert.match(staff.body, /בקשת קונסיירז'/);
  assert.match(staff.body, /helicopter\|מסוק לאילת מחר בבוקר/, "שום פרט לא נחתך");
});

test("בקשה: תקלה בשכבת הקונסיירז' לא מונעת מהבקשה להגיע לאדם", async () => {
  const { hotelConfig } = await import("./config.js");
  const { concierge }   = await import("./concierge/index.js");

  const orig = concierge.submitRequest;
  concierge.submitRequest = async () => { throw new Error("provider down"); };
  try {
    const p = freshGuest();
    await bot.handleIncoming(p, "שלום");
    sent.length = 0;

    aiReply = "מעביר לקונסיירז'.\n[CONCIERGE:taxi|מונית לנתב\"ג מחר ב-05:30, נוסע אחד]";
    await bot.handleIncoming(p, "מונית לנתבג מחר");

    const staff = sent.find(s => s.to === hotelConfig.concierge_number);
    assert.ok(staff, "ספק נפל — הבקשה עדיין חייבת להגיע לקונסיירז' האנושי");
    assert.match(staff.body, /מונית לנתב"ג מחר ב-05:30/);
    assert.ok(!/אסמכתא/.test(staff.body), "בלי ספק אין אסמכתא — ולא ממציאים אחת");

    const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
    assert.ok(!guest.includes("["), "התג לא דולף גם בנתיב השגיאה");
  } finally {
    concierge.submitRequest = orig;
  }
});

test("קונסיירז': הכללים על מה מותר להבטיח מגיעים ל-AI — HE + EN", async () => {
  const he = await askConcierge("אפשר מונית?");
  assert.match(he, /"הזמנתי לך מונית ל-20:00"/, "איסור אישור הזמנה שלא בוצעה");
  assert.match(he, /אעביר את בקשתך/, "הניסוח המותר — העברת בקשה, לא ביצוע");
  assert.match(he, /\[CONCIERGE:taxi\|/, "הפורמט המדויק מודגם ל-AI");

  const en = await askConcierge("Can I get a taxi?");
  assert.match(en, /"I've booked you a taxi for 20:00"/);
  assert.match(en, /pass your request/i);
  assert.match(en, /\[CONCIERGE:taxi\|/);
});

// ── הקונסיירז' לא ממציא מקומות ──────────────────────────
// התקלה: הבוט המליץ על עסקים שאולי אינם קיימים, או ענה "אני לא יודע"
// והשאיר את האורח תלוי באוויר. שתי ההתנהגויות חייבות להיאסר במפורש.
test("קונסיירז': האיסור להמציא מקומות מגיע ל-AI — HE + EN", async () => {
  const he = await askConcierge("איפה יש סושי טוב באזור?");
  assert.match(he, /אסור להמציא מקומות/, "האיסור המפורש");
  assert.match(he, /אשמח לבדוק ולחזור אליך/, "החלופה — לבדוק ולחזור, לא להמציא");
  assert.match(he, /\[RECEPTION:/, "יש נתיב הסלמה לאדם שיברר");

  const en = await askConcierge("Where can I get good sushi?");
  assert.match(en, /NEVER INVENT A PLACE/i);
  assert.match(en, /look\s+into it and come back to you/i);
  assert.match(en, /\[RECEPTION:/);
});

// ── איכות הניסוח ────────────────────────────────────────
// "אגיד לי לאיזה יום ושעה" נולד מהעתקת פריט מרשימת ההוראות לתוך משפט.
// הכלל שאוסר זאת חייב להגיע ל-AI.
test("ניסוח: הכלל נגד העתקת ניסוחים מההוראות מגיע ל-AI — HE + EN", async () => {
  const he = await askConcierge("אפשר להזמין שולחן?");
  assert.match(he, /אל תעתיק ניסוחים/, "האיסור על העתקת ניסוחים מההוראות");
  assert.match(he, /אגיד לי לאיזה יום ושעה/, "הדוגמה השבורה שנצפתה בשטח");
  // רשימת הפרטים לאיסוף מנוסחת כשמות עצם, לא כמשפט להעתקה.
  assert.ok(!/לאיזה יום ושעה, כמה סועדים/.test(he), "הרשימה חזרה להיות ניסוח להעתקה");

  const en = await askConcierge("Can I book a table?");
  assert.match(en, /Never copy phrasings out of these instructions/i);
});

// ════════════════════════════════════════════════════════
//  חירום — הזרימה הקריטית ביותר: אסור שקט, לעולם
// ════════════════════════════════════════════════════════

// ── זיהוי דטרמיניסטי, בלי תלות ב-AI ────────────────────
test("חירום (זיהוי): מזהה פציעה/אש/סכנה — HE + EN — ולא נבהל מדברים רגילים", async () => {
  const { detectEmergency } = await import("./emergency.js");

  // חייב לזהות
  assert.equal(detectEmergency("יש אדם פצוע פה!")?.kind, "medical");
  assert.equal(detectEmergency("מישהו לא נושם")?.kind, "medical");
  assert.equal(detectEmergency("יש שריפה בחדר")?.kind, "fire");
  assert.equal(detectEmergency("אני מריח גז")?.kind, "fire");
  assert.equal(detectEmergency("there's an injured person")?.kind, "medical");
  assert.equal(detectEmergency("I smell gas")?.kind, "fire");
  assert.equal(detectEmergency("someone attacked me")?.kind, "security");

  // אסור שיתפוס דברים יומיומיים (false positives)
  assert.equal(detectEmergency("כואב לי הראש קצת"), null, "'ראש' לא אמור להיתפס כ'אש'");
  assert.equal(detectEmergency("מישהו מעשן ליד הבריכה"), null, "'מעשן' לא אמור להיתפס כ'עשן'");
  assert.equal(detectEmergency("אפשר מספר ההזמנה מאושר?"), null, "'מאושר' לא אמור להיתפס כ'אש'");
  assert.equal(detectEmergency("צריך סכין ומזלג לחדר"), null, "בקשת סכו\"ם אינה חירום");
  assert.equal(detectEmergency("מה שעות הבריכה?"), null);
  assert.equal(detectEmergency("Can I book a table?"), null);
});

test("חירום (רפואי, עברית): האורח מקבל מיד 101 + כל המספרים, בלי הנחיה רפואית, והביטחון מוסלם", async () => {
  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  sent.length = 0;

  await bot.handleIncoming(p, "יש פה אדם פצוע, הוא מדמם!");

  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.ok(guest.length > 0, "אסור שקט בחירום");
  assert.match(guest, /101/, "מספר מד\"א");
  assert.match(guest, /102/, "מספר כבאות");
  assert.match(guest, /100/, "מספר משטרה");
  assert.match(guest, /לא מוסמך|אינני מוסמך|איני מוסמך/, "הבהרה שאינו נותן הנחיות רפואיות");
  assert.ok(!guest.includes("["), `תג דלף לאורח: ${guest}`);

  const staff = sent.filter(s => s.to !== p).map(s => s.body).join("\n");
  assert.match(staff, /חירום/, "הביטחון קיבל התראת חירום");
});

test("חירום (אש, עברית): 102 + הנחיית פינוי", async () => {
  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  sent.length = 0;

  await bot.handleIncoming(p, "יש שריפה במסדרון!!");
  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(guest, /102/);
  assert.match(guest, /צאו מהחדר|התרחקו|למקום/, "הנחיית פינוי");
});

test("חירום (אנגלית): מקרה רפואי → 101 באנגלית", async () => {
  const p = freshGuest();
  await bot.handleIncoming(p, "hello");
  sent.length = 0;

  await bot.handleIncoming(p, "help, my wife is unconscious!");
  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(guest, /101/);
  assert.match(guest, /Magen David Adom|101/);
  assert.match(guest, /not qualified/i);
});

test("חירום גובר על צ'ק אין: 'יש פצוע' באמצע שלב הזהות → הנחיית חירום, לא 'שלח תעודה'", async () => {
  const p = await checkinUpTo("waiting_id");
  sent.length = 0;

  // האורח בשלב אימות הזהות שולח טקסט חירום (בלי תמונה). קודם זה היה
  // נבלע כ"לא קיבלתי תמונה" — עכשיו החירום גובר על הכול.
  await bot.handleIncoming(p, "עזוב את התעודה, יש פה מישהו שהתעלף!");
  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(guest, /101/, "האורח מקבל הנחיית חירום");
  assert.ok(!/תעוד|תמונה|דרכון/.test(guest), `הבוט חזר לבקש תעודה במקום לטפל בחירום: ${guest}`);
});

test("חירום עובד גם כשה-AI למטה — כי הוא דטרמיניסטי ולא קורא ל-AI", async () => {
  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  sent.length = 0;
  aiCalls = 0;
  aiReply = null; // ה-AI היה מחזיר content ריק / נכשל

  await bot.handleIncoming(p, "מישהו טובע בבריכה!");
  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(guest, /101/, "האורח קיבל מספרי חירום גם כשה-AI למטה");
  assert.equal(aiCalls, 0, "החירום לא אמור לקרוא ל-AI בכלל");
});

test("חירום (התרחיש שדווח): 'יש פצוע' ואז 'הלו?' — שתי ההודעות מקבלות מענה, אפס שקט", async () => {
  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  sent.length = 0;

  // הודעה 1 — דיווח על פצוע
  await bot.handleIncoming(p, "יש פה אדם פצוע");
  assert.ok(sent.some(s => s.to === p), "הודעה 1: האורח חייב לקבל מענה");

  // הודעה 2 — "הלו?" (האורח בודק אם מישהו שם). קודם זו הייתה שתיקה.
  sent.length = 0;
  aiReply = "אני כאן איתך, צוות הביטחון בדרך.";
  await bot.handleIncoming(p, "הלו??");
  assert.ok(sent.some(s => s.to === p), "הודעה 2: 'הלו?' לא יכולה להיענות בשקט");
  assert.ok(sent.filter(s => s.to === p).every(s => s.body && s.body.trim()), "אין הודעות ריקות");
});

// ════════════════════════════════════════════════════════
//  ידע בסיסי + בטיחות + קונסיירז' מדויק
// ════════════════════════════════════════════════════════
test("מבנה: הבוט יודע איפה הלובי/הקבלה — המידע מגיע ל-AI (HE + EN)", async () => {
  const he = await askConcierge("איפה הקבלה?");
  assert.match(he, /מבנה המלון/, "סעיף מבנה המלון");
  assert.match(he, /קומת הקרקע/, "ברירת המחדל: לובי בקומת הקרקע");
  assert.match(he, /אל תשאל את האורח שאלות\s*\n?\s*מבנה|אל תשאל/, "כלל: לא לשאול שאלות מבנה");

  const en = await askConcierge("where is reception?");
  assert.match(en, /THE BUILDING/i);
  assert.match(en, /ground floor/i);
});

test("בטיחות בריכה: מידע מציל ובטיחות מגיע ל-AI", async () => {
  const he = await askConcierge("ספר לי על הבריכה");
  assert.match(he, /מציל/, "מידע על מציל");
  assert.match(he, /בטיחות/, "כללי בטיחות");

  const en = await askConcierge("tell me about the pool");
  assert.match(en, /Lifeguard/i);
  assert.match(en, /Safety/i);
});

test("קונסיירז' מדויק: הכלל לכבד בקשה בשרית/כשרה מגיע ל-AI, ויש מקום בשרי בנתונים", async () => {
  const he = await askConcierge("אפשר המלצה למסעדת בשרים כשרה?");
  assert.match(he, /כבד את הבקשה המדויקת|אל תחליף קטגוריה/, "הכלל לכבד את הבקשה");
  assert.match(he, /בשרי/, "המידע כולל שיוך בשרי/חלבי");
  assert.match(he, /כשרות/, "שדה הכשרות מגיע ל-AI");
  assert.match(he, /האש/, "יש מסעדה בשרית בנתונים להמליץ עליה");

  const en = await askConcierge("a kosher steakhouse nearby?");
  assert.match(en, /Honour the exact request|never swap the category/i);
  assert.match(en, /Kosher/);
});

test("עברית עקבית: הכלל נגד ערבוב לכם/לכן מגיע ל-AI", async () => {
  const he = await askConcierge("אנחנו זוג, מה תמליץ לנו?");
  assert.match(he, /לכם.*לכן|עקביות בפנייה/, "הכלל על עקביות לכם/לכן");
});

// ════════════════════════════════════════════════════════
//  Google Places — חיפוש מקומות אמיתי דרך שכבת places/
// ════════════════════════════════════════════════════════

test("places: כלי search_nearby_places נשלח ל-AI בכל תור קונסיירז'", async () => {
  const p = freshGuest();
  await bot.handleIncoming(p, "מה שעות הספא?");
  assert.ok(Array.isArray(aiParams.tools), "tools לא נשלח ל-AI");
  const tool = aiParams.tools.find(t => t.name === "search_nearby_places");
  assert.ok(tool, "הכלי search_nearby_places חסר");
  assert.ok(tool.input_schema.properties.query, "לכלי אין שדה query");
});

test("places: בקשת המלצה מפעילה חיפוש חי סביב מיקום המלון ומחזירה מקום אמיתי", async () => {
  placesResult = {
    ok: true, provider: "mock",
    results: [{
      name: "Real Grill", address: "12 Herbert Samuel St", category: "Steak house",
      rating: 4.6, ratingCount: 1240, priceSymbol: "₪₪₪", openNow: true,
      distanceText: "300 m", distanceMeters: 300,
    }],
  };
  // תור 1: ה-AI מבקש לחפש. תור 2: מנסח תשובה לאורח.
  aiScript = (params, idx) => {
    if (idx === 0) return {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: "search_nearby_places",
        input: { query: "kosher meat restaurant", category: "restaurant", keyword: "kosher" } }],
    };
    return { content: [{ type: "text", text: "אני ממליץ בחום על *Real Grill* 🌟 — 300 מ׳ מהמלון." }] };
  };

  const p = freshGuest();
  await bot.handleIncoming(p, "אני רוצה מסעדת בשר כשרה בקרבת מקום");

  // הכלי נקרא פעם אחת, עם הבקשה המדויקת ומיקום המלון מה-config.
  // ⚠️ הקואורדינטות נגזרות מה-config עצמו (מקור האמת) ולא מקובעות כאן —
  //    כדי שהחלפת מיקום המלון בקונפיג לא תשבור את הבדיקה.
  const { hotelConfig: locCfg } = await import("./config.js");
  assert.equal(placesCalls.length, 1, "החיפוש לא הופעל");
  assert.match(placesCalls[0].query, /kosher meat/i, "הבקשה המדויקת לא עברה לחיפוש");
  assert.equal(placesCalls[0].location.lat, locCfg.location.lat, "מיקום המלון לא עבר לחיפוש");
  assert.equal(placesCalls[0].location.lng, locCfg.location.lng);

  // התוצאה האמיתית הגיעה לאורח.
  assert.match(lastBody(), /Real Grill/, "המקום האמיתי לא הוצג לאורח");

  // הקריאה השנייה ל-AI קיבלה tool_result עם המקום — כך הוא ידע לנסח.
  const msgsJson = JSON.stringify(aiParams.messages);
  assert.match(msgsJson, /tool_result/, "לא הוחזר tool_result ל-AI");
  assert.match(msgsJson, /Real Grill/, "תוצאות החיפוש לא הוחזרו ל-AI");
});

test("places: חיפוש שנכשל (unavailable) → status עובר ל-AI, אין קריסה", async () => {
  placesResult = { ok: false, provider: "mock", reason: "unavailable", results: [] };
  aiScript = (params, idx) => {
    if (idx === 0) return {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t2", name: "search_nearby_places", input: { query: "sushi" } }],
    };
    // ה-AI רואה את הכישלון ומנסח "אבדוק ואחזור" + [RECEPTION].
    return { content: [{ type: "text", text: "אשמח לבדוק ולחזור אליך 🙏 [RECEPTION:סושי באזור]" }] };
  };

  const p = freshGuest();
  await bot.handleIncoming(p, "יש סושי טוב בסביבה?");

  assert.equal(placesCalls.length, 1);
  // ה-status הועבר ל-AI כדי שידע לא להמציא.
  const toolResult = JSON.stringify(aiParams.messages);
  assert.match(toolResult, /unavailable/, "סטטוס הכישלון לא הועבר ל-AI");
  // התג הפנימי לא דלף לאורח, והאורח קיבל מענה אנושי.
  assert.doesNotMatch(lastBody(), /\[RECEPTION/, "תג פנימי דלף לאורח");
  assert.match(lastBody(), /אבדוק|לבדוק/);
});

test("places: כמה קריאות כלי ברצף לא תוקעות — נעצר בגבול ומחזיר טקסט", async () => {
  placesResult = { ok: true, provider: "mock", results: [{ name: "Loop Place", distanceText: "100 m", distanceMeters: 100 }] };
  // ה-AI מבקש כלי שוב ושוב — הלולאה חייבת להיעצר ולא להיתקע.
  aiScript = () => ({
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "tx", name: "search_nearby_places", input: { query: "loop" } }],
  });

  const p = freshGuest();
  await bot.handleIncoming(p, "המלצה?");

  // נעצר בגבול הקשיח (MAX_HOPS) — לא לולאה אינסופית.
  assert.ok(aiCalls <= 6, `יותר מדי קריאות AI: ${aiCalls}`);
  assert.ok(placesCalls.length <= 5);
  // האורח קיבל מענה כלשהו (aiReply של הקריאה הסופית ללא כלים).
  assert.ok(lastBody().length > 0);
});

// ════════════════════════════════════════════════════════
//  צ'ק אאוט — מכונת המצבים המלאה (הצגת חשבון → אישור → סליקה)
//  ----------------------------------------------------------
//  עד כה לא היו בדיקות מקצה-לקצה לצ'ק אאוט. כאן מריצים צ'ק אין מלא
//  דרך הצ'אט, מקבלים את ההזמנה למצב checked_in (דרך completeCheckin),
//  מוסיפים חיובים, ואז מפעילים את זרימת הצ'ק אאוט — כולל שלושת מקרי
//  הפיקדון והביטול. גם מאמת שאין כפילות בשורות ניכוי הפיקדון.
// ════════════════════════════════════════════════════════

// מביא אורח עד מצב checked_in *אמיתי* (כמו אחרי תשלום), ומחזיר {phone, res}.
async function checkedInGuest({ lang = "he" } = {}) {
  const { reservations, completeCheckin } = await import("./checkin.js");
  const p = await checkinUpTo("waiting_payment", { lang });
  const res = Object.values(reservations).find(r => r.phone === p && r.stage === "pending_payment");
  await completeCheckin(res.id, "412");
  return { p, res, reservations };
}

test("צ'ק אאוט: 'צק אאוט' מציג את החשבון המלא ומבקש אישור", async () => {
  const { p } = await checkedInGuest();
  const { addFolioItem } = await import("./checkin.js");
  const { reservations } = await import("./checkin.js");
  const res = Object.values(reservations).find(r => r.phone === p);
  addFolioItem(res.id, "MINIBAR", "מיני בר", 9500);
  sent.length = 0;

  await bot.handleIncoming(p, "צק אאוט");
  assert.match(lastBody(), /בקשת צ'ק אאוט|סיכום חשבון/, "מציג בקשת צ'ק אאוט עם חשבון");
  assert.match(lastBody(), /מיני בר/, "פריט החיוב מופיע");
  assert.match(lastBody(), /כן|לא/, "מבקש אישור כן/לא");
  assert.ok(!lastBody().includes("["), "אין תג שדולף");
});

test("צ'ק אאוט (מקרה A): אין חיובים → פיקדון משוחרר, פרידה חמה", async () => {
  const { p } = await checkedInGuest();
  sent.length = 0;
  await bot.handleIncoming(p, "צק אאוט");
  sent.length = 0;
  await bot.handleIncoming(p, "כן");

  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(guest, /צ'ק אאוט הושלם/, "אישור צ'ק אאוט");
  assert.match(guest, /לא בוצע חיוב|אין חיובים/, "אין חיובים");
  assert.match(guest, /3-5 ימי עסקים/, "מועד שחרור הפיקדון");
  assert.match(guest, /נשמח לראותך שוב/, "פרידה חמה");
  assert.ok(!guest.includes("["), "אין תג שדולף");

  const staff = sent.filter(s => s.to !== p).map(s => s.body).join("\n");
  assert.match(staff, /ניקיון|פנוי/, "משק הבית מקבל התראה על חדר פנוי");
});

test("צ'ק אאוט (מקרה B): חיובים ≤ פיקדון → ניכוי + שחרור יתרה, בלי כפילות שורות", async () => {
  const { p, reservations } = await checkedInGuest();
  const { addFolioItem } = await import("./checkin.js");
  const res = Object.values(reservations).find(r => r.phone === p);
  addFolioItem(res.id, "RESTAURANT", "ארוחת ערב", 12000);
  addFolioItem(res.id, "MINIBAR", "מיני בר", 8000); // סה"כ ₪200 < ₪500
  sent.length = 0;

  await bot.handleIncoming(p, "צק אאוט");
  // מנקים כדי לבדוק את *הודעת האישור הסופית* בלבד (התצוגה המקדימה היא
  // הודעה נפרדת מוקדמת יותר, בזמן עתיד — לא כפילות בתוך אותה הודעה).
  sent.length = 0;
  await bot.handleIncoming(p, "כן");

  const confirmation = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(confirmation, /צ'ק אאוט הושלם/);
  assert.match(confirmation, /נוכה מהפיקדון: ₪200\.00/, "סכום הניכוי הנכון");
  assert.match(confirmation, /יתרת הפיקדון \(₪300\.00\) תשוחרר/, "היתרה הנכונה משוחררת");
  // הרגרסיה שתוקנה: שורת "נוכה מהפיקדון" הופיעה פעמיים *באותה הודעה*
  // (פעם בתוך formatFolio ופעם בשורה שהודבקה אחריו). עכשיו פעם אחת.
  const occurrences = (confirmation.match(/נוכה מהפיקדון: ₪200\.00/g) || []).length;
  assert.equal(occurrences, 1, `שורת הניכוי הופיעה ${occurrences} פעמים — צריכה פעם אחת`);
});

test("צ'ק אאוט (מקרה C): חיובים > פיקדון → פיקדון מלא + הפרש + הצעת כרטיס אחר", async () => {
  const { p, reservations } = await checkedInGuest();
  const { addFolioItem } = await import("./checkin.js");
  const res = Object.values(reservations).find(r => r.phone === p);
  addFolioItem(res.id, "RESTAURANT", "אירוע", 70000); // ₪700 > ₪500
  sent.length = 0;

  await bot.handleIncoming(p, "צק אאוט");
  await bot.handleIncoming(p, "כן");

  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(guest, /נוכה במלואו/, "הפיקדון נוכה במלואו");
  assert.match(guest, /ההפרש \(₪200\.00\) חויב/, "ההפרש חויב");
  assert.match(guest, /כרטיס אחר/, "מוצעת החלפה לכרטיס אחר");
  assert.match(guest, /http/, "קישור להחלפת הכרטיס");
  assert.ok(!guest.includes("["), "אין תג שדולף");
});

test("צ'ק אאוט: 'לא' מבטל את הצ'ק אאוט — לא מחייב, נשאר checked_in", async () => {
  const { p, reservations } = await checkedInGuest();
  const { addFolioItem } = await import("./checkin.js");
  const res = Object.values(reservations).find(r => r.phone === p);
  addFolioItem(res.id, "MINIBAR", "מיני בר", 5000);
  sent.length = 0;

  await bot.handleIncoming(p, "צק אאוט");
  sent.length = 0;
  await bot.handleIncoming(p, "לא");

  assert.match(lastBody(), /בוטל/, "הצ'ק אאוט בוטל");
  const after = Object.values(reservations).find(r => r.phone === p);
  assert.equal(after.stage, "checked_in", "ההזמנה נשארת פעילה");
  assert.equal(after.captured, false, "לא בוצע חיוב");
});

test("צ'ק אאוט: אורח אנגלי מקבל צ'ק אאוט באנגלית מלאה — בלי ערבוב שפות", async () => {
  const { p } = await checkedInGuest({ lang: "en" });
  sent.length = 0;

  await bot.handleIncoming(p, "check out");
  const bill = lastBody();
  assert.match(bill, /Check-out request|Bill/, "בקשת צ'ק אאוט באנגלית");
  assert.ok(!/[֐-׿]/.test(bill), `עברית דלפה לאורח אנגלי: ${bill}`);

  sent.length = 0;
  await bot.handleIncoming(p, "yes");
  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(guest, /Check-out complete/, "אישור באנגלית");
  assert.ok(!/[֐-׿]/.test(guest), `עברית דלפה לאישור הצ'ק אאוט: ${guest}`);
});

// ניקוי קובץ ה-DB הזמני
process.on("exit", () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* ignore */ }
  }
});
