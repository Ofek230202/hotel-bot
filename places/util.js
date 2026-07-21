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
// Google מחזיר את שעות השבוע כשבע שורות טקסט מוכנות, כל אחת פותחת בשם
// היום: "Tuesday: 12:00 – 23:00" / "יום שלישי: 12:00–23:00".
//
// 🔴 מלכודת שנתפסה בבדיקה חיה מול Google עם מפתח אמיתי: **סדר הימים
//    תלוי בשפה**. באנגלית התשובה מתחילה ביום שני (כמו שמתועד), אבל
//    בעברית (languageCode=he) היא מתחילה ב*יום ראשון*. קוד שמניח סדר
//    קבוע ומחשב אינדקס מסר לאורח את שעות **היום הלא נכון** — ה-M25
//    הופיע עם "יום שני" בזמן שהיום שלישי. שעות שגויות גרועות משעות
//    חסרות: אורח הולך למסעדה סגורה בגלל מידע שנמסר לו בביטחון.
//
// לכן אין כאן שום הנחה על סדר: מחשבים את שם היום *בשפת התוצאה* ומחפשים
// את השורה שמתחילה בו. אם השם לא נמצא (שפה אחרת/פורמט אחר) — מנסים את
// השפה השנייה, ורק אם גם זה נכשל מוותרים ומחזירים null. אף פעם לא ניחוש.
//
// מלכודת שנייה: "היום" נקבע לפי שעון *ישראל*, לא UTC — ב-01:00 בלילה
// ה-UTC עדיין אתמול, והאורח היה מקבל את שעות אתמול.
export function todayHoursLine(weekdayDescriptions, now = new Date(), lang = "he", timeZone = "Asia/Jerusalem") {
  if (!Array.isArray(weekdayDescriptions) || weekdayDescriptions.length < 7) return null;

  const locales = lang === "he" ? ["he-IL", "en-US"] : ["en-US", "he-IL"];
  for (const locale of locales) {
    const name = new Intl.DateTimeFormat(locale, { timeZone, weekday: "long" }).format(now);
    const hit = weekdayDescriptions.find(d => String(d).trim().startsWith(name));
    if (hit) return hit;
  }
  return null;
}
