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
🛎️ בקשות ניקיון ותחזוקה
💡 כל שאלה על שהייתכם

במה אוכל לעזור?`,
  },
};

export function updateConfig(patch) {
  hotelConfig = { ...hotelConfig, ...patch };
}
