// ════════════════════════════════════════════════════════
//  SAMPLE HOTELS — מלוני דוגמה במיקומים שונים (בדיקת רב-מלונות)
//  ----------------------------------------------------------
//  6 מלונות אמיתיים גאוגרפית: 4 בישראל (ת"א/ירושלים/אילת/חיפה) ו-2
//  בחו"ל (מנהטן/לונדון). לכל מלון: מיקום מדויק (lat/lng), אזור זמן,
//  ומספר Twilio משלו. משמש את concierge-live-check.mjs ואפשר גם לזרוע
//  אותם ל-DB אמיתי לצורך הדגמה.
//
//  ⚠️ ל-local_area של כל מלון *שאינו* ברירת המחדל אנחנו מאפסים את הידע
//     המקומי המובנה (שהוא של תל אביב ב-DEFAULTS) — אחרת מלון בניו יורק
//     היה "יורש" מסעדות תל אביביות. כך הקונסיירז' של מלון לא-ת"א נשען
//     על החיפוש החי בלבד (Google לפי המיקום שלו), בלי דליפת מקום בין ערים.
// ════════════════════════════════════════════════════════

// מבנה local_area ריק (שני השפות) — מחליף את הידע התל-אביבי ב-DEFAULTS.
function emptyLocalArea() {
  const empty = () => ({
    neighbourhood: "",
    restaurants: [], attractions: [], tours: [], nightlife: [], shopping: [],
    transport: {},
  });
  return { en: empty(), he: empty() };
}

// כל מלון: hotelId, number (Twilio E.164), ו-config override (מעל DEFAULTS).
export const SAMPLE_HOTELS = [
  {
    hotelId: "kempinski",              // מלון ברירת המחדל — תל אביב (קיים)
    number:  "+15550001001",
    isDefault: true,                   // לא דורסים — כבר מוגדר ב-DEFAULTS
    label:   "Tel Aviv · The David Kempinski",
    config: null,                      // משתמשים בקונפיג הקיים
  },
  {
    hotelId: "jerusalem",
    number:  "+15550001002",
    label:   "Jerusalem · King David area",
    config: {
      name: "The Jerusalem Grand", name_he: "מלון ירושלים גרנד",
      location: {
        address:    "23 King David Street, Jerusalem, Israel",
        address_he: "רחוב המלך דוד 23, ירושלים",
        lat: 31.7742, lng: 35.2226, timezone: "Asia/Jerusalem", country: "IL", search_radius_m: 3000,
      },
      local_area: emptyLocalArea(),
    },
  },
  {
    hotelId: "eilat",
    number:  "+15550001003",
    label:   "Eilat · North Beach",
    config: {
      name: "Eilat Bay Resort", name_he: "מלון מפרץ אילת",
      location: {
        address:    "North Beach Promenade, Eilat, Israel",
        address_he: "טיילת חוף הצפוני, אילת",
        lat: 29.5540, lng: 34.9520, timezone: "Asia/Jerusalem", country: "IL", search_radius_m: 4000,
      },
      local_area: emptyLocalArea(),
    },
  },
  {
    hotelId: "haifa",
    number:  "+15550001004",
    label:   "Haifa · German Colony",
    config: {
      name: "Haifa Carmel Hotel", name_he: "מלון הכרמל חיפה",
      location: {
        address:    "Ben Gurion Avenue, German Colony, Haifa, Israel",
        address_he: "שדרות בן גוריון, המושבה הגרמנית, חיפה",
        lat: 32.8184, lng: 34.9885, timezone: "Asia/Jerusalem", country: "IL", search_radius_m: 3500,
      },
      local_area: emptyLocalArea(),
    },
  },
  {
    hotelId: "nyc",
    number:  "+15550001005",
    label:   "New York · Midtown Manhattan",
    config: {
      name: "The Manhattan Fifth", name_he: "מלון מנהטן החמישית",
      location: {
        address:    "5th Avenue & W 52nd St, Midtown, New York, NY, USA",
        address_he: "השדרה החמישית פינת רחוב 52, מידטאון, ניו יורק",
        lat: 40.7614, lng: -73.9776, timezone: "America/New_York", country: "US", search_radius_m: 2500,
      },
      local_area: emptyLocalArea(),
    },
  },
  {
    hotelId: "london",
    number:  "+15550001006",
    label:   "London · Mayfair",
    config: {
      name: "The Mayfair London", name_he: "מלון מייפייר לונדון",
      location: {
        address:    "Berkeley Square, Mayfair, London, UK",
        address_he: "ברקלי סקוור, מייפייר, לונדון",
        lat: 51.5099, lng: -0.1467, timezone: "Europe/London", country: "GB", search_radius_m: 2500,
      },
      local_area: emptyLocalArea(),
    },
  },
  {
    // ── מלון בוטיק (Part א') — קוד לדלת, בלי צוות 24/7 ──────
    // מדגים את הסוג השני: מנעול חכם (קוד דלת) במקום כרטיס, בלי קבלה
    // מאוישת מסביב לשעון ובלי צוות ביטחון/רפואי במקום. חירום מופנה
    // לשירותי החוץ (101/102/100) ולמנהל התורן מרחוק (duty_manager_number).
    hotelId: "lala",
    number:  "+15550001007",
    label:   "Tel Aviv · LALA (boutique, door-code)",
    config: {
      name: "LALA Boutique", name_he: "לאלה בוטיק",
      tagline: "A boutique hideaway on the Tel Aviv shoreline",
      hotel_type: "boutique",             // ← קוד לדלת + בלי צוות במקום
      duty_manager_number: "whatsapp:+9725559990000", // מנהל תורן מרחוק 24/7
      location: {
        address:    "78 Ben Zvi Road, Tel Aviv-Yafo, Israel",
        address_he: "דרך בן צבי 78, תל אביב-יפו",
        // ⚠️ קואורדינטות משוערות לבן צבי 78 (דרום ת"א). כשמחברים מלון
        //    אמיתי מזינים את המדויקות (Google Maps → קליק ימני על הסיכה).
        lat: 32.0548, lng: 34.7745, timezone: "Asia/Jerusalem", country: "IL", search_radius_m: 2500,
      },
      // בוטיק קטן — מבנה פשוט (בלי לובי מאויש, בלי מעליות אורחים ייעודיות).
      building: {
        he: { floors: "4 קומות, 12 חדרים בלבד", lobby: "כניסה עצמאית עם קוד לדלת הראשית",
              reception: "אין קבלה מאוישת 24/7 — צ'ק אין דיגיטלי וקוד לדלת" },
        en: { floors: "4 floors, just 12 rooms", lobby: "Self-entry with a code on the main door",
              reception: "No 24/7 staffed reception — digital check-in with a door code" },
      },
      // 🔴 פרטים משלו לבוטיק — אחרת יורש את ברירות המחדל של קמפינסקי
      //    (בריכה בקומה 12, "מסעדת הגן") שאינן מתאימות למלון בוטיק קטן.
      wifi: { name: "LALA_Guest", password: "Shoreline2026" },
      // מחליף את השירותים בסט מתאים לבוטיק. null מסיר שירות שירש מברירת
      // המחדל של קמפינסקי (בריכה/ספא/חדר כושר/מסעדה/בר/כביסה) — בוטיק
      // קטן על הטיילת אין לו את אלה, ואסור שהם יופיעו לאורח.
      services: {
        pool: null, spa: null, gym: null, restaurant: null, bar: null, laundry: null,
        breakfast: {
          he: { name: "ארוחת בוקר", hours: "08:00–10:30", location: "בבית הקפה שבקומת הכניסה",
                style: "קונטיננטלית — מאפים טריים, גבינות, פירות וקפה", price: "כלולה בלינה" },
          en: { name: "Breakfast", hours: "08:00–10:30", location: "at the café on the entrance floor",
                style: "Continental — fresh pastries, cheeses, fruit and coffee", price: "Included in the stay" },
        },
        room_service: {
          he: { name: "שירות לחדר", dial: null, hours: "אין שירות לחדר במלון — אשמח להמליץ ולהזמין משלוח מבחוץ",
                how_to_order: "פשוט לבקש ממני ואארגן משלוח ממסעדה באזור" },
          en: { name: "In-room dining", dial: null, hours: "No in-house room service — I'm happy to recommend and order a delivery from nearby",
                how_to_order: "Just ask me and I'll arrange a delivery from a local restaurant" },
        },
      },
      // ללא מסעדות פנימיות, ללא חניון גדול (בוטיק על הטיילת).
      restaurants: {},
      parking: {
        available: false,
        he: { note: "אין חניון במלון. חניה כחול-לבן ברחוב, וחניון ציבורי בתשלום במרחק 3 דקות הליכה." },
        en: { note: "No hotel car park. Metered street parking, and a paid public car park a 3-minute walk away." },
      },
      arrival: {
        he: { by_car: "מכביש החוף, יציאה לטיילת הרברט סמואל. אין חניון במלון — חניה ברחוב או בחניון ציבורי סמוך.",
              from_airport: "מנתב\"ג — כ-20 דקות ברכב. מונית ₪150–₪220.",
              check_in_time: "הכניסה מהשעה 15:00 עם קוד לדלת שיישלח אליך. הגעתם מוקדם? כתבו לי ואסדר." },
        en: { by_car: "From the coastal road, exit to the Herbert Samuel promenade. No hotel car park — street or a nearby public car park.",
              from_airport: "From Ben Gurion — about 20 min by car. Taxi ₪150–₪220.",
              check_in_time: "Check-in from 15:00 with a door code sent to you. Arriving early? Message me and I'll help." },
      },
      local_area: emptyLocalArea(),
    },
  },
];

// זורע את מלוני הדוגמה: כותב קונפיג לכל מלון (מלבד ברירת המחדל) וממפה
// את מספר ה-Twilio שלו. idempotent — אפשר להריץ שוב. מקבל את המודולים
// כדי לא לכפות סדר ייבוא (הקורא כבר טען אותם).
export function seedSampleHotels({ updateConfigFor, registerHotelNumber, DEFAULT_HOTEL_ID }) {
  for (const h of SAMPLE_HOTELS) {
    registerHotelNumber(h.number, h.hotelId, h.number);
    if (!h.isDefault && h.config) updateConfigFor(h.hotelId, h.config);
  }
  return SAMPLE_HOTELS;
}
