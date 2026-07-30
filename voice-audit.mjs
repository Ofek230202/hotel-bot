// ════════════════════════════════════════════════════════
//  VOICE-AUDIT — מריץ את הבוט ומדרג כל מילה שהוא אומר
//  ----------------------------------------------------------
//  "טון חם ומקצועי" הוא לא משהו שאפשר לאמת בקריאה חוזרת של הקוד. לכן
//  כאן מריצים את הזרימות **בפועל**, אוספים כל הודעה שנשלחה לאורח,
//  ומעבירים אותה דרך `voice.js`.
//
//  שתי השפות, שני המלונות, וכל השלבים — כולל אלה שקשה להגיע אליהם ידנית
//  (דחיית מסמך, תאריך שעבר, סירוב לתנאים, חירום).
//
//  ללא AI: כל מה שנבדק כאן הוא **טקסט דטרמיניסטי מהקוד** — בדיוק החלק
//  שאנחנו שולטים בו ושחייב להיות מושלם. תשובות ה-AI נבדקות ב-preflight
//  מול Claude אמיתי.
//
//  הרצה:  node --experimental-test-module-mocks voice-audit.mjs [--verbose]
// ════════════════════════════════════════════════════════
import { mock } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.DB_PATH                = path.join(os.tmpdir(), `voice-${process.pid}.db`);
process.env.TWILIO_ACCOUNT_SID     = "ACvoice";
process.env.TWILIO_AUTH_TOKEN      = "voice";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+15550001001";
process.env.ANTHROPIC_API_KEY      = "sk-test";
process.env.BASE_URL               = "https://demo.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);
process.env.GUEST_BURST            = "5000";

const C = { dim: "\x1b[2m", b: "\x1b[1m", r: "\x1b[0m", gr: "\x1b[32m", re: "\x1b[31m", ye: "\x1b[33m", cy: "\x1b[36m" };
const VERBOSE = process.argv.includes("--verbose");

// ── לכידה ───────────────────────────────────────────────
const captured = [];   // { to, body, staff }
let staffNumbers = new Set();

mock.module("twilio", {
  exports: {
    default: () => ({
      messages: {
        create: async ({ to, body }) => {
          captured.push({ to, body, staff: staffNumbers.has(to) });
          return { sid: "SMvoice" };
        },
      },
    }),
  },
});

// ה-AI מוחלף בתשובה ניטרלית: אנחנו בודקים כאן את **הטקסט שלנו**.
mock.module("@anthropic-ai/sdk", {
  exports: {
    default: class Anthropic {
      messages = { create: async () => ({ content: [{ type: "text", text: "בשמחה." }] }) };
    },
  },
});

const { email } = await import("./email/index.js");
email.send = async () => ({ success: true });

const { idVerify } = await import("./idverify/index.js");
let idResult = null;
idVerify.verifyDocument = async () => idResult || {
  status: "verified", documentType: "id_card", storedPath: null, confidence: 0.95,
  fields: { full_name: "דנה כהן", document_type: "תעודת זהות", nationality: "ישראל" },
};

const bot     = await import("./bot.js");
const checkin = await import("./checkin.js");
const state   = await import("./state.js");
const config  = await import("./config.js");
const tenant  = await import("./tenant.js");
const { auditAll } = await import("./voice.js");
const { SAMPLE_HOTELS, seedSampleHotels } = await import("./sample-hotels.mjs");

seedSampleHotels({
  updateConfigFor: config.updateConfigFor,
  registerHotelNumber: tenant.registerHotelNumber,
  DEFAULT_HOTEL_ID: tenant.DEFAULT_HOTEL_ID,
});

for (const hid of ["lala", "kempinski"]) {
  for (const d of config.DEPARTMENTS) {
    const n = config.configFor(hid)[`${d}_number`];
    if (n) staffNumbers.add(n);
  }
}

const numberOf = (id) => SAMPLE_HOTELS.find(h => h.hotelId === id).number;
const LALA = { id: "lala", to: numberOf("lala") };
const KEMP = { id: "kempinski", to: numberOf("kempinski") };
const say = (hotel, phone, text, media = null) => bot.handleIncoming(phone, text, media, { to: hotel.to });
const FAKE_ID = { url: "https://x/id.jpg", contentType: "image/jpeg" };

function futureStay(nights = 3) {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
  return `${nights} לילות ${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
}

// ── כל הזרימות, שתי השפות, שני המלונות ─────────────────
async function collect() {
  let n = 0;
  const phone = () => `whatsapp:+9725558${String(++n).padStart(5, "0")}`;

  // 1. צ'ק אין מלא — עברית ואנגלית, שני המלונות
  for (const [hotel, lang] of [[LALA, "he"], [KEMP, "he"], [KEMP, "en"]]) {
    const p = phone();
    const he = lang === "he";
    await say(hotel, p, he ? "שלום" : "Hello");
    await say(hotel, p, he ? "אני רוצה לעשות צ'ק אין" : "I'd like to check in");
    await say(hotel, p, he ? "דנה כהן" : "John Miller");
    await say(hotel, p, "RES-VOICE-1");
    await say(hotel, p, he ? futureStay(3) : "3 nights from tomorrow");
    await say(hotel, p, he ? "כן" : "yes");
    await say(hotel, p, he ? "2 אורחים, מגיעים ב-16:00" : "2 guests, arriving 16:00");
    await say(hotel, p, he ? "התעודה" : "my ID", FAKE_ID);
    await say(hotel, p, he ? "אני מאשר את התנאים" : "I confirm the terms");

    const pend = tenant.runInTenant(hotel.id, () => checkin.getPendingReservation(p, hotel.id));
    if (pend) {
      await tenant.runInTenant(hotel.id, () => checkin.completeCheckin(pend.id, hotel.id === "lala" ? "7" : "304"));
      tenant.runInTenant(hotel.id, () => checkin.addDemoCharges(pend.id, lang));
      await say(hotel, p, he ? "אני רוצה לעשות צ'ק אאוט" : "I'd like to check out");
      await say(hotel, p, he ? "כן" : "yes");
      await say(hotel, p, he ? "5, היה מצוין" : "5, excellent");
    }
  }

  // 2. מסלולי דחייה ותיקון — כאן הניסוח הכי חשוף
  const p2 = phone();
  await say(KEMP, p2, "צ'ק אין");
  await say(KEMP, p2, "I want to check in");        // שם לא תקין
  await say(KEMP, p2, "ישראל ישראלי");
  await say(KEMP, p2, "RES-VOICE-2");
  await say(KEMP, p2, "10.7");                       // תאריך שעבר
  await say(KEMP, p2, "25.7 - 23.7");                // טווח הפוך
  await say(KEMP, p2, "32.13");                      // תאריך לא חוקי
  await say(KEMP, p2, futureStay(2));
  await say(KEMP, p2, "לא");                         // תיקון תאריכים
  await say(KEMP, p2, futureStay(2));
  await say(KEMP, p2, "כן");
  await say(KEMP, p2, "דלג");
  idResult = { status: "rejected", documentType: "drivers_license", reasonHe: "המסמך אינו תעודת זהות או דרכון.", reasonEn: "Not an ID or passport." };
  await say(KEMP, p2, "רישיון נהיגה", FAKE_ID);
  idResult = null;
  await say(KEMP, p2, "התעודה", FAKE_ID);
  await say(KEMP, p2, "כן");                         // "כן" אינו אישור תנאים
  await say(KEMP, p2, "אני לא מאשר");                // סירוב

  // 3. חירום — שני סוגי המלונות
  for (const hotel of [LALA, KEMP]) {
    const p = phone();
    state.patchSession(p, { lang: "he", roomNumber: "7", guestName: "דנה כהן" }, hotel.id);
    await say(hotel, p, "יש כאן מישהו פצוע, דחוף!");
  }

  // 4. מסלול מזומן + no-show
  const p4 = phone();
  const { reservationId } = await tenant.runInTenant(KEMP.id, () => checkin.startCheckin(
    p4, { guestName: "ישראל ישראלי", guestNameHe: "ישראל ישראלי", guestNameEn: "Israel Israeli" },
    "RES-VOICE-CASH", { stay: { checkIn: "2099-05-01", checkOut: "2099-05-03", nights: 2 }, depositMethod: "cash" },
  ));
  await tenant.runInTenant(KEMP.id, () => checkin.completeCheckin(reservationId, "208"));

  // 5. הודעת פתיחה בשתי השפות ובשני המלונות (נבדקת ישירות)
  for (const hid of ["lala", "kempinski"]) {
    for (const lang of ["he", "en"]) {
      captured.push({ to: "welcome", body: config.welcomeFor(hid, lang), staff: false });
    }
  }

  // ⚠️ תנאי השהייה **אינם** נבדקים מהקונפיג הגולמי. הנוסח שם מכיל
  //    placeholders ({hotel}, {deposit}) שמוחלפים בזמן השליחה, ולכן
  //    בדיקה של התבנית הייתה מדווחת 16 "הפרות" שאינן קיימות באמת.
  //    הנוסח *המלא והמוחלף* כבר נאסף בזרימת הצ'ק אין למעלה — וזה מה
  //    שהאורח באמת קורא.
}

// ── הרצה ────────────────────────────────────────────────
console.log(`\n${C.ye}${C.b}${"═".repeat(70)}\n  🎩 ביקורת ניסוח — רמת קמפינסקי\n${"═".repeat(70)}${C.r}`);
try { await collect(); }
catch (e) { console.error(`${C.re}💥 איסוף נכשל: ${e.stack}${C.r}`); }

const guest = captured.filter(m => !m.staff);
const staff = captured.filter(m => m.staff);
console.log(`${C.dim}   נאספו ${guest.length} הודעות לאורח ו-${staff.length} התראות צוות${C.r}\n`);

const g = auditAll(guest);
const s = auditAll(staff.map(m => ({ ...m, staff: true })));

function report(title, res, total) {
  console.log(`${C.b}── ${title} (${total} הודעות) ──${C.r}`);
  const { bySeverity, byRule, violations } = res;
  if (!violations.length) { console.log(`${C.gr}   ✅ אין הפרות${C.r}\n`); return; }
  console.log(`   ${bySeverity.error ? C.re : C.dim}שגיאות: ${bySeverity.error}${C.r} · ` +
              `${bySeverity.warn ? C.ye : C.dim}אזהרות: ${bySeverity.warn}${C.r} · ` +
              `${C.dim}מידע: ${bySeverity.info}${C.r}`);
  const order = { error: 0, warn: 1, info: 2 };
  for (const [rule, count] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
    const first = violations.find(v => v.rule === rule);
    const colour = first.severity === "error" ? C.re : first.severity === "warn" ? C.ye : C.dim;
    console.log(`   ${colour}${first.severity === "error" ? "❌" : first.severity === "warn" ? "⚠️ " : "ℹ️ "} ${rule} ×${count}${C.r} — ${first.why}`);
    const show = VERBOSE ? violations.filter(v => v.rule === rule) : [first];
    for (const v of show.slice(0, VERBOSE ? 20 : 2)) console.log(`${C.dim}        ${v.sample}${C.r}`);
  }
  void order;
  console.log("");
}

report("הודעות לאורח", g, guest.length);
report("התראות צוות", s, staff.length);

const totalErrors = g.bySeverity.error + s.bySeverity.error;
console.log(
  totalErrors === 0
    ? `${C.gr}${C.b}   ✅ אין הפרות ברמת שגיאה — הפלט עומד בתקן.${C.r}\n`
    : `${C.re}${C.b}   ❌ ${totalErrors} הפרות ברמת שגיאה.${C.r}\n`
);

try { fs.unlinkSync(process.env.DB_PATH); } catch {}
process.exit(totalErrors === 0 ? 0 : 1);
