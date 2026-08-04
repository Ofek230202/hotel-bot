// ════════════════════════════════════════════════════════
//  מדיה נכנסת — הודעה קולית אינה "תמונה"
//  ----------------------------------------------------------
//  🔴 באג שנתפס בסקירה (04.08.2026): כל מדיה, מכל סוג, תוארה ל-AI כ-
//     "האורח שלח תמונה ללא טקסט". בוואטסאפ בישראל הודעה קולית היא אחת
//     הדרכים הנפוצות ביותר לפנות — ולכן אורח שדיבר קיבל תשובה על *צילום*
//     שמעולם לא שלח. הבדיקה נראתה ירוקה כי אף בדיקה לא שלחה audio/ogg.
//
//  אין כאן תמלול ואין הבטחה לתמלול: המערכת אומרת בכנות שהיא קוראת טקסט,
//  ומציעה חלופה מיידית. זה מה שנבדק כאן.
// ════════════════════════════════════════════════════════
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH                = freshTestDbPath("media");
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

let aiSawMessages = null;
mock.module("@anthropic-ai/sdk", {
  defaultExport: class {
    messages = {
      create: async (params) => {
        aiSawMessages = params.messages;
        return { content: [{ type: "text", text: "בוודאי, אשמח לעזור." }], stop_reason: "end_turn" };
      },
    };
  },
});

const { handleIncoming, classifyMedia } = await import("./bot.js");
const { registerHotelNumber } = await import("./tenant.js");

const HOTEL_NUM = "whatsapp:+10000000000";
registerHotelNumber(HOTEL_NUM, "kempinski");

let seq = 0;
const nextPhone = () => `whatsapp:+9725999${String(++seq).padStart(4, "0")}`;
beforeEach(() => { sent.length = 0; aiSawMessages = null; });

const guestText = (phone) => sent.filter(s => s.to === phone).map(s => s.body).join("\n");

// ── סיווג ──────────────────────────────────────────────
test("סיווג: כל סוג מדיה מזוהה לפי מה שטוויליו מסר", () => {
  assert.equal(classifyMedia("audio/ogg; codecs=opus"), "audio"); // ← וואטסאפ שולח בדיוק כך
  assert.equal(classifyMedia("image/jpeg"), "image");
  assert.equal(classifyMedia("video/mp4"), "video");
  assert.equal(classifyMedia("application/pdf"), "document");
  assert.equal(classifyMedia(""), "unknown");
  assert.equal(classifyMedia(undefined), "unknown");
});

// ── הודעה קולית ────────────────────────────────────────
test("הודעה קולית: האורח מקבל תשובה כנה — ולא תשובה על 'תמונה'", async () => {
  const phone = nextPhone();
  await handleIncoming(phone, "", { url: "https://x/a.ogg", contentType: "audio/ogg; codecs=opus" }, { to: HOTEL_NUM });
  const reply = guestText(phone);
  assert.ok(reply.trim(), "אורח שדיבר חייב לקבל תשובה");
  assert.match(reply, /קולית/, "התשובה חייבת להכיר בכך שזו הודעה קולית");
  assert.doesNotMatch(reply, /תמונה|צילום/, "🔴 הודעה קולית תוארה כתמונה — הבאג המקורי");
  // הודאה בלבד אינה שירות: חייבת להיות דרך אחת ברורה להמשיך.
  assert.match(reply, /לכתוב|במילים|להתקשר/, "חייבת להיות חלופה מעשית, לא רק סירוב");
});

test("הודעה קולית באנגלית: אותה התנהגות, בשפת האורח", async () => {
  const phone = nextPhone();
  await handleIncoming(phone, "hello", null, { to: HOTEL_NUM });   // קובע אנגלית
  sent.length = 0;
  await handleIncoming(phone, "", { url: "https://x/a.ogg", contentType: "audio/ogg" }, { to: HOTEL_NUM });
  const reply = guestText(phone);
  assert.match(reply, /voice message/i);
  assert.doesNotMatch(reply, /\bimage\b|\bphoto\b/i, "🔴 תוארה כתמונה באנגלית");
  assert.doesNotMatch(reply, /[֐-׿]/, "אורח אנגלי לא אמור לקבל עברית");
});

test("הודעה קולית לא נשלחת ל-AI כאילו הייתה תמונה", async () => {
  const phone = nextPhone();
  await handleIncoming(phone, "", { url: "https://x/a.ogg", contentType: "audio/ogg" }, { to: HOTEL_NUM });
  const flat = JSON.stringify(aiSawMessages || []);
  assert.doesNotMatch(flat, /שלח תמונה|sent an image/, "🔴 ה-AI קיבל 'תמונה' על הודעה קולית");
});

test("סרטון וקובץ: נענים בכנות, לפי סוגם", async () => {
  for (const [ct, expect] of [["video/mp4", /סרטון/], ["application/pdf", /קובץ/]]) {
    const phone = nextPhone();
    sent.length = 0;
    await handleIncoming(phone, "", { url: "https://x/f", contentType: ct }, { to: HOTEL_NUM });
    assert.match(guestText(phone), expect, `${ct} לא תואר נכון`);
  }
});

// ── מה שאסור שיישבר ────────────────────────────────────
test("תמונה עדיין עוברת רגיל — התיקון לא חסם צילומים", async () => {
  const phone = nextPhone();
  await handleIncoming(phone, "", { url: "https://x/p.jpg", contentType: "image/jpeg" }, { to: HOTEL_NUM });
  const reply = guestText(phone);
  assert.ok(reply.trim(), "תמונה חייבת להמשיך להיענות");
  assert.doesNotMatch(reply, /קולית|סרטון/, "תמונה סווגה כמדיה אחרת");
});

test("מדיה עם כיתוב: הטקסט מטופל, וה-AI יודע מה באמת צורף", async () => {
  const phone = nextPhone();
  await handleIncoming(phone, "מה שעות הספא?", { url: "https://x/a.ogg", contentType: "audio/ogg" }, { to: HOTEL_NUM });
  const flat = JSON.stringify(aiSawMessages || []);
  assert.match(flat, /שעות הספא/, "הטקסט של האורח חייב להגיע ל-AI");
  assert.doesNotMatch(flat, /שלח תמונה|an image/, "🔴 קול תואר כתמונה גם עם כיתוב");
});

test("חירום גובר על מדיה — 'נפצעתי' + קובץ עדיין מפעיל חירום", async () => {
  const phone = nextPhone();
  await handleIncoming(phone, "נפצעתי בחדר", { url: "https://x/a.ogg", contentType: "audio/ogg" }, { to: HOTEL_NUM });
  const reply = guestText(phone);
  assert.match(reply, /101/, "🔴 חירום נבלע בגלל שצורפה מדיה — אין שיקול שדוחה 101");
});
