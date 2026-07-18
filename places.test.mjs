// ════════════════════════════════════════════════════════
//  יחידה — שכבת places/ (Google Places + מוק + עזרים)
//  ----------------------------------------------------------
//  בודק את הספק המדומה, את עזרי החישוב/הפורמט, ואת הספק האמיתי מול
//  fetch מזויף — בלי רשת אמיתית ובלי מפתח אמיתי.
// ════════════════════════════════════════════════════════
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { haversineMeters, distanceText, priceLevelInfo } from "./places/util.js";
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

test("PLACE_CATEGORIES: קטגוריות המפתח ממופות ל-includedType של Google", () => {
  assert.equal(PLACE_CATEGORIES.restaurant, "restaurant");
  assert.equal(PLACE_CATEGORIES.attraction, "tourist_attraction");
  assert.equal(PLACE_CATEGORIES.nightlife, "night_club");
});
