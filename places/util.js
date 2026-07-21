// ════════════════════════════════════════════════════════
//  places/util.js — עזרי חישוב ופורמט משותפים לספקי המקומות
//  ----------------------------------------------------------
//  אין כאן רשת ואין מפתח — רק חישוב מרחק (haversine), תרגום דרגת
//  מחיר של Google לסמלי ₪, ופורמט מרחק דו-לשוני. גם הספק האמיתי
//  (GooglePlacesProvider) וגם המוק (MockPlacesProvider) משתמשים באותם
//  עזרים, כדי שהתוצאה שמגיעה לבוט תיראה זהה בשני המצבים.
// ════════════════════════════════════════════════════════

// מרחק אווירי בין שתי נקודות (מטרים). מספיק מדויק להצגת "9 דקות הליכה
// ≈ 700 מ׳" לאורח — לא ניווט. נמנע מהוספת תלות ב-API נתיבים בשלב הזה.
export function haversineMeters(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const R = 6371000; // רדיוס כדור הארץ במטרים
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

// מרחק במילים, לפי שפת השיחה. עד 1 ק״מ → מטרים מעוגלים לעשרות;
// מעבר לכך → ק״מ עם ספרה אחת אחרי הנקודה.
export function distanceText(meters, lang = "he") {
  if (meters == null) return null;
  const he = lang === "he";
  if (meters < 1000) {
    const m = Math.max(10, Math.round(meters / 10) * 10);
    return he ? `${m} מ׳` : `${m} m`;
  }
  const km = (meters / 1000).toFixed(1);
  return he ? `${km} ק״מ` : `${km} km`;
}

// דרגת המחיר של Google → סמלי ₪. השדה מגיע כמחרוזת enum ("PRICE_LEVEL_
// MODERATE") או כמספר 0–4 בגרסאות ישנות. מחזירים גם סמל וגם רמה מספרית,
// כדי שה-AI יוכל לנסח בעצמו ("סביר", "יוקרתי") בלי לנחש מספר.
const PRICE_LEVEL_MAP = {
  PRICE_LEVEL_FREE:           { level: 0, symbol: "" },
  PRICE_LEVEL_INEXPENSIVE:    { level: 1, symbol: "₪" },
  PRICE_LEVEL_MODERATE:       { level: 2, symbol: "₪₪" },
  PRICE_LEVEL_EXPENSIVE:      { level: 3, symbol: "₪₪₪" },
  PRICE_LEVEL_VERY_EXPENSIVE: { level: 4, symbol: "₪₪₪₪" },
};

export function priceLevelInfo(priceLevel) {
  if (priceLevel == null) return null;
  if (typeof priceLevel === "number") {
    const symbol = priceLevel > 0 ? "₪".repeat(Math.min(4, priceLevel)) : "";
    return { level: priceLevel, symbol };
  }
  return PRICE_LEVEL_MAP[priceLevel] || null;
}

// עיגול דירוג להצגה (4.4), ושמירת מספר הדירוגים כפי שהוא.
export function formatRating(rating, count) {
  if (rating == null) return null;
  return { value: Math.round(rating * 10) / 10, count: count ?? null };
}

// ── שעות הפתיחה *של היום* ──────────────────────────────
// Google מחזיר את שעות השבוע כשבע שורות טקסט מוכנות
// ("Monday: 12:00 – 23:00" / "יום שני: 12:00–23:00"), כשהראשונה היא
// *יום שני* — כך זה מוגדר ב-Places API (New).
//
// שתי מלכודות שהקוד הזה מטפל בהן:
//  1. "היום" נקבע לפי שעון *ישראל*, לא לפי UTC. בשעה 01:00 בלילה בישראל
//     ה-UTC עדיין אתמול — והאורח היה מקבל את שעות אתמול.
//  2. האינדוקס מתחיל בשני, לא בראשון. חישוב "יום בשבוע" רגיל (0=ראשון)
//     היה מזיז את כל השבוע ביום אחד — ומוסר לאורח שעות של יום אחר לגמרי,
//     מה שגרוע יותר מלא למסור שעות בכלל.
export function todayHoursLine(weekdayDescriptions, now = new Date(), timeZone = "Asia/Jerusalem") {
  if (!Array.isArray(weekdayDescriptions) || weekdayDescriptions.length < 7) return null;
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(now);
  const mondayFirst = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const idx = mondayFirst.indexOf(name);
  if (idx === -1) return null;
  return weekdayDescriptions[idx] || null;
}
