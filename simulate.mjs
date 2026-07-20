// ════════════════════════════════════════════════════════
//  SIMULATE — הרצה חיה של כל הזרימות, כמו הדגמה אמיתית
//  ----------------------------------------------------------
//  מריץ את handleIncoming האמיתי עם Claude אמיתי, Places אמיתי
//  (אם יש מפתח) ו-DB זמני. רק טוויליו מוחלף ב-mock שמדפיס
//  בדיוק את מה שהאורח יראה ואת מה שהצוות יקבל.
//
//  הרצה:  node --experimental-test-module-mocks simulate.mjs [scenario]
// ════════════════════════════════════════════════════════
import { mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

process.env.DB_PATH = path.join(os.tmpdir(), `hotel-sim-${process.pid}.db`);
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACsim";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "sim";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.BASE_URL = process.env.BASE_URL || "https://demo.local";
process.env.ID_ENCRYPTION_KEY = "0".repeat(64);

// ── מפת מספרי הצוות → שם מחלקה, לתצוגה ─────────────────
const { hotelConfig } = await import("./config.js");
const STAFF = new Map([
  [hotelConfig.housekeeping_number, ["משק בית / HOUSEKEEPING", hotelConfig.housekeeping_email]],
  [hotelConfig.reception_number,    ["קבלה / RECEPTION",       hotelConfig.reception_email]],
  [hotelConfig.maintenance_number,  ["אחזקה / MAINTENANCE",    hotelConfig.maintenance_email]],
  [hotelConfig.concierge_number,    ["קונסיירז' / CONCIERGE",  hotelConfig.concierge_email]],
  [hotelConfig.security_number,     ["ביטחון / SECURITY",      hotelConfig.security_email]],
  [hotelConfig.room_service_number, ["שירות חדרים / ROOM SERVICE", hotelConfig.room_service_email]],
]);

const GUEST = "whatsapp:+972500000001";
const log = [];

const C = { dim: "\x1b[2m", b: "\x1b[1m", r: "\x1b[0m", cy: "\x1b[36m", ye: "\x1b[33m", gr: "\x1b[32m", ma: "\x1b[35m", re: "\x1b[31m" };

mock.module("twilio", {
  exports: {
    default: () => ({
      messages: {
        create: async ({ to, body }) => {
          if (!body) throw new Error("Twilio: body is required");
          log.push({ to, body });
          if (to === GUEST) {
            console.log(`\n${C.gr}${C.b}🤖 הבוט → האורח${C.r}`);
            console.log(indent(body));
          } else {
            const [name, mail] = STAFF.get(to) || [`?? ${to}`, "??"];
            console.log(`\n${C.ma}${C.b}📟 התראת צוות → ${name}${C.r}`);
            console.log(`${C.dim}   WhatsApp: ${to.replace(/^whatsapp:/, "")}${C.r}`);
            console.log(indent(body));
          }
          return { sid: "SMsim" };
        },
      },
    }),
  },
});

// ── מייל: מדפיסים כל מייל יוצא ───────────────────────────
const { email } = await import("./email/index.js");
const origSend = email.send.bind(email);
email.send = async (msg) => {
  console.log(`${C.cy}   ✉️  Email → ${msg.to}${C.r}  ${C.dim}נושא: ${msg.subject}${C.r}`);
  log.push({ email: msg.to, subject: msg.subject, dept: msg.dept });
  return origSend(msg);
};

// ── אימות זהות: מוחלף בסימולציה ─────────────────────────
// השלב הזה מוריד תמונה אמיתית מ-URL של טוויליו ושולח אותה ל-Claude
// vision. אין URL כזה בסימולציה, ולכן רק *הוא* מוחלף — כל שאר הזרימה
// (הניסוחים, המעבר לשלב הבא, ההתראות) רצה אמיתי.
const { idVerify } = await import("./idverify/index.js");
idVerify.verifyDocument = async () => {
  console.log(`${C.dim}   ⚙️  [סימולציה] אימות הזהות מוחלף — מוחזר "מסמך תקין"${C.r}`);
  return { status: "verified", documentType: "id_card", storedPath: "sim-doc.enc", confidence: 0.95 };
};

function indent(s) {
  return String(s).split("\n").map(l => "   │ " + l).join("\n");
}

const bot = await import("./bot.js");
const { getSession, patchSession, deleteSession } = await import("./state.js");
const { placesLive } = await import("./places/index.js");

async function guest(text, media = null) {
  console.log(`\n${C.cy}${C.b}👤 האורח${C.r}${media ? `${C.dim} [+תמונה]${C.r}` : ""}`);
  console.log(indent(text));
  await bot.handleIncoming(GUEST, text, media);
}

function header(title) {
  console.log(`\n\n${C.ye}${C.b}${"═".repeat(64)}\n  ${title}\n${"═".repeat(64)}${C.r}`);
}

function reset() {
  deleteSession(GUEST);
  log.length = 0;
}

// ══════════════ תרחישים ══════════════

const FAKE_ID = { url: "https://example.com/id.jpg", contentType: "image/jpeg" };

// תאריך הגעה עתידי, מחושב מהיום — תאריך קבוע בקוד הופך לתאריך שעבר
// והבוט דוחה אותו בצדק, מה שנראה כמו תקלה בסימולציה.
const STAY_TEXT = (() => {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `4 לילות ${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
})();

const scenarios = {
  async checkin() {
    header("תרחיש 1 — צ׳ק-אין מלא בעברית");
    reset();
    await guest("שלום");
    await guest("אני רוצה לעשות צ'ק אין");
    await guest("ישראל ישראלי");
    await guest("RES12345");
    await guest(STAY_TEXT);
    await guest("כן");
    await guest("2 אורחים, מגיעים ב-16:00");
    await guest("הנה תעודת הזהות שלי", FAKE_ID);
    await guest("אני מאשר את התנאים");
  },

  async concierge() {
    header("תרחיש 2 — קונסיירז' בעברית (מסעדת בשר)");
    reset();
    patchSession(GUEST, { lang: "he", roomNumber: "304", guestName: "ישראל ישראלי" });
    await guest("אני מחפש מסעדת בשר טובה באזור");
    await guest("ואם בא לי סושי?");
  },

  async emergency() {
    header("תרחיש 3 — חירום בעברית");
    reset();
    patchSession(GUEST, { lang: "he", roomNumber: "304", guestName: "ישראל ישראלי" });
    await guest("יש כאן מישהו פצוע");
  },

  async checkout() {
    header("תרחיש 4 — צ׳ק-אאוט בעברית (חשבון)");
    reset();
    // צ'ק-אין מלא (שקט) כדי שיהיה על מה לעשות צ'ק-אאוט
    const q = [];
    const realLog = console.log; console.log = (...a) => q.push(a);
    await bot.handleIncoming(GUEST, "צ'ק אין");
    await bot.handleIncoming(GUEST, "ישראל ישראלי");
    await bot.handleIncoming(GUEST, "RES99999");
    await bot.handleIncoming(GUEST, STAY_TEXT);
    await bot.handleIncoming(GUEST, "כן");
    await bot.handleIncoming(GUEST, "דלג");
    await bot.handleIncoming(GUEST, "ת\"ז", FAKE_ID);
    await bot.handleIncoming(GUEST, "אני מאשר את התנאים");
    console.log = realLog;
    const { getPendingReservation, completeCheckin, addDemoCharges } = await import("./checkin.js");
    const pend = getPendingReservation(GUEST);
    if (!pend) { console.log(`${C.re}❌ אין הזמנה ממתינה — הצ'ק-אין נכשל${C.r}`); return; }
    log.length = 0;
    await completeCheckin(pend.id, "304");
    addDemoCharges(pend.id);
    await guest("אני רוצה לעשות צ'ק אאוט");
    await guest("כן");
    await guest("5, היה מצוין");
  },

  async english() {
    header("תרחיש 5 — אנגלית: בקשת מגבות");
    reset();
    await guest("Hi, I need towels");
    await guest("Room 512");
  },

  // המשך-תור: בקשה עמומה שנפתרת בתור השני
  async followups() {
    header("תרחיש 7 — בקשות עמומות: האם הן נסגרות בתור השני?");
    reset();
    patchSession(GUEST, { lang: "he", roomNumber: "304", guestName: "ישראל ישראלי" });
    await guest("אני רוצה לאכול משהו");
    await guest("בחדר בבקשה");
    const staff = log.filter(l => l.to && l.to !== GUEST);
    for (const s of staff) console.log(`   ➜ נותב ל: ${(STAFF.get(s.to) || ["?"])[0]}`);
    if (!staff.length) console.log(`${C.re}   ❌ עדיין לא נותב לשום מחלקה${C.r}`);
  },

  // ── ניתוב מחלקות — ארבע הפניות מהבקשה ──
  async routing() {
    header("תרחיש 6 — ניתוב מחלקות (4 פניות)");
    const cases = [
      ["נשברה נורה בחדר",        "אחזקה / MAINTENANCE"],
      ["צריך מגבות בבקשה",       "משק בית / HOUSEKEEPING"],
      ["אני רוצה לאכול משהו",     "שירות חדרים / ROOM SERVICE"],
      ["יש מישהו חשוד במסדרון",   "ביטחון / SECURITY"],
    ];
    for (const [text, expect] of cases) {
      reset();
      patchSession(GUEST, { lang: "he", roomNumber: "304", guestName: "ישראל ישראלי" });
      console.log(`\n${C.ye}── מצופה: ${expect} ──${C.r}`);
      await guest(text);
      const staff = log.filter(l => l.to && l.to !== GUEST);
      const mails = log.filter(l => l.email);
      if (!staff.length) console.log(`${C.re}   ❌ לא נשלחה שום התראת צוות!${C.r}`);
      if (!mails.length) console.log(`${C.re}   ❌ לא נשלח שום מייל!${C.r}`);
      for (const s of staff) {
        const [name] = STAFF.get(s.to) || ["?"];
        const ok = name === expect;
        console.log(`   ${ok ? "✅" : "❌"} נותב ל: ${name} ${ok ? "" : `(מצופה ${expect})`}`);
        console.log(`      חדר בהתראה: ${/חדר: 304/.test(s.body) ? "✅ 304" : `${C.re}❌ חסר${C.r}`}`);
      }
      for (const m of mails) console.log(`   ✉️  מייל: ${m.email}`);
    }
  },
};

// ══════════════ הרצה ══════════════
const want = process.argv[2];
console.log(`${C.dim}Places live: ${placesLive ? "GOOGLE (חי)" : "MOCK"}${C.r}`);
const list = want ? [want] : Object.keys(scenarios);
for (const k of list) {
  try { await scenarios[k](); }
  catch (e) { console.error(`\n${C.re}💥 ${k} נכשל: ${e.stack}${C.r}`); }
}
console.log("\n");
try { fs.unlinkSync(process.env.DB_PATH); } catch {}
process.exit(0);
