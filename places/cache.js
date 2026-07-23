// ════════════════════════════════════════════════════════
//  CachedPlaces — cache + הגבלת קצב מעל כל ספק מקומות
//  ----------------------------------------------------------
//  היעד: 100 מלונות × אלפי אורחים ששואלים על מסעדות בו-זמנית, בלי
//  לחרוג ממכסת Google ובלי לקרוס. עוטף כל PlacesProvider (Google/mock)
//  ומיישם את אותו ממשק `searchNearby`, כך שהבוט לא יודע שיש כאן cache.
//
//  שתי הגנות, מסודרות לפי סדר:
//   1. CACHE (TTL): אותה שאילתה, מאותו מיקום (מעוגל ל~100 מ׳), באותה שפה —
//      מוגשת מהזיכרון בלי לגעת ב-Google. חלון קצר (10 דק׳ ברירת מחדל) כי
//      דירוג/כתובת יציבים, אבל שעות משתנות. **`openNow` לא נשמר ב-cache** —
//      הוא תלוי-רגע, וקאשינג שלו היה מחזיר "פתוח" על מקום סגור.
//   2. RATE LIMIT (token bucket גלובלי): תקרת קריאות לשנייה ל-Google, כדי
//      שפרץ עומס לא יחרוג מהמכסה. חריגה → reason:"rate_limited" (הבוט כבר
//      יודע לטפל: retry/backoff ואז "אבדוק ואחזור"). cache-hit לא נספר
//      במכסה — בדיוק הנקודה: העומס נבלע ב-cache ולא מגיע ל-Google.
//
//  מפתח ה-cache כולל את מיקום המלון המעוגל — ולכן **אין ערבוב בין מלונות**:
//  מלון בתל אביב ומלון בניו יורק מקבלים מפתחות שונים ותוצאות שונות.
//
//  הכול בזיכרון התהליך (כמו concurrency.js). לריבוי מכונות — cache משותף
//  (Redis) באותו רעיון; נקודת ההחלפה כאן. ראה SCALING.md.
// ════════════════════════════════════════════════════════
import { createRateLimiter } from "../concurrency.js";

const DEFAULT_TTL_MS  = Number(process.env.PLACES_CACHE_TTL_MS) || 600_000; // 10 דק׳
const DEFAULT_MAX      = Number(process.env.PLACES_CACHE_MAX) || 5000;
const DEFAULT_QPS      = Number(process.env.GOOGLE_PLACES_QPS) || 50;

export class CachedPlaces {
  constructor(provider, { ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX, qps = DEFAULT_QPS, now } = {}) {
    this.provider   = provider;
    this.ttlMs      = ttlMs;
    this.maxEntries = maxEntries;
    this.now        = now || (() => Date.now());
    // דלי אסימונים גלובלי לספק (מפתח קבוע "places"): capacity=refill=qps →
    // עד qps קריאות בשנייה, מתחדש ברציפות.
    this.limiter    = createRateLimiter({ capacity: qps, refillPerSec: qps });
    this.cache      = new Map();
    // single-flight: בקשות זהות שמגיעות *בו-זמנית* חולקות קריאה אחת לספק
    // (לפני שה-cache הספיק להתמלא). זה מה שמונע "עדר רועם" — 500 אורחים
    // שמבקשים "מסעדות" באותו רגע לא פותחים 500 קריאות ל-Google, אלא אחת.
    this.inflight   = new Map();
    this.stats      = { hits: 0, misses: 0, coalesced: 0, providerCalls: 0, rateLimited: 0, stored: 0, evicted: 0 };
  }

  get providerName() {
    return this.provider?.constructor?.name?.toLowerCase().includes("google") ? "google" : "mock";
  }

  // מפתח דטרמיניסטי: מיקום מעוגל (~100 מ׳) + שפה + קטגוריה + keyword +
  // שאילתה מנורמלת + רדיוס. עיגול המיקום מבטיח בידוד מלונות ומיזוג שאילתות
  // כמעט-זהות סביב אותו מלון.
  key({ query, category, keyword, lang, location, radius } = {}) {
    const lat = location?.lat != null ? Number(location.lat).toFixed(3) : "?";
    const lng = location?.lng != null ? Number(location.lng).toFixed(3) : "?";
    const q   = String(query || "").trim().toLowerCase().replace(/\s+/g, " ");
    const kw  = String(keyword || "").trim().toLowerCase();
    const cat = category || "";
    const l   = lang === "he" ? "he" : "en";
    const r   = radius || "";
    return [lat, lng, l, cat, kw, q, r].join("|");
  }

  async searchNearby(params = {}) {
    const now = this.now();
    // openNow תלוי-רגע → לא נכנס/יוצא מה-cache (רק rate-limit).
    const cacheable = !params.openNow;
    const k = cacheable ? this.key(params) : null;

    if (cacheable) {
      const hit = this.#get(k, now);
      if (hit) { this.stats.hits++; return { ...hit, cached: true }; }
      // בקשה זהה כבר בטיסה? מצטרפים אליה במקום לפתוח קריאה נוספת לספק.
      const flying = this.inflight.get(k);
      if (flying) {
        this.stats.coalesced++;
        const r = await flying;
        return r && r.ok ? { ...r, cached: true } : r;
      }
      this.stats.misses++;
    }

    // הגנת מכסה: cache-hit ובקשות מאוחדות כבר חזרו למעלה בלי לצרוך אסימון.
    // רק ה"מוביל" של כל שאילתה ייחודית מגיע לכאן וצורך מהמכסה.
    if (!this.limiter("places", now)) {
      this.stats.rateLimited++;
      return { ok: false, results: [], reason: "rate_limited", provider: this.providerName };
    }

    this.stats.providerCalls++;
    const promise = (async () => {
      const res = await this.provider.searchNearby(params);
      // שומרים רק תוצאות תקינות (ok=true). כישלון/היעדר תוצאות לא נשמר —
      // כדי לא "לנעול" תקלה חולפת ל-10 דקות.
      if (cacheable && res && res.ok) this.#set(k, res, this.now());
      return res;
    })();

    if (cacheable) {
      this.inflight.set(k, promise);
      // מנקים את רשומת ה-inflight בסיום, בהצלחה או בכישלון.
      promise.then(() => {}, () => {}).finally(() => {
        if (this.inflight.get(k) === promise) this.inflight.delete(k);
      });
    }
    return promise;
  }

  #get(k, now) {
    const e = this.cache.get(k);
    if (!e) return null;
    if (e.exp <= now) { this.cache.delete(k); return null; }
    return e.val;
  }

  #set(k, val, now) {
    this.cache.set(k, { val, exp: now + this.ttlMs });
    this.stats.stored++;
    // תקרת גודל: מפנים את הישן ביותר (Map שומר סדר הכנסה) כדי למנוע דליפה.
    while (this.cache.size > this.maxEntries) {
      const first = this.cache.keys().next().value;
      this.cache.delete(first);
      this.stats.evicted++;
    }
  }

  // ניקוי רשומות שפג תוקפן (אופציונלי, לתחזוקה מחזורית).
  sweep(now = this.now()) {
    let removed = 0;
    for (const [k, e] of this.cache) if (e.exp <= now) { this.cache.delete(k); removed++; }
    return removed;
  }

  size() { return this.cache.size; }
}
