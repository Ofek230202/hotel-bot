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
import { freshTestDbPath } from "./test-dbpath.mjs";

// נתיב DB ייחודי ומתנקה — מונע טעינת מצב מהרצה קודמת (pid ממוחזר).
process.env.DB_PATH                = freshTestDbPath("type");
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

let bot, checkin, config, emergency, pay, cardcom, state, wa, cloud, pmsMod, profiles;
before(async () => {
  bot       = await import("./bot.js");
  checkin   = await import("./checkin.js");
  config    = await import("./config.js");
  emergency = await import("./emergency.js");
  pay       = await import("./payments/index.js");
  cardcom   = await import("./payments/CardComProvider.js");
  state     = await import("./state.js");
  wa        = await import("./whatsapp/index.js");
  cloud     = await import("./whatsapp/CloudApiProvider.js");
  pmsMod    = await import("./pms/index.js");
  profiles  = await import("./profiles.js");
});

let phoneSeq = 0;
const freshGuest = () => `whatsapp:+9725200000${String(++phoneSeq).padStart(2, "0")}`;
beforeEach(() => { sent.length = 0; emails.length = 0; aiReply = "שלום!"; });
// כל בדיקה שמשנה את הקונפיג חייבת לאפס — אחרת "בוטיק"/ספק סליקה דולף
// לבדיקה הבאה. מנקים גם את מטמון ספק התשלום כדי שיקרא מחדש את הקונפיג.
afterEach(() => {
  config.resetConfig();
  pay.clearPaymentsCache();
  wa?.clearWhatsAppCache?.();
  pmsMod?.clearPmsCache?.();
});

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

test("איכות פלט: מלון בלי בריכה — אישור הצ'ק אין לא מציג 'undefined'", async () => {
  // מלון בוטיק בלי בריכה/רום-סרוויס: השורות לא אמורות להופיע (ולא כ-undefined).
  config.updateConfig({
    hotel_type: "boutique",
    services: { pool: null, room_service: null },
    wifi: { name: "Boutique_Guest", password: "x" },
  });
  const phone = freshGuest();
  const { reservationId } = await checkin.startCheckin(phone, NAME, "ABC", { stay: STAY });
  sent.length = 0;
  await checkin.completeCheckin(reservationId, "9");
  const guest = guestMsgs(phone);
  assert.ok(!/undefined/.test(guest), `יש undefined באישור: ${guest}`);
  assert.ok(!/🏊 בריכה/.test(guest), "מלון בלי בריכה לא אמור להציג שורת בריכה");
  assert.match(guest, /Boutique_Guest/, "WiFi של המלון כן מופיע");
  assert.match(guest, /קוד הכניסה לחדר/, "קוד דלת (בוטיק)");
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

// ════════════════════════════════════════════════════════
//  חשבונית מס-קבלה (Part ה')
// ════════════════════════════════════════════════════════
async function stayWithCharge(charge, { tourist = false, lang = "he" } = {}) {
  const phone = freshGuest();
  const { reservationId } = await checkin.startCheckin(phone, NAME, "ABC", { stay: STAY });
  const res = checkin.reservations[reservationId];
  if (tourist) res.isTourist = true;
  await checkin.completeCheckin(reservationId, "512");
  checkin.addFolioItem(reservationId, "RESTAURANT", lang === "he" ? "ארוחה" : "Meal", charge);
  return { phone, reservationId, res: checkin.reservations[reservationId] };
}

test("חשבונית: מע\"מ 18% מופרד נכון מסכום כולל מע\"מ (תושב)", async () => {
  const { res } = await stayWithCharge(11800); // ₪118 כולל מע"מ
  const inv = await checkin.issueFolioInvoice(res, "he");
  assert.equal(inv.totalInclVat, 11800);
  assert.equal(inv.net, 10000, "₪100 לפני מע\"מ");
  assert.equal(inv.vat, 1800,  "₪18 מע\"מ");
  assert.equal(inv.zeroRated, false);
  assert.match(inv.number, /^\d{4}-\d{5}$/, "מספר סידורי בפורמט שנה-רץ");
  assert.ok(inv.seller.businessId, "מספר עוסק על החשבונית");
});

test("חשבונית: תייר חוץ → 0% מע\"מ (מלונאות לתייר)", async () => {
  const { res } = await stayWithCharge(11800, { tourist: true, lang: "en" });
  const inv = await checkin.issueFolioInvoice(res, "en");
  assert.equal(inv.vat, 0);
  assert.equal(inv.zeroRated, true);
  assert.equal(inv.net, 11800, "אין הפרדת מע\"מ בזירו-רייטד");
});

// ניסוח הסיכום שהאורח מקבל בוואטסאפ. בחשבונית באפס מע"מ אין מה להפריד:
// "סכום לפני מע"מ" היה מכפיל את אותו מספר, ו"סה"כ *כולל מע"מ*" הוא ניסוח
// מטעה על מסמך שלא נגבה בו מע"מ כלל. עמוד ה-HTML כבר נהג נכון — כאן
// מיישרים אליו גם את הסיכום בצ'אט.
test("חשבונית: ניסוח הסיכום לתייר (0%) לא מדבר על 'כולל מע\"מ'", async () => {
  const { res } = await stayWithCharge(11800, { tourist: true, lang: "en" });
  const inv = await checkin.issueFolioInvoice(res, "en");
  const en  = checkin.formatInvoiceSummary(inv, "en");
  assert.ok(!/incl\. VAT/i.test(en), `"incl. VAT" על חשבונית 0%:\n${en}`);
  assert.ok(!/Amount before VAT/i.test(en), `שורת נטו מיותרת על חשבונית 0%:\n${en}`);
  assert.match(en, /VAT: 0%/, "כן נאמר במפורש שהמע\"מ 0%");
  assert.match(en, /\*Total: ₪118\.00\*/, "סיכום פשוט וברור");

  const he = checkin.formatInvoiceSummary({ ...inv, type: "חשבונית מס-קבלה" }, "he");
  assert.ok(!/כולל מע"מ/.test(he), `"כולל מע\"מ" על חשבונית 0%:\n${he}`);
  assert.match(he, /סה"כ לתשלום/);
});

test("חשבונית: ניסוח הסיכום לתושב כן מפרט מע\"מ 18%", async () => {
  const { res } = await stayWithCharge(11800);
  const inv = await checkin.issueFolioInvoice(res, "he");
  const he  = checkin.formatInvoiceSummary(inv, "he");
  assert.match(he, /סכום לפני מע"מ: ₪100\.00/);
  assert.match(he, /מזה מע"מ 18%: ₪18\.00/);
  assert.match(he, /סה"כ כולל מע"מ: ₪118\.00/);
});

test("חשבונית: מספרים סידוריים רצים ועולים ב-1", async () => {
  const a = (await checkin.issueFolioInvoice((await stayWithCharge(5000)).res, "he")).number;
  const b = (await checkin.issueFolioInvoice((await stayWithCharge(5000)).res, "he")).number;
  assert.equal(+b.split("-")[1], +a.split("-")[1] + 1, "המספר עולה ב-1 בין חשבוניות");
});

test("צ'ק אאוט עם חיובים: האורח מקבל חשבונית מס-קבלה + קישור למסמך", async () => {
  const { phone, reservationId } = await stayWithCharge(35000);
  sent.length = 0;
  await checkin.processCheckout(phone, reservationId, "he");
  const guest = guestMsgs(phone);
  assert.match(guest, /חשבונית מס-קבלה/, "נשלח מסמך מס");
  assert.match(guest, /\/invoice\//, "קישור לחשבונית המלאה");
  assert.match(guest, /מע"מ 18%/, "פירוט מע\"מ");
});

// ════════════════════════════════════════════════════════
//  מנהל רואה שיחות לפי חדר (Part ו')
// ════════════════════════════════════════════════════════
test("Part ו': מציאת שיחה לפי חדר → טלפון האורח נגיש למנהל/קבלה", async () => {
  const phone = freshGuest();
  const { reservationId } = await checkin.startCheckin(phone, NAME, "ABC", { stay: STAY });
  await checkin.completeCheckin(reservationId, "777");
  const s = state.sessionByRoom("777");
  assert.ok(s, "נמצא סשן לפי מספר החדר");
  assert.equal(s.phone, phone, "הטלפון של האורח נגיש (למי לפנות)");
  assert.equal(s.roomNumber, "777");
  assert.equal(s.reservationId, reservationId, "מקושר להזמנה");
});

test("Part ו': חדר לא מאוכלס → null (בלי לזרוק)", () => {
  assert.equal(state.sessionByRoom("9999"), null);
});

// ════════════════════════════════════════════════════════
//  חיבורי PMS + Meta WhatsApp (Part ט')
// ════════════════════════════════════════════════════════
test("Part ט' whatsapp: ברירת מחדל = Twilio (אפס שינוי התנהגות)", () => {
  assert.ok(wa.whatsappFor("kempinski") === wa.whatsapp);
});

test("Part ט' whatsapp: cloud בלי credentials נופל ל-Twilio", () => {
  config.updateConfig({ whatsapp_provider: "cloud" });
  wa.clearWhatsAppCache();
  assert.ok(wa.whatsappFor("kempinski") === wa.whatsapp, "נפילה בטוחה");
});

test("Part ט' whatsapp: cloud עם credentials בוחר CloudApiProvider", () => {
  config.updateConfig({ whatsapp_provider: "cloud", whatsapp_credentials: { phoneNumberId: "123", token: "t" } });
  wa.clearWhatsAppCache();
  assert.equal(wa.whatsappFor("kempinski").constructor.name, "CloudApiProvider");
});

test("Part ט' whatsapp: אימות HMAC של webhook Meta (תקין מול מזויף)", async () => {
  const { createHmac } = await import("node:crypto");
  const p = new cloud.CloudApiProvider({ phoneNumberId: "1", token: "t", appSecret: "secret" });
  const body = JSON.stringify({ hello: "world" });
  const sig  = "sha256=" + createHmac("sha256", "secret").update(body).digest("hex");
  assert.equal(p.verifyWebhook({ rawBody: body, signature: sig }).valid, true, "חתימה תקינה עוברת");
  assert.equal(p.verifyWebhook({ rawBody: body, signature: "sha256=deadbeef" }).valid, false, "חתימה מזויפת נדחית");
  assert.equal(p.verifyWebhook({ rawBody: body }).valid, false, "בלי חתימה — נדחה");
});

test("Part ט' whatsapp: verifyMetaChallenge רק עם verify token תואם", () => {
  assert.equal(cloud.verifyMetaChallenge({ "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "42" }, "tok"), "42");
  assert.equal(cloud.verifyMetaChallenge({ "hub.mode": "subscribe", "hub.verify_token": "x", "hub.challenge": "42" }, "tok"), null);
});

test("Part ט' pms: ברירת מחדל = Mock — המאגר המובנה מקור האמת", async () => {
  const p = pmsMod.pmsFor("kempinski");
  assert.equal(p.isMock, true);
  assert.equal(await p.getReservation({ confirmationNumber: "X" }), null, "אין רשומה חיצונית → מאגר מובנה");
});

test("Part ט' pms: apaleo עם credentials — ספק אמיתי מהרישום, לא scaffold", async () => {
  config.updateConfig({ pms_provider: "apaleo", pms_credentials: { clientId: "a", clientSecret: "b", propertyId: "c" } });
  pmsMod.clearPmsCache();
  const p = pmsMod.pmsFor("kempinski");
  // Apaleo עבר מ-scaffold ייעודי למנוע הגנרי שמריץ את המפרט מ-vendors.js.
  assert.equal(p.constructor.name, "RestPmsProvider");
  assert.equal(p.vendor, "apaleo");
  assert.equal(p.isConfigured(), true);
  assert.equal(p.supports("folio.post"), true, "Apaleo תומכת ברישום חיוב");
  assert.equal(await p.getReservation({}), null, "בקשה בלי מזהה → null, בלי קריאת רשת");
  assert.ok(p.describe().docsUrl.includes("apaleo"), "המדריך מפנה לתיעוד הספק");
});

test("Part ט' pms: apaleo בלי credentials נופל ל-Mock", () => {
  config.updateConfig({ pms_provider: "apaleo" });
  pmsMod.clearPmsCache();
  assert.equal(pmsMod.pmsFor("kempinski").isMock, true, "נפילה בטוחה למאגר המובנה");
});

test("Part 2: Optima (מוביל השוק בישראל) עם credentials — נבחר, יכולות שמרניות", async () => {
  const { OptimaPmsProvider } = await import("./pms/OptimaPmsProvider.js");
  config.updateConfig({
    pms_provider: "optima",
    pms_credentials: { endpoint: "https://optima.example/api", apiUser: "u", apiPassword: "p", hotelCode: "H1" },
  });
  pmsMod.clearPmsCache();
  const p = pmsMod.pmsFor("kempinski");
  assert.ok(p instanceof OptimaPmsProvider, "נבחר Optima");
  // יכולות: קריאה כן, post folio לא (מדרדר בחן לצוות).
  assert.equal(p.supports("reservation.read"), true);
  assert.equal(p.supports("folio.post"), false, "Optima לא מצהירה folio.post כברירת מחדל");

  // האדפטר כבר אינו scaffold: עם credentials הוא *מוגדר* ומבצע HTTP אמיתי
  // (מכוסה מקצה לקצה ב-pms-optima.test.mjs עם fetch מוזרק). מה שנשאר לבדוק
  // כאן הוא ההתנהגות מול pmsFor: נבחר, מוגדר, ולא חושף סודות.
  assert.equal(p.isConfigured(), true, "credentials מלאים → מוגדר");
  assert.equal(p.hotelCode, "H1");
  assert.equal(await p.getReservation({}), null, "בקשה בלי מספר אישור → null, בלי קריאת רשת");
  const d = p.describe();
  assert.equal(d.provider, "optima");
  assert.ok(!JSON.stringify(d).includes("apiPassword\":\"p\""), "describe לא מחזיר סיסמה");

  // בלי credentials — נכשל *בבירור*, לא מתחזה לעובד.
  const bare = new OptimaPmsProvider({});
  assert.equal(bare.isConfigured(), false);
  await assert.rejects(() => bare.getReservation("ABC"), (e) => e.notConnected === true,
    "מלון בלי חיבור מקבל שגיאה מפורשת");
});

test("Part 2: capability flags — Mock תומך בהכל, אדפטר בסיסי בכלום", async () => {
  const { PmsProvider } = await import("./pms/PmsProvider.js");
  assert.equal(new PmsProvider().supports("folio.post"), false, "בסיס בטוח = כלום נתמך");
  assert.equal(pmsMod.pms.supports("folio.post"), true, "Mock תומך בהכל");
});

// ════════════════════════════════════════════════════════
//  מוכנות לפרודקשן — מייל אמיתי + onboarding
// ════════════════════════════════════════════════════════
test("מוכנות: HttpEmailProvider — מוגדר עם מפתח, בטוח בלי נמען/בלי מפתח", async () => {
  const { HttpEmailProvider } = await import("./email/HttpEmailProvider.js");
  assert.equal(new HttpEmailProvider({}).isConfigured(), false, "בלי מפתח = לא מוגדר");
  assert.equal(new HttpEmailProvider({ apiKey: "re_x" }).isConfigured(), true);
  // בלי מפתח — לא זורק, מחזיר success:false (לא מפיל ניתוב מחלקה).
  const noKey = await new HttpEmailProvider({}).send({ to: "hk@hotel.com", subject: "x", body: "y" });
  assert.equal(noKey.success, false);
  assert.equal(noKey.status, "not_configured");
  // בלי נמען — לא זורק.
  const noTo = await new HttpEmailProvider({ apiKey: "re_x" }).send({ subject: "x", body: "y" });
  assert.equal(noTo.success, false);
  assert.equal(noTo.status, "no_recipient");
});

test("מוכנות: onboarding מלון חדש בקריאה אחת — מספר + קונפיג + בדיקת אנשי קשר", async () => {
  const { registerHotelNumber } = await import("./tenant.js");
  const { checkDepartmentContacts, configFor } = await import("./config.js");
  const hid = "readytest";
  // מדמה את מה ש-POST /api/hotels עושה: רישום מספר + קונפיג מלון.
  const mapped = registerHotelNumber("+15550009999", hid, null);
  assert.equal(mapped.hotelId, hid);
  config.updateConfigFor(hid, {
    name: "Ready Hotel", name_he: "מלון רדי",
    reception_number: "whatsapp:+972111", reception_email: "r@ready.com",
    housekeeping_number: "whatsapp:+972222", housekeeping_email: "h@ready.com",
  });
  assert.equal(configFor(hid).name, "Ready Hotel", "הקונפיג נשמר למלון החדש");
  // בדיקת שלמות — אילו מחלקות חסרות אנשי קשר (כדי שלא ייעלמו התראות).
  const contacts = checkDepartmentContacts(hid);
  assert.ok(Array.isArray(contacts.missing), "מוחזרת רשימת חוסרים לבדיקה");
});

// ════════════════════════════════════════════════════════
//  פרופיל אורח חוצה-שהיות (Part י')
// ════════════════════════════════════════════════════════
test("Part י': שהייה שנייה מזוהה כאורח חוזר; VIP אחרי 3 שהיות", () => {
  const phone = freshGuest();
  assert.equal(profiles.isReturningGuest(phone), false, "פעם ראשונה — לא חוזר");
  const p1 = profiles.recordStay(phone, { name: "דנה", preferences: "קומה גבוהה, נוף לים" });
  assert.equal(p1.stays, 1);
  assert.equal(profiles.isReturningGuest(phone), true, "אחרי שהייה — חוזר");
  assert.equal(p1.vip, false);
  profiles.recordStay(phone);
  const p3 = profiles.recordStay(phone);
  assert.equal(p3.stays, 3);
  assert.equal(p3.vip, true, "3 שהיות = VIP");
  assert.equal(p3.preferences, "קומה גבוהה, נוף לים", "ההעדפה נשמרת בין שהיות");
});

test("Part י': צ'ק אאוט רושם את השהייה בפרופיל (עם ההעדפה)", async () => {
  const phone = freshGuest();
  const { reservationId } = await checkin.startCheckin(phone, NAME, "ABC", { stay: STAY });
  const res = checkin.reservations[reservationId];
  res.specialRequests = "מיטה זוגית, קרוב למעלית";
  await checkin.completeCheckin(reservationId, "512");
  await checkin.processCheckout(phone, reservationId, "he");
  const prof = profiles.getProfile(phone);
  assert.ok(prof, "נוצר פרופיל בצ'ק אאוט");
  assert.equal(prof.stays, 1);
  assert.equal(prof.preferences, "מיטה זוגית, קרוב למעלית");
});

test("Part י': אורח חוזר מקבל פתיחת צ'ק אין חמה ('לארח שוב')", async () => {
  const phone = freshGuest();
  profiles.recordStay(phone, { name: "יעל" }); // שהייה קודמת
  sent.length = 0;
  await bot.handleIncoming(phone, "צ'ק אין");
  assert.match(guestMsgs(phone), /לארח אותך שוב/, "פתיחה חמה לאורח חוזר");
});

test("רגרסיה: 'אני רוצה לעשות צ'ק אאוט' → צ'ק אאוט, לא צ'ק אין", async () => {
  const phone = freshGuest();
  const { reservationId } = await checkin.startCheckin(phone, NAME, "ABC", { stay: STAY });
  await checkin.completeCheckin(reservationId, "512");
  checkin.addFolioItem(reservationId, "MINIBAR", "מיני בר", 5000);
  sent.length = 0;
  await bot.handleIncoming(phone, "אני רוצה לעשות צ'ק אאוט");
  const guest = guestMsgs(phone);
  assert.match(guest, /בקשת צ'ק אאוט|סיכום חשבון/, "מופעל צ'ק אאוט");
  assert.ok(!/שמך המלא/.test(guest), "לא מתחיל צ'ק אין בטעות");
});

// ════════════════════════════════════════════════════════
//  פטור מע"מ לתיירים (Part 3)
// ════════════════════════════════════════════════════════
test("Part 3: דרכון זר → תייר → חשבונית מע\"מ 0%; ת\"ז ישראלית → 18%", async () => {
  // תייר: דרכון + אזרחות זרה → isTourist מופעל בהזמנה → חשבונית 0%.
  const t = freshGuest();
  const rt = await checkin.startCheckin(t, NAME, "ABC", { stay: STAY, isTourist: true, nationality: "USA" });
  const rtRes = checkin.reservations[rt.reservationId];
  assert.equal(rtRes.isTourist, true);
  await checkin.completeCheckin(rt.reservationId, "700");
  checkin.addFolioItem(rt.reservationId, "RESTAURANT", "Dinner", 11800);
  const invT = await checkin.issueFolioInvoice(rtRes, "en");
  assert.equal(invT.zeroRated, true, "תייר → מע\"מ 0%");
  assert.equal(invT.vat, 0);

  // תושב: בלי דגל תייר → מע"מ 18%.
  const r = freshGuest();
  const rr = await checkin.startCheckin(r, NAME, "ABC", { stay: STAY });
  const rrRes = checkin.reservations[rr.reservationId];
  assert.equal(rrRes.isTourist, false);
  await checkin.completeCheckin(rr.reservationId, "701");
  checkin.addFolioItem(rr.reservationId, "RESTAURANT", "ארוחה", 11800);
  const invR = await checkin.issueFolioInvoice(rrRes, "he");
  assert.equal(invR.zeroRated, false, "תושב → מע\"מ 18%");
  assert.equal(invR.vat, 1800);
});

test("Part 3: assessTourist — דרכון זר=תייר, דרכון/ת\"ז ישראלי=תושב", async () => {
  const { assessTourist } = bot;
  assert.equal(assessTourist({ fields: { nationality: "USA" }, documentType: "passport" }).isTourist, true);
  assert.equal(assessTourist({ fields: { nationality: "French" }, documentType: "passport" }).isTourist, true);
  assert.equal(assessTourist({ fields: { nationality: "Israeli" }, documentType: "passport" }).isTourist, false, "אזרח ישראלי בדרכון = תושב");
  assert.equal(assessTourist({ fields: { nationality: "ישראל" }, documentType: "id_card" }).isTourist, false);
  assert.equal(assessTourist({ fields: {}, documentType: "id_card" }).isTourist, false, "בלי אזרחות = לא מפעילים 0% אוטומטית");
});

// ════════════════════════════════════════════════════════
//  אבטחה (Part ב')
// ════════════════════════════════════════════════════════
test("Part ב': שם אורח זדוני עובר escape בעמוד האישור (הגנת XSS)", async () => {
  const phone = freshGuest();
  const evil  = "<script>alert(1)</script>";
  const { reservationId } = await checkin.startCheckin(
    phone,
    { guestName: evil, guestNameHe: evil, guestNameEn: "<img src=x onerror=alert(1)>" },
    "ABC", { stay: STAY },
  );
  await checkin.completeCheckin(reservationId, "512");
  const { default: router } = await import("./checkin-routes.js");
  const layer = router.stack.find(l => l.route?.path === "/checkin/success");
  let html = "";
  await layer.route.stack[0].handle(
    { query: { rid: reservationId }, headers: {} },
    { send: (h) => { html = h; }, redirect: () => {} },
  );
  assert.ok(!/<script>alert/.test(html), "תגית script גולמית לא נכנסת ל-HTML");
  assert.match(html, /&lt;script&gt;/, "השם עבר escape כראוי");
});

test("עמוד החשבונית מרנדר את כל שדות החובה", async () => {
  const { reservationId, res } = await stayWithCharge(11800);
  await checkin.issueFolioInvoice(res, "he");
  const { default: router } = await import("./checkin-routes.js");
  const layer = router.stack.find(l => l.route?.path === "/invoice/:rid");
  let html = "";
  await layer.route.stack[0].handle(
    { params: { rid: reservationId }, query: {}, headers: {} },
    { send: (h) => { html = h; } },
  );
  assert.match(html, /חשבונית מס-קבלה/, "סוג המסמך");
  assert.match(html, /מקור/, "סימון 'מקור'");
  assert.match(html, /עוסק/, "מספר עוסק");
  assert.match(html, /מע"מ 18%/, "שיעור מע\"מ");
  assert.match(html, /ישראל ישראלי/, "שם הלקוח");
});
