// ════════════════════════════════════════════════════════
//  GooglePlacesProvider — הספק האמיתי: Google Places API (New)
//  ----------------------------------------------------------
//  משתמש ב-Text Search (New): POST places.googleapis.com/v1/places:searchText.
//  למה Text Search ולא Nearby: הוא מקבל שאילתת טקסט חופשי ("kosher meat
//  restaurant") ומכבד אותה מילה במילה — בדיוק מה שצריך כדי לכבד בקשה
//  מדויקת (בשרי / כשר / טבעוני / סושי), לצד locationBias סביב המלון.
//
//  🔑 המפתח נקרא מ-process.env.GOOGLE_PLACES_API_KEY — *אף פעם* לא נכתב
//     בקוד, לא מודפס ללוג, ולא מוחזר לאורח. עובר רק בכותרת הבקשה ל-Google.
//
//  אין תלות חיצונית: fetch מובנה ב-Node 18+. שגיאה/רשת/תשובה פגומה →
//  { ok:false, reason } — הבוט אומר לאורח שיבדוק ויחזור, לא קורס ולא ממציא.
// ════════════════════════════════════════════════════════
import { PlacesProvider, PLACE_CATEGORIES } from "./PlacesProvider.js";
import { haversineMeters, distanceText, priceLevelInfo, formatRating } from "./util.js";

const SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";

// רק השדות שאנחנו באמת מציגים — FieldMask הדוק חוסך עלות וזמן ומונע
// משיכת מידע מיותר. כל שדה כאן חייב להופיע גם ב-normalizePlace למטה.
const FIELD_MASK = [
  "places.displayName",
  "places.formattedAddress",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.currentOpeningHours.openNow",
  "places.location",
  "places.primaryTypeDisplayName",
  "places.googleMapsUri",
].join(",");

const DEFAULT_RADIUS_M = 4000;   // רדיוס חיפוש ברירת מחדל (מטרים)
const DEFAULT_LIMIT    = 6;      // תוצאות מרביות
const REQUEST_TIMEOUT  = 8000;   // מפסיקים בקשה תקועה כדי לא לתקוע את הבוט

export class GooglePlacesProvider extends PlacesProvider {
  constructor(apiKey = process.env.GOOGLE_PLACES_API_KEY) {
    super();
    // שומרים את המפתח בשדה פרטי ולא חושפים אותו בשום getter/לוג.
    this.#apiKey = apiKey;
  }
  #apiKey;

  get hasKey() { return !!this.#apiKey; }

  async searchNearby({ query, category, keyword, openNow = false, lang = "he", location, radius, limit } = {}) {
    if (!location || location.lat == null || location.lng == null) {
      return { ok: false, results: [], reason: "no_location", provider: "google" };
    }
    if (!this.#apiKey) {
      return { ok: false, results: [], reason: "no_api_key", provider: "google" };
    }

    // שאילתת הטקסט = מה שהאורח ביקש + מילת סינון אופציונלית. כך "בשרי"/
    // "כשר"/"vegan" מגיעים ל-Google כטקסט ומשפיעים על הדירוג בפועל.
    const textQuery = [query, keyword].filter(Boolean).join(" ").trim() || "restaurant";
    const includedType = category ? PLACE_CATEGORIES[category] : undefined;

    const body = {
      textQuery,
      languageCode: lang === "he" ? "he" : "en",
      maxResultCount: Math.min(20, Math.max(1, limit || DEFAULT_LIMIT)),
      locationBias: {
        circle: {
          center: { latitude: location.lat, longitude: location.lng },
          radius: Math.min(50000, Math.max(500, radius || DEFAULT_RADIUS_M)),
        },
      },
    };
    if (includedType) body.includedType = includedType;
    if (openNow)      body.openNow = true;

    let resp;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      resp = await fetch(SEARCH_TEXT_URL, {
        method: "POST",
        headers: {
          "Content-Type":      "application/json",
          "X-Goog-Api-Key":    this.#apiKey, // ← המפתח, רק כאן, אף פעם לא בלוג
          "X-Goog-FieldMask":  FIELD_MASK,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      // רשת נפלה / timeout — לא מדליפים פרטים, רק מסמנים "לא זמין".
      console.error(`Places(Google) fetch failed: ${e?.name || "Error"} ${e?.message || ""}`.trim());
      return { ok: false, results: [], reason: "unavailable", provider: "google" };
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      // מדפיסים סטטוס בלבד — לעולם לא את גוף התשובה או המפתח.
      console.error(`Places(Google) HTTP ${resp.status} for query="${textQuery.slice(0, 60)}"`);
      return { ok: false, results: [], reason: resp.status === 429 ? "rate_limited" : "unavailable", provider: "google" };
    }

    let data;
    try {
      data = await resp.json();
    } catch {
      return { ok: false, results: [], reason: "bad_response", provider: "google" };
    }

    const hotel = { lat: location.lat, lng: location.lng };
    const results = (data.places || [])
      .map((p) => normalizePlace(p, hotel, lang))
      .filter(Boolean)
      // הקרוב ביותר קודם — קונסיירז' מציע קודם את מה שקרוב למלון.
      .sort((a, b) => (a.distanceMeters ?? 1e9) - (b.distanceMeters ?? 1e9));

    return { ok: true, results, provider: "google" };
  }
}

// תשובת Google הגולמית → אובייקט נקי, אחיד, מוכן להצגה. אותו מבנה בדיוק
// שהמוק מחזיר — כדי שהבוט לא יבחין בין אמיתי למדומה.
function normalizePlace(p, hotel, lang) {
  const name = p.displayName?.text;
  if (!name) return null;

  const loc = p.location
    ? { lat: p.location.latitude, lng: p.location.longitude }
    : null;
  const meters = loc ? haversineMeters(hotel, loc) : null;
  const price  = priceLevelInfo(p.priceLevel);
  const rating = formatRating(p.rating, p.userRatingCount);

  return {
    name,
    address:        p.formattedAddress || null,
    category:       p.primaryTypeDisplayName?.text || null,
    rating:         rating ? rating.value : null,
    ratingCount:    rating ? rating.count : null,
    priceLevel:     price ? price.level : null,
    priceSymbol:    price ? price.symbol : null,
    openNow:        p.currentOpeningHours?.openNow ?? null,
    distanceMeters: meters,
    distanceText:   distanceText(meters, lang),
    mapsUri:        p.googleMapsUri || null,
  };
}
