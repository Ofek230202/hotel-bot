// ════════════════════════════════════════════════════════
//  DEMO-SWITCH — בדיקה חיה: מספר אחד, שני מלונות, בלי שאריות
//  ----------------------------------------------------------
//  התרחיש האמיתי: יש מספר Twilio **אחד**. מחר מדגימים את LALA, מחרתיים
//  את קמפינסקי. הבדיקה מריצה בדיוק את זה — מחליפה את המספר, שולחת
//  הודעות דרך אותו נתיב של webhook אמיתי (`meta.to`), ומוודאת ששום
//  פרט מהמלון הקודם לא נשאר.
//
//  מה שנבדק בכל צד: שם המלון, הכתובת/המיקום שהקונסיירז' מחפש סביבו,
//  אמצעי הכניסה לחדר (קוד מול כרטיס), אנשי הקשר של המחלקות, פרטי
//  העוסק בחשבונית — ושאף אחד מהם אינו של המלון השני.
//
//  הרצה: npm test
// ════════════════════════════════════════════════════════
import { test, mock, before } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH                = freshTestDbPath("demo-switch");
process.env.TWILIO_ACCOUNT_SID     = "ACtest";
process.env.TWILIO_AUTH_TOKEN      = "test";
// המספר היחיד — כמו בסביבה האמיתית.
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+972500000000";
process.env.ANTHROPIC_API_KEY      = "sk-test";
process.env.BASE_URL               = "http://test.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);

const THE_NUMBER = "+972500000000";

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

let aiReply = "בוודאי!";
mock.module("@anthropic-ai/sdk", {
  exports: {
    default: class Anthropic {
      messages = { create: async () => ({ content: [{ type: "text", text: aiReply }] }) };
    },
  },
});

const { email } = await import("./email/index.js");
const emails = [];
email.send = async (m) => { emails.push(m); return { success: true }; };

const config  = await import("./config.js");
const tenant  = await import("./tenant.js");
const bot     = await import("./bot.js");
const state   = await import("./state.js");
const checkin = await import("./checkin.js");
const { db, DEFAULT_HOTEL_ID } = await import("./db.js");
const { SAMPLE_HOTELS } = await import("./sample-hotels.mjs");

// ── אותה לוגיקה שבה משתמש demo-switch.mjs ───────────────
// (הכלי עצמו הוא CLI; כאן משחזרים את הפעולה שהוא מבצע, כדי שהבדיקה
//  תיכשל אם ההתנהגות משתנה.)
function switchNumberTo(hotelId) {
  const cfg = SAMPLE_HOTELS.find(h => h.hotelId === hotelId)?.config;
  if (cfg && hotelId !== DEFAULT_HOTEL_ID) config.updateConfigFor(hotelId, cfg);
  // מוחקים כל מיפוי אחר — מספר יתום היה נבחר כמספר היוצא.
  for (const row of db.prepare(`SELECT number FROM hotel_numbers`).all()) {
    if (tenant.normalizeNumber(row.number) !== THE_NUMBER) {
      db.prepare(`DELETE FROM hotel_numbers WHERE number = ?`).run(row.number);
    }
  }
  tenant.registerHotelNumber(THE_NUMBER, hotelId, THE_NUMBER);
  // סשנים של המלון הזה — כדי שההדגמה מתחילה נקייה.
  for (const s of state.allSessions(hotelId)) state.deleteSession(s.phone, hotelId);
  db.prepare(`DELETE FROM sessions WHERE hotel_id = ?`).run(hotelId);
  config.clearConfigCache();
}

const GUEST = "whatsapp:+972521234567";
const say = (text, media = null) => bot.handleIncoming(GUEST, text, media, { to: THE_NUMBER });

before(() => { switchNumberTo(DEFAULT_HOTEL_ID); });

// ════════════════════════════════════════════════════════
test("מתג הדגמה: המספר מנותב ל-LALA — ואין שום פרט של קמפינסקי", async () => {
  switchNumberTo("lala");
  sent.length = 0;

  assert.equal(tenant.resolveHotelId(THE_NUMBER), "lala", "המספר מנותב ל-LALA");
  assert.equal(tenant.normalizeNumber(tenant.fromNumberFor("lala")), THE_NUMBER,
    "המספר היוצא של LALA הוא המספר היחיד שיש");

  await say("שלום");
  const welcome = sent.filter(m => m.to === GUEST).map(m => m.body).join("\n");
  assert.match(welcome, /לאלה בוטיק/, "הפתיחה בשם LALA");
  assert.ok(!/קמפינסקי|Kempinski/.test(welcome), `🔴 שם קמפינסקי בהודעה של LALA:\n${welcome}`);
  // LALA היא בוטיק בלי בריכה/ספא/חדר כושר — אסור שיוצעו.
  for (const w of ["בריכה", "ספא", "חדר כושר"]) {
    assert.ok(!welcome.includes(w), `🔴 הפתיחה של LALA מציעה "${w}"`);
  }

  const cfg = config.configFor(tenant.resolveHotelId(THE_NUMBER));
  assert.match(cfg.location.address_he, /בן צבי/, "המיקום של LALA");
  assert.equal(config.hotelModel("lala").keyDelivery, "door_code", "קוד לדלת, לא כרטיס");
  assert.equal(cfg.business.business_id, "515111222", "העוסק של LALA");
  assert.ok(!Object.keys(cfg.restaurants || {}).length, "אין מסעדות של קמפינסקי");
});

test("מתג הדגמה: בקשה ב-LALA מגיעה למחלקות של LALA בלבד", async () => {
  switchNumberTo("lala");
  sent.length = 0; emails.length = 0;
  state.patchSession(GUEST, { lang: "he", roomNumber: "7", guestName: "דנה כהן" }, "lala");
  aiReply = "מעביר לאחזקה 🙏\n[MAINTENANCE:מזגן לא מקרר · חדר 7]";
  await say("המזגן לא עובד");

  const lalaMaint = config.departmentContacts("maintenance", "lala");
  const kempMaint = config.departmentContacts("maintenance", DEFAULT_HOTEL_ID);
  assert.ok(sent.some(m => m.to === lalaMaint.whatsapp), "ההתראה לאחזקה של LALA");
  assert.ok(!sent.some(m => m.to === kempMaint.whatsapp), "🔴 ההתראה דלפה לקמפינסקי");
  assert.ok(emails.some(e => e.to === lalaMaint.email), "והמייל ל-LALA");
  assert.ok(!emails.some(e => e.to === kempMaint.email), "🔴 המייל דלף לקמפינסקי");
});

// ════════════════════════════════════════════════════════
test("מתג הדגמה: החזרה לקמפינסקי — ואין שום פרט של LALA", async () => {
  switchNumberTo("lala");            // קודם LALA…
  await say("שלום");
  switchNumberTo(DEFAULT_HOTEL_ID);  // …ואז מחזירים
  sent.length = 0;

  assert.equal(tenant.resolveHotelId(THE_NUMBER), DEFAULT_HOTEL_ID, "המספר חזר לקמפינסקי");
  assert.equal(tenant.normalizeNumber(tenant.fromNumberFor(DEFAULT_HOTEL_ID)), THE_NUMBER);

  await say("שלום");
  const welcome = sent.filter(m => m.to === GUEST).map(m => m.body).join("\n");
  assert.match(welcome, /קמפינסקי/, "הפתיחה בשם קמפינסקי");
  assert.ok(!/לאלה בוטיק|LALA/.test(welcome), `🔴 שם LALA בהודעה של קמפינסקי:\n${welcome}`);
  assert.match(welcome, /בריכה/, "קמפינסקי כן מציע בריכה");

  const cfg = config.configFor(DEFAULT_HOTEL_ID);
  assert.match(cfg.location.address_he, /הירקון/, "המיקום של קמפינסקי");
  assert.equal(config.hotelModel(DEFAULT_HOTEL_ID).keyDelivery, "reception_card", "כרטיס בקבלה");
  assert.equal(cfg.business.business_id, "514000000", "העוסק של קמפינסקי");
  assert.ok(Object.keys(cfg.restaurants || {}).length > 0, "מסעדות המלון חזרו");
  assert.ok(cfg.services.room_service, "שירות חדרים קיים");
  assert.ok(!/Shoreline2026|LALA_Guest/.test(JSON.stringify(cfg.wifi)), "🔴 ה-WiFi של LALA נשאר");
});

test("מתג הדגמה: הסשן מתאפס בהחלפה — הפתיחה מופיעה שוב", async () => {
  switchNumberTo("lala");
  await say("שלום");
  await say("עוד הודעה");         // messageCount > 1
  assert.ok(state.peekSession(GUEST, "lala")?.messageCount > 1);

  switchNumberTo("lala");          // החלפה חוזרת = איפוס
  assert.equal(state.peekSession(GUEST, "lala"), undefined, "הסשן נמחק");

  sent.length = 0;
  await say("שלום");
  assert.match(sent.filter(m => m.to === GUEST).map(m => m.body).join("\n"), /ברוכים הבאים/,
    "הפתיחה מופיעה שוב אחרי איפוס");
});

test("מתג הדגמה: נשאר בדיוק מיפוי אחד — אין מספר יתום שיגנוב את היציאה", () => {
  // מדמים שארית: מספר דמו שמצביע על אותו מלון.
  tenant.registerHotelNumber("+15550009999", "lala", "+15550009999");
  switchNumberTo("lala");
  const rows = db.prepare(`SELECT number, hotel_id FROM hotel_numbers`).all();
  assert.equal(rows.length, 1, `נשארו ${rows.length} מיפויים: ${rows.map(r => r.number).join(", ")}`);
  assert.equal(tenant.normalizeNumber(rows[0].number), THE_NUMBER);
  assert.equal(tenant.normalizeNumber(tenant.fromNumberFor("lala")), THE_NUMBER,
    "🔴 המספר היוצא אינו המספר האמיתי — הודעות היו נכשלות ב-Twilio");
});

test("מתג הדגמה: חשבונית אחרי החלפה נושאת את העוסק של המלון הפעיל", async () => {
  for (const [hotelId, expectBiz] of [["lala", "515111222"], [DEFAULT_HOTEL_ID, "514000000"]]) {
    switchNumberTo(hotelId);
    const inv = await tenant.runInTenant(hotelId, async () => {
      const { reservationId } = await checkin.startCheckin(
        "whatsapp:+972521111111",
        { guestName: "דנה כהן", guestNameHe: "דנה כהן", guestNameEn: "Dana Cohen" },
        `RES-SW-${hotelId}`, { stay: { checkIn: "2099-03-10", checkOut: "2099-03-12", nights: 2 } },
      );
      await checkin.completeCheckin(reservationId, "5");
      checkin.addFolioItem(reservationId, "MINIBAR", "מיני בר", 11800);
      return checkin.issueFolioInvoice(checkin.reservations[reservationId], "he");
    });
    assert.equal(inv.seller.businessId, expectBiz, `החשבונית של ${hotelId}`);
  }
});
