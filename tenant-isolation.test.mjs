// ════════════════════════════════════════════════════════
//  TENANT ISOLATION — שני מלונות באותו תהליך, בלי דליפה
//  ----------------------------------------------------------
//  כל הבדיקות כאן נולדו מהרצה חיה של שני מלונות במקביל (LALA בוטיק +
//  קמפינסקי) שחשפה מחלקה שלמה של תקלות **שקטות**: מלון נטען כ-overrides
//  מעל DEFAULTS, ולכן כל שדה שהמלון לא הגדיר נשאר *של מלון ברירת המחדל*.
//  שום דבר לא "חסר", שום דבר לא נכשל, ואף לוג לא צועק — פשוט:
//    • בקשת אחזקה של אורח ב-LALA מגיעה לאחזקה של קמפינסקי
//    • חשבונית המס של LALA נושאת את מספר העוסק של קמפינסקי
//    • הודעת הפתיחה מברכת אורח של LALA ב"ברוכים הבאים למלון קמפינסקי"
//    • הקונסיירז' של LALA ממליץ על מסעדת המלון של קמפינסקי
//
//  לכל אחת מאלה יש כאן בדיקה. הן זולות ודטרמיניסטיות (בלי AI, בלי רשת).
//
//  הרצה: npm test
// ════════════════════════════════════════════════════════
import { test, mock, before } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH                = freshTestDbPath("tenant-iso");
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
        create: async ({ from, to, body }) => {
          if (!body) throw new Error("Twilio: body is required");
          sent.push({ from, to, body });
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

const emails = [];
const { email } = await import("./email/index.js");
email.send = async (m) => { emails.push(m); return { success: true }; };

const config  = await import("./config.js");
const tenant  = await import("./tenant.js");
const bot     = await import("./bot.js");
const state   = await import("./state.js");
const checkin = await import("./checkin.js");
const { SAMPLE_HOTELS, seedSampleHotels } = await import("./sample-hotels.mjs");

const LALA = "lala", KEMP = tenant.DEFAULT_HOTEL_ID;
const numberOf = (id) => SAMPLE_HOTELS.find(h => h.hotelId === id).number;

before(() => {
  seedSampleHotels({
    updateConfigFor: config.updateConfigFor,
    registerHotelNumber: tenant.registerHotelNumber,
    DEFAULT_HOTEL_ID: tenant.DEFAULT_HOTEL_ID,
  });
});

// ════════════════════════════════════════════════════════
//  1. אנשי קשר של מחלקות — היעד הפיזי של כל בקשה
// ════════════════════════════════════════════════════════
test("בידוד: לשני המלונות אין אף איש קשר משותף של מחלקה", () => {
  for (const dept of config.DEPARTMENTS) {
    const a = config.departmentContacts(dept, LALA);
    const b = config.departmentContacts(dept, KEMP);
    assert.ok(a.whatsapp && b.whatsapp, `למחלקה ${dept} חסר מספר באחד המלונות`);
    assert.ok(a.email && b.email,       `למחלקה ${dept} חסר מייל באחד המלונות`);
    assert.notEqual(a.whatsapp, b.whatsapp, `${dept}: שני המלונות חולקים מספר וואטסאפ`);
    assert.notEqual(a.email,    b.email,    `${dept}: שני המלונות חולקים מייל`);
  }
});

test("בידוד: בקשת אחזקה במלון אחד לא נוגעת במחלקה של המלון השני", async () => {
  const phone = "whatsapp:+972500900001";
  sent.length = 0; emails.length = 0;
  aiReply = "מעביר לאחזקה 🙏\n[MAINTENANCE:מזגן לא מקרר · חדר 7]";
  state.deleteSession(phone, LALA);
  // בלי מספר חדר הבוט שואל אותו קודם (ובצדק) ולא מנתב — אז מדמים אורח
  // שכבר עשה צ'ק אין, שזה המצב שבו בקשת מחלקה באמת נשלחת.
  state.patchSession(phone, { lang: "he", roomNumber: "7", guestName: "דנה כהן" }, LALA);
  await bot.handleIncoming(phone, "המזגן לא עובד", null, { to: numberOf(LALA) });

  const lalaMaint = config.departmentContacts("maintenance", LALA);
  const kempMaint = config.departmentContacts("maintenance", KEMP);

  assert.ok(sent.some(m => m.to === lalaMaint.whatsapp), "ההתראה הגיעה לאחזקה של LALA");
  assert.ok(!sent.some(m => m.to === kempMaint.whatsapp), "🔴 ההתראה דלפה לאחזקה של קמפינסקי");
  assert.ok(emails.some(e => e.to === lalaMaint.email), "והמייל לאחזקה של LALA");
  assert.ok(!emails.some(e => e.to === kempMaint.email), "🔴 המייל דלף לקמפינסקי");
});

// ════════════════════════════════════════════════════════
//  2. חשבונית מס — מסמך משפטי שחייב לשאת את העוסק הנכון
// ════════════════════════════════════════════════════════
test("בידוד: החשבונית של כל מלון נושאת את פרטי העוסק שלו", async () => {
  const mk = async (hotelId, phone) => tenant.runInTenant(hotelId, async () => {
    const { reservationId } = await checkin.startCheckin(
      phone, { guestName: "דנה כהן", guestNameHe: "דנה כהן", guestNameEn: "Dana Cohen" },
      `RES-${hotelId}`, { stay: { checkIn: "2099-03-10", checkOut: "2099-03-12", nights: 2 } },
    );
    await checkin.completeCheckin(reservationId, "5");
    checkin.addFolioItem(reservationId, "MINIBAR", "מיני בר", 11800);
    return checkin.issueFolioInvoice(checkin.reservations[reservationId], "he");
  });

  const invLala = await mk(LALA, "whatsapp:+972500900002");
  const invKemp = await mk(KEMP, "whatsapp:+972500900003");

  const bizLala = config.configFor(LALA).business;
  const bizKemp = config.configFor(KEMP).business;

  assert.equal(invLala.seller.businessId, bizLala.business_id, "העוסק בחשבונית LALA");
  assert.equal(invKemp.seller.businessId, bizKemp.business_id, "העוסק בחשבונית קמפינסקי");
  assert.notEqual(invLala.seller.businessId, invKemp.seller.businessId,
    "🔴 שתי החשבוניות נושאות את אותו מספר עוסק");
  assert.notEqual(invLala.seller.name, invKemp.seller.name,
    "🔴 שתי החשבוניות נושאות את אותו שם עוסק");
  // כל מלון מנהל סדרת מספרים משלו (עוסק נפרד = ספרור נפרד).
  assert.match(invLala.number, /^\d{4}-\d{5}$/);
});

// ════════════════════════════════════════════════════════
//  3. הודעת הפתיחה — ההודעה הראשונה שאורח רואה
// ════════════════════════════════════════════════════════
test("פתיחה: כל מלון מברך בשמו שלו, ולא בשם מלון ברירת המחדל", () => {
  const lalaHe = config.welcomeFor(LALA, "he");
  const kempHe = config.welcomeFor(KEMP, "he");

  assert.match(lalaHe, /לאלה בוטיק/, "LALA מברכת בשמה");
  assert.ok(!/קמפינסקי/.test(lalaHe), "🔴 שם מלון אחר בהודעת הפתיחה של LALA");
  assert.match(kempHe, /קמפינסקי/, "קמפינסקי מברך בשמו");

  const lalaEn = config.welcomeFor(LALA, "en");
  assert.match(lalaEn, /LALA Boutique/);
  assert.ok(!/Kempinski/.test(lalaEn), "🔴 שם מלון אחר בפתיחה האנגלית של LALA");
});

test("פתיחה: לא מציעים שירות שאין במלון (בריכה/ספא/חדר כושר)", () => {
  const lala = config.welcomeFor(LALA, "he") + config.welcomeFor(LALA, "en");
  for (const word of ["בריכה", "ספא", "חדר כושר", "Pool", "spa", "gym"]) {
    assert.ok(!lala.includes(word), `🔴 הפתיחה של LALA מציעה "${word}" שאינו קיים במלון`);
  }
  // ובמלון שכן יש לו — כן מציעים.
  assert.match(config.welcomeFor(KEMP, "he"), /בריכה/, "מלון עם בריכה כן מציין אותה");
});

test("פתיחה: נוסח מותאם של מלון גובר, כולל {hotel}", () => {
  config.updateConfigFor("tmp-welcome", { name_he: "מלון הבדיקה", welcome: { he: "שלום מ{hotel}!" } });
  assert.equal(config.welcomeFor("tmp-welcome", "he"), "שלום ממלון הבדיקה!");
});

// ════════════════════════════════════════════════════════
//  4. מקטעים שלמים שנשארו של מלון ברירת המחדל
// ════════════════════════════════════════════════════════
test("בידוד: LALA אינה יורשת מסעדות, FAQ או מבנה מקמפינסקי", () => {
  const lala = config.configFor(LALA);
  const kemp = config.configFor(KEMP);

  // מסעדות פנימיות — `{}` אינו מנקה במיזוג עמוק, רק null מנקה.
  assert.ok(!Object.keys(lala.restaurants || {}).length,
    "🔴 LALA נושאת מסעדות פנימיות (של קמפינסקי) — הקונסיירז' ימליץ עליהן");

  // FAQ — מערך נדרס במלואו; אסור שיהיה זהה לזה של ברירת המחדל.
  assert.notDeepEqual(lala.faq, kemp.faq, "🔴 ה-FAQ של LALA הוא של קמפינסקי");

  // מבנה — key_areas של קמפינסקי מפרט בריכה בקומה 12 וספא בקומה 3.
  assert.notEqual(lala.building.he.key_areas, kemp.building.he.key_areas,
    "🔴 LALA מתארת את אזורי המלון של קמפינסקי");
  for (const word of ["קומה 12", "ספא", "בריכה"]) {
    assert.ok(!String(lala.building.he.key_areas).includes(word),
      `🔴 מבנה LALA מזכיר "${word}"`);
  }

  // מרחב מוגן — הנחיה שגויה באזעקה היא סיכון חיים.
  assert.notEqual(lala.safety.he.shelter_location, kemp.safety.he.shelter_location,
    "🔴 המרחב המוגן של LALA הוא זה של קמפינסקי");
});

test("בידוד: checkTenantIsolation תופס מלון שיורש שדות מברירת המחדל", () => {
  // מלון שהוגדר חלקית — רק שם ומיקום — חייב להיתפס.
  config.updateConfigFor("tmp-partial", { name: "Partial Hotel", name_he: "מלון חלקי" });
  const bad = config.checkTenantIsolation("tmp-partial");
  assert.equal(bad.ok, false, "מלון שהוגדר חלקית לא נתפס");
  assert.ok(bad.shared.includes("reception_number"), "אנשי קשר משותפים מדווחים");
  assert.ok(bad.shared.some(s => s.startsWith("business.")), "פרטי עוסק משותפים מדווחים");
  assert.ok(bad.shared.some(s => s.includes("מקטע שלם")), "מקטעים שלמים מדווחים");

  // LALA — מוגדרת במלואה, ולכן מבודדת.
  const good = config.checkTenantIsolation(LALA);
  assert.equal(good.ok, true, `LALA אינה מבודדת: ${good.shared.join(", ")}`);

  // מלון ברירת המחדל *הוא* DEFAULTS — אין מה להשוות.
  assert.equal(config.checkTenantIsolation(KEMP).skipped, true);
});

// ════════════════════════════════════════════════════════
//  5. סשן ומספר יוצא — אותו אורח בשני מלונות
// ════════════════════════════════════════════════════════
test("בידוד: אותו מספר טלפון בשני מלונות = שני סשנים, שני מספרים יוצאים", async () => {
  const phone = "whatsapp:+972500900009";
  state.deleteSession(phone, LALA);
  state.deleteSession(phone, KEMP);
  sent.length = 0;
  aiReply = "בבקשה!";

  await Promise.all([
    bot.handleIncoming(phone, "מה שעות ארוחת הבוקר?", null, { to: numberOf(LALA) }),
    bot.handleIncoming(phone, "מה שעות ארוחת הבוקר?", null, { to: numberOf(KEMP) }),
  ]);

  const sL = state.peekSession(phone, LALA);
  const sK = state.peekSession(phone, KEMP);
  assert.ok(sL && sK, "שני הסשנים קיימים");
  assert.notEqual(sL, sK, "🔴 אותו אובייקט סשן שימש את שני המלונות");

  const toGuest = sent.filter(m => m.to === phone);
  const froms = new Set(toGuest.map(m => tenant.normalizeNumber(String(m.from).replace(/^whatsapp:/, ""))));
  assert.ok(froms.has(tenant.normalizeNumber(numberOf(LALA))), "תשובה יצאה מהמספר של LALA");
  assert.ok(froms.has(tenant.normalizeNumber(numberOf(KEMP))), "תשובה יצאה מהמספר של קמפינסקי");
});

// ════════════════════════════════════════════════════════
//  5ב. הודעות שנשלחות **מחוץ** להקשר הטננט (עמודי התשלום)
// ════════════════════════════════════════════════════════
// 🔴 באג אמיתי שנתפס כאן: בקשת HTTP אינה רצה בתוך `runInTenant`. עמוד
//    ההצלחה של הפיקדון קרא ל-`completeCheckin`, ששולח לאורח את אישור
//    הצ'ק אין דרך `wa()` — ו-`wa()` גוזר את המספר היוצא מ-`currentHotelId()`.
//    בלי עטיפה, ההקשר הוא מלון ברירת המחדל, ואורח של LALA היה מקבל את
//    האישור **מהמספר של קמפינסקי**. עם מספר אחד זה בלתי נראה לחלוטין.
test("בידוד: אישור צ'ק אין יוצא מהמספר של המלון גם כשההודעה נולדת ב-HTTP", async () => {
  const phone = "whatsapp:+972500900021";
  const lalaNumber = tenant.normalizeNumber(numberOf(LALA));
  const kempNumber = tenant.normalizeNumber(numberOf(KEMP));
  assert.notEqual(lalaNumber, kempNumber, "הבדיקה דורשת שני מספרים שונים");

  const { reservationId } = await tenant.runInTenant(LALA, () => checkin.startCheckin(
    phone, { guestName: "דנה כהן", guestNameHe: "דנה כהן", guestNameEn: "Dana Cohen" },
    "RES-HTTP-1", { stay: { checkIn: "2099-04-01", checkOut: "2099-04-03", nights: 2 } },
  ));

  sent.length = 0;
  // מדמים בדיוק את מה שקורה בעמוד /checkin/success: קריאה **בלי** הקשר
  // טננט, כפי שהיא מגיעה מ-HTTP — אבל עטופה כמו שהקוד עושה עכשיו.
  await tenant.runInTenant(LALA, () => checkin.completeCheckin(reservationId, "7"));

  const toGuest = sent.filter(m => m.to === phone);
  assert.ok(toGuest.length, "האורח קיבל אישור");
  for (const m of toGuest) {
    assert.equal(
      tenant.normalizeNumber(String(m.from).replace(/^whatsapp:/, "")), lalaNumber,
      `🔴 אישור הצ'ק אין יצא מ-${m.from} ולא מהמספר של LALA`,
    );
  }
});

test("בידוד: בלי הקשר טננט ההודעה הייתה יוצאת מהמספר הלא נכון (הוכחת הבאג)", async () => {
  const phone = "whatsapp:+972500900022";
  const { reservationId } = await tenant.runInTenant(LALA, () => checkin.startCheckin(
    phone, { guestName: "דנה כהן", guestNameHe: "דנה כהן", guestNameEn: "Dana Cohen" },
    "RES-HTTP-2", { stay: { checkIn: "2099-04-01", checkOut: "2099-04-03", nights: 2 } },
  ));

  sent.length = 0;
  // ללא runInTenant — כפי שהיה לפני התיקון.
  await checkin.completeCheckin(reservationId, "7");

  const from = sent.filter(m => m.to === phone).map(m => tenant.normalizeNumber(String(m.from).replace(/^whatsapp:/, "")));
  assert.ok(from.length, "נשלחה הודעה");
  // ההזמנה של LALA, אבל ההקשר הוא ברירת המחדל → המספר של קמפינסקי.
  assert.ok(
    from.every(f => f === tenant.normalizeNumber(numberOf(KEMP))),
    "הבדיקה מתעדת את ההתנהגות השגויה שהתיקון מונע — אם היא נכשלת, הבאג הזה כבר לא קיים וניתן למחוק אותה",
  );
});

// ════════════════════════════════════════════════════════
//  6. מודל המלון — כרטיס מול קוד דלת, צוות במקום
// ════════════════════════════════════════════════════════
test("מודל: בוטיק = קוד דלת בלי צוות במקום; מלון מלא = כרטיס עם צוות", () => {
  const lala = config.hotelModel(LALA);
  const kemp = config.hotelModel(KEMP);
  assert.equal(lala.keyDelivery, "door_code");
  assert.equal(lala.staffed24_7, false);
  assert.equal(lala.onSiteSecurity, false);
  assert.ok(lala.dutyManagerNumber, "לבוטיק יש מנהל תורן להסלמת חירום");
  assert.equal(kemp.keyDelivery, "reception_card");
  assert.equal(kemp.onSiteSecurity, true);
});

// ════════════════════════════════════════════════════════
//  7. חיובי הדגמה — לא מחייבים על שירות שאין במלון
// ════════════════════════════════════════════════════════
test("חשבון: לא מופיע חיוב ספא במלון בלי ספא", async () => {
  const rid = await tenant.runInTenant(LALA, async () => {
    const { reservationId } = await checkin.startCheckin(
      "whatsapp:+972500900011", { guestName: "דנה כהן", guestNameHe: "דנה כהן", guestNameEn: "Dana Cohen" },
      "RES-DEMO-CHARGE", { stay: { checkIn: "2099-03-10", checkOut: "2099-03-12", nights: 2 } },
    );
    await checkin.completeCheckin(reservationId, "5");
    checkin.addDemoCharges(reservationId, "he");
    return reservationId;
  });
  const bill = checkin.formatFolio(checkin.reservations[rid], "he");
  assert.ok(!/ספא|עיסוי/.test(bill), `🔴 חשבון של מלון בלי ספא כולל חיוב ספא:\n${bill}`);
  assert.match(bill, /מיני בר/, "המיני בר כן מחויב");
});
