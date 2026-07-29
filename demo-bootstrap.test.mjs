// ════════════════════════════════════════════════════════
//  DEMO-BOOTSTRAP — מלון ההדגמה נקבע ממשתנה סביבה (מסלול הענן)
//  ----------------------------------------------------------
//  בענן (Railway) מערכת הקבצים בת-חלוף ואין שורות ב-DB, ולכן ההגדרה
//  חייבת להיגזר מ-`DEMO_HOTEL`. הבדיקות כאן מכסות בדיוק את מה שיקרה
//  שם בעלייה, כולל המקרים שנכשלים בשקט אם לא נזהרים.
//
//  הרצה: npm test
// ════════════════════════════════════════════════════════
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH                = freshTestDbPath("demo-boot");
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+14155238886";
process.env.ANTHROPIC_API_KEY      = "sk-test";
process.env.BASE_URL               = "http://test.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);

const NUMBER = "+14155238886";

const { db, DEFAULT_HOTEL_ID } = await import("./db.js");
const tenant = await import("./tenant.js");
const config = await import("./config.js");
const { bootstrapDemoHotel } = await import("./demo-bootstrap.js");

function wipe() {
  db.prepare(`DELETE FROM hotel_numbers`).run();
  db.prepare(`DELETE FROM config`).run();
  config.clearConfigCache();
  tenant.reloadHotelNumbers();
}

beforeEach(() => { wipe(); delete process.env.DEMO_HOTEL; });

test("bootstrap: בלי DEMO_HOTEL לא נוגעים בכלום", async () => {
  const r = await bootstrapDemoHotel();
  assert.equal(r.skipped, true);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM hotel_numbers`).get().c, 0,
    "לא נוצר מיפוי — פריסה אמיתית לא נדרסת בכל restart");
});

test("bootstrap: DEMO_HOTEL=lala ממפה את המספר וכותב את הקונפיג", async () => {
  process.env.DEMO_HOTEL = "lala";
  const r = await bootstrapDemoHotel();
  assert.equal(r.ok, true);
  assert.equal(r.hotelId, "lala");

  // המספר מנותב ל-LALA — זה מה שקובע למי הבוט עונה.
  assert.equal(tenant.resolveHotelId("whatsapp:" + NUMBER), "lala");
  // והמספר היוצא הוא אותו מספר (אחרת ספק הוואטסאפ דוחה).
  assert.equal(tenant.normalizeNumber(tenant.fromNumberFor("lala")), NUMBER);

  // הקונפיג באמת נכתב — בלעדיו configFor("lala") היה מחזיר את DEFAULTS,
  // כלומר את התוכן של קמפינסקי תחת השם "lala". זו המלכודת המרכזית.
  const cfg = config.configFor("lala");
  assert.match(cfg.name_he, /לאלה/);
  assert.match(cfg.location.address_he, /בן צבי/);
  assert.equal(config.hotelModel("lala").keyDelivery, "door_code");
  assert.equal(cfg.business.business_id, "515111222");
  assert.ok(!Object.keys(cfg.restaurants || {}).length, "אין מסעדות של קמפינסקי");
  assert.ok(!cfg.services?.pool, "אין בריכה של קמפינסקי");
});

test("bootstrap: DEMO_HOTEL=kempinski מחזיר את המספר למלון ברירת המחדל", async () => {
  process.env.DEMO_HOTEL = "lala";
  await bootstrapDemoHotel();
  assert.equal(tenant.resolveHotelId("whatsapp:" + NUMBER), "lala");

  process.env.DEMO_HOTEL = DEFAULT_HOTEL_ID;
  const r = await bootstrapDemoHotel();
  assert.equal(r.ok, true);
  assert.equal(tenant.resolveHotelId("whatsapp:" + NUMBER), DEFAULT_HOTEL_ID);
  assert.equal(tenant.normalizeNumber(tenant.fromNumberFor(DEFAULT_HOTEL_ID)), NUMBER);
  assert.match(config.configFor(DEFAULT_HOTEL_ID).location.address_he, /הירקון/);
});

test("bootstrap: אידמפוטנטי — עלייה חוזרת משאירה מיפוי אחד בדיוק", async () => {
  process.env.DEMO_HOTEL = "lala";
  await bootstrapDemoHotel();
  await bootstrapDemoHotel();
  await bootstrapDemoHotel();
  const rows = db.prepare(`SELECT number, hotel_id FROM hotel_numbers`).all();
  assert.equal(rows.length, 1, `נשארו ${rows.length} מיפויים`);
  assert.equal(rows[0].hotel_id, "lala");
});

test("bootstrap: מיפוי יתום נמחק — אחרת התשובות יוצאות ממספר לא קיים", async () => {
  // מדמים שארית: מספר דמו שמצביע על אותו מלון.
  tenant.registerHotelNumber("+15550001007", "lala", "+15550001007");
  process.env.DEMO_HOTEL = "lala";
  await bootstrapDemoHotel();

  const rows = db.prepare(`SELECT number FROM hotel_numbers`).all();
  assert.equal(rows.length, 1, "נשאר מיפוי אחד");
  assert.equal(tenant.normalizeNumber(rows[0].number), NUMBER);
  assert.equal(tenant.normalizeNumber(tenant.fromNumberFor("lala")), NUMBER,
    "🔴 המספר היוצא אינו המספר האמיתי");
});

test("bootstrap: DEMO_HOTEL לא מוכר → לא נוגעים בכלום, ומדווחים", async () => {
  process.env.DEMO_HOTEL = "no-such-hotel";
  const r = await bootstrapDemoHotel();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown_hotel");
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM hotel_numbers`).get().c, 0);
});

test("bootstrap: DEMO_HOTEL בלי מספר וואטסאפ → נכשל בקול, לא בשקט", async () => {
  const saved = process.env.TWILIO_WHATSAPP_NUMBER;
  delete process.env.TWILIO_WHATSAPP_NUMBER;
  process.env.DEMO_HOTEL = "lala";
  try {
    const r = await bootstrapDemoHotel();
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no_number");
  } finally {
    process.env.TWILIO_WHATSAPP_NUMBER = saved;
  }
});
