// ════════════════════════════════════════════════════════
//  MockPlacesProvider — ספק מקומות מדומה (בלי רשת, בלי מפתח)
//  ----------------------------------------------------------
//  משמש כשאין GOOGLE_PLACES_API_KEY בסביבה (פיתוח מקומי) או כש-
//  PLACES_PROVIDER=mock (בדיקות). מחזיר תוצאות דמו קבועות סביב מיקום
//  המלון, בפורמט *זהה בדיוק* לזה של GooglePlacesProvider — כך אפשר
//  לפתח ולבדוק את כל הזרימה בלי לגעת ב-Google וב-מפתח.
//
//  ⚠️ אלה מקומות בדויים לחלוטין. אסור שהמוק יגיע לפרודקשן מול אורחים —
//     כמו שאר שכבות המוק בפרויקט. הבחירה נעשית במקום אחד: places/index.js.
// ════════════════════════════════════════════════════════
import { PlacesProvider } from "./PlacesProvider.js";
import { haversineMeters, distanceText, todayHoursLine } from "./util.js";

// שעות שבוע לדוגמה — בדיוק בפורמט של Google (ראשונה = יום שני), כדי
// שהמוק והספק האמיתי ייראו זהים לבוט, כולל שורת "השעות היום".
const DEMO_HOURS_EN = [
  "Monday: 12:00 – 23:00", "Tuesday: 12:00 – 23:00", "Wednesday: 12:00 – 23:00",
  "Thursday: 12:00 – 23:30", "Friday: 12:00 – 15:00", "Saturday: Closed",
  "Sunday: 12:00 – 23:00",
];
const DEMO_HOURS_HE = [
  "יום שני: 12:00–23:00", "יום שלישי: 12:00–23:00", "יום רביעי: 12:00–23:00",
  "יום חמישי: 12:00–23:30", "יום שישי: 12:00–15:00", "יום שבת: סגור",
  "יום ראשון: 12:00–23:00",
];

// דוגמאות לפי קטגוריה — כל אחת עם היסט קטן ממיקום המלון כדי לייצר מרחק
// אמין. keyword משוקף לשם (למשל "kosher") כדי שבדיקות יראו שהסינון עבר.
const SAMPLES = {
  restaurant: [
    { name: "Demo Grill House", d: [0.006, 0.001], rating: 4.5, count: 820, price: 3, cat: "Restaurant" },
    { name: "Demo Trattoria",   d: [-0.003, 0.004], rating: 4.3, count: 540, price: 2, cat: "Italian restaurant" },
    { name: "Demo Bistro",      d: [0.002, -0.005], rating: 4.6, count: 310, price: 2, cat: "Bistro" },
  ],
  cafe: [
    { name: "Demo Roasters",    d: [0.001, 0.001], rating: 4.7, count: 1200, price: 1, cat: "Coffee shop" },
    { name: "Demo Café Levant", d: [-0.002, 0.002], rating: 4.4, count: 430, price: 1, cat: "Café" },
  ],
  attraction: [
    { name: "Demo Old Port",     d: [0.008, 0.006], rating: 4.6, count: 9800, price: null, cat: "Tourist attraction" },
    { name: "Demo Promenade",    d: [0.004, -0.002], rating: 4.8, count: 15400, price: null, cat: "Scenic spot" },
  ],
  default: [
    { name: "Demo Place One", d: [0.003, 0.002], rating: 4.4, count: 260, price: 2, cat: "Point of interest" },
    { name: "Demo Place Two", d: [-0.004, 0.003], rating: 4.2, count: 180, price: 2, cat: "Point of interest" },
  ],
};

export class MockPlacesProvider extends PlacesProvider {
  async searchNearby({ query, category, keyword, lang = "he", location, limit = 6 } = {}) {
    if (!location || location.lat == null || location.lng == null) {
      return { ok: false, results: [], reason: "no_location", provider: "mock" };
    }

    const base  = SAMPLES[category] || SAMPLES.default;
    const tag   = (keyword || query || "").trim();
    const hours = lang === "he" ? DEMO_HOURS_HE : DEMO_HOURS_EN;

    const results = base.slice(0, limit).map((s) => {
      const loc    = { lat: location.lat + s.d[0], lng: location.lng + s.d[1] };
      const meters = haversineMeters(location, loc);
      // משקפים את מילת הבקשה בשם, כדי שבדיקה תראה שהבקשה המדויקת נשמרה
      // (mock בלבד — בפרודקשן זו תוצאה אמיתית מ-Google).
      const name = tag ? `${s.name} (${tag})` : s.name;
      return {
        name,
        address:        `${Math.round(meters)} m from the hotel (demo address)`,
        category:       s.cat,
        rating:         s.rating,
        ratingCount:    s.count,
        priceLevel:     s.price,
        priceSymbol:    s.price ? "₪".repeat(s.price) : null,
        openNow:        true,
        openingHours:   hours,
        todayHours:     todayHoursLine(hours),
        phone:          "03-000-0000",
        website:        null,
        distanceMeters: meters,
        distanceText:   distanceText(meters, lang),
        mapsUri:        null,
      };
    }).sort((a, b) => a.distanceMeters - b.distanceMeters);

    return { ok: true, results, provider: "mock" };
  }
}
