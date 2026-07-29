// ════════════════════════════════════════════════════════
//  VERIFY-NUMBER — הוכחה חיה: למי עונה מספר ה-Twilio האמיתי
//  ----------------------------------------------------------
//  רץ מול **בסיס הנתונים האמיתי** (hotel.db) ומול המספר האמיתי, ומריץ
//  הודעה דרך אותו נתיב בדיוק שבו עוברת הודעת WhatsApp אמיתית
//  (`handleIncoming` עם `meta.to`). ההבדל היחיד: שליחת Twilio מוחלפת,
//  כדי שהבדיקה **לא תשלח שום הודעה לאף אחד**.
//
//  מה שנבדק:
//   1. המספר מנותב למלון שצריך (`resolveHotelId`).
//   2. התשובה בפועל היא של אותו מלון — שם, שירותים — ובלי שום פרט
//      של המלון השני.
//   3. המספר שממנו התשובה יוצאת הוא המספר האמיתי (אחרת Twilio דוחה).
//
//  ניקוי: הסשן הזמני שנוצר לטלפון הבדיקה נמחק בסוף, כדי לא להשאיר
//  שאריות בבסיס הנתונים האמיתי.
//
//  הרצה: node --experimental-test-module-mocks verify-number.mjs [lala|kempinski]
// ════════════════════════════════════════════════════════
import { mock } from "node:test";
import dotenv from "dotenv";
dotenv.config();

const C = { dim: "\x1b[2m", b: "\x1b[1m", r: "\x1b[0m", gr: "\x1b[32m", re: "\x1b[31m", ye: "\x1b[33m", cy: "\x1b[36m" };

const EXPECT = (process.argv[2] || "").toLowerCase() || null;
const NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "whatsapp:+14155238886";
// טלפון בדיקה מסומן — הסשן שלו נמחק בסוף.
const TEST_GUEST = "whatsapp:+972500000777";

const sent = [];
mock.module("twilio", {
  exports: {
    default: () => ({
      messages: {
        create: async ({ from, to, body }) => {
          if (!body) throw new Error("Twilio: body is required");
          sent.push({ from, to, body });
          return { sid: "SMverify" };
        },
      },
    }),
  },
});

// מייל — לא שולחים בבדיקה.
const { email } = await import("./email/index.js");
email.send = async () => ({ success: true });

const tenant = await import("./tenant.js");
const config = await import("./config.js");
const bot    = await import("./bot.js");
const state  = await import("./state.js");

// חתימות זיהוי לכל מלון — מה *חייב* להופיע ומה אסור שיופיע.
const SIGNATURES = {
  lala: {
    label: "LALA Boutique · לאלה בוטיק",
    must:   [/לאלה בוטיק/],
    mustNot: [/קמפינסקי/, /Kempinski/, /בריכה/, /חדר כושר/],
  },
  kempinski: {
    label: "The David Kempinski · מלון דוד קמפינסקי",
    must:   [/קמפינסקי/],
    mustNot: [/לאלה בוטיק/, /LALA/],
  },
};

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`   ${ok ? C.gr + "✅" : C.re + "❌"} ${name}${C.r}${!ok && detail ? `\n${C.re}      ${detail}${C.r}` : ""}`);
}

console.log(`\n${C.ye}${C.b}${"═".repeat(66)}\n  🔎 בדיקה חיה — למי עונה ${NUMBER}\n${"═".repeat(66)}${C.r}`);
console.log(`${C.dim}   בסיס נתונים: ${process.env.DB_PATH || "hotel.db"} (האמיתי)${C.r}`);
console.log(`${C.dim}   שליחת Twilio מוחלפת — שום הודעה לא תישלח לאף אחד.${C.r}\n`);

// ── 1. ניתוב המספר ──────────────────────────────────────
const hotelId = tenant.resolveHotelId(NUMBER);
const cfg     = config.configFor(hotelId);
const sig     = SIGNATURES[hotelId] || null;

console.log(`   ${C.b}המספר מנותב ל:${C.r} ${cfg.name_he || cfg.name} ${C.dim}(${hotelId})${C.r}`);
console.log(`   ${C.b}כתובת:${C.r} ${cfg.location?.address_he}`);
console.log(`   ${C.b}כניסה לחדר:${C.r} ${config.hotelModel(hotelId).keyDelivery === "door_code" ? "קוד לדלת" : "כרטיס בקבלה"}`);
console.log(`   ${C.b}עוסק לחשבונית:${C.r} ${cfg.business?.business_id}\n`);

if (EXPECT) {
  check(`המספר מנותב ל-"${EXPECT}" כמצופה`, hotelId === EXPECT, `בפועל: ${hotelId}`);
}
check("המספר היוצא זהה למספר הנכנס (אחרת Twilio ידחה)",
  tenant.normalizeNumber(tenant.fromNumberFor(hotelId)) === tenant.normalizeNumber(NUMBER),
  `יוצא: ${tenant.fromNumberFor(hotelId)} · נכנס: ${tenant.normalizeNumber(NUMBER)}`);

// ── 2. הודעה אמיתית דרך אותו נתיב של webhook ────────────
state.deleteSession(TEST_GUEST, hotelId);
sent.length = 0;
await bot.handleIncoming(TEST_GUEST, "שלום", null, { to: NUMBER });

const toGuest = sent.filter(m => m.to === TEST_GUEST);
const reply   = toGuest.map(m => m.body).join("\n");

console.log(`\n   ${C.b}מה שהאורח קיבל בפועל:${C.r}`);
console.log(reply.split("\n").map(l => `     ${C.cy}│${C.r} ${l}`).join("\n"));
console.log("");

check("האורח קיבל תשובה", toGuest.length > 0);
check("התשובה יצאה מהמספר האמיתי",
  toGuest.every(m => tenant.normalizeNumber(String(m.from).replace(/^whatsapp:/, "")) === tenant.normalizeNumber(NUMBER)),
  `יצא מ: ${[...new Set(toGuest.map(m => m.from))].join(", ")}`);

if (sig) {
  for (const re of sig.must) {
    check(`התשובה כוללת את זהות המלון (${re.source})`, re.test(reply));
  }
  for (const re of sig.mustNot) {
    check(`התשובה *אינה* כוללת פרט של המלון השני (${re.source})`, !re.test(reply),
      `נמצא "${re.source}" בתשובה`);
  }
} else {
  console.log(`${C.ye}   ⚠️ אין חתימת זיהוי למלון "${hotelId}" — מדלגים על בדיקת התוכן.${C.r}`);
}

// ── 3. ניקוי — לא משאירים שאריות ב-DB האמיתי ────────────
state.deleteSession(TEST_GUEST, hotelId);
check("הסשן הזמני של הבדיקה נמחק", !state.peekSession(TEST_GUEST, hotelId));

// ── סיכום ───────────────────────────────────────────────
const bad = results.filter(r => !r.ok);
console.log(
  bad.length === 0
    ? `\n${C.gr}${C.b}   ✅ ${NUMBER} עונה כ"${cfg.name_he}" — ${results.length} בדיקות עברו.${C.r}\n`
    : `\n${C.re}${C.b}   ❌ ${bad.length} מתוך ${results.length} בדיקות נכשלו.${C.r}\n`
);
process.exit(bad.length === 0 ? 0 : 1);
