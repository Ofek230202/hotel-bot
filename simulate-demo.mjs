// ════════════════════════════════════════════════════════
//  SIMULATE-DEMO — שני מלונות במקביל, מקצה לקצה, לפני הדגמה
//  ----------------------------------------------------------
//  למה הקובץ הזה קיים ולא הסתפקנו ב-simulate.mjs:
//  simulate.mjs ו-simulate-new.mjs מריצים **מלון אחד** (ואף משנים את
//  הקונפיג הגלובלי כדי לדמות בוטיק). ההדגמה מול לקוח היא בדיוק המצב
//  ההפוך — שני מלונות *שונים* חיים באותו תהליך, וכל השאלה היא אם יש
//  ביניהם דליפה. לכן כאן כל הודעה נכנסת דרך גבול הטננט האמיתי
//  (`meta.to` → resolveHotelId), בדיוק כמו webhook אמיתי של Twilio.
//
//  שני המלונות:
//    • LALA        — בוטיק, דרך בן צבי 78, קוד לדלת, בלי צוות במקום
//    • KEMPINSKI   — מלון מלא, הירקון 51, כרטיס בקבלה, צוות 24/7
//
//  מה אמיתי כאן: Claude, Google Places, כל לוגיקת הבוט, ה-DB, החשבוניות.
//  מה מוחלף: שליחת Twilio (מודפסת במקום להישלח), שליחת מייל (מודפסת),
//  ואימות הזהות — שדורש URL מדיה אמיתי של Twilio. סוג המסמך והאזרחות
//  שהאימות מחזיר נקבעים פר-תרחיש, כדי להריץ את מסלול התייר ואת מסלול
//  התושב באמת (assessTourist רץ על התוצאה, בלי קיצור דרך).
//
//  הרצה:  node --experimental-test-module-mocks simulate-demo.mjs [lala|kempinski|isolation]
// ════════════════════════════════════════════════════════
import { mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

process.env.DB_PATH                = path.join(os.tmpdir(), `hotel-demo-${process.pid}.db`);
process.env.TWILIO_ACCOUNT_SID     = process.env.TWILIO_ACCOUNT_SID || "ACsim";
process.env.TWILIO_AUTH_TOKEN      = process.env.TWILIO_AUTH_TOKEN  || "sim";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+15550001001";  // = המספר של קמפינסקי
process.env.BASE_URL               = process.env.BASE_URL || "https://demo.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);

const C = {
  dim: "\x1b[2m", b: "\x1b[1m", r: "\x1b[0m", cy: "\x1b[36m", ye: "\x1b[33m",
  gr: "\x1b[32m", ma: "\x1b[35m", re: "\x1b[31m", bl: "\x1b[34m",
};

// ── לכידת כל מה שיוצא ───────────────────────────────────
// כל הודעת וואטסאפ (לאורח ולצוות) וכל מייל נרשמים עם המלון שבהקשרו
// נשלחו — זה מה שמאפשר לבדוק דליפה בין מלונות אחרי כל תרחיש.
const outbox = [];   // { kind:"wa"|"email", from, to, body, subject, hotelId }
let currentScenarioHotel = null;

mock.module("twilio", {
  exports: {
    default: () => ({
      messages: {
        create: async ({ from, to, body }) => {
          if (!body) throw new Error("Twilio: body is required");
          outbox.push({ kind: "wa", from, to, body, hotelId: currentScenarioHotel });
          return { sid: "SMdemo" };
        },
      },
    }),
  },
});

const { email } = await import("./email/index.js");
email.send = async (m) => {
  outbox.push({ kind: "email", to: m.to, subject: m.subject, body: m.body, dept: m.dept, hotelId: currentScenarioHotel });
  return { success: true, id: "EMdemo" };
};

// ── אימות זהות — התוצאה נקבעת פר-תרחיש ──────────────────
// זה השלב היחיד שאי אפשר להריץ אמיתי בסימולציה (צריך URL מדיה של
// Twilio). כל השאר — assessTourist, ההתראה לקבלה, מסלול המע"מ — אמיתי.
let nextIdResult = null;
// המסמך נושא את שמו של האורח שבאמת בשיחה — אחרת ההתראה לקבלה מציגה שם
// אחר משם האורח, וזה נראה כמו תקלה אמיתית בהדגמה.
const ID_RESIDENT = (name) => ({
  status: "verified", documentType: "id_card", storedPath: null, confidence: 0.96,
  fields: { full_name: name, document_type: "תעודת זהות", document_number: "0•••••••9", nationality: "ישראל" },
});
const ID_TOURIST = (name) => ({
  status: "verified", documentType: "passport", storedPath: null, confidence: 0.94,
  fields: { full_name: name, document_type: "Passport", document_number: "5•••••••2", nationality: "USA" },
});
const { idVerify } = await import("./idverify/index.js");
idVerify.verifyDocument = async () => nextIdResult || ID_RESIDENT("אורח");

// ── טעינת המערכת ────────────────────────────────────────
const bot        = await import("./bot.js");
const checkinMod = await import("./checkin.js");
const state      = await import("./state.js");
const config     = await import("./config.js");
const tenant     = await import("./tenant.js");
const { placesLive, places } = await import("./places/index.js");
const { SAMPLE_HOTELS, seedSampleHotels } = await import("./sample-hotels.mjs");

// זריעת שני המלונות (מספר Twilio + קונפיג) — בדיוק כמו onboarding אמיתי.
seedSampleHotels({
  updateConfigFor: config.updateConfigFor,
  registerHotelNumber: tenant.registerHotelNumber,
  DEFAULT_HOTEL_ID: tenant.DEFAULT_HOTEL_ID,
});

const numberOf = (id) => SAMPLE_HOTELS.find(h => h.hotelId === id).number;

const HOTELS = {
  lala: {
    id: "lala", to: numberOf("lala"), label: "LALA · בוטיק · דרך בן צבי 78",
    emailDomain: "lala-demo.co.il",
  },
  kempinski: {
    id: "kempinski", to: numberOf("kempinski"), label: "KEMPINSKI · מלון מלא · הירקון 51",
    emailDomain: "kempinski-demo.co.il",
  },
};

// ── תצוגה ───────────────────────────────────────────────
function indent(s, pad = "   │ ") {
  return String(s).split("\n").map(l => pad + l).join("\n");
}
function banner(title, colour = C.ye) {
  console.log(`\n\n${colour}${C.b}${"═".repeat(70)}\n  ${title}\n${"═".repeat(70)}${C.r}`);
}
function section(title) {
  console.log(`\n${C.bl}${C.b}──── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}${C.r}`);
}
function note(t) { console.log(`${C.dim}   » ${t}${C.r}`); }

// שם המחלקה של יעד וואטסאפ, *לפי המלון שבו אנחנו* — כך רואים מיד אם
// התראה נחתה במחלקה של המלון השני.
function deptOfNumber(hotelId, to) {
  const cfg = config.configFor(hotelId);
  for (const d of config.DEPARTMENTS) {
    if (cfg[`${d}_number`] === to) return config.DEPARTMENT_LABELS_HE[d] || d;
  }
  return null;
}

// מדפיס את מה שהצטבר ב-outbox מאז הסמן, ומחזיר את הפריטים.
function flush(from = 0, { guest }) {
  const items = outbox.slice(from);
  for (const it of items) {
    if (it.kind === "email") {
      console.log(`${C.cy}   ✉️  מייל → ${it.to}${C.r}  ${C.dim}(${it.subject})${C.r}`);
      continue;
    }
    if (it.to === guest) {
      console.log(`\n${C.gr}${C.b}🤖 הבוט → האורח${C.r} ${C.dim}[מהמספר ${String(it.from).replace(/^whatsapp:/, "")}]${C.r}`);
      console.log(indent(it.body));
    } else {
      const dept = deptOfNumber(currentScenarioHotel, it.to);
      console.log(`\n${C.ma}${C.b}📟 התראת צוות → ${dept || "❓ יעד לא מזוהה"}${C.r} ${C.dim}(${String(it.to).replace(/^whatsapp:/, "")})${C.r}`);
      console.log(indent(it.body));
    }
  }
  return items;
}

// ── בדיקת דליפה בין מלונות ──────────────────────────────
// אחרי כל תרחיש: כל יעד צוות חייב להיות של *המלון הזה*, כל מייל בדומיין
// של המלון הזה, וכל תשובה לאורח חייבת לצאת מהמספר של המלון הזה.
const findings = [];
function auditTenant(hotel, items, guest, scenario) {
  const cfg   = config.configFor(hotel.id);
  const mine  = new Set(config.DEPARTMENTS.map(d => cfg[`${d}_number`]).filter(Boolean));
  const other = Object.values(HOTELS).find(h => h.id !== hotel.id);
  const otherCfg  = config.configFor(other.id);
  const otherNums = new Set(config.DEPARTMENTS.map(d => otherCfg[`${d}_number`]).filter(Boolean));
  const problems = [];

  for (const it of items) {
    if (it.kind === "email") {
      if (!String(it.to).endsWith(hotel.emailDomain)) {
        problems.push(`מייל יצא לדומיין זר: ${it.to} (מצופה @${hotel.emailDomain})`);
      }
      continue;
    }
    if (it.to === guest) {
      const from = String(it.from).replace(/^whatsapp:/, "");
      if (tenant.normalizeNumber(from) !== tenant.normalizeNumber(hotel.to)) {
        problems.push(`תשובה לאורח יצאה מהמספר ${from} במקום ${hotel.to}`);
      }
    } else if (!mine.has(it.to)) {
      problems.push(
        otherNums.has(it.to)
          ? `🔴 התראה נשלחה למחלקה של המלון השני (${other.id}): ${it.to}`
          : `התראה נשלחה ליעד שאינו של המלון: ${it.to}`
      );
    }
  }

  const ok = problems.length === 0;
  findings.push({ hotel: hotel.id, scenario, ok, problems });
  if (ok) {
    console.log(`\n${C.gr}   ✅ בידוד תקין — כל היעדים שייכים ל-"${hotel.id}"${C.r}`);
  } else {
    console.log(`\n${C.re}   ❌ דליפה בין מלונות:${C.r}`);
    for (const p of problems) console.log(`${C.re}      • ${p}${C.r}`);
  }
  return ok;
}

// ── שליחת הודעה כאורח ───────────────────────────────────
// דרך handleIncoming עם meta.to של המלון — בדיוק כמו webhook אמיתי.
async function say(hotel, guest, text, media = null) {
  console.log(`\n${C.cy}${C.b}👤 האורח${C.r}${media ? `${C.dim} [+תמונה]${C.r}` : ""}`);
  console.log(indent(text));
  await bot.handleIncoming(guest, text, media, { to: hotel.to });
}

// תרחיש שלם: מריץ, מדפיס, ומבקר בידוד.
// ⚠️ הסשן *לא* נמחק בין תרחישים (אלא ב-fresh) — אורח אמיתי שומר את
//    ההקשר שלו, וכולל את מספר החדר. מחיקה בין תרחישים גרמה לבוט לשאול
//    "מה מספר החדר?" באמצע שהייה, וזה נראה כמו באג שאינו קיים.
async function scenario(hotel, name, guest, fn, { fresh = false } = {}) {
  section(`${hotel.id.toUpperCase()} · ${name}`);
  currentScenarioHotel = hotel.id;
  if (fresh) state.deleteSession(guest, hotel.id);
  const mark = outbox.length;
  await fn();
  const items = flush(mark, { guest });
  auditTenant(hotel, items, guest, name);
  return items;
}

const FAKE_ID = { url: "https://example.com/id.jpg", contentType: "image/jpeg" };

// תאריך הגעה עתידי (תאריך קבוע בקוד היה נדחה בצדק כתאריך שעבר).
function stayText(nights = 3) {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${nights} לילות ${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
}

// צ'ק-אין מלא בצ'אט. מחזיר את ההזמנה הממתינה.
async function fullCheckin(hotel, guest, { name, reservation, lang = "he", idResult = ID_RESIDENT, details = "דלג" }) {
  nextIdResult = idResult(name);
  const he = lang === "he";
  await say(hotel, guest, he ? "שלום" : "Hello");
  await say(hotel, guest, he ? "אני רוצה לעשות צ'ק אין" : "I'd like to check in");
  await say(hotel, guest, name);
  await say(hotel, guest, reservation);
  await say(hotel, guest, he ? stayText(3) : "3 nights from tomorrow");
  await say(hotel, guest, he ? "כן" : "yes");
  await say(hotel, guest, details);
  await say(hotel, guest, he ? "הנה תעודת הזהות שלי" : "Here is my passport", FAKE_ID);
  await say(hotel, guest, he ? "אני מאשר את התנאים" : "I confirm the terms");
  return tenant.runInTenant(hotel.id, () => checkinMod.getPendingReservation(guest, hotel.id));
}

// ══════════════════════════════════════════════════════════
//  מלון LALA — בוטיק
// ══════════════════════════════════════════════════════════
async function runLala() {
  const H = HOTELS.lala;
  banner(`🏨  ${H.label}   ${C.dim}[מספר נכנס ${H.to}]${C.r}${C.ye}${C.b}`, C.ye);

  const cfg = config.configFor(H.id);
  note(`סוג: ${config.hotelModel(H.id).type} · כניסה: ${config.hotelModel(H.id).keyDelivery} · קבלה 24/7: ${config.hotelModel(H.id).staffed24_7 ? "כן" : "לא"}`);
  note(`מיקום: ${cfg.location.address_he} (${cfg.location.lat}, ${cfg.location.lng})`);
  note(`עוסק לחשבונית: ${cfg.business.legal_name} · ${cfg.business.business_id}`);

  const guest = "whatsapp:+972500000101";

  // 1 — צ'ק-אין מלא: קוד לדלת, לא כרטיס
  let pend;
  await scenario(H, "צ׳ק-אין מלא + אימות ת\"ז → קוד לדלת", guest, async () => {
    pend = await fullCheckin(H, guest, {
      name: "דנה כהן", reservation: "LALA-2201", idResult: ID_RESIDENT,
      details: "2 אורחים, מגיעים ב-16:00",
    });
  }, { fresh: true });
  if (pend) {
    currentScenarioHotel = H.id;
    const mark = outbox.length;
    await tenant.runInTenant(H.id, () => checkinMod.completeCheckin(pend.id, "7"));
    flush(mark, { guest });
    const res = checkinMod.reservations[pend.id];
    console.log(`\n${C.dim}   ✓ קוד דלת שנוצר: ${res.doorCode || "❌ לא נוצר"} · חדר ${res.roomNumber} · מלון ${res.hotelId}${C.r}`);
  }

  // 2 — קונסיירז' סביב בן צבי 78
  await scenario(H, "קונסיירז' — מקומות אמיתיים סביב בן צבי 78", guest, async () => {
    await say(H, guest, "אני מחפש מסעדה איטלקית טובה קרוב למלון לארוחת ערב היום");
    await say(H, guest, "מה השעות והכתובת של הראשונה שהצעת?");
  });

  // 3 — חירום רפואי: מד"א 101, בלי "צוות בדרך"
  await scenario(H, "חירום רפואי — מד\"א 101, בלי צוות במקום", guest, async () => {
    await say(H, guest, "אשתי התעלפה בחדר, דחוף!");
  });

  // 4 — ניתוב מחלקה
  await scenario(H, "ניתוב מחלקה (וואטסאפ + מייל)", guest, async () => {
    await say(H, guest, "המזגן בחדר לא מקרר בכלל");
  });

  // 5 — צ'ק-אאוט + חשבונית מס
  if (pend) {
    await scenario(H, "צ׳ק-אאוט מלא + חשבונית מס-קבלה", guest, async () => {
      tenant.runInTenant(H.id, () => checkinMod.addDemoCharges(pend.id, "he"));
      await say(H, guest, "אני רוצה לעשות צ'ק אאוט");
      await say(H, guest, "כן");
      await say(H, guest, "5, היה מקסים");
    });
    printInvoice(checkinMod.reservations[pend.id], H);
  }
}

// ══════════════════════════════════════════════════════════
//  מלון KEMPINSKI — מלון מלא
// ══════════════════════════════════════════════════════════
async function runKempinski() {
  const H = HOTELS.kempinski;
  banner(`🏨  ${H.label}   ${C.dim}[מספר נכנס ${H.to}]${C.r}${C.ye}${C.b}`, C.ye);

  const cfg = config.configFor(H.id);
  note(`סוג: ${config.hotelModel(H.id).type} · כניסה: ${config.hotelModel(H.id).keyDelivery} · קבלה 24/7: ${config.hotelModel(H.id).staffed24_7 ? "כן" : "לא"}`);
  note(`מיקום: ${cfg.location.address_he} (${cfg.location.lat}, ${cfg.location.lng})`);
  note(`עוסק לחשבונית: ${cfg.business.legal_name} · ${cfg.business.business_id}`);

  const resident = "whatsapp:+972500000201";
  const tourist  = "whatsapp:+972500000202";

  // 1 — צ'ק-אין ישראלי (ת"ז) → כרטיס בקבלה, מע"מ 18%
  let resPend;
  await scenario(H, "צ׳ק-אין מלא (ישראלי, ת\"ז) → כרטיס בקבלה", resident, async () => {
    resPend = await fullCheckin(H, resident, {
      name: "ישראל ישראלי", reservation: "KEMP-5501", idResult: ID_RESIDENT,
      details: "2 אורחים, מגיעים ב-18:00, קומה גבוהה",
    });
  }, { fresh: true });
  if (resPend) {
    currentScenarioHotel = H.id;
    const mark = outbox.length;
    await tenant.runInTenant(H.id, () => checkinMod.completeCheckin(resPend.id, "304"));
    flush(mark, { guest: resident });
    const r = checkinMod.reservations[resPend.id];
    console.log(`\n${C.dim}   ✓ חדר ${r.roomNumber} · קוד דלת: ${r.doorCode || "אין (כרטיס בקבלה) ✓"} · תייר: ${r.isTourist ? "כן" : "לא"} · מלון ${r.hotelId}${C.r}`);
  }

  // 2 — צ'ק-אין תייר באנגלית (דרכון) → מע"מ 0%
  let tourPend;
  await scenario(H, "צ׳ק-אין באנגלית (תייר, דרכון) → זיהוי לפטור מע\"מ", tourist, async () => {
    tourPend = await fullCheckin(H, tourist, {
      name: "John Miller", reservation: "KEMP-5502", lang: "en", idResult: ID_TOURIST,
      details: "2 guests, arriving at 19:00",
    });
  }, { fresh: true });
  if (tourPend) {
    currentScenarioHotel = H.id;
    const mark = outbox.length;
    await tenant.runInTenant(H.id, () => checkinMod.completeCheckin(tourPend.id, "512"));
    flush(mark, { guest: tourist });
    const r = checkinMod.reservations[tourPend.id];
    console.log(`\n${C.dim}   ✓ חדר ${r.roomNumber} · תייר חוץ: ${r.isTourist ? "כן ✓ (מע\"מ 0%)" : "❌ לא זוהה"} · אזרחות: ${r.nationality || "—"}${C.r}`);
  }

  // 3 — קונסיירז' סביב הירקון 51
  await scenario(H, "קונסיירז' — מקומות אמיתיים סביב הירקון 51", resident, async () => {
    await say(H, resident, "אני מחפש מסעדת בשר טובה באזור");
    await say(H, resident, "עד איזו שעה הראשונה פתוחה ומה הטלפון שלה?");
  });

  // 4 — רום סרוויס עם תפריט
  await scenario(H, "שירות חדרים — הזמנה מהתפריט עד הסוף", resident, async () => {
    await say(H, resident, "אני רוצה להזמין פסטה לחדר");
    await say(H, resident, "לינגוויני");
    await say(H, resident, "רוזה, מנה שלמה, בלי פרמזן — רגישות ללקטוז");
    await say(H, resident, "וכוס יין אדום, זה הכל");
  });

  // 5 — חירום: יש צוות במלון
  await scenario(H, "חירום רפואי — צוות המלון בדרך + 101", resident, async () => {
    await say(H, resident, "יש כאן מישהו פצוע, דחוף!");
  });

  // 6 — ניתוב מחלקה
  await scenario(H, "ניתוב מחלקה (וואטסאפ + מייל)", resident, async () => {
    await say(H, resident, "צריך בבקשה מגבות נוספות לחדר");
  });

  // 7 — צ'ק-אאוט: ישראלי (18%) ותייר (0%)
  if (resPend) {
    await scenario(H, "צ׳ק-אאוט ישראלי + חשבונית מס 18%", resident, async () => {
      tenant.runInTenant(H.id, () => checkinMod.addDemoCharges(resPend.id, "he"));
      await say(H, resident, "אני רוצה לעשות צ'ק אאוט");
      await say(H, resident, "כן");
      await say(H, resident, "5, מצוין");
    });
    printInvoice(checkinMod.reservations[resPend.id], H);
  }
  if (tourPend) {
    await scenario(H, "צ׳ק-אאוט תייר + חשבונית מס 0%", tourist, async () => {
      tenant.runInTenant(H.id, () => checkinMod.addDemoCharges(tourPend.id, "en"));
      await say(H, tourist, "I'd like to check out please");
      await say(H, tourist, "yes");
      await say(H, tourist, "5, wonderful stay");
    });
    printInvoice(checkinMod.reservations[tourPend.id], H);
  }
}

// ── הדפסת שדות החובה של החשבונית שהופקה ─────────────────
function printInvoice(res, hotel) {
  const i = res?.invoice;
  if (!i) { console.log(`${C.re}   ❌ לא הופקה חשבונית להזמנה ${res?.id}${C.r}`); return; }
  const cfg = config.configFor(hotel.id);
  const money = (a) => `₪${(a / 100).toFixed(2)}`;
  const sellerOk = i.seller.businessId === cfg.business.business_id;
  console.log(`\n${C.dim}   ── שדות החובה של החשבונית ──`);
  console.log(`   סוג: ${i.type} · מס' ${i.number}`);
  console.log(`   עוסק: ${i.seller.name} · ${i.seller.businessId} · ${i.seller.address}`);
  console.log(`   לקוח: ${i.customer.name} · חדר ${i.customer.room}`);
  console.log(`   לפני מע"מ ${money(i.net)} · מע"מ ${Math.round(i.vatRate * 100)}% ${money(i.vat)} · סה"כ ${money(i.totalInclVat)}${C.r}`);
  console.log(
    sellerOk
      ? `${C.gr}   ✅ העוסק בחשבונית הוא של "${hotel.id}"${C.r}`
      : `${C.re}   ❌ העוסק בחשבונית (${i.seller.businessId}) אינו של "${hotel.id}" (${cfg.business.business_id})${C.r}`
  );
  findings.push({
    hotel: hotel.id, scenario: `חשבונית ${i.number}`, ok: sellerOk,
    problems: sellerOk ? [] : [`עוסק שגוי בחשבונית: ${i.seller.businessId}`],
  });
}

// ══════════════════════════════════════════════════════════
//  בידוד — אותו מספר טלפון בשני המלונות בו-זמנית
// ══════════════════════════════════════════════════════════
async function runIsolation() {
  banner("🔀  בידוד — אותו אורח כותב לשני המלונות באותו זמן", C.ma);
  note("אותו מספר טלפון בדיוק. אם הבידוד נכון — שני סשנים נפרדים, שתי תשובות שונות, כל אחת מהמספר של המלון שלה.");

  const guest = "whatsapp:+972500000999";
  state.deleteSession(guest, "lala");
  state.deleteSession(guest, "kempinski");

  // שתי שיחות מקבילות ממש (Promise.all) — זה מה שבודק את AsyncLocalStorage.
  const mark = outbox.length;
  currentScenarioHotel = null;
  await Promise.all([
    bot.handleIncoming(guest, "היי, מה שעת ארוחת הבוקר ואיפה היא?", null, { to: HOTELS.lala.to }),
    bot.handleIncoming(guest, "היי, מה שעת ארוחת הבוקר ואיפה היא?", null, { to: HOTELS.kempinski.to }),
  ]);

  const items = outbox.slice(mark).filter(i => i.kind === "wa" && i.to === guest);
  for (const it of items) {
    const from = String(it.from).replace(/^whatsapp:/, "");
    const which = tenant.normalizeNumber(from) === tenant.normalizeNumber(HOTELS.lala.to) ? "LALA"
                : tenant.normalizeNumber(from) === tenant.normalizeNumber(HOTELS.kempinski.to) ? "KEMPINSKI"
                : "❓";
    console.log(`\n${C.gr}${C.b}🤖 תשובה ${which}${C.r} ${C.dim}[מהמספר ${from}]${C.r}`);
    console.log(indent(it.body));
  }

  // הסשנים חייבים להיות נפרדים ולשאת כל אחד את המלון שלו.
  const sL = state.peekSession(guest, "lala");
  const sK = state.peekSession(guest, "kempinski");
  const separate = !!sL && !!sK && sL !== sK;
  const froms = new Set(items.map(i => tenant.normalizeNumber(String(i.from).replace(/^whatsapp:/, ""))));
  const bothNumbers = froms.has(tenant.normalizeNumber(HOTELS.lala.to)) && froms.has(tenant.normalizeNumber(HOTELS.kempinski.to));

  console.log(`\n${separate ? C.gr + "   ✅" : C.re + "   ❌"} שני סשנים נפרדים לאותו מספר טלפון${C.r}`);
  console.log(`${bothNumbers ? C.gr + "   ✅" : C.re + "   ❌"} כל תשובה יצאה מהמספר של המלון שלה${C.r}`);
  findings.push({
    hotel: "both", scenario: "בידוד סשנים במקביל", ok: separate && bothNumbers,
    problems: separate && bothNumbers ? [] : ["סשן או מספר יוצא לא הופרדו בין המלונות"],
  });
}

// ══════════════════════════════════════════════════════════
//  גאוגרפיה — שהמלצות כל מלון באמת סביבו
// ══════════════════════════════════════════════════════════
async function runGeography() {
  banner("🗺️  גאוגרפיה — חיפוש חי סביב כל מלון בנפרד", C.ma);
  if (!placesLive) { note("Places רץ על מוק (אין מפתח) — מדלגים על ההשוואה הגאוגרפית."); return; }

  for (const key of ["lala", "kempinski"]) {
    const H = HOTELS[key];
    const loc = config.configFor(H.id).location;
    const r = await places.searchNearby({ query: "מסעדה", category: "restaurant", lang: "he", location: loc, limit: 4 });
    console.log(`\n${C.b}${H.label}${C.r} ${C.dim}(${loc.lat}, ${loc.lng})${C.r}`);
    if (!r.ok) { console.log(`${C.re}   ❌ חיפוש נכשל: ${r.reason}${C.r}`); continue; }
    for (const p of r.results) {
      console.log(`   • ${p.name} — ${p.address}${p.distanceText ? ` ${C.dim}(${p.distanceText})${C.r}` : ""}`);
    }
  }
  note("שתי הרשימות אמורות להיות שונות לחלוטין — זו ההוכחה שהמיקום פר-מלון ולא גלובלי.");
}

// ══════════════════════════════════════════════════════════
//  הרצה
// ══════════════════════════════════════════════════════════
console.log(`${C.dim}Places: ${placesLive ? "GOOGLE (חי)" : "MOCK"} | AI: ${process.env.ANTHROPIC_API_KEY?.startsWith("sk-ant") ? "Claude אמיתי" : "❌ לא זמין"}${C.r}`);

const want = (process.argv[2] || "").toLowerCase();
const steps = {
  lala: runLala, kempinski: runKempinski, isolation: runIsolation, geography: runGeography,
};
const list = steps[want] ? [want] : Object.keys(steps);

for (const k of list) {
  try { await steps[k](); }
  catch (e) { console.error(`\n${C.re}💥 ${k} נכשל: ${e.stack}${C.r}`); findings.push({ hotel: k, scenario: "הרצה", ok: false, problems: [e.message] }); }
}

// ── סיכום ───────────────────────────────────────────────
banner("📋  סיכום בידוד ותקינות", C.ma);
const bad = findings.filter(f => !f.ok);
for (const f of findings) {
  console.log(`   ${f.ok ? C.gr + "✅" : C.re + "❌"} ${String(f.hotel).padEnd(10)} ${f.scenario}${C.r}`);
  for (const p of f.problems) console.log(`${C.re}        • ${p}${C.r}`);
}
console.log(
  bad.length === 0
    ? `\n${C.gr}${C.b}   ✅ אין דליפה בין המלונות — ${findings.length} בדיקות עברו.${C.r}\n`
    : `\n${C.re}${C.b}   ❌ ${bad.length} מתוך ${findings.length} בדיקות נכשלו.${C.r}\n`
);

try { fs.unlinkSync(process.env.DB_PATH); } catch {}
process.exit(bad.length === 0 ? 0 : 1);
