// ════════════════════════════════════════════════════════
//  HOTEL CONFIGURATION  —  edit this file per property
//  ----------------------------------------------------------
//  שתי שכבות:
//  1. `DEFAULTS` (למטה) — ברירות המחדל שבקוד. מקור האמת ההתחלתי.
//  2. `overrides` — עריכות שנעשו דרך ה-API (POST /api/config), שמורות
//     ב-DB בטבלת `config`. נטענות בעליית התהליך ומוחלות מעל DEFAULTS.
//
//  hotelConfig = deepMerge(DEFAULTS, overrides) — ולכן:
//  • עריכה דרך ה-API שורדת ריסטארט (לא הייתה שורדת קודם).
//  • המיזוג *עמוק*: `{services:{spa:{he:{hours:"…"}}}}` משנה רק את
//    שעות הספא בעברית. קודם, במיזוג השטוח, פאטצ' כזה היה מוחק את כל
//    שאר השירותים — כי `{...cfg, ...patch}` מחליף את `services` כולו.
//  • נשמרים רק ה-overrides, לא הקונפיג המלא. כך שדה חדש שנוסף כאן
//    בקוד מגיע גם למלון שכבר ערך את הקונפיג — במקום להיחסם על ידי
//    snapshot ישן מה-DB.
// ════════════════════════════════════════════════════════
import { db, DEFAULT_HOTEL_ID } from "./db.js";

const HOTEL = DEFAULT_HOTEL_ID;

// ⚠️⚠️ נתוני דמו — להחלפה מלאה בכל מלון אמיתי ⚠️⚠️
// ─────────────────────────────────────────────────────────
// כל הערכים בקובץ הזה (שעות, מחירים, טיפולים, תפריטים, מדיניות,
// טלפונים, WiFi ותנאי שהייה) הם *נתוני דוגמה* סבירים למלון 5 כוכבים,
// שנועדו להדגמה בלבד. אין להפעיל מול אורחים אמיתיים לפני שכל מלון
// מחליף אותם בנתונים האמיתיים שלו.
//
// למה זה קריטי: הבוט מצטט את הערכים האלה לאורח *כעובדה* ("עיסוי
// שוודי 60 דקות — ₪350"). מחיר דמו שנשאר בפרודקשן = מחיר שהאורח קיבל
// והמלון מחויב לכבד.
//
// מה להחליף לפני העלייה לאוויר: services, parking, faq, wifi,
// deposit_amount, terms (נוסח משפטי מאושר), וכל מספרי הטלפון/מיילים.
// ─────────────────────────────────────────────────────────
const DEFAULTS = {
  // ── Identity ──────────────────────────────────────────
  name:          "Kempinski Hotel",
  name_he:       "מלון קמפינסקי",
  tagline:       "Where luxury meets hospitality",
  default_lang:  "auto",   // "auto" | "he" | "en"

  // ── Internal contacts (WhatsApp numbers) ─────────────
  housekeeping_number: "whatsapp:+9721234567",
  reception_number:    "whatsapp:+9727654321",
  maintenance_number:  "whatsapp:+9729876543",
  concierge_number:    "whatsapp:+9721112233",
  security_number:     "whatsapp:+9725556677",   // ביטחון / מנהל תורן — להסלמת חירום

  // ── Internal contacts (Email per department) ─────────
  housekeeping_email: "housekeeping@kempinski-demo.co.il",
  reception_email:    "reception@kempinski-demo.co.il",
  maintenance_email:  "maintenance@kempinski-demo.co.il",
  concierge_email:    "concierge@kempinski-demo.co.il",
  security_email:     "security@kempinski-demo.co.il",

  // ── Timing ───────────────────────────────────────────
  checkin_time:  "15:00",
  checkout_time: "12:00",
  early_checkin: true,
  late_checkout: true,

  // ── Deposit ───────────────────────────────────────────
  // סכום פיקדון השהייה, באגורות (50000 = ₪500). מקור אמת אחד: משמש
  // את שכבת התשלום (checkin.js), את הסבר הפיקדון ואת תנאי השהייה —
  // כדי שהסכום שהאורח מאשר בתנאים יהיה תמיד הסכום שבאמת מוקפא.
  deposit_amount: 50000,

  // ── Stay terms (תנאי שהייה) ───────────────────────────
  // ⚠️ תנאים *לדוגמה* בלבד — לצורכי הדמו.
  //    בפרודקשן כל מלון מחליף אותם בתנאים המשפטיים האמיתיים שלו,
  //    לאחר אישור יועץ משפטי (חוק הגנת הצרכן, חוק הגנת הפרטיות,
  //    ומדיניות הביטול בפועל של המלון).
  //    מכיוון שהתנאים יושבים כאן, ב-hotelConfig, הם כבר per-hotel —
  //    כשנעבור למולטי-טננט כל מלון יקבל את הנוסח שלו בלי שינוי קוד.
  //
  //    `version` נשמר על ההזמנה יחד עם רגע האישור — כדי שתמיד נדע
  //    *איזה* נוסח האורח אישר בפועל. כל שינוי בתנאים = version חדש.
  //
  //    placeholders שמוחלפים בזמן השליחה: {hotel} {checkout_time} {deposit}
  terms: {
    version: "demo-2026-01",
    he: [
      { title: "אחריות לנזקים",
        body: "האורח אחראי לכל נזק שייגרם לחדר, לתכולתו או לרכוש {hotel} במהלך שהייתו, ויחויב בעלות התיקון או ההחלפה." },
      { title: "שעת צ'ק אאוט",
        body: "יש לפנות את החדר עד השעה {checkout_time} ביום העזיבה. צ'ק אאוט מאוחר כפוף לזמינות ועשוי להיות כרוך בתשלום נוסף." },
      { title: "פיקדון ומדיניות ביטול",
        body: "פיקדון בסך {deposit} מוקפא בכרטיס האשראי להבטחת השהייה — הקפאה בלבד, לא חיוב. בצ'ק אאוט ינוכו החיובים שנצברו, והיתרה תשוחרר על ידי חברת האשראי תוך 3-5 ימי עסקים. ביטול עד 24 שעות לפני מועד ההגעה — ללא חיוב." },
      { title: "מלון ללא עישון",
        body: "העישון אסור בכל שטחי המלון, לרבות החדרים והמרפסות. הפרה תחויב בדמי ניקוי בסך ₪1,500." },
      { title: "נכונות הפרטים",
        body: "האורח מאשר כי הפרטים שמסר — השם המלא, מספר ההזמנה, תאריכי השהייה ומסמך הזיהוי — נכונים ומדויקים." },
    ],
    en: [
      { title: "Liability for damages",
        body: "The guest is responsible for any damage caused to the room, its contents or the property of {hotel} during the stay, and will be charged the cost of repair or replacement." },
      { title: "Check-out time",
        body: "The room must be vacated by {checkout_time} on the day of departure. Late check-out is subject to availability and may incur an additional charge." },
      { title: "Deposit & cancellation policy",
        body: "A {deposit} deposit is held on your credit card to secure the stay — a hold only, not a charge. At check-out any accrued charges are deducted, and the remainder is released by your card issuer within 3–5 business days. Cancellation up to 24 hours before arrival is free of charge." },
      { title: "Non-smoking hotel",
        body: "Smoking is prohibited throughout the hotel, including guest rooms and balconies. A cleaning fee of ₪1,500 applies to any breach." },
      { title: "Accuracy of details",
        body: "The guest confirms that the details provided — full name, reservation number, stay dates and identity document — are true and accurate." },
    ],
  },

  // ── WiFi ──────────────────────────────────────────────
  wifi: { name: "Kempinski_Guest", password: "Welcome2024" },

  // ── Services ──────────────────────────────────────────
  // ⚠️ נתוני דוגמה (ראה האזהרה בראש הקובץ) — כל מלון מחליף בנתוניו.
  //
  // מבנה: services.<key>.<lang> = אובייקט שטוח של שדות. כל שדה מגיע
  // ל-AI *עם השם שלו* (buildPrompt → renderFields ב-bot.js), ולכן:
  // • אפשר להוסיף כאן שדה חדש בלי לגעת בקוד — הוא יגיע לבוט מסומן.
  // • שם השדה הוא חלק מהמידע. `price_range` נקרא לאורח כטווח מחירים;
  //   `price` כמחיר סופי. בחר את השם לפי המשמעות.
  // • רשימות (טיפולים, מנות) הן מערך של אובייקטים — כל פריט מרונדר
  //   כשורה עם *כל* השדות שלו יחד: שם + משך + מחיר. זה מה שמונע מה-AI
  //   לנחש איזה מחיר שייך לאיזה טיפול.
  //
  // ⚠️ שדות ש*קוד אחר* מסתמך עליהם (אל תמחק, אפשר לערוך):
  //   breakfast.hours/location, pool.hours/location, room_service.hours/dial
  //   — הודעת אישור הצ'ק אין (checkin.js) קוראת אותם ישירות.
  services: {
    breakfast: {
      en: {
        name:     "Breakfast",
        hours:    "07:00–11:00 (weekends and holidays until 11:30)",
        location: "The Garden Restaurant, Level 1",
        style:    "Full buffet — hot dishes, fresh pastries, cheeses, fish, made-to-order eggs and an espresso bar",
        price:    "Included in most room rates. If not included: ₪120 per adult, ₪60 per child aged 3–12, free under 3",
        dietary:  "Vegetarian, vegan and gluten-free options available at the buffet; kosher on request",
        note:     "Room-service breakfast is available at the same hours for an additional tray charge",
      },
      he: {
        name:     "ארוחת בוקר",
        hours:    "07:00–11:00 (בסופי שבוע וחגים עד 11:30)",
        location: "מסעדת הגן, קומה 1",
        style:    "בופה מלא — מנות חמות, מאפים טריים, גבינות, דגים, ביצים בהזמנה ובר אספרסו",
        price:    "כלולה ברוב תעריפי החדרים. אם אינה כלולה: ₪120 למבוגר, ₪60 לילד בגילאי 3–12, חינם עד גיל 3",
        dietary:  "אפשרויות צמחוניות, טבעוניות וללא גלוטן בבופה; כשר בתיאום מראש",
        note:     "ניתן להזמין ארוחת בוקר לחדר באותן שעות, בתוספת דמי מגש",
      },
    },

    pool: {
      en: {
        name:      "Rooftop Pool",
        hours:     "07:00–22:00, daily",
        location:  "Rooftop, Level 12",
        note:      "Heated year-round to 28°C",
        access:    "Complimentary for hotel guests — present your room key",
        amenities: "Towels, sun loungers and shaded cabanas provided at no charge; poolside bar service 10:00–19:00",
        children:  "Children under 14 must be accompanied by an adult at all times. No lifeguard on duty",
      },
      he: {
        name:      "בריכת הגג",
        hours:     "07:00–22:00, כל יום",
        location:  "גג, קומה 12",
        note:      "מחוממת כל השנה ל-28°C",
        access:    "ללא תשלום לאורחי המלון — יש להציג את כרטיס החדר",
        amenities: "מגבות, מיטות שיזוף וקבנות מוצלות ללא תשלום; שירות בר ליד הבריכה 10:00–19:00",
        children:  "ילדים מתחת לגיל 14 בליווי מבוגר בלבד. אין מציל בשירות",
      },
    },

    gym: {
      en: {
        name:             "Fitness Center",
        hours:            "Open 24/7 — access with your room key",
        location:         "Level 2",
        access:           "Complimentary for hotel guests",
        equipment:        "Technogym cardio machines, full strength circuit, free weights up to 40 kg, yoga mats and stretching area",
        classes:          "Yoga — Sun & Wed 07:00 | Pilates — Tue & Thu 08:00 | Complimentary, reserve at reception or ask me",
        personal_trainer: "₪280 per 60-minute session, by appointment — please book 24h in advance",
        amenities:        "Towels, chilled water and fruit provided; lockers and showers on the same floor",
        age_policy:       "Guests under 16 must be accompanied by an adult",
      },
      he: {
        name:             "מרכז הכושר",
        hours:            "פתוח 24/7 — כניסה עם כרטיס החדר",
        location:         "קומה 2",
        access:           "ללא תשלום לאורחי המלון",
        equipment:        "מכשירי קרדיו של Technogym, מעגל כוח מלא, משקולות חופשיות עד 40 ק\"ג, מזרני יוגה ואזור מתיחות",
        classes:          "יוגה — ראשון ורביעי 07:00 | פילאטיס — שלישי וחמישי 08:00 | ללא תשלום, בהרשמה בקבלה או דרכי",
        personal_trainer: "₪280 לאימון של 60 דקות, בתיאום מראש — יש להזמין 24 שעות מראש",
        amenities:        "מגבות, מים קרים ופירות ללא תשלום; לוקרים ומקלחות באותה קומה",
        age_policy:       "אורחים מתחת לגיל 16 בליווי מבוגר בלבד",
      },
    },

    spa: {
      en: {
        name:           "The Spa",
        hours:          "09:00–21:00, daily (last treatment starts at 20:00)",
        location:       "Level 3",
        booking:        "Ask me and I'll arrange it for you, or dial Ext. 205",
        booking_notice: "We recommend booking 24 hours ahead; same-day treatments are subject to availability",
        treatments: [
          { name: "Swedish massage",       duration: "60 min", price: "₪350" },
          { name: "Swedish massage",       duration: "90 min", price: "₪470" },
          { name: "Deep tissue massage",   duration: "60 min", price: "₪390" },
          { name: "Deep tissue massage",   duration: "90 min", price: "₪480" },
          { name: "Aromatherapy massage",  duration: "60 min", price: "₪380" },
          { name: "Hot stone massage",     duration: "75 min", price: "₪450" },
          { name: "Couples massage",       duration: "60 min", price: "₪680", note: "Price is for two people, in a private suite" },
          { name: "Signature facial",      duration: "50 min", price: "₪280" },
          { name: "Anti-aging facial",     duration: "75 min", price: "₪420" },
          { name: "Body scrub & wrap",     duration: "45 min", price: "₪320" },
          { name: "Manicure",              duration: "40 min", price: "₪160" },
          { name: "Pedicure",              duration: "50 min", price: "₪190" },
        ],
        facilities:   "Sauna, steam room, jacuzzi and relaxation lounge — complimentary for treatment guests, ₪90 per day otherwise",
        arrival:      "Please arrive 15 minutes before your appointment; robes and slippers are provided",
        cancellation: "Free cancellation up to 4 hours before the appointment. Later cancellations or no-shows are charged in full",
        age_policy:   "Treatments are for guests aged 16 and over",
      },
      he: {
        name:           "הספא",
        hours:          "09:00–21:00, כל יום (הטיפול האחרון מתחיל ב-20:00)",
        location:       "קומה 3",
        booking:        "אפשר לבקש ממני לתאם, או שלוחה 205",
        booking_notice: "מומלץ להזמין 24 שעות מראש; טיפולים באותו יום כפופים לזמינות",
        treatments: [
          { name: "עיסוי שוודי",          duration: "60 דקות", price: "₪350" },
          { name: "עיסוי שוודי",          duration: "90 דקות", price: "₪470" },
          { name: "עיסוי רקמות עומק",     duration: "60 דקות", price: "₪390" },
          { name: "עיסוי רקמות עומק",     duration: "90 דקות", price: "₪480" },
          { name: "עיסוי ארומתרפי",       duration: "60 דקות", price: "₪380" },
          { name: "עיסוי אבנים חמות",     duration: "75 דקות", price: "₪450" },
          { name: "עיסוי זוגי",           duration: "60 דקות", price: "₪680", note: "המחיר לשני אנשים, בסוויטה פרטית" },
          { name: "טיפול פנים",           duration: "50 דקות", price: "₪280" },
          { name: "טיפול פנים אנטי-אייג'ינג", duration: "75 דקות", price: "₪420" },
          { name: "פילינג ועטיפת גוף",    duration: "45 דקות", price: "₪320" },
          { name: "מניקור",               duration: "40 דקות", price: "₪160" },
          { name: "פדיקור",               duration: "50 דקות", price: "₪190" },
        ],
        facilities:   "סאונה, חדר אדים, ג'קוזי וטרקלין רגיעה — ללא תשלום למקבלי טיפול, ₪90 ליום ללא טיפול",
        arrival:      "נא להגיע 15 דקות לפני מועד הטיפול; חלוק ונעלי בית מסופקים במקום",
        cancellation: "ביטול ללא תשלום עד 4 שעות לפני הטיפול. ביטול מאוחר יותר או אי-הגעה יחויבו במלוא הסכום",
        age_policy:   "הטיפולים מגיל 16 ומעלה",
      },
    },

    restaurant: {
      en: {
        name:         "The Garden Restaurant",
        cuisine:      "Mediterranean & International",
        hours:        "Breakfast 07:00–11:00 | Lunch 12:00–16:00 | Dinner 18:00–23:00 (kitchen closes 22:30)",
        location:     "Level 1, overlooking the garden",
        price_range:  "Starters ₪45–₪85 | Main courses ₪90–₪180 | Desserts ₪45–₪60 | Chef's tasting menu ₪320 per person",
        reservations: "Ask me and I'll book a table for you, or dial Ext. 210",
        dress_code:   "Smart casual",
        dietary:      "Vegetarian, vegan and gluten-free dishes on the regular menu; kosher menu by advance arrangement",
        note:         "Dinner reservations are recommended, especially Thursday to Saturday",
      },
      he: {
        name:         "מסעדת הגן",
        cuisine:      "ים תיכונית ובינלאומית",
        hours:        "ארוחת בוקר 07:00–11:00 | צהריים 12:00–16:00 | ערב 18:00–23:00 (המטבח נסגר ב-22:30)",
        location:     "קומה 1, עם נוף לגן",
        price_range:  "מנות ראשונות ₪45–₪85 | מנות עיקריות ₪90–₪180 | קינוחים ₪45–₪60 | תפריט טעימות של השף ₪320 לאדם",
        reservations: "אפשר לבקש ממני להזמין שולחן, או שלוחה 210",
        dress_code:   "לבוש מכובד-חופשי",
        dietary:      "מנות צמחוניות, טבעוניות וללא גלוטן בתפריט הרגיל; תפריט כשר בתיאום מראש",
        note:         "מומלץ להזמין שולחן לארוחת ערב, במיוחד מחמישי עד שבת",
      },
    },

    bar: {
      en: {
        name:        "Sky Bar",
        hours:       "17:00–01:00 (Friday & Saturday until 02:00)",
        location:    "Rooftop, Level 12",
        note:        "Smart-casual dress code",
        price_range: "Cocktails ₪58–₪75 | Wine by the glass ₪42–₪70 | Bar bites ₪38–₪70",
        happy_hour:  "17:00–19:00 daily — 1+1 on cocktails and draught beer",
        age_policy:  "Guests aged 18 and over after 20:00",
      },
      he: {
        name:        "סקיי בר",
        hours:       "17:00–01:00 (שישי ושבת עד 02:00)",
        location:    "גג, קומה 12",
        note:        "לבוש מכובד נדרש",
        price_range: "קוקטיילים ₪58–₪75 | יין בכוס ₪42–₪70 | מנות בר ₪38–₪70",
        happy_hour:  "17:00–19:00 כל יום — 1+1 על קוקטיילים ובירה מהחבית",
        age_policy:  "מגיל 18 ומעלה אחרי השעה 20:00",
      },
    },

    room_service: {
      en: {
        name:           "In-Room Dining",
        hours:          "24/7",
        dial:           "Ext. 0",
        how_to_order:   "Dial Ext. 0, or tell me what you'd like and I'll pass it on",
        delivery_time:  "30–45 minutes for hot dishes, 15–20 minutes for drinks and snacks",
        price_range:    "Breakfast ₪120 | Sandwiches & salads ₪60–₪95 | Hot main courses ₪95–₪160 | Desserts ₪45",
        service_charge: "₪25 tray charge per order, added to your room bill",
        night_menu:     "A reduced menu (sandwiches, salads, soups and desserts) is served between 23:00 and 06:00",
      },
      he: {
        name:           "שירות חדרים",
        hours:          "24/7",
        dial:           "שלוחה 0",
        how_to_order:   "שלוחה 0, או פשוט תגיד/י לי מה בא לך ואעביר הלאה",
        delivery_time:  "30–45 דקות למנות חמות, 15–20 דקות למשקאות ונשנושים",
        price_range:    "ארוחת בוקר ₪120 | כריכים וסלטים ₪60–₪95 | מנות עיקריות חמות ₪95–₪160 | קינוחים ₪45",
        service_charge: "דמי מגש ₪25 להזמנה, מתווספים לחשבון החדר",
        night_menu:     "בין 23:00 ל-06:00 מוגש תפריט מצומצם (כריכים, סלטים, מרקים וקינוחים)",
      },
    },

    laundry: {
      en: {
        name:         "Laundry & Dry Cleaning",
        hours:        "Collection 08:00–18:00, daily (no collection on Saturdays)",
        how_to_order: "Fill in the form in the laundry bag in your wardrobe and dial Ext. 0 for collection — or just ask me",
        turnaround:   "Same day if collected before 10:00; otherwise returned the next day by 18:00",
        express:      "Express 4-hour service — 50% surcharge",
        price_range:  "Shirt ₪25 | Trousers ₪35 | Dress ₪55 | Suit ₪90 | Wash & fold ₪60 per kg",
        note:         "Ironing only: ₪18 per item. We are not liable for items without a care label",
      },
      he: {
        name:         "כביסה וניקוי יבש",
        hours:        "איסוף 08:00–18:00, כל יום (ללא איסוף בשבת)",
        how_to_order: "יש למלא את הטופס בשקית הכביסה שבארון ולחייג לשלוחה 0 לאיסוף — או פשוט לבקש ממני",
        turnaround:   "החזרה באותו יום אם נאסף לפני 10:00; אחרת למחרת עד 18:00",
        express:      "שירות אקספרס תוך 4 שעות — תוספת 50%",
        price_range:  "חולצה ₪25 | מכנסיים ₪35 | שמלה ₪55 | חליפה ₪90 | כביסה וקיפול ₪60 לק\"ג",
        note:         "גיהוץ בלבד: ₪18 לפריט. איננו אחראים לפריטים ללא תווית הוראות כביסה",
      },
    },
  },

  // ── Parking ───────────────────────────────────────────
  // ⚠️ נתוני דוגמה — להחלפה בנתוני החניון האמיתיים.
  parking: {
    available: true,
    en: {
      type:         "Underground valet parking",
      price:        "₪65 per night for hotel guests | ₪90 per night for visitors",
      hours:        "Valet service 24/7 at the main entrance",
      location:     "Levels -1 and -2, direct lift access to all floors",
      ev_charging:  "6 bays — ₪0.60 per kWh, first come first served",
      height_limit: "Vehicle height limit 2.1 m",
      note:         "Please notify reception upon arrival and provide your vehicle plate number",
    },
    he: {
      type:         "חניון תת-קרקעי עם ואלה",
      price:        "₪65 ללילה לאורחי המלון | ₪90 ללילה למבקרים",
      hours:        "שירות ואלה 24/7 בכניסה הראשית",
      location:     "קומות -1 ו--2, גישה ישירה במעלית לכל הקומות",
      ev_charging:  "6 עמדות — ₪0.60 לקוט\"ש, כל הקודם זוכה",
      height_limit: "גובה רכב מרבי 2.1 מ'",
      note:         "אנא הודע/י לקבלה עם הגעתך ומסור/י את מספר הרכב",
    },
  },

  // ── FAQ ───────────────────────────────────────────────
  // ⚠️ נתוני דוגמה — להחלפה במדיניות האמיתית של המלון.
  faq: [
    {
      en: { q: "Pets policy?",         a: "We do not accommodate pets, with the exception of certified service animals." },
      he: { q: "מדיניות חיות מחמד?",  a: "לצערנו, חיות מחמד אינן מורשות, למעט כלבי שירות מוסמכים." },
    },
    {
      en: { q: "Airport transfer?",    a: "We offer private transfers to Ben Gurion Airport. Please book 24h in advance via reception. Rate from ₪180." },
      he: { q: "הסעה לשדה התעופה?",   a: "אנו מציעים העברות פרטיות לנתב\"ג. יש לתאם 24 שעות מראש דרך הקבלה. החל מ-180₪." },
    },
    {
      en: { q: "Accessible rooms?",    a: "We have 6 fully accessible rooms with adaptive equipment. Please mention during booking." },
      he: { q: "חדרי נגישות?",         a: "יש לנו 6 חדרים נגישים מלאים עם ציוד מותאם. אנא ציין בעת ההזמנה." },
    },
    {
      en: { q: "Kosher food?",         a: "Our restaurant offers a kosher menu by advance arrangement. Contact concierge." },
      he: { q: "אוכל כשר?",            a: "המסעדה מציעה תפריט כשר בתיאום מראש. פנה לקונסיירז'." },
    },
    {
      en: { q: "Business center?",     a: "Our business center is open 24/7, Level 1. Printing, scanning and meeting rooms available." },
      he: { q: "מרכז עסקים?",          a: "מרכז העסקים פתוח 24/7, קומה 1. הדפסה, סריקה וחדרי ישיבות זמינים." },
    },
    {
      en: { q: "Luggage storage?",     a: "Complimentary luggage storage is available at reception before check-in and after check-out, on the day of arrival or departure." },
      he: { q: "אחסון מזוודות?",       a: "אחסון מזוודות ללא תשלום בקבלה, לפני הצ'ק אין ואחרי הצ'ק אאוט, ביום ההגעה או העזיבה." },
    },
    {
      en: { q: "Is there a minibar?",  a: "Every room has a stocked minibar. Items consumed are added to your room bill; soft drinks from ₪18, snacks from ₪22." },
      he: { q: "יש מיני בר בחדר?",     a: "בכל חדר מיני בר מאובזר. פריטים שנצרכו מתווספים לחשבון החדר; משקאות קלים החל מ-₪18, חטיפים החל מ-₪22." },
    },
  ],

  // ── Welcome messages ──────────────────────────────────
  welcome: {
    en: `Welcome to *Kempinski Hotel* ✨

I'm your personal AI concierge, available 24/7.

I can help you with:
🏨 Check-in & Check-out
🍳 Dining & reservations
🏊 Pool, Spa & Gym
🅿️ Parking
🛎️ Housekeeping requests
💡 Any question about your stay

How may I assist you today?`,

    he: `ברוכים הבאים ל*מלון קמפינסקי* ✨

אני הקונסיירז' הדיגיטלי שלכם, זמין 24/7.

אוכל לעזור לכם ב:
🏨 צ'ק אין וצ'ק אאוט
🍳 מסעדה והזמנות
🏊 בריכה, ספא וחדר כושר
🅿️ חניה
🛎️ בקשות ניקיון ואחזקה
💡 כל שאלה על שהייתכם

במה אוכל לעזור?`,
  },
};

// ── מיזוג עמוק ─────────────────────────────────────────
// כללים:
// • אובייקט רגיל → ממוזג רקורסיבית (שדה בודד לא מוחק את אחיו).
// • מערך → מוחלף כמכלול. אין מיזוג לפי אינדקס: "עדכן את הטיפול השני"
//   דרך מיזוג-אינדקסים הוא מלכודת (סדר משתנה → מחיר עובר לטיפול אחר).
//   מי שמעדכן רשימה שולח את הרשימה המלאה.
// • null → מאפס שדה במפורש (כך אפשר להסיר ערך שירש מברירת המחדל).
// • undefined → מדלגים; הערך הקיים נשמר.
function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// מפתחות שלעולם לא ממזגים — patch מה-API הוא קלט חיצוני, ו-`__proto__`
// בתוכו היה משנה את שרשרת הפרוטוטייפ במקום שדה קונפיג (prototype pollution).
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(k) || v === undefined) continue;
    out[k] = isPlainObject(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}

// ── טעינת ה-overrides מה-DB ────────────────────────────
function loadOverrides() {
  try {
    const row = db.prepare(`SELECT data FROM config WHERE hotel_id = ?`).get(HOTEL);
    const parsed = row?.data ? JSON.parse(row.data) : null;
    return isPlainObject(parsed) ? parsed : {};
  } catch (e) {
    // קונפיג פגום ב-DB לא יפיל את הבוט — נופלים לברירות המחדל שבקוד.
    console.error("⚠️ טעינת overrides של הקונפיג נכשלה — ממשיכים עם ברירות המחדל:", e?.message || e);
    return {};
  }
}

const persistStmt = db.prepare(`
  INSERT INTO config (hotel_id, data, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(hotel_id) DO UPDATE SET
    data       = excluded.data,
    updated_at = excluded.updated_at
`);

let overrides = loadOverrides();

// structuredClone: hotelConfig מקבל עותק עצמאי לגמרי, כך ש-DEFAULTS
// נשאר נקי גם אם מישהו ישנה את hotelConfig במקום.
export let hotelConfig = deepMerge(structuredClone(DEFAULTS), overrides);

// ── עדכון קונפיג — ממוזג עמוק ונשמר ל-DB ───────────────
// זורק אם ה-patch אינו אובייקט או אם השמירה נכשלה — הקורא (server.js)
// מחזיר שגיאה ללקוח. אסור לאשר "נשמר" כשלא נשמר.
export function updateConfig(patch) {
  if (!isPlainObject(patch)) {
    throw new TypeError("updateConfig expects a plain object");
  }
  const nextOverrides = deepMerge(overrides, patch);
  persistStmt.run(HOTEL, JSON.stringify(nextOverrides), new Date().toISOString());
  overrides   = nextOverrides;
  hotelConfig = deepMerge(structuredClone(DEFAULTS), overrides);
  return hotelConfig;
}

// ── איפוס לברירות המחדל שבקוד ──────────────────────────
// מוחק את כל ה-overrides. משמש איפוס דמו/סביבת בדיקה.
export function resetConfig() {
  db.prepare(`DELETE FROM config WHERE hotel_id = ?`).run(HOTEL);
  overrides   = {};
  hotelConfig = deepMerge(structuredClone(DEFAULTS), overrides);
  return hotelConfig;
}

// ה-overrides בלבד (מה שנערך מעל הקוד) — לצורכי דיבוג/דשבורד.
export function configOverrides() {
  return structuredClone(overrides);
}
