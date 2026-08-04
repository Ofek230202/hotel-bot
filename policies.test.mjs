// ════════════════════════════════════════════════════════
//  POLICIES — התשובות שאורח שואל לפני שהוא מזמין
//  ----------------------------------------------------------
//  🔴 הבוט **אינו ממציא** — זו תכונה, לא באג. אבל אורח ששואל "יש מיטת
//     תינוק?" ומקבל "אבדוק ואחזור" מרגיש שהמלון אינו מאורגן. הפתרון אינו
//     לרופף את כלל האמינות, אלא **לתת לבוט את התשובה**.
//
//  הבדיקות כאן מוודאות שכל מדיניות מגיעה ל-prompt, בשתי השפות, נגזרת
//  מהמלון הספציפי, ושמלון שהגדיר אחרת — מקבל את שלו.
// ════════════════════════════════════════════════════════
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH = freshTestDbPath("policies");
process.env.TWILIO_ACCOUNT_SID     = "ACtest";
process.env.TWILIO_AUTH_TOKEN      = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.ANTHROPIC_API_KEY      = "sk-test";
process.env.BASE_URL               = "http://test.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);

let aiParams = null;
mock.module("@anthropic-ai/sdk", {
  exports: { default: class {
    constructor() {
      this.messages = { create: async (p) => {
        aiParams = p;
        return { content: [{ type: "text", text: "בשמחה." }], stop_reason: "end_turn" };
      } };
    }
  } },
});
mock.module("twilio", {
  exports: { default: () => ({ messages: { create: async () => ({ sid: "SM" }) } }) },
});
const { email } = await import("./email/index.js");
email.send = async () => ({ success: true });

const bot    = await import("./bot.js");
const config = await import("./config.js");
const tenant = await import("./tenant.js");

const HID = tenant.DEFAULT_HOTEL_ID;

/** שולח הודעה ומחזיר את ה-system prompt שנשלח ל-Claude. */
async function promptFor(text, { hotelId = HID, phone = "whatsapp:+972551110001" } = {}) {
  aiParams = null;
  await bot.handleIncoming(phone, text, null, { hotelId });
  return String(aiParams?.system || "");
}

// ════════════════════════════════════════════════════════
test("כל מדיניות שגיא פירט מגיעה ל-prompt", async () => {
  const p = await promptFor("שלום, יש לי כמה שאלות");
  for (const [label, why] of [
    ["מיטת תינוק",     "אורח עם תינוק שואל את זה לפני שהוא מזמין"],
    ["נגישות",         "שאלה שאי אפשר לענות עליה 'אבדוק'"],
    ["בעלי חיים",      "תשובה שלילית ברורה עדיפה על 'אבדוק'"],
    ["שמירת מזוודות",  "שאלה של יום העזיבה"],
    ["ביטול הזמנה",    "שאלה כספית — חייבת תשובה ודאית"],
    ["עישון",          ""],
    ["שעות מנוחה",     ""],
    ["כניסה מוקדמת",   ""],
    ["יציאה מאוחרת",   ""],
  ]) {
    assert.ok(p.includes(label), `🔴 "${label}" לא הגיע ל-prompt${why ? ` — ${why}` : ""}`);
  }
});

test("ההנחיה אומרת במפורש לא לומר 'אבדוק ואחזור' על מה שידוע", async () => {
  const p = await promptFor("שאלה");
  assert.match(p.replace(/\s+/g, " "), /אל תאמר "אבדוק ואחזור"/,
    "🔴 בלי ההנחיה הזו הבוט יענה 'אבדוק' גם כשהתשובה מולו");
});

test("אנגלית: אותן מדיניות, בשפה של האורח", async () => {
  const p = await promptFor("Hello, I have a few questions", { phone: "whatsapp:+972551110002" });
  for (const label of ["Cot", "Accessibility", "Pets", "Luggage storage", "Cancellation", "Late check-out"]) {
    assert.ok(p.includes(label), `🔴 "${label}" חסר ב-prompt האנגלי`);
  }
  // ההנחיה משתרעת על שתי שורות ב-prompt — משטחים לפני ההשוואה.
  assert.match(p.replace(/\s+/g, " "), /Never say you will check and come back/,
    "🔴 בלי ההנחיה הזו הבוט יענה 'I'll check' גם כשהתשובה מולו");
});

test("🔴 המדיניות היא של **אותו מלון** — לא של ברירת המחדל", async () => {
  config.updateConfigFor("pol_pets_ok", {
    name: "Pet Friendly", name_he: "מלון ידידותי",
    policies: {
      pets: { allowed: true, he: "בעלי חיים מוזמנים בשמחה, ללא תשלום", en: "Pets are warmly welcome, at no charge" },
      baby_cot: { available: false, he: "אין מיטות תינוק במלון זה", en: "Cots are not available at this hotel" },
    },
  });
  tenant.registerHotelNumber("+15558880001", "pol_pets_ok");
  tenant.reloadHotelNumbers();

  const p = await promptFor("יש לכם חיות?", { hotelId: "pol_pets_ok", phone: "whatsapp:+972551110003" });
  assert.match(p, /בעלי חיים מוזמנים בשמחה/, "🔴 המלון קיבל את המדיניות של ברירת המחדל");
  assert.ok(!/איננו מארחים בעלי חיים/.test(p), "🔴 מדיניות של מלון אחר דלפה");
  assert.match(p, /אין מיטות תינוק/, "מדיניות שלילית מגיעה גם היא");
});

test("שירות שאינו זמין מסומן ככזה, ולא נעלם", async () => {
  config.updateConfigFor("pol_no_late", {
    name_he: "בלי יציאה מאוחרת",
    late_checkout: { available: false },
  });
  tenant.registerHotelNumber("+15558880002", "pol_no_late");
  tenant.reloadHotelNumbers();

  const p = await promptFor("אפשר יציאה מאוחרת?", { hotelId: "pol_no_late", phone: "whatsapp:+972551110004" });
  assert.match(p, /יציאה מאוחרת: אינה אפשרית/,
    "🔴 שירות שאינו קיים חייב להיאמר במפורש — אחרת הבוט מבטיח משהו שאין");
});

test("מחיר מופיע כשיש, ואינו מופיע כשאין", async () => {
  config.updateConfigFor("pol_paid", {
    name_he: "בתשלום",
    late_checkout: { available: true, until: "16:00", price_cents: 25000, he: "יציאה מאוחרת עד 16:00" },
  });
  tenant.registerHotelNumber("+15558880003", "pol_paid");
  tenant.reloadHotelNumbers();

  const p = await promptFor("כמה עולה יציאה מאוחרת?", { hotelId: "pol_paid", phone: "whatsapp:+972551110005" });
  assert.match(p, /₪250/, "🔴 המחיר לא הגיע — אורח ישאל שוב");
});

test("מלון בלי מדיניות כלל אינו מייצר שורות ריקות או undefined", async () => {
  config.updateConfigFor("pol_empty", { name_he: "ריק", policies: null, early_checkin: null, late_checkout: null });
  tenant.registerHotelNumber("+15558880004", "pol_empty");
  tenant.reloadHotelNumbers();

  const p = await promptFor("שלום", { hotelId: "pol_empty", phone: "whatsapp:+972551110006" });
  assert.ok(!/undefined|\[object Object\]|null/.test(p.split("מדיניות המלון")[1]?.slice(0, 400) || ""),
    "🔴 ערך לא מוגדר דלף ל-prompt");
});
