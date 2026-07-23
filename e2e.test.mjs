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
process.env.ID_ENCRYPTION_KEY    = "0".repeat(64); // 32 בייט hex — הצפנת מסמכי זיהוי בבדיקות

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

// ── שכבת המייל — לוכדים כל מייל שנשלח למחלקה ──────────
// כל התראה למחלקה אמורה לצאת בשני ערוצים (וואטסאפ + מייל). בלי לכידת
// המייל אפשר לבדוק רק חצי מהניתוב.
const emails = [];
mock.module("./email/index.js", {
  exports: {
    email: { send: async (m) => { emails.push(m); return { success: true, messageId: "mock" }; } },
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
  aiScript = null; emails.length = 0;
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
  if (stage === "waiting_details") return p;
  // שלב הפרטים הנוספים אופציונלי — בבדיקות מדלגים עליו כברירת מחדל.
  await bot.handleIncoming(p, lang === "he" ? "דלג" : "skip");
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
  // אורח מחובר (יש לו מספר חדר) כדי שבקשת ניקיון תעבור מיד — Bug #3.
  const { p } = await checkedInGuest();
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
  const { peekSession } = await import("./state.js");
  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");

  // התרחיש שהרג את הבוט: אורח שולח תמונה אקראית בלי טקסט (מחוץ לצ'ק אין).
  aiReply = "תמונה יפה!";
  await bot.handleIncoming(p, "", IMG);

  const history = peekSession(p).history;
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
  assert.match(lastBody(), /מתי מתוכננת השהייה/, "שלב התאריכים בעברית");
  assert.ok(!/please|stay dates|Reservation/i.test(lastBody()), `ערבוב שפות: ${lastBody()}`);

  sent.length = 0;
  await bot.handleIncoming(p, STAY.text);
  assert.match(lastBody(), /נכון\?/, "אישור התאריכים בעברית");
  assert.ok(!/correct|arrival|departure/i.test(lastBody()), `ערבוב שפות: ${lastBody()}`);

  sent.length = 0;
  await bot.handleIncoming(p, "כן");        // → שלב הפרטים הנוספים (עברית)
  assert.ok(!/please|arrival|plate/i.test(lastBody()), `ערבוב שפות בפרטים: ${lastBody()}`);

  sent.length = 0;
  await bot.handleIncoming(p, "דלג");       // מדלגים על הפרטים → שלב הזהות
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
  assert.equal(ask, "And what is your *reservation number*? (it appears on your booking confirmation)");
});

// ── מספר הזמנה אלפאנומרי — אישורי הזמנה אמיתיים מכילים אותיות ──
// "RES12345" נדחה בעבר ("ספרות בלבד") והצ'ק אין נתקע לצמיתות.
test("מספר הזמנה עם אותיות (RES12345) מתקבל", async () => {
  const { validateReservationNumber } = await import("./validate.js");
  for (const code of ["RES12345", "12345", "BK-8842-QT", "res12345", "#A1B2C3"]) {
    assert.equal(validateReservationNumber(code).ok, true, `${code} אמור להתקבל`);
  }
  assert.equal(validateReservationNumber("RES12345").value, "RES12345");
  assert.equal(validateReservationNumber("מספר ההזמנה שלי הוא RES12345").value, "RES12345");
  // ...ועדיין דוחה טקסט חופשי, כדי שקלט של שלב אחר לא ייבלע כקוד.
  for (const junk of ["10 יותר נוח לי בעברית", "4 לילות 19.7", "אני מאשר את התנאים", "abc"]) {
    assert.equal(validateReservationNumber(junk).ok, false, `${junk} אמור להידחות`);
  }
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
  await bot.handleIncoming(p, "דלג");                     // דילוג על פרטים נוספים
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
  await bot.handleIncoming(p, "דלג");  // מדלגים על הפרטים הנוספים
  assert.match(lastBody(), /תעודת הזהות|הדרכון/, "אחרי אישור — ממשיך לשלב הבא");
});

test("תוספת 1: תאריכים לא תקינים → נשארים בשלב ומבקשים שוב", async () => {
  const p = await checkinUpTo("waiting_dates");

  for (const bad of ["מתישהו בקיץ", "25/07/2027 - 20/07/2027", "01/01/2020 - 05/01/2020"]) {
    sent.length = 0;
    await bot.handleIncoming(p, bad);
    assert.match(lastBody(), /מתי מתוכננת השהייה/, `לא ביקש שוב על "${bad}": ${lastBody()}`);
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
  await bot.handleIncoming(p, "דלג");  // דילוג על פרטים נוספים
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
  assert.match(lastBody(), /מתי מתוכננת השהייה/, "חזר לשאלת התאריכים");

  // תיקון ישיר בתאריכים חדשים → מאשרים מחדש את החדשים
  sent.length = 0;
  await bot.handleIncoming(p, "20/07/2027, 3 לילות");
  assert.match(lastBody(), /נכון\?/, "מבקש אישור על התאריכים המתוקנים");
});

// ════════════════════════════════════════════════════════
//  באג התאריכים — צבירת מידע חלקי לאורך כמה הודעות (Bug #2)
//  ----------------------------------------------------------
//  מהבדיקה החיה: "4 לילות" ואז "19.7" — הבוט שכח את הלילות וביקש שוב.
//  עכשיו הוא זוכר את החלק שכבר נמסר ומצרף אליו את החדש.
// ════════════════════════════════════════════════════════
// 🔴 התאריך כאן מחושב מ*היום* ולא כתוב קשיח. גרסה קודמת השתמשה ב-"19.7",
// והבדיקה נשברה מעצמה ברגע ש-19.7 הפך לתאריך שעבר — הבוט דחה אותו בצדק
// ("ההגעה יוצאת בתאריך שכבר עבר"), אבל הבדיקה נראתה כמו רגרסיה.
function futureDay(offsetDays) {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return { day: d.getUTCDate(), month: d.getUTCMonth() + 1, date: d };
}

test("צבירת תאריכים: 'X לילות' ואז תאריך הגעה מצטרפים יחד", async () => {
  const p = await checkinUpTo("waiting_dates");
  const arrive = futureDay(2);
  const depart = futureDay(6); // +4 לילות

  // חלק 1 — רק מספר לילות. הבוט אמור לזכור ולבקש *רק* את תאריך ההגעה.
  sent.length = 0;
  await bot.handleIncoming(p, "4 לילות");
  assert.ok(!/נכון\?/.test(lastBody()), "עדיין אין תאריך — אסור לאשר");
  assert.ok(!/תעודת הזהות/.test(lastBody()), "אסור להתקדם עם חצי מידע");
  assert.match(lastBody(), /הגעה|תאריך/, `אמור לבקש את תאריך ההגעה: ${lastBody()}`);

  // חלק 2 — תאריך ההגעה. עכשיו שני החלקים מצטרפים.
  sent.length = 0;
  await bot.handleIncoming(p, `${arrive.day}.${arrive.month}`);
  assert.match(lastBody(), /נכון\?/, `אחרי שני החלקים — מבקש אישור: ${lastBody()}`);
  assert.match(lastBody(), new RegExp(`\\b${arrive.day}\\b`), "תאריך ההגעה מההודעה השנייה");
  assert.match(lastBody(), new RegExp(`\\b${depart.day}\\b`), "העזיבה = הגעה + 4 לילות");
  assert.match(lastBody(), /4 לילות/, "ארבעה לילות (מההודעה הראשונה — לא נשכח)");
});

test("צבירת תאריכים: הסדר ההפוך — תאריך ואז לילות — גם עובד", async () => {
  const p = await checkinUpTo("waiting_dates");
  const arrive = futureDay(2);
  const depart = futureDay(6);

  sent.length = 0;
  await bot.handleIncoming(p, `${arrive.day}.${arrive.month}`);
  assert.ok(!/נכון\?/.test(lastBody()), "תאריך יחיד בלי לילות — עוד לא מאשרים");

  sent.length = 0;
  await bot.handleIncoming(p, "4 לילות");
  assert.match(lastBody(), /נכון\?/, "אחרי שני החלקים — מבקש אישור");
  assert.match(lastBody(), new RegExp(`\\b${arrive.day}\\b`), "תאריך ההגעה");
  assert.match(lastBody(), new RegExp(`\\b${depart.day}\\b`), "תאריך העזיבה");
});

// הדוגמה שהבוט מציג לאורח חייבת להיות תאריך עתידי — אחרת הוא מציע
// בדיוק את הקלט שהוא עצמו ידחה.
test("תאריכים: הדוגמה שמוצגת לאורח היא תמיד עתידית, לא קבועה בקוד", async () => {
  const p = await checkinUpTo("waiting_dates");
  sent.length = 0;
  await bot.handleIncoming(p, "בלגן בלי תאריך"); // קלט לא קריא → מוצגת דוגמה
  const body = lastBody();
  const dates = [...body.matchAll(/(\d{2})\/(\d{2})\/(\d{4})/g)];
  assert.ok(dates.length >= 1, `אמורה להופיע דוגמת תאריך: ${body}`);
  for (const [, dd, mm, yyyy] of dates) {
    const shown = new Date(Date.UTC(+yyyy, +mm - 1, +dd));
    assert.ok(shown.getTime() > Date.now(), `הדוגמה ${dd}/${mm}/${yyyy} כבר עברה`);
  }
});

test("צבירת תאריכים: תשובה מלאה בהודעה אחת עדיין עובדת (בלי זיהום משארית)", async () => {
  const p = await checkinUpTo("waiting_dates");

  // חצי מידע ראשון שנזכר, ואז תשובה *מלאה* — התשובה המלאה גוברת.
  sent.length = 0;
  await bot.handleIncoming(p, "3 לילות");
  sent.length = 0;
  await bot.handleIncoming(p, "20/07/2027 - 22/07/2027"); // מלא בעצמו, 2 לילות
  assert.match(lastBody(), /נכון\?/, "מבקש אישור על התשובה המלאה");
  assert.match(lastBody(), /22/, "עזיבה 22/7 מהתשובה המלאה — לא 23/7 מ-3 הלילות הישנים");
});

// ════════════════════════════════════════════════════════
//  Bug #3 — מספר חדר חובה בכל פנייה למחלקה "בתוך החדר"
//  ----------------------------------------------------------
//  אורח בלי צ'ק אין (אין חדר בסשן) שמבקש ניקיון/אחזקה/רום סרוויס —
//  הבוט קודם מבקש מספר חדר, ורק אז מעביר את הבקשה, עם החדר.
// ════════════════════════════════════════════════════════
test("Bug #3: בקשת ניקיון בלי חדר — הבוט מבקש מספר חדר לפני ההעברה", async () => {
  const { hotelConfig } = await import("./config.js");
  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  sent.length = 0;

  aiReply = "בשמחה! [HK:עוד שתי מגבות]";
  await bot.handleIncoming(p, "אפשר עוד מגבות?");

  // עדיין לא הועבר למשק הבית — אין חדר.
  assert.ok(!sent.some(s => s.to === hotelConfig.housekeeping_number), "אסור להעביר בלי מספר חדר");
  assert.match(lastBody(), /חדר/, `הבוט חייב לבקש מספר חדר: ${lastBody()}`);
  assert.ok(!lastBody().includes("["), "אין דליפת תג");

  // האורח מוסר את מספר החדר → הבקשה מועברת עם החדר.
  sent.length = 0;
  await bot.handleIncoming(p, "חדר 808");
  const staff = sent.find(s => s.to === hotelConfig.housekeeping_number);
  assert.ok(staff, "אחרי מסירת החדר — הבקשה מועברת למשק הבית");
  assert.match(staff.body, /808/, "מספר החדר מופיע בפנייה למחלקה");
  assert.match(staff.body, /מגבות/, "פרטי הבקשה נשמרו");
});

test("Bug #3: אורח מחובר (יש חדר) — בקשת מחלקה עוברת מיד עם החדר", async () => {
  const { hotelConfig } = await import("./config.js");
  const { p } = await checkedInGuest(); // חדר 412
  sent.length = 0;

  aiReply = "מיד! [MAINTENANCE:המזגן לא מקרר]";
  await bot.handleIncoming(p, "המזגן לא עובד");

  const staff = sent.find(s => s.to === hotelConfig.maintenance_number);
  assert.ok(staff, "בקשת אחזקה עוברת מיד לאורח מחובר");
  assert.match(staff.body, /412/, "מספר החדר של האורח המחובר מופיע");
});

test("Bug #3: מונית (קונסיירז') לא נחסמת על מספר חדר — לא 'בתוך החדר'", async () => {
  const { hotelConfig } = await import("./config.js");
  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  sent.length = 0;

  aiReply = "אני מטפל בזה עבורך! [CONCIERGE:taxi|מונית לנתב\"ג ב-06:00, נוסע אחד]";
  await bot.handleIncoming(p, "אפשר מונית לשדה התעופה?");

  // בקשת מונית אינה "לחדר" — עוברת מיד לקונסיירז', בלי לבקש מספר חדר.
  const staff = sent.find(s => s.to === hotelConfig.concierge_number);
  assert.ok(staff, "בקשת מונית עוברת מיד לקונסיירז'");
  assert.ok(!lastBody().includes("["), "אין דליפת תג");
});

// ════════════════════════════════════════════════════════
//  Bug #1 — לעולם לא שקט: אימות זהות תקוע → בדיקה ידנית
//  ----------------------------------------------------------
//  שורש השקט בשטח: fetchMedia נתקע (בלי timeout) והאורח נשאר על
//  "🔎 בודק…" לנצח. עכשיו כשל/תקיעה באימות → הצ'ק אין ממשיך.
// ════════════════════════════════════════════════════════
test("Bug #1: אימות זהות שזורק שגיאה → האורח לא נתקע, הצ'ק אין ממשיך", async () => {
  const savedIdResult = idResult;
  const p = await checkinUpTo("waiting_id");
  sent.length = 0;

  // מדמה תקלה טכנית באימות (כמו fetchMedia שנכשל/timeout).
  const idMod = await import("./idverify/index.js");
  const prev = idMod.idVerify.verifyDocument;
  idMod.idVerify.verifyDocument = async () => { throw new Error("boom (media fetch timeout)"); };
  try {
    await bot.handleIncoming(p, "", IMG);
    // האורח קיבל מענה (לא שקט) והצ'ק אין התקדם לשלב התנאים.
    assert.ok(sent.length > 0, "אסור שקט אחרי כשל אימות");
    assert.match(allBodies(), /תנאי השהייה|אני מאשר/, "הצ'ק אין ממשיך לשלב התנאים");
  } finally {
    idMod.idVerify.verifyDocument = prev;
    idResult = savedIdResult;
  }
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
  // Bug #6: הניסוח האלגנטי בגוף ראשון ("אני מטפל בזה עבורך"), בלי להזכיר
  // "קונסיירז' אמיתי/אנושי" או מנגנון פנימי.
  assert.match(he, /אני מטפל בזה עבורך/, "הניסוח האלגנטי המותר");
  assert.match(he, /אל תזכיר.*הקונסיירז' האמיתי/s, "איסור מפורש להזכיר 'קונסיירז' אמיתי'");
  assert.match(he, /\[CONCIERGE:taxi\|/, "הפורמט המדויק מודגם ל-AI");

  const en = await askConcierge("Can I get a taxi?");
  assert.match(en, /"I've booked you a taxi for 20:00"/);
  assert.match(en, /taking care of this for you/i, "elegant first-person phrasing");
  assert.match(en, /the real concierge/i, "explicit ban on mentioning the real concierge");
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
  assert.equal(detectEmergency("נפצעתי, אני מדמם")?.kind, "medical"); // גוף ראשון (הלקוח ציין)
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
  assert.equal(detectEmergency("חתכתי את הלחם"), null, "'חתכתי את הלחם' אינו פציעה");
  assert.equal(detectEmergency("המזגן לא עובד"), null, "תקלת מזגן אינה חירום");
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

  // תקלה חולפת (unavailable) → retry עם backoff לפני ויתור. 3 ניסיונות.
  assert.equal(placesCalls.length, 3, "התבצע retry על תקלה חולפת (3 ניסיונות)");
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

// ════════════════════════════════════════════════════════
//  תיקון חמור — אימות מסמך זהות אמיתי (סלפי/צילום מסך נדחים)
//  ----------------------------------------------------------
//  נצפה בשטח: אורח שלח סלפי (תמונת פנים) והבוט אישר כאילו זו תעודה.
//  הבדיקות מוודאות שרק ת"ז/דרכון אמיתיים וקריאים מתקבלים.
// ════════════════════════════════════════════════════════

test("זהות: סלפי נדחה — לא נשמר, ומבקשים ת\"ז/דרכון", async () => {
  const { MockIdProvider } = await import("./idverify/MockIdProvider.js");
  const provider = new MockIdProvider();

  // ה-vision מזהה תמונת פנים ללא מסמך → shows_document=false, doc_type=selfie.
  visionResult = { valid: false, isId: false, showsDocument: false, readable: false,
                   confidence: 0.95, docType: "selfie",
                   reasonHe: "זו נראית כמו תמונת פנים ולא כמו תעודה.", reasonEn: "" };
  const r = await provider.verifyDocument({ mediaUrl: "https://x/selfie", contentType: "image/jpeg" });

  assert.equal(r.status, "rejected", "סלפי חייב להידחות");
  assert.equal(r.storedPath, null, "סלפי לא נשמר לדיסק");
  assert.match(r.reasonHe, /תעוד|פנים/, "הסבר מנומס לאורח");
});

test("זהות: צילום מסך / תמונה אקראית נדחים (shows_document=false)", async () => {
  const { MockIdProvider } = await import("./idverify/MockIdProvider.js");
  const provider = new MockIdProvider();

  for (const docType of ["other", "selfie"]) {
    visionResult = { valid: false, isId: false, showsDocument: false, readable: false,
                     confidence: 0.9, docType, reasonHe: "", reasonEn: "" };
    const r = await provider.verifyDocument({ mediaUrl: "https://x/1", contentType: "image/jpeg" });
    assert.equal(r.status, "rejected", `${docType} היה אמור להידחות`);
    assert.equal(r.storedPath, null, `${docType} לא אמור להישמר`);
    assert.match(r.reasonHe, /תעודת זהות|דרכון/, "מבקשים ת\"ז/דרכון");
    assert.match(r.reasonEn, /ID card|passport/, "וגם באנגלית");
  }
});

test("זהות (מקצה לקצה): סלפי בשלב הזהות → לא 'אומת', נשארים בשלב", async () => {
  const p = await checkinUpTo("waiting_id");
  sent.length = 0;

  idResult = { success: false, status: "rejected", documentId: null, documentType: "selfie",
               storedPath: null, reasonHe: "זו נראית כמו תמונת פנים, לא תעודה. אשמח לתעודת זהות או דרכון.", reasonEn: "" };
  await bot.handleIncoming(p, "", IMG);
  idResult = { success: true, status: "verified", documentId: "d1", documentType: "id_card", storedPath: "/demo/id.jpg", reasonHe: "", reasonEn: "" };

  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.ok(!/אומתה בהצלחה/.test(guest), "סלפי לא אמור להיות מאושר כתעודה");
  assert.ok(!/תנאי השהייה/.test(guest), "אסור להתקדם עם סלפי");
  assert.match(guest, /תעודת זהות|דרכון|פנים/, "מבקשים תעודה אמיתית");
});

test("זהות: המסר לאורח לא מזכיר 'רישיון נהיגה' — ניסוח גנרי", async () => {
  const { MockIdProvider } = await import("./idverify/MockIdProvider.js");
  const provider = new MockIdProvider();
  visionResult = { valid: true, isId: true, showsDocument: true, readable: true,
                   confidence: 0.97, docType: "drivers_license", reasonHe: "", reasonEn: "" };
  const r = await provider.verifyDocument({ mediaUrl: "https://x/1", contentType: "image/jpeg" });
  assert.equal(r.status, "rejected");
  assert.ok(!/רישיון/.test(r.reasonHe), `אין להזכיר רישיון נהיגה לאורח: ${r.reasonHe}`);
  assert.ok(!/driver/i.test(r.reasonEn), `no driver's-license wording: ${r.reasonEn}`);
  assert.match(r.reasonHe, /תעודת זהות|דרכון/);
});

// ════════════════════════════════════════════════════════
//  אבטחה — מסמכי זיהוי מוצפנים at-rest
// ════════════════════════════════════════════════════════
test("אבטחה: מצב שמירה (בסיס חוקי) — מסמך נשמר מוצפן (.enc), לא plaintext, ומתפענח", async () => {
  const { MockIdProvider } = await import("./idverify/MockIdProvider.js");
  const { decryptBuffer } = await import("./idverify/crypto.js");
  const provider = new MockIdProvider();

  // ה-vision מזהה ת"ז אמיתית. מדמים מלון עם בסיס חוקי לשמירה דרך env override.
  visionResult = { valid: true, isId: true, showsDocument: true, readable: true,
                   confidence: 0.95, docType: "id_card", reasonHe: "", reasonEn: "" };
  const prev = process.env.ID_STORE_MODE;
  process.env.ID_STORE_MODE = "store_encrypted";   // = מלון עם retain_image + legal_basis
  let r;
  try {
    r = await provider.verifyDocument({ reservationId: "enc-test", mediaUrl: "https://x/1", contentType: "image/jpeg" });
    assert.equal(r.status, "verified");
    assert.ok(r.storedPath, "המסמך נשמר");
    assert.match(r.storedPath, /\.enc$/, "הקובץ נשמר עם סיומת .enc");

    const onDisk = fs.readFileSync(r.storedPath);
    assert.ok(!onDisk.toString("utf8").includes("fake-image"), "הקובץ על הדיסק לא אמור להיות plaintext");
    assert.equal(decryptBuffer(onDisk).toString("utf8"), "fake-image", "הפענוח מחזיר את התוכן המקורי");

    const meta = JSON.parse(fs.readFileSync(r.storedPath.replace(/\.enc$/, ".json"), "utf8"));
    assert.equal(meta.encrypted, true);
    assert.match(meta.encryption.algorithm, /aes-256-gcm/);
  } finally {
    if (prev === undefined) delete process.env.ID_STORE_MODE; else process.env.ID_STORE_MODE = prev;
    for (const f of [r?.storedPath, r?.storedPath?.replace(/\.enc$/, ".json")]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

test("אבטחה: ברירת מחדל verify-then-discard — התמונה לא נשמרת אחרי אימות", async () => {
  const { MockIdProvider } = await import("./idverify/MockIdProvider.js");
  const provider = new MockIdProvider();

  visionResult = { valid: true, isId: true, showsDocument: true, readable: true,
                   confidence: 0.95, docType: "passport", fields: { full_name: "Jane Doe", document_number: "X1" },
                   reasonHe: "", reasonEn: "" };
  const prev = process.env.ID_STORE_MODE;
  delete process.env.ID_STORE_MODE;   // ברירת מחדל = discard
  try {
    const r = await provider.verifyDocument({ reservationId: "discard-test", mediaUrl: "https://x/2", contentType: "image/jpeg" });
    assert.equal(r.status, "verified");
    assert.equal(r.storedPath, null, "התמונה לא נשמרה");
    assert.equal(r.discarded, true, "סומן discarded");
    assert.ok(r.fields && r.fields.full_name === "Jane Doe", "חולצו השדות המינימליים במקום התמונה");
  } finally {
    if (prev !== undefined) process.env.ID_STORE_MODE = prev;
  }
});

// ════════════════════════════════════════════════════════
//  שיפור — פרטי צ'ק אין נוספים (אורחים / ETA / רכב / בקשות)
// ════════════════════════════════════════════════════════
test("פרטים: parseCheckinDetails מחלץ אורחים/שעה/רכב/בקשה מהודעה אחת", async () => {
  const { parseCheckinDetails } = await import("./validate.js");

  const d = parseCheckinDetails("2 אורחים, נגיע בסביבות 15:00, רכב 12-345-67, קומה גבוהה");
  assert.equal(d.guests, 2);
  assert.equal(d.eta, "15:00");
  assert.equal(d.vehicle, "12-345-67");
  assert.match(d.requests, /קומה גבוהה/);

  const en = parseCheckinDetails("we are 3, arriving around 9pm");
  assert.equal(en.guests, 3);
  assert.equal(en.eta, "9pm");

  assert.equal(parseCheckinDetails("דלג").skipped, true);
  assert.equal(parseCheckinDetails("skip").skipped, true);
  assert.equal(parseCheckinDetails("").skipped, true);
});

test("פרטים: שלב הפרטים מופיע אחרי אישור התאריכים, וניתן לדלג", async () => {
  const p = await checkinUpTo("waiting_dates_confirm");
  sent.length = 0;
  await bot.handleIncoming(p, "כן");            // אישור תאריכים → שלב הפרטים
  assert.match(lastBody(), /כמה אורחים|פרטים/, "מוצג שלב הפרטים הנוספים");
  assert.match(lastBody(), /דלג/, "אפשר לדלג");

  sent.length = 0;
  await bot.handleIncoming(p, "דלג");            // מדלגים → שלב הזהות
  assert.match(lastBody(), /תעודת הזהות|הדרכון/, "אחרי דילוג — ממשיכים לזהות");
});

test("פרטים: הפרטים נשמרים על ההזמנה ומוצגים בסיכום + לצוות", async () => {
  const { reservations, completeCheckin } = await import("./checkin.js");
  const p = freshGuest();
  await bot.handleIncoming(p, "צק אין");
  await bot.handleIncoming(p, "אופק כהן");
  await bot.handleIncoming(p, "1234");
  await bot.handleIncoming(p, STAY.text);
  await bot.handleIncoming(p, "כן");
  await bot.handleIncoming(p, "אנחנו 2, נגיע ב-16:00, רכב 12-345-67, מבקשים קומה גבוהה");
  await bot.handleIncoming(p, "", IMG);
  await bot.handleIncoming(p, "אני מאשר");

  const res = Object.values(reservations).find(r => r.phone === p && r.stage === "pending_payment");
  assert.ok(res, "נוצרה הזמנה");
  assert.equal(res.guestsCount, 2, "מספר האורחים נשמר");
  assert.equal(res.eta, "16:00", "שעת ההגעה נשמרה");
  assert.equal(res.vehiclePlate, "12-345-67", "מספר הרכב נשמר");
  assert.match(res.specialRequests, /קומה גבוהה/, "הבקשה המיוחדת נשמרה");

  sent.length = 0;
  await completeCheckin(res.id, "305");
  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(guest, /אורחים: 2/, "האורח רואה את הפרטים בסיכום");
  assert.match(guest, /16:00/);
  const staff = sent.filter(s => s.to !== p).map(s => s.body).join("\n");
  assert.match(staff, /12-345-67/, "הצוות מקבל את מספר הרכב לחניה");
  assert.match(staff, /קומה גבוהה/, "הצוות מקבל את הבקשה המיוחדת");
});

// ════════════════════════════════════════════════════════
//  שיפור — צ'ק אאוט: חשבונית מקובצת + משוב
// ════════════════════════════════════════════════════════
test("חשבונית: פריטים מקובצים לפי קטגוריה, מיני-בר בנפרד עם סכום ביניים", async () => {
  const { p, reservations } = await checkedInGuest();
  const { addFolioItem } = await import("./checkin.js");
  const res = Object.values(reservations).find(r => r.phone === p);
  addFolioItem(res.id, "MINIBAR", "קולה", 2500);
  addFolioItem(res.id, "MINIBAR", "בירה", 3500);
  addFolioItem(res.id, "RESTAURANT", "ארוחת ערב", 12000);
  sent.length = 0;

  await bot.handleIncoming(p, "צק אאוט");
  const bill = lastBody();
  assert.match(bill, /\*מיני בר\*/, "קטגוריית מיני בר ככותרת נפרדת");
  assert.match(bill, /קולה — ₪25\.00/);
  assert.match(bill, /בירה — ₪35\.00/);
  assert.match(bill, /סה"כ מיני בר: ₪60\.00/, "סכום ביניים למיני בר");
  assert.match(bill, /\*מסעדה\*/, "קטגוריית מסעדה נפרדת");
});

test("משוב: אחרי צ'ק אאוט מבקשים משוב; דירוג נשמר, האורח מקבל תודה, ההנהלה מעודכנת", async () => {
  const { p, reservations } = await checkedInGuest();
  await bot.handleIncoming(p, "צק אאוט");
  sent.length = 0;
  await bot.handleIncoming(p, "כן");             // אישור צ'ק אאוט → בקשת משוב

  const afterCheckout = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(afterCheckout, /1 עד 5|לשמוע איך הייתה השהייה/, "מוצגת בקשת משוב עדינה");

  sent.length = 0;
  await bot.handleIncoming(p, "5, הכל היה מושלם!");  // האורח נותן משוב

  const thanks = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(thanks, /תודה/, "האורח מקבל תודה חמה");

  const res = Object.values(reservations).find(r => r.phone === p);
  assert.ok(res.feedback, "המשוב נשמר על ההזמנה");
  assert.equal(res.feedback.rating, 5, "הדירוג חולץ ונשמר");
  assert.match(res.feedback.text, /מושלם/, "הטקסט נשמר");

  const staff = sent.filter(s => s.to !== p).map(s => s.body).join("\n");
  assert.match(staff, /משוב אורח/, "ההנהלה/קבלה קיבלה את המשוב");
});

test("משוב: אפשר לדלג על המשוב — פרידה חמה, בלי לשמור", async () => {
  const { p, reservations } = await checkedInGuest();
  await bot.handleIncoming(p, "צק אאוט");
  await bot.handleIncoming(p, "כן");
  sent.length = 0;
  await bot.handleIncoming(p, "דלג");

  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(guest, /תודה|להתראות|נסיעה טובה/, "פרידה חמה גם בדילוג");
  const res = Object.values(reservations).find(r => r.phone === p);
  assert.equal(res.feedback, null, "בלי משוב — לא נשמר כלום");
});

test("משוב: דירוג נמוך → הסלמה בעדיפות גבוהה להנהלה", async () => {
  const { p } = await checkedInGuest();
  await bot.handleIncoming(p, "צק אאוט");
  await bot.handleIncoming(p, "כן");
  sent.length = 0;
  await bot.handleIncoming(p, "2 - השירות היה איטי");

  const staff = sent.filter(s => s.to !== p).map(s => s.body).join("\n");
  assert.match(staff, /דירוג: 2\/5/, "הדירוג הנמוך מועבר");
  assert.match(staff, /דחוף/, "דירוג נמוך מסומן כדחוף");
});

test("משוב באנגלית: אורח אנגלי מקבל בקשת משוב ותודה באנגלית — בלי עברית", async () => {
  const { p } = await checkedInGuest({ lang: "en" });
  await bot.handleIncoming(p, "check out");
  sent.length = 0;
  await bot.handleIncoming(p, "yes");
  const ask = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(ask, /how your stay was|rate it/i, "בקשת משוב באנגלית");
  assert.ok(!/[֐-׿]/.test(ask), `עברית דלפה: ${ask}`);

  sent.length = 0;
  await bot.handleIncoming(p, "5, wonderful stay");
  const thanks = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(thanks, /Thank you/i);
  assert.ok(!/[֐-׿]/.test(thanks), `עברית דלפה בתודה: ${thanks}`);
});

// ════════════════════════════════════════════════════════
//  אישור לקוח — ניתוב בקשות למחלקות (7 מחלקות)
// ════════════════════════════════════════════════════════
test("ניתוב: שירות חדרים — 'קפה לחדר' מגיע למחלקת Room Service (וואטסאפ + מייל)", async () => {
  const { hotelConfig } = await import("./config.js");
  // אורח מחובר — יש מספר חדר, כך שהבקשה הפנים-חדרית עוברת מיד (Bug #3).
  const { p } = await checkedInGuest();
  sent.length = 0;

  aiReply = "בשמחה, מעביר לשירות החדרים! ☕ [ROOMSERVICE:קפה חם + חלב לחדר 305]";
  await bot.handleIncoming(p, "אפשר קפה לחדר?");

  const staff = sent.find(s => s.to === hotelConfig.room_service_number);
  assert.ok(staff, "שירות החדרים חייב לקבל את הבקשה");
  assert.match(staff.body, /ROOM SERVICE/, "כותרת המחלקה קריאה (לא ROOM_SERVICE)");
  assert.match(staff.body, /קפה חם/, "הפרטים עוברים");
  assert.match(staff.body, /412/, "מספר החדר חייב להופיע בפנייה למחלקה (Bug #3)");
  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.ok(!guest.includes("["), `תג דלף לאורח: ${guest}`);
});

test("ניתוב: ביטחון (לא-חירום) — 'אדם חשוד' מגיע ל-Security בעדיפות גבוהה", async () => {
  const { hotelConfig } = await import("./config.js");
  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  sent.length = 0;

  aiReply = "תודה שעדכנת, אני מטפל בזה מיד. [SECURITY:אדם לא מזוהה מסתובב בקומה 4]";
  await bot.handleIncoming(p, "מסתובב פה מישהו חשוד במסדרון");

  const staff = sent.find(s => s.to === hotelConfig.security_number);
  assert.ok(staff, "הביטחון חייב לקבל התראה");
  assert.match(staff.body, /דחוף/, "עניין ביטחוני מסומן כדחוף");
  assert.match(staff.body, /אדם לא מזוהה/);
});

test("ניתוב: כל תג מגיע למחלקה הנכונה (וואטסאפ)", async () => {
  const { hotelConfig } = await import("./config.js");
  // roomBound=true → מחלקה "בתוך החדר": הבוט מבקש מספר חדר לפני ההעברה (Bug #3).
  const cases = [
    ["[HK:עוד מגבות לחדר]",              hotelConfig.housekeeping_number,  /HOUSEKEEPING/, true],
    ["[MAINTENANCE:נורה שרופה בחדר]",    hotelConfig.maintenance_number,   /MAINTENANCE/,  true],
    ["[ROOMSERVICE:כריך וקולה לחדר]",    hotelConfig.room_service_number,  /ROOM SERVICE/, true],
    ["[SECURITY:רעש חשוד מחדר 210]",     hotelConfig.security_number,      /SECURITY/,     false],
    ["[RECEPTION:שאלה על החשבון]",       hotelConfig.reception_number,     /RECEPTION/,    false],
  ];
  for (const [tag, number, title, roomBound] of cases) {
    const p = freshGuest();
    await bot.handleIncoming(p, "שלום");
    sent.length = 0;
    aiReply = `בסדר גמור. ${tag}`;
    await bot.handleIncoming(p, "בבקשה");

    if (roomBound) {
      // אורח בלי צ'ק אין — אין מספר חדר. הבוט חייב לבקש אותו קודם ולא
      // להעביר בקשה "עיוורת" בלי חדר.
      const ask = sent.filter(s => s.to === p).map(s => s.body).join("\n");
      assert.match(ask, /חדר/, `${tag}: הבוט חייב לבקש מספר חדר לפני ההעברה`);
      assert.ok(!sent.some(s => s.to === number), `${tag}: אסור להעביר למחלקה בלי מספר חדר`);
      sent.length = 0;
      await bot.handleIncoming(p, "417"); // האורח מוסר את מספר החדר
    }

    const staff = sent.find(s => s.to === number);
    assert.ok(staff, `${tag}: לא הגיע למחלקה הנכונה`);
    assert.match(staff.body, title, `${tag}: כותרת מחלקה שגויה`);
    if (roomBound) assert.match(staff.body, /417/, `${tag}: מספר החדר חייב להופיע בפנייה למחלקה`);
    const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
    assert.ok(!guest.includes("["), `${tag}: תג דלף לאורח`);
  }
});

test("ניתוב: הנחיות המחלקות + התגים החדשים מגיעים ל-AI — HE + EN", async () => {
  const he = await askConcierge("מה יש במלון?");
  assert.match(he, /המחלקות של המלון/, "סעיף מחלקות בעברית");
  assert.match(he, /\[ROOMSERVICE:/, "תג שירות חדרים");
  assert.match(he, /\[SECURITY:/, "תג ביטחון");
  assert.match(he, /בא לי קפה לחדר.*ROOMSERVICE/s, "דוגמת ניתוב קפה→שירות חדרים");
  assert.match(he, /נשברה נורה.*MAINTENANCE/s, "דוגמת ניתוב נורה→אחזקה");

  const en = await askConcierge("what's in the hotel?");
  assert.match(en, /THE HOTEL'S DEPARTMENTS/i);
  assert.match(en, /\[ROOMSERVICE:/);
  assert.match(en, /\[SECURITY:/);
});

test("ניתוב: חירום דטרמיניסטי — 'נפצעתי' → 101 מיד, בלי תלות ב-AI", async () => {
  const { detectEmergency } = await import("./emergency.js");
  assert.equal(detectEmergency("נפצעתי!")?.kind, "medical");

  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  sent.length = 0;
  aiCalls = 0;
  await bot.handleIncoming(p, "נפצעתי, אני מדמם");
  const guest = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.match(guest, /101/, "הנחיית חירום מיידית");
  assert.equal(aiCalls, 0, "חירום לא עובר ב-AI");
});

// ════════════════════════════════════════════════════════
//  אישור לקוח — עברית נטולת-מין בהודעות המערכת
// ════════════════════════════════════════════════════════
test("מגדר: פתיחת הצ'ק אין נטולת-מין — בלי 'ברוך הבא' הזכרי ובלי 'בוא'", async () => {
  const p = freshGuest();
  sent.length = 0;
  await bot.handleIncoming(p, "צק אין");
  const body = lastBody();
  assert.ok(!/ברוך הבא/.test(body), `'ברוך הבא' מגדר זכר: ${body}`);
  assert.ok(!/\bבוא\b/.test(body), `'בוא' מגדר זכר: ${body}`);
  assert.match(body, /שמך המלא/, "עדיין מבקש שם");
});

test("מגדר: הכלל להתאמת מין/מספר לפי כתיבת האורח מגיע ל-AI", async () => {
  const he = await askConcierge("מה שעות הספא?");
  assert.match(he, /מין ומספר/, "חוק המין והמספר");
  assert.match(he, /איך שהוא עצמו כותב|מתוך.*כותב/, "זיהוי מין לפי כתיבת האורח");
  assert.match(he, /נטול-מין/, "ברירת מחדל נטולת-מין כשלא ידוע");
});

test("מגדר: פרידת הצ'ק אאוט + המשוב עקביים בלשון יחיד נטולת-מין", async () => {
  const { p } = await checkedInGuest();
  await bot.handleIncoming(p, "צק אאוט");
  await bot.handleIncoming(p, "כן");
  sent.length = 0;
  await bot.handleIncoming(p, "5, היה מושלם");
  const thanks = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  // בלי צורות רבים ("אתכם"/"לראותכם") שסותרות את "לראותך" בצ'ק אאוט
  assert.ok(!/אתכם|לראותכם|ששהיתם/.test(thanks), `ערבוב יחיד/רבים בפרידה: ${thanks}`);
  assert.match(thanks, /לראותך|אותך/, "לשון יחיד נטולת-מין");
});

// ════════════════════════════════════════════════════════
//  מולטי-טננט — בידוד אנשי הקשר בין מלונות
// ════════════════════════════════════════════════════════
test("מולטי-טננט: אנשי הקשר נשלפים לפי מלון, בלי דליפה בין מלונות", async () => {
  const { departmentContacts, DEPARTMENTS, checkDepartmentContacts } = await import("./config.js");
  const { db, DEFAULT_HOTEL_ID } = await import("./db.js");

  // מלון שני עם מספרים ומיילים משלו — נכתב לאותה טבלה, hotel_id אחר.
  db.prepare(`INSERT INTO config (hotel_id, data, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(hotel_id) DO UPDATE SET data = excluded.data`)
    .run("hotel-b", JSON.stringify({
      housekeeping_number: "whatsapp:+972999000111",
      housekeeping_email:  "hk@hotel-b.co.il",
    }), new Date().toISOString());

  const a = departmentContacts("housekeeping", DEFAULT_HOTEL_ID);
  const b = departmentContacts("housekeeping", "hotel-b");

  assert.notEqual(a.whatsapp, b.whatsapp, "כל מלון — מספר וואטסאפ משלו");
  assert.notEqual(a.email,    b.email,    "כל מלון — מייל משלו");
  assert.equal(b.whatsapp, "whatsapp:+972999000111");
  assert.equal(b.email,    "hk@hotel-b.co.il");

  // מלון שלא הגדיר מחלקה — נופל לברירות המחדל שבקוד, לא לערכים של מלון א'.
  assert.ok(departmentContacts("security", "hotel-b").email, "יש ברירת מחדל, לא ריק");

  // כל המחלקות של מלון הדמו מוגדרות — אחרת בקשות נעלמות בשקט.
  const check = checkDepartmentContacts(DEFAULT_HOTEL_ID);
  assert.equal(check.ok, true, `חסרים אנשי קשר: ${check.missing.join(", ")}`);
  assert.equal(DEPARTMENTS.length, 6);
});

// ════════════════════════════════════════════════════════
//  ניקוי פורמט לוואטסאפ — markdown שוואטסאפ לא יודע להציג
// ════════════════════════════════════════════════════════
test("פורמט: קו מפריד '---' לעולם לא מגיע לאורח", async () => {
  const p = "whatsapp:+972500777099";
  sent.length = 0;
  aiReply = "המלצה ראשונה\n\n---\n\nהמלצה שנייה\n\n### כותרת\n\n\n\nסוף";
  await bot.handleIncoming(p, "מה יש באזור?");
  const body = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.ok(!/^\s*[-_*]{3,}\s*$/m.test(body), `קו מפריד דלף לאורח:\n${body}`);
  assert.ok(!/^#{1,6}\s/m.test(body), "כותרת markdown דלפה לאורח");
  assert.ok(!/\n{3,}/.test(body), "שלוש שורות ריקות ברצף");
  assert.match(body, /\*כותרת\*/, "כותרת markdown הומרה להדגשה של וואטסאפ");
});

test("פורמט: הדגשה '**טקסט**' מומרת לכוכבית אחת (וואטסאפ)", async () => {
  const p = "whatsapp:+972500777098";
  sent.length = 0;
  aiReply = "הייתי ממליץ על **האש** — מסעדת גריל, ועל **מיטבר** גם.";
  await bot.handleIncoming(p, "המלצה?");
  const body = sent.filter(s => s.to === p).map(s => s.body).join("\n");
  assert.ok(!body.includes("**"), `כוכבית כפולה דלפה לאורח:\n${body}`);
  assert.match(body, /\*האש\*/);
  assert.match(body, /\*מיטבר\*/);
});

// ════════════════════════════════════════════════════════
//  אישור תנאים — משפט טבעי, לא מחרוזת מדויקת
// ════════════════════════════════════════════════════════
test("תנאים: 'אני מאשר את התנאים' מתקבל, שלילה נדחית", async () => {
  const { validateTermsConfirmation } = await import("./validate.js");
  for (const yes of ["אני מאשר", "אני מאשר את התנאים", "מאשרת את התנאים",
                     "אני מסכים לתנאים", "אני מאשר/ת", "I confirm", "I agree to the terms"]) {
    assert.equal(validateTermsConfirmation(yes).ok, true, `"${yes}" אמור להתקבל`);
  }
  for (const no of ["אני לא מאשר", "לא מסכים לתנאים", "I do not agree", "I decline"]) {
    const r = validateTermsConfirmation(no);
    assert.equal(r.ok, false, `"${no}" אמור להידחות`);
    assert.equal(r.reason, "declined", `"${no}" הוא סירוב, לא קלט לא ברור`);
  }
  // "כן" עדיין אינו אישור משפטי לתנאים.
  assert.equal(validateTermsConfirmation("כן").reason, "not_explicit");
});

// ════════════════════════════════════════════════════════
//  שעות פתיחה — בלי נתון, אין אמירה
// ════════════════════════════════════════════════════════
test("מקומות: openNow חסר לא מגיע ל-AI כ-null (שלא ינחש 'פתוח עכשיו')", async () => {
  const { places } = await import("./places/index.js");
  const orig = places.searchNearby.bind(places);
  places.searchNearby = async () => ({
    ok: true,
    results: [
      { name: "מקום עם נתון",  address: "רחוב א 1", rating: 4.5, ratingCount: 100,
        priceSymbol: "₪₪", openNow: true,  distanceText: "300 מ׳", category: "restaurant" },
      { name: "מקום בלי נתון", address: "רחוב ב 2", rating: 4.2, ratingCount: 80,
        priceSymbol: "₪₪", openNow: null,  distanceText: "500 מ׳", category: "restaurant" },
    ],
  });
  try {
    sent.length = 0;
    aiScript = (params, i) => i === 0 ? {
      content: [{ type: "tool_use", id: "t1", name: "search_nearby_places",
                  input: { query: "מסעדה" } }],
      stop_reason: "tool_use",
    } : null;
    aiReply = "בסדר.";
    await bot.handleIncoming("whatsapp:+972500777097", "מסעדה בבקשה");

    // ה-tool_result שנשלח ל-AI בקריאה השנייה
    const raw = JSON.stringify(aiParams.messages);
    assert.ok(raw.includes("מקום עם נתון") && raw.includes("מקום בלי נתון"), "שני המקומות הועברו ל-AI");
    assert.ok(!/openNow\\?":\s*null/.test(raw), "openNow=null לא נשלח ל-AI — הוא נשמט");
    assert.ok(/openNow\\?":\s*true/.test(raw), "openNow=true כן נשלח");
    assert.ok(raw.includes("never say whether it is open"), "הוראה מפורשת לא לנחש שעות");
  } finally {
    places.searchNearby = orig;
    aiScript = null;
  }
});

// ════════════════════════════════════════════════════════
//  "אין חדר" — שני מצבים שונים, שני נוסחים שונים
// ════════════════════════════════════════════════════════
test("התראה: חדר שטרם הוקצה בצ'ק אין ≠ אורח שמיקומו לא ידוע", async () => {
  // (א) אמצע צ'ק אין — החדר טרם הוקצה. זה מהלך תקין, לא תקלה.
  const p = await checkinUpTo("waiting_id");
  sent.length = 0;
  await bot.handleIncoming(p, "", { url: "https://x/id.jpg", contentType: "image/jpeg" });
  const idAlert = sent.filter(s => s.to !== p).map(s => s.body).join("\n");
  assert.match(idAlert, /טרם הוקצה/, `נוסח החדר בצ'ק אין: ${idAlert}`);
  assert.ok(!/יש ליצור קשר עם האורח לבירור המיקום/.test(idAlert),
    "אסור להציג צ'ק אין תקין כאילו איבדנו את האורח");

  // (ב) אורח שמבקש שירות ואיננו יודעים איפה הוא — כן תקלה, וכן צריך לצלצל.
  const p2 = "whatsapp:+972500777096";
  sent.length = 0;
  await bot.notifyStaff({
    dept: "housekeeping", roomNumber: null, guestName: "אורח", phone: p2, message: "מגבות",
  });
  const lost = sent.map(s => s.body).join("\n");
  assert.match(lost, /לא ידוע/, "מיקום לא ידוע נשאר מסומן ככזה");
  assert.match(lost, /יש ליצור קשר/, "והוא עדיין הוראת פעולה לצוות");
});

// ════════════════════════════════════════════════════════
//  תאריכים שכבר עברו / לא הגיוניים — הבוט כפקיד קבלה אמיתי
//  ----------------------------------------------------------
//  אורח כותב מה שבא לו. הבוט לעולם לא רושם הזמנה לא הגיונית, ותמיד
//  אומר *מה בדיוק* הבעיה — הודעה שגויה מבלבלת יותר מאשר לא לענות.
//  "היום" בכל הבדיקות האלה קבוע: 20/07/2026, כדי שלא ירקבו עם הזמן.
// ════════════════════════════════════════════════════════
const D_NOW = new Date("2026-07-20T09:00:00Z");
const stay = async (text) => (await import("./validate.js")).validateStayDates(text, D_NOW);

// ── 1. תאריך הגעה שכבר עבר ──
test("תאריכים 1: הגעה שכבר עברה נדחית ולא נרשמת", async () => {
  for (const text of ["מ-10.7, 3 לילות", "10.7 - 13.7", "1.1.2020 - 5.1.2020",
                      "from 10.7, 3 nights", "10/07/2026 - 13/07/2026"]) {
    const r = await stay(text);
    assert.equal(r.ok, false, `"${text}" אמור להידחות — ההגעה בעבר`);
    assert.equal(r.reason, "past", `"${text}" — הסיבה חייבת להיות 'past', לא ${r.reason}`);
  }
});

test("תאריכים 1ב: אתמול עדיין קביל (אורח שמאחר בלילה)", async () => {
  const r = await stay("19.7 - 23.7");
  assert.equal(r.ok, true, "הגעה אתמול נשארת קבילה — אורח שמאחר");
  assert.equal(r.value.checkIn, "2026-07-19");
});

test("תאריכים 1ג: תאריך עמוק בעבר ללא שנה מתפרש כשנה הבאה", async () => {
  // "10.5" ביולי = מאי הבא. זו הכוונה הסבירה, והאורח מאשר אותה בשלב
  // האישור עם השנה המלאה לפני שזה ננעל.
  const r = await stay("מ-10.5, 3 לילות");
  assert.equal(r.ok, true);
  assert.equal(r.value.checkIn, "2027-05-10", "מאי הבא, לא מאי שעבר");
});

// ── 2. עזיבה לפני ההגעה ──
test("תאריכים 2: עזיבה לפני ההגעה נדחית עם ההודעה הנכונה", async () => {
  for (const text of ["25.7 - 23.7", "מ-25.7 עד 23.7", "25/07/2026 - 23/07/2026",
                      "from 25.7 to 23.7"]) {
    const r = await stay(text);
    assert.equal(r.ok, false, `"${text}" אמור להידחות`);
    // 🔴 הרגרסיה שנתפסה: בלי שנה זה הפך ל-363 לילות והאורח קיבל
    // "שהייה ארוכה מ-60 לילות" — הודעה שאין לה קשר לבעיה שלו.
    assert.equal(r.reason, "not_after",
      `"${text}" — חייב לומר שהעזיבה לפני ההגעה, לא '${r.reason}'`);
  }
});

test("תאריכים 2ב: הגעה ועזיבה באותו יום = אפס לילות, נדחה", async () => {
  for (const text of ["25.7 - 25.7", "25/07/2026 - 25/07/2026"]) {
    const r = await stay(text);
    assert.equal(r.ok, false, `"${text}" — אפס לילות אינה שהייה`);
    assert.equal(r.reason, "not_after");
  }
});

test("תאריכים 2ג: שהייה שחוצה את סוף השנה עדיין תקינה (לא נדחית בטעות)", async () => {
  // הגלגול לשנה הבאה *נכון* כאן — אסור שהתיקון של 2 ישבור את זה.
  const r = await stay("28.12 - 3.1");
  assert.equal(r.ok, true, `שהייה על פני ראש השנה חייבת לעבוד: ${r.reason}`);
  assert.equal(r.value.checkIn,  "2026-12-28");
  assert.equal(r.value.checkOut, "2027-01-03");
  assert.equal(r.value.nights, 6);
});

// ── 3. תאריך לא הגיוני ──
test("תאריכים 3: תאריך שאינו קיים בלוח השנה נדחה כ-bad_date", async () => {
  for (const text of ["32.13", "32.13 - 35.14", "30.2 - 3.3", "31.4 - 3.5", "0.0 - 1.1"]) {
    const r = await stay(text);
    assert.equal(r.ok, false, `"${text}" אמור להידחות`);
    assert.equal(r.reason, "bad_date",
      `"${text}" — צריך לומר שהתאריך לא קיים, לא '${r.reason}'`);
  }
});

test("תאריכים 3ב: 29 בפברואר בשנה מעוברת כן קיים", async () => {
  const r = await stay("29/02/2028 - 02/03/2028");
  assert.equal(r.ok, true, "2028 היא שנה מעוברת — 29.2 חוקי");
});

test("תאריכים 3ג: תאריך רחוק מדי בעתיד נדחה", async () => {
  for (const text of ["מ-1.1.2050, 3 לילות", "1.1.2050 - 5.1.2050", "מ-1.1.2030, 3 לילות"]) {
    const r = await stay(text);
    assert.equal(r.ok, false, `"${text}" — אף מלון לא רושם הזמנה כזו`);
    assert.equal(r.reason, "too_far");
  }
});

test("תאריכים 3ד: שנה קדימה עדיין בתוך האופק המותר", async () => {
  const r = await stay("1.1.2027 - 5.1.2027");
  assert.equal(r.ok, true, `שנה קדימה זו הזמנה לגיטימית: ${r.reason}`);
});

test("תאריכים 3ה: שהייה ארוכה מ-60 לילות עם שנים מפורשות = too_long", async () => {
  const r = await stay("25.7.2026 - 28.7.2027");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "too_long", "כאן זו באמת שהייה ארוכה, לא טווח הפוך");
});

// ── 4. ביטויים יחסיים ──
test("תאריכים 4: ביטויים יחסיים בעברית מחושבים נכון מהיום", async () => {
  const expect = {
    "היום, 2 לילות":        ["2026-07-20", "2026-07-22"],
    "מחר, 3 לילות":         ["2026-07-21", "2026-07-24"],
    "מחרתיים, 2 לילות":     ["2026-07-22", "2026-07-24"],
    "עוד שבוע, 3 לילות":    ["2026-07-27", "2026-07-30"],
    "בעוד שבוע, 3 לילות":   ["2026-07-27", "2026-07-30"],
    "בעוד שבועיים, 2 לילות":["2026-08-03", "2026-08-05"],
    "בעוד 3 ימים, 2 לילות": ["2026-07-23", "2026-07-25"],
    "בעוד חודש, 2 לילות":   ["2026-08-19", "2026-08-21"],
  };
  for (const [text, [ci, co]] of Object.entries(expect)) {
    const r = await stay(text);
    assert.equal(r.ok, true, `"${text}" אמור להיקלט: ${r.reason}`);
    assert.equal(r.value.checkIn,  ci, `הגעה שגויה עבור "${text}"`);
    assert.equal(r.value.checkOut, co, `עזיבה שגויה עבור "${text}"`);
  }
});

test("תאריכים 4ב: ביטויים יחסיים באנגלית", async () => {
  const expect = {
    "today, 2 nights":            ["2026-07-20", "2026-07-22"],
    "tomorrow, 3 nights":         ["2026-07-21", "2026-07-24"],
    "day after tomorrow, 2 nights":["2026-07-22", "2026-07-24"],
    "in a week, 3 nights":        ["2026-07-27", "2026-07-30"],
    "next week, 3 nights":        ["2026-07-27", "2026-07-30"],
    "in 3 days, 2 nights":        ["2026-07-23", "2026-07-25"],
  };
  for (const [text, [ci, co]] of Object.entries(expect)) {
    const r = await stay(text);
    assert.equal(r.ok, true, `"${text}" אמור להיקלט: ${r.reason}`);
    assert.equal(r.value.checkIn,  ci, `arrival wrong for "${text}"`);
    assert.equal(r.value.checkOut, co, `departure wrong for "${text}"`);
  }
});

test("תאריכים 4ג: שני ביטויים יחסיים באותה הודעה", async () => {
  // "מהיום עד מחר" — היה נקרא כתאריך יחיד, כי רק ביטוי אחד נתמך.
  const r = await stay("מהיום עד מחר");
  assert.equal(r.ok, true, `שני ביטויים יחסיים חייבים לעבוד: ${r.reason}`);
  assert.equal(r.value.checkIn,  "2026-07-20");
  assert.equal(r.value.checkOut, "2026-07-21");
  assert.equal(r.value.nights, 1);
});

test("תאריכים 4ד: יחסי + מספרי מעורבבים, והתפקיד נקבע לפי המילה", async () => {
  const a = await stay("היום עד 25.7");
  assert.equal(a.ok, true);
  assert.deepEqual([a.value.checkIn, a.value.checkOut], ["2026-07-20", "2026-07-25"]);

  // "עד מחר" = מחר הוא ה*עזיבה*, לא ההגעה.
  const b = await stay("2 לילות עד מחר");
  assert.equal(b.ok, true, `"עד מחר" עם לילות: ${b.reason}`);
  assert.equal(b.value.checkOut, "2026-07-21", "מחר הוא העזיבה");
  assert.equal(b.value.checkIn,  "2026-07-19", "ההגעה מחושבת אחורה");
});

test("תאריכים 4ה: 'מחר' בתוך 'מחרתיים' לא נקרא בטעות כ'מחר'", async () => {
  const r = await stay("מחרתיים, 2 לילות");
  assert.equal(r.value.checkIn, "2026-07-22", "מחרתיים = +2, לא +1");
});

// ── 5. שעת הגעה ──
test("תאריכים 5: שעת הגעה נקלטת, ושעה לא חוקית לא נקלטת", async () => {
  const { parseCheckinDetails } = await import("./validate.js");
  assert.equal(parseCheckinDetails("מגיעים ב-16:00").eta, "16:00");
  assert.equal(parseCheckinDetails("arriving at 11pm").eta, "11pm");
  // 25:00 אינה שעה — לא נקלטת כ-ETA ולא מפילה כלום.
  assert.equal(parseCheckinDetails("מגיעים ב-25:00").eta, null);
  // שעה שכבר עברה היא הערה לצוות בלבד — היא לא משנה תאריכים ולא חוסמת.
  const past = parseCheckinDetails("מגיעים ב-03:00");
  assert.equal(past.eta, "03:00");
  assert.equal(past.skipped, false);
});

// ── מקצה לקצה: האורח באמת מקבל את ההודעה הנכונה בצ'אט ──
test("תאריכים: האורח מקבל בצ'אט את ההודעה המדויקת לכל סוג תקלה", async () => {
  const cases = [
    ["1.1.2020 - 5.1.2020", /כבר עבר/],
    ["25.7 - 23.7",         /אחרי תאריך ההגעה/],
    ["32.13 - 35.14",       /אינו תאריך קיים|לא קיים/],
    ["1.1.2050 - 5.1.2050", /רחוק מאוד בעתיד/],
  ];
  for (const [input, expected] of cases) {
    const p = await checkinUpTo("waiting_dates");
    sent.length = 0;
    await bot.handleIncoming(p, input);
    assert.match(lastBody(), expected, `"${input}" — ההודעה לאורח`);
    assert.ok(!/נכון\?/.test(lastBody()), `"${input}" — אסור לעבור לאישור`);
  }
});

test("תאריכים: הזמנה לא הגיונית לעולם לא נרשמת", async () => {
  const p = await checkinUpTo("waiting_dates");
  for (const bad of ["1.1.2020 - 5.1.2020", "25.7 - 23.7", "32.13 - 35.14", "1.1.2050 - 5.1.2050"]) {
    await bot.handleIncoming(p, bad);
  }
  const { getSession } = await import("./state.js");
  const s = getSession(p);
  assert.equal(s.checkinStage, "waiting_dates", "נשארים בשלב התאריכים עד שיש קלט תקין");
  assert.ok(!s.pendingStay, "לא נשמרה שום שהייה לא הגיונית");
});

// ════════════════════════════════════════════════════════
//  מספרים שנכתבו במילים — "שתי לילות" = 2 לילות
//  ----------------------------------------------------------
//  מהבדיקה החיה: אורח כתב "שתי לילות" והבוט לא הבין את מספר הלילות.
//  אורח לא מקליד ספרות; הוא כותב כמו שהוא מדבר.
// ════════════════════════════════════════════════════════
test("מספרים במילים: לילות בעברית ובאנגלית מובנים בדיוק כמו ספרות", async () => {
  const { validateStayDates } = await import("./validate.js");
  const now = new Date("2026-07-15T09:00:00Z");

  const cases = [
    ["שתי לילות מ-20/7",          "2026-07-20", "2026-07-22", 2],
    ["שני לילות מ-20/7",          "2026-07-20", "2026-07-22", 2],
    ["שלושה לילות מ-20/7",        "2026-07-20", "2026-07-23", 3],
    ["20/7, ארבעה לילות",         "2026-07-20", "2026-07-24", 4],
    ["חמישה לילות עד 25/7",       "2026-07-20", "2026-07-25", 5],
    ["עשרה לילות מ-20/7",         "2026-07-20", "2026-07-30", 10],
    ["לילה אחד מ-20/7",           "2026-07-20", "2026-07-21", 1],
    ["two nights from 20/7",      "2026-07-20", "2026-07-22", 2],
    ["three nights from 20/07",   "2026-07-20", "2026-07-23", 3],
    ["seven nights until 25/7",   "2026-07-18", "2026-07-25", 7],
    ["בעוד שלושה ימים, 2 לילות",  "2026-07-18", "2026-07-20", 2],
    ["in three days, two nights", "2026-07-18", "2026-07-20", 2],
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

test("מספרים במילים: 'יום שני' נשאר יום בשבוע ולא הופך ל-2", async () => {
  const { wordsToDigits } = await import("./numbers.js");
  assert.equal(wordsToDigits("נגיע ביום שני"), "נגיע ביום שני");
  assert.equal(wordsToDigits("שני לילות"), "2 לילות");
  // התחילית נשמרת — בלעדיה מילת התפקיד ("ל", "מ") הייתה נעלמת מהתאריך.
  assert.equal(wordsToDigits("לשלושה לילות"), "ל3 לילות");
});

test("מספרים במילים: אורחים ושעות — בצ'ק אין ובפרטים הנוספים", async () => {
  const { parseCheckinDetails } = await import("./validate.js");

  assert.equal(parseCheckinDetails("עשרה אורחים").guests, 10);
  assert.equal(parseCheckinDetails("שני אורחים").guests, 2);
  assert.equal(parseCheckinDetails("ארבעה אנשים").guests, 4);
  assert.equal(parseCheckinDetails("two guests").guests, 2);
  assert.equal(parseCheckinDetails("we are five").guests, 5);

  // שעה שנכתבה במילים — כולל חלק היום. "בשמונה בערב" הוא 20:00, לא 08:00.
  assert.equal(parseCheckinDetails("מגיעים בשמונה בערב").eta, "20:00");
  assert.equal(parseCheckinDetails("מגיעים בתשע בבוקר").eta, "09:00");
  assert.equal(parseCheckinDetails("arriving at eight in the evening").eta, "20:00");
  assert.equal(parseCheckinDetails("מגיעים ב-14:30").eta, "14:30");
});

test("מספרים במילים: מקצה לקצה בצ'אט — 'שתי לילות' מתקבל", async () => {
  const { getSession } = await import("./state.js");
  const d = (n) => {
    const x = new Date(Date.now() + n * 86400000);
    return `${String(x.getUTCDate()).padStart(2, "0")}/${String(x.getUTCMonth() + 1).padStart(2, "0")}/${x.getUTCFullYear()}`;
  };

  const p = await checkinUpTo("waiting_dates");
  sent.length = 0;
  await bot.handleIncoming(p, `שתי לילות מ-${d(5)}`);

  assert.match(lastBody(), /נכון\?/, `לא הגיע לאישור התאריכים: ${lastBody()}`);
  assert.equal(getSession(p).pendingStay.nights, 2, "שתי לילות = 2 לילות");
});

// ════════════════════════════════════════════════════════
//  תאריך שעבר — נתפס *ברגע שנמסר*, לא אחרי עוד סבב
//  ----------------------------------------------------------
//  מהבדיקה החיה: האורח מסר 10.7 כשהיום 21.7. הבוט ענה "קיבלתי תאריך
//  אחד" והמשיך לבקש תאריך עזיבה — ורק אז גילה שההגעה עברה. פקיד קבלה
//  היה עוצר מיד; אין צורך בתאריך שני כדי לדעת שהראשון בעבר.
// ════════════════════════════════════════════════════════
test("תאריך שעבר: תאריך בודד שעבר נדחה מיד, בלי לבקש תאריך שני", async () => {
  const { validateStayDates } = await import("./validate.js");
  const now = new Date("2026-07-21T09:00:00Z");

  const v = validateStayDates("10.7", now);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "past", "תאריך יחיד שעבר → past, לא one_date");
  assert.equal(v.pastDate, "10/07/2026", "יודעים לומר איזה תאריך בדיוק עבר");
  assert.equal(v.today, "21/07/2026");

  // תאריך עתידי בודד עדיין מבקש את המשלים — ההתנהגות הזו לא נשברה.
  assert.equal(validateStayDates("25.7", now).reason, "one_date");
  // אתמול נשאר קביל (אורח שמאחר בלילה).
  assert.ok(validateStayDates("20.7 - 25.7", now).ok);
});

test("תאריך שעבר: הבוט אומר לאורח *איזה* תאריך עבר, מיד באותה הודעה", async () => {
  const past = new Date(Date.now() - 11 * 86400000);
  const dm = `${String(past.getUTCDate()).padStart(2, "0")}.${String(past.getUTCMonth() + 1).padStart(2, "0")}`;

  const p = await checkinUpTo("waiting_dates");
  sent.length = 0;
  await bot.handleIncoming(p, dm);

  assert.match(lastBody(), /כבר עבר/, `לא זוהה כתאריך שעבר: ${lastBody()}`);
  assert.match(lastBody(), new RegExp(String(past.getUTCDate()).padStart(2, "0")), "מציין את התאריך הבעייתי");
  assert.ok(!/קיבלתי תאריך אחד/.test(lastBody()), "אסור להמשיך כאילו הכול תקין");
  assert.ok(!/נכון\?/.test(lastBody()), "אסור להתקדם לאישור תאריכים");

  // ואחרי תיקון — ממשיכים כרגיל, בלי שהתאריך הפגום נצבר לתוך הקלט הבא.
  const d = (n) => {
    const x = new Date(Date.now() + n * 86400000);
    return `${String(x.getUTCDate()).padStart(2, "0")}/${String(x.getUTCMonth() + 1).padStart(2, "0")}/${x.getUTCFullYear()}`;
  };
  sent.length = 0;
  await bot.handleIncoming(p, `${d(4)} - ${d(7)}`);
  assert.match(lastBody(), /נכון\?/, `לא התאושש אחרי תאריך שעבר: ${lastBody()}`);
});

// ════════════════════════════════════════════════════════
//  הזמנת אוכל — הזמנה יוצאת מלאה, כמו אצל מלצר
//  ----------------------------------------------------------
//  מהבדיקה החיה: אורח ביקש פסטה, והבוט ענה "מעביר לשירות החדרים" —
//  בלי סוג, בלי רוטב, בלי גודל. במטבח אי אפשר לבשל את זה.
// ════════════════════════════════════════════════════════
test("שירות חדרים: התפריט המלא מגיע ל-AI, עם מנות, מחירים ואפשרויות בחירה", async () => {
  const sys = await askConcierge("אשמח לפסטה לחדר");

  assert.match(sys, /לינגוויני טרי/, "המנות עצמן חייבות להגיע ל-AI");
  assert.match(sys, /₪86/, "עם המחיר");
  assert.match(sys, /אפשרויות בחירה ותוספות/, "השדה מגיע מתויג, לא כערך ערום");
  assert.match(sys, /רוזה/, "אפשרויות הרוטב — בלעדיהן אי אפשר לשאול 'איזה רוטב'");
  assert.match(sys, /מידת עשייה/, "מנות בשר — מידת עשייה");
});

test("שירות חדרים: ה-prompt מחייב לאסוף את פרטי המנה לפני העברה למטבח", async () => {
  const he = await askConcierge("אשמח לפסטה לחדר");
  for (const rule of [/אתה המלצר/, /אסור להעביר הזמנה חלקית/, /רוטב/, /אלרגיות/, /ROOMSERVICE/]) {
    assert.match(he, rule, "כלל חסר בהוראות ההזמנה (עברית)");
  }
  const en = await askConcierge("I'd like some pasta to the room please");
  for (const rule of [/you are the waiter/i, /Never pass a partial order/i, /allergies/i]) {
    assert.match(en, rule, "כלל חסר בהוראות ההזמנה (אנגלית)");
  }
});

test("שירות חדרים: הזמנה מלאה מנותבת לשירות החדרים — וואטסאפ + מייל + חדר", async () => {
  const { departmentContacts } = await import("./config.js");
  const p = freshGuest();
  const { patchSession } = await import("./state.js");
  await bot.handleIncoming(p, "שלום");
  patchSession(p, { roomNumber: "512" });

  sent.length = 0; emails.length = 0;
  aiReply = "בשמחה — לינגוויני ברוטב רוזה בדרך אליך 🌟\n" +
            "[ROOMSERVICE:לינגוויני טרי ברוטב רוזה, מנה שלמה, בלי פרמזן · 1 מנה · להגשה עכשיו]";
  await bot.handleIncoming(p, "אשמח ללינגוויני ברוזה");

  const { whatsapp, email: mail } = departmentContacts("room_service");
  const staff = sent.find(m => m.to === whatsapp);
  assert.ok(staff, "ההזמנה חייבת להגיע לוואטסאפ של שירות החדרים");
  assert.match(staff.body, /רוזה/, "ההזמנה המלאה, לא 'האורח רוצה פסטה'");
  assert.match(staff.body, /חדר: 512/, "עם מספר החדר");
  assert.ok(emails.some(e => e.to === mail && /רוזה/.test(e.body)), "וגם למייל של שירות החדרים");
});

// ════════════════════════════════════════════════════════
//  הזמנת אוכל — רשת ביטחון: הזמנה לא נתקעת ולא מוכפלת
//  ----------------------------------------------------------
//  בהרצות חוזרות מול Claude האמיתי ה-AI לא היה עקבי: לפעמים שלח את
//  ההזמנה, ולפעמים ענה "כריך קלאב, לחם מלא — מושלם. לצרף משהו לשתות?"
//  בלי תג — האורח בטוח שהזמין, והמטבח לא קיבל דבר. ופעם אחרת שלח את
//  אותה הזמנה *פעמיים*. שתי התקלות מטופלות דטרמיניסטית.
// ════════════════════════════════════════════════════════
test("אוכל: זיהוי מנה מהתפריט — כולל שם חלקי", async () => {
  const { namedDish } = await import("./bot.js");
  assert.equal(namedDish("אשמח לכריך קלאב", "he"), "כריך קלאב");
  assert.equal(namedDish("לינגוויני ברוזה בבקשה", "he"), "לינגוויני טרי");
  assert.equal(namedDish("I'd like the club sandwich", "en"), "Club sandwich");
  assert.equal(namedDish("מה שעות הבריכה?", "he"), null, "שאלה שאינה הזמנה");
});

test("אוכל: מנה שנבחרה ולא נשלחה — התור הבא נושא שורת מצב מפורשת ל-AI", async () => {
  const { patchSession } = await import("./state.js");
  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  patchSession(p, { roomNumber: "410" });

  // תור 1: האורח נוקב במנה, ה-AI שואל שאלה ולא שולח תג.
  aiReply = "מעולה! לצרף משהו לשתות?";
  await bot.handleIncoming(p, "אשמח לכריך קלאב, לחם מלא");

  // תור 2: ה-prompt חייב לומר ל-AI שההזמנה עדיין לא יצאה.
  aiReply = "בטח.";
  await bot.handleIncoming(p, "מה שעות הבריכה?");
  assert.match(lastSystem(), /מצב עכשיו/, "חסרה שורת מצב על הזמנה פתוחה");
  assert.match(lastSystem(), /כריך קלאב/, "שורת המצב חייבת לנקוב במנה");
  assert.match(lastSystem(), /ROOMSERVICE/, "ולומר מה לעשות");
});

test("אוכל: הזמנה שנתקעה בלי תג — מוסלמת לשירות החדרים, לא נעלמת", async () => {
  const { departmentContacts } = await import("./config.js");
  const { patchSession } = await import("./state.js");
  const { whatsapp } = departmentContacts("room_service");

  // (א) אישור מנה בלי שאלה ובלי תג = מבוי סתום → הסלמה מיידית.
  const p1 = freshGuest();
  await bot.handleIncoming(p1, "שלום");
  patchSession(p1, { roomNumber: "410" });
  sent.length = 0; emails.length = 0;
  aiReply = "כריך קלאב, לחם מלא, בלי צ'יפס — מושלם.";
  await bot.handleIncoming(p1, "כריך קלאב בלחם מלא בלי צ'יפס");

  const staff1 = sent.find(m => m.to === whatsapp);
  assert.ok(staff1, "אישור מנה בלי תג ובלי שאלה — חייב להסלים");
  assert.match(staff1.body, /כריך קלאב/, "עם המנה שנבחרה");
  assert.match(staff1.body, /ליצור קשר/, "ועם הוראה לסגור מול האורח");
  assert.ok(emails.some(e => e.to === departmentContacts("room_service").email), "וגם במייל");

  // (ב) שאלה לגיטימית בתור הראשון לא מסלימה — אבל תור נוסף בלי תג כן.
  const p2 = freshGuest();
  await bot.handleIncoming(p2, "שלום");
  patchSession(p2, { roomNumber: "411" });
  sent.length = 0;
  aiReply = "מעולה! לצרף משהו לשתות?";
  await bot.handleIncoming(p2, "אשמח לכריך קלאב");
  assert.ok(!sent.some(m => m.to === whatsapp), "שאלה אחת לגיטימית — עדיין לא מסלימים");

  aiReply = "בסדר גמור, אז זהו?";
  await bot.handleIncoming(p2, "לא תודה");
  assert.ok(sent.some(m => m.to === whatsapp), "תור שני בלי הזמנה — האורח לא נשאר בלי אוכל");
});

test("אוכל: הזמנה שנשלחה כראוי לא מסלימה ולא מסומנת ככפולה", async () => {
  const { departmentContacts } = await import("./config.js");
  const { patchSession } = await import("./state.js");
  const { whatsapp } = departmentContacts("room_service");

  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  patchSession(p, { roomNumber: "412" });
  sent.length = 0;
  aiReply = "שלחתי למטבח! 🌟\n[ROOMSERVICE:כריך קלאב, לחם מלא, בלי צ'יפס · חדר 412]";
  await bot.handleIncoming(p, "כריך קלאב בלחם מלא");

  const staff = sent.filter(m => m.to === whatsapp);
  assert.equal(staff.length, 1, "הזמנה אחת בדיוק");
  assert.ok(!/ליצור קשר/.test(staff[0].body), "אין הסלמת 'נתקע' על הזמנה תקינה");
  assert.ok(!/ייתכן שזו אותה הזמנה/.test(staff[0].body), "ואין סימון כפילות");
});

test("אוכל: אותה הזמנה פעמיים — מסומנת למטבח, לא נמחקת ולא מוכפלת בשקט", async () => {
  const { departmentContacts } = await import("./config.js");
  const { patchSession } = await import("./state.js");
  const { whatsapp } = departmentContacts("room_service");

  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  patchSession(p, { roomNumber: "413" });

  sent.length = 0;
  aiReply = "שלחתי! 🌟\n[ROOMSERVICE:כריך קלאב, לחם מלא · חדר 413]";
  await bot.handleIncoming(p, "כריך קלאב");
  aiReply = "שלחתי! 🌟\n[ROOMSERVICE:כריך קלאב, לחם מלא, בלי צ'יפס · חדר 413]";
  await bot.handleIncoming(p, "לא תודה, זה הכל");

  const staff = sent.filter(m => m.to === whatsapp);
  assert.equal(staff.length, 2, "שתי הבקשות מגיעות — בקשה לא נמחקת בשקט");
  assert.ok(!/ייתכן שזו אותה הזמנה/.test(staff[0].body), "הראשונה נקייה");
  assert.match(staff[1].body, /ייתכן שזו אותה הזמנה/, "השנייה מסומנת ככפילות אפשרית");
  assert.match(staff[1].body, /הכנה כפולה/, "עם הוראה לוודא מול האורח");

  // מנה *אחרת* אינה כפילות — אורח שמוסיף קינוח חייב לקבל אותו.
  sent.length = 0;
  aiReply = "בשמחה! 🌟\n[ROOMSERVICE:פונדנט שוקולד · חדר 413]";
  await bot.handleIncoming(p, "ותוסיף פונדנט שוקולד");
  const dessert = sent.find(m => m.to === whatsapp);
  assert.ok(dessert, "ההזמנה הנוספת נשלחה");
  assert.ok(!/ייתכן שזו אותה הזמנה/.test(dessert.body), "מנה אחרת אינה כפילות");
});

// ════════════════════════════════════════════════════════
//  ניתוב מחלקות — כל תג, לשני הערוצים, למחלקה הנכונה
// ════════════════════════════════════════════════════════
test("ניתוב: כל תג מגיע למחלקה הנכונה — וואטסאפ *וגם* מייל, עם מספר חדר", async () => {
  const { departmentContacts, TAG_DEPARTMENTS } = await import("./config.js");
  const { patchSession } = await import("./state.js");

  const samples = {
    HK:          "[HK:מגבות נוספות לחדר]",
    HK_URGENT:   "[HK_URGENT:נשפך יין על השטיח]",
    MAINTENANCE: "[MAINTENANCE:המזגן לא מקרר]",
    ROOMSERVICE: "[ROOMSERVICE:קפוצ'ינו אחד וכריך קלאב]",
    CONCIERGE:   "[CONCIERGE:taxi|מונית לנמל הישן, מחר 22/07 ב-20:00, 2 נוסעים]",
    RECEPTION:   "[RECEPTION:שאלה על החשבון]",
    SECURITY:    "[SECURITY:אדם חשוד במסדרון]",
    EMERGENCY:   "[EMERGENCY:פציעה — האורח נחתך ביד]",
  };

  for (const [tag, reply] of Object.entries(samples)) {
    const p = freshGuest();
    await bot.handleIncoming(p, "שלום");
    patchSession(p, { roomNumber: "701" });

    sent.length = 0; emails.length = 0;
    aiReply = `בטיפול 🌟\n${reply}`;
    await bot.handleIncoming(p, "בקשה כלשהי");

    const dept = TAG_DEPARTMENTS[tag];
    const { whatsapp, email: mail } = departmentContacts(dept);
    const waMsg = sent.find(m => m.to === whatsapp);
    assert.ok(waMsg, `[${tag}] לא הגיע לוואטסאפ של ${dept}`);
    assert.match(waMsg.body, /חדר: 701/, `[${tag}] ההתראה חייבת לכלול מספר חדר`);
    assert.ok(emails.some(e => e.to === mail), `[${tag}] לא נשלח מייל ל-${dept}`);
    // התג עצמו לעולם לא נשלח לאורח.
    const guestMsgs = sent.filter(m => m.to === p).map(m => m.body).join("\n");
    assert.ok(!/\[[A-Z_]+/.test(guestMsgs), `[${tag}] תג פנימי דלף לאורח: ${guestMsgs}`);
  }
});

test("ניתוב: טבלת הניתוב מלאה — לכל תג יש מחלקה, מספר ומייל", async () => {
  const { routingTable, TAG_DEPARTMENTS } = await import("./config.js");
  const rows = routingTable();
  assert.equal(rows.length, Object.keys(TAG_DEPARTMENTS).length);
  for (const r of rows) {
    assert.ok(r.whatsapp, `[${r.tag}] בלי מספר וואטסאפ — הבקשה תיעלם`);
    assert.ok(r.email,    `[${r.tag}] בלי מייל — חצי מהניתוב חסר`);
    assert.ok(r.deptHe,   `[${r.tag}] בלי שם מחלקה קריא`);
  }
});

// ════════════════════════════════════════════════════════
//  קונסיירז' — תאריך ושעה הם פרט חובה בהזמנה
// ════════════════════════════════════════════════════════
test("קונסיירז': ה-prompt דורש תאריך/יום, ותופס תאריך או שעה שעברו", async () => {
  const he = await askConcierge("אפשר להזמין שולחן במסעדה?");
  assert.match(he, /תאריך הוא פרט חובה/, "חייב לדרוש תאריך");
  assert.match(he, /שכבר עברו/, "חייב לתפוס תאריך/שעה שעברו");
  assert.match(he, /התאריך \*המפורש\*|22\/07/, "התג נושא תאריך מפורש, לא 'מחר'");

  const en = await askConcierge("Can you book me a table?");
  assert.match(en, /The date is required/i);
  assert.match(en, /already passed/i);
});

test("קונסיירז': בקשה שהועברה בלי תאריך/שעה מסומנת לצוות במפורש", async () => {
  const { departmentContacts } = await import("./config.js");
  const { missingBookingParts } = await import("./bot.js");
  const { REQUEST_TYPES } = await import("./concierge/index.js");

  assert.deepEqual(missingBookingParts(REQUEST_TYPES.RESTAURANT, "שולחן ל-2 במסעדת ים"), ["תאריך/יום", "שעה"]);
  assert.deepEqual(missingBookingParts(REQUEST_TYPES.TAXI, "מונית לנתב\"ג מחר ב-05:30, 2 נוסעים"), []);
  assert.deepEqual(missingBookingParts(REQUEST_TYPES.GIFT, "זר פרחים"), [], "בקשה שאינה הזמנה בזמן — לא נדרש");

  const p = freshGuest();
  await bot.handleIncoming(p, "שלום");
  sent.length = 0;
  aiReply = "אני מטפל בזה ואחזור עם אישור 🌟\n[CONCIERGE:restaurant|שולחן ל-2 במסעדת ים]";
  await bot.handleIncoming(p, "תזמין לי שולחן");

  const { whatsapp } = departmentContacts("concierge");
  const staff = sent.find(m => m.to === whatsapp);
  assert.ok(staff, "הבקשה הועברה לקונסיירז'");
  assert.match(staff.body, /חסר בבקשה/, "הצוות חייב לדעת שחסרים פרטים");
  assert.match(staff.body, /תאריך/, "ומה בדיוק חסר");
});

// ════════════════════════════════════════════════════════
//  שעות פתיחה מגוגל — הקונסיירז' מוסר מידע, לא "אין לי"
// ════════════════════════════════════════════════════════
test("Places: שעות הפתיחה מגוגל מגיעות ל-AI (היום + כל השבוע)", async () => {
  placesResult = {
    ok: true, provider: "google",
    results: [{
      name: "מסעדת בדיקה", address: "הירקון 100, תל אביב", category: "מסעדת בשרים",
      rating: 4.6, ratingCount: 812, priceSymbol: "₪₪₪", openNow: true,
      todayHours: "יום שלישי: 12:00–23:00",
      openingHours: ["יום שני: 12:00–23:00", "יום שלישי: 12:00–23:00", "יום רביעי: 12:00–23:00",
                     "יום חמישי: 12:00–23:30", "יום שישי: 12:00–15:00", "יום שבת: סגור",
                     "יום ראשון: 12:00–23:00"],
      phone: "03-1234567", website: "https://example.co.il",
      distanceText: "450 מ׳", distanceMeters: 450,
    }],
  };
  aiScript = (params, idx) => idx === 0
    ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "search_nearby_places", input: { query: "מסעדת בשר", category: "restaurant" } }] }
    : null;

  const p = freshGuest();
  await bot.handleIncoming(p, "אשמח להמלצה על מסעדת בשר");

  // מה שחזר לכלי — זה מה שה-AI מקבל לנסח ממנו.
  const toolResult = JSON.stringify(aiParams.messages);
  assert.match(toolResult, /todayHours/, "שעות היום חייבות להגיע ל-AI");
  assert.match(toolResult, /12:00/, "עם השעות עצמן");
  assert.match(toolResult, /openingHours/, "וגם שעות כל השבוע");
  assert.match(toolResult, /03-1234567/, "וגם הטלפון — כדי שלא יאמר 'אין לי'");
  assert.match(toolResult, /מסעדת בשרים/, "וגם סוג המטבח");
});

test("Places: ה-prompt מחייב למסור שעות ואוסר על 'אין לי מידע'", async () => {
  const he = await askConcierge("איזו מסעדה יש באזור?");
  assert.match(he, /שעות פתיחה/, "הוראה על שעות פתיחה");
  assert.match(he, /todayHours/, "השדה עצמו מוזכר, כדי שה-AI ידע מאיפה לקחת");
  assert.match(he, /קרא לכלי \*שוב\*/, "שאלת המשך על מקום → חיפוש נוסף, לא 'אין לי'");

  const en = await askConcierge("Any good restaurant nearby?");
  assert.match(en, /todayHours/);
  assert.match(en, /Call the tool \*again\*/);
});

test("Places: מקום בלי שעות ידועות — לא ממציאים לו שעות", async () => {
  placesResult = {
    ok: true, provider: "google",
    results: [{ name: "מקום בלי שעות", address: "רחוב כלשהו 1", category: "בר",
                rating: 4.1, ratingCount: 60, priceSymbol: "₪₪", openNow: null,
                todayHours: null, openingHours: null, phone: null, website: null,
                distanceText: "300 מ׳", distanceMeters: 300 }],
  };
  aiScript = (params, idx) => idx === 0
    ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "search_nearby_places", input: { query: "בר" } }] }
    : null;

  const p = freshGuest();
  await bot.handleIncoming(p, "אשמח להמלצה על בר");

  // בודקים את *התוצאה עצמה* ולא את כל הודעות ה-AI: ההסבר שנשלח לצד
  // התוצאות מזכיר את שמות השדות בכוונה.
  const block   = aiParams.messages.flatMap(m => (Array.isArray(m.content) ? m.content : []))
                                   .find(b => b.type === "tool_result");
  const payload = JSON.parse(block.content);
  assert.equal(payload.results.length, 1);
  assert.ok(!("todayHours" in payload.results[0]), "שדה ריק נשמט לגמרי — null מזמין ניחוש");
  assert.ok(!("openNow" in payload.results[0]),    "בלי נתון פתיחה — אין אמירה על פתיחה");
  assert.ok(!("phone" in payload.results[0]),      "אין טלפון → לא ממציאים טלפון");
});

// ════════════════════════════════════════════════════════
//  בקשות מיוחדות בצ'ק אין — דוגמאות שאורח באמת מבקש
// ════════════════════════════════════════════════════════
test("צ'ק אין: דוגמאות הבקשות המיוחדות הגיוניות — בלי 'חדר שקט'", async () => {
  const pHe = await checkinUpTo("waiting_details");
  const he  = lastBody();
  assert.match(he, /בקשה מיוחדת/, "השלב מבקש בקשה מיוחדת");
  assert.match(he, /קומה גבוהה/);
  assert.match(he, /נוף לים/);
  assert.ok(!/חדר שקט/.test(he), "כל החדרים שקטים — דוגמה כזו משדרת את ההפך");
  assert.ok(pHe);

  await checkinUpTo("waiting_details", { lang: "en" });
  const en = lastBody();
  assert.match(en, /sea view/i);
  assert.ok(!/quiet room/i.test(en), "no 'quiet room' example in English either");
});

// ניקוי קובץ ה-DB הזמני
process.on("exit", () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* ignore */ }
  }
});
