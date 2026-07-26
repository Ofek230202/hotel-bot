// ════════════════════════════════════════════════════════
//  HOTEL TYPE — בדיקות לשני סוגי המלונות (Part א')
//  ----------------------------------------------------------
//  full_service (קמפינסקי) — כרטיס מוכן בקבלה, צוות ביטחון במקום.
//  boutique     (כמו LALA) — קוד למנעול הדלת נמסר לאורח, בלי צוות
//                            במקום; חירום מופנה לשירותי החוץ.
//  בלי לשבור אף אחד מהם: ברירת המחדל (full_service) חייבת להישאר
//  זהה למה שהיה, והבוטיק מקבל התנהגות שונה רק היכן שצריך.
//
//  הרצה: npm test
// ════════════════════════════════════════════════════════
import { test, mock, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DB_PATH                = path.join(os.tmpdir(), `hotel-type-${process.pid}.db`);
process.env.TWILIO_ACCOUNT_SID     = "ACtest";
process.env.TWILIO_AUTH_TOKEN      = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.ANTHROPIC_API_KEY      = "sk-test";
process.env.BASE_URL               = "http://test.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);

const sent = [];
mock.module("twilio", {
  exports: {
    default: () => ({
      messages: {
        create: async ({ to, body }) => {
          if (!body) throw new Error("Twilio: body is required");
          sent.push({ to, body });
          return { sid: "SMtest" };
        },
      },
    }),
  },
});

let aiReply = "שלום!";
mock.module("@anthropic-ai/sdk", {
  exports: {
    default: class Anthropic {
      messages = { create: async () => ({ content: [{ type: "text", text: aiReply }] }) };
    },
  },
});

mock.module("./places/index.js", {
  exports: {
    places: { searchNearby: async () => ({ ok: true, provider: "mock", results: [] }) },
    placesLive: false,
    PLACE_CATEGORIES: Object.freeze({ restaurant: "restaurant", pharmacy: "pharmacy", doctor: "doctor" }),
  },
});

const emails = [];
mock.module("./email/index.js", {
  exports: { email: { send: async (m) => { emails.push(m); return { success: true, messageId: "mock" }; } } },
});

let bot, checkin, config, emergency, pay, cardcom;
before(async () => {
  bot       = await import("./bot.js");
  checkin   = await import("./checkin.js");
  config    = await import("./config.js");
  emergency = await import("./emergency.js");
  pay       = await import("./payments/index.js");
  cardcom   = await import("./payments/CardComProvider.js");
});

let phoneSeq = 0;
const freshGuest = () => `whatsapp:+9725200000${String(++phoneSeq).padStart(2, "0")}`;
beforeEach(() => { sent.length = 0; emails.length = 0; aiReply = "שלום!"; });
// כל בדיקה שמשנה את הקונפיג חייבת לאפס — אחרת "בוטיק"/ספק סליקה דולף
// לבדיקה הבאה. מנקים גם את מטמון ספק התשלום כדי שיקרא מחדש את הקונפיג.
afterEach(() => { config.resetConfig(); pay.clearPaymentsCache(); });

const guestMsgs = (g) => sent.filter(m => m.to === g).map(m => m.body).join("\n");
const staffMsgs = (g) => sent.filter(m => m.to !== g).map(m => m.body).join("\n");

// יוצר הזמנה במצב pending_payment ומשלים אותה — מחזיר את ההזמנה.
async function completeStay(hotelType) {
  if (hotelType) config.updateConfig({ hotel_type: hotelType });
  const phone = freshGuest();
  const { reservationId } = await checkin.startCheckin(
    phone,
    { guestName: "ישראל ישראלי", guestNameHe: "ישראל ישראלי", guestNameEn: "Israel Israeli" },
    "ABC123",
    { stay: { checkIn: "2099-01-10", checkOut: "2099-01-12", nights: 2 } },
  );
  sent.length = 0;
  await checkin.completeCheckin(reservationId, "512");
  return { phone, res: checkin.reservations[reservationId] };
}

// ════════════════════════════════════════════════════════
//  hotelModel — מקור האמת לסוג המלון
// ════════════════════════════════════════════════════════
test("hotelModel: ברירת מחדל = מלון מלא (כרטיס בקבלה, צוות במקום)", () => {
  config.resetConfig();
  const m = config.hotelModel();
  assert.equal(m.type, "full_service");
  assert.equal(m.keyDelivery, "reception_card");
  assert.equal(m.staffed24_7, true);
  assert.equal(m.onSiteSecurity, true);
});

test("hotelModel: boutique = קוד לדלת, בלי צוות במקום", () => {
  config.updateConfig({ hotel_type: "boutique" });
  const m = config.hotelModel();
  assert.equal(m.type, "boutique");
  assert.equal(m.keyDelivery, "door_code");
  assert.equal(m.staffed24_7, false);
  assert.equal(m.onSiteSecurity, false);
});

test("hotelModel: עקיפה מפורשת גוברת על ברירת המחדל של הסוג", () => {
  // מלון בוטיק חריג — עם שומר לילה במקום.
  config.updateConfig({ hotel_type: "boutique", on_site_security: true });
  const m = config.hotelModel();
  assert.equal(m.type, "boutique");
  assert.equal(m.keyDelivery, "door_code");   // עדיין קוד לדלת
  assert.equal(m.onSiteSecurity, true);        // אבל יש צוות ביטחון
});

// ════════════════════════════════════════════════════════
//  צ'ק אין — כרטיס מול קוד לדלת
// ════════════════════════════════════════════════════════
test("צ'ק אין מלון מלא: האורח מקבל 'כרטיס מחכה בקבלה', הקבלה 'להכין כרטיס'", async () => {
  const { phone, res } = await completeStay("full_service");
  const guest = guestMsgs(phone);
  assert.match(guest, /כרטיס החדר מחכה/, "האורח מקבל הפניה לכרטיס בקבלה");
  assert.ok(!res.doorCode, "אין קוד דלת במלון מלא");
  assert.match(staffMsgs(phone), /להכין כרטיס לחדר/, "הקבלה מתבקשת להכין כרטיס");
});

test("צ'ק אין מלון בוטיק: האורח מקבל קוד דלת, הקבלה 'אין צורך בכרטיס'", async () => {
  const { phone, res } = await completeStay("boutique");
  assert.ok(/^\d{4}$/.test(res.doorCode || ""), "נוצר קוד דלת בן 4 ספרות");
  const guest = guestMsgs(phone);
  assert.match(guest, /קוד הכניסה לחדר/, "האורח מקבל את קוד הדלת");
  assert.match(guest, new RegExp(res.doorCode), "הקוד עצמו מופיע בהודעה");
  assert.ok(!/כרטיס החדר מחכה/.test(guest), "בבוטיק אין 'כרטיס מחכה בקבלה'");
  const staff = staffMsgs(phone);
  assert.match(staff, /צ'ק אין עצמאי הושלם|אין צורך בהכנת כרטיס/, "הקבלה מקבלת רישום, לא הוראת כרטיס");
});

test("קוד הדלת יציב — completeCheckin חוזר לא משנה אותו (idempotency)", async () => {
  const { res } = await completeStay("boutique");
  const first = res.doorCode;
  await checkin.completeCheckin(res.id, "512"); // ריצה חוזרת (preview/refresh)
  assert.equal(checkin.reservations[res.id].doorCode, first, "אותו קוד נשמר");
});

// ════════════════════════════════════════════════════════
//  חירום — צוות במקום מול שירותי חוץ
// ════════════════════════════════════════════════════════
test("emergencyGuestMessage: מלון מלא מבטיח 'הצוות בדרך אליכם'", () => {
  const msg = emergency.emergencyGuestMessage("medical", "he", { onSiteTeam: true });
  assert.match(msg, /צוות הביטחון של המלון.*בדרך אליכם/s);
});

test("emergencyGuestMessage: בוטיק לא מבטיח צוות בדרך — מדגיש שירותי חירום", () => {
  const msg = emergency.emergencyGuestMessage("medical", "he", { onSiteTeam: false });
  assert.ok(!/צוות הביטחון של המלון.*בדרך אליכם/s.test(msg), "אסור להבטיח צוות במקום בדרך");
  assert.match(msg, /מנהל התורן/, "מוזכר המנהל התורן מרחוק");
  assert.match(msg, /101/, "מספרי החירום נשארים בולטים");
});

test("חירום בבוטיק דרך הצ'אט: האורח לא מקבל 'צוות בדרך', הצוות מקבל 'מלון ללא צוות'", async () => {
  config.updateConfig({ hotel_type: "boutique" });
  const phone = freshGuest();
  await bot.handleIncoming(phone, "יש שריפה בחדר!");
  const guest = guestMsgs(phone);
  assert.match(guest, /102/, "הנחיית כבאות");
  assert.ok(!/צוות הביטחון של המלון.*בדרך אליכם/s.test(guest), "אין הבטחת צוות במקום");
  assert.match(staffMsgs(phone), /מלון ללא צוות ביטחון במקום/, "המנהל התורן יודע שאין צוות במקום");
});

test("חירום במלון מלא נשאר כשהיה: 'צוות בדרך אליכם' + הסלמה לצוות", async () => {
  const phone = freshGuest();
  await bot.handleIncoming(phone, "יש שריפה בחדר!");
  const guest = guestMsgs(phone);
  assert.match(guest, /צוות הביטחון של המלון.*בדרך אליכם/s, "מלון מלא ממשיך להבטיח צוות בדרך");
  assert.ok(!/מלון ללא צוות ביטחון במקום/.test(staffMsgs(phone)), "אין הערת בוטיק במלון מלא");
});

// ════════════════════════════════════════════════════════
//  ספק סליקה פר-מלון (Part ג')
// ════════════════════════════════════════════════════════
test("paymentsFor: ברירת מחדל = Mock (מאשר תמיד)", async () => {
  const p = pay.paymentsFor("kempinski");
  const auth = await p.authorizeDeposit({ paymentPageUrl: "u", successUrl: "s" });
  assert.equal(auth.status, "authorized");
});

test("paymentsFor: cardcom בלי credentials נופל ל-Mock — לא שובר צ'ק אין", async () => {
  config.updateConfig({ payment_provider: "cardcom" }); // בלי credentials
  pay.clearPaymentsCache();
  const p = pay.paymentsFor("kempinski");
  const auth = await p.authorizeDeposit({ paymentPageUrl: "u", successUrl: "s" });
  assert.equal(auth.status, "authorized", "נפילה בטוחה ל-Mock");
});

test("paymentsFor: cardcom עם credentials בוחר CardComProvider (scaffold זורק בבירור)", async () => {
  config.updateConfig({
    payment_provider: "cardcom",
    payment_credentials: { terminalNumber: "1000", apiName: "x", apiPassword: "y" },
  });
  pay.clearPaymentsCache();
  const p = pay.paymentsFor("kempinski");
  assert.ok(p instanceof cardcom.CardComProvider, "נבחר ספק CardCom");
  await assert.rejects(() => p.authorizeDeposit({}), (e) => e.notConnected === true,
    "ה-scaffold זורק שגיאת 'לא מחובר' — לא מדמה הצלחה שקרית");
});

// ════════════════════════════════════════════════════════
//  תשלום מזומן (Part ד')
// ════════════════════════════════════════════════════════
const STAY = { checkIn: "2099-01-10", checkOut: "2099-01-12", nights: 2 };
const NAME = { guestName: "ישראל ישראלי", guestNameHe: "ישראל ישראלי", guestNameEn: "Israel Israeli" };

test("startCheckin מזומן: אין הרשאת כרטיס ואין קישור תשלום", async () => {
  const phone = freshGuest();
  const { reservationId, paymentUrl } = await checkin.startCheckin(phone, NAME, "ABC", { stay: STAY, depositMethod: "cash" });
  const r = checkin.reservations[reservationId];
  assert.equal(r.depositMethod, "cash");
  assert.equal(r.paymentId, null, "אין הרשאת כרטיס בזרימת מזומן");
  assert.equal(paymentUrl, null, "אין קישור תשלום");
});

test("switchDepositToCash: הופך הזמנת כרטיס קיימת ל-cash ומבטל את ה-hold", async () => {
  const phone = freshGuest();
  const { reservationId } = await checkin.startCheckin(phone, NAME, "ABC", { stay: STAY }); // card
  assert.ok(checkin.reservations[reservationId].paymentId, "hold כרטיס קיים");
  await checkin.switchDepositToCash(reservationId);
  const r = checkin.reservations[reservationId];
  assert.equal(r.depositMethod, "cash");
  assert.equal(r.paymentUrl, null);
});

test("צ'ק אין מזומן: האורח מקבל 'פיקדון במזומן', הקבלה 'לגבות במזומן'", async () => {
  const phone = freshGuest();
  const { reservationId } = await checkin.startCheckin(phone, NAME, "ABC", { stay: STAY, depositMethod: "cash" });
  sent.length = 0;
  await checkin.completeCheckin(reservationId, "512");
  assert.match(guestMsgs(phone), /פיקדון במזומן/, "האורח יודע שהפיקדון במזומן");
  assert.match(staffMsgs(phone), /לגבות במזומן בקבלה/, "הפקיד מתבקש לגבות מזומן");
});

test("צ'ק אאוט מזומן, חיובים מתחת לפיקדון: החזר עודף במזומן בקבלה", async () => {
  const phone = freshGuest();
  const { reservationId } = await checkin.startCheckin(phone, NAME, "ABC", { stay: STAY, depositMethod: "cash" });
  await checkin.completeCheckin(reservationId, "512");
  checkin.addFolioItem(reservationId, "RESTAURANT", "ארוחת ערב", 12000); // ₪120 < ₪500
  sent.length = 0;
  await checkin.processCheckout(phone, reservationId, "he");
  assert.match(guestMsgs(phone), /יתרת המזומן.*תוחזר/s, "יתרת המזומן מוחזרת בקבלה");
  assert.match(staffMsgs(phone), /להחזיר עודף.*במזומן/s, "הקבלה מקבלת סכום ההחזר");
});

test("צ'ק אאוט מזומן, חיובים מעל הפיקדון: 'להשלים במזומן', בלי קישור כרטיס", async () => {
  const phone = freshGuest();
  const { reservationId } = await checkin.startCheckin(phone, NAME, "ABC", { stay: STAY, depositMethod: "cash" });
  await checkin.completeCheckin(reservationId, "512");
  checkin.addFolioItem(reservationId, "RESTAURANT", "ארוחות", 70000); // ₪700 > ₪500
  sent.length = 0;
  await checkin.processCheckout(phone, reservationId, "he");
  const guest = guestMsgs(phone);
  assert.match(guest, /להשלים במזומן בקבלה/, "האורח משלים במזומן");
  assert.ok(!/balance\/pay/.test(guest), "אין קישור תשלום כרטיס בזרימת מזומן");
  assert.match(staffMsgs(phone), /לגבות הפרש.*במזומן/s, "הקבלה מקבלת סכום ההפרש");
});
