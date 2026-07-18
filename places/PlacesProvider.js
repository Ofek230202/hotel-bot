// ════════════════════════════════════════════════════════
//  PlacesProvider — ממשק אחיד לחיפוש מקומות אמיתיים ליד המלון
//  ----------------------------------------------------------
//  בדיוק כמו idverify/ ו-concierge/ ו-payments/: כל ספק (Google עכשיו,
//  אולי אחר בעתיד) יורש מהמחלקה הזו וממלא את searchNearby. הקוד העסקי
//  (bot.js) מדבר רק עם הממשק — לעולם לא עם Google API ישירות. מעבר לספק
//  אחר, או ל-mock לבדיקות, נעשה במקום אחד בלבד: places/index.js.
// ════════════════════════════════════════════════════════

// קטגוריות המקום שהקונסיירז' יכול לחפש. המפתח (משמאל) הוא מה שה-AI
// בוחר בכלי; הערך (מימין) הוא ה-includedType של Google Places שאליו הוא
// מתורגם. טקסט חופשי ("מסעדת בשר כשרה") עדיין עובר כ-textQuery — הקטגוריה
// רק ממקדת את סוג המקום (מסעדה מול בית קפה מול אטרקציה).
export const PLACE_CATEGORIES = Object.freeze({
  restaurant: "restaurant",
  cafe:       "cafe",
  bar:        "bar",
  bakery:     "bakery",
  attraction: "tourist_attraction",
  museum:     "museum",
  park:       "park",
  nightlife:  "night_club",
  shopping:   "shopping_mall",
  store:      "store",
  spa:        "spa",
  pharmacy:   "pharmacy",
});

export class PlacesProvider {
  /**
   * מחפש מקומות אמיתיים סביב מיקום המלון.
   * @param {object} params
   *   query    {string}  מה שהאורח מחפש בטקסט חופשי — כולל מטבח/כשרות/סגנון
   *                      ("מסעדת בשר כשרה", "בית קפה עם WiFi", "מוזיאון אמנות").
   *   category {string?} מפתח מ-PLACE_CATEGORIES — ממקד את סוג המקום.
   *   keyword  {string?} סינון נוסף ("kosher", "vegan", "sushi") — מצורף ל-query.
   *   openNow  {boolean?} רק מקומות פתוחים כעת.
   *   lang     {string}  "he" | "en" — שפת התוצאות ופורמט המרחק.
   *   location {{lat:number,lng:number,address?:string}} מיקום המלון (per-hotel).
   *   radius   {number?} רדיוס חיפוש במטרים (ברירת מחדל בספק).
   *   limit    {number?} מספר תוצאות מרבי.
   * @returns {Promise<{ok:boolean, results:Array<object>, reason?:string, provider:string}>}
   *   ok=false + reason ("no_location" / "unavailable" / "bad_response") — הבוט
   *   יאמר לאורח שיבדוק ויחזור, ולעולם לא ימציא מקום. results ריק = אין ממצאים.
   */
  async searchNearby(_params) {
    throw new Error("searchNearby not implemented");
  }
}
