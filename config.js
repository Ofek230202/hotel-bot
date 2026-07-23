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
  room_service_number: "whatsapp:+9724445566",    // שירות חדרים — אוכל/שתייה לחדר

  // ── Internal contacts (Email per department) ─────────
  housekeeping_email: "housekeeping@kempinski-demo.co.il",
  reception_email:    "reception@kempinski-demo.co.il",
  maintenance_email:  "maintenance@kempinski-demo.co.il",
  concierge_email:    "concierge@kempinski-demo.co.il",
  security_email:     "security@kempinski-demo.co.il",
  room_service_email: "roomservice@kempinski-demo.co.il",

  // ── Timing ───────────────────────────────────────────
  checkin_time:  "15:00",
  checkout_time: "12:00",
  early_checkin: true,
  late_checkout: true,

  // ── Location (מיקום המלון — למנוע חיפוש המקומות של הקונסיירז') ──
  // ⚠️⚠️ נתוני דוגמה — כל מלון *חייב* להזין את המיקום האמיתי שלו ⚠️⚠️
  //
  // המיקום הזה הוא מרכז החיפוש של הקונסיירז' ב-Google Places: כשאורח
  // מבקש "מסעדת בשר בקרבת מקום", הבוט מחפש מקומות אמיתיים סביב הקואורדינטות
  // האלה (places/). קואורדינטות שגויות = המלצות במקום הלא נכון.
  //
  // • address — כתובת מלאה לקריאה (מוצגת לאורח כהקשר, לא לחיפוש).
  // • lat / lng — קו רוחב/אורך עשרוניים. הדרך הקלה להשיג: לחיפוש המלון
  //   ב-Google Maps, לחיצה ימנית על הסיכה → הקואורדינטות מועתקות.
  // • search_radius_m — רדיוס החיפוש במטרים (ברירת מחדל 4000 = 4 ק״מ).
  //
  // 🔴 הקואורדינטות כאן היו שגויות ב-1.7 ק״מ (32.09 / 34.77 — אזור נמל
  //    תל אביב, לא המלון). המשמעות: כל המלצה "בקרבת מקום" של הקונסיירז'
  //    נמדדה ממקום אחר, ואורח נשלח למסעדה שהמרחק אליה שגוי לחלוטין.
  //    אומת מול העמוד הרשמי של Kempinski, Google Maps ו-OSM:
  //    המלון נמצא ברחוב הירקון 51, תל אביב-יפו, מיקוד 6343203.
  location: {
    address:         "51 HaYarkon Street, Tel Aviv-Yafo 6343203, Israel (The David Kempinski Tel Aviv)",
    address_he:      "רחוב הירקון 51, תל אביב-יפו — מלון דוד קמפינסקי תל אביב",
    lat:             32.0746,
    lng:             34.7661,
    search_radius_m: 3000,
  },

  // ── Building / layout (מבנה המלון) ───────────────────
  // ⚠️ נתוני דוגמה — כל מלון מזין את המבנה האמיתי שלו. אבל *ידע בסיסי*
  //    חייב להיות כאן כדי שהבוט לא ישאל את האורח שאלות מגוחכות ("באיזו
  //    קומה הלובי?"). הבוט הוא איש צוות — הוא *יודע* את מבנה המלון.
  //    הכללים הגנריים (לובי וקבלה בקומת הקרקע) כתובים גם ב-prompt כברירת
  //    מחדל, כך שגם מלון שלא ימלא את הסעיף הזה עדיין לא ישאל שטויות.
  building: {
    en: {
      floors:        "12 guest floors above ground, plus 2 underground parking levels (-1, -2)",
      lobby:         "The lobby is on the ground floor (Level 0), at the main entrance",
      reception:     "The front desk / reception is in the lobby, ground floor, staffed 24/7",
      elevators:     "Four guest lifts by the lobby serve all floors, including the parking levels",
      accessibility: "Step-free access from the main entrance; accessible lifts and 6 accessible rooms",
      key_areas:     "Restaurant & breakfast Level 1 · Fitness Level 2 · Spa Level 3 · Pool & Sky Bar rooftop Level 12 · Business centre Level 1",
    },
    he: {
      floors:        "12 קומות אירוח מעל הקרקע, ועוד 2 קומות חניון תת-קרקעי (‎-1, ‎-2)",
      lobby:         "הלובי נמצא בקומת הקרקע (קומה 0), בכניסה הראשית",
      reception:     "דלפק הקבלה נמצא בלובי, בקומת הקרקע, ומאויש 24/7",
      elevators:     "ארבע מעליות אורחים ליד הלובי משרתות את כל הקומות, כולל קומות החניון",
      accessibility: "גישה נטולת מדרגות מהכניסה הראשית; מעליות נגישות ו-6 חדרים נגישים",
      key_areas:     "מסעדה וארוחת בוקר קומה 1 · חדר כושר קומה 2 · ספא קומה 3 · בריכה וסקיי בר בגג קומה 12 · מרכז עסקים קומה 1",
    },
  },

  // ── Deposit ───────────────────────────────────────────
  // סכום פיקדון השהייה, באגורות (50000 = ₪500). מקור אמת אחד: משמש
  // את שכבת התשלום (checkin.js), את הסבר הפיקדון ואת תנאי השהייה —
  // כדי שהסכום שהאורח מאשר בתנאים יהיה תמיד הסכום שבאמת מוקפא.
  deposit_amount: 50000,

  // ── ID document policy (מדיניות מסמכי זיהוי) ───────────
  // ⚠️ קריטי לפרטיות. ברירת המחדל היא **verify-then-discard**: הבוט
  //    מאמת את המסמך, מחלץ *רק את השדות הנדרשים*, ומוחק את התמונה מיד.
  //    זו העמדה המתכנסת של כל רשויות הפרטיות שנבדקו (CNIL/AEPD/Garante/
  //    DPC + הרשות הישראלית) — ראה SECURITY.md §0. אל תשמור תמונה בלי סיבה.
  //
  //    מלון רשאי לשמור את התמונה *רק* אם יש לו **בסיס חוקי מתועד**
  //    (למשל תיעוד תייר חוץ ל-מע"מ 0%, חוק מע"מ §30(א)(8)). אז — ורק
  //    אז — קובעים `retain_image: true` **וגם** `legal_basis`, והתמונה
  //    נשמרת מוצפנת, עם retention אוטומטי ו-audit על כל גישה.
  id_policy: {
    retain_image:  false,   // ברירת מחדל תואמת-רגולציה: לא שומרים תמונה
    legal_basis:   null,    // חובה כש-retain_image=true, אחרת השמירה נחסמת
    retention_days: 30,     // רלוונטי רק כששומרים; מומלץ לצמצם למינימום
    // השדות המינימליים שמחלצים ושומרים במקום התמונה (מינימיזציית נתונים).
    // רק מה שהמלון באמת צריך לפנקס האורחים — לא כתובת/חתימה/תמונת פנים.
    extract_fields: ["full_name", "document_type", "document_number", "nationality", "date_of_birth", "expiry_date"],
  },

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
    // ⚠️ כל שינוי בנוסח מחייב version חדש — ה-version נשמר על ההזמנה
    //    יחד עם רגע האישור, וזו הראיה היחידה ל*מה* האורח אישר בפועל.
    //    demo-2026-02: תוקן סעיף הפיקדון, שהבטיח "היתרה תשוחרר" גם
    //    כשאין יתרה (חיובים מעל הפיקדון). ראה ההערה בסעיף עצמו.
    version: "demo-2026-02",
    he: [
      { title: "אחריות לנזקים",
        body: "האורח אחראי לכל נזק שייגרם לחדר, לתכולתו או לרכוש {hotel} במהלך שהייתו, ויחויב בעלות התיקון או ההחלפה." },
      { title: "שעת צ'ק אאוט",
        body: "יש לפנות את החדר עד השעה {checkout_time} ביום העזיבה. צ'ק אאוט מאוחר כפוף לזמינות ועשוי להיות כרוך בתשלום נוסף." },
      // ⚠️ הנוסח הקודם הבטיח "ינוכו החיובים והיתרה תשוחרר" — כאילו תמיד
      //    נשארת יתרה. כשהחיובים גבוהים מהפיקדון אין שום יתרה, ולהפך:
      //    המלון מחייב את ההפרש. תנאי שהייה שסותרים את מה שהמערכת עושה
      //    בפועל הם הבטחה שגויה לאורח. שלושת המקרים כתובים כאן במפורש,
      //    בדיוק כמו ב-depositExplainer (checkin.js) — אותו מידע, אותו נוסח.
      { title: "פיקדון ומדיניות ביטול",
        body: "פיקדון בסך {deposit} מוקפא בכרטיס האשראי להבטחת השהייה — הקפאה בלבד, לא חיוב. בצ'ק אאוט: אם לא נצברו חיובים — לא יבוצע חיוב, וההקפאה תשוחרר על ידי חברת האשראי תוך 3-5 ימי עסקים. אם נצברו חיובים — הם ינוכו מהפיקדון, ויתרת הפיקדון (אם נותרה) תשוחרר באותו אופן. אם החיובים גבוהים מהפיקדון — הפיקדון ינוכה במלואו, וההפרש יחויב בנפרד מאותו כרטיס אשראי. ביטול עד 24 שעות לפני מועד ההגעה — ללא חיוב." },
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
      // ⚠️ See the note on the Hebrew clause above — all three outcomes must
      //    be stated, including the one where charges exceed the deposit.
      { title: "Deposit & cancellation policy",
        body: "A {deposit} deposit is held on your credit card to secure the stay — a hold only, not a charge. At check-out: if no charges were accrued, nothing is charged and the hold is released by your card issuer within 3–5 business days. If charges were accrued, they are deducted from the deposit, and any remaining balance is released the same way. If the charges exceed the deposit, the deposit is deducted in full and the difference is charged separately to the same card. Cancellation up to 24 hours before arrival is free of charge." },
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
        depth:     "1.2 m to 1.8 m; there is no shallow children's pool",
        lifeguard: "A certified lifeguard is on duty 09:00–19:00. Outside those hours swimming is at your own risk and is not recommended",
        children:  "Children under 14 must be accompanied and actively supervised by an adult at all times, whether or not a lifeguard is on duty",
        safety:    "Please shower before entering, no diving and no running on the wet deck, and no glassware at the poolside. A ring buoy and a first-aid station are by the lifeguard chair, and a house phone by the entrance reaches security immediately",
      },
      he: {
        name:      "בריכת הגג",
        hours:     "07:00–22:00, כל יום",
        location:  "גג, קומה 12",
        note:      "מחוממת כל השנה ל-28°C",
        access:    "ללא תשלום לאורחי המלון — יש להציג את כרטיס החדר",
        amenities: "מגבות, מיטות שיזוף וקבנות מוצלות ללא תשלום; שירות בר ליד הבריכה 10:00–19:00",
        depth:     "עומק 1.2 מ' עד 1.8 מ'; אין בריכת פעוטות נפרדת",
        lifeguard: "מציל מוסמך בשירות בין 09:00 ל-19:00. מחוץ לשעות אלה הרחצה באחריות האורח ואינה מומלצת",
        children:  "ילדים מתחת לגיל 14 בליווי והשגחה פעילה של מבוגר בכל עת, בין אם יש מציל בשירות ובין אם לא",
        safety:    "יש להתקלח לפני הכניסה למים, אין לקפוץ ראש ואין לרוץ על הדק הרטוב, ואין להכניס כלי זכוכית לאזור הבריכה. גלגל הצלה ועמדת עזרה ראשונה נמצאים ליד כיסא המציל, וטלפון פנימי ליד הכניסה מחובר ישירות למוקד הביטחון",
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
        // ⚠️ כלל שנוגע לאיך שהמחיר נקרא לאורח: מחיר טיפול הוא *לאדם אחד*,
        //    אלא אם הפריט אומר אחרת ב-note. בלי המשפט הזה ה-AI הציג "₪680"
        //    ליד "עיסוי זוגי" בלי הקשר, והאורח קרא את זה כמחיר לאדם.
        price_note:     "Every price below is for one person, unless the treatment says otherwise",
        treatments: [
          { name: "Swedish massage",       duration: "60 min", price: "₪350" },
          { name: "Swedish massage",       duration: "90 min", price: "₪470" },
          { name: "Deep tissue massage",   duration: "60 min", price: "₪390" },
          { name: "Deep tissue massage",   duration: "90 min", price: "₪480" },
          { name: "Aromatherapy massage",  duration: "60 min", price: "₪380" },
          { name: "Hot stone massage",     duration: "75 min", price: "₪450" },
          { name: "Couples massage",       duration: "60 min", price: "₪680",
            note: "For two people together — two therapists working side by side in our couples treatment room. ₪680 total, i.e. ₪340 per person" },
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
        // ⚠️ ראה ההערה בגרסה האנגלית — המחיר הוא לאדם אחד אלא אם נכתב אחרת.
        price_note:     "כל המחירים למטה הם לאדם אחד, אלא אם כתוב אחרת בטיפול עצמו",
        treatments: [
          { name: "עיסוי שוודי",          duration: "60 דקות", price: "₪350" },
          { name: "עיסוי שוודי",          duration: "90 דקות", price: "₪470" },
          { name: "עיסוי רקמות עמוק",     duration: "60 דקות", price: "₪390" },
          { name: "עיסוי רקמות עמוק",     duration: "90 דקות", price: "₪480" },
          { name: "עיסוי ארומתרפי",       duration: "60 דקות", price: "₪380" },
          { name: "עיסוי אבנים חמות",     duration: "75 דקות", price: "₪450" },
          { name: "עיסוי זוגי",           duration: "60 דקות", price: "₪680",
            note: "לשני אנשים יחד — שני מטפלים במקביל, בחדר טיפולים זוגי. ₪680 סה\"כ, כלומר ₪340 לאדם" },
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
        // ⚠️⚠️ SAMPLE MENU — every hotel replaces this with its real one ⚠️⚠️
        // 🔴 Why the menu lives in the config at all: a guest who wrote "I'd
        //    like pasta" got "I'm passing that to room service" — with no
        //    dish, no sauce, no size. The kitchen cannot cook that. A waiter
        //    asks *which* pasta and *which* sauce, and to do that the bot has
        //    to know the menu. Anything not written here, it must not invent.
        menu: {
          starters: [
            { name: "Jerusalem artichoke soup", description: "With toasted hazelnuts and truffle oil", price: "₪48" },
            { name: "Beef carpaccio", description: "Rocket, aged parmesan, lemon", price: "₪72" },
            { name: "Hummus & lamb kebab", description: "Warm pita, pickles", price: "₪64" },
          ],
          salads: [
            { name: "Kempinski chopped salad", description: "Tomato, cucumber, herbs, olive oil", price: "₪58", options: "Add: grilled chicken ₪28 · goat cheese ₪22 · avocado ₪14" },
            { name: "Caesar salad", description: "Cos lettuce, croutons, anchovy dressing", price: "₪68", options: "Add: chicken ₪28 · salmon ₪38 · without anchovy on request" },
          ],
          pasta: [
            {
              name: "Fresh linguine",
              description: "Made in-house daily",
              price: "₪86",
              options: "Choice of sauce: rosé · fresh tomato & basil · mushroom cream · aglio e olio. " +
                       "Optional additions: chicken breast ₪28 · shrimp ₪42 · extra parmesan ₪12. " +
                       "Available as a half portion (₪62) and in a gluten-free pasta (₪12)",
            },
            { name: "Truffle ravioli", description: "Ricotta and spinach filling, butter-sage sauce", price: "₪98", options: "Vegetarian. Cream-free version on request" },
          ],
          mains: [
            { name: "Entrecôte 300 g", description: "Served with roast potatoes and grilled vegetables", price: "₪186", options: "Cooked to your preference: rare · medium rare · medium · well done. Sauce: peppercorn · red wine · none" },
            { name: "Sea bass fillet", description: "Lemon, olive oil, seasonal greens", price: "₪148", options: "Side choice: mashed potato · rice · green salad" },
            { name: "Chicken schnitzel", description: "The children's favourite, with chips", price: "₪86", options: "Also available grilled instead of fried" },
            { name: "Club sandwich", description: "Chicken, egg, tomato, chips on the side", price: "₪78", options: "Bread choice: white · wholemeal · gluten-free (₪8)" },
          ],
          desserts: [
            { name: "Chocolate fondant", description: "Warm centre, vanilla ice cream", price: "₪52", options: "Takes 15 minutes to prepare" },
            { name: "Seasonal fruit plate", description: "Whatever the market had this morning", price: "₪46" },
          ],
          drinks: [
            { name: "Espresso / cappuccino / filter coffee", price: "₪18–₪26" },
            { name: "Fresh orange juice", price: "₪28" },
            { name: "House wine, by the glass", price: "₪42", options: "Red · white · rosé" },
            { name: "Beer / soft drinks / mineral water", price: "₪16–₪34" },
          ],
        },
      },
      he: {
        name:           "שירות חדרים",
        hours:          "24/7",
        dial:           "שלוחה 0",
        how_to_order:   "שלוחה 0, או פשוט לספר לי מה בא לך ואעביר את ההזמנה",
        delivery_time:  "30–45 דקות למנות חמות, 15–20 דקות למשקאות ונשנושים",
        price_range:    "ארוחת בוקר ₪120 | כריכים וסלטים ₪60–₪95 | מנות עיקריות חמות ₪95–₪160 | קינוחים ₪45",
        service_charge: "דמי מגש ₪25 להזמנה, מתווספים לחשבון החדר",
        night_menu:     "בין 23:00 ל-06:00 מוגש תפריט מצומצם (כריכים, סלטים, מרקים וקינוחים)",
        // ⚠️⚠️ תפריט לדוגמה — כל מלון מחליף אותו בתפריט האמיתי שלו ⚠️⚠️
        // 🔴 למה התפריט יושב בקונפיג: אורח שכתב "אשמח לפסטה" קיבל "מעביר
        //    לשירות החדרים" — בלי סוג, בלי רוטב, בלי גודל. במטבח אי אפשר
        //    לבשל את זה. מלצר שואל *איזו* פסטה ו*איזה* רוטב, וכדי לשאול
        //    הבוט חייב להכיר את התפריט. מה שלא כתוב כאן — אסור לו להמציא.
        menu: {
          starters: [
            { name: "מרק ארטישוק ירושלמי", description: "עם אגוזי לוז קלויים ושמן כמהין", price: "₪48" },
            { name: "קרפצ'יו בקר", description: "רוקט, פרמזן מיושן, לימון", price: "₪72" },
            { name: "חומוס וקבב טלה", description: "פיתה חמה וחמוצים", price: "₪64" },
          ],
          salads: [
            { name: "סלט קמפינסקי קצוץ", description: "עגבנייה, מלפפון, עשבי תיבול, שמן זית", price: "₪58", options: "תוספות: חזה עוף בגריל ₪28 · גבינת עיזים ₪22 · אבוקדו ₪14" },
            { name: "סלט קיסר", description: "חסה רומית, קרוטונים, רוטב אנשובי", price: "₪68", options: "תוספות: עוף ₪28 · סלמון ₪38 · אפשר גם בלי אנשובי" },
          ],
          pasta: [
            {
              name: "לינגוויני טרי",
              description: "נעשה במטבח שלנו כל בוקר",
              price: "₪86",
              options: "בחירת רוטב: רוזה · עגבניות ובזיליקום · שמנת פטריות · אליו אוליו. " +
                       "תוספות: חזה עוף ₪28 · שרימפס ₪42 · פרמזן נוסף ₪12." +
                       "אפשר גם במנה חצי (₪62) ובפסטה ללא גלוטן (₪12)",
            },
            { name: "רביולי כמהין", description: "מילוי ריקוטה ותרד, רוטב חמאה ומרווה", price: "₪98", options: "צמחוני. אפשר גם בגרסה בלי שמנת" },
          ],
          mains: [
            { name: "אנטרקוט 300 גרם", description: "מוגש עם תפוחי אדמה צלויים וירקות בגריל", price: "₪186", options: "מידת עשייה: נא · מדיום רייר · מדיום · עשוי היטב. רוטב: פלפלת · יין אדום · בלי" },
            { name: "פילה לברק", description: "לימון, שמן זית וירק העונה", price: "₪148", options: "בחירת תוספת: פירה · אורז · סלט ירוק" },
            { name: "שניצל עוף", description: "האהוב על הילדים, עם צ'יפס", price: "₪86", options: "אפשר גם בגריל במקום מטוגן" },
            { name: "כריך קלאב", description: "עוף, ביצה, עגבנייה, צ'יפס בצד", price: "₪78", options: "בחירת לחם: לבן · מלא · ללא גלוטן (₪8)" },
          ],
          desserts: [
            { name: "פונדנט שוקולד", description: "לב חם, גלידת וניל", price: "₪52", options: "זמן הכנה 15 דקות" },
            { name: "מגש פירות העונה", description: "מה שהיה הבוקר בשוק", price: "₪46" },
          ],
          drinks: [
            { name: "אספרסו / קפוצ'ינו / קפה פילטר", price: "₪18–₪26" },
            { name: "מיץ תפוזים סחוט", price: "₪28" },
            { name: "יין הבית, בכוס", price: "₪42", options: "אדום · לבן · רוזה" },
            { name: "בירה / שתייה קלה / מים מינרליים", price: "₪16–₪34" },
          ],
        },
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
      note:         "נא להודיע לקבלה עם ההגעה ולמסור את מספר הרכב",
    },
  },

  // ── Local area (ידע הקונסיירז' על הסביבה) ─────────────
  // ⚠️⚠️ נתוני דמו במלואם — מלון, מסעדות, מחירים ומרחקים בדויים ⚠️⚠️
  //
  // זה מקור הידע היחיד של הקונסיירז' על *מחוץ* למלון. הבוט מצטט מכאן
  // לאורח כעובדה ("10 דקות הליכה, ₪90–₪140 לסועד") — בדיוק כמו services.
  // מלון אמיתי חייב להחליף את כל הסעיף בהמלצות שהוא באמת עומד מאחוריהן.
  //
  // המבנה זהה ל-services: אובייקט שטוח של שדות + רשימות של פריטים. כל
  // שדה מגיע ל-AI עם התווית שלו (buildPrompt → renderFields ב-bot.js),
  // ולכן אפשר להוסיף כאן קטגוריה חדשה ("גלריות", "ספורט") בלי לגעת בקוד.
  //
  // 💡 `tip` הוא השדה שהופך רשימה להמלצה אישית — זה מה שקונסיירז' אנושי
  //    היה אומר בשקט מעבר לדלפק. בלעדיו הבוט רק מקריא מדריך טלפונים.
  local_area: {
    en: {
      neighbourhood:
        "The hotel sits between the beachfront promenade and the old city centre — a five-minute walk to the sea, " +
        "and inside a quarter full of restaurants, bars, boutiques and galleries",

      restaurants: [
        { name: "HaEsh", cuisine: "Meat — grill & steakhouse", kosher: "Kosher (meat, Rabbinate certified)",
          hours: "Sun–Thu 12:00–23:00, Fri 12:00–15:00, Sat from an hour after sundown", distance: "9 min walk", price_range: "₪120–₪200 per diner",
          good_for: "Meat lovers, a hearty dinner, groups",
          tip: "The place for a proper meat meal nearby — no dairy on the menu; ask for the mixed grill" },
        { name: "Yam", cuisine: "Seafood & fish", kosher: "Not kosher (serves shellfish)",
          hours: "Daily 12:00–24:00", distance: "6 min walk", price_range: "₪140–₪220 per diner",
          good_for: "A special evening, sunset over the sea",
          tip: "Ask for a table on the upper terrace — I'll note it on the reservation" },
        { name: "Sofia", cuisine: "Italian, dairy — wood-fired oven", kosher: "Not kosher",
          hours: "Daily 12:00–23:30", distance: "10 min walk", price_range: "₪90–₪140 per diner", good_for: "Families, a relaxed dinner",
          tip: "Warm and noisy in the best way; the kids' pizza is made to order" },
        { name: "Aleph", cuisine: "Levantine small plates (meat & mezze)", kosher: "Not kosher",
          hours: "Daily 18:00–01:00", distance: "12 min walk", price_range: "₪80–₪130 per diner", good_for: "Couples, a lively evening",
          tip: "No reservations before 19:00 — go early or let me get you on the list" },
        { name: "Nur", cuisine: "Vegetarian & vegan", kosher: "Kosher (dairy & parve)",
          hours: "Sun–Thu 09:00–22:00, Fri 09:00–15:00, closed Sat", distance: "8 min walk", price_range: "₪70–₪110 per diner", good_for: "Lunch, plant-based dining",
          tip: "Everything on the menu is vegan; the mushroom dish is the one to order" },
        { name: "Beit Kaffe", cuisine: "Café, dairy — breakfast and light meals", kosher: "Kosher (dairy)",
          hours: "Sun–Fri 07:00–19:00, Sat 08:00–17:00", distance: "4 min walk", price_range: "₪45–₪80 per diner", good_for: "A late breakfast, a working morning",
          tip: "Open from 07:00 and quiet before 09:00 — the best coffee in the quarter" },
      ],

      attractions: [
        { name: "The beachfront promenade", distance: "5 min walk", hours: "Open at all hours", price: "Free",
          good_for: "A walk, sunset, running", tip: "Most beautiful in the hour before sunset" },
        { name: "The old port", distance: "15 min walk / 5 min by taxi", hours: "Shops 10:00–22:00", price: "Free entry",
          good_for: "Strolling, shopping, restaurants", tip: "A farmers' market runs there every Friday morning" },
        { name: "Museum of Art", distance: "10 min by taxi", hours: "Sun–Thu 10:00–18:00, Fri 10:00–14:00, closed Sat",
          price: "₪50 per adult, free under 18", good_for: "A rainy day, a quiet morning" },
        { name: "The market quarter", distance: "12 min walk", hours: "Sun–Fri 08:00–16:00, closed Sat",
          price: "Free", good_for: "Food, atmosphere, gifts", tip: "Come hungry and go before 11:00, before the crowds" },
        { name: "The old city walls", distance: "20 min by taxi", hours: "Open at all hours", price: "Free",
          good_for: "History, a view, photography" },
      ],

      tours: [
        { name: "Guided walking tour of the old city", duration: "3 hours", price: "₪180 per person",
          note: "Departs daily at 09:00 from the hotel lobby, in English or Hebrew — book by 20:00 the evening before" },
        { name: "Day trip to Jerusalem", duration: "Full day, 08:00–18:00", price: "₪450 per person",
          note: "Private driver-guide, hotel pick-up and drop-off. 24 hours' notice" },
        { name: "Dead Sea day trip", duration: "Full day, 08:00–19:00", price: "₪520 per person",
          note: "Includes entrance to a beach and spa. 24 hours' notice" },
        { name: "Food tour of the market", duration: "2.5 hours", price: "₪290 per person",
          note: "Eight tastings, runs Sun–Thu at 10:00. Vegetarian option on request" },
        { name: "Private tour, built around you", duration: "By arrangement", price: "From ₪1,400 per day for up to 4 people",
          note: "Tell me what interests you and I'll match a guide. 48 hours' notice" },
      ],

      nightlife: [
        { name: "Sky Bar (in the hotel)", type: "Cocktail bar, rooftop", hours: "17:00–01:00",
          note: "Level 12 — the view is the reason to go" },
        { name: "The Basement", type: "Live music, jazz and blues", distance: "9 min walk",
          hours: "21:00–02:00, Wed–Sat", note: "Shows start at 22:00; I can hold a table" },
        { name: "Port Bars", type: "Bar quarter", distance: "5 min by taxi", hours: "20:00–03:00",
          note: "A whole strip of bars — lively, young, walkable between them" },
        { name: "Café Levant", type: "Wine bar, quiet", distance: "7 min walk", hours: "18:00–00:00",
          note: "For a conversation rather than a night out — small and calm" },
      ],

      shopping: [
        { name: "The main boulevard", type: "Boutiques, Israeli designers", distance: "8 min walk",
          hours: "Sun–Thu 10:00–20:00, Fri until 14:00, closed Sat" },
        { name: "The shopping centre", type: "Mall — international brands", distance: "10 min by taxi",
          hours: "Sun–Thu 09:30–21:30, Fri until 15:00, Sat from sunset" },
        { name: "The craft market", type: "Jewellery, ceramics, art", distance: "12 min walk",
          hours: "Tue & Fri 10:00–17:00", note: "Bring cash — not every stall takes cards" },
        { name: "The old port shops", type: "Home, fashion, gifts", distance: "15 min walk",
          hours: "10:00–22:00, daily" },
      ],

      transport: {
        taxi: "Ask me and I'll order one for you — a taxi is at the entrance within 5–10 minutes. To the airport ₪180–₪250, within the city ₪25–₪60",
        airport: "Ben Gurion Airport — 35–50 minutes by car depending on traffic. Private transfer from ₪180, book 24 hours ahead",
        public_transport: "Bus stop 3 minutes from the hotel; the train station is 10 minutes by taxi. Note: public transport does not run from Friday afternoon to Saturday evening",
        car_rental: "Rental desks are 10 minutes away; I can arrange delivery of a car to the hotel with 24 hours' notice",
        bikes: "City bike share — a docking station right outside the hotel, ₪17 per day",
        walking: "The city centre, the beach and the market are all within a 15-minute walk",
      },
    },

    he: {
      neighbourhood:
        "המלון ממוקם בין טיילת החוף למרכז העיר העתיקה — חמש דקות הליכה מהים, " +
        "בתוך רובע מלא במסעדות, ברים, בוטיקים וגלריות",

      restaurants: [
        { name: "האש", cuisine: "בשרי — גריל וסטייקים", kosher: "כשר (בשרי, בהשגחת הרבנות)",
          hours: "א׳–ה׳ 12:00–23:00, ו׳ 12:00–15:00, מוצ״ש משעה לאחר צאת השבת", distance: "9 דקות הליכה", price_range: "₪120–₪200 לסועד",
          good_for: "אוהבי בשר, ארוחת ערב משביעה, קבוצות",
          tip: "המקום לארוחה בשרית אמיתית באזור — אין חלבי בתפריט; שווה לבקש את המעורב על האש" },
        { name: "ים", cuisine: "דגים ופירות ים", kosher: "לא כשר (מגישים פירות ים)",
          hours: "כל יום 12:00–24:00", distance: "6 דקות הליכה", price_range: "₪140–₪220 לסועד", good_for: "ערב מיוחד, שקיעה מול הים",
          tip: "כדאי לבקש שולחן במרפסת העליונה — אציין את זה בהזמנה" },
        { name: "סופיה", cuisine: "איטלקית, חלבי — טאבון", kosher: "לא כשר",
          hours: "כל יום 12:00–23:30", distance: "10 דקות הליכה", price_range: "₪90–₪140 לסועד", good_for: "משפחות, ארוחת ערב רגועה",
          tip: "חם ורועש במובן הטוב; פיצה לילדים מוכנה בהזמנה" },
        { name: "אלף", cuisine: "מנות קטנות, מטבח לבנטיני (בשרי ומזה)", kosher: "לא כשר",
          hours: "כל יום 18:00–01:00", distance: "12 דקות הליכה", price_range: "₪80–₪130 לסועד", good_for: "זוגות, ערב תוסס",
          tip: "לא מקבלים הזמנות לפני 19:00 — או להגיע מוקדם, או שאסדר מקום ברשימה" },
        { name: "נור", cuisine: "צמחוני וטבעוני", kosher: "כשר (חלבי ופרווה)",
          hours: "א׳–ה׳ 09:00–22:00, ו׳ 09:00–15:00, שבת סגור", distance: "8 דקות הליכה", price_range: "₪70–₪110 לסועד", good_for: "צהריים, אוכל מהצומח",
          tip: "כל התפריט טבעוני; מנת הפטריות היא זו שכדאי להזמין" },
        { name: "בית קפה", cuisine: "בית קפה, חלבי — בקרים וארוחות קלות", kosher: "כשר (חלבי)",
          hours: "א׳–ו׳ 07:00–19:00, שבת 08:00–17:00", distance: "4 דקות הליכה", price_range: "₪45–₪80 לסועד", good_for: "בוקר מאוחר, בוקר עבודה",
          tip: "פתוח מ-07:00 ושקט לפני 09:00 — הקפה הכי טוב ברובע" },
      ],

      attractions: [
        { name: "טיילת החוף", distance: "5 דקות הליכה", hours: "פתוח בכל שעה", price: "ללא תשלום",
          good_for: "הליכה, שקיעה, ריצה", tip: "הכי יפה בשעה שלפני השקיעה" },
        { name: "הנמל הישן", distance: "15 דקות הליכה / 5 דקות במונית", hours: "החנויות 10:00–22:00",
          price: "כניסה חופשית", good_for: "בילוי, קניות, מסעדות", tip: "כל יום שישי בבוקר יש שם שוק איכרים" },
        { name: "מוזיאון לאמנות", distance: "10 דקות במונית", hours: "א'–ה' 10:00–18:00, ו' 10:00–14:00, סגור בשבת",
          price: "₪50 למבוגר, חינם עד גיל 18", good_for: "יום גשום, בוקר שקט" },
        { name: "רובע השוק", distance: "12 דקות הליכה", hours: "א'–ו' 08:00–16:00, סגור בשבת",
          price: "ללא תשלום", good_for: "אוכל, אווירה, מתנות", tip: "להגיע רעבים ולפני 11:00, לפני העומס" },
        { name: "חומות העיר העתיקה", distance: "20 דקות במונית", hours: "פתוח בכל שעה", price: "ללא תשלום",
          good_for: "היסטוריה, נוף, צילום" },
      ],

      tours: [
        { name: "סיור מודרך רגלי בעיר העתיקה", duration: "3 שעות", price: "₪180 לאדם",
          note: "יוצא כל יום ב-09:00 מלובי המלון, בעברית או באנגלית — להזמין עד 20:00 בערב הקודם" },
        { name: "טיול יום לירושלים", duration: "יום מלא, 08:00–18:00", price: "₪450 לאדם",
          note: "נהג-מדריך פרטי, איסוף והחזרה למלון. בהתראה של 24 שעות" },
        { name: "טיול יום לים המלח", duration: "יום מלא, 08:00–19:00", price: "₪520 לאדם",
          note: "כולל כניסה לחוף ולספא. בהתראה של 24 שעות" },
        { name: "סיור קולינרי בשוק", duration: "שעתיים וחצי", price: "₪290 לאדם",
          note: "שמונה טעימות, יוצא א'–ה' ב-10:00. אפשרות צמחונית בתיאום" },
        { name: "סיור פרטי בהתאמה אישית", duration: "בתיאום", price: "החל מ-₪1,400 ליום עד 4 אנשים",
          note: "אשמח לשמוע מה מעניין אותך ולהתאים מדריך. בהתראה של 48 שעות" },
      ],

      nightlife: [
        { name: "סקיי בר (במלון)", type: "בר קוקטיילים, על הגג", hours: "17:00–01:00",
          note: "קומה 12 — הנוף הוא הסיבה לעלות" },
        { name: "המרתף", type: "מוזיקה חיה, ג'אז ובלוז", distance: "9 דקות הליכה",
          hours: "21:00–02:00, ד'–ש'", note: "ההופעות מתחילות ב-22:00; אוכל לשריין שולחן" },
        { name: "ברי הנמל", type: "רובע ברים", distance: "5 דקות במונית", hours: "20:00–03:00",
          note: "רצועה שלמה של ברים — תוססת, צעירה, אפשר לעבור ביניהם ברגל" },
        { name: "קפה לבנט", type: "בר יין, שקט", distance: "7 דקות הליכה", hours: "18:00–00:00",
          note: "לשיחה ולא ליציאה — קטן ורגוע" },
      ],

      shopping: [
        { name: "השדרה הראשית", type: "בוטיקים, מעצבים ישראלים", distance: "8 דקות הליכה",
          hours: "א'–ה' 10:00–20:00, ו' עד 14:00, סגור בשבת" },
        { name: "הקניון", type: "קניון — מותגים בינלאומיים", distance: "10 דקות במונית",
          hours: "א'–ה' 09:30–21:30, ו' עד 15:00, שבת מצאת השבת" },
        { name: "שוק האומנים", type: "תכשיטים, קרמיקה, אמנות", distance: "12 דקות הליכה",
          hours: "ג' ו-ו' 10:00–17:00", note: "כדאי מזומן — לא בכל דוכן יש אשראי" },
        { name: "חנויות הנמל הישן", type: "בית, אופנה, מתנות", distance: "15 דקות הליכה",
          hours: "10:00–22:00, כל יום" },
      ],

      transport: {
        taxi: "אפשר לבקש ממני להזמין — המונית מגיעה לכניסה תוך 5–10 דקות. לנתב\"ג ₪180–₪250, בתוך העיר ₪25–₪60",
        airport: "נתב\"ג — 35–50 דקות ברכב, תלוי בעומס. הסעה פרטית החל מ-₪180, בהזמנה 24 שעות מראש",
        public_transport: "תחנת אוטובוס 3 דקות מהמלון; תחנת הרכבת 10 דקות במונית. לתשומת לב: אין תחבורה ציבורית מיום שישי בצהריים ועד מוצאי שבת",
        car_rental: "משרדי השכרת רכב במרחק 10 דקות; אפשר לתאם הגעת רכב למלון בהתראה של 24 שעות",
        bikes: "אופניים שיתופיים — עמדה ממש מחוץ למלון, ₪17 ליום",
        walking: "מרכז העיר, החוף והשוק — כולם בטווח של עד 15 דקות הליכה",
      },
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

I'm your personal concierge, here around the clock.

I'm happy to help with:
🏨 Check-in & check-out
🍳 Dining, and a table booked for you anywhere
🗺️ Recommendations — restaurants, attractions, tours, nightlife, shopping
🚕 A taxi, a transfer, a spa treatment, a special request
🏊 Pool, spa & gym
🛎️ Housekeeping & maintenance
💡 Anything at all about your stay

How may I assist you today?`,

    he: `ברוכים הבאים ל*מלון קמפינסקי* ✨

אני הקונסיירז' האישי שלכם, כאן מסביב לשעון.

אשמח לעזור ב:
🏨 צ'ק אין וצ'ק אאוט
🍳 מסעדה, והזמנת שולחן עבורכם בכל מקום
🗺️ המלצות — מסעדות, אטרקציות, טיולים, חיי לילה, קניות
🚕 מונית, הסעה, טיפול בספא, בקשה מיוחדת
🏊 בריכה, ספא וחדר כושר
🛎️ ניקיון ואחזקה
💡 כל שאלה על השהייה שלכם

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
  configCache.delete(HOTEL);
  return hotelConfig;
}

// ── עדכון קונפיג של מלון *מסוים* (multi-tenant onboarding) ──
// כמו updateConfig, אבל לכל hotel_id. זו נקודת הכניסה להוספת/עריכת
// מלון שאינו מלון ברירת המחדל: כותב overrides לשורה שלו ב-DB ומנקה
// את ה-cache שלו. עבור מלון ברירת המחדל מפנה ל-updateConfig כדי שגם
// hotelConfig החי יתעדכן. לעולם לא מערבב בין מלונות — כל מלון ושורתו.
export function updateConfigFor(hotelId, patch) {
  if (!hotelId || hotelId === HOTEL) return updateConfig(patch);
  if (!isPlainObject(patch)) throw new TypeError("updateConfigFor expects a plain object");
  let cur = {};
  try {
    const row = db.prepare(`SELECT data FROM config WHERE hotel_id = ?`).get(hotelId);
    const parsed = row?.data ? JSON.parse(row.data) : null;
    if (isPlainObject(parsed)) cur = parsed;
  } catch { /* אין שורה עדיין */ }
  const next = deepMerge(cur, patch);
  persistStmt.run(hotelId, JSON.stringify(next), new Date().toISOString());
  configCache.delete(hotelId);
  return configFor(hotelId);
}

// ── איפוס לברירות המחדל שבקוד ──────────────────────────
// מוחק את כל ה-overrides. משמש איפוס דמו/סביבת בדיקה.
export function resetConfig() {
  db.prepare(`DELETE FROM config WHERE hotel_id = ?`).run(HOTEL);
  overrides   = {};
  hotelConfig = deepMerge(structuredClone(DEFAULTS), overrides);
  configCache.delete(HOTEL);
  return hotelConfig;
}

// ה-overrides בלבד (מה שנערך מעל הקוד) — לצורכי דיבוג/דשבורד.
export function configOverrides() {
  return structuredClone(overrides);
}

// ════════════════════════════════════════════════════════
//  מחלקות ואנשי קשר — **נקודת ההפרדה בין מלונות**
//  ----------------------------------------------------------
//  זו הנקודה היחידה בקוד שיודעת לאיזה מספר וואטסאפ ולאיזה מייל
//  נשלחת התראה של מחלקה. `notifyStaff` (bot.js) קורא רק לכאן.
//
//  למה זה חשוב למולטי-טננט: כל עוד השליפה פזורה כ-
//  `hotelConfig.housekeeping_number` בתוך הלוגיקה, כל מלון נוסף
//  דורש נגיעה בכל מקום שמתריע. עכשיו מלון נוסף = שורת קונפיג
//  נוספת ב-DB (`config.hotel_id`), והלוגיקה לא משתנה בכלל:
//  ההתראה נשלחת עם `hotelId`, ומכאן חוזרים אנשי הקשר של *אותו*
//  מלון בלבד. אין שום מסלול שבו בקשה של מלון א' מגיעה למחלקה
//  של מלון ב' — כי אין יותר גלובל אחד שכולם קוראים ממנו.
// ════════════════════════════════════════════════════════
export const DEPARTMENTS = [
  "reception", "housekeeping", "maintenance", "concierge", "security", "room_service",
];

// קונפיג מלא של מלון מסוים. המלון הנוכחי מוחזר מהזיכרון; כל מלון
// אחר נטען מה-DB (אותה טבלה, hotel_id אחר) ונשמר ב-cache.
const configCache = new Map();
export function configFor(hotelId = HOTEL) {
  if (hotelId === HOTEL) return hotelConfig;
  if (!configCache.has(hotelId)) {
    let ov = {};
    try {
      const row = db.prepare(`SELECT data FROM config WHERE hotel_id = ?`).get(hotelId);
      const parsed = row?.data ? JSON.parse(row.data) : null;
      if (isPlainObject(parsed)) ov = parsed;
    } catch (e) {
      console.error(`⚠️ טעינת הקונפיג של המלון "${hotelId}" נכשלה:`, e?.message || e);
    }
    configCache.set(hotelId, deepMerge(structuredClone(DEFAULTS), ov));
  }
  return configCache.get(hotelId);
}

// ── תג פנימי → מחלקה — מקור אמת אחד ────────────────────
// המפה הזו הייתה קבורה בתוך runActions ב-bot.js, ולכן אי אפשר היה
// להדפיס או לבדוק "לאן בעצם הולכת כל בקשה" בלי לקרוא את הלוגיקה.
// עכשיו היא יושבת ליד אנשי הקשר: תג → מחלקה → וואטסאפ + מייל, שרשרת
// אחת שאפשר להדפיס בעלייה ולבדוק בבדיקות.
export const TAG_DEPARTMENTS = Object.freeze({
  HK:          "housekeeping",
  HK_URGENT:   "housekeeping",
  MAINTENANCE: "maintenance",
  ROOMSERVICE: "room_service",
  CONCIERGE:   "concierge",
  RECEPTION:   "reception",
  SECURITY:    "security",
  EMERGENCY:   "security",
});

// שם המחלקה לקריאת אדם (לוגים, טבלת הניתוב).
export const DEPARTMENT_LABELS_HE = Object.freeze({
  reception:    "קבלה",
  housekeeping: "משק בית",
  maintenance:  "אחזקה",
  concierge:    "קונסיירז'",
  security:     "ביטחון",
  room_service: "שירות חדרים",
});

// טבלת הניתוב המלאה: כל תג, המחלקה שלו, והיעדים בפועל.
export function routingTable(hotelId = HOTEL) {
  return Object.entries(TAG_DEPARTMENTS).map(([tag, dept]) => {
    const { whatsapp, email } = departmentContacts(dept, hotelId);
    return { tag, dept, deptHe: DEPARTMENT_LABELS_HE[dept] || dept, whatsapp, email };
  });
}

// הדפסת הטבלה בעלייה — כדי שלפני הדגמה אפשר יהיה לראות בעין אחת
// לאן כל סוג בקשה נשלח, ובאיזה ערוץ. מחלקה בלי ערוץ מסומנת באדום.
export function printRoutingTable(hotelId = HOTEL) {
  const rows = routingTable(hotelId);
  console.log(`\n📍 ניתוב בקשות — מלון "${hotelId}" (כל בקשה נשלחת גם בוואטסאפ וגם במייל):`);
  for (const r of rows) {
    const wa = r.whatsapp ? String(r.whatsapp).replace(/^whatsapp:/, "") : "❌ חסר";
    const em = r.email || "❌ חסר";
    console.log(`   [${r.tag}]`.padEnd(16) + `→ ${r.deptHe}`.padEnd(18) + `📱 ${wa}   📧 ${em}`);
  }
  console.log("");
  return rows;
}

// אנשי הקשר של מחלקה, במלון מסוים.
export function departmentContacts(dept, hotelId = HOTEL) {
  const cfg = configFor(hotelId);
  return {
    whatsapp: cfg[`${dept}_number`] || null,
    email:    cfg[`${dept}_email`]  || null,
  };
}

// ── בדיקת שלמות בהפעלה ─────────────────────────────────
// מחלקה בלי מספר או בלי מייל **לא מתריעה בכלל** — והכשל שקט לגמרי:
// האורח מקבל "העברתי את הבקשה", ואף אחד לא מקבל כלום. זו בדיוק תקלת
// ההדגמה שאי אפשר לראות עד שמישהו שואל "למה לא הגיע?".
// לכן בודקים את זה בעלייה ומדווחים בקול.
export function checkDepartmentContacts(hotelId = HOTEL) {
  const missing = [];
  for (const dept of DEPARTMENTS) {
    const { whatsapp, email } = departmentContacts(dept, hotelId);
    if (!whatsapp) missing.push(`${dept}_number`);
    if (!email)    missing.push(`${dept}_email`);
  }
  return { ok: missing.length === 0, missing, hotelId };
}
