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

// ════════════════════════════════════════════════════════
//  smoke-check בהפעלה — מפתח פסול לא ישתוק
//  ----------------------------------------------------------
//  המלכודת: הבחירה למעלה נעשית לפי *קיום* המפתח בלבד. מפתח שגוי, מפתח
//  שה-Places API (New) לא מופעל עבורו בפרויקט, או מפתח מוגבל — ייבחרו
//  בדיוק כמו מפתח תקין. אחרי זה כל חיפוש חוזר 400/403, `runPlacesTool`
//  מחזיר "לא זמין", והבוט אומר לאורח בנימוס "אבדוק ואחזור אליך" —
//  *בלי שום סימן חיצוני שמשהו שבור*. בהדגמה מול לקוח זה נראה כאילו
//  הקונסיירז' פשוט לא יודע, ואיש לא יבין שהחיבור מת.
//
//  לכן: חיפוש אמיתי אחד בהפעלה, ותוצאה רועשת בלוג. שלוש התנהגויות —
//  תקין → שורה אחת; מפתח פסול (invalid_key, תקלה *קבועה*) → בלוק שגיאה
//  בולט עם מה לבדוק; תקלה חולפת (רשת/429/500) → אזהרה מרוככת, כי אין
//  טעם להקים רעש על בעיה שתיפתר מעצמה.
//
//  לא חוסם את עליית השרת (לא ממתינים לו), לא זורק, ולא מדפיס את המפתח.
// ════════════════════════════════════════════════════════
export async function smokePlaces(location) {
  if (!placesLive) return { skipped: true, reason: "not_live" };
  if (!location || location.lat == null || location.lng == null) {
    console.warn("🗺️  smoke-check דולג — אין קואורדינטות למלון ב-config.location");
    return { skipped: true, reason: "no_location" };
  }

  let r;
  try {
    r = await places.searchNearby({
      query: "restaurant", category: "restaurant",
      lang: "en", location, limit: 1,
    });
  } catch (e) {
    console.warn(`⚠️  Places smoke-check נכשל באופן חריג: ${e?.message || e}`);
    return { ok: false, reason: "threw" };
  }

  if (r.ok) {
    console.log(`✅ Places smoke-check עבר — Google החזיר ${r.results.length} תוצאה. החיפוש החי פעיל.`);
    return { ok: true, results: r.results.length };
  }

  if (r.reason === "invalid_key") {
    console.error(
      "\n╔══════════════════════════════════════════════════════════════╗\n" +
      "║ 🔴 GOOGLE PLACES — המפתח נדחה. החיפוש החי *אינו* עובד.       ║\n" +
      "╚══════════════════════════════════════════════════════════════╝\n" +
      "   הבוט ימשיך לרוץ, אבל כל בקשת המלצה תיענה ב\"אבדוק ואחזור אליך\"\n" +
      "   בלי שום סימן לאורח שמשהו שבור. לבדוק בסדר הזה:\n" +
      "     1. ‏Places API (New) מופעל בפרויקט (לא ה-Places API הישן)\n" +
      "     2. המפתח ב-GOOGLE_PLACES_API_KEY הועתק במלואו, בלי רווחים\n" +
      "     3. הגבלות המפתח (API restrictions / IP) לא חוסמות את השרת\n" +
      "     4. יש חשבון חיוב פעיל בפרויקט\n" +
      "   כדי לרוץ מכוון על המוק בינתיים: PLACES_PROVIDER=mock\n"
    );
    return { ok: false, reason: "invalid_key" };
  }

  console.warn(
    `⚠️  Places smoke-check לא עבר (${r.reason}) — ככל הנראה תקלה חולפת ` +
    `(רשת/מכסה). המפתח עצמו לא נדחה. שווה לבדוק שוב לפני הדגמה.`
  );
  return { ok: false, reason: r.reason };
}
