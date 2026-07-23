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
// ⚠️ הערכים חייבים להיות includedType חוקיים של Google Places API (New),
//    Table A — אחרת הבקשה מקבלת 400. כרשת ביטחון, GooglePlacesProvider
//    מנסה שוב *בלי* includedType על 400, כך שגם קטגוריה לא-נתמכת עדיין
//    מחזירה תוצאות דרך טקסט חופשי (query). המפתח משמאל הוא מה שה-AI בוחר.
export const PLACE_CATEGORIES = Object.freeze({
  // אוכל ושתייה
  restaurant:   "restaurant",
  cafe:         "cafe",
  bar:          "bar",
  bakery:       "bakery",
  takeaway:     "meal_takeaway",
  // בריאות ורווחה
  pharmacy:     "pharmacy",
  doctor:       "doctor",
  dentist:      "dentist",
  hospital:     "hospital",
  physiotherapist: "physiotherapist",
  vet:          "veterinary_care",
  // יופי וטיפוח
  spa:          "spa",
  hair_salon:   "hair_salon",
  beauty_salon: "beauty_salon",
  nail_salon:   "nail_salon",
  // כושר
  gym:          "gym",
  // קניות
  supermarket:  "supermarket",
  grocery:      "grocery_store",
  convenience:  "convenience_store",
  shopping:     "shopping_mall",
  department_store: "department_store",
  clothing:     "clothing_store",
  shoe_store:   "shoe_store",
  jewelry:      "jewelry_store",
  book_store:   "book_store",
  electronics:  "electronics_store",
  gift:         "gift_shop",
  florist:      "florist",
  pet_store:    "pet_store",
  liquor:       "liquor_store",
  store:        "store",
  // כספים
  atm:          "atm",
  bank:         "bank",
  // רכב
  gas_station:  "gas_station",
  car_repair:   "car_repair",
  car_wash:     "car_wash",
  parking:      "parking",
  ev_charging:  "electric_vehicle_charging_station",
  // שירותים
  laundry:      "laundry",
  travel_agency:"travel_agency",
  post_office:  "post_office",
  // חינוך
  preschool:    "preschool",
  school:       "school",
  library:      "library",
  university:   "university",
  // תרבות ובידור
  attraction:   "tourist_attraction",
  museum:       "museum",
  art_gallery:  "art_gallery",
  park:         "park",
  nightlife:    "night_club",
  movie_theater:"movie_theater",
  theater:      "performing_arts_theater",
  amusement_park:"amusement_park",
  aquarium:     "aquarium",
  zoo:          "zoo",
  bowling:      "bowling_alley",
  casino:       "casino",
  // תחבורה
  train_station:"train_station",
  subway:       "subway_station",
  bus_station:  "bus_station",
  taxi:         "taxi_stand",
  // דת
  synagogue:    "synagogue",
  church:       "church",
  mosque:       "mosque",
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
