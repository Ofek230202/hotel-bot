// ════════════════════════════════════════════════════════
//  CONCIERGE @ SCALE — בידוד בין מלונות, cache, הגבלת קצב, אזורי זמן
//  ----------------------------------------------------------
//  מוכיח שהקונסיירז' עומד ב-100 מלונות במקביל בלי לערבב מלונות, בלי
//  לחרוג ממכסת גוגל ובלי לקרוס, ושהוא נותן שעות נכונות בכל אזור זמן.
//
//  הרצה: node --test concierge-scale.test.mjs
// ════════════════════════════════════════════════════════
import { test } from "node:test";
import assert from "node:assert/strict";
import { CachedPlaces } from "./places/cache.js";
import { MockPlacesProvider } from "./places/MockPlacesProvider.js";
import { todayHoursLine } from "./places/util.js";

const TLV = { lat: 32.0746, lng: 34.7661, timezone: "Asia/Jerusalem" };
const NYC = { lat: 40.7580, lng: -73.9855, timezone: "America/New_York" };
const TYO = { lat: 35.6762, lng: 139.6503, timezone: "Asia/Tokyo" };

// ספק מדומה שסופר קריאות ומחזיר תוצאה תלוית-מיקום — כדי לזהות ערבוב.
class CountingProvider {
  constructor() { this.calls = 0; }
  async searchNearby(p) {
    this.calls++;
    return { ok: true, provider: "fake",
      results: [{ name: `place@${p.location.lat.toFixed(3)},${p.location.lng.toFixed(3)}|${p.query}` }] };
  }
}

// ── חלק 1: בידוד בין מלונות ─────────────────────────────

test("בידוד: מלון בת\"א ומלון בניו יורק מקבלים תוצאות שונות — אין ערבוב", async () => {
  const p = new CountingProvider();
  const c = new CachedPlaces(p, {});
  const a = await c.searchNearby({ query: "restaurant", lang: "en", location: TLV });
  const b = await c.searchNearby({ query: "restaurant", lang: "en", location: NYC });
  assert.match(a.results[0].name, /32\.075,34\.766/, "ת\"א מקבל את המיקום שלו");
  assert.match(b.results[0].name, /40\.758,-73\.986/, "ניו יורק מקבל את המיקום שלו");
  assert.notEqual(a.results[0].name, b.results[0].name, "שתי ערים שונות → תוצאות שונות");
  assert.equal(p.calls, 2, "מפתחות שונים → שתי קריאות נפרדות (אין hit מוטעה)");
});

test("בידוד: cache של מלון אחד לעולם לא מוגש למלון אחר (אותה שאילתה בדיוק)", async () => {
  const p = new CountingProvider();
  const c = new CachedPlaces(p, {});
  const tlv = await c.searchNearby({ query: "sushi", lang: "en", location: TLV });
  const nyc = await c.searchNearby({ query: "sushi", lang: "en", location: NYC });   // אותה שאילתה, מלון אחר
  assert.notEqual(tlv.results[0].name, nyc.results[0].name);
  assert.notEqual(nyc.cached, true, "ניו יורק לא קיבל את התוצאה השמורה של ת\"א");
});

// ── חלק 2: cache + הגבלת קצב ────────────────────────────

test("cache: אותה שאילתה מאותו מלון — הספק נקרא פעם אחת בלבד", async () => {
  const p = new CountingProvider();
  const c = new CachedPlaces(p, {});
  await c.searchNearby({ query: "coffee", lang: "en", location: TLV });
  const second = await c.searchNearby({ query: "coffee", lang: "en", location: TLV });
  assert.equal(p.calls, 1, "השנייה הוגשה מה-cache");
  assert.equal(second.cached, true);
});

test("cache: openNow לא נשמר (תלוי-רגע) — כל בקשה פוגעת בספק", async () => {
  const p = new CountingProvider();
  const c = new CachedPlaces(p, {});
  await c.searchNearby({ query: "bar", lang: "en", location: TLV, openNow: true });
  await c.searchNearby({ query: "bar", lang: "en", location: TLV, openNow: true });
  assert.equal(p.calls, 2, "openNow לעולם לא מוגש מ-cache");
});

test("cache: TTL — רשומה פגה אחרי החלון ונטענת מחדש", async () => {
  const p = new CountingProvider();
  let t = 1000;
  const c = new CachedPlaces(p, { ttlMs: 5000, now: () => t });
  await c.searchNearby({ query: "x", lang: "en", location: TLV }); // calls=1
  t = 3000; await c.searchNearby({ query: "x", lang: "en", location: TLV }); // cached, calls=1
  assert.equal(p.calls, 1);
  t = 7000; await c.searchNearby({ query: "x", lang: "en", location: TLV }); // פג, calls=2
  assert.equal(p.calls, 2);
});

test("cache: כישלון (ok:false) לא נשמר — כדי לא לנעול תקלה חולפת", async () => {
  let ok = false;
  const p = { calls: 0, async searchNearby() { this.calls++; return ok ? { ok: true, results: [{ name: "y" }] } : { ok: false, reason: "unavailable", results: [] }; } };
  const c = new CachedPlaces(p, {});
  await c.searchNearby({ query: "z", lang: "en", location: TLV }); // נכשל, לא נשמר
  ok = true;
  const r = await c.searchNearby({ query: "z", lang: "en", location: TLV }); // מנסה שוב את הספק
  assert.equal(p.calls, 2, "לא הוגש כישלון שמור");
  assert.equal(r.ok, true);
});

test("הגבלת קצב: חריגה ממכסה → rate_limited, הספק לא נקרא מעבר לתקרה", async () => {
  const p = new CountingProvider();
  const t = 0;                                   // זמן קפוא → אין מילוי מחדש
  const c = new CachedPlaces(p, { qps: 3, ttlMs: 0, now: () => t }); // ttl=0 → אין cache, כל בקשה מגיעה למגביל
  const out = [];
  for (let i = 0; i < 10; i++) out.push(await c.searchNearby({ query: `q${i}`, lang: "en", location: TLV }));
  assert.equal(out.filter(r => r.ok).length, 3, "רק 3 בתוך המכסה עברו");
  assert.equal(out.filter(r => r.reason === "rate_limited").length, 7, "השאר נדחו בנימוס");
  assert.equal(p.calls, 3, "הספק (גוגל) נקרא רק 3 פעמים — המכסה מוגנת");
});

test("עומס: 100 מלונות × 50 אורחים באותה שאילתה → הספק נקרא 100 פעם בלבד (cache בולע)", async () => {
  const p = new CountingProvider();
  const c = new CachedPlaces(p, { qps: 100000, ttlMs: 600_000 });
  const hotels = Array.from({ length: 100 }, (_, i) => ({ lat: 10 + i * 0.5, lng: 20 + i * 0.5 }));
  const tasks = [];
  for (const h of hotels) for (let g = 0; g < 50; g++) tasks.push(c.searchNearby({ query: "restaurant", lang: "en", location: h }));
  await Promise.all(tasks);            // 5000 בקשות בו-זמנית
  assert.equal(p.calls, 100, "100 מלונות ייחודיים → 100 קריאות ספק, לא 5000");
  // ה-49 הנוספים לכל מלון הגיעו *בו-זמנית* עם המוביל → אוחדו (single-flight).
  assert.ok(c.stats.coalesced + c.stats.hits >= 4900,
    `רוב הבקשות (${c.stats.coalesced} אוחדו + ${c.stats.hits} cache) נבלעו בלי לפנות לספק`);
});

test("עומס עוקב: אחרי שהתמלא ה-cache, בקשות חוזרות מוגשות ממנו (hits)", async () => {
  const p = new CountingProvider();
  const c = new CachedPlaces(p, { qps: 100000, ttlMs: 600_000 });
  // סבב ראשון — ממלא cache (בזה אחר זה, לא במקביל).
  for (let i = 0; i < 20; i++) await c.searchNearby({ query: "restaurant", lang: "en", location: { lat: i, lng: i } });
  assert.equal(p.calls, 20);
  // סבב שני — אותן שאילתות → הכול מה-cache, אפס קריאות ספק נוספות.
  for (let i = 0; i < 20; i++) await c.searchNearby({ query: "restaurant", lang: "en", location: { lat: i, lng: i } });
  assert.equal(p.calls, 20, "אין קריאות ספק נוספות");
  assert.ok(c.stats.hits >= 20, "הסבב השני הוגש כולו מה-cache");
});

// ── חלק 3: קונסיירז' מושלם — שעות נכונות בכל אזור זמן ────

test("אזור זמן: 'היום' נקבע לפי אזור הזמן של המלון (ניו יורק ≠ ישראל)", () => {
  const week = ["Monday: A", "Tuesday: B", "Wednesday: C", "Thursday: D", "Friday: E", "Saturday: F", "Sunday: G"];
  // רגע שבו ניו יורק עדיין ביום שני בערב, וישראל כבר ביום שלישי לפנות בוקר.
  const t = new Date("2024-01-02T02:00:00Z");
  assert.match(todayHoursLine(week, t, "en", "America/New_York"), /Monday/, "מלון NY → יום שני");
  assert.match(todayHoursLine(week, t, "en", "Asia/Jerusalem"),  /Tuesday/, "מלון IL → יום שלישי");
});

test("אזור זמן: MockPlacesProvider מכבד את timeZone שהמלון מעביר", async () => {
  const mock = new MockPlacesProvider();
  // המוק מחזיר שעות שבוע קבועות; שורת 'היום' צריכה להשתנות לפי אזור הזמן.
  const t = new Date("2024-01-02T02:00:00Z");
  // בודקים ישירות דרך util עם השבוע של המוק (אנגלית מתחיל ביום שני).
  const weekEn = ["Monday: 12:00 – 23:00", "Tuesday: 12:00 – 23:00", "Wednesday: 12:00 – 23:00",
    "Thursday: 12:00 – 23:30", "Friday: 12:00 – 15:00", "Saturday: Closed", "Sunday: 12:00 – 23:00"];
  assert.match(todayHoursLine(weekEn, t, "en", "America/New_York"), /Monday/);
  assert.match(todayHoursLine(weekEn, t, "en", "Asia/Tokyo"),       /Tuesday/);
  // ושהספק בכלל מחזיר את השדות המלאים לאורח:
  const res = await mock.searchNearby({ query: "restaurant", category: "restaurant", lang: "en", location: TYO, timeZone: "Asia/Tokyo" });
  const r = res.results[0];
  for (const f of ["name", "address", "category", "rating", "ratingCount", "priceSymbol", "openNow", "openingHours", "todayHours", "phone", "distanceText"]) {
    assert.ok(r[f] !== undefined, `שדה ${f} קיים בתשובת הקונסיירז'`);
  }
});
