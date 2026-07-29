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

      // 🔴 אנשי הקשר של המחלקות — *חובה* פר-מלון.
      //    בלי הסעיף הזה LALA יורשת את המספרים והמיילים של קמפינסקי
      //    מ-DEFAULTS, ואז בקשת מגבות של אורח ב-LALA מגיעה למשק הבית של
      //    קמפינסקי. זו בדיוק דליפת המלונות שאסור שתקרה — ולכן כל מלון
      //    חדש חייב להגדיר את שש המחלקות (ראה checkDepartmentContacts).
      //    בבוטיק קטן כמה "מחלקות" הן אותו אדם — וזה בסדר: מה שחשוב הוא
      //    שהיעד יהיה *של המלון הזה*.
      housekeeping_number: "whatsapp:+9725551110001",
      reception_number:    "whatsapp:+9725551110002",
      maintenance_number:  "whatsapp:+9725551110003",
      concierge_number:    "whatsapp:+9725551110004",
      security_number:     "whatsapp:+9725559990000", // = המנהל התורן מרחוק
      room_service_number: "whatsapp:+9725551110004", // אין מטבח — לקונסיירז'
      housekeeping_email:  "housekeeping@lala-demo.co.il",
      reception_email:     "reception@lala-demo.co.il",
      maintenance_email:   "maintenance@lala-demo.co.il",
      concierge_email:     "concierge@lala-demo.co.il",
      security_email:      "manager@lala-demo.co.il",
      room_service_email:  "concierge@lala-demo.co.il",

      // 🔴 פרטי העוסק לחשבונית המס — *חובה* פר-מלון.
      //    בלי זה החשבונית של אורח LALA נושאת את שם העוסק, מספר הח.פ.
      //    והכתובת של קמפינסקי. זו לא "אי-דיוק בתצוגה" אלא מסמך מס שגוי.
      business: {
        legal_name:    "לאלה בוטיק בע\"מ",
        legal_name_en: "LALA Boutique Ltd.",
        business_id:   "515111222",
        business_type: "עוסק מורשה",
        address:       "דרך בן צבי 78, תל אביב-יפו",
        address_en:    "78 Ben Zvi Road, Tel Aviv-Yafo, Israel",
        phone:         "+972-3-111-2222",
        email:         "billing@lala-demo.co.il",
      },

      // 🔴 מרחב מוגן — ברירת המחדל מדברת על מקלט בחניון קומה ‎-1 ועל
      //    ממ"ק בכל קומת אירוח. ל-LALA אין חניון ויש 4 קומות בלבד;
      //    הנחיה שגויה באזעקה היא סיכון חיים, לא אי-דיוק.
      safety: {
        he: { shelter_location: "הממ\"ד בקומת הכניסה, מאחורי דלפק הקפה (מסומן בשילוט)",
              shelter_time:     "כ-90 שניות" },
        en: { shelter_location: "the reinforced room (Mamad) on the entrance floor, behind the coffee counter (signposted)",
              shelter_time:     "about 90 seconds" },
      },
      location: {
        address:    "78 Ben Zvi Road, Tel Aviv-Yafo, Israel",
        address_he: "דרך בן צבי 78, תל אביב-יפו",
        // ⚠️ קואורדינטות משוערות לבן צבי 78 (דרום ת"א). כשמחברים מלון
        //    אמיתי מזינים את המדויקות (Google Maps → קליק ימני על הסיכה).
        lat: 32.0548, lng: 34.7745, timezone: "Asia/Jerusalem", country: "IL", search_radius_m: 2500,
      },
      // בוטיק קטן — מבנה פשוט (בלי לובי מאויש, בלי מעליות אורחים ייעודיות).
      // ⚠️ חובה למלא כאן את *כל* השדות שקיימים ב-DEFAULTS. מיזוג עמוק שומר
      //    כל שדה שלא נדרס: בגרסה קודמת LALA ירשה את key_areas של קמפינסקי
      //    ("בריכה וסקיי בר בגג קומה 12 · ספא קומה 3") — במלון בן 4 קומות
      //    בלי בריכה. ה-AI מקבל את זה כעובדה ומוסר אותה לאורח בביטחון.
      building: {
        he: { floors: "4 קומות, 12 חדרים בלבד", lobby: "כניסה עצמאית עם קוד לדלת הראשית",
              reception: "אין קבלה מאוישת 24/7 — צ'ק אין דיגיטלי וקוד לדלת",
              elevators: "מעלית אחת קטנה בכניסה, משרתת את כל 4 הקומות",
              accessibility: "הכניסה בגישה נטולת מדרגות; חדר אחד נגיש בקומת הכניסה",
              key_areas: "בית קפה וארוחת בוקר בקומת הכניסה · גג עם מרפסת ישיבה" },
        en: { floors: "4 floors, just 12 rooms", lobby: "Self-entry with a code on the main door",
              reception: "No 24/7 staffed reception — digital check-in with a door code",
              elevators: "One small lift at the entrance, serving all 4 floors",
              accessibility: "Step-free entrance; one accessible room on the entrance floor",
              key_areas: "Café & breakfast on the entrance floor · roof terrace seating" },
      },

      // 🔴 מסעדות פנימיות — null מנקה. `{}` *אינו* מנקה: מיזוג עמוק של
      //    אובייקט ריק משאיר את מסעדות ברירת המחדל, ואז הקונסיירז' של
      //    LALA היה מפנה אורחים ל"מסעדת הגן, קומה 1" של קמפינסקי.
      restaurants: null,

      // 🔴 שאלות נפוצות — מערך נדרס במלואו. בלי זה LALA יורשת את ה-FAQ של
      //    קמפינסקי (מרכז עסקים 24/7, ואלט, אחסון מזוודות בקבלה) — שירותים
      //    שאין לה, ושהבוט היה מוסר עליהם תשובה מלאה ובטוחה.
      faq: [
        { he: { q: "מה שעות הכניסה והעזיבה?", a: "הכניסה מהשעה 15:00 עם קוד לדלת שנשלח אליכם, והעזיבה עד 12:00. אפשר לבקש ממני גמישות ואבדוק." },
          en: { q: "Check-in / check-out times?", a: "Check-in from 15:00 with a door code sent to you, check-out by 12:00. Ask me and I'll try to arrange flexibility." } },
        { he: { q: "איך נכנסים בלי קבלה?", a: "הצ'ק אין הוא דיגיטלי, כאן בוואטסאפ. בסיומו נשלח אליכם קוד לדלת הראשית ולחדר — אין צורך באיסוף מפתח." },
          en: { q: "How do I get in with no reception?", a: "Check-in is digital, right here on WhatsApp. When it's done you'll get a code for the main door and your room — no key to collect." } },
        { he: { q: "יש חניה?", a: "אין חניון במלון. יש חניה כחול-לבן ברחוב, וחניון ציבורי בתשלום במרחק 3 דקות הליכה." },
          en: { q: "Is there parking?", a: "No hotel car park. There's metered street parking, and a paid public car park a 3-minute walk away." } },
        { he: { q: "יש שירות לחדר?", a: "אין מטבח במלון, אבל אשמח להמליץ על מסעדה באזור ולהזמין עבורכם משלוח לחדר." },
          en: { q: "Is there room service?", a: "There's no kitchen on site, but I'm happy to recommend a local restaurant and order a delivery to your room." } },
        { he: { q: "מה כוללת ארוחת הבוקר?", a: "ארוחת בוקר קונטיננטלית — מאפים טריים, גבינות, פירות וקפה — בבית הקפה שבקומת הכניסה, בין 08:00 ל-10:30. כלולה בלינה." },
          en: { q: "What's included in breakfast?", a: "A continental breakfast — fresh pastries, cheeses, fruit and coffee — at the café on the entrance floor, 08:00–10:30. Included in your stay." } },
      ],
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
      // ללא חניון (בוטיק על הטיילת).
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
