// ════════════════════════════════════════════════════════
//  PREFLIGHT — בדיקת ענק אחת לפני הדגמה מול לקוח
//  ----------------------------------------------------------
//  ארבעה חלקים, בסדר הזה:
//
//   A. בידול קונסיירז' × N — שני מלונות שואלים *במקביל* את אותה שאלה,
//      שוב ושוב. מוודאים שכל מלון חיפש סביב הקואורדינטות שלו, שהתוצאות
//      אכן קרובות אליו, ושאף שם מקום שהוחזר *רק* למלון האחד לא הופיע
//      בהודעה של המלון האחר. זה בדיוק התרחיש שבו cache משותף או מצב
//      גלובלי היו מתגלים.
//
//   B. עומס — הרבה מלונות × הרבה אורחים בו-זמנית. שני גלים:
//      B1 מסלול דטרמיניסטי בנפח גבוה (בלי AI): מאות אורחים מתחילים צ'ק
//         אין בו-זמנית ב-6 מלונות. בודק נעילות, סשנים, DB ובידוד טננט.
//      B2 גל עם Claude אמיתי, קטן יותר, כדי לאמת גם את המסלול היקר.
//
//   C. תהליכים מלאים בשני מלונות ההדגמה — צ'ק אין, ת"ז מול דרכון,
//      דחיית מסמך לא קביל, תנאי שהייה, פיקדון, מע"מ תושב/תייר, צ'ק אאוט
//      וחשבונית מס.
//
//   D. איכות פלט — כל הודעה שנשלחה לאורח בכל החלקים עוברת בדיקת ניסוח:
//      תגים פנימיים, markdown שוואטסאפ לא מרנדר, "undefined", placeholder
//      שלא הוחלף, ערבוב שפות, הודעה ריקה או ארוכה מדי.
//
//  הרצה:  node --experimental-test-module-mocks preflight.mjs [rounds]
// ════════════════════════════════════════════════════════
import { mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

process.env.DB_PATH                = path.join(os.tmpdir(), `hotel-preflight-${process.pid}.db`);
process.env.TWILIO_ACCOUNT_SID     = process.env.TWILIO_ACCOUNT_SID || "ACsim";
process.env.TWILIO_AUTH_TOKEN      = process.env.TWILIO_AUTH_TOKEN  || "sim";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+15550001001";
process.env.BASE_URL               = process.env.BASE_URL || "https://demo.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);
// העומס מדמה מאות אורחים בו-זמנית; בלימת הקצב per-guest אינה הנושא הנבדק.
process.env.GUEST_BURST            = "5000";

const C = {
  dim: "\x1b[2m", b: "\x1b[1m", r: "\x1b[0m", cy: "\x1b[36m", ye: "\x1b[33m",
  gr: "\x1b[32m", ma: "\x1b[35m", re: "\x1b[31m",
};

const ROUNDS = Number(process.argv[2]) || 20;

// ── לכידה ───────────────────────────────────────────────
const outbox = [];      // { from, to, body }
const emailbox = [];
let capture = true;

mock.module("twilio", {
  exports: {
    default: () => ({
      messages: {
        create: async ({ from, to, body }) => {
          if (!body) throw new Error("Twilio: body is required");
          if (capture) outbox.push({ from, to, body });
          return { sid: "SMpre" };
        },
      },
    }),
  },
});

const { email } = await import("./email/index.js");
email.send = async (m) => { if (capture) emailbox.push(m); return { success: true }; };

// אימות זהות — התוצאה נקבעת פר-תרחיש (זה השלב היחיד שאין לו URL מדיה אמיתי).
let nextIdResult = null;
const ID_RESIDENT = (name) => ({
  status: "verified", documentType: "id_card", storedPath: null, confidence: 0.96,
  fields: { full_name: name, document_type: "תעודת זהות", document_number: "0•••••••9", nationality: "ישראל" },
});
const ID_TOURIST = (name) => ({
  status: "verified", documentType: "passport", storedPath: null, confidence: 0.94,
  fields: { full_name: name, document_type: "Passport", document_number: "5•••••••2", nationality: "USA" },
});
const ID_REJECTED = {
  status: "rejected", documentType: "drivers_license", storedPath: null,
  reasonHe: "המסמך שנשלח אינו תעודת זהות או דרכון.",
  reasonEn: "The document sent is not an ID card or passport.",
};
const { idVerify } = await import("./idverify/index.js");
idVerify.verifyDocument = async () => nextIdResult || ID_RESIDENT("אורח");

// ── טעינת המערכת ────────────────────────────────────────
const bot     = await import("./bot.js");
const checkin = await import("./checkin.js");
const state   = await import("./state.js");
const config  = await import("./config.js");
const tenant  = await import("./tenant.js");
const { places, placesLive } = await import("./places/index.js");
const { haversineMeters } = await import("./places/util.js");
const { SAMPLE_HOTELS, seedSampleHotels } = await import("./sample-hotels.mjs");

seedSampleHotels({
  updateConfigFor: config.updateConfigFor,
  registerHotelNumber: tenant.registerHotelNumber,
  DEFAULT_HOTEL_ID: tenant.DEFAULT_HOTEL_ID,
});

// ── מעקב אחרי כל חיפוש מקומות, עם המלון שביקש אותו ──────
// זו נקודת האמת של בדיקת הבידול: מה *באמת* נשלח לגוגל, ובאיזה מיקום.
const searches = [];   // { hotelId, location, query, names[] }
const origSearch = places.searchNearby.bind(places);
places.searchNearby = async (params = {}) => {
  const hotelId = tenant.currentHotelId();
  const res = await origSearch(params);
  searches.push({
    hotelId,
    location: params.location,
    query: params.query,
    names: (res?.results || []).map(p => p.name),
    results: res?.results || [],
  });
  return res;
};

// ── תשתית דיווח ─────────────────────────────────────────
const findings = [];
function check(section, name, ok, detail = "") {
  findings.push({ section, name, ok, detail });
  console.log(`   ${ok ? C.gr + "✅" : C.re + "❌"} ${name}${C.r}${detail && !ok ? `\n${C.re}      ${detail}${C.r}` : ""}`);
  return ok;
}
function banner(t) {
  console.log(`\n\n${C.ye}${C.b}${"═".repeat(72)}\n  ${t}\n${"═".repeat(72)}${C.r}`);
}
function note(t) { console.log(`${C.dim}   » ${t}${C.r}`); }

const numberOf = (id) => SAMPLE_HOTELS.find(h => h.hotelId === id)?.number;
const LALA = { id: "lala", to: numberOf("lala") };
const KEMP = { id: "kempinski", to: numberOf("kempinski") };

const say = (hotel, phone, text, media = null) =>
  bot.handleIncoming(phone, text, media, { to: hotel.to });

// ════════════════════════════════════════════════════════
//  A. בידול קונסיירז' × ROUNDS
// ════════════════════════════════════════════════════════
async function sectionA() {
  banner(`A · בידול קונסיירז' — ${ROUNDS} סבבים, שני מלונות במקביל`);
  if (!placesLive) { note("אין מפתח Google — החלק הזה ידלג."); return; }

  const locL = config.configFor("lala").location;
  const locK = config.configFor("kempinski").location;
  note(`LALA (${locL.lat}, ${locL.lng})  ·  KEMPINSKI (${locK.lat}, ${locK.lng})`);
  note(`המרחק בין שני המלונות: ${Math.round(haversineMeters(locL, locK))} מ׳`);

  // שאלות מגוונות — כדי שלא נבדוק רק ערך אחד ב-cache.
  const QUERIES = [
    "אני מחפש מסעדה טובה קרוב למלון",
    "איפה אפשר לשתות קפה טוב בקרבת מקום?",
    "מסעדת בשר מומלצת באזור?",
    "יש בר נחמד קרוב?",
    "איפה בית מרקחת קרוב?",
  ];

  // 🔬 יושרה של הבדיקה עצמה: סבב שבו ה-AI רק שאל שאלת הבהרה ולא חיפש
  //    *אינו מוכיח כלום* על בידול. סופרים כמה סבבים באמת הפעילו חיפוש
  //    בשני המלונות, וכמה שמות מקומות באמת הושוו — אחרת "20 סבבים עברו"
  //    יכול להיות ריק מתוכן.
  let bad = 0, rounds = 0, dualSearchRounds = 0, namesCompared = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const q = QUERIES[i % QUERIES.length];
    const pL = `whatsapp:+9725551${String(i).padStart(5, "0")}`;
    const pK = `whatsapp:+9725552${String(i).padStart(5, "0")}`;
    state.deleteSession(pL, "lala");
    state.deleteSession(pK, "kempinski");
    state.patchSession(pL, { lang: "he", roomNumber: "7",   guestName: "דנה כהן" },   "lala");
    state.patchSession(pK, { lang: "he", roomNumber: "304", guestName: "ישראל ישראלי" }, "kempinski");

    const mark  = outbox.length;
    const smark = searches.length;

    // *במקביל* — זה מה שבודק את בידוד ההקשר האסינכרוני.
    await Promise.all([say(LALA, pL, q), say(KEMP, pK, q)]);

    const msgs = outbox.slice(mark);
    const srch = searches.slice(smark);
    const textL = msgs.filter(m => m.to === pL).map(m => m.body).join("\n");
    const textK = msgs.filter(m => m.to === pK).map(m => m.body).join("\n");
    const srchL = srch.filter(s => s.hotelId === "lala");
    const srchK = srch.filter(s => s.hotelId === "kempinski");

    const problems = [];

    // 1. כל חיפוש נעשה במיקום של המלון שביקש אותו.
    for (const s of srchL) {
      if (s.location?.lat !== locL.lat || s.location?.lng !== locL.lng) {
        problems.push(`LALA חיפשה במיקום ${s.location?.lat},${s.location?.lng}`);
      }
    }
    for (const s of srchK) {
      if (s.location?.lat !== locK.lat || s.location?.lng !== locK.lng) {
        problems.push(`קמפינסקי חיפש במיקום ${s.location?.lat},${s.location?.lng}`);
      }
    }

    // 2. התוצאות אכן קרובות למלון שביקש (ולא למלון השני).
    for (const [srcs, home, other, who] of [[srchL, locL, locK, "LALA"], [srchK, locK, locL, "קמפינסקי"]]) {
      for (const s of srcs) {
        for (const p of s.results) {
          if (p.lat == null || p.lng == null) continue;
          const dHome  = haversineMeters(home, p);
          const dOther = haversineMeters(other, p);
          // סובלנות: מקום באמצע יכול להיות קרוב לשניהם. מה שאסור הוא
          // תוצאה שרחוקה מהמלון שביקש *ובאופן מובהק* קרובה לשני.
          if (dHome > (home.search_radius_m || 4000) * 1.5 && dOther < dHome / 2) {
            problems.push(`${who}: "${p.name}" רחוק ${Math.round(dHome)}מ׳ ממנו אך ${Math.round(dOther)}מ׳ מהשני`);
          }
        }
      }
    }

    // 3. שם מקום שהוחזר *רק* למלון אחד לא מופיע בהודעה של השני.
    const namesL = new Set(srchL.flatMap(s => s.names));
    const namesK = new Set(srchK.flatMap(s => s.names));
    const onlyL  = [...namesL].filter(n => !namesK.has(n));
    const onlyK  = [...namesK].filter(n => !namesL.has(n));
    for (const n of onlyL) if (n.length > 3 && textK.includes(n)) problems.push(`שם "${n}" מ-LALA הופיע בהודעה של קמפינסקי`);
    for (const n of onlyK) if (n.length > 3 && textL.includes(n)) problems.push(`שם "${n}" מקמפינסקי הופיע בהודעה של LALA`);
    namesCompared += onlyL.length + onlyK.length;
    if (srchL.length && srchK.length) dualSearchRounds++;

    // 4. שם המלון השני לא מוזכר לאורח.
    if (/קמפינסקי|Kempinski/.test(textL)) problems.push("שם קמפינסקי הוזכר לאורח של LALA");
    if (/לאלה בוטיק|LALA/.test(textK))    problems.push("שם LALA הוזכר לאורח של קמפינסקי");

    rounds++;
    if (problems.length) {
      bad++;
      console.log(`   ${C.re}❌ סבב ${i + 1} ("${q}"):${C.r}`);
      for (const p of problems) console.log(`${C.re}      • ${p}${C.r}`);
    } else {
      process.stdout.write(`${C.gr}·${C.r}`);
    }
  }
  console.log("");
  check("A", `${rounds} סבבי בידול קונסיירז' — אין ולו בלבול אחד`, bad === 0, `${bad} סבבים עם בעיה`);
  note(`סבבים שבהם *שני* המלונות באמת חיפשו: ${dualSearchRounds}/${rounds} · שמות מקומות ייחודיים שהושוו: ${namesCompared}`);
  // אם כמעט אף סבב לא הפעיל חיפוש — הבדיקה לא באמת בדקה כלום.
  check("A", "רוב הסבבים הפעילו חיפוש חי בשני המלונות (הבדיקה אינה ריקה)",
    dualSearchRounds >= Math.ceil(rounds * 0.5), `רק ${dualSearchRounds}/${rounds} סבבים עם חיפוש כפול`);
  check("A", "הושוו מספיק שמות מקומות ייחודיים בין המלונות",
    namesCompared >= rounds, `רק ${namesCompared} שמות`);

  // סטטיסטיקה: כמה חיפושים בוצעו ולאיזה מלון
  const byHotel = searches.reduce((m, s) => (m[s.hotelId] = (m[s.hotelId] || 0) + 1, m), {});
  note(`סה"כ חיפושים חיים: ${JSON.stringify(byHotel)}`);
  check("A", "כל חיפוש שויך למלון מוכר (אין חיפוש בלי טננט)",
    searches.every(s => s.hotelId === "lala" || s.hotelId === "kempinski"),
    `נמצאו חיפושים משויכים ל: ${[...new Set(searches.map(s => s.hotelId))].join(", ")}`);
}

// ════════════════════════════════════════════════════════
//  B. עומס — הרבה מלונות, הרבה אורחים, בו-זמנית
// ════════════════════════════════════════════════════════
// מלון סינתטי **מלא** — כל מה שמלון אמיתי חייב לספק כדי להיות מבודד
// ממלון ברירת המחדל. זו בדיוק הרשימה ש-checkTenantIsolation אוכף, ולכן
// הפונקציה הזו משמשת גם כתבנית onboarding: מלון שממלא את כל אלה עובר.
function synthHotel(i) {
  const id  = `load${i}`;
  const pad = String(i).padStart(2, "0");
  const nameHe = `מלון עומס ${i}`, nameEn = `Load Hotel ${i}`;
  return {
    id,
    number: `+1555900${pad}00`,
    config: {
      name: nameEn, name_he: nameHe,
      // 1. אנשי קשר של שש המחלקות — וואטסאפ ומייל
      housekeeping_number: `whatsapp:+97290${pad}0001`, reception_number: `whatsapp:+97290${pad}0002`,
      maintenance_number:  `whatsapp:+97290${pad}0003`, concierge_number: `whatsapp:+97290${pad}0004`,
      security_number:     `whatsapp:+97290${pad}0005`, room_service_number: `whatsapp:+97290${pad}0006`,
      housekeeping_email: `hk@load${i}.test`,  reception_email: `rec@load${i}.test`,
      maintenance_email:  `mnt@load${i}.test`, concierge_email: `cnc@load${i}.test`,
      security_email:     `sec@load${i}.test`, room_service_email: `rs@load${i}.test`,
      // 2. פרטי העוסק לחשבונית המס
      business: { legal_name: `${nameHe} בע"מ`, legal_name_en: `${nameEn} Ltd.`,
                  business_id: `5150000${pad}`, business_type: "עוסק מורשה",
                  address: `רחוב הבדיקה ${i}, תל אביב`, address_en: `${i} Test St, Tel Aviv`,
                  phone: `+972-3-900-00${pad}`, email: `billing@load${i}.test` },
      // 3. מיקום — מרכז החיפוש של הקונסיירז'
      location: { address: `${i} Test St, Tel Aviv`, address_he: `רחוב הבדיקה ${i}, תל אביב`,
                  lat: 32.05 + i / 100, lng: 34.77 + i / 100,
                  timezone: "Asia/Jerusalem", country: "IL", search_radius_m: 3000 },
      // 4. המקטעים שהאורח רואה — חייבים להיות של המלון הזה
      wifi: { name: `Load${i}_Guest`, password: `Load${i}Pass` },
      safety: {
        he: { shelter_location: `הממ"ד בקומה ‎-1 של מלון עומס ${i}`, shelter_time: "כ-90 שניות" },
        en: { shelter_location: `the shelter on Level -1 of ${nameEn}`, shelter_time: "about 90 seconds" },
      },
      building: {
        he: { floors: `${i + 3} קומות אירוח`, lobby: "הלובי בקומת הקרקע", reception: "קבלה מאוישת 24/7",
              elevators: "שתי מעליות אורחים", accessibility: "גישה נטולת מדרגות",
              key_areas: `ארוחת בוקר קומה 1 · חדר ישיבות קומה ${i + 1}` },
        en: { floors: `${i + 3} guest floors`, lobby: "Lobby on the ground floor", reception: "Reception staffed 24/7",
              elevators: "Two guest lifts", accessibility: "Step-free access",
              key_areas: `Breakfast Level 1 · meeting room Level ${i + 1}` },
      },
      services: {
        pool: null, spa: null, gym: null, restaurant: null, bar: null, laundry: null, room_service: null,
        breakfast: {
          he: { name: "ארוחת בוקר", hours: `0${6 + i}:30–10:00`, location: `אולם הבוקר של ${nameHe}`, price: "כלולה בלינה" },
          en: { name: "Breakfast", hours: `0${6 + i}:30–10:00`, location: `the breakfast room at ${nameEn}`, price: "Included" },
        },
      },
      restaurants: null,
      parking: {
        available: true,
        he: { type: "חניון תת-קרקעי", price: `₪${40 + i} ללילה`, hours: "24/7" },
        en: { type: "Underground car park", price: `₪${40 + i} per night`, hours: "24/7" },
      },
      arrival: {
        he: { by_car: `נסיעה לרחוב הבדיקה ${i}`, from_airport: `כ-${20 + i} דקות מנתב"ג`,
              check_in_time: "הכניסה מהשעה 15:00" },
        en: { by_car: `Drive to ${i} Test St`, from_airport: `About ${20 + i} min from Ben Gurion`,
              check_in_time: "Check-in from 15:00" },
      },
      faq: [
        { he: { q: "שעות כניסה ועזיבה?", a: `במלון עומס ${i}: כניסה מ-15:00, עזיבה עד 12:00.` },
          en: { q: "Check-in / check-out?", a: `At ${nameEn}: check-in from 15:00, check-out by 12:00.` } },
      ],
      local_area: {
        he: { neighbourhood: `הסביבה של ${nameHe}`, restaurants: [], attractions: [], tours: [], nightlife: [], shopping: [], transport: {} },
        en: { neighbourhood: `The area around ${nameEn}`, restaurants: [], attractions: [], tours: [], nightlife: [], shopping: [], transport: {} },
      },
    },
  };
}

async function sectionB() {
  banner("B · עומס — מלונות רבים × אורחים רבים בו-זמנית");

  const HOTELS = [LALA, KEMP, ...Array.from({ length: 4 }, (_, i) => {
    const h = synthHotel(i + 1);
    config.updateConfigFor(h.id, h.config);
    tenant.registerHotelNumber(h.number, h.id, h.number);
    return { id: h.id, to: h.number };
  })];

  // ── B1: נפח גבוה, מסלול דטרמיניסטי (בלי AI) ──────────
  const GUESTS_PER_HOTEL = 100;
  const total = HOTELS.length * GUESTS_PER_HOTEL;
  note(`B1 — ${HOTELS.length} מלונות × ${GUESTS_PER_HOTEL} אורחים = ${total} הודעות במקביל (מסלול צ'ק אין, בלי AI)`);

  capture = false;   // לא מציפים את בדיקת איכות הפלט ב-600 הודעות זהות
  const seen = [];
  const t0 = Date.now();
  const jobs = [];
  for (const h of HOTELS) {
    for (let g = 0; g < GUESTS_PER_HOTEL; g++) {
      const phone = `whatsapp:+97255${String(HOTELS.indexOf(h)).padStart(2, "0")}${String(g).padStart(4, "0")}`;
      jobs.push((async () => {
        await bot.handleIncoming(phone, "אני רוצה לעשות צ'ק אין", null, { to: h.to });
        await bot.handleIncoming(phone, "ישראל ישראלי", null, { to: h.to });
        seen.push({ hotel: h.id, phone });
      })());
    }
  }
  const settled = await Promise.allSettled(jobs);
  const elapsed = Date.now() - t0;
  capture = true;

  const failed = settled.filter(s => s.status === "rejected");
  check("B", `${total} שיחות במקביל הסתיימו בלי קריסה`, failed.length === 0,
    failed.slice(0, 3).map(f => f.reason?.message).join(" | "));
  note(`זמן: ${(elapsed / 1000).toFixed(1)} שניות (${Math.round(total / (elapsed / 1000))} הודעות/שנייה)`);

  // כל אורח קיבל סשן, במלון הנכון, ובשלב הנכון של הצ'ק אין.
  let wrongStage = 0, wrongTenant = 0, missing = 0;
  for (const { hotel, phone } of seen) {
    const s = state.peekSession(phone, hotel);
    if (!s) { missing++; continue; }
    if (s.checkinStage !== "waiting_reservation") wrongStage++;
    // אותו אורח לא אמור להתקיים במלון אחר
    for (const h of HOTELS) {
      if (h.id === hotel) continue;
      if (state.peekSession(phone, h.id)) wrongTenant++;
    }
  }
  check("B", "כל אורח קיבל סשן משלו", missing === 0, `${missing} אורחים בלי סשן`);
  check("B", "כל הסשנים בשלב הנכון (אין דריסת מצב בין הודעות)", wrongStage === 0, `${wrongStage} סשנים בשלב שגוי`);
  check("B", "אין סשן שדלף למלון אחר", wrongTenant === 0, `${wrongTenant} דליפות`);

  // ── B2: גל עם Claude אמיתי ────────────────────────────
  const AI_PER_HOTEL = 5;
  note(`B2 — ${HOTELS.length} מלונות × ${AI_PER_HOTEL} אורחים = ${HOTELS.length * AI_PER_HOTEL} הודעות AI במקביל (Claude אמיתי)`);
  const aiJobs = [];
  const aiExpect = [];
  for (const h of HOTELS) {
    for (let g = 0; g < AI_PER_HOTEL; g++) {
      const phone = `whatsapp:+97256${String(HOTELS.indexOf(h)).padStart(2, "0")}${String(g).padStart(4, "0")}`;
      state.patchSession(phone, { lang: "he", roomNumber: "101", guestName: "אורח בדיקה" }, h.id);
      aiExpect.push({ phone, hotel: h.id });
      aiJobs.push(bot.handleIncoming(phone, "מה שעות הצ'ק אאוט?", null, { to: h.to }));
    }
  }
  const aiSettled = await Promise.allSettled(aiJobs);
  const aiFailed = aiSettled.filter(s => s.status === "rejected");
  check("B", `${aiJobs.length} הודעות AI במקביל — כולן הצליחו`, aiFailed.length === 0,
    aiFailed.slice(0, 3).map(f => f.reason?.message).join(" | "));

  // כל אורח קיבל תשובה, מהמספר של המלון שלו.
  let noReply = 0, wrongFrom = 0;
  for (const { phone, hotel } of aiExpect) {
    const replies = outbox.filter(m => m.to === phone);
    if (!replies.length) { noReply++; continue; }
    const want = tenant.normalizeNumber(HOTELS.find(h => h.id === hotel).to);
    for (const r of replies) {
      if (tenant.normalizeNumber(String(r.from).replace(/^whatsapp:/, "")) !== want) wrongFrom++;
    }
  }
  check("B", "כל אורח קיבל תשובה", noReply === 0, `${noReply} אורחים בלי תשובה`);
  check("B", "כל תשובה יצאה מהמספר של המלון הנכון", wrongFrom === 0, `${wrongFrom} תשובות ממספר שגוי`);

  // בידוד קונפיג של כל המלונות הסינתטיים
  const notIsolated = HOTELS.filter(h => h.id !== KEMP.id && !config.checkTenantIsolation(h.id).ok);
  check("B", "כל המלונות מבודדים זה מזה בקונפיג", notIsolated.length === 0,
    notIsolated.map(h => h.id).join(", "));
}

// ════════════════════════════════════════════════════════
//  C. תהליכים מלאים — שני מלונות ההדגמה
// ════════════════════════════════════════════════════════
function stayText(nights = 3) {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${nights} לילות ${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
}

const FAKE_ID = { url: "https://example.com/id.jpg", contentType: "image/jpeg" };

async function fullFlow(hotel, phone, { name, reservation, lang, idResult, expectTourist }) {
  const he = lang === "he";
  state.deleteSession(phone, hotel.id);
  nextIdResult = idResult(name);

  await say(hotel, phone, he ? "אני רוצה לעשות צ'ק אין" : "I'd like to check in");
  await say(hotel, phone, name);
  await say(hotel, phone, reservation);
  await say(hotel, phone, he ? stayText(3) : "3 nights from tomorrow");
  await say(hotel, phone, he ? "כן" : "yes");
  await say(hotel, phone, he ? "2 אורחים" : "2 guests");

  // מסמך לא קביל נדחה, והצ'ק אין *לא* מתקדם.
  const beforeReject = outbox.length;
  nextIdResult = ID_REJECTED;
  await say(hotel, phone, he ? "הנה רישיון הנהיגה" : "Here's my driving licence", FAKE_ID);
  const rejectMsgs = outbox.slice(beforeReject).filter(m => m.to === phone).map(m => m.body).join("\n");
  const stillOnId = state.peekSession(phone, hotel.id)?.checkinStage === "waiting_id";
  check("C", `${hotel.id}/${lang}: רישיון נהיגה נדחה והצ'ק אין נשאר בשלב הזהות`, stillOnId,
    `שלב נוכחי: ${state.peekSession(phone, hotel.id)?.checkinStage}`);
  check("C", `${hotel.id}/${lang}: הסבר הדחייה נמסר לאורח`,
    /תעודת זהות|דרכון|ID card|passport/i.test(rejectMsgs));

  // ועכשיו המסמך התקין.
  nextIdResult = idResult(name);
  await say(hotel, phone, he ? "הנה התעודה" : "Here is my document", FAKE_ID);

  const sess = state.peekSession(phone, hotel.id);
  check("C", `${hotel.id}/${lang}: אחרי אימות — שלב תנאי השהייה`, sess?.checkinStage === "waiting_terms",
    `שלב: ${sess?.checkinStage}`);
  check("C", `${hotel.id}/${lang}: זיהוי תייר/תושב נכון`, !!sess?.pendingIsTourist === expectTourist,
    `pendingIsTourist=${sess?.pendingIsTourist}`);

  // תנאי שהייה — "כן" אינו אישור; נדרש נוסח מפורש.
  const beforeYes = outbox.length;
  await say(hotel, phone, he ? "כן" : "yes");
  const stillTerms = state.peekSession(phone, hotel.id)?.checkinStage === "waiting_terms";
  check("C", `${hotel.id}/${lang}: "כן" לבדו אינו אישור תנאים`, stillTerms);
  void beforeYes;

  await say(hotel, phone, he ? "אני מאשר את התנאים" : "I confirm the terms");
  const afterTerms = state.peekSession(phone, hotel.id);
  check("C", `${hotel.id}/${lang}: אישור התנאים נרשם עם נוסח ו-hash`,
    !!afterTerms?.termsHash && !!afterTerms?.termsAcceptanceText,
    `hash=${afterTerms?.termsHash} text=${afterTerms?.termsAcceptanceText}`);

  const pend = tenant.runInTenant(hotel.id, () => checkin.getPendingReservation(phone, hotel.id));
  check("C", `${hotel.id}/${lang}: נוצרה הזמנה ממתינה עם פיקדון`,
    !!pend && pend.deposit === config.configFor(hotel.id).deposit_amount,
    `deposit=${pend?.deposit}`);
  return pend;
}

async function sectionC() {
  banner("C · תהליכים מלאים — צ'ק אין, זהות, תנאים, פיקדון, מע\"מ, צ'ק אאוט");

  const cases = [
    { hotel: LALA, phone: "whatsapp:+972557000001", name: "דנה כהן",   reservation: "LALA-9001", lang: "he", idResult: ID_RESIDENT, expectTourist: false, room: "7",   vat: 0.18 },
    { hotel: KEMP, phone: "whatsapp:+972557000002", name: "ישראל ישראלי", reservation: "KEMP-9002", lang: "he", idResult: ID_RESIDENT, expectTourist: false, room: "304", vat: 0.18 },
    { hotel: KEMP, phone: "whatsapp:+972557000003", name: "John Miller", reservation: "KEMP-9003", lang: "en", idResult: ID_TOURIST,  expectTourist: true,  room: "512", vat: 0 },
  ];

  for (const c of cases) {
    console.log(`\n${C.cy}${C.b}── ${c.hotel.id} · ${c.lang} · ${c.name} ──${C.r}`);
    const pend = await fullFlow(c.hotel, c.phone, c);
    if (!pend) { check("C", `${c.hotel.id}/${c.lang}: המשך התהליך`, false, "אין הזמנה"); continue; }

    // השלמת הצ'ק אין (הפיקדון אושר) — כרטיס מול קוד דלת.
    await tenant.runInTenant(c.hotel.id, () => checkin.completeCheckin(pend.id, c.room));
    const res = checkin.reservations[pend.id];
    const model = config.hotelModel(c.hotel.id);
    check("C", `${c.hotel.id}/${c.lang}: אמצעי כניסה נכון לסוג המלון`,
      model.keyDelivery === "door_code" ? !!res.doorCode : !res.doorCode,
      `keyDelivery=${model.keyDelivery} doorCode=${res.doorCode}`);
    check("C", `${c.hotel.id}/${c.lang}: הסשן מסומן כמאוכלס וקשור להזמנה`,
      state.peekSession(c.phone, c.hotel.id)?.stage === "checked_in",
      `stage=${state.peekSession(c.phone, c.hotel.id)?.stage}`);

    // צ'ק אאוט מלא דרך הצ'אט.
    tenant.runInTenant(c.hotel.id, () => checkin.addDemoCharges(pend.id, c.lang));
    const beforeOut = outbox.length;
    await say(c.hotel, c.phone, c.lang === "he" ? "אני רוצה לעשות צ'ק אאוט" : "I'd like to check out");
    await say(c.hotel, c.phone, c.lang === "he" ? "כן" : "yes");
    const outMsgs = outbox.slice(beforeOut).filter(m => m.to === c.phone).map(m => m.body).join("\n");

    const inv = checkin.reservations[pend.id].invoice;
    const biz = config.configFor(c.hotel.id).business;
    check("C", `${c.hotel.id}/${c.lang}: הופקה חשבונית מס-קבלה`, !!inv, "אין חשבונית");
    if (inv) {
      check("C", `${c.hotel.id}/${c.lang}: החשבונית נושאת את העוסק של המלון`,
        inv.seller.businessId === biz.business_id, `${inv.seller.businessId} ≠ ${biz.business_id}`);
      check("C", `${c.hotel.id}/${c.lang}: שיעור מע"מ נכון (${c.vat * 100}%)`,
        inv.vatRate === c.vat, `vatRate=${inv.vatRate}`);
      check("C", `${c.hotel.id}/${c.lang}: חישוב מע"מ עקבי (net+vat=total)`,
        inv.net + inv.vat === inv.totalInclVat, `${inv.net}+${inv.vat}≠${inv.totalInclVat}`);
      check("C", `${c.hotel.id}/${c.lang}: סכום החשבונית = סך החיובים`,
        inv.totalInclVat === tenant.runInTenant(c.hotel.id, () => checkin.getFolioTotal(pend.id)));
      check("C", `${c.hotel.id}/${c.lang}: החשבונית נשלחה לאורח`,
        outMsgs.includes(inv.number), `מס' ${inv.number} לא הופיע בהודעות`);
    }
    check("C", `${c.hotel.id}/${c.lang}: הפיקדון סולק (נלכד/שוחרר)`,
      checkin.reservations[pend.id].captured || checkin.reservations[pend.id].refunded);
  }
}

// ════════════════════════════════════════════════════════
//  D. איכות פלט
// ════════════════════════════════════════════════════════
const HEB = /[֐-׿]/;
function sectionD() {
  banner("D · איכות פלט — כל הודעה שנשלחה לאורח");

  // הודעות לאורחים בלבד (לא התראות צוות — הן פנימיות ובעברית תמיד).
  const staffNumbers = new Set();
  for (const hid of ["lala", "kempinski"]) {
    for (const d of config.DEPARTMENTS) {
      const n = config.configFor(hid)[`${d}_number`];
      if (n) staffNumbers.add(n);
    }
  }
  const guestMsgs = outbox.filter(m => !staffNumbers.has(m.to));
  note(`נבדקות ${guestMsgs.length} הודעות לאורחים`);

  const RULES = [
    ["תג פנימי דלף לאורח",        /\[(HK|HK_URGENT|MAINTENANCE|ROOMSERVICE|CONCIERGE|RECEPTION|SECURITY|EMERGENCY|CHECKIN|CHECKOUT)\b/],
    ["טבלת markdown (וואטסאפ לא מרנדר)", /\|\s*:?-{3,}/],
    ["הדגשה כפולה **",            /\*\*/],
    ["כותרת markdown ###",        /^#{1,6}\s/m],
    ["קו מפריד ---",              /^\s*[-_*]{3,}\s*$/m],
    ["undefined בטקסט",           /\bundefined\b/],
    ["null בטקסט",                /\bnull\b/],
    ["NaN בטקסט",                 /\bNaN\b/],
    ["[object Object]",           /\[object Object\]/],
    ["placeholder שלא הוחלף",     /\{(hotel|deposit|checkout_time|name|room)\}/],
    ["שלוש שורות ריקות ברצף",     /\n{3,}/],
    ["צורת לוכסן (הקלד/י)",       /(הקלד|כתוב|בחר|שלח|לחץ)\/[יא]/],
    ["רווח כפול בתוך משפט",       /\S {2,}\S/],
  ];

  const violations = [];
  for (const m of guestMsgs) {
    for (const [label, re] of RULES) {
      if (re.test(m.body)) violations.push({ label, to: m.to, body: m.body.slice(0, 160) });
    }
    if (!m.body.trim()) violations.push({ label: "הודעה ריקה", to: m.to, body: "" });
    if (m.body.length > 1500) violations.push({ label: `הודעה ארוכה מ-1500 (${m.body.length})`, to: m.to, body: m.body.slice(0, 120) });
  }

  const byLabel = violations.reduce((a, v) => (a[v.label] = (a[v.label] || 0) + 1, a), {});
  for (const [label] of RULES) {
    check("D", label.startsWith("הודעה") ? label : `אין: ${label}`, !byLabel[label],
      byLabel[label] ? `${byLabel[label]} מופעים. דוגמה: ${violations.find(v => v.label === label)?.body}` : "");
  }
  check("D", "אין הודעה ריקה", !byLabel["הודעה ריקה"]);
  check("D", "אין הודעה מעל מגבלת וואטסאפ",
    !Object.keys(byLabel).some(k => k.startsWith("הודעה ארוכה")),
    Object.keys(byLabel).filter(k => k.startsWith("הודעה ארוכה")).join(", "));

  // עקביות שפה: אורח אנגלי לא מקבל בלוקים בעברית.
  const enGuest = "whatsapp:+972557000003";
  const enMsgs = guestMsgs.filter(m => m.to === enGuest);
  const hebrewLeak = enMsgs.filter(m => {
    // מותר שם מקום/רחוב בודד; פוסלים רק כשיש עברית *משמעותית*.
    const heb = (m.body.match(/[֐-׿]/g) || []).length;
    return heb > 12;
  });
  check("D", `אורח אנגלי (${enMsgs.length} הודעות) לא קיבל טקסט בעברית`, hebrewLeak.length === 0,
    hebrewLeak.slice(0, 1).map(m => m.body.slice(0, 200)).join(""));

  // אורח עברי מקבל עברית.
  const heGuest = "whatsapp:+972557000002";
  const heMsgs = guestMsgs.filter(m => m.to === heGuest);
  check("D", `אורח עברי (${heMsgs.length} הודעות) מקבל עברית`,
    heMsgs.length > 0 && heMsgs.every(m => HEB.test(m.body)));

  // התראות הצוות — תמיד בעברית, גם כשהאורח אנגלי.
  const staffMsgs = outbox.filter(m => staffNumbers.has(m.to));
  check("D", `כל ${staffMsgs.length} התראות הצוות בעברית`,
    staffMsgs.length > 0 && staffMsgs.every(m => HEB.test(m.body)));
}

// ════════════════════════════════════════════════════════
//  הרצה
// ════════════════════════════════════════════════════════
console.log(`${C.dim}Places: ${placesLive ? "GOOGLE (חי)" : "MOCK"} | AI: ${process.env.ANTHROPIC_API_KEY?.startsWith("sk-ant") ? "Claude אמיתי" : "❌ לא זמין"} | סבבי בידול: ${ROUNDS}${C.r}`);

for (const [name, fn] of [["A", sectionA], ["B", sectionB], ["C", sectionC], ["D", sectionD]]) {
  try { await fn(); }
  catch (e) {
    console.error(`\n${C.re}💥 חלק ${name} נפל: ${e.stack}${C.r}`);
    findings.push({ section: name, name: `חלק ${name} הסתיים בשגיאה`, ok: false, detail: e.message });
  }
}

banner("📋  סיכום Preflight");
const bad = findings.filter(f => !f.ok);
for (const s of ["A", "B", "C", "D"]) {
  const items = findings.filter(f => f.section === s);
  if (!items.length) continue;
  const failed = items.filter(f => !f.ok).length;
  console.log(`   ${failed ? C.re + "❌" : C.gr + "✅"} חלק ${s}: ${items.length - failed}/${items.length} עברו${C.r}`);
  for (const f of items.filter(x => !x.ok)) console.log(`${C.re}        • ${f.name}${f.detail ? ` — ${f.detail}` : ""}${C.r}`);
}
console.log(
  bad.length === 0
    ? `\n${C.gr}${C.b}   ✅ הכל תקין — ${findings.length} בדיקות עברו.${C.r}\n`
    : `\n${C.re}${C.b}   ❌ ${bad.length} מתוך ${findings.length} בדיקות נכשלו.${C.r}\n`
);

try { fs.unlinkSync(process.env.DB_PATH); } catch {}
process.exit(bad.length === 0 ? 0 : 1);
