// ════════════════════════════════════════════════════════
//  CONCIERGE LIVE CHECK — בדיקה חיה של הקונסיירז' לכל מלון ולכל בקשה
//  ----------------------------------------------------------
//  מריץ מול Google Places API האמיתי (ואופציונלית Claude האמיתי) ומדפיס
//  תוצאות אמיתיות שרואים בעיניים. מוכיח:
//   A. לכל מלון (ת"א/ירושלים/אילת/חיפה/ניו יורק/לונדון) — מקומות אמיתיים
//      ליד המלון הנכון, לכל סוג בקשה (מסעדות/ספא/כספומט/וטרינר/...).
//   B. אזור זמן: "פתוח עכשיו" והשעות לפי השעון המקומי של המלון.
//   C. עומס: כל המלונות שואלים דברים שונים בו-זמנית — בלי ערבוב, בלי קריסה.
//   D. (אופציונלי) שיחות AI מלאות דרך handleIncoming — התשובה שהאורח מקבל.
//
//  הרצה:
//    GOOGLE_PLACES_API_KEY=... node --experimental-test-module-mocks concierge-live-check.mjs [sweep|tz|load|ai|all]
//  בלי מפתח — נעצר בהודעה ברורה (לא רץ על mock, כי המטרה היא אימות חי).
// ════════════════════════════════════════════════════════
import { mock } from "node:test";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
dotenv.config();

process.env.DB_PATH = path.join(os.tmpdir(), `hotel-livecheck-${process.pid}.db`);
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACcheck";
process.env.TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "check";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.BASE_URL = process.env.BASE_URL || "https://demo.local";
process.env.ID_ENCRYPTION_KEY = "0".repeat(64);

const C = { dim: "\x1b[2m", b: "\x1b[1m", r: "\x1b[0m", cy: "\x1b[36m", ye: "\x1b[33m", gr: "\x1b[32m", ma: "\x1b[35m", re: "\x1b[31m" };
const mode = (process.argv[2] || "all").toLowerCase();

// mock של Twilio — לוכד יוצא (רק חלק ה-AI צריך אותו).
const sent = [];
mock.module("twilio", {
  exports: { default: () => ({ messages: { create: async ({ to, body }) => { if (!body) throw new Error("body required"); sent.push({ to, body }); return { sid: "SMx" }; } } }) },
});

const { placesLive, places } = await import("./places/index.js");
const { configFor } = await import("./config.js");
const tenant = await import("./tenant.js");
const { seedSampleHotels, SAMPLE_HOTELS } = await import("./sample-hotels.mjs");
const { updateConfigFor } = await import("./config.js");

if (!placesLive) {
  console.error(`\n${C.re}${C.b}⛔ אין חיפוש חי.${C.r} הבדיקה החיה דורשת GOOGLE_PLACES_API_KEY אמיתי (ו-PLACES_PROVIDER≠mock).`);
  console.error(`   הגדר את המפתח והרץ שוב:`);
  console.error(`   ${C.dim}GOOGLE_PLACES_API_KEY=... node --experimental-test-module-mocks concierge-live-check.mjs${C.r}\n`);
  process.exit(1);
}

seedSampleHotels({ ...tenant, updateConfigFor });

// כל סוגי הבקשות שאורח יכול לבקש — עברית לישראל, אנגלית לחו"ל.
const CATEGORIES = [
  { cat: "restaurant",   label: "מסעדה (כללי)",        he: "מסעדה טובה",           en: "good restaurant" },
  { cat: "restaurant",   label: "מסעדת בשר",           he: "מסעדת בשר",            en: "steakhouse" },
  { cat: "restaurant",   label: "מסעדה חלבית",         he: "מסעדה חלבית",          en: "dairy restaurant" },
  { cat: "restaurant",   label: "כשר",                 he: "מסעדה כשרה",           en: "kosher restaurant" },
  { cat: "restaurant",   label: "טבעוני",              he: "מסעדה טבעונית",        en: "vegan restaurant" },
  { cat: "restaurant",   label: "סושי",                he: "סושי",                 en: "sushi" },
  { cat: "cafe",         label: "בית קפה",             he: "בית קפה",              en: "coffee shop" },
  { cat: "bar",          label: "בר",                  he: "בר",                   en: "cocktail bar" },
  { cat: "hair_salon",   label: "מספרה",               he: "מספרה",                en: "hair salon" },
  { cat: "spa",          label: "ספא",                 he: "ספא",                  en: "day spa" },
  { cat: "beauty_salon", label: "מכון יופי",           he: "מכון יופי",            en: "beauty salon" },
  { cat: "nail_salon",   label: "ציפורניים",           he: "מניקור פדיקור",        en: "nail salon" },
  { cat: "gym",          label: "חדר כושר",            he: "חדר כושר",             en: "gym" },
  { cat: "pharmacy",     label: "בית מרקחת",           he: "בית מרקחת",            en: "pharmacy" },
  { cat: "supermarket",  label: "סופרמרקט",            he: "סופרמרקט",             en: "supermarket" },
  { cat: "shopping",     label: "קניון",               he: "קניון",                en: "shopping mall" },
  { cat: "clothing",     label: "חנות בגדים",          he: "חנות בגדים",           en: "clothing store" },
  { cat: "atm",          label: "כספומט",              he: "כספומט",               en: "ATM" },
  { cat: "bank",         label: "בנק",                 he: "בנק",                  en: "bank" },
  { cat: "gas_station",  label: "תחנת דלק",            he: "תחנת דלק",             en: "gas station" },
  { cat: "car_repair",   label: "מוסך",                he: "מוסך",                 en: "car repair" },
  { cat: "laundry",      label: "מכבסה",               he: "מכבסה",                en: "laundromat" },
  { cat: "doctor",       label: "רופא",                he: "מרפאה",                en: "doctor clinic" },
  { cat: "dentist",      label: "רופא שיניים",         he: "רופא שיניים",          en: "dentist" },
  { cat: "vet",          label: "וטרינר",              he: "וטרינר",               en: "veterinarian" },
  { cat: "preschool",    label: "גן ילדים",            he: "גן ילדים",             en: "kindergarten" },
  { cat: "park",         label: "פארק",                he: "פארק",                 en: "park" },
  { cat: "museum",       label: "מוזיאון",             he: "מוזיאון",              en: "museum" },
  { cat: "art_gallery",  label: "גלריה",               he: "גלריה לאמנות",         en: "art gallery" },
  { cat: "theater",      label: "תיאטרון",             he: "תיאטרון",              en: "theatre" },
  { cat: "movie_theater",label: "קולנוע",              he: "קולנוע",               en: "cinema" },
  { cat: "attraction",   label: "אטרקציה",             he: "אטרקציה תיירותית",     en: "tourist attraction" },
  { cat: "attraction",   label: "חוף ים",              he: "חוף ים",               en: "beach" },
  { cat: "travel_agency",label: "סיורים",              he: "סיורים מודרכים",       en: "guided tours" },
  { cat: "florist",      label: "פרחים",               he: "חנות פרחים",           en: "florist" },
  { cat: "gift",         label: "מתנות",               he: "חנות מתנות",           en: "gift shop" },
  { cat: "store",        label: "אופטיקה",             he: "אופטיקה משקפיים",      en: "optician" },
  { cat: "spa",          label: "עיסוי",               he: "עיסוי",                en: "massage" },
];

function localeFor(hotelId) {
  const country = configFor(hotelId).location?.country;
  return (country && country !== "IL") ? "en" : "he";
}

function placeLine(r) {
  const bits = [`${C.b}${r.name}${C.r}`];
  if (r.address)      bits.push(r.address);
  if (r.phone)        bits.push(`☎ ${r.phone}`);
  if (r.rating)       bits.push(`⭐ ${r.rating}${r.ratingCount ? ` (${r.ratingCount})` : ""}`);
  if (r.priceSymbol)  bits.push(r.priceSymbol);
  if (r.distanceText) bits.push(`📍 ${r.distanceText}`);
  if (r.todayHours)   bits.push(`🕐 ${r.todayHours}`);
  if (typeof r.openNow === "boolean") bits.push(r.openNow ? `${C.gr}פתוח עכשיו${C.r}` : `${C.re}סגור עכשיו${C.r}`);
  return bits.join("  ·  ");
}

async function searchFor(hotelId, item, lang) {
  const loc = configFor(hotelId).location;
  return places.searchNearby({
    query: item[lang], category: item.cat, lang,
    location: { lat: loc.lat, lng: loc.lng, timezone: loc.timezone },
    timeZone: loc.timezone, radius: loc.search_radius_m || 3000, limit: 2,
  });
}

// ── A. סוויפ קטגוריות מלא לכל מלון ──────────────────────
async function sweep() {
  console.log(`\n${C.ye}${C.b}${"═".repeat(70)}\n  A. סוויפ מלא — כל סוג בקשה, לכל מלון (מקומות אמיתיים מ-Google)\n${"═".repeat(70)}${C.r}`);
  let ok = 0, empty = 0, failed = 0;
  for (const h of SAMPLE_HOTELS) {
    const lang = localeFor(h.hotelId);
    const loc  = configFor(h.hotelId).location;
    console.log(`\n${C.cy}${C.b}🏨 ${h.label}${C.r}  ${C.dim}(${loc.address} · ${loc.timezone})${C.r}`);
    for (const item of CATEGORIES) {
      try {
        const res = await searchFor(h.hotelId, item, lang);
        if (res.ok && res.results.length) {
          ok++;
          console.log(`  ${C.gr}✓${C.r} ${item.label.padEnd(14)} → ${placeLine(res.results[0])}`);
        } else if (res.ok) {
          empty++;
          console.log(`  ${C.ye}∅${C.r} ${item.label.padEnd(14)} → אין תוצאות בגוגל באזור הזה`);
        } else {
          failed++;
          console.log(`  ${C.re}✗${C.r} ${item.label.padEnd(14)} → ${res.reason}`);
        }
      } catch (e) {
        failed++;
        console.log(`  ${C.re}✗${C.r} ${item.label.padEnd(14)} → ${e?.message || e}`);
      }
    }
  }
  console.log(`\n${C.b}סיכום סוויפ:${C.r} ${C.gr}${ok} עם תוצאות${C.r} · ${C.ye}${empty} ריקות${C.r} · ${C.re}${failed} כשלים${C.r}` +
    `  ${C.dim}(cache: ${places.stats.providerCalls} קריאות ספק, ${places.stats.hits} hits)${C.r}`);
}

// ── B. אזור זמן — "פתוח עכשיו" לפי השעון המקומי ─────────
async function tz() {
  console.log(`\n${C.ye}${C.b}${"═".repeat(70)}\n  B. אזור זמן — השעה המקומית ו"פתוח עכשיו" לכל מלון\n${"═".repeat(70)}${C.r}`);
  for (const h of SAMPLE_HOTELS) {
    const loc  = configFor(h.hotelId).location;
    const lang = localeFor(h.hotelId);
    const localTime = new Intl.DateTimeFormat("en-GB", { timeZone: loc.timezone, weekday: "long", hour: "2-digit", minute: "2-digit" }).format(new Date());
    const res = await searchFor(h.hotelId, { cat: "restaurant", he: "מסעדה", en: "restaurant" }, lang);
    const r = res.results?.[0];
    console.log(`  ${C.cy}${C.b}${h.label.padEnd(34)}${C.r} ${C.dim}${loc.timezone}${C.r}  🕰️ ${C.b}${localTime}${C.r}` +
      (r ? `   → ${r.name}: ${r.todayHours || "—"}  ${typeof r.openNow === "boolean" ? (r.openNow ? C.gr + "פתוח" + C.r : C.re + "סגור" + C.r) : ""}` : ""));
  }
}

// ── C. עומס — כל המלונות שואלים בו-זמנית, בלי ערבוב ─────
async function load() {
  console.log(`\n${C.ye}${C.b}${"═".repeat(70)}\n  C. עומס — כל המלונות שואלים דברים שונים בו-זמנית\n${"═".repeat(70)}${C.r}`);
  const before = { ...places.stats };
  const tasks = [];
  const GUESTS_PER_HOTEL = 40;
  for (const h of SAMPLE_HOTELS) {
    const lang = localeFor(h.hotelId);
    for (let g = 0; g < GUESTS_PER_HOTEL; g++) {
      const item = CATEGORIES[g % CATEGORIES.length];
      tasks.push(searchFor(h.hotelId, item, lang).then(res => ({ hotelId: h.hotelId, res })));
    }
  }
  const t0 = Date.now();
  const results = await Promise.all(tasks);
  const ms = Date.now() - t0;

  // אימות בידוד: כל תוצאה חייבת להיות קרובה למלון שממנו נשאלה (המרחק סביר).
  let crossMix = 0, errors = 0;
  for (const { hotelId, res } of results) {
    if (!res.ok) { if (res.reason !== "rate_limited") errors++; continue; }
    for (const p of res.results) {
      // אם מקום "קרוב" רחוק מ-60 ק"מ מהמלון — כנראה ערבוב מיקומים.
      const m = parseFloat(String(p.distanceText).replace(/[^\d.]/g, "")) * (/\bק"מ|km/.test(p.distanceText) ? 1000 : 1);
      if (m > 60000) crossMix++;
    }
  }
  const after = places.stats;
  console.log(`  שוגרו ${C.b}${tasks.length}${C.r} בקשות בו-זמנית מ-${SAMPLE_HOTELS.length} מלונות תוך ${C.b}${ms}ms${C.r}.`);
  console.log(`  ${crossMix === 0 ? C.gr + "✓ אין ערבוב מיקומים" : C.re + "✗ " + crossMix + " ערבובים"}${C.r} · ${errors === 0 ? C.gr + "✓ בלי קריסה/שגיאות" : C.re + "✗ " + errors + " שגיאות"}${C.r}`);
  console.log(`  ${C.dim}cache/מכסה: +${after.providerCalls - before.providerCalls} קריאות ספק · ${after.hits - before.hits} hits · ${after.coalesced - before.coalesced} מאוחדות · ${after.rateLimited - before.rateLimited} הוגבלו${C.r}`);
}

// ── D. שיחות AI מלאות — התשובה שהאורח מקבל בפועל ────────
async function ai() {
  if (!process.env.ANTHROPIC_API_KEY) { console.log(`\n${C.ye}דילוג על חלק D (AI): אין ANTHROPIC_API_KEY.${C.r}`); return; }
  console.log(`\n${C.ye}${C.b}${"═".repeat(70)}\n  D. שיחות AI אמיתיות — מה שהאורח מקבל בוואטסאפ\n${"═".repeat(70)}${C.r}`);
  const bot = await import("./bot.js");
  const probes = [
    { hotelId: "jerusalem", num: "+15550001002", text: "אני מחפש מסעדת בשר כשרה טובה קרוב למלון" },
    { hotelId: "eilat",     num: "+15550001003", text: "איפה יש בית מרקחת פתוח עכשיו?" },
    { hotelId: "nyc",       num: "+15550001005", text: "Where can I find a good vegan restaurant nearby?" },
    { hotelId: "london",    num: "+15550001006", text: "I need a pharmacy and an ATM near the hotel" },
  ];
  let phone = 972500000900;
  for (const p of probes) {
    const guest = `whatsapp:+${phone++}`;
    const h = SAMPLE_HOTELS.find(x => x.hotelId === p.hotelId);
    console.log(`\n${C.cy}${C.b}🏨 ${h.label}${C.r}`);
    console.log(`${C.cy}👤 האורח:${C.r} ${p.text}`);
    sent.length = 0;
    await bot.handleIncoming(guest, p.text, null, { to: p.num });
    const answer = sent.filter(s => s.to === guest).map(s => s.body).join("\n");
    console.log(`${C.gr}${C.b}🤖 הבוט:${C.r}\n${String(answer).split("\n").map(l => "   │ " + l).join("\n")}`);
  }
}

const t0 = Date.now();
if (mode === "sweep" || mode === "all") await sweep();
if (mode === "tz"    || mode === "all") await tz();
if (mode === "load"  || mode === "all") await load();
if (mode === "ai"    || mode === "all") await ai();
console.log(`\n${C.dim}סה"כ ${((Date.now() - t0) / 1000).toFixed(1)}s${C.r}\n`);
process.exit(0);
