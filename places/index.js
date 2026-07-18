// ════════════════════════════════════════════════════════
//  נקודת החיבור היחידה לספק המקומות (single wiring point)
//  ----------------------------------------------------------
//  כאן — ורק כאן — נבחר מי מספק את חיפוש המקומות האמיתיים. כל שאר
//  הקוד (bot.js) מייבא את `places` מכאן ולא יודע מי הספק בפועל.
//
//  הבחירה אוטומטית ובטוחה:
//  • יש GOOGLE_PLACES_API_KEY בסביבה (Railway) → הספק האמיתי של Google.
//  • אין מפתח, או PLACES_PROVIDER=mock → מוק (פיתוח/בדיקות, בלי רשת).
//  כך אותו קוד רץ בענן עם תוצאות אמיתיות ובמחשב מקומי בלי מפתח — בלי
//  קריסה ובלי צורך לשנות קוד. מעבר לספק אחר בעתיד = החלפת שורה כאן.
//
//  ⚠️ המפתח עצמו לא נמצא כאן ולא בשום קובץ — רק שמו נקרא מ-process.env
//     בתוך GooglePlacesProvider. אין לכתוב מפתח בקוד ואין להדפיסו ללוג.
// ════════════════════════════════════════════════════════
import { GooglePlacesProvider } from "./GooglePlacesProvider.js";
import { MockPlacesProvider }   from "./MockPlacesProvider.js";

export { PLACE_CATEGORIES } from "./PlacesProvider.js";

const forceMock = (process.env.PLACES_PROVIDER || "").toLowerCase() === "mock";
const hasKey    = !!process.env.GOOGLE_PLACES_API_KEY;

// האם חיפוש חי אמיתי פעיל (משפיע רק על לוגים — לא על שם המפתח).
export const placesLive = hasKey && !forceMock;

export const places = placesLive
  ? new GooglePlacesProvider()
  : new MockPlacesProvider();

console.log(
  placesLive
    ? "🗺️  Places: Google Places API (live) פעיל"
    : `🗺️  Places: MOCK (${forceMock ? "PLACES_PROVIDER=mock" : "אין GOOGLE_PLACES_API_KEY"})`
);
