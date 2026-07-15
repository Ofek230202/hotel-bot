// ════════════════════════════════════════════════════════
//  HOTEL CONFIGURATION  —  edit this file per property
// ════════════════════════════════════════════════════════

export let hotelConfig = {
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
  services: {
    breakfast: {
      en: { hours: "07:00–11:00", location: "The Garden Restaurant, Level 1" },
      he: { hours: "07:00–11:00", location: "מסעדת הגן, קומה 1" },
    },
    pool: {
      en: { hours: "07:00–22:00", location: "Rooftop, Level 12", note: "Heated year-round" },
      he: { hours: "07:00–22:00", location: "גג, קומה 12", note: "מחוממת כל השנה" },
    },
    gym: {
      en: { hours: "06:00–23:00", location: "Level 2, Fitness Center" },
      he: { hours: "06:00–23:00", location: "קומה 2, מרכז כושר" },
    },
    spa: {
      en: { hours: "09:00–21:00", booking: "Ext. 205 or ask me to schedule" },
      he: { hours: "09:00–21:00", booking: "שלוחה 205 או בקש ממני לקבוע" },
    },
    room_service: {
      en: { hours: "24/7", dial: "Ext. 0" },
      he: { hours: "24/7", dial: "שלוחה 0" },
    },
    restaurant: {
      en: { name: "The Garden Restaurant", hours: "12:00–23:00", cuisine: "Mediterranean & International" },
      he: { name: "מסעדת הגן",             hours: "12:00–23:00", cuisine: "ים תיכונית ובינלאומית" },
    },
    bar: {
      en: { name: "Sky Bar", hours: "17:00–01:00", location: "Rooftop Level 12", note: "Smart-casual dress code" },
      he: { name: "סקיי בר", hours: "17:00–01:00", location: "גג קומה 12", note: "לבוש מכובד נדרש" },
    },
  },

  // ── Parking ───────────────────────────────────────────
  parking: {
    available: true,
    en: { type: "Underground valet parking", price: "₪65/night", note: "Please notify reception upon arrival" },
    he: { type: "חניון תת-קרקעי עם ואלה",   price: "65₪/לילה",  note: "אנא הודע לקבלה עם הגעתך" },
  },

  // ── FAQ ───────────────────────────────────────────────
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

export function updateConfig(patch) {
  hotelConfig = { ...hotelConfig, ...patch };
}
