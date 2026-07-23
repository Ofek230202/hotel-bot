// ════════════════════════════════════════════════════════
//  יחידה — שכבת places/ (Google Places + מוק + עזרים)
//  ----------------------------------------------------------
//  בודק את הספק המדומה, את עזרי החישוב/הפורמט, ואת הספק האמיתי מול
//  fetch מזויף — בלי רשת אמיתית ובלי מפתח אמיתי.
// ════════════════════════════════════════════════════════
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { haversineMeters, distanceText, priceLevelInfo, todayHoursLine } from "./places/util.js";
import { MockPlacesProvider } from "./places/MockPlacesProvider.js";
import { GooglePlacesProvider } from "./places/GooglePlacesProvider.js";
import { PLACE_CATEGORIES } from "./places/PlacesProvider.js";

const HOTEL = { lat: 32.0743, lng: 34.7664, address: "Demo Hotel" };

// ── עזרים ──────────────────────────────────────────────
test("haversine: מרחק בין שתי נקודות קרובות סביר (~מאות מטרים)", () => {
  const m = haversineMeters({ lat: 32.0743, lng: 34.7664 }, { lat: 32.0800, lng: 34.7664 });
  // ~0.0057° קו רוחב ≈ 630 מ׳
  assert.ok(m > 500 && m < 750, `got ${m}`);
});

test("haversine: קלט חסר → null", () => {
  assert.equal(haversineMeters(null, HOTEL), null);
  assert.equal(haversineMeters({ lat: 1 }, HOTEL), null);
});

test("distanceText: מטרים מול ק״מ, עברית ואנגלית", () => {
  assert.match(distanceText(320, "he"), /מ׳/);
  assert.match(distanceText(320, "en"), /m$/);
  assert.match(distanceText(2400, "he"), /ק״מ/);
  assert.match(distanceText(2400, "en"), /km$/);
});

test("priceLevelInfo: enum של Google → סמלי ₪", () => {
  assert.equal(priceLevelInfo("PRICE_LEVEL_MODERATE").symbol, "₪₪");
  assert.equal(priceLevelInfo("PRICE_LEVEL_VERY_EXPENSIVE").symbol, "₪₪₪₪");
  assert.equal(priceLevelInfo(null), null);
  assert.equal(priceLevelInfo(3).symbol, "₪₪₪"); // גם מספר נתמך
});

// ── MockPlacesProvider ─────────────────────────────────
test("mock: מחזיר תוצאות ממוינות לפי מרחק, עם השדות שהבוט צריך", async () => {
  const mock = new MockPlacesProvider();
  const res = await mock.searchNearby({ query: "restaurant", category: "restaurant", lang: "he", location: HOTEL });
  assert.equal(res.ok, true);
  assert.ok(res.results.length >= 2);
  // ממוין: הקרוב ביותר קודם
  for (let i = 1; i < res.results.length; i++) {
    assert.ok(res.results[i].distanceMeters >= res.results[i - 1].distanceMeters);
  }
  const r = res.results[0];
  for (const k of ["name", "address", "category", "rating", "distanceText"]) {
    assert.ok(k in r, `missing ${k}`);
  }
});

test("mock: משקף את מילת הבקשה (כשר) — הבקשה המדויקת נשמרת", async () => {
  const mock = new MockPlacesProvider();
  const res = await mock.searchNearby({ query: "meat", keyword: "kosher", category: "restaurant", lang: "en", location: HOTEL });
  assert.match(res.results[0].name, /kosher/i);
});

test("mock: אין מיקום → ok=false, reason=no_location", async () => {
  const mock = new MockPlacesProvider();
  const res = await mock.searchNearby({ query: "x", lang: "he", location: null });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_location");
});

// ── GooglePlacesProvider (fetch מזויף) ─────────────────
const realFetch = globalThis.fetch;
let fetchCalls = [];
function stubFetch(impl) {
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return impl(url, opts);
  };
}
beforeEach(() => { fetchCalls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

function googleOkResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      places: [
        {
          displayName: { text: "HaEsh Grill" },
          formattedAddress: "12 Herbert Samuel St, Tel Aviv",
          rating: 4.6,
          userRatingCount: 1240,
          priceLevel: "PRICE_LEVEL_EXPENSIVE",
          currentOpeningHours: { openNow: true },
          location: { latitude: 32.0800, longitude: 34.7664 },
          primaryTypeDisplayName: { text: "Steak house" },
          googleMapsUri: "https://maps.google.com/?cid=1",
        },
      ],
    }),
  };
}

test("google: אין מפתח → no_api_key, ולא נגענו ברשת", async () => {
  const g = new GooglePlacesProvider(undefined);
  stubFetch(() => googleOkResponse());
  const res = await g.searchNearby({ query: "x", location: HOTEL });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_api_key");
  assert.equal(fetchCalls.length, 0);
});

test("google: אין מיקום → no_location", async () => {
  const g = new GooglePlacesProvider("KEY");
  const res = await g.searchNearby({ query: "x", location: null });
  assert.equal(res.reason, "no_location");
});

test("google: בונה בקשה נכונה — מפתח בכותרת, FieldMask, textQuery מאחד query+keyword, includedType, locationBias", async () => {
  const g = new GooglePlacesProvider("SECRET-KEY");
  stubFetch(() => googleOkResponse());
  await g.searchNearby({ query: "meat restaurant", keyword: "kosher", category: "restaurant", lang: "he", location: HOTEL, radius: 3000 });

  assert.equal(fetchCalls.length, 1);
  const { url, opts } = fetchCalls[0];
  assert.match(url, /places:searchText/);
  assert.equal(opts.method, "POST");
  assert.equal(opts.headers["X-Goog-Api-Key"], "SECRET-KEY");
  assert.ok(opts.headers["X-Goog-FieldMask"].includes("places.displayName"));

  const body = JSON.parse(opts.body);
  assert.equal(body.textQuery, "meat restaurant kosher"); // query + keyword
  assert.equal(body.includedType, "restaurant");          // מקטגוריה
  assert.equal(body.languageCode, "he");
  assert.equal(body.locationBias.circle.center.latitude, 32.0743);
  assert.equal(body.locationBias.circle.radius, 3000);
});

test("google: המפתח לעולם לא בגוף הבקשה (רק בכותרת)", async () => {
  const g = new GooglePlacesProvider("SECRET-KEY");
  stubFetch(() => googleOkResponse());
  await g.searchNearby({ query: "x", location: HOTEL });
  const body = fetchCalls[0].opts.body;
  assert.ok(!body.includes("SECRET-KEY"), "API key leaked into request body");
});

test("google: מנרמל תשובה — שם, דירוג, מחיר, מרחק מחושב", async () => {
  const g = new GooglePlacesProvider("KEY");
  stubFetch(() => googleOkResponse());
  const res = await g.searchNearby({ query: "meat", lang: "en", location: HOTEL });
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 1);
  const r = res.results[0];
  assert.equal(r.name, "HaEsh Grill");
  assert.equal(r.rating, 4.6);
  assert.equal(r.ratingCount, 1240);
  assert.equal(r.priceSymbol, "₪₪₪");
  assert.equal(r.openNow, true);
  assert.ok(r.distanceMeters > 500 && r.distanceMeters < 750); // ~630 מ׳
  assert.match(r.distanceText, /m$/);
});

test("google: HTTP 500 → ok=false, unavailable (לא קורס, לא ממציא)", async () => {
  const g = new GooglePlacesProvider("KEY");
  stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
  const res = await g.searchNearby({ query: "x", location: HOTEL });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unavailable");
});

test("google: HTTP 429 → rate_limited", async () => {
  const g = new GooglePlacesProvider("KEY");
  stubFetch(() => ({ ok: false, status: 429, json: async () => ({}) }));
  const res = await g.searchNearby({ query: "x", location: HOTEL });
  assert.equal(res.reason, "rate_limited");
});

test("google: רשת נפלה (fetch זורק) → unavailable, לא זורק החוצה", async () => {
  const g = new GooglePlacesProvider("KEY");
  stubFetch(() => { throw new Error("network down"); });
  const res = await g.searchNearby({ query: "x", location: HOTEL });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unavailable");
});

test("google: אפס תוצאות → ok=true עם רשימה ריקה (הבוט יאמר 'אבדוק ואחזור')", async () => {
  const g = new GooglePlacesProvider("KEY");
  stubFetch(() => ({ ok: true, status: 200, json: async () => ({ places: [] }) }));
  const res = await g.searchNearby({ query: "x", location: HOTEL });
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 0);
});

// ── שעות פתיחה — הנתון שהיה חסר בבדיקה החיה ────────────
// הבוט המליץ על מסעדות בלי שעות, וכשאורח שאל "עד איזו שעה פתוח?" ענה
// "אין לי מידע מדויק" — בזמן שגוגל יודע. השעות נמשכות עכשיו במפורש.
const WEEK_EN = [
  "Monday: 12:00 – 23:00", "Tuesday: 12:00 – 23:00", "Wednesday: 12:00 – 23:00",
  "Thursday: 12:00 – 23:30", "Friday: 12:00 – 15:00", "Saturday: Closed",
  "Sunday: 12:00 – 23:00",
];

// 🔴 סדר הימים של Google *תלוי בשפה*: באנגלית השבוע מתחיל ביום שני,
//    בעברית ביום ראשון. זה נתפס בבדיקה חיה עם מפתח אמיתי — מסעדה קיבלה
//    "יום שני" בזמן שהיום היה שלישי, כלומר שעות של יום אחר לגמרי.
const WEEK_HE = [
  "יום ראשון: סגור", "יום שני: 12:00–23:00", "יום שלישי: 12:00–23:00",
  "יום רביעי: 12:00–23:00", "יום חמישי: 12:00–23:00",
  "יום שישי: 11:00–16:00, 18:00–22:00", "יום שבת: 12:00–22:00",
];

test("todayHoursLine: היום נגזר לפי שעון ישראל ולפי *שם היום*, לא לפי אינדקס", () => {
  // 20/07/2026 הוא יום שני; 21/07 שלישי; 25/07 שבת.
  assert.equal(todayHoursLine(WEEK_EN, new Date("2026-07-20T09:00:00Z"), "en"), "Monday: 12:00 – 23:00");
  assert.equal(todayHoursLine(WEEK_EN, new Date("2026-07-25T09:00:00Z"), "en"), "Saturday: Closed");
  // 23:30 UTC ביום ראשון הוא כבר *יום שני* בישראל (UTC+3) — וזה מה שנמסר לאורח.
  assert.equal(todayHoursLine(WEEK_EN, new Date("2026-07-19T22:30:00Z"), "en"), "Monday: 12:00 – 23:00");

  // ── התרחיש שנשבר בשטח: עברית, שבוע שמתחיל בראשון ──
  assert.equal(todayHoursLine(WEEK_HE, new Date("2026-07-21T09:00:00Z"), "he"), "יום שלישי: 12:00–23:00");
  assert.equal(todayHoursLine(WEEK_HE, new Date("2026-07-19T09:00:00Z"), "he"), "יום ראשון: סגור");
  assert.equal(todayHoursLine(WEEK_HE, new Date("2026-07-24T09:00:00Z"), "he"), "יום שישי: 11:00–16:00, 18:00–22:00");

  // שפה שלא תואמת לתוצאה — עדיין מוצאים את היום הנכון (נסיגה לשפה השנייה).
  assert.equal(todayHoursLine(WEEK_HE, new Date("2026-07-21T09:00:00Z"), "en"), "יום שלישי: 12:00–23:00");
  assert.equal(todayHoursLine(WEEK_EN, new Date("2026-07-21T09:00:00Z"), "he"), "Tuesday: 12:00 – 23:00");

  // רשימה חסרה/ריקה או פורמט לא מזוהה → null, אף פעם לא ניחוש.
  assert.equal(todayHoursLine(null), null);
  assert.equal(todayHoursLine(["Monday: 12:00 – 23:00"]), null);
  assert.equal(todayHoursLine(["1", "2", "3", "4", "5", "6", "7"], new Date(), "he"), null);
});

test("google: FieldMask מבקש שעות פתיחה, טלפון ואתר", () => {
  // בלי השדות האלה במסכה גוגל פשוט לא מחזיר אותם — וזה היה שורש
  // התשובה "אין לי מידע על שעות".
  const g = new GooglePlacesProvider("KEY");
  stubFetch(() => googleOkResponse());
  return g.searchNearby({ query: "x", location: HOTEL }).then(() => {
    const mask = fetchCalls[0].opts.headers["X-Goog-FieldMask"];
    assert.ok(mask.includes("currentOpeningHours.weekdayDescriptions"), "שעות השבוע הנוכחי");
    assert.ok(mask.includes("regularOpeningHours.weekdayDescriptions"), "שעות רגילות כגיבוי");
    assert.ok(mask.includes("nationalPhoneNumber"), "טלפון");
    assert.ok(mask.includes("websiteUri"), "אתר");
  });
});

test("google: שעות השבוע ושורת 'היום' מנורמלות מהתשובה", async () => {
  const g = new GooglePlacesProvider("KEY");
  stubFetch(() => ({
    ok: true, status: 200,
    json: async () => ({
      places: [{
        displayName: { text: "HaEsh Grill" },
        formattedAddress: "12 Herbert Samuel St, Tel Aviv",
        rating: 4.6, userRatingCount: 1240,
        currentOpeningHours: { openNow: true, weekdayDescriptions: WEEK_EN },
        regularOpeningHours: { weekdayDescriptions: ["x", "x", "x", "x", "x", "x", "x"] },
        nationalPhoneNumber: "03-123-4567",
        websiteUri: "https://example.co.il",
        location: { latitude: 32.08, longitude: 34.7664 },
        primaryTypeDisplayName: { text: "Steak house" },
      }],
    }),
  }));

  const r = (await g.searchNearby({ query: "meat", lang: "en", location: HOTEL })).results[0];
  assert.deepEqual(r.openingHours, WEEK_EN, "שעות השבוע הנוכחי גוברות על ה'רגילות'");
  assert.ok(r.todayHours.startsWith(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", weekday: "long" }).format(new Date())));
  assert.equal(r.phone, "03-123-4567");
  assert.equal(r.website, "https://example.co.il");
  assert.equal(r.category, "Steak house", "סוג המקום/המטבח");
});

test("google: מקום בלי שעות → openingHours ו-todayHours הם null (בלי המצאה)", async () => {
  const g = new GooglePlacesProvider("KEY");
  stubFetch(() => googleOkResponse()); // אין weekdayDescriptions בתשובה
  const r = (await g.searchNearby({ query: "x", lang: "en", location: HOTEL })).results[0];
  assert.equal(r.openingHours, null);
  assert.equal(r.todayHours, null);
  assert.equal(r.phone, null);
});

test("mock: מחזיר בדיוק את אותם שדות כמו הספק האמיתי — כולל שעות", async () => {
  const mock = new MockPlacesProvider();
  const r = (await mock.searchNearby({ query: "restaurant", category: "restaurant", lang: "he", location: HOTEL })).results[0];
  for (const k of ["openingHours", "todayHours", "phone", "openNow"]) {
    assert.ok(k in r, `missing ${k} — המוק והספק האמיתי חייבים להיראות זהים לבוט`);
  }
  assert.equal(r.openingHours.length, 7);
  assert.ok(r.todayHours, "יש שורת שעות להיום");
  // ובאמת *היום*, ולא יום שכן — זה הבאג שנתפס מול Google האמיתי.
  const heToday = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", weekday: "long" }).format(new Date());
  assert.ok(r.todayHours.startsWith(heToday), `שורת השעות היא של ${r.todayHours} במקום ${heToday}`);
});

test("PLACE_CATEGORIES: קטגוריות המפתח ממופות ל-includedType של Google", () => {
  assert.equal(PLACE_CATEGORIES.restaurant, "restaurant");
  assert.equal(PLACE_CATEGORIES.attraction, "tourist_attraction");
  assert.equal(PLACE_CATEGORIES.nightlife, "night_club");
});

// ── מפתח פסול מול תקלה חולפת (smoke-check בהפעלה) ──────
// הבחנה קריטית: 400/403 = תקלת *הגדרות* שלא תתקן את עצמה (מפתח שגוי /
// Places API (New) לא מופעל / מפתח מוגבל). 429/500/רשת = תקלה *חולפת*.
// בלי ההפרדה הזו, smoke-check לא יכול לדעת מתי לצעוק ומתי רק להזהיר.
test("google: HTTP 400 (בלי includedType) → invalid_key (תקלת הגדרות קבועה)", async () => {
  const g = new GooglePlacesProvider("BAD_KEY");
  stubFetch(() => ({ ok: false, status: 400, json: async () => ({}) }));
  const res = await g.searchNearby({ query: "x", location: HOTEL }); // בלי category
  assert.equal(res.ok, false);
  assert.equal(res.reason, "invalid_key");
});

test("עמידות: 400 עם includedType → ניסיון שני *בלי* הסינון, מחזיר תוצאות", async () => {
  const g = new GooglePlacesProvider("KEY");
  let call = 0;
  stubFetch(() => {
    call++;
    // ניסיון ראשון (עם includedType) נכשל ב-400; השני (בלי) מצליח.
    return call === 1 ? { ok: false, status: 400, json: async () => ({}) } : googleOkResponse();
  });
  const res = await g.searchNearby({ query: "veterinarian", category: "vet", location: HOTEL });
  assert.equal(res.ok, true, "התאושש דרך טקסט חופשי");
  assert.ok(res.results.length >= 1);
  assert.equal(fetchCalls.length, 2, "בדיוק שני ניסיונות");
  assert.ok(JSON.parse(fetchCalls[0].opts.body).includedType, "הראשון כלל includedType");
  assert.ok(!JSON.parse(fetchCalls[1].opts.body).includedType, "השני בלי includedType");
});

test("עמידות: 400 עם includedType שגם השני נכשל → invalid_key (מפתח באמת פסול)", async () => {
  const g = new GooglePlacesProvider("BAD_KEY");
  stubFetch(() => ({ ok: false, status: 400, json: async () => ({}) }));
  const res = await g.searchNearby({ query: "x", category: "vet", location: HOTEL });
  assert.equal(res.reason, "invalid_key", "כשגם הניסיון בלי הסינון נכשל — זו תקלת מפתח אמיתית");
  assert.equal(fetchCalls.length, 2);
});

test("קטגוריות: המפה מכסה מגוון רחב (מסעדה עד וטרינר/כספומט/מספרה)", () => {
  for (const k of ["restaurant", "cafe", "bar", "pharmacy", "atm", "bank", "vet", "dentist",
    "hair_salon", "nail_salon", "gym", "supermarket", "laundry", "gas_station", "car_repair",
    "florist", "gift", "museum", "art_gallery", "theater", "movie_theater", "park", "spa"]) {
    assert.ok(PLACE_CATEGORIES[k], `קטגוריה חסרה: ${k}`);
  }
});

test("google: HTTP 403 → invalid_key (API לא מופעל / מפתח מוגבל)", async () => {
  const g = new GooglePlacesProvider("BAD_KEY");
  stubFetch(() => ({ ok: false, status: 403, json: async () => ({}) }));
  const res = await g.searchNearby({ query: "x", location: HOTEL });
  assert.equal(res.reason, "invalid_key");
});

test("google: 429/500 נשארים תקלה חולפת — לא מסומנים כמפתח פסול", async () => {
  const g = new GooglePlacesProvider("KEY");
  stubFetch(() => ({ ok: false, status: 429, json: async () => ({}) }));
  assert.equal((await g.searchNearby({ query: "x", location: HOTEL })).reason, "rate_limited");
  stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
  assert.equal((await g.searchNearby({ query: "x", location: HOTEL })).reason, "unavailable");
});

// ── smoke-check בהפעלה ─────────────────────────────────
// המפתח נקרא ב-import time, לכן מגדירים אותו לפני הייבוא הדינמי.
// מגדירים זמנית ומשחזרים מיד אחרי הייבוא — אחרת שאר הבדיקות בקובץ
// (שבונות GooglePlacesProvider בלי ארגומנט) יראו מפתח ויישברו.
const _savedKey  = process.env.GOOGLE_PLACES_API_KEY;
const _savedForce = process.env.PLACES_PROVIDER;
process.env.GOOGLE_PLACES_API_KEY = "SMOKE_TEST_KEY";
delete process.env.PLACES_PROVIDER;
const { smokePlaces } = await import("./places/index.js");
if (_savedKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY; else process.env.GOOGLE_PLACES_API_KEY = _savedKey;
if (_savedForce !== undefined) process.env.PLACES_PROVIDER = _savedForce;

// לוכד console כדי לוודא שהכשל באמת *רועש* ולא נבלע.
function captureConsole(fn) {
  const logs = [];
  const [e, w, l] = [console.error, console.warn, console.log];
  console.error = (...a) => logs.push(["error", a.join(" ")]);
  console.warn  = (...a) => logs.push(["warn",  a.join(" ")]);
  console.log   = (...a) => logs.push(["log",   a.join(" ")]);
  return fn().finally(() => { console.error = e; console.warn = w; console.log = l; })
             .then(r => ({ result: r, logs }));
}

test("smoke-check: מפתח תקין → עובר ומדווח בלוג", async () => {
  stubFetch(() => ({ ok: true, status: 200, json: async () => ({
    places: [{ displayName: { text: "Some Cafe" }, formattedAddress: "St 1", location: { latitude: 32.075, longitude: 34.767 } }],
  }) }));
  const { result, logs } = await captureConsole(() => smokePlaces(HOTEL));
  assert.equal(result.ok, true);
  assert.match(logs.map(l => l[1]).join("\n"), /smoke-check עבר/);
});

test("smoke-check: מפתח פסול → שגיאה רועשת עם מה לבדוק (לא אזהרה שקטה)", async () => {
  stubFetch(() => ({ ok: false, status: 400, json: async () => ({}) }));
  const { result, logs } = await captureConsole(() => smokePlaces(HOTEL));
  assert.equal(result.reason, "invalid_key");
  const errors = logs.filter(l => l[0] === "error").map(l => l[1]).join("\n");
  assert.match(errors, /המפתח נדחה/, "הכשל חייב להופיע כשגיאה, לא כאזהרה");
  assert.match(errors, /Places API \(New\)/, "חייב להסביר מה לבדוק");
  assert.doesNotMatch(errors, /SMOKE_TEST_KEY/, "🔴 המפתח דלף ללוג");
});

test("smoke-check: תקלה חולפת → אזהרה בלבד, בלי להקים רעש על מפתח", async () => {
  stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
  const { result, logs } = await captureConsole(() => smokePlaces(HOTEL));
  assert.equal(result.reason, "unavailable");
  // הספק עצמו מדפיס שורת סטטוס — לגיטימי. מה שאסור הוא בלוק "המפתח נדחה".
  const errors = logs.filter(l => l[0] === "error").map(l => l[1]).join("\n");
  assert.doesNotMatch(errors, /המפתח נדחה/, "תקלה חולפת סומנה בטעות כמפתח פסול");
  assert.match(logs.map(l => l[1]).join("\n"), /חולפת/);
});

test("smoke-check: רשת נפלה → לא זורק ולא מפיל את השרת", async () => {
  stubFetch(() => { throw new Error("network down"); });
  const { result } = await captureConsole(() => smokePlaces(HOTEL));
  assert.equal(result.ok, false);
});

test("smoke-check: אין קואורדינטות → דילוג מסודר", async () => {
  const { result } = await captureConsole(() => smokePlaces(null));
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "no_location");
});
