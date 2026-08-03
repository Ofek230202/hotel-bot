// ════════════════════════════════════════════════════════
//  TAKEOVER — איש צוות נכנס לשיחה
//  ----------------------------------------------------------
//  שתי דרכים שבהן זה יכול להיכשל בצורה חמורה, ושתיהן נבדקות כאן:
//   🔴 הבוט ממשיך לענות בזמן שמנהל מטפל → אורח מקבל שני קולות סותרים.
//   🔴 מנהל שוכח לשחרר → אורח כותב ואיש לא עונה. **זה החמור מבין השניים**,
//      ולכן להשתלטות יש מועד פקיעה ולא רק כפתור.
// ════════════════════════════════════════════════════════
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH = freshTestDbPath("takeover");
process.env.TWILIO_ACCOUNT_SID     = "ACtest";
process.env.TWILIO_AUTH_TOKEN      = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.ANTHROPIC_API_KEY      = "sk-test";
process.env.BASE_URL               = "http://test.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);

const outgoing = [];
mock.module("twilio", {
  exports: { default: () => ({ messages: { create: async ({ to, body }) => { outgoing.push({ to, body }); return { sid: "SM" }; } } }) },
});
// AI שמסמן את עצמו — כדי לזהות בוודאות אם הבוט ענה.
mock.module("@anthropic-ai/sdk", {
  exports: { default: class {
    constructor() {
      this.messages = { create: async () => ({ content: [{ type: "text", text: "תשובת הבוט האוטומטית" }], stop_reason: "end_turn" }) };
    }
  } },
});
const { email } = await import("./email/index.js");
email.send = async () => ({ success: true });

const to     = await import("./takeover.js");
const bot    = await import("./bot.js");
const state  = await import("./state.js");
const tenant = await import("./tenant.js");

const HID = tenant.DEFAULT_HOTEL_ID;
const botReplied = phone => outgoing.some(o => o.to === phone && /תשובת הבוט האוטומטית/.test(o.body));

// ════════════════════════════════════════════════════════
test("ברירת המחדל: הבוט עונה", async () => {
  outgoing.length = 0;
  const phone = "whatsapp:+972541110001";
  await bot.handleIncoming(phone, "מה שעות הבריכה?", null, {});
  assert.ok(botReplied(phone), "בלי השתלטות — הבוט עונה כרגיל");
});

test("🔴 בזמן השתלטות הבוט שותק — אבל ההודעה נשמרת והצוות מקבל התראה", async () => {
  const phone = "whatsapp:+972541110002";
  await bot.handleIncoming(phone, "שלום", null, {});
  await to.takeOver(phone, { by: "מיכל (מנהלת)", hotelId: HID });

  outgoing.length = 0;
  await bot.handleIncoming(phone, "אני רוצה להתלונן על החדר", null, {});

  assert.ok(!botReplied(phone), "🔴 הבוט ענה בזמן שמנהלת מטפלת — האורח מקבל שני קולות");

  // ההודעה נשמרה — אחרת המנהלת לא תראה מה האורח כתב.
  const s = state.peekSession(phone, HID);
  assert.ok(s.history.some(h => h.role === "user" && /להתלונן/.test(h.content)),
    "🔴 הודעת האורח לא נשמרה בהיסטוריה");

  // הצוות קיבל התראה — אחרת "השתלטות" פירושה אורח שכותב לחלל ריק.
  assert.ok(outgoing.some(o => /בטיפולך|מיכל/.test(o.body)),
    "🔴 איש הצוות לא קיבל התראה שהאורח כתב");
});

test("🔴 חירום גובר על השתלטות — תמיד", async () => {
  const phone = "whatsapp:+972541110003";
  await bot.handleIncoming(phone, "שלום", null, {});
  await to.takeOver(phone, { by: "מנהל", hotelId: HID });

  outgoing.length = 0;
  await bot.handleIncoming(phone, "נפלתי במקלחת ואני לא מצליחה לקום", null, {});

  const guest = outgoing.filter(o => o.to === phone).map(o => o.body).join("\n");
  assert.match(guest, /101|מד"א|מגן דוד/,
    "🔴 אורח פצוע לא קיבל הנחיית חירום כי מנהל 'החזיק' את השיחה — אין שיקול תפעולי שדוחה בטיחות");
});

test("שחרור מחזיר את הבוט לענות", async () => {
  const phone = "whatsapp:+972541110004";
  await bot.handleIncoming(phone, "שלום", null, {});
  await to.takeOver(phone, { by: "מנהל", hotelId: HID });
  await to.releaseTakeover(phone, { by: "מנהל", hotelId: HID });

  outgoing.length = 0;
  await bot.handleIncoming(phone, "מה שעות הספא?", null, {});
  assert.ok(botReplied(phone), "🔴 הבוט לא חזר לענות אחרי שחרור");
});

// ════════════════════════════════════════════════════════
//  פקיעה — ההגנה מפני "שכחתי לשחרר"
// ════════════════════════════════════════════════════════
test("🔴 השתלטות פגה מעצמה — אורח לעולם לא נשאר מול שקט", async () => {
  const phone = "whatsapp:+972541110005";
  await bot.handleIncoming(phone, "שלום", null, {});
  await to.takeOver(phone, { by: "מנהל שישכח", hotelId: HID, ttlMs: 50 });

  assert.equal(to.isHumanHandling(phone, HID), true, "פעילה מיד");
  await new Promise(r => setTimeout(r, 80));
  assert.equal(to.isHumanHandling(phone, HID), false,
    "🔴 ההשתלטות לא פגה — אורח שכותב עכשיו לא יקבל מענה מאף אחד");

  outgoing.length = 0;
  await bot.handleIncoming(phone, "הלו? יש שם מישהו?", null, {});
  assert.ok(botReplied(phone), "🔴 הבוט לא חזר אחרי הפקיעה");
});

test("הסורק מודיע לצוות שההשתלטות פגה", async () => {
  const notes = [];
  to.setNotifier(async a => { notes.push(a); });
  const phone = "whatsapp:+972541110006";
  await bot.handleIncoming(phone, "שלום", null, {});
  await to.takeOver(phone, { by: "יעל", hotelId: HID, ttlMs: 10 });
  await new Promise(r => setTimeout(r, 30));

  to.setSessionSource(async () => [state.peekSession(phone, HID)]);
  const out = await to.sweepTakeovers();

  assert.equal(out.expired, 1);
  assert.ok(notes.some(n => /פגה|חזר לענות/.test(n.message)),
    "🔴 הצוות לא יודע שהבוט חזר — מנהל בטוח שהוא עדיין מטפל");
  assert.equal(to.isHumanHandling(phone, HID), false);
});

test("הארכה שומרת על זהות המטפל", async () => {
  const phone = "whatsapp:+972541110007";
  await bot.handleIncoming(phone, "שלום", null, {});
  await to.takeOver(phone, { by: "רון", hotelId: HID, ttlMs: 60_000 });
  const ext = await to.extendTakeover(phone, { hotelId: HID, ttlMs: 120_000 });

  assert.equal(ext.by, "רון", "🔴 שרשרת האחריות נדרסה בהארכה");
  const st = to.takeoverState(phone, HID);
  assert.ok(st.msLeft > 60_000, "המועד הוארך");
});

test("מי שהשתלט נרשם — אחרת אין שרשרת אחריות", async () => {
  const phone = "whatsapp:+972541110008";
  await bot.handleIncoming(phone, "שלום", null, {});
  await to.takeOver(phone, { by: "דנה מהקבלה", reason: "תלונה", hotelId: HID });
  const st = to.takeoverState(phone, HID);
  assert.equal(st.by, "דנה מהקבלה");
  assert.equal(st.reason, "תלונה");
  assert.ok(st.since && st.expiresAt);
});

test("שיחה שלא הושתלטה מדווחת לא-פעילה, בלי לזרוק", () => {
  assert.deepEqual(to.takeoverState("whatsapp:+972549999999", HID), { active: false });
});
