// ════════════════════════════════════════════════════════
//  SIMULATE-NEW — הדגמה חיה של היכולות החדשות (חלקים א'–י')
//  ----------------------------------------------------------
//  מריץ את הקוד האמיתי ומדפיס בדיוק מה שהאורח/הצוות רואים. הזרימות
//  הדטרמיניסטיות (קוד דלת, מזומן, חשבונית, תנאים) רצות בלי AI; החירום
//  רץ דטרמיניסטית (detectEmergency לפני ה-AI); הקונסיירז' לבריאות רץ
//  מול Claude אמיתי אם יש מפתח.
//
//  הרצה: node --experimental-test-module-mocks simulate-new.mjs
// ════════════════════════════════════════════════════════
import { mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
dotenv.config();

process.env.DB_PATH = path.join(os.tmpdir(), `hotel-simnew-${process.pid}.db`);
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACsim";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "sim";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.BASE_URL = "https://demo.local";
process.env.ID_ENCRYPTION_KEY = "0".repeat(64);

const C = { dim: "\x1b[2m", b: "\x1b[1m", r: "\x1b[0m", cy: "\x1b[36m", ye: "\x1b[33m", gr: "\x1b[32m", ma: "\x1b[35m", re: "\x1b[31m" };
const GUEST = "whatsapp:+972500009999";
const log = [];

const { hotelConfig } = await import("./config.js");
const STAFF = new Map([
  [hotelConfig.housekeeping_number, "משק בית"],
  [hotelConfig.reception_number,    "קבלה"],
  [hotelConfig.maintenance_number,  "אחזקה"],
  [hotelConfig.concierge_number,    "קונסיירז'"],
  [hotelConfig.security_number,     "ביטחון"],
  [hotelConfig.room_service_number, "שירות חדרים"],
]);
const deptOf = (to) => STAFF.get(to) || STAFF.get(to.replace(/^whatsapp:/, "whatsapp:")) || "צוות";

function indent(s) { return String(s).split("\n").map(l => "   │ " + l).join("\n"); }

mock.module("twilio", {
  exports: {
    default: () => ({
      messages: { create: async ({ to, body }) => {
        if (!body) throw new Error("empty body");
        log.push({ to, body });
        if (to === GUEST) { console.log(`\n${C.gr}${C.b}🤖 הבוט → האורח${C.r}`); console.log(indent(body)); }
        else { console.log(`\n${C.ma}${C.b}📟 התראת צוות → ${deptOf(to)}${C.r} ${C.dim}(${to.replace(/^whatsapp:/,"")})${C.r}`); console.log(indent(body)); }
        return { sid: "SMsim" };
      } },
    }),
  },
});

const { email } = await import("./email/index.js");
email.send = async (m) => { console.log(`${C.cy}   ✉️  מייל → ${m.to} ${C.dim}(${m.subject})${C.r}`); log.push({ email: m.to }); return { success: true }; };

// אימות זהות — מוחלף בסימולציה (אין URL מדיה אמיתי). כל שאר הזרימה אמיתית.
const { idVerify } = await import("./idverify/index.js");
idVerify.verifyDocument = async () => ({ status: "verified", documentType: "id_card", storedPath: null, confidence: 0.95 });

const bot     = await import("./bot.js");
const checkin = await import("./checkin.js");
const config  = await import("./config.js");
const state   = await import("./state.js");
const { placesLive } = await import("./places/index.js");

function header(t) { console.log(`\n\n${C.ye}${C.b}${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}${C.r}`); }
function note(t)   { console.log(`${C.dim}   » ${t}${C.r}`); }
function reset()   { state.deleteSession(GUEST); log.length = 0; }

const STAY = { checkIn: "2099-03-10", checkOut: "2099-03-12", nights: 2 };
const NAME = { guestName: "דנה כהן", guestNameHe: "דנה כהן", guestNameEn: "Dana Cohen" };

// ── חלק א' — מלון בוטיק: קוד לדלת ──────────────────────
async function boutiqueCheckin() {
  header("חלק א' — צ׳ק-אין במלון בוטיק (קוד לדלת, בלי כרטיס)");
  config.updateConfig({ hotel_type: "boutique", duty_manager_number: "whatsapp:+9725559990000" });
  reset();
  note("מגדירים את המלון כבוטיק. הבוט אמור לתת קוד לדלת ולומר לקבלה שאין צורך בכרטיס.");
  const { reservationId } = await checkin.startCheckin(GUEST, NAME, "RES-BTQ-1122", { stay: STAY });
  log.length = 0;
  await checkin.completeCheckin(reservationId, "12");
  const res = checkin.reservations[reservationId];
  console.log(`\n${C.dim}   ✓ קוד הדלת שנוצר: ${res.doorCode} (בן 4 ספרות, יציב)${C.r}`);
  config.resetConfig();
}

// ── חלק א'/יא' — מלון רגיל: כרטיס בקבלה ─────────────────
async function fullCheckin() {
  header("חלק יא' — צ׳ק-אין במלון רגיל (כרטיס מוכן בקבלה)");
  reset();
  note("מלון מלא (ברירת מחדל). הבוט אמור לומר 'כרטיס מחכה בקבלה' ולבקש מהקבלה להכין כרטיס.");
  const { reservationId } = await checkin.startCheckin(GUEST, NAME, "RES-FULL-3344", { stay: STAY });
  log.length = 0;
  await checkin.completeCheckin(reservationId, "304");
}

// ── חלק ד' — מזומן ─────────────────────────────────────
async function cash() {
  header("חלק ד' — פיקדון במזומן (אורח משלם בקבלה)");
  reset();
  note("אורח שבוחר 'מזומן'. אין הרשאת כרטיס; הקבלה מקבלת הוראה לגבות במזומן.");
  const { reservationId } = await checkin.startCheckin(GUEST, NAME, "RES-CASH-5566", { stay: STAY, depositMethod: "cash" });
  log.length = 0;
  await checkin.completeCheckin(reservationId, "208");
}

// ── חלק ה' — קבלה/חשבונית בצ׳ק-אאוט ────────────────────
async function invoice() {
  header("חלק ה' — קבלה/חשבונית מס-קבלה בצ׳ק-אאוט");
  reset();
  note("צ'ק-אין → הוספת חיובים (מיני בר, מסעדה, ספא) → צ'ק-אאוט. האורח מקבל חשבונית מס.");
  const { reservationId } = await checkin.startCheckin(GUEST, NAME, "RES-INV-9900", { stay: STAY });
  await checkin.completeCheckin(reservationId, "410");
  checkin.addDemoCharges(reservationId, "he");
  log.length = 0;
  await bot.handleIncoming(GUEST, "אני רוצה לעשות צ'ק אאוט");
  await bot.handleIncoming(GUEST, "כן");
  // מדפיסים את שדות החובה של החשבונית שנשמרה
  const res = checkin.reservations[reservationId];
  if (res.invoice) {
    const i = res.invoice;
    console.log(`\n${C.dim}   ── שדות החובה של החשבונית שהופקה: ──`);
    console.log(`   סוג: ${i.type} | מס' סידורי: ${i.number}`);
    console.log(`   עוסק: ${i.seller.name} · ${i.seller.businessId}`);
    console.log(`   לפני מע"מ: ₪${(i.net/100).toFixed(2)} | מע"מ ${Math.round(i.vatRate*100)}%: ₪${(i.vat/100).toFixed(2)} | סה"כ: ₪${(i.totalInclVat/100).toFixed(2)}${C.r}`);
  }
}

// ── חלק ה' תייר — 0% מע"מ ──────────────────────────────
async function touristInvoice() {
  header("חלק ה' — חשבונית לתייר חוץ (מע\"מ 0%)");
  reset();
  const { reservationId } = await checkin.startCheckin(GUEST, { ...NAME, guestNameEn: "John Tourist" }, "RES-TUR-2233", { stay: STAY });
  const res = checkin.reservations[reservationId];
  res.isTourist = true; // תייר חוץ
  await checkin.completeCheckin(reservationId, "411");
  checkin.addFolioItem(reservationId, "RESTAURANT", "Dinner", 23600); // ₪236 כולל
  const inv = await checkin.issueFolioInvoice(res, "en");
  console.log(indent(checkin.formatInvoiceSummary(inv, "en")));
  console.log(`${C.dim}   ✓ תייר → מע"מ 0% (מלונאות לתייר), אין הפרדת מע"מ${C.r}`);
}

// ── חלק ח' — טופס תנאי אירוח ────────────────────────────
async function terms() {
  header("חלק ח' — טופס תנאי האירוח (מה שהאורח רואה ומאשר)");
  reset();
  // מריצים צ'ק-אין עד שלב התנאים כדי לראות את הטופס האמיתי שנשלח
  await bot.handleIncoming(GUEST, "צ'ק אין");
  await bot.handleIncoming(GUEST, "דנה כהן");
  await bot.handleIncoming(GUEST, "RES-TRM-7788");
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
  await bot.handleIncoming(GUEST, `4 לילות ${d.getUTCDate()}.${d.getUTCMonth() + 1}`);
  await bot.handleIncoming(GUEST, "כן");
  await bot.handleIncoming(GUEST, "דלג");
  log.length = 0;
  await bot.handleIncoming(GUEST, "ת\"ז", { url: "x", contentType: "image/jpeg" });
  // מדפיס את רשומת האישור אחרי "אני מאשר"
  log.length = 0;
  await bot.handleIncoming(GUEST, "אני מאשר את התנאים");
  const s = state.getSession(GUEST);
  console.log(`\n${C.dim}   ── רשומת האישור בת-האכיפה שנשמרה: ──`);
  console.log(`   נוסח שהאורח כתב: "${s.termsAcceptanceText}" | שפה: ${s.termsLang}`);
  console.log(`   טביעת אצבע (hash) של הנוסח: ${String(s.termsHash).slice(0, 24)}…${C.r}`);
}

// ── חלק א' — חירום במלון בוטיק מול מלון מלא ─────────────
async function emergencyBoutique() {
  header("חלק א' — חירום רפואי במלון בוטיק (מד\"א 101, בלי 'צוות בדרך')");
  config.updateConfig({ hotel_type: "boutique" });
  reset();
  state.patchSession(GUEST, { lang: "he", roomNumber: "12", guestName: "דנה כהן" });
  log.length = 0;
  await bot.handleIncoming(GUEST, "יש כאן מישהו פצוע, דחוף!");
  config.resetConfig();
}
async function emergencyFull() {
  header("חלק יא' — חירום רפואי במלון מלא (הפניה לצוות המלון)");
  reset();
  state.patchSession(GUEST, { lang: "he", roomNumber: "304", guestName: "דנה כהן" });
  log.length = 0;
  await bot.handleIncoming(GUEST, "יש כאן מישהו פצוע, דחוף!");
}

// ── חלק ז' — קונסיירז' לבריאות (רופא/בית מרקחת) — Claude אמיתי ──
async function healthConcierge() {
  header("חלק ז' — קונסיירז' לבריאות: בית מרקחת (Claude אמיתי)");
  reset();
  state.patchSession(GUEST, { lang: "he", roomNumber: "304", guestName: "דנה כהן" });
  log.length = 0;
  await bot.handleIncoming(GUEST, "יש לי כאב ראש חזק, איפה בית מרקחת פתוח קרוב?");
  const staff = log.filter(l => l.to && l.to !== GUEST);
  for (const s of staff) note(`נותב גם ל: ${deptOf(s.to)}`);
}

// ── חלק י' — אורח חוזר (VIP) ────────────────────────────
async function returningGuest() {
  header("חלק י' — אורח חוזר: זיהוי VIP וקבלה חמה");
  const { recordStay } = await import("./profiles.js");
  reset();
  recordStay(GUEST, { name: "דנה כהן", preferences: "קומה גבוהה, נוף לים" }); // שהייה קודמת
  log.length = 0;
  await bot.handleIncoming(GUEST, "צ'ק אין");
  note("הפתיחה אמורה להיות 'שמחים לארח שוב', והפרופיל זמין ל-AI.");
}

// ══════════════ הרצה ══════════════
console.log(`${C.dim}Places: ${placesLive ? "GOOGLE (חי)" : "MOCK (נתוני דמו, אותו פורמט)"} | AI: ${process.env.ANTHROPIC_API_KEY?.startsWith("sk-ant") ? "Claude אמיתי" : "לא זמין"}${C.r}`);

const steps = [
  boutiqueCheckin, fullCheckin, cash, invoice, touristInvoice,
  terms, emergencyBoutique, emergencyFull, returningGuest, healthConcierge,
];
for (const step of steps) {
  try { await step(); }
  catch (e) { console.error(`\n${C.re}💥 ${step.name} נכשל: ${e.stack}${C.r}`); }
  finally { config.resetConfig(); }
}
console.log("\n");
try { fs.unlinkSync(process.env.DB_PATH); } catch {}
process.exit(0);
