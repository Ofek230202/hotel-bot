// ════════════════════════════════════════════════════════
//  BOT BRAIN v6 — Production Ready
// ════════════════════════════════════════════════════════
import Anthropic from "@anthropic-ai/sdk";
import twilio    from "twilio";
import dotenv    from "dotenv";
import { hotelConfig, departmentContacts, TAG_DEPARTMENTS } from "./config.js";
import { getSession, recordActivity, pushHistory, patchSession, logAlert, logIncident, stats, sessions } from "./state.js";
import { detectLangSignal, detectLanguageRequest, stripLanguageRequest } from "./i18n.js";
import { stripInternalTags, hasInternalTag, validateFullName, validateReservationNumber, validateIdMedia, validateStayDates, validateTermsConfirmation, parseCheckinDetails, isSkipWord } from "./validate.js";
import { resolveNameForms, nameFor }                      from "./names.js";
import { startCheckin, processCheckout, getActiveReservation, getPendingReservation, formatFolio, depositExplainer, formatStayDates, saveFeedback } from "./checkin.js";
import { email }                                          from "./email/index.js";
import { idVerify }                                       from "./idverify/index.js";
import { concierge, REQUEST_TYPES }                       from "./concierge/index.js";
import { places, PLACE_CATEGORIES, placesLive }           from "./places/index.js";
import { detectEmergency, emergencyGuestMessage, emergencyKindHe, emergencyDial } from "./emergency.js";

dotenv.config();

const AI_MODEL = "claude-sonnet-4-6";
const ai   = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // הגנה מפני "Premature close" ותקלות רשת חולפות מול api.anthropic.com בענן:
  // ה-SDK מנסה שוב לבד על שגיאות רשת/429/5xx, עם timeout סביר לכל ניסיון.
  maxRetries: 3,
  timeout: 30_000, // 30s לכל ניסיון (max_tokens קטן, אין streaming)
});

// קריאה ל-AI עם retry ברמת האפליקציה + לוג ברור של השגיאה המדויקת.
// חשוב: "Premature close" נזרק בזמן קריאת גוף התשובה — אחרי שה-headers כבר
// הגיעו — ולכן ה-retry הפנימי של ה-SDK לא תמיד תופס אותו. עוטפים בעצמנו.
async function createMessageWithRetry(params, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await ai.messages.create(params);
    } catch (e) {
      lastErr = e;
      const status = e?.status;
      const kind   = e?.name || e?.constructor?.name || "Error";
      console.error(`AI attempt ${i}/${attempts} failed [${kind}${status ? " " + status : ""}]: ${e?.message || e}${e?.cause ? ` | cause: ${e.cause?.message || e.cause}` : ""}`);
      // שגיאות לקוח קבועות (400/401/403/404) — אין טעם לנסות שוב.
      if (status && status >= 400 && status < 500 && status !== 429) break;
      if (i < attempts) await new Promise(r => setTimeout(r, 400 * 2 ** (i - 1)));
    }
  }
  throw lastErr;
}
const tw   = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_WHATSAPP_NUMBER;

// ── הודעות מוכנות למקרי קצה — לעולם לא שקט מוחלט (Bug #2) ──
const FALLBACK_MSG = {
  he: "אירעה תקלה קלה אצלנו — אני חוזר אליך מיד 🙏\nאם זה דחוף, הקבלה זמינה בשלוחה 0.",
  en: "We hit a small glitch on our side — I'll be right back with you 🙏\nIf it's urgent, reception is available at Ext. 0.",
};

// ── ערוץ היציאה היחיד לוואטסאפ — כאן מחטאים כל הודעה ──
// שתי רשתות ביטחון על *כל* הודעה יוצאת, לאורח ולצוות כאחד:
// 1. תג פנימי ([CHECKIN] / [HK:...] וכו') לעולם לא ידלוף לאורח (Bug #1).
//    גם אם הקוד שמעל פספס — כאן זה נעצר, ונרשם ללוג כדי שנדע.
// 2. הודעה ריקה לא נשלחת לטוויליו (שזורק שגיאה על body ריק ומשתיק את
//    הבוט) — במקומה נשלחת הודעת גיבוי (Bug #2).
// ── ניקוי פורמט אחרון לפני וואטסאפ ──────────────────────
// ה-prompt כבר אוסר markdown שוואטסאפ לא יודע להציג, אבל prompt הוא
// בקשה, לא ערובה. נצפה בשטח: הבוט הפריד בין המלצות בקו "---", ווואטסאפ
// הציג שלושה מקפים ערומים באמצע הודעה של מלון 5 כוכבים.
// כאן זה נעצר דטרמיניסטית — בדיוק כמו סינון התגים הפנימיים.
function tidyForWhatsApp(text) {
  return String(text ?? "")
    // שורה שכולה קו מפריד (---, ___, ***, ═══) — נמחקת לגמרי
    .replace(/^[ \t]*(?:-{3,}|_{3,}|\*{3,}|={3,}|—{2,}|─{2,})[ \t]*$/gm, "")
    // כותרת markdown (### כותרת) → טקסט מודגש, כמו שוואטסאפ מבין
    .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, "*$1*")
    // הדגשה בסגנון markdown (**טקסט**) → כוכבית אחת. וואטסאפ מדגיש עם
    // כוכבית *אחת*, ולכן שתיים מוצגות לאורח כתווים ערומים: **האש**.
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "*$1*")
    // שלוש שורות ריקות ומעלה → שורה ריקה אחת
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function wa(to, body, { lang = "he" } = {}) {
  const raw = String(body ?? "");
  if (hasInternalTag(raw)) {
    console.error(`🚨 תג פנימי נתפס לפני שליחה לאורח (${to.slice(-8)}) — סונן: ${raw.slice(0, 120)}`);
  }

  let text = tidyForWhatsApp(stripInternalTags(raw));
  if (!text) {
    console.error(`🚨 הודעה ריקה נחסמה לפני שליחה (${to.slice(-8)}) — נשלחת הודעת גיבוי. raw="${raw.slice(0, 120)}"`);
    text = FALLBACK_MSG[lang === "he" ? "he" : "en"];
  }

  await tw.messages.create({ from: FROM, to, body: text });
  console.log(`📤 → ${to.slice(-8)}: ${text.slice(0, 60)}…`);
}

function israelTime() {
  const now = new Date();
  const time = now.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" });
  const date = now.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Jerusalem" });
  return { time, date, full: `${date}, ${time}` };
}

// כל התראה חייבת להיות *ניתנת לפעולה*: מחלקה שמקבלת בקשה בלי מספר חדר
// ובלי דרך להשיג את האורח לא יכולה לעשות דבר. לכן `phone` נכנס לכל
// התראה, וכשמספר החדר לא ידוע ההתראה אומרת זאת במפורש ומורה ליצור קשר —
// במקום מקף שקט שנראה כאילו המידע פשוט חסר.
// `hotelId` הוא הפרמטר שהופך את זה למולטי-טננט: אנשי הקשר נשלפים
// לפי המלון, מנקודה אחת (config.js), ולא מגלובל משותף.
export async function notifyStaff({ dept, roomNumber, guestName, message, phone, priority = "normal", hotelId, roomNote }) {
  const { whatsapp: to, email: toEmail } = departmentContacts(dept, hotelId);
  const emoji = { housekeeping: "🧹", reception: "🏨", maintenance: "🔧", concierge: "⭐", security: "🚨", room_service: "🛎️" }[dept] || "🔔";
  // שם המחלקה בכותרת ההתראה — קריא לצוות (room_service → ROOM SERVICE).
  const deptLabel = dept.replace(/_/g, " ").toUpperCase();
  const urgency = priority === "high" ? "🚨 *דחוף* 🚨\n" : "";
  const { full } = israelTime();
  // מספר חדר חסר אינו "—" שקט: הוא הוראת פעולה.
  //
  // אבל יש *שני* מצבים שונים לגמרי של "אין חדר", והם דורשים נוסח שונה:
  //  • אורח שמבקש משהו ואיננו יודעים איפה הוא → תקלה. צריך להתקשר אליו.
  //  • אורח באמצע צ'ק אין, שהחדר שלו פשוט טרם הוקצה → תקין לחלוטין.
  // הנוסח האחיד הקודם ("לא ידוע — יש ליצור קשר לבירור המיקום") הופיע גם
  // בהתראת אימות הזהות, וגרם לזה להיראות כמו כשל בזמן שהכול תקין.
  // `roomNote` נותן לקורא לומר במפורש מה המצב.
  const roomLine = roomNumber
    ? `🚪 חדר: ${roomNumber}`
    : roomNote
      ? `🚪 חדר: ${roomNote}`
      : `🚪 חדר: *לא ידוע* — יש ליצור קשר עם האורח לבירור המיקום`;
  // הטלפון נכנס לכל התראה: זו הדרך היחידה של הצוות להשיג את האורח.
  const phoneLine = phone ? `\n📱 ${String(phone).replace(/^whatsapp:/, "")}` : "";
  // trim: תוכן שמגיע מתג ([HK: מגבות]) נושא לרוב רווח מוביל, וההתראה
  // יצאה עם "📝  מגבות" — רווח כפול. פרט קטן, אבל הצוות רואה את זה כל היום.
  const body = `${urgency}${emoji} *${deptLabel}*\n\n👤 אורח: ${guestName || "—"}\n${roomLine}${phoneLine}\n📝 ${String(message ?? "").trim()}\n⏰ ${full}`;

  // מחלקה בלי שום ערוץ = בקשה שנעלמת בשקט. לא מרשים לזה לקרות בלי לצעוק.
  if (!to && !toEmail) {
    console.error(`🚨 למחלקה "${dept}" אין מספר וואטסאפ ואין מייל בקונפיג — ההתראה לא נשלחה לאיש!`);
  }

  // ── ערוץ 1: וואטסאפ ──────────────────────────────────
  if (to) {
    try { await wa(to, body); } catch (e) { console.error("Staff notify (WhatsApp) failed:", e.message); }
  }

  // ── ערוץ 2: מייל (דרך שכבת המייל המבודדת) ────────────
  if (toEmail) {
    // נושא המייל חייב לומר את אותו דבר כמו ההתראה בוואטסאפ — אחרת אותו
    // אירוע נראה לצוות כשתי בעיות שונות ("טרם הוקצה" מול "חדר לא ידוע").
    const roomSubject = roomNumber
      ? `חדר ${roomNumber}`
      : (roomNote ? `חדר ${roomNote.split("—")[0].trim()}` : "חדר לא ידוע");
    const subject = `${priority === "high" ? "🚨 דחוף — " : ""}${deptLabel} | ${roomSubject} | ${guestName || "—"}`;
    try {
      await email.send({ to: toEmail, subject, body, dept, priority, meta: { roomNumber, guestName, message } });
    } catch (e) { console.error("Staff notify (email) failed:", e.message); }
  }

  logAlert({ dept, roomNumber, guestName, message, priority });
  stats.serviceRequests++;
}

function isCheckinIntent(text) {
  const t = text.replace(/['''`״׳]/g, "").toLowerCase().trim();
  return [
    "צק אין", "צכ אין", "תק אין", "צאק אין", "צ אין", "צקאין",
    "check in", "checkin", "check-in", "chek in", "chekin",
    "הגעתי", "אני פה", "רוצה להתחיל", "want to check", "checking in",
    "לצק אין", "לעשות צק", "wanna check in", "like to check in"
  ].some(x => t.includes(x.replace(/[''']/g, "").toLowerCase()));
}

function isCheckoutIntent(text) {
  const t = text.replace(/['''`״׳]/g, "").toLowerCase().trim();
  return [
    "צק אאוט", "צכ אאוט", "תק אאוט", "צ אאוט", "צקאאוט",
    "check out", "checkout", "check-out", "chek out", "chekout",
    "אני עוזב", "אני יוצא", "leaving", "checking out", "לצאת", "לעזוב",
    "wanna check out", "like to check out"
  ].some(x => t.includes(x.replace(/[''']/g, "").toLowerCase()));
}

// האם ההודעה היא ברכה/פתיחה כללית בלבד (בלי בקשה ממשית)?
// משמש כדי להחליט אם לשלוח את הודעת הפתיחה/תפריט בהודעה הראשונה.
// אם נשאר תוכן ממשי אחרי ניקוי הברכות — זו אינה הודעה כללית, ומטפלים בה מיד.
function isGenericGreeting(text) {
  let t = (text || "").replace(/['''`״׳.,!?\-—…😊🙂👋🙏🌟]/g, " ").toLowerCase();
  const greetings = [
    "שלום רב", "שלום לך", "שלום", "היי", "הייי", "הי", "אהלן", "הלו", "מה נשמע",
    "מה קורה", "מה המצב", "מה שלומך", "בוקר טוב", "ערב טוב", "צהריים טובים",
    "לילה טוב", "good morning", "good evening", "good afternoon", "good night",
    "hello", "hellow", "hey there", "heya", "hey", "hi there", "hii", "hi",
    "hallo", "yo", "whats up", "how are you",
  ];
  for (const g of greetings) {
    t = t.replace(new RegExp(g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  }
  t = t.replace(/\s+/g, " ").trim();
  return t.length <= 2; // לא נשאר תוכן ממשי → ברכה כללית בלבד
}

// ════════════════════════════════════════════════════════
//  רינדור המידע המובנה מה-config אל ה-prompt
//  ----------------------------------------------------------
//  שם השדה הוא חלק מהמידע. הרינדור הקודם עשה
//  `Object.values(s).join(" | ")` — ולכן הספא הגיע ל-AI כ-
//  "09:00–21:00 | ₪350 | ₪480", בלי לדעת איזה מספר הוא שעה, איזה
//  מחיר שייך לאיזה טיפול, ומה בכלל כל אחד מהם. ה-AI נאלץ לנחש,
//  ואורח קיבל מחיר שגוי כעובדה.
//
//  שני כללים שמונעים את זה מלחזור:
//  1. כל ערך מגיע עם התווית שלו — לעולם לא ערך ערום.
//  2. מפתח שאין לו תווית נופל לשם המפתח עצמו. כלומר אפשר להוסיף
//     שדה חדש ל-config.js בלי לגעת בקוד כאן: הכי גרוע התווית תהיה
//     "night menu" במקום "תפריט לילה" — אבל המשמעות לא הולכת לאיבוד.
// ════════════════════════════════════════════════════════
const FIELD_LABELS = {
  he: {
    name: "שם", hours: "שעות פעילות", location: "מיקום", style: "אופי",
    price: "מחיר", price_range: "טווח מחירים", dietary: "התאמות תזונתיות",
    note: "לתשומת לב", access: "כניסה", amenities: "מה כלול", children: "ילדים",
    equipment: "ציוד", classes: "שיעורים", personal_trainer: "מאמן אישי",
    age_policy: "מדיניות גיל", booking: "איך מזמינים", booking_notice: "הזמנה מראש",
    treatments: "טיפולים ומחירים", facilities: "מתקנים", arrival: "הגעה",
    cancellation: "מדיניות ביטול", cuisine: "סוג מטבח", reservations: "הזמנת שולחן",
    dress_code: "קוד לבוש", dial: "שלוחה", how_to_order: "איך מזמינים",
    delivery_time: "זמן הגעה", service_charge: "דמי שירות", night_menu: "תפריט לילה",
    turnaround: "זמן אספקה", express: "שירות אקספרס", type: "סוג",
    ev_charging: "טעינת רכב חשמלי", height_limit: "הגבלת גובה", duration: "משך",
    happy_hour: "שעת האפי האוור", price_note: "לתשומת לב לגבי המחירים",
    // ── בטיחות (בריכה וכו') + כשרות ──
    safety: "בטיחות", lifeguard: "מציל", depth: "עומק", kosher: "כשרות",
    // ── תפריט שירות החדרים (config.services.room_service.menu) ──
    menu: "התפריט", starters: "מנות פתיחה", salads: "סלטים", pasta: "פסטות",
    mains: "מנות עיקריות", desserts: "קינוחים", drinks: "משקאות",
    description: "תיאור", options: "אפשרויות בחירה ותוספות",
    // ── מבנה המלון (config.building) ──
    floors: "קומות", lobby: "לובי", reception: "קבלה", elevators: "מעליות",
    accessibility: "נגישות", key_areas: "מה נמצא בכל קומה",
    // ── ידע הקונסיירז' על הסביבה (config.local_area) ──
    neighbourhood: "השכונה והמיקום", restaurants: "מסעדות מומלצות באזור",
    attractions: "אטרקציות ומקומות לבקר", tours: "טיולים וסיורים",
    nightlife: "חיי לילה", shopping: "קניות", transport: "תחבורה והסעות",
    distance: "מרחק מהמלון", good_for: "מתאים ל", tip: "הטיפ שלי",
    taxi: "מוניות", airport: "שדה תעופה", public_transport: "תחבורה ציבורית",
    car_rental: "השכרת רכב", bikes: "אופניים", walking: "מה בהליכה",
  },
  en: {
    name: "Name", hours: "Hours", location: "Location", style: "Style",
    price: "Price", price_range: "Price range", dietary: "Dietary options",
    note: "Note", access: "Access", amenities: "Included", children: "Children",
    equipment: "Equipment", classes: "Classes", personal_trainer: "Personal trainer",
    age_policy: "Age policy", booking: "How to book", booking_notice: "Advance booking",
    treatments: "Treatments & prices", facilities: "Facilities", arrival: "Arrival",
    cancellation: "Cancellation policy", cuisine: "Cuisine", reservations: "Table reservations",
    dress_code: "Dress code", dial: "Dial", how_to_order: "How to order",
    delivery_time: "Delivery time", service_charge: "Service charge", night_menu: "Night menu",
    turnaround: "Turnaround", express: "Express service", type: "Type",
    ev_charging: "EV charging", height_limit: "Height limit", duration: "Duration",
    happy_hour: "Happy hour", price_note: "About the prices",
    // ── Safety (pool, etc.) + kosher ──
    safety: "Safety", lifeguard: "Lifeguard", depth: "Depth", kosher: "Kosher",
    // ── In-room dining menu (config.services.room_service.menu) ──
    menu: "The menu", starters: "Starters", salads: "Salads", pasta: "Pasta",
    mains: "Main courses", desserts: "Desserts", drinks: "Drinks",
    description: "Description", options: "Choices & additions",
    // ── Building / layout (config.building) ──
    floors: "Floors", lobby: "Lobby", reception: "Reception", elevators: "Lifts",
    accessibility: "Accessibility", key_areas: "What's on each floor",
    // ── Concierge's knowledge of the area (config.local_area) ──
    neighbourhood: "The neighbourhood", restaurants: "Recommended restaurants nearby",
    attractions: "Attractions & places to visit", tours: "Tours & day trips",
    nightlife: "Nightlife", shopping: "Shopping", transport: "Transport & transfers",
    distance: "Distance from the hotel", good_for: "Good for", tip: "My tip",
    taxi: "Taxis", airport: "Airport", public_transport: "Public transport",
    car_rental: "Car rental", bikes: "Bicycles", walking: "Within walking distance",
  },
};

function labelFor(key, lang) {
  return FIELD_LABELS[lang === "he" ? "he" : "en"][key] || String(key).replace(/_/g, " ");
}

const isPlainObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const hasValue   = (v) => v !== null && v !== undefined && v !== "";

// פריט ברשימה (טיפול בספא, מנה) — כל השדות שלו על שורה אחת, יחד.
// זה מה שקושר מחיר לטיפול: "עיסוי שוודי | משך: 60 דקות | מחיר: ₪350".
function renderItem(item, lang) {
  if (!isPlainObj(item)) return String(item);
  return Object.entries(item)
    .filter(([, v]) => hasValue(v))
    .map(([k, v]) => (k === "name" ? String(v) : `${labelFor(k, lang)}: ${v}`))
    .join(" | ");
}

// רינדור גנרי של אובייקט קונפיג לשורות מתויגות. רקורסיבי — כדי
// שמבנה מקונן שיתווסף בעתיד יגיע שלם ולא ייעלם/יידחס למחרוזת.
function renderFields(obj, lang, indent = "  ") {
  const lines = [];
  for (const [key, val] of Object.entries(obj || {})) {
    if (!hasValue(val)) continue;
    const label = labelFor(key, lang);

    if (Array.isArray(val)) {
      if (!val.length) continue;
      lines.push(`${indent}${label}:`);
      for (const item of val) lines.push(`${indent}  • ${renderItem(item, lang)}`);
    } else if (isPlainObj(val)) {
      const nested = renderFields(val, lang, indent + "  ");
      if (nested) lines.push(`${indent}${label}:`, nested);
    } else {
      lines.push(`${indent}${label}: ${val}`);
    }
  }
  return lines.join("\n");
}

// ════════════════════════════════════════════════════════
//  כלי חיפוש מקומות אמיתיים — Google Places דרך שכבת places/
//  ----------------------------------------------------------
//  ה-AI מקבל את הכלי הזה בכל תור. כשאורח מבקש המלצה שאין לה כיסוי
//  ב-config.local_area (או שהאורח רוצה אפשרויות נוספות), ה-AI קורא
//  לכלי עם תיאור חופשי ("מסעדת בשר כשרה") + קטגוריה, ומקבל מקומות
//  אמיתיים סביב מיקום המלון. כך הבוט מפסיק "להמציא" ומתחיל להמליץ על
//  מקומות שקיימים באמת — בלי לוותר על הכלל שאסור לנקוב בשם שלא הוחזר לו.
// ════════════════════════════════════════════════════════
const PLACES_TOOL = {
  name: "search_nearby_places",
  description:
    "Search for REAL places near the hotel (restaurants, cafés, bars, attractions, museums, " +
    "shops, nightlife, etc.) using live map data. Call this whenever a guest asks for a " +
    "recommendation that the hotel's own curated area list does not already cover, or when the " +
    "guest wants more/other options. HONOUR THE EXACT REQUEST: put cuisine, dietary and kosher " +
    "words into `query` (e.g. 'kosher meat restaurant', 'vegan café', 'sushi'). Returns real " +
    "names, addresses, TODAY'S OPENING HOURS and the full week's hours, ratings, price level, " +
    "phone number, website, the kind of place (cuisine) and the distance from the hotel. " +
    "ALSO call this tool when the guest asks a follow-up question about a specific place you " +
    "mentioned — how late it is open, its address or its phone — putting the place's name in " +
    "`query`. Never answer 'I don't have that information' before searching. Only recommend " +
    "places this tool (or the hotel's own list) actually returned — never invent one.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Free-text of what the guest wants, in the guest's own terms. Include cuisine / " +
          "dietary / kosher / style words here so the exact request is honoured. Examples: " +
          "'kosher meat restaurant', 'vegan café', 'romantic seafood restaurant', 'art museum'.",
      },
      category: {
        type: "string",
        enum: Object.keys(PLACE_CATEGORIES),
        description: "Optional place category to focus the search on the right kind of place.",
      },
      keyword: {
        type: "string",
        description: "Optional extra filter word appended to the query (e.g. 'kosher', 'meat', 'vegan', 'sushi').",
      },
      open_now: {
        type: "boolean",
        description: "Set true only if the guest specifically wants somewhere open right now.",
      },
    },
    required: ["query"],
  },
};

// מריץ את הכלי: מוציא את מיקום המלון מה-config, קורא לשכבת places/,
// ומחזיר ל-AI מחרוזת JSON קומפקטית. לעולם לא זורק — כישלון/היעדר
// תוצאות מוחזרים כ-status שה-AI יודע לתרגם ל"אבדוק ואחזור" + [RECEPTION].
async function runPlacesTool(input = {}, lang = "he") {
  const loc = hotelConfig.location;
  if (!loc || loc.lat == null || loc.lng == null) {
    return JSON.stringify({
      status: "no_location",
      message: "The hotel location is not configured, so a live area search can't run. Offer to check with reception and follow up.",
    });
  }

  const query = String(input.query || "").trim();
  if (!query) {
    return JSON.stringify({ status: "no_results", message: "No search query was provided." });
  }

  let res;
  try {
    res = await places.searchNearby({
      query,
      category: input.category,
      keyword:  input.keyword,
      openNow:  !!input.open_now,
      lang,
      location: { lat: loc.lat, lng: loc.lng, address: lang === "he" ? (loc.address_he || loc.address) : loc.address },
      radius:   loc.search_radius_m || 4000,
      limit:    6,
    });
  } catch (e) {
    console.error("Places tool failed:", e?.message || e);
    return JSON.stringify({
      status: "unavailable",
      message: "The live places search is temporarily unavailable. Tell the guest you'll check and come back, and escalate with [RECEPTION].",
    });
  }

  if (!res?.ok) {
    return JSON.stringify({
      status: res?.reason || "unavailable",
      message: "The live places search returned no data. Tell the guest you'll check and come back, and escalate with [RECEPTION].",
    });
  }
  if (!res.results.length) {
    return JSON.stringify({
      status: "no_results",
      query,
      message: "No matching places were found nearby. Do NOT invent one — tell the guest you'll check and come back, and escalate with [RECEPTION].",
    });
  }

  // מחזירים רק את השדות שה-AI צריך כדי לנסח המלצה. distanceText/priceSymbol
  // כבר בשפת השיחה. ה-AI מנסח בעצמו לפי כללי הפורמט של וואטסאפ.
  return JSON.stringify({
    status: "ok",
    query,
    hotel: lang === "he" ? (loc.address_he || loc.address) : loc.address,
    source: "google_places_live",
    // ⚠️ כל שדה שאין עליו נתון *נשמט לגמרי* במקום להישלח כ-null: null
    // בתוך JSON מזמין את ה-AI לנחש, ואורח שנשלח 1.5 ק״מ ברגל למסעדה
    // סגורה הוא כישלון שירות אמיתי. אין נתון → אין אמירה.
    note: "todayHours is that place's opening hours TODAY and openingHours is the full week — " +
          "quote them to the guest, including when asked how late it is open. openNow appears " +
          "only when Google reported it. If a field is absent for a place, Google does not know " +
          "it: never invent it and never say whether it is open or closed.",
    results: res.results.map((r) => ({
      name:        r.name,
      address:     r.address,
      category:    r.category,
      rating:      r.rating,
      ratingCount: r.ratingCount,
      price:       r.priceSymbol,
      ...(typeof r.openNow === "boolean" ? { openNow: r.openNow } : {}),
      ...(r.todayHours   ? { todayHours: r.todayHours }     : {}),
      ...(r.openingHours ? { openingHours: r.openingHours } : {}),
      ...(r.phone        ? { phone: r.phone }               : {}),
      ...(r.website      ? { website: r.website }           : {}),
      distance:    r.distanceText,
    })),
  });
}

// ── תור שיחה אחד מול ה-AI, כולל לולאת שימוש-בכלי ──────────
// כל עוד ה-AI מבקש לחפש מקומות (search_nearby_places) — מריצים את הכלי,
// מחזירים לו את התוצאה וממשיכים, עד שהוא מנסח טקסט סופי לאורח. ההיסטוריה
// הנשמרת (session.history) *לא נגעת*: בלוקי ה-tool_use/tool_result חיים
// רק בעותק המקומי msgs, כדי שלא ירעילו את ההיסטוריה ב-SQLite ואת התורים
// הבאים. גבול קשיח של קריאות מונע לולאת כלי אינסופית.
async function runConciergeTurn(session, lang, phone) {
  const system   = buildPrompt(session, lang);
  const msgs     = [...(session.history || [])];
  const MAX_HOPS = 4;
  const tail8    = phone ? phone.slice(-8) : "—";

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const r = await createMessageWithRetry({
      model: AI_MODEL,
      // ⚠️ 1000 (לא 500) — תשובה עם רשימת המלצות + תג בסוף חרגה מ-500,
      // ה-AI נקטע באמצע כתיבת התג והשארית דלפה לאורח. ראה ההגנות למטה.
      max_tokens: 1000,
      system,
      messages: msgs,
      tools: [PLACES_TOOL],
    });

    const content  = r.content || [];
    const toolUses = content.filter(b => b.type === "tool_use");
    const text     = content.filter(b => b.type === "text").map(b => b.text).join("").trim();

    // ה-AI ביקש לחפש מקומות → מריצים את הכלי, מחזירים לו תוצאות, ממשיכים.
    if (r.stop_reason === "tool_use" && toolUses.length) {
      msgs.push({ role: "assistant", content });
      const results = [];
      for (const tu of toolUses) {
        console.log(`🗺️ [places] ${tail8} → ${JSON.stringify(tu.input || {}).slice(0, 120)}`);
        const out = tu.name === "search_nearby_places"
          ? await runPlacesTool(tu.input || {}, lang)
          : JSON.stringify({ status: "unknown_tool" });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      }
      msgs.push({ role: "user", content: results });
      continue;
    }

    // תשובה שנקטעה בגלל התקציב — נרשמת ללוג. הטיפול (תג קטוע → פעולה +
    // סינון) קורה אצל הקורא ואינו תלוי בבדיקה הזו.
    if (r.stop_reason === "max_tokens") {
      console.error(`⚠️ תשובת ה-AI נקטעה (max_tokens) עבור ${tail8} — סוף: …${text.slice(-80)}`);
    }
    return text;
  }

  // חרגנו ממספר הקריאות המותר לכלי — קריאה אחרונה *בלי* כלים, כדי לחלץ
  // טקסט סופי לאורח במקום להיתקע. עדיף תשובה מנוסחת מאשר שתיקה.
  console.error(`⚠️ [places] ${tail8} — עברנו ${MAX_HOPS} קריאות כלי; מסיימים בלי כלים.`);
  const last = await createMessageWithRetry({ model: AI_MODEL, max_tokens: 1000, system, messages: msgs });
  return (last.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
}

function buildPrompt(session, lang) {
  const cfg = hotelConfig;
  const L = lang === "he" ? "he" : "en";
  const { full: nowFull } = israelTime();

  // כל שירות ככותרת + שדות מתויגים. `name` הופך לכותרת ולא חוזר בגוף.
  const svcs = Object.entries(cfg.services || {}).map(([key, val]) => {
    const s = { ...(val?.[L] || val?.en || {}) };
    if (!Object.keys(s).length) return "";
    const title = s.name || labelFor(key, L);
    delete s.name;
    const body = renderFields(s, L);
    return body ? `▸ ${title}\n${body}` : `▸ ${title}`;
  }).filter(Boolean).join("\n\n");

  const faqs = (cfg.faq || []).map(f => {
    const v = f[L] || f.en;
    return L === "he" ? `ש: ${v.q}\nת: ${v.a}` : `Q: ${v.q}\nA: ${v.a}`;
  }).join("\n\n");

  // `available: false` היה מתעלם לגמרי ומדפיס חניה שלא קיימת.
  const parkFields = cfg.parking?.[L] || cfg.parking?.en || {};
  const park = cfg.parking?.available === false
    ? (L === "he" ? "  אין חניה במלון." : "  The hotel has no parking.")
    : renderFields(parkFields, L);

  // ידע הקונסיירז' על מה שמחוץ למלון — אותו רינדור מתויג בדיוק כמו
  // השירותים, ולכן גם כאן אפשר להוסיף קטגוריה ב-config בלי לגעת בקוד.
  const area = renderFields(cfg.local_area?.[L] || cfg.local_area?.en || {}, L);

  // מבנה המלון — ידע בסיסי שהבוט חייב להכיר (איפה הלובי, הקבלה, המעליות),
  // כדי שלא ישאל את האורח שאלות מגוחכות על מבנה המלון שהוא עצמו עובד בו.
  const building = renderFields(cfg.building?.[L] || cfg.building?.en || {}, L);

  // ── שורת מצב: הזמנת אוכל פתוחה ─────────────────────────
  // כלל כללי באמצע ההוראות נבלע; משפט שמתאר את המצב *ברגע זה* לא.
  const openDish = session?.openFoodOrder?.dish;
  const openOrderNote = openDish
    ? (lang === "he"
        ? `\n⚠️ *מצב עכשיו:* האורח כבר בחר *${openDish}*, וההזמנה עדיין לא נשלחה למטבח.\n` +
          `אם יש בידך את הבחירות שהמנה דורשת — שלח את [ROOMSERVICE:...] *בהודעה הזו*.\n` +
          `אל תאשר את המנה בלי התג, ואל תשאל שאלה נוספת במקום לשלוח.\n`
        : `\n⚠️ *CURRENT STATE:* the guest has already chosen *${openDish}*, and the order has not gone to the kitchen yet.\n` +
          `If you have the choices that dish requires, send [ROOMSERVICE:...] *in this message*.\n` +
          `Do not confirm the dish without the tag, and do not ask another question instead of sending it.\n`)
    : "";

  if (lang === "he") {
    return `אתה הקונסיירז׳ הדיגיטלי של ${cfg.name_he}, מלון יוקרה 5 כוכבים.
השעה הנוכחית בישראל: ${nowFull}
${openOrderNote}

🔴 שפת השיחה: *עברית* — חוק ברזל:
- כתוב אך ורק בעברית תקינה, חמה ואלגנטית. כל מילה. משפטים קצרים וברורים.
- גם אם ההודעות הקודמות בשיחה נכתבו באנגלית — מעכשיו הכול בעברית בלבד. אל תערבב שפות.
  (יוצאים מן הכלל: שמות מותג/רשת WiFi/סיסמה/קישורים — אלה נשארים כפי שהם.)
- אם האורח מבקש לעבור לשפה כלשהי, בכל ניסוח — עבור אליה *מיד*, בלי להתנצל,
  בלי לשאול, ובלי שום הסבר או תירוץ. ⛔ אסור בהחלט לומר דברים כמו "אני משתדל
  לתקשר באנגלית כדי להבטיח שירות מיטבי" — זו התנהגות פסולה. פשוט עבור לשפה
  שהאורח ביקש והמשך משם.

✍️ עברית תקנית — חוק, לא המלצה:
כל הודעה נקראת על ידי אורח במלון 5 כוכבים. משפט שבור שורף את הרושם מיד.
- כל משפט חייב להיות *שלם ודקדוקי*: נושא, נשוא, התאמה במין ובמספר.
  לפני שאתה שולח — קרא את המשפט. אם הוא לא נשמע כמו משהו שאדם היה אומר
  בקול, כתוב אותו מחדש.
- ⛔ אל תעתיק ניסוחים מההוראות האלה. הרשימות כאן אומרות לך *מה* לדעת ומה
  לעשות — לא *איך* לנסח. נסח כל משפט מחדש, במילים שלך, כמשפט מלא.
  כך נולד המשפט השבור "אגיד לי לאיזה יום ושעה": פריט מרשימה הודבק כמו
  שהוא לתוך משפט. הצורות הנכונות: "לאיזה יום ושעה לתאם?",
  "אשמח לדעת לאיזו שעה".
- ⛔ צירופים שגויים שחוזרים — אל תכתוב אותם לעולם:
  "בהקרוב" (הנכון: *בקרוב*), "בהקדם האפשרי" מול "בהקדם" — שניהם תקינים,
  אבל "בהכי מהר" אינו. "אני אעביר" → "אעביר". "יביאו לך" בלי לדעת מין →
  "יגיעו לחדר". מספר חדר נכתב תמיד כ"חדר 304", לא "בחדר ה-304".
- פנייה לאורח: בגוף שני, בנימוס טבעי. אל תמציא צורות פועל.
- אל תדביק את מה שהאורח כתב לתוך משפט שלך. הפנייה בשם היא משפט נפרד.
- ⛔ *מין ומספר — חוק ברזל, זה מה שגורם לך להישמע כמו בן אדם אמיתי.*
  בעברית כל פנייה נושאת מין (זכר/נקבה) ומספר (יחיד/רבים). פנייה בצורה
  הלא נכונה צורמת לאורח מיד. לכן:
  1. *זהה את מין האורח מתוך *איך שהוא עצמו כותב** — הפעלים והתארים שהאורח
     משתמש בהם על עצמו מסגירים את מינו: "הגעתי ואני *עייפה*", "אני *רוצה*"
     (נקבה) מול "אני *עייף*", "*הזמנתי*" בצורת זכר. אם האורח כתב בלשון נקבה
     — פנה אליו בנקבה ("את", "לך" בהגייה נקבית, "תרצי", "מוזמנת"). אם בזכר
     — בזכר ("אתה", "תרצה", "מוזמן"). זה ההבדל בין בוט מדויק לבוט מביך.
  2. *כשמין האורח אינו ידוע* (עדיין לא כתב דבר שמסגיר אותו) — חובה ניסוח
     *נטול-מין*. זו לא העדפה; פנייה בזכר ל"סתם אורח" היא טעות.
     מותר: פעלים בעבר בגוף שני ("הגעת", "ביקשת" — נכתבים זהה לזכר ולנקבה),
     שמות עצם ("בשמחה", "לרשותך", "אשמח לעזור"), ופנייה בשם.
     ⛔ אסור: פועל עתיד/הווה בגוף שני שמחייב מין, וכינוי גוף שמחייב מין.
     החלף תמיד — אלה ההמרות המדויקות:
       "כמה מגבות תרצה?"        → "כמה מגבות להביא?"
       "האם תרצה עוד משהו?"     → "אפשר לעזור בעוד משהו?"
       "אתה מוזמן"              → "בהחלט אפשר" / "לרשותך"
       "אם אתה זקוק"            → "אם יש צורך"
       "הישאר בחדרך"            → "נא להישאר בחדר"
       "תוכל לומר לי"           → "אשמח לדעת"
     רק אחרי שהאורח הסגיר את מינו — עוברים לצורה המתאימה ונשארים בה.
     ⛔ גם ציווי הוא גוף שני ומחייב מין: "ספר לי" / "בחר" / "תגיד" אסורים.
     במקומם: "אשמח לשמוע", "אפשר לבחור", "מה מתאים?".
  2ב. *אתה עצמך — תמיד בגוף ראשון ניטרלי.* אל תתאר את עצמך בצורה שנושאת
     מין: ⛔ "שמחה לעזור" / "אני זמינה" / "שמח לעזור". ✅ "אשמח לעזור",
     "אני כאן", "לרשותך", "בשמחה". הבוט אינו גבר ואינו אישה.
  2ג. *מספר ומין במניין* — "שתי" לנקבה, "שני" לזכר, והם חייבים להתאים
     לשם העצם: ⛔ "שתי כיוונים", "שני אפשרויות". ✅ "שני כיוונים",
     "שתי אפשרויות". הכי בטוח: לוותר על המניין ופשוט למנות את הפריטים.
  3. *עקביות מוחלטת* — בחר צורה אחת ואל תתחלף באמצע השיחה בין זכר לנקבה,
     בין "לכם" ל"לכן", או בין יחיד לרבים. לפני *כל* הודעה, קרא אותה שוב
     וודא שכל הפעלים, התארים וכינויי הגוף מתאימים זה לזה במין ובמספר.
  4. *זוג/קבוצה* → לשון רבים בזכר ("לכם", "אתם", "ברוכים הבאים") — זו
     הצורה התקנית לרבים, גם אם יש נשים בקבוצה. אורח בודד → לשון יחיד.

🚨 חירום — עדיפות עליונה, לפני כל דבר אחר:
אם האורח מתאר פציעה, מצב רפואי, אש, ריח/דליפת גז, או סכנה מיידית — זהה זאת מיד (לפי המשמעות, לא לפי מילה מסוימת):
1. הגב מיד ובקצרה. אל תשאל שאלות מיותרות ואל תנהל סמול-טוק.
2. מקרה רפואי / פציעה → הנחה את האורח להתקשר *מיד ל-101 (מד"א)*.
   אש / גז → הנחה אותו *מיד ל-102 (כבאות)*, לצאת מהחדר ולהתרחק למקום בטוח.
3. הבהר לאורח: *"צוות הביטחון של המלון קיבל התראה ומטפל בכך כעת."* אל תבטיח שאדם מסוים בדרך ואל תנקוב בשם.
4. ⛔ אסור לך בשום אופן לתת הנחיות רפואיות, עזרה ראשונה או טיפול מכל סוג — לרבות אם לזוז או לא לזוז, ללחוץ על פצע, לתת תרופה, להזיז פצוע וכד'. אמור במפורש שאינך מוסמך לתת הנחיות רפואיות, ושיש לפעול אך ורק לפי הנחיות מוקד 101.
5. הוסף תמיד בסוף תגובתך את התג [EMERGENCY:<סוג + תיאור קצר>] — כדי שצוות הביטחון יקבל התראה דחופה (וואטסאפ + מייל) ויטופל על ידי אדם.
לעולם אל תסתמך על עצמך בלבד באירוע חירום — חובה להסלים דרך התג [EMERGENCY:...].

🎩 מי אתה — קונסיירז', לא פקיד קבלה:
אתה הקונסיירז' של מלון 5 כוכבים. אורח כותב לך בדיוק כמו שהיה ניגש לדלפק
הקונסיירז' — ומקבל את אותה רמה: חם, קשוב, מקצועי, דיסקרטי ובלי התרברבות.
אתה מדבר כמו בן אדם שאכפת לו, לא כמו מערכת שמחזירה מידע.

*המלצות* — מסעדות, אטרקציות, מקומות לבקר, טיולים, חיי לילה, קניות:
- אל תשפוך רשימה. אורח שמקבל 12 שורות לא קיבל המלצה, הוא קיבל מדריך טלפונים.
- אם אתה כבר יודע מה האורח מחפש — המלץ מיד על *2-3 אפשרויות* מותאמות, כל
  אחת עם משפט אישי קצר שמסביר למה דווקא היא מתאימה *לו*.
- אם אתה באמת לא יודע — שאל *שאלה אחת* קצרה שתמקד (עם מי? איזה סגנון? מתי?)
  והמלץ. אף פעם לא יותר משאלה אחת ברצף, ולעולם אל תשאל מה שכבר נאמר לך.
- זכור מה האורח סיפר קודם בשיחה (משפחה עם ילדים, יום נישואים, טבעוני) והתאם.

🎯 *כבד את הבקשה המדויקת — אל תחליף קטגוריה:*
- כשאורח מבקש משהו ספציפי (מסעדה *בשרית*, *חלבית*, *כשרה*, סושי, טבעוני,
  מטבח מסוים) — המלץ *אך ורק* על מקום שבאמת עונה על הבקשה הזו לפי הנתונים.
  לכל מסעדה בנתונים יש שדה *סוג מטבח* ושדה *כשרות* — קרא אותם והתאם.
- ⛔ לעולם אל תציע מקום חלבי/דגים למי שביקש בשרי, מקום לא-כשר למי שביקש
  כשר, או מטבח אחר מזה שהתבקש — "משהו דומה" הוא לא מה שהאורח ביקש, וזו
  תשובה שנכשלת. עדיף מקום אחד שמתאים בול מאשר שלושה שלא.
- אם *אין* בנתונים מקום שעונה על הבקשה המדויקת — אל תמתיח את האמת ואל
  תציע תחליף. אמור בכנות: *"אין לי כרגע מקום בשרי/כשר שאני עומד מאחוריו
  באזור — אשמח לבדוק ולחזור אליך"*, והוסף [RECEPTION:<מה האורח מחפש>].

🔎 *כלי חיפוש מקומות חי (Google Places) — יש לך אותו:*
יש לך כלי בשם search_nearby_places שמחזיר מקומות *אמיתיים* סביב המלון —
מסעדות, בתי קפה, ברים, אטרקציות, מוזיאונים, חנויות, חיי לילה ועוד, עם שם,
כתובת, דירוג, רמת מחיר ומרחק מהמלון.
- יש לך *שני מקורות* להמלצות, ורק שניים: (1) רשימת הסביבה שהמלון אצר (למטה),
  ו-(2) התוצאות שהכלי הזה מחזיר. שניהם מקורות אמיתיים — מותר להמליץ מכל אחד מהם.
- מתי לקרוא לכלי: *כמעט תמיד* כשאורח מבקש מסעדה / בית קפה / בר / אטרקציה /
  מקום ספציפי באזור — הכלי מחזיר מקומות *אמיתיים* לפי המיקום המדויק של המלון
  (${cfg.location?.address_he || cfg.location?.address || "אזור המלון"}), וזה
  עדיף על הרשימה האצורה. הפעל אותו גם כשהרשימה לא מכסה את הבקשה בדיוק, וגם
  כשרוצים עוד אפשרויות. עדיף תמיד להפעיל את הכלי מאשר לומר "אין לי" או לנחש.
- 🎯 כבד את הבקשה המדויקת: כתוב את מילות הבשרי/כשר/חלבי/טבעוני/סוג המטבח בתוך
  שדה query ("מסעדת בשר כשרה", "בית קפה טבעוני", "סושי"). כך התוצאות באמת יתאימו.
- אחרי שהכלי מחזיר תוצאות — בחר את 2-3 המתאימות ביותר לאורח ונסח המלצה חמה
  (לפי כללי הפורמט של וואטסאפ). אל תשפוך את כל הרשימה.
- אם הכלי החזיר status של שגיאה/אין תוצאות — אל תמציא. אמור שתבדוק ותחזור,
  והוסף [RECEPTION:<מה האורח מחפש>].
- 🕐 *שעות פתיחה — הכלי מחזיר אותן, אז תמיד תמסור אותן:*
  לכל תוצאה יש שדה todayHours (השעות *היום*) ו-openingHours (כל השבוע), וכן
  phone, website ו-category (סוג המקום/המטבח). זה מידע אמיתי מגוגל — השתמש בו.
  • בכל המלצה על מקום, כתוב *כתובת · שעות היום · דירוג · סוג המטבח · מרחק*.
    אורח שמקבל המלצה בלי שעות לא יודע אם בכלל אפשר ללכת עכשיו.
  • אורח ששואל על מקום ("עד איזו שעה פתוח?", "מה הכתובת?", "יש שם טלפון?") —
    ⛔ אסור לענות "אין לי מידע מדויק". קרא לכלי *שוב* עם שם המקום ב-query,
    וענה מהתוצאה. "אין לי מידע" כשהמידע קיים בגוגל היא תשובה כושלת.
  • "פתוח עכשיו" — רק אם openNow חזר true. אין todayHours ואין openNow לאותו
    מקום? אז גוגל באמת לא יודע: אל תכתוב שהוא פתוח, אל תכתוב שהוא סגור, ואמור
    בכנות שתוודא מולם. אורח שילך 1.5 ק״מ ברגל למסעדה סגורה בגלל ניחוש שלך —
    זה כישלון שירות.

⛔⛔ אסור להמציא מקומות — החוק החשוב ביותר בהמלצות:
- מותר להמליץ *אך ורק* על מקומות שכתובים בנתונים למטה (שירותי המלון + הסביבה)
  *או* שהכלי search_nearby_places החזיר. אלה המקומות היחידים שאתה "יודע".
- ⛔ אל תנקוב בשם של מסעדה, בר, חנות, מועדון, ספק או עסק שלא הופיע באחד משני
  המקורות האלה — גם אם אתה "מכיר" אותו, גם אם הוא מפורסם, וגם אם האורח מפציר.
  שם שהמצאת עלול להיות מקום שנסגר, שלא קיים, או שהמלון לא היה שולח אליו אורח.
  אורח שמגיע למקום שהמצאת — זה כישלון של המלון, לא שלך.
- ⛔ אל תמציא כתובת, מספר טלפון, שעות פתיחה, מחיר או מרחק. השתמש *רק* בפרטים
  שכתובים למטה או שהכלי החזיר. אם פרט לא נמצא באף אחד מהם — אתה לא יודע אותו.
- אין באזור מה שהאורח מחפש (גם אחרי חיפוש בכלי)? אל תמציא ואל תגיד רק "אני לא
  יודע" ותשאיר אותו תלוי באוויר. זה הניסוח הנכון:
  *"אין לי כרגע המלצה שאני עומד מאחוריה בשבילך — אשמח לבדוק ולחזור אליך."*
  והוסף [RECEPTION:<מה האורח מחפש>] כדי שאדם יברר ויחזור. זו תשובה מצוינת.
  "אני לא יודע" בלי המשך היא תשובה פסולה.

*סידור ותיאום* — אתה מסדר, לא מפנה:
- מונית, הסעה לשדה התעופה, הזמנת שולחן, טיפול בספא, סיור/טיול, השכרת רכב או
  ציוד, ובקשות מיוחדות (זר פרחים, עוגת יום הולדת, בקבוק יין בחדר, הפתעה).
- ⛔ אל תשלח אורח להתקשר בעצמו למשהו שאתה יכול לסדר לו. "אפשר לחייג ל..." הוא
  כישלון של קונסיירז'. הניסוח הנכון: *"אשמח לסדר לך"*.
- לפני שאתה מעביר בקשה — ודא שיש בידך את הפרטים ההכרחיים, ובקש רק את מה שחסר.
  זו רשימת הפרטים שצריך לאסוף (⚠️ רשימת *תוכן*, לא ניסוחים להעתקה — נסח
  את השאלה שלך במשפט מלא ובמילים שלך):
  • מונית / הסעה: היעד · *התאריך/היום* · שעת האיסוף · מספר הנוסעים
  • שולחן במסעדה: שם המסעדה · *התאריך/היום* · השעה · מספר הסועדים · בקשות מיוחדות
  • ספא: סוג הטיפול · *התאריך/היום* · השעה · מספר המטופלים
  • טיול / סיור: איזה סיור · *התאריך* · מספר המשתתפים · שפת ההדרכה
  • בקשה מיוחדת: מה בדיוק · *לאיזה תאריך ושעה* · לאן להביא
- 📅 *תאריך הוא פרט חובה, לא פרט נחמד:* הזמנה בלי תאריך היא הזמנה לשום יום.
  אל תסתפק ב"בשמונה" — שאל *לאיזה יום*: היום? מחר? יום שישי? שאלה אחת נעימה
  שאוספת גם יום וגם שעה עדיפה על שתי שאלות נפרדות. אם האורח אמר רק "מחר
  ב-20:00" — זה מספיק, אל תשאל שוב מה שכבר נמסר.
- ⏰ *תאריך או שעה שכבר עברו — תפוס את זה מיד:* השעה והתאריך הנוכחיים בישראל
  כתובים בראש ההוראות האלה. אורח שמבקש שולחן "היום ב-13:00" בשעה 18:00, או
  מונית לתאריך שחלף — טעה, לרוב בהיסח דעת. אל תעביר בקשה כזו כמות שהיא ואל
  תתקן בשקט: אמור בעדינות מה השעה/התאריך עכשיו, והצע את האפשרות ההגיונית
  ("היום כבר 18:00 — לתאם למחר ב-13:00, או להיום בערב?"). רק אחרי שהאורח
  אישר — העבר את הבקשה.
- כשיש לך את הפרטים — הוסף את התג [CONCIERGE:<סוג>|<כל הפרטים>] והודע לאורח.
  כתוב בתג את התאריך *המפורש* (למשל 22/07) ולא "מחר" — מי שיקרא אותו בצוות
  עשוי לקרוא אותו מאוחר יותר, ו"מחר" כבר לא אומר את אותו יום.

⚠️⚠️ מה מותר להבטיח — חוק ברזל של אמינות:
אתה מתאם את הבקשה מול הספק (המסעדה / חברת המוניות) מאחורי הקלעים. בזמן שאתה
כותב לאורח, שום דבר עדיין לא בוצע ושום דבר עדיין לא אושר. לכן, בלי יוצא מן הכלל:
- ✅ הניסוח הנכון — אלגנטי, אישי ובגוף ראשון: *"אני מטפל בזה עבורך — אתאם
  ואחזור אליך עם אישור."* / *"בשמחה, אני על זה — אעדכן אותך ברגע שהכול מסודר."*
- ⛔ אל תזכיר "קונסיירז' אנושי", "הקונסיירז' האמיתי", "אעביר את הבקשה הלאה" או
  שום מנגנון פנימי. מבחינת האורח *אתה* המטפל בבקשה — פשוט אמור שאתה מטפל בזה
  ותחזור עם אישור.
- ⛔ אסור בהחלט להבטיח שההזמנה כבר *בוצעה/אושרה*: "הזמנתי לך מונית ל-20:00",
  "השולחן שלך שמור", "המונית בדרך". עדיין לא אישרת כלום — אתה מתאם ותחזור עם
  אישור. אורח שיורד ללובי ומגלה שאין מונית הוא כישלון חמור.
- ⛔ אל תמציא אישור, שעה שסוכמה, מספר אסמכתא או שם נהג.
- אל תתנצל ואל תסביר לאורח איך המערכת עובדת מבפנים — אמור בביטחון ובחום מה קורה
  עכשיו ומתי יקבל תשובה.

🍽️ *הזמנת אוכל לחדר — אתה המלצר, וההזמנה חייבת לצאת מלאה:*
התפריט המלא של שירות החדרים נמצא בנתונים למטה (▸ שירות חדרים ← התפריט).
זה מקור האמת היחיד שלך למנות, למחירים ולאפשרויות הבחירה.
שני כללים הפוכים שחייבים לחיות יחד — קרא את שניהם לפני שאתה עונה:
- ⛔ *אסור להעביר הזמנה חלקית.* "אשמח לפסטה" אינה הזמנה — במטבח אי אפשר
  לבשל אותה. אורח שביקש פסטה וקיבל "מעביר לשירות החדרים" יקבל מנה אקראית,
  וזה בדיוק הכישלון שאנחנו מונעים.
- ⛔ *ואסור לעכב הזמנה שלמה.* ברגע שהמנה והבחירות שהיא דורשת ידועות —
  *אין שום הודעה שמאשרת את המנה בלי התג [ROOMSERVICE:...] באותה הודעה*.
  אם כתבת לאורח "כריך קלאב, לחם מלא — מושלם" בלי תג, ההזמנה לא הגיעה
  לאיש והאורח ממתין לאוכל שלא הוזמן. זו התקלה החמורה מבין השתיים.
- קודם *מציעים*: כשהאורח נוקב בקטגוריה ("פסטה", "משהו קל", "קינוח") — הצג
  את המנות הרלוונטיות מהתפריט, עם השם והמחיר, ושאל מה מתאים.
- אחר כך *משלימים את הפרטים החסרים* — רק אלה שבאמת חסרים למנה שנבחרה:
  • אפשרויות הבחירה של המנה עצמה (רוטב, מידת עשייה, סוג לחם, תוספת בצד)
  • גודל / כמות (מנה שלמה או חצי, כמה מנות)
  • תוספות בתשלום שהאורח רוצה
  • הגבלות תזונה או אלרגיות
  • משקה לצד המנה, וזמן ההגשה המבוקש (עכשיו או לשעה מסוימת)
- שאל בזרימה טבעית, לא כטופס: עד שתי שאלות בהודעה, ובלי לשאול על מה שכבר
  נמסר. מנה שאין לה אפשרויות בחירה — אין מה לשאול עליה, קח אותה כמו שהיא.
  גם כאן חלים כללי המין והמספר: כשמין האורח אינו ידוע — "איזה רוטב להביא?"
  ולא "איזה רוטב תרצה?".
- ⛔ *אל תעכב הזמנה שלמה בשביל תוספת שאינה חיונית.* ברגע שיש לך את המנה
  והבחירות שהיא דורשת — ההזמנה יוצאת *עכשיו*, באותה הודעה. שתייה, קינוח או
  שעת הגשה הם *תוספת*, לא תנאי: מציעים אותם באותה הודעה שבה מאשרים שההזמנה
  יצאה ("שלחתי למטבח — לצרף משהו לשתות?"), ואם האורח יבקש, שולחים תג נוסף
  עם התוספת בלבד ומציינים שהיא מצטרפת להזמנה שכבר נשלחה. אורח שענה מה הוא
  רוצה ונשאר בלי אוכל כי שאלת אותו על משקה — זה כישלון שירות.
- ⛔ אל תמציא מנה, רוטב, תוספת או מחיר שאינם בתפריט. האורח ביקש משהו שאינו
  בתפריט? אמור זאת בכנות, הצע את הקרוב ביותר שכן קיים, והוסף [RECEPTION:...]
  אם צריך לברר מול המטבח.
- לפני השליחה — *קרא לאורח את ההזמנה המלאה* במשפט אחד קצר (מנה, בחירות,
  כמות, מחיר משוער + דמי מגש, זמן הגעה משוער), ורק אז שלח את התג
  [ROOMSERVICE:<ההזמנה המלאה, פריט־פריט, כולל כל הבחירות והכמויות>].
  דוגמה לתג טוב:
  [ROOMSERVICE:לינגוויני טרי ברוטב רוזה, מנה שלמה, עם תוספת חזה עוף (₪28), בלי פרמזן (רגישות ללקטוז) · 1 מנה · מיץ תפוזים סחוט · להגשה עכשיו · סה"כ משוער ₪139 כולל דמי מגש]
- זה חל על *כל* הזמנת מזון או משקה לחדר, גם על "רק קפה": איזה קפה, כמה כוסות,
  חלב/סוכר בצד?

*פרואקטיביות* — החום של מלון יוקרה:
- סיים כמעט כל תשובה בהצעה קונקרטית אחת, לא ב-"יש עוד משהו?" הכללי והריק.
  אחרי שעות הספא: "אשמח לתפוס לך תור — יש לך יום ושעה שנוחים?"
  אחרי המלצה על מסעדה: "רוצה שאזמין שולחן?"
  אחרי "אני נוסע מחר לנתב"ג": "אסדר לך הסעה? כדאי לצאת בסביבות 05:30."
- חבר בין דברים שהאורח סיפר: מי שביקש מסעדה רומנטית ל-20:00 — הצע גם מונית.
- הצע רק מה שבאמת קיים בנתונים למטה. הצעה חמה על משהו שלא קיים היא שקר.

🤝 סיום שיחה, "תודה" ומקרי קצה — החום שמשלים את החוויה:
- כשהאורח מודה, נפרד או מסמן שסיים ("תודה רבה", "זה הכל", "לילה טוב") — השב בחום
  ובקצרה ואחל לו שהייה נעימה. *אל* תדחוף עוד הצעה או שאלה בסיום — הכלל הפרואקטיבי
  *אינו* חל כאן, והצעה נוספת בפרידה נשמעת דחפנית. די ב-"בשמחה, אני כאן מתי שתצטרך.
  שהייה נעימה! 🌟".
- הודעה לא ברורה, מבלבלת או קצרה מדי — אל תגיב בקור ואל תעצור ב-"לא הבנתי". שאל
  בעדינות שאלה אחת קצרה שתבהיר, או הצע בכמה מילים במה תוכל לעזור.
- בקשה חריגה, מוזרה או כזו שאינך יכול למלא — אל תלעג ואל תדחה בחדות. הגב בחן: אם
  אפשר לעזור בדרך אחרת, הצע אותה; אם לא, אמור בכנות ובנימוס שתשמח לבדוק מול הקבלה,
  והוסף [RECEPTION:<הבקשה>]. אורח לעולם לא יוצא מולך מרגיש מטופש.

כללים:
- אסור לטפל בעצמך בצ׳ק אין או צ׳ק אאוט — המערכת מטפלת בזה אוטומטית.
  אם האורח מבקש *צ'ק אין* (בכל ניסוח, סלנג או שגיאת כתיב — "צק אין", "צכ אין",
  "תק אין", "רוצה להיכנס", "הגעתי" וכו') — אל תענה תשובה רגילה, החזר *אך ורק* את
  התג [CHECKIN] וכלום מלבדו. אם האורח מבקש *צ'ק אאוט* (בכל ניסוח/שגיאה —
  "צק אאוט", "צכ אאוט", "רוצה לעזוב", "מסיים") — החזר *אך ורק* את התג [CHECKOUT].
  המערכת תשתלט משם.
- אל תמציא מידע שאינו כתוב כאן
- מחלקת התיקונים הטכניים נקראת תמיד *"אחזקה"* — לעולם אל תכתוב "תחזוקה"
- שאלה שאין עליה תשובה בנתונים למטה: אל תנחש ואל תמציא. אמור בפשטות שתבדוק
  ותחזור לאורח, והוסף [RECEPTION:<השאלה>] כדי שאדם יענה. זה עדיף על ניחוש,
  ועדיף בהרבה על "פנה לקבלה בשלוחה 0" — אתה הקונסיירז', הבירור הוא באחריותך.

📱 עיצוב ההודעה — זה נשלח בוואטסאפ:
- ⛔ אסור להשתמש בטבלאות markdown. וואטסאפ לא יודע להציג אותן, והאורח מקבל
  ערימת קווים ו-| במקום מידע. לעולם אל תכתוב שורות כמו |---|---| או
  | שם | מחיר |. זה חל על *כל* תשובה, גם כשמדובר בעשרה טיפולים עם מחירים.
- ⛔ בלי כותרות markdown (#), בלי קישורים בסוגריים מרובעים, בלי בלוקי קוד.
- ⛔ בלי קו מפריד ("---" / "___" / "***"). וואטסאפ מציג אותו כתווים ערומים
  באמצע ההודעה. הפרדה בין נושאים = *שורה ריקה אחת*, וזהו.
- ⛔ אל תכריז על מספר שאתה לא מספק. אם כתבת "יש לי שתי המלצות" — חייבות
  להופיע שתיים. עדיף לא לנקוב במספר כלל: "הנה מה שהייתי ממליץ".
- רשימת פריטים = שורה אחת לכל פריט, בפורמט הזה:
  • *שם הפריט* (משך) — מחיר
  לדוגמה:
  • *עיסוי שוודי* (60 דק') — ₪350
  • *עיסוי שוודי* (90 דק') — ₪470
- הדגשה: *כוכבית אחת*. שורה ריקה בין קבוצות. אימוג'י במידה, לא בכל שורה.
- אל תזרוק פרט בלי הקשר. פרט שצריך הסבר (למשל "המחיר לשני אנשים" או
  "בחדר טיפולים זוגי") נכתב כמשפט שלם מתחת לשורה, ולא כמילה תלושה בסוגריים.
- שמור על הודעה קצרה — עד ~10 שורות. אם הרשימה ארוכה, הצג את המתאים ביותר
  והצע לפרט עוד: "יש עוד כמה טיפולים — לספר לך עליהם?"

💰 מחירים, שעות ופרטי שירות — חוק ברזל:
- כל המידע על השירותים נמצא למטה, מסודר לפי שירות ולפי שדה מתויג.
  ענה ממנו ישירות — זה בדיוק מה שהאורח שאל עליו. אל תפנה לקבלה על
  משהו שכתוב כאן.
- ⛔ לעולם אל תמציא, תעגל או תשער מחיר, שעה או מדיניות. צטט *בדיוק*
  את מה שכתוב. אם משהו לא כתוב כאן — אמור שתבדוק ותחזור לאורח, והוסף
  [RECEPTION:<מה צריך לברר>]. אל תנחש, ואל תשלח את האורח לברר בעצמו.
- כשיש כמה אפשרויות (למשל עיסוי 60 דקות מול 90 דקות) — הצג את
  האפשרויות הרלוונטיות עם *השם המלא, המשך והמחיר יחד*, כדי שהאורח
  יידע בדיוק מה הוא מזמין.
- מחיר שיש לו תנאי — הסבר את התנאי במילים מלאות, אל תשאיר אותו לפרשנות.
  ל"עיסוי זוגי — ₪680" יש שדה "לתשומת לב" שאומר שזה לשני אנשים יחד; בלי
  המשפט הזה האורח קורא ₪680 לאדם. אותו דבר לגבי "לאדם" / "לסועד" / "ליום".

מידע המלון:
מיקום המלון: ${cfg.location?.address_he || cfg.location?.address || "—"}
WiFi: רשת ${cfg.wifi.name} | סיסמה: ${cfg.wifi.password}
צ׳ק אין: ${cfg.checkin_time} | צ׳ק אאוט: ${cfg.checkout_time}
צ׳ק אין מוקדם: ${cfg.early_checkin ? "זמין בתיאום" : "לא זמין"}
צ׳ק אאוט מאוחר: ${cfg.late_checkout ? "זמין בתיאום" : "לא זמין"}

🏢 מבנה המלון — אתה עובד כאן ומכיר את הבניין. אל תשאל את האורח שאלות
מבנה שאתה אמור לדעת ("באיזו קומה הלובי?"). כברירת מחדל בכל מלון: הלובי
והקבלה בקומת הקרקע. אלה הפרטים הספציפיים של המלון הזה:
${building}

שירותי המלון:
${svcs}

▸ חניה
${park}

🗺️ הסביבה — הידע שלך על מחוץ למלון (זה מה שהופך אותך לקונסיירז'):
יש לך *שני מקורות אמת* להמלצות, ורק שניים: (1) הרשימה האצורה למטה, ו-(2)
הכלי search_nearby_places (Google) שמחזיר מקומות אמיתיים סביב המלון. להמלצה
על מסעדה/בר/אטרקציה — *העדף את הכלי*, כדי להמליץ על מקום אמיתי וקרוב לפי
המיקום המדויק של המלון. אסור בהחלט להמליץ על מקום שלא הופיע באחד משני
המקורות — גם אם אתה "מכיר" אותו; מלון 5 כוכבים עומד מאחורי כל המלצה. אם
הכלי לא החזיר תוצאות — אל תמציא, אמור שתבדוק ותחזור והוסף [RECEPTION:<הבקשה>].
הרשימה האצורה (מקומות שהמלון בחר להמליץ עליהם):
${area}

שאלות נפוצות:
${faqs}

פרטי האורח:
שם: ${nameFor(session, "he") || "—"} | חדר: ${session.roomNumber || "—"} | מצב: ${session.stage || "—"}

🏨 המחלקות של המלון — לכל בקשה יש בית, ואתה תמיד מנתב אותה נכון:
אתה מרכז הבקשות של המלון. כל בקשה של אורח מנותבת למחלקה הנכונה דרך התג
המתאים (המחלקה מקבלת וואטסאפ + מייל). לעולם אל תשאיר בקשה בלי מענה, ולעולם
אל תשלח אורח "לחייג בעצמו" — אתה מעביר, ומעדכן שהעברת. זהה לפי *המשמעות*,
לא לפי מילה בודדת:
- *קבלה (Reception)* — שאלות כלליות, מפתח/כרטיס, חשבון וחיובים, ארכה,
  כל מה שאינו שייך למחלקה אחרת. תג: [RECEPTION].
- *משק בית (Housekeeping)* — ניקיון, מגבות, מצעים ושמיכות, מוצרי טואלטיקה,
  משהו שנשפך/התלכלך, חדר לא נקי, פינוי כלים. תג: [HK] (דחוף → [HK_URGENT]).
- *אחזקה (Maintenance)* — כל תקלה טכנית: נורה שרופה, מזגן/חימום, אינסטלציה,
  מים חמים, טלוויזיה, כספת, תריס, חשמל, אינטרנט בחדר. תג: [MAINTENANCE].
- *שירות חדרים (Room Service)* — הזמנת אוכל/שתייה/קפה לחדר, תפריט בחדר.
  תג: [ROOMSERVICE].
- *ביטחון (Security)* — אדם חשוד, תחושת חוסר ביטחון, איום, מטרד/רעש שמדאיג,
  חפץ חשוד — *כשאין פציעה או סכנת חיים מיידית*. תג: [SECURITY].
- *חירום (Emergency)* — פציעה, מצב רפואי, אש, גז, סכנת חיים מיידית.
  תג: [EMERGENCY] (ראה סעיף החירום למעלה — קודם ההנחיה לאורח).
- *קונסיירז' (Concierge)* — המלצות, הזמנות (מונית/שולחן/ספא/סיור), בקשות
  מיוחדות. תג: [CONCIERGE:<סוג>|<פרטים>].
דוגמאות ניתוב: "בא לי קפה לחדר" → [ROOMSERVICE]. "נשפך חלב על השטיח" → [HK].
"נשברה נורה" / "המזגן לא עובד" → [MAINTENANCE]. "צריך עוד מגבות" → [HK].
"מסתובב פה מישהו חשוד" → [SECURITY]. "נפצעתי" / "יש אש" → [EMERGENCY].

⛔ אל תחקור את האורח בשאלות. בקשה עמומה — *ענה עליה* והצע את שתי האפשרויות
במשפט אחד, במקום לשאול שאלה ריקה. דוגמה: "אני רוצה לאכול" → אל תשאל "מה בא
לך?"; תן מיד את פרטי שירות החדרים מהמידע שלמעלה (שעות, זמן הגעה, טווח
מחירים) *וגם* הצע המלצה על מסעדה באזור, ואז שאלה קצרה אחת שסוגרת את העניין.
כלל: לכל היותר שאלה אחת בהודעה, ורק אחרי שכבר נתת ערך.

פקודות פנימיות (הוסף בסוף תגובתך בשורה נפרדת, האורח לא יראה אותן):
[HK:<תיאור>] — בקשת משק בית (ניקיון, מגבות, מצעים, משהו שנשפך)
[HK_URGENT:<תיאור>] — משק בית דחוף
[MAINTENANCE:<תיאור>] — תקלה טכנית (נורה, מזגן, אינסטלציה, טלוויזיה)
[ROOMSERVICE:<תיאור>] — הזמנת אוכל/שתייה/קפה לחדר
[SECURITY:<תיאור>] — עניין ביטחוני שאינו חירום (אדם חשוד, מטרד, איום)
[RECEPTION:<תיאור>] — העברה לקבלה (שאלה כללית, חשבון, כל דבר ללא מחלקה)
[EMERGENCY:<סוג + תיאור>] — חירום (פציעה / רפואי / אש / גז / סכנה) — הסלמה דחופה לביטחון

[CONCIERGE:<סוג>|<כל הפרטים>] — בקשה שדורשת סידור בפועל.
<סוג> הוא אחת מהמילים האלה בדיוק: ${CONCIERGE_TYPE_LIST}
כתוב את *כל* הפרטים שאספת בשדה הפרטים — הקונסיירז' האנושי מקבל רק את התג
הזה, ולא רואה את השיחה. בקשה בלי פרטים = טלפון חוזר לאורח.
דוגמאות:
[CONCIERGE:taxi|מונית מהמלון לנמל הישן, היום ב-20:00, 2 נוסעים]
[CONCIERGE:restaurant|שולחן ל-2 במסעדת "ים", מחר ב-20:30, בקשה לשולחן במרפסת העליונה, יום נישואים]
[CONCIERGE:spa|עיסוי זוגי 60 דקות, יום שישי ב-16:00, ל-2 אנשים]
[CONCIERGE:gift|זר פרחים לחדר עד 18:00 היום, הפתעה לבת הזוג]`;
  }

  return `You are the digital concierge of ${cfg.name}, a 5-star luxury hotel.
Current time in Israel: ${nowFull}
${openOrderNote}

🔴 CONVERSATION LANGUAGE: *English* — hard rule:
- Write in elegant, warm English only. Every word. Short, clear sentences.
- Even if earlier messages in this conversation were in another language — from now on it is English only. Never mix languages.
  (Exceptions: brand names / WiFi network / password / links stay as they are.)
- If the guest asks to switch to another language, in any phrasing — switch *immediately*, with no apology,
  no questions, and no explanation or excuse. ⛔ Never say things like "I try to communicate in English to
  ensure the highest level of service" — that is unacceptable. Just switch to the language the guest asked
  for and continue from there.

✍️ WRITING QUALITY — a rule, not a suggestion:
Every message is read by a guest in a 5-star hotel. One broken sentence undoes the impression.
- Every sentence must be complete and grammatical. Read it back before sending; if it isn't
  something a person would say out loud, rewrite it.
- ⛔ Never copy phrasings out of these instructions. The lists here tell you *what* to know and
  do — never *how* to word it. Rewrite every sentence in your own words, as a full sentence.
- Never paste the guest's own words into the middle of your sentence. Address them in a
  separate sentence of its own.

🚨 EMERGENCY — highest priority, before anything else:
If the guest describes an injury, a medical event, fire, a gas smell/leak, or immediate danger — recognize it instantly (by meaning, not by a specific keyword):
1. Respond immediately and briefly. Do not ask unnecessary questions or make small talk.
2. Medical / injury → instruct the guest to *call 101 (Magen David Adom) now*.
   Fire / gas → instruct them to *call 102 (Fire & Rescue) now*, leave the room and move to a safe place.
3. Tell the guest clearly: *"The hotel's security team has been alerted and is handling this now."* Do not promise that a specific person is on the way or name anyone.
4. ⛔ You must NEVER give medical, first-aid, or treatment instructions of any kind — including whether to move or stay still, applying pressure to a wound, giving medication, moving an injured person, etc. State explicitly that you are not qualified to give medical guidance, and that they must follow the instructions of the 101 dispatcher only.
5. Always append the tag [EMERGENCY:<type + short description>] at the end — so security is alerted urgently (WhatsApp + email) and a human handles it.
Never rely on yourself alone in an emergency — you MUST escalate via the [EMERGENCY:...] tag.

🎩 WHO YOU ARE — a concierge, not a receptionist:
You are the concierge of a 5-star hotel. A guest writes to you exactly as they would
walk up to the concierge desk — and they get the same standard: warm, attentive,
professional, discreet, never boastful. You speak like a person who cares, not like a
system returning records.

*Recommendations* — restaurants, attractions, places to visit, tours, nightlife, shopping:
- Never dump a list. A guest handed 12 lines didn't get a recommendation, they got a
  phone directory.
- If you already know what the guest is after — recommend *2-3 options* straight away,
  each with one short, personal line on why it suits *them* in particular.
- If you genuinely don't know — ask *one* short focusing question (who with? what
  style? when?) and then recommend. Never more than one question in a row, and never
  ask for something you were already told.
- Remember what the guest mentioned earlier in the conversation (family with children,
  an anniversary, vegan) and tailor to it.

🎯 *Honour the exact request — never swap the category:*
- When a guest asks for something specific (a *meat* restaurant, a *dairy* one,
  *kosher*, sushi, vegan, a particular cuisine) — recommend *only* a place that
  genuinely meets that request in the data. Every restaurant has a *Cuisine* field
  and a *Kosher* field — read them and match.
- ⛔ Never offer a dairy/fish place to someone who asked for meat, a non-kosher
  place to someone who asked for kosher, or a different cuisine than the one asked
  for. "Something similar" is not what the guest asked for, and it is a failed answer.
  One place that fits exactly beats three that don't.
- If *nothing* in the data meets the exact request — don't stretch the truth and
  don't offer a substitute. Say honestly: *"I don't have a meat/kosher place nearby
  I'd stand behind just yet — let me look into it and come back to you"*, and append
  [RECEPTION:<what the guest is looking for>].

🔎 *Live places search (Google Places) — you have it:*
You have a tool called search_nearby_places that returns REAL places around the hotel —
restaurants, cafés, bars, attractions, museums, shops, nightlife and more, each with a
name, address, rating, price level and distance from the hotel.
- You have *two sources* for recommendations, and only two: (1) the hotel's curated area
  list (below), and (2) whatever this tool returns. Both are real — recommend from either.
- When to call it: *almost always* when a guest asks for a restaurant / café / bar /
  attraction / a specific kind of place nearby — the tool returns *real* places around the
  hotel's exact location (${cfg.location?.address || "the hotel area"}), which is better than
  the curated list. Call it when the list doesn't match exactly, and when the guest wants more
  options. Always prefer calling the tool over saying "I don't have one" or guessing.
- 🎯 Honour the exact request: put the meat / kosher / dairy / vegan / cuisine words inside
  the 'query' field ("kosher meat restaurant", "vegan café", "sushi"). That makes the
  results actually match.
- Once the tool returns results — pick the 2-3 that suit the guest best and write a warm
  recommendation (following the WhatsApp formatting rules). Never dump the whole list.
- If the tool returns an error/no-results status — do NOT invent. Say you'll check and
  come back, and append [RECEPTION:<what the guest is looking for>].
- 🕐 *Opening hours — the tool returns them, so always pass them on:*
  Every result carries todayHours (today's hours) and openingHours (the whole week),
  plus phone, website and category (the kind of place / cuisine). That is real data
  from Google — use it.
  • In every recommendation, give the *address · today's hours · rating · cuisine · distance*.
    A guest handed a recommendation without hours doesn't know whether they can go now.
  • If a guest asks about a place ("how late is it open?", "what's the address?",
    "do they have a phone number?") — ⛔ never answer "I don't have exact details".
    Call the tool *again* with the place name in the query field and answer from the result.
    "I don't know" when Google does know is a failed answer.
  • "Open now" — only if openNow came back true. If a place has neither todayHours nor
    openNow, Google genuinely doesn't know: don't say it's open, don't say it's closed,
    and offer honestly to confirm with them. A guest walking 1.5 km to a closed
    restaurant because you guessed is a real service failure.

⛔⛔ NEVER INVENT A PLACE — the most important rule in recommendations:
- You may recommend *only* places written in the data below (hotel services + the area)
  *or* returned by the search_nearby_places tool. Those are the only places you "know".
- ⛔ Never name a restaurant, bar, shop, club, supplier or business that didn't come from
  one of those two sources — not even if you "know" it, not even if it's famous, not even
  if the guest presses you. A name you invented may be somewhere that has closed, that
  doesn't exist, or that the hotel would never send a guest to. A guest arriving at a
  place you made up is the hotel's failure, not yours.
- ⛔ Never invent an address, a phone number, opening hours, a price or a distance. Use
  *only* details written below or returned by the tool. If a detail is in neither, you
  don't know it.
- The area still doesn't have what the guest wants (even after a tool search)? Don't
  invent, and don't just say "I don't know" and leave them hanging. Say this:
  *"I don't have a recommendation I'd stand behind for that just yet — let me look
  into it and come back to you."*
  Then append [RECEPTION:<what the guest is looking for>] so a person finds out and
  follows up. That is an excellent answer. A bare "I don't know" is not acceptable.

*Arranging things* — you arrange, you don't redirect:
- A taxi, an airport transfer, a table, a spa treatment, a tour, a car or equipment
  rental, and special requests (flowers, a birthday cake, wine in the room, a surprise).
- ⛔ Never send a guest off to call something you could arrange for them. "You can dial…"
  is a concierge's failure. The right phrasing is *"I'd be delighted to arrange that."*
- Before passing a request on, make sure you have the essentials, and ask only for
  what's missing. This is the list of details to collect (⚠️ a list of *content*, not
  wording to copy — ask in your own words, in a full sentence):
  • Taxi / transfer: the destination · *the date/day* · the pick-up time · the number of passengers
  • Restaurant table: which restaurant · *the date/day* · the time · the number of diners · any requests
  • Spa: which treatment · *the date/day* · the time · how many people
  • Tour: which tour · *the date* · how many people · the language
  • Special request: what exactly · *for which date and time* · where to deliver it
- 📅 *The date is required, not a nicety:* a booking without a date is a booking for
  no day at all. Never settle for "at eight" — ask *which day*: today? tomorrow?
  Friday? One pleasant question that collects both the day and the time beats two
  separate ones. If the guest already said "tomorrow at 20:00", that's enough — never
  ask again for something you were told.
- ⏰ *A date or time that has already passed — catch it immediately:* the current date
  and time in Israel are at the top of these instructions. A guest asking for a table
  "today at 13:00" when it is 18:00, or a taxi for a date that has gone by, has made a
  slip. Don't pass such a request on as-is, and don't silently "fix" it: gently say what
  the time/date is now and offer the sensible option ("it's already 18:00 — shall I make
  it tomorrow at 13:00, or this evening?"). Only once they confirm, pass it on.
- Once you have the details — append [CONCIERGE:<type>|<all the details>] and tell the guest.
  Write the *explicit* date in the tag (e.g. 22/07), never "tomorrow" — whoever reads it
  on the team may read it later, and by then "tomorrow" means a different day.

⚠️⚠️ WHAT YOU MAY PROMISE — an iron rule of honesty:
You coordinate the request with the provider (the restaurant / the taxi company) behind the
scenes. At the moment you write to the guest, nothing has been done yet and nothing has been
confirmed yet. Therefore, without exception:
- ✅ The right phrasing — elegant, personal, first-person: *"I'm taking care of this for you
  — I'll arrange it and come back to you with a confirmation."* / *"With pleasure, I'm on it —
  I'll update you the moment it's all set."*
- ⛔ Never mention a "human concierge", "the real concierge", "I'll pass this on", or any
  internal mechanism. To the guest, *you* are the one handling it — simply say you're taking
  care of it and will come back with a confirmation.
- ⛔ Never promise the booking is already *done/confirmed*: "I've booked you a taxi for 20:00",
  "Your table is reserved", "the car is on its way." You haven't confirmed anything yet — you're
  arranging it and will return with a confirmation. A guest who goes to the lobby to find no
  taxi is a serious failure.
- ⛔ Never invent a confirmation, an agreed time, a reference number, or a driver's name.
- Don't apologise and don't explain the internals to the guest — say, warmly and with
  confidence, what is happening now and when they'll hear back.

🍽️ *Taking a food order — you are the waiter, and the order must go out complete:*
The full in-room dining menu is in the data below (▸ In-Room Dining → The menu).
That is your only source of truth for dishes, prices and choices.
Two opposite rules that must live together — read both before you reply:
- ⛔ *Never pass a partial order on.* "I'd like pasta" is not an order — the kitchen
  cannot cook it. A guest who asked for pasta and got "I'm passing that to room service"
  receives a random dish, and that is exactly the failure we are preventing.
- ⛔ *And never hold a complete order back.* The moment the dish and its required choices
  are known, *no message may confirm that dish without the [ROOMSERVICE:...] tag in that
  same message*. If you wrote "club sandwich, wholemeal, no chips — perfect" with no tag,
  the order reached nobody and the guest is waiting for food that was never ordered. Of
  the two failures, this is the worse one.
- First *offer*: when the guest names a category ("pasta", "something light", "dessert"),
  show the relevant dishes from the menu with names and prices, and ask what appeals.
- Then *fill in what's missing* — only what is genuinely missing for the chosen dish:
  • The dish's own choices (sauce, how it's cooked, bread, the side)
  • Size / quantity (full or half portion, how many)
  • Any paid additions the guest wants
  • Dietary restrictions or allergies
  • A drink alongside, and when they'd like it served (now or at a set time)
- Ask naturally, not like a form: at most two questions per message, and never ask about
  something already told to you. A dish with no choices needs no questions — take it as is.
- ⛔ *Never hold a complete order back for a non-essential extra.* The moment you have the
  dish and the choices it requires, the order goes out *now*, in that same message. A drink,
  a dessert or a serving time are *additions*, not conditions: offer them in the same message
  that confirms the order has gone in ("that's with the kitchen — shall I add something to
  drink?"), and if the guest wants one, send a further tag for the addition alone, noting it
  joins the order already sent. A guest who told you what they wanted and got no food because
  you asked about a drink is a service failure.
- ⛔ Never invent a dish, a sauce, an addition or a price that isn't on the menu. If the
  guest asks for something that isn't there, say so honestly, offer the closest thing that
  does exist, and append [RECEPTION:...] if the kitchen needs to be asked.
- Before sending — *read the complete order back* in one short sentence (dish, choices,
  quantity, approximate price incl. the tray charge, expected delivery time), and only
  then send the tag [ROOMSERVICE:<the full order, item by item, with every choice and quantity>].
  A good tag looks like this:
  [ROOMSERVICE:Fresh linguine in rosé sauce, full portion, with grilled chicken (₪28), no parmesan (lactose sensitivity) · 1 portion · fresh orange juice · to be served now · approx. ₪139 incl. tray charge]
- This applies to *every* food or drink order to the room, "just a coffee" included:
  which coffee, how many cups, milk and sugar on the side?

*Being proactive* — the warmth of a luxury hotel:
- End almost every reply with one concrete offer, not a hollow "anything else?".
  After the spa hours: "Shall I book you in — do you have a day and time in mind?"
  After a restaurant recommendation: "Would you like me to reserve a table?"
  After "I fly out tomorrow": "Shall I arrange your transfer? You'd want to leave around 05:30."
- Connect the dots: a guest who asked for a romantic restaurant at 20:00 — offer the taxi too.
- Only offer what actually exists in the data below. A warm offer of something that
  doesn't exist is a lie.

🤝 Closings, "thank you" and edge cases — the warmth that finishes the experience:
- When the guest thanks you, says goodbye, or signals they're done ("thanks", "that's
  all", "good night") — reply warmly and briefly and wish them a lovely stay. Do *not*
  push another offer or question at a closing — the proactivity rule does *not* apply
  here, and an extra offer on a goodbye feels pushy. "Of course — I'm here whenever you
  need me. Enjoy your stay! 🌟" is plenty.
- An unclear, confusing or very short message — never respond coldly or stop at "I didn't
  understand". Gently ask one short clarifying question, or in a few words suggest how
  you can help.
- An unusual, odd or impossible request — never mock it or refuse bluntly. Respond with
  grace: if you can help another way, offer it; if not, say honestly and politely that
  you'll gladly check with reception, and append [RECEPTION:<the request>]. A guest
  should never walk away from you feeling foolish.

Rules:
- Never handle check-in or check-out yourself — the system does this automatically.
  If the guest asks to *check in* (in any phrasing, slang or typo — "checkin",
  "chek in", "i wanna check in", "arrived", "want to get my room") — do NOT reply
  normally; return *only* the tag [CHECKIN] and nothing else. If the guest asks to
  *check out* (any phrasing/typo — "checkout", "chekout", "i'm leaving", "wrap up
  my stay") — return *only* the tag [CHECKOUT]. The system takes over from there.
- Never invent information not listed here
- If a question isn't answered by the data below: don't guess and don't invent. Simply
  say you'll check and come back to them, and append [RECEPTION:<the question>] so a
  human answers. That beats guessing, and it beats "please call reception at Ext. 0" by
  a mile — you are the concierge, finding out is your job.

📱 MESSAGE FORMATTING — this is sent over WhatsApp:
- ⛔ Never use markdown tables. WhatsApp cannot render them, and the guest receives a
  pile of dashes and pipes instead of information. Never write rows like |---|---| or
  | Name | Price |. This applies to *every* reply, including ten treatments with prices.
- ⛔ No markdown headings (#), no bracketed links, no code blocks.
- ⛔ No horizontal rules ("---" / "___" / "***"). WhatsApp renders them as bare
  characters in the middle of the message. Separate topics with *one blank line*.
- ⛔ Never announce a count you don't then deliver. If you write "I have two
  recommendations", two must follow. Better not to give a number at all.
- A list of items = one line per item, in this format:
  • *Item name* (duration) — price
  For example:
  • *Swedish massage* (60 min) — ₪350
  • *Swedish massage* (90 min) — ₪470
- Emphasis: *single asterisks*. A blank line between groups. Emojis sparingly, not on
  every line.
- Never drop a detail without context. A detail that needs explaining (e.g. "the price
  is for two people", "in a couples treatment room") goes in a full sentence below the
  line — never as a stray word in brackets.
- Keep messages short — around 10 lines. If the list is long, show what fits the guest
  best and offer the rest: "There are a few more treatments — shall I run through them?"

💰 Prices, hours and service details — hard rule:
- All service information is below, organised per service with labelled fields.
  Answer from it directly — it is exactly what the guest is asking about. Never
  refer a guest to reception for something that is written here.
- ⛔ Never invent, round or estimate a price, an opening hour or a policy. Quote
  *exactly* what is written. If something isn't here, say you'll check and come
  back to the guest, and append [RECEPTION:<what needs checking>]. Don't guess,
  and don't send the guest off to find out for themselves.
- When several options exist (e.g. a 60-minute versus a 90-minute massage),
  present the relevant options with *the full name, duration and price together*,
  so the guest knows exactly what they are booking.
- A price with a condition attached — spell the condition out in full words, never
  leave it to interpretation. "Couples massage — ₪680" carries a "Note" field saying
  it covers two people together; without that sentence the guest reads ₪680 per person.
  The same goes for "per person" / "per diner" / "per day".

Hotel Information:
Hotel location: ${cfg.location?.address || "—"}
WiFi: Network ${cfg.wifi.name} | Password: ${cfg.wifi.password}
Check-in: ${cfg.checkin_time} | Check-out: ${cfg.checkout_time}
Early check-in: ${cfg.early_checkin ? "Available upon request" : "Not available"}
Late check-out: ${cfg.late_checkout ? "Available upon request" : "Not available"}

🏢 THE BUILDING — you work here and know the layout. Never ask the guest a
structural question you're supposed to know ("which floor is the lobby on?").
Default in every hotel: the lobby and reception are on the ground floor. Here
are this hotel's specifics:
${building}

Hotel services:
${svcs}

▸ Parking
${park}

🗺️ THE AREA — your knowledge beyond the hotel (this is what makes you a concierge):
You have *two sources of truth* for recommendations, and only two: (1) the curated list
below, and (2) the search_nearby_places tool (Google), which returns real places around the
hotel. For a restaurant/bar/attraction recommendation, *prefer the tool* — so you recommend a
real place, near the hotel's exact location. Never recommend a place that came from neither
source, even if you "know" it — a 5-star hotel stands behind every recommendation. If the tool
returns nothing, don't invent: say you'll check and come back, and append [RECEPTION:<request>].
The curated list (places the hotel chose to recommend):
${area}

FAQ:
${faqs}

Guest:
Name: ${nameFor(session, "en") || "—"} | Room: ${session.roomNumber || "—"}

🏨 THE HOTEL'S DEPARTMENTS — every request has a home, and you always route it:
You are the hotel's request hub. Every guest request is routed to the right
department via the matching tag (that department gets WhatsApp + email). Never
leave a request unanswered, and never tell a guest to "call it yourself" — you
pass it on and confirm you have. Identify by *meaning*, not a single keyword:
- *Reception* — general questions, key/keycard, bill and charges, extensions,
  anything not owned by another department. Tag: [RECEPTION].
- *Housekeeping* — cleaning, towels, linen and blankets, toiletries, a spill or
  mess, an unclean room, clearing dishes. Tag: [HK] (urgent → [HK_URGENT]).
- *Maintenance* — any technical fault: a blown bulb, air-conditioning/heating,
  plumbing, hot water, TV, safe, blinds, electrics, in-room internet. Tag: [MAINTENANCE].
- *Room Service* — ordering food/drinks/coffee to the room, in-room menu. Tag: [ROOMSERVICE].
- *Security* — a suspicious person, feeling unsafe, a threat, a worrying
  disturbance/noise, a suspicious object — *when there is no injury or immediate
  danger to life*. Tag: [SECURITY].
- *Emergency* — injury, medical event, fire, gas, immediate danger to life.
  Tag: [EMERGENCY] (see the emergency section above — the guest instruction comes first).
- *Concierge* — recommendations, bookings (taxi/table/spa/tour), special
  requests. Tag: [CONCIERGE:<type>|<details>].
Routing examples: "I'd like a coffee to the room" → [ROOMSERVICE]. "Milk spilled
on the carpet" → [HK]. "A bulb went out" / "the AC isn't working" → [MAINTENANCE].
"I need more towels" → [HK]. "Someone suspicious is here" → [SECURITY].
"I'm injured" / "there's a fire" → [EMERGENCY].

Internal commands (add at end of reply on a new line, guest never sees these):
[HK:<description>] — housekeeping (cleaning, towels, linen, a spill)
[HK_URGENT:<description>] — urgent housekeeping
[MAINTENANCE:<description>] — technical fault (bulb, AC, plumbing, TV)
[ROOMSERVICE:<description>] — order food/drinks/coffee to the room
[SECURITY:<description>] — a non-emergency security matter (suspicious person, disturbance, threat)
[RECEPTION:<description>] — escalate to reception (general question, bill, anything without a department)
[EMERGENCY:<type + description>] — emergency (injury/medical/fire/gas/danger) — urgent escalation to security

[CONCIERGE:<type>|<all the details>] — a request that needs actually arranging.
<type> is exactly one of these words: ${CONCIERGE_TYPE_LIST}
Put *every* detail you collected in the details field — the human concierge receives
only this tag and never sees the conversation. A request without details means a call
back to the guest.
Examples:
[CONCIERGE:taxi|Taxi from the hotel to the old port, today at 20:00, 2 passengers]
[CONCIERGE:restaurant|Table for 2 at "Yam", tomorrow 20:30, requested upper terrace, anniversary]
[CONCIERGE:spa|Couples massage 60 min, Friday at 16:00, for 2 people]
[CONCIERGE:gift|Bouquet delivered to the room by 18:00 today, a surprise for his partner]`;
}

// ════════════════════════════════════════════════════════
//  הזמנת אוכל — רשת ביטחון דטרמיניסטית
//  ----------------------------------------------------------
//  ה-prompt מנחה לשלוח את ההזמנה ברגע שהמנה והבחירות ידועות, אבל בהרצות
//  חוזרות ה-AI *לא היה עקבי*: לפעמים שלח, ולפעמים ענה "כריך קלאב, לחם
//  מלא — מושלם. לצרף משהו לשתות?" בלי תג. במקרה הזה האורח בטוח שהזמין,
//  והמטבח לא קיבל דבר — הכישלון החמור ביותר בזרימה הזו.
//
//  לכן שתי שכבות מעל ה-prompt, שתיהן דטרמיניסטיות:
//  1. *תזכורת מצב* — כשידוע שהאורח כבר נקב במנה ועדיין לא נשלחה הזמנה,
//     ה-prompt של התור הבא נושא שורת מצב מפורשת. שורה שמתארת את המצב
//     *הנוכחי* חזקה בהרבה מכלל כללי שנקבר באמצע ההוראות.
//  2. *הסלמה מובטחת* — אם עברו שני תורות עם מנה ידועה ובלי הזמנה, או
//     שה-AI אישר מנה בלי לשאול דבר ובלי תג, הבקשה עוברת לשירות החדרים
//     כ"הזמנה חלקית" עם בקשה להתקשר לאורח. בדיוק כמו הטיפול בתג קטוע:
//     בקשה של אורח לא נעלמת בשקט, גם כשה-AI מפספס.
// ════════════════════════════════════════════════════════
function menuDishNames(lang) {
  const svc  = hotelConfig.services?.room_service || {};
  const menu = (lang === "he" ? svc.he?.menu : svc.en?.menu) || svc.en?.menu || {};
  return Object.values(menu).flat().map(i => i?.name).filter(Boolean);
}

// שם המנה שהאורח נקב בה, אם בכלל. מזהה גם שם חלקי ("לינגוויני" מתוך
// "לינגוויני טרי") דרך אסימון מזהה מספיק ארוך — אורח לא מקליד שם מלא.
export function namedDish(text, lang = "he") {
  const t = String(text ?? "").toLowerCase();
  if (!t) return null;
  for (const name of menuDishNames(lang)) {
    const n = String(name).toLowerCase();
    if (t.includes(n)) return name;
    for (const tok of n.split(/[^\p{L}\p{N}]+/u)) {
      if (tok.length >= 4 && t.includes(tok)) return name;
    }
  }
  return null;
}

// כל המנות שמוזכרות בטקסט (לא רק הראשונה) — לזיהוי הזמנה כפולה.
function dishesIn(text, lang = "he") {
  const t = String(text ?? "").toLowerCase();
  return menuDishNames(lang).filter((name) => {
    const n = String(name).toLowerCase();
    if (t.includes(n)) return true;
    return n.split(/[^\p{L}\p{N}]+/u).some(tok => tok.length >= 4 && t.includes(tok));
  });
}

// ── הזמנה כפולה ────────────────────────────────────────
// נצפה בהרצה חוזרת: ה-AI שלח את ההזמנה כשהאורח פירט את המנה, ואז *שוב*
// כשהוא אמר "לא תודה, זה הכל" — ובמטבח שני כריכים. אבל להפיל את התג
// השני בשקט מסוכן לא פחות: אולי האורח באמת הזמין עוד אחד.
// לכן לא מוחקים ולא כופלים — *מסמנים*: המטבח מקבל את הבקשה עם אזהרה
// לוודא מול האורח. אף בקשה לא נעלמת, ואף מנה לא מוכפלת בשקט.
const DUPLICATE_ORDER_WINDOW_MS = 10 * 60_000;

function flagDuplicateOrder(phone, session, payload) {
  const dishes = dishesIn(payload, session.lang || "he");
  if (!dishes.length) return payload;

  const prev = session.lastRoomServiceOrder;
  const now  = Date.now();
  const same = prev
    && now - prev.at < DUPLICATE_ORDER_WINDOW_MS
    && prev.dishes.length === dishes.length
    && prev.dishes.every(d => dishes.includes(d));

  patchSession(phone, { lastRoomServiceOrder: { dishes, at: now } });
  if (!same) return payload;

  const minutes = Math.max(1, Math.round((now - prev.at) / 60_000));
  console.error(`⚠️ הזמנת שירות חדרים כפולה אפשרית (${phone.slice(-8)}): ${dishes.join(", ")}`);
  return `${payload}\n⚠️ *ייתכן שזו אותה הזמנה שכבר נשלחה לפני כ-${minutes} דק׳* (${dishes.join(", ")}) — נא לוודא עם האורח לפני הכנה כפולה.`;
}

// האם התשובה שואלת את האורח משהו? תשובה שמאשרת מנה, בלי תג ובלי שאלה,
// היא מבוי סתום: האורח לא אמור לענות דבר, וההזמנה לא נשלחה לאיש.
const ASKS_SOMETHING = /[?？]/;

async function trackFoodOrder(phone, lang, { guestText, reply, sent }) {
  const s    = sessions[phone] || getSession(phone);
  const open = s.openFoodOrder || null;

  // ההזמנה נשלחה → סוגרים את המעקב.
  if (sent) {
    if (open) patchSession(phone, { openFoodOrder: null });
    return;
  }

  const dish = namedDish(guestText, lang) || open?.dish || null;
  if (!dish) return;

  const turns   = (open?.turns || 0) + 1;
  const stalled = turns >= 2 || !ASKS_SOMETHING.test(String(reply ?? ""));

  if (!stalled) {
    patchSession(phone, { openFoodOrder: { dish, turns } });
    return;
  }

  // הסלמה: המטבח מקבל את מה שידוע, ומתבקש לסגור מול האורח בטלפון.
  patchSession(phone, { openFoodOrder: null });
  console.error(`🚨 הזמנת אוכל נתקעה בלי תג (${phone.slice(-8)}) — הועברה לשירות החדרים: ${dish}`);
  await notifyStaff({
    phone,
    dept: "room_service",
    roomNumber: s.roomNumber,
    guestName:  s.guestName,
    message:
      `🍽️ *הזמנה שלא נסגרה בצ'אט — נא ליצור קשר עם האורח*\n` +
      `המנה שנבחרה: ${dish}\n` +
      `דברי האורח: "${String(guestText ?? "").slice(0, 200)}"\n` +
      `⚠️ האורח בחר מנה אך ההזמנה לא נשלחה במלואה. נא לוודא מולו את הפרטים ולהשלים.`,
    priority: "high",
  }).catch(e => console.error("food order escalation failed:", e?.message || e));
}

// ── בקשות קונסיירז' ────────────────────────────────────
// ה-AI מחזיר [CONCIERGE:<סוג>|<פרטים>]. הסוג הוא מה שיקבע בעתיד לאיזה
// ספק אמיתי הבקשה נשלחת (מונית → גט, שולחן → Tabit) — ראה concierge/.
const CONCIERGE_TYPE_LIST = Object.values(REQUEST_TYPES).join(" | ");
const CONCIERGE_TYPES     = new Set(Object.values(REQUEST_TYPES));

// כותרת ההתראה לצוות — תמיד בעברית, ככל שאר הודעות הצוות.
const CONCIERGE_TITLE_HE = {
  [REQUEST_TYPES.TAXI]:       "🚕 *הזמנת מונית*",
  [REQUEST_TYPES.RESTAURANT]: "🍽️ *הזמנת שולחן במסעדה*",
  [REQUEST_TYPES.SPA]:        "💆 *הזמנת טיפול בספא*",
  [REQUEST_TYPES.TOUR]:       "🗺️ *הזמנת טיול / סיור*",
  [REQUEST_TYPES.TRANSFER]:   "✈️ *הזמנת הסעה*",
  [REQUEST_TYPES.RENTAL]:     "🚗 *השכרת רכב / ציוד*",
  [REQUEST_TYPES.GIFT]:       "🎁 *בקשה מיוחדת / מתנה*",
  [REQUEST_TYPES.OTHER]:      "⭐ *בקשת קונסיירז'*",
};

// "taxi|מונית לנמל ב-20:00" → { type:"taxi", details:"מונית לנמל ב-20:00" }.
// סוג לא מוכר, או תג בלי "|" בכלל (כמו הפורמט הישן) → "other" עם כל
// המחרוזת כפרטים. הכלל: לעולם לא לאבד את הבקשה בגלל פורמט לא צפוי.
function parseConciergeRequest(payload) {
  const raw = String(payload ?? "").trim();
  const i   = raw.indexOf("|");
  if (i === -1) return { type: REQUEST_TYPES.OTHER, details: raw };

  const head    = raw.slice(0, i).trim().toLowerCase();
  const details = raw.slice(i + 1).trim();
  return CONCIERGE_TYPES.has(head) && details
    ? { type: head, details }
    : { type: REQUEST_TYPES.OTHER, details: raw };
}

// מגיש את הבקשה דרך שכבת concierge/ המבודדת ומחזיר את גוף ההתראה לצוות.
// היום המוק רק מקצה אסמכתא — הביצוע בפועל הוא של הקונסיירז' האנושי
// שמקבל את ההודעה הזו. לכן הבוט אומר לאורח "העברתי את בקשתך ואחזור עם
// אישור", ולעולם לא "הזמנתי לך שולחן" (ראה חוק האמינות ב-buildPrompt).
//
// 🔌 חיבור עתידי לשירות הזמנות אמיתי (Tabit/OpenTable/גט/ספא-PMS):
//    נעשה במקום *אחד* בלבד — concierge/index.js (החלפת MockConciergeProvider
//    בספק אמיתי). כשהספק יחזיר `status: "confirmed"` עם אישור אמיתי, כאן
//    (ורק אז) יתווסף עדכון "ההזמנה אושרה" לאורח, ורק אז מותר לבוט לומר
//    שההזמנה בוצעה. עד אז — "הבקשה הועברה". נכשל? הבקשה עדיין עוברת לאדם.
// ── מתי בקשת קונסיירז' חייבת תאריך ושעה ────────────────
// הזמנה לשולחן/מונית/ספא/סיור בלי *מתי* היא בקשה שאי אפשר לבצע — ומי
// שיגלה את זה הוא הקונסיירז' האנושי, כשהוא כבר מחזיק את השפופרת. ה-prompt
// מנחה את הבוט לאסוף תאריך ושעה, אבל prompt הוא בקשה ולא ערובה: כאן זה
// נבדק דטרמיניסטית, וההתראה לצוות אומרת במפורש מה חסר.
const TIMED_REQUEST_TYPES = new Set([
  REQUEST_TYPES.TAXI, REQUEST_TYPES.RESTAURANT, REQUEST_TYPES.SPA,
  REQUEST_TYPES.TOUR, REQUEST_TYPES.TRANSFER,
]);
const HAS_TIME_RE = /\d{1,2}\s*[:.]\s*\d{2}|\b\d{1,2}\s*(?:am|pm)\b/i;
const HAS_DATE_RE = /\d{1,2}\s*[./-]\s*\d{1,2}|היום|מחר|מחרתיים|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i;

export function missingBookingParts(type, details) {
  if (!TIMED_REQUEST_TYPES.has(type)) return [];
  const t = String(details ?? "");
  const missing = [];
  if (!HAS_DATE_RE.test(t)) missing.push("תאריך/יום");
  if (!HAS_TIME_RE.test(t)) missing.push("שעה");
  return missing;
}

async function submitConciergeRequest(payload, session, phone) {
  const { type, details } = parseConciergeRequest(payload);

  let result = null;
  try {
    result = await concierge.submitRequest({
      type, details, phone,
      guestName:  session.guestName,
      roomNumber: session.roomNumber,
      lang:       session.lang || "he",
    });
  } catch (e) {
    console.error("Concierge request submit failed:", e?.message || e);
  }

  const title   = CONCIERGE_TITLE_HE[type] || CONCIERGE_TITLE_HE[REQUEST_TYPES.OTHER];
  const missing = missingBookingParts(type, details);
  if (missing.length) {
    console.error(`⚠️ בקשת קונסיירז' (${type}) הועברה בלי ${missing.join(" ו")} — ${phone.slice(-8)}`);
  }

  return `${title}\n${details || "—"}` +
         (missing.length ? `\n⚠️ *חסר בבקשה: ${missing.join(" · ")}* — נא לוודא מול האורח לפני ביצוע.` : "") +
         (result?.reference ? `\n🔖 אסמכתא: ${result.reference}` : "");
}

// ── תגי פעולה — כולל תג *קטוע* ─────────────────────────
// `(\]|$)` הוא מה שמציל בקשה שנקטעה: כשה-AI נעצר באמצע כתיבת התג
// (max_tokens), אין "]" סוגר. הרגקס הישן, שדרש סוגר, פשוט לא התאים —
// ולכן קרו *שני* דברים רעים בבת אחת: הבקשה של האורח לא הועברה לאף
// אחד, והטקסט "[CONCIERGE:restaurant|" נשלח אליו כהודעה.
// עכשיו התג נתפס, הבקשה עוברת לאדם (מסומנת כחלקית), והטקסט מוסר.
// הנקודתיים אופציונליות: תג בלי payload ("[HK]") נוצר בפועל כשה-AI מקצר.
// בגרסה הקודמת הוא *סונן* מהתשובה אך *לא נותב* לאיש — הבקשה נעלמה בשקט,
// והאורח עוד קיבל "העברתי לצוות המתאים". עכשיו הוא מנותב עם סימון מפורש
// שחסרים פרטים, כדי שאדם ייצור קשר עם האורח.
const ACTION_TAG_RE = /\[(HK_URGENT|HK|MAINTENANCE|ROOMSERVICE|CONCIERGE|RECEPTION|SECURITY|EMERGENCY)(?::([^\]]*?))?(\]|$)/g;

// ── מחלקות "בתוך החדר" — חייבות מספר חדר (Bug #3) ───────
// ניקיון, אחזקה ושירות חדרים שולחים אדם *לחדר האורח*. בלי מספר חדר הצוות
// לא יודע לאן ללכת. לכן לפני שמעבירים בקשה כזו — אם מספר החדר לא ידוע,
// שואלים את האורח (מי שלא עשה צ'ק אין דרך הבוט אין לו חדר בסשן).
// קונסיירז'/קבלה/ביטחון/חירום *לא* חוסמים: מונית/שולחן אינם "לחדר",
// וחירום לעולם לא ממתין — הקבלה מזהה את האורח לפי הטלפון.
const ROOM_BOUND_TAG_RE = /\[(?:HK_URGENT|HK|MAINTENANCE|ROOMSERVICE)(?::|\]|\s|$)/;
function needsRoomNumber(raw) {
  return ROOM_BOUND_TAG_RE.test(String(raw ?? ""));
}

// מחלץ מספר חדר מהודעת אורח. תומך: "304", "חדר 304", "room 512", "1205",
// וחדר עם אות ("12A"). מחזיר את מספר החדר כמחרוזת, או null אם אין.
function extractRoomNumber(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const labelled = t.match(/(?:חדר|room|rm|מספר|no\.?|#)\s*(\d{1,4}[A-Za-z]?)/i);
  if (labelled) return labelled[1].toUpperCase();
  const bare = t.match(/^\s*(\d{1,4}[A-Za-z]?)\s*$/);
  if (bare) return bare[1].toUpperCase();
  return null;
}

async function runActions(raw, session, phone) {
  const re = new RegExp(ACTION_TAG_RE.source, "g");
  let m;
  while ((m = re.exec(raw)) !== null) {
    const [, type, payloadCaptured, closer] = m;
    const payloadRaw = payloadCaptured ?? "";
    // תג בלי סוגר = התשובה נקטעה באמצע. הפרטים שנאספו חלקיים, ולכן
    // הבקשה עוברת לאדם בעדיפות גבוהה עם סימון מפורש — עדיף טלפון חוזר
    // לאורח מאשר בקשה שנעלמה בשקט.
    const truncated = closer !== "]";
    // תג בלי פרטים כלל ("[HK]") — קודם נעלם בשקט. גם הוא עובר לאדם.
    const noDetails = !payloadRaw.trim();
    const payload   = truncated
      ? `${payloadRaw.trim()}\n⚠️ *הבקשה נקטעה באמצע ולא נקלטה במלואה — נא ליצור קשר עם האורח להשלמת הפרטים.*`
      : noDetails
        ? `⚠️ *בקשה למחלקה ללא פרטים* — זוהתה פנייה של האורח אך הפרטים לא נקלטו. נא ליצור קשר עם האורח בטלפון שלמעלה.`
        : payloadRaw;
    if (truncated || noDetails) {
      console.error(`🚨 תג ${type} ${truncated ? "נקטע באמצע" : "הגיע בלי פרטים"} (${phone.slice(-8)}) — הועבר לצוות לטיפול אנושי: ${payloadRaw.slice(0, 80)}`);
    }
    // תג → מחלקה: מקור אמת אחד ב-config.js, לצד אנשי הקשר עצמם
    // (ולכן גם ניתן להדפסה בעלייה ולבדיקה אוטומטית).
    const dept = TAG_DEPARTMENTS[type];
    // בקשה קטועה = פרטים חסרים = חייבת עין אנושית, יהיה הסוג אשר יהיה.
    const priority = truncated || noDetails || type.includes("URGENT") || type === "RECEPTION"
      || type === "SECURITY" || type === "EMERGENCY"
      ? "high" : "normal";

    // ── חירום: תיעוד מובנה של האירוע לפני ההסלמה ────────
    if (type === "EMERGENCY") {
      logIncident({
        phone,
        roomNumber: session.roomNumber,
        guestName:  session.guestName,
        description: payload.trim(),
        channel: "whatsapp",
      });
    }

    // ── קונסיירז': הבקשה עוברת דרך שכבת הספק המבודדת ────
    // ── שירות חדרים: הזמנה חוזרת מסומנת, לא מוכפלת בשקט ─
    const message = type === "CONCIERGE"
      ? await submitConciergeRequest(payload, session, phone)
      : type === "ROOMSERVICE"
        ? flagDuplicateOrder(phone, session, payload)
        : payload;

    await notifyStaff({
      phone,
      dept,
      roomNumber: session.roomNumber,
      guestName: session.guestName,
      message,
      priority,
    });
  }
  return raw.replace(re, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ════════════════════════════════════════════════════════
//  צ'ק אין — מכונת מצבים עם אימות קלט בכל שלב
//  ----------------------------------------------------------
//  שני עקרונות:
//  1. קלט לא תקין לעולם לא מתקבל ולעולם לא שובר את הזרימה — מבקשים
//     שוב בנימוס *באותו שלב* (Bug #3, #9).
//  2. לכל שלב יש מקור אמת אחד לניסוח (promptStage) — ולכן אפשר לשלוח
//     אותו מחדש בכל שפה, בכל רגע, בלי להתחיל מהתחלה (Bug #5).
// ════════════════════════════════════════════════════════

// הסבר מנומס למה הקלט לא התקבל — לפי סוג התקלה ולפי שפה.
const INPUT_HINTS = {
  name: {
    empty:          { he: "לא קיבלתי שם.", en: "I didn't catch a name." },
    has_digits:     { he: "שם מלא לא כולל ספרות.", en: "A full name shouldn't contain digits." },
    no_letters:     { he: "זה לא נראה כמו שם.", en: "That doesn't look like a name." },
    not_a_name:     { he: "זה לא נראה כמו שם.", en: "That doesn't look like a name." },
    single_word:    { he: "אשמח לשם המלא — שם פרטי ושם משפחה.", en: "I'd love your full name — first and last." },
    too_many_words: { he: "אשמח רק לשם המלא, בלי פרטים נוספים.", en: "Just the full name please, without extra details." },
    too_long:       { he: "השם ארוך מדי.", en: "That name is too long." },
    // "I want to check in" עבר בעבר כשם ונדבק לתוך ההודעה הבאה.
    command_phrase: { he: "אנחנו כבר בתהליך הצ'ק אין 😊", en: "We're already in the check-in process 😊" },
  },
  dates: {
    empty:      { he: "לא קיבלתי תאריכים.", en: "I didn't catch any dates." },
    no_dates:   { he: "לא זיהיתי תאריכים בהודעה.", en: "I couldn't find any dates in that message." },
    no_arrival: { he: "קיבלתי את מספר הלילות — אשמח גם לתאריך ההגעה.", en: "I have the number of nights — I just need the arrival date too." },
    one_date:   { he: "קיבלתי תאריך אחד בלבד, ובלי מספר הלילות אין לי את השני.", en: "I only caught one date, and without the number of nights I can't work out the other." },
    bad_date:   { he: "אחד התאריכים אינו תאריך קיים בלוח השנה.", en: "One of those dates doesn't exist on the calendar." },
    not_after:  { he: "תאריך העזיבה חייב להיות אחרי תאריך ההגעה.", en: "The departure date must be after the arrival date." },
    past:       { he: "לפי מה שקיבלתי, ההגעה יוצאת בתאריך שכבר עבר.", en: "From what I have, the arrival works out to a date that has already passed." },
    too_long:   { he: "שהייה ארוכה מ-60 לילות מתואמת ישירות מול הקבלה.", en: "Stays longer than 60 nights are arranged directly with reception." },
    too_far:    { he: "התאריך שקיבלתי רחוק מאוד בעתיד — הזמנות נפתחות עד שנתיים מראש.", en: "That date is very far in the future — bookings open up to two years ahead." },
    unclear:    { he: "לא הצלחתי לקרוא את התאריכים.", en: "I couldn't read those dates." },
    // שתי הסיבות האלה נוספו יחד עם הפרסור מבוסס-התפקיד: עדיף לשאול שוב
    // מאשר לנחש איזה תאריך הוא ההגעה ואיזה העזיבה.
    ambiguous:  { he: "לא הצלחתי לזהות בוודאות איזה תאריך הוא ההגעה ואיזה העזיבה.", en: "I couldn't tell for certain which date is the arrival and which is the departure." },
    conflict:   { he: "מספר הלילות שציינת לא מסתדר עם התאריכים.", en: "The number of nights you mentioned doesn't match the dates." },
  },
  terms: {
    empty:        { he: "לא קיבלתי אישור.", en: "I didn't receive a confirmation." },
    not_explicit: { he: "כדי לאשר את התנאים אני צריך את הנוסח המדויק.", en: "To accept the terms I need the exact wording." },
    unclear:      { he: "לא הצלחתי לזהות אישור.", en: "I couldn't recognise that as a confirmation." },
  },
  // אישור התאריכים — כן/לא, או תאריכים חדשים שמחליפים את מה שהבנו.
  dates_confirm: {
    empty:   { he: "לא קיבלתי תשובה.", en: "I didn't catch an answer." },
    unclear: { he: "לא הצלחתי לזהות אם זה אישור או תיקון.", en: "I couldn't tell whether that was a yes or a no." },
  },
  reservation: {
    empty:       { he: "לא קיבלתי מספר הזמנה.", en: "I didn't catch a reservation number." },
    not_numeric: { he: "לא זיהיתי מספר הזמנה — הוא מופיע באישור ההזמנה ששלחנו.", en: "I couldn't find a reservation number — it appears on the confirmation we sent." },
    extra_text:  { he: "אשמח למספר ההזמנה עצמו, כפי שהוא מופיע באישור.", en: "Just the reservation number itself, exactly as it appears on your confirmation." },
    ambiguous:   { he: "קיבלתי כמה מספרים — אשמח למספר ההזמנה בלבד.", en: "I received several numbers — just the reservation number please." },
    too_short:   { he: "מספר ההזמנה קצר מהצפוי.", en: "That reservation number is shorter than expected." },
    too_long:    { he: "מספר ההזמנה ארוך מהצפוי.", en: "That reservation number is longer than expected." },
  },
  id: {
    no_media:          { he: "לא קיבלתי תמונה.", en: "I didn't receive a photo." },
    not_an_image:      { he: "הקובץ ששלחת אינו תמונה.", en: "The file you sent isn't an image." },
    unsupported_image: { he: "סוג התמונה אינו נתמך — אשמח לצילום רגיל (JPG / PNG).", en: "That image format isn't supported — a regular photo (JPG / PNG) works best." },
  },
};

function hint(kind, reason, lang) {
  const h = INPUT_HINTS[kind]?.[reason] || INPUT_HINTS[kind]?.empty;
  return h ? (lang === "he" ? h.he : h.en) : "";
}

// ── תאריך שעבר — אומרים *איזה* תאריך ולמה ──────────────
// הודעה כללית ("התאריך כבר עבר") משאירה את האורח לנחש איזה מהם. פקיד
// קבלה היה אומר: "10/07 כבר עבר, היום 21/07 — לאיזה תאריך לרשום?".
// זה גם מה שמונע את הלולאה: האורח יודע בדיוק מה לתקן, מיד.
function datesHint(state, lang) {
  const base = hint("dates", state.reason, lang);
  if (state.reason !== "past" || !state.pastDate) return base;
  return lang === "he"
    ? `📅 התאריך *${state.pastDate}* כבר עבר (היום ${state.today}).`
    : `📅 *${state.pastDate}* has already passed (today is ${state.today}).`;
}

// ── תנאי השהייה — רינדור מ-hotelConfig ─────────────────
// הנוסח עצמו יושב ב-config.js (per-hotel, נוסח לדוגמה בדמו). כאן רק
// מרכיבים אותו להודעת וואטסאפ ומחליפים placeholders בערכים האמיתיים
// של המלון — כדי שהתנאים לא יסתרו את מה שהמערכת עושה בפועל.
function renderTerms(lang) {
  const cfg  = hotelConfig;
  const he   = lang === "he";
  const list = cfg.terms?.[he ? "he" : "en"] || [];
  const vars = {
    "{hotel}":         he ? cfg.name_he : cfg.name,
    "{checkout_time}": cfg.checkout_time,
    "{deposit}":       `₪${((cfg.deposit_amount ?? 50000) / 100).toFixed(0)}`,
  };
  const fill = (s) => Object.entries(vars).reduce((acc, [k, v]) => acc.split(k).join(v), String(s ?? ""));
  return list.map((item, i) => `${i + 1}. *${fill(item.title)}*\n${fill(item.body)}`).join("\n\n");
}

// ── תצוגת פרטי הצ'ק אין הנוספים ───────────────────────
// מקבל אובייקט עם guests/eta/vehicle/requests (מהסשן או מההזמנה)
// ומחזיר בלוק שורות מתויגות לפי שפה, או "" אם אין שום פרט.
// מקור אמת אחד — משמש גם באישור באמצע הצ'ק אין, גם בהודעת האישור לאורח
// וגם בהתראה לצוות (שם תמיד בעברית).
function formatCheckinDetails(d, lang = "he") {
  if (!d) return "";
  const he = lang === "he";
  const lines = [];
  if (d.guests)   lines.push(he ? `👥 אורחים: ${d.guests}`          : `👥 Guests: ${d.guests}`);
  if (d.eta)      lines.push(he ? `🕐 הגעה משוערת: ${d.eta}`        : `🕐 Estimated arrival: ${d.eta}`);
  if (d.vehicle)  lines.push(he ? `🚗 רכב (לחניה): ${d.vehicle}`    : `🚗 Vehicle (for parking): ${d.vehicle}`);
  if (d.requests) lines.push(he ? `📝 בקשה מיוחדת: ${d.requests}`   : `📝 Special request: ${d.requests}`);
  return lines.join("\n");
}

// ── מקור האמת לניסוח כל שלב ────────────────────────────
// prefix = הסבר על קלט קודם שלא התקבל (ריק בפעם הראשונה).
// נקרא גם בפתיחת שלב, גם אחרי קלט לא תקין, וגם כשאורח מחליף שפה
// באמצע — ואז השלב פשוט נשלח מחדש בשפה החדשה וממשיכים משם.
//
// ⚠️ כלל: ההודעה של כל שלב היא *משפט שלם ועצמאי*. אסור להשחיל לתוכה
// טקסט שהאורח הקליד — כך נולד "I want to check in, please enter your
// reservation number": השם הקודם הודבק כפנייה בתחילת המשפט הבא.
// פנייה בשם, אם יש, מגיעה כ-prefix בשורה נפרדת משלה.
// דוגמת תאריכים לשלב השהייה — תמיד מחר + 4 לילות, לפי שעון ישראל.
// מוחזרת כ-DD/MM/YYYY, הפורמט שהאורח מקליד ושהפרסור מבין.
function exampleStayDates(now = new Date()) {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const today = new Date(`${ymd}T00:00:00Z`);
  const fmt = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  };
  const DAY = 86_400_000;
  return [fmt(new Date(today.getTime() + DAY)), fmt(new Date(today.getTime() + 5 * DAY))];
}

async function promptStage(phone, stage, lang, { prefix = "", brief = false, withExample = false } = {}) {
  const he = lang === "he";
  const p  = prefix ? prefix + "\n\n" : "";

  if (stage === "waiting_name") {
    return wa(phone, p + (he
      ? `מה *שמך המלא*? (שם פרטי ושם משפחה)`
      : `What is your *full name*? (first and last)`), { lang });
  }

  if (stage === "waiting_reservation") {
    return wa(phone, p + (he
      ? `ומה *מספר ההזמנה* שלך? (מופיע באישור ההזמנה)`
      : `And what is your *reservation number*? (it appears on your booking confirmation)`), { lang });
  }

  if (stage === "waiting_dates") {
    // ── שאלה קצרה ונקייה כברירת מחדל (Bug #5) ──────────────
    // קודם הבוט שפך את כל הפורמט והדוגמאות בכל פנייה — מכוער וחוזר. עכשיו
    // השאלה קצרה, והבוט מבין תאריכים בצורה חכמה. הדוגמה מוצגת *רק* כשצריך:
    // אחרי שהאורח שלח משהו שלא הצלחנו לקרוא (withExample=true) — ואז פעם
    // אחת, מסומנת במפורש כדוגמה כדי שלא תיקרא כתאריך אמיתי.
    const ask = he
      ? `📅 מתי מתוכננת השהייה שלך — תאריך הגעה ותאריך עזיבה?`
      : `📅 When is your stay — an arrival date and a departure date?`;
    // 🔴 הדוגמה חייבת להיות *עתידית*, ולכן היא מחושבת מהיום ולא כתובה
    // קשיח. דוגמה קבועה ("19/07/2026") הופכת לתאריך שעבר ברגע שהתאריך
    // חולף — והבוט מציע לאורח בדיוק את הקלט שהוא עצמו ידחה כ"תאריך שעבר".
    const [exFrom, exTo] = exampleStayDates();
    const example = he
      ? `\n\n_אפשר גם הגעה ומספר לילות. למשל: «${exFrom} עד ${exTo}» או «${exFrom}, 4 לילות»._`
      : `\n\n_You can also give an arrival date and the number of nights. E.g. «${exFrom} to ${exTo}» or «${exFrom}, 4 nights»._`;
    return wa(phone, p + ask + (withExample ? example : ""), { lang });
  }

  // ── אישור התאריכים — לפני שממשיכים הלאה ───────────────
  // תאריך שהובן לא נכון = כרטיס חדר מתוקף לימים הלא נכונים וחיוב שגוי.
  // לכן אף פעם לא ממשיכים על סמך הפרסור בלבד: מציגים לאורח בדיוק מה
  // הבנו, במילים מלאות, ומבקשים אישור מפורש.
  if (stage === "waiting_dates_confirm") {
    const stay = getSession(phone).pendingStay;
    if (!stay) {
      // אין מה לאשר (מצב שלא אמור לקרות) — חוזרים לשאלה במקום להיתקע.
      patchSession(phone, { checkinStage: "waiting_dates" });
      return promptStage(phone, "waiting_dates", lang, { prefix });
    }
    return wa(phone, p + (he
      ? `רק לוודא שהבנתי נכון:\n\n${formatStayDates(stay, "he")}\n\nהאם זה נכון? נא להשיב *כן* לאישור, או *לא* אם צריך לתקן.`
      : `Just to make sure I've understood correctly:\n\n${formatStayDates(stay, "en")}\n\nIs that right? Please reply *yes* to confirm, or *no* if it needs correcting.`), { lang });
  }

  // ── פרטים נוספים (אופציונלי, חלק) ────────────────────
  // מלון אמיתי מבקש כמה פרטים שיעזרו לארח נכון. הכול אופציונלי — אפשר
  // לכתוב הכל בהודעה אחת, או פשוט *לדלג*. לא חוסם את הצ'ק אין.
  if (stage === "waiting_details") {
    return wa(phone, p + (he
      ? `כמעט סיימנו! עוד כמה פרטים קטנים שיעזרו לנו לארח אותך כמו שצריך (אפשר לכתוב הכל בהודעה אחת, או פשוט לכתוב *דלג*):\n\n` +
        `• כמה אורחים תהיו בחדר?\n` +
        `• באיזו שעה בערך מתוכננת ההגעה?\n` +
        `• אם מגיעים ברכב — מספר הרכב, לחניה\n` +
        // ⚠️ הדוגמאות כאן הן מה שהאורח יבקש בפועל — ולכן חייבות להיות
        // בקשות אמיתיות שהמלון יכול למלא. "חדר שקט" הופיע כאן וזו דוגמה
        // מטופשת: כל החדרים במלון 5 כוכבים שקטים, וההצעה משדרת ההפך.
        `• בקשה מיוחדת? (קומה גבוהה, נוף לים, מיטה זוגית או שתי מיטות, קרבה למעלית…)`
      : `Almost there! A few small details that help us host you properly (feel free to put it all in one message, or just type *skip*):\n\n` +
        `• How many guests will you be?\n` +
        `• Roughly what time will you arrive?\n` +
        `• If you're coming by car — the licence plate, for parking\n` +
        `• Any special request? (a high floor, a sea view, a double bed or twin beds, close to the lift…)`), { lang });
  }

  if (stage === "waiting_id") {
    return wa(phone, p + (he
      ? `🪪 כדי להשלים את הצ'ק אין נדרש *אימות זהות*.\n\nאשמח לתמונה של *תעודת הזהות או הדרכון* — צילום ברור שבו כל הפרטים קריאים.`
      : `🪪 To complete your check-in we need to *verify your identity*.\n\nPlease send a photo of your *ID card or passport* — a clear shot with all the details readable.`), { lang });
  }

  if (stage === "waiting_terms") {
    // brief — האורח כבר ראה את התנאים ורק הניסוח שלו לא היה מפורש.
    // אין טעם להציף אותו שוב בכל הסעיפים; מבקשים רק את נוסח האישור.
    const ask = he
      ? `לאישור, נא לכתוב: *אני מאשר*`
      : `To accept, please type: *I confirm*`;
    if (brief) return wa(phone, p + ask, { lang });

    return wa(phone, p + (he
      ? `📜 *תנאי השהייה*\n\nלפני קבלת החדר, אלה התנאים לקריאה ולאישור:\n\n${renderTerms("he")}\n\n${ask}`
      : `📜 *Stay Terms*\n\nBefore we hand over the room, here are the terms to read and accept:\n\n${renderTerms("en")}\n\n${ask}`), { lang });
  }

  if (stage === "waiting_payment") {
    // מחדשים את שלב הפיקדון: אותו קישור, בשפה הנוכחית. אם מסיבה כלשהי
    // אין קישור (תקלה קודמת) — מנסים ליצור אותו מחדש, ולא מחזירים את
    // האורח לתחילת הצ'ק אין.
    const url = await ensureDepositLink(phone, lang);
    if (!url) {
      return wa(phone, p + (he
        ? `⏳ אנחנו משלימים עבורך את שלב הפיקדון — מהקבלה יחזרו אליך מיד.\n\nלכל שאלה: קבלה, שלוחה 0.`
        : `⏳ We're finalising the deposit step for you — reception will get back to you shortly.\n\nAny questions: reception, Ext. 0.`), { lang });
    }
    // ההודעה כאן מדברת *רק* על הפיקדון. הסטטוס של אימות הזהות מגיע
    // כ-prefix מהקורא — כדי שלא נכריז "אומת" כשהאימות עדיין ידני.
    return wa(phone, p + (he
      ? `שלב אחרון — *פיקדון שהייה*.\n\n${depositExplainer("he")}\n\nלהקפאת הפיקדון, בקישור הזה:\n👉 ${url}`
      : `One last step — a *security deposit*.\n\n${depositExplainer("en")}\n\nTap the link to place the deposit hold:\n👉 ${url}`), { lang });
  }
}

// מחזיר קישור לפיקדון: משתמש בהזמנה הממתינה אם קיימת, אחרת יוצר אחת.
// כך "להמשיך בצ'ק אין" / מעבר שפה לא יוצרים הזמנה כפולה, ותקלה חולפת
// ביצירת הקישור ניתנת לתיקון בניסיון הבא — בלי לאבד את השלב.
async function ensureDepositLink(phone, lang) {
  const existing = getPendingReservation(phone);
  if (existing?.paymentUrl) return existing.paymentUrl;

  const s = getSession(phone);
  try {
    const { paymentUrl } = await startCheckin(
      phone,
      { guestName: s.guestName, guestNameHe: s.guestNameHe, guestNameEn: s.guestNameEn },
      s.pendingReservation || "",
      {
        // תאריכי השהייה שהאורח מסר, ואיזה נוסח תנאים אישר ומתי —
        // עוברים אל ההזמנה כדי שיישמרו ב-DB וישרדו ריסטארט.
        stay:  s.pendingStay || null,
        terms: { version: s.termsVersion || null, acceptedAt: s.termsAcceptedAt || null },
        // פרטי הצ'ק אין הנוספים (אורחים / ETA / רכב / בקשות) — אופציונליים.
        details: {
          guests:   s.pendingGuests   ?? null,
          eta:      s.pendingEta       ?? null,
          vehicle:  s.pendingVehicle   ?? null,
          requests: s.pendingRequests  ?? null,
        },
      }
    );
    return paymentUrl;
  } catch (e) {
    console.error("Deposit link creation failed:", e?.message || e);
    // הסלמה לאדם — האורח לא נשאר תקוע בלי טיפול.
    await notifyStaff({
      phone,
      dept: "reception",
      roomNumber: s.roomNumber,
      roomNote: ROOM_NOTE_PENDING_CHECKIN,
      guestName: s.guestName,
      message: `⚠️ יצירת קישור הפיקדון נכשלה בצ'ק אין הדיגיטלי (${phone}). הזמנה: ${s.pendingReservation || "—"}. נדרש טיפול ידני.`,
      priority: "high",
    }).catch(() => {});
    return null;
  }
}

// opts.langSwitched — האורח החליף שפה בהודעה הזו.
async function handleCheckin(phone, text, lang, media = null, opts = {}) {
  const session = getSession(phone);
  const stage   = session.checkinStage;
  const input   = String(text || "").trim();

  // ── פתיחת הצ'ק אין ───────────────────────────────────
  if (!stage || stage === "start") {
    patchSession(phone, { checkinStage: "waiting_name", idAttempts: 0 });
    await promptStage(phone, "waiting_name", lang, {
      prefix: lang === "he"
        // ניסוח *נטול-מין* (unisex): "שמחים שהגעת" ו"עבורך" נכתבים זהה
        // לזכר ולנקבה — כך הפתיחה נכונה לכל אורח, בלי "ברוך הבא" הזכרי.
        ? `שמחים שהגעת! 🌟 נשמח להשלים עבורך את הצ׳ק אין הדיגיטלי.`
        : `Welcome! 🌟 Let's get you checked in.`,
    });
    return;
  }

  // ── החלפת שפה באמצע (Bug #5) ─────────────────────────
  // לא נשאר קלט אמיתי מלבד בקשת השפה → שולחים את השלב הנוכחי מחדש
  // בשפה החדשה וממשיכים בדיוק מאותה נקודה. לא מתחילים מהתחלה.
  if (opts.langSwitched && !input && !media) {
    await promptStage(phone, stage, lang, {
      prefix: lang === "he" ? "בוודאי, נמשיך בעברית 😊" : "Of course, we'll continue in English 😊",
    });
    return;
  }

  // ── שם מלא ───────────────────────────────────────────
  if (stage === "waiting_name") {
    const v = validateFullName(input);
    if (!v.ok) {
      await promptStage(phone, "waiting_name", lang, { prefix: hint("name", v.reason, lang) });
      return;
    }
    // שומרים את השם בשתי הצורות (עברית + אנגלית) כבר עכשיו, ומציגים לפי
    // שפת השיחה — כדי שלא ייווצר ערבוב שפות בשם.
    const forms = await resolveNameForms(v.value);
    patchSession(phone, {
      checkinStage:  "waiting_reservation",
      pendingName:   v.value,
      pendingNameHe: forms.he,
      pendingNameEn: forms.en,
    });
    const shown = lang === "he" ? forms.he : forms.en;
    // הפנייה בשם היא prefix בשורה נפרדת — לא חלק מהמשפט של השלב הבא.
    await promptStage(phone, "waiting_reservation", lang, {
      prefix: lang === "he" ? `תודה, *${shown}*! 😊` : `Thank you, *${shown}*! 😊`,
    });
    return;
  }

  // ── מספר הזמנה — קוד אלפאנומרי מאישור ההזמנה (Bug #3) ─
  if (stage === "waiting_reservation") {
    const v = validateReservationNumber(input);
    if (!v.ok) {
      await promptStage(phone, "waiting_reservation", lang, { prefix: hint("reservation", v.reason, lang) });
      return;
    }
    patchSession(phone, { checkinStage: "waiting_dates", pendingReservation: v.value, pendingDatesText: null });
    await promptStage(phone, "waiting_dates", lang, {
      prefix: lang === "he"
        ? `✅ *הזמנה מספר ${v.value} אותרה!*`
        : `✅ *Reservation ${v.value} found!*`,
    });
    return;
  }

  // ── תאריכי שהייה ─────────────────────────────────────
  // עד כה מספר הלילות היה קבוע (3) לכל אורח. עכשיו האורח מוסר אותם,
  // הם נשמרים על ההזמנה, ומהם נגזר תוקף כרטיס החדר ורגע ה-no-show.
  if (stage === "waiting_dates") {
    // ── צבירת מידע חלקי לאורך כמה הודעות (Bug #2) ─────────
    // אורח שכתב "4 לילות" ואז "19.7" מסר את המידע בשתי הודעות. קודם כל
    // חלק נבדק לבד, נכשל ונשכח — והבוט שאל שוב ושוב את אותה שאלה. עכשיו
    // זוכרים את מה שכבר נמסר (session.pendingDatesText) ומצרפים אליו את
    // ההודעה הבאה: "4 לילות" + "19.7" → הגעה 19/7, 4 לילות.
    const prev = getSession(phone).pendingDatesText || "";

    // תשובה מלאה בהודעה אחת גוברת (מונעת זיהום משארית ישנה); אחרת מצרפים.
    let v = validateStayDates(input);
    let combined = input;
    if (!v.ok && prev) {
      combined = `${prev} ${input}`.trim();
      const merged = validateStayDates(combined);
      if (merged.ok) v = merged;
    }

    if (v.ok) {
      // הצלחנו — מנקים את הצבירה וממשיכים לאישור.
      patchSession(phone, { checkinStage: "waiting_dates_confirm", pendingStay: v.value, pendingDatesText: null });
      await promptStage(phone, "waiting_dates_confirm", lang);
      return;
    }

    // עדיין חסר מידע. בודקים אם מה שבידינו הוא "חצי" שימושי — מספר לילות
    // בלי תאריך (no_arrival), או תאריך יחיד בלי לילות (one_date). אם כן,
    // זוכרים אותו וממשיכים לבקש *רק את מה שחסר*; אחרת (קלט לא ברור/סותר)
    // לא צוברים זבל, ומראים דוגמה קצרה כדי לעזור.
    // תאריך שעבר נעצר מיד ולא נצבר: אין טעם לצרף אליו תאריך שני, וכל
    // סבב נוסף רק מרחיק את האורח מהתיקון. מנקים את הצבירה ומבקשים תאריך
    // חדש, עם ציון מפורש איזה תאריך בעייתי.
    const state   = validateStayDates(combined);
    const partial = state.reason === "no_arrival" || state.reason === "one_date";
    patchSession(phone, { pendingDatesText: partial ? combined : null });
    await promptStage(phone, "waiting_dates", lang, {
      prefix:      datesHint(state, lang),
      withExample: !partial && state.reason !== "past",
    });
    return;
  }

  // ── אישור תאריכי השהייה ──────────────────────────────
  // שער אחרון לפני שהתאריכים "ננעלים" על ההזמנה ומתקפים כרטיס חדר.
  if (stage === "waiting_dates_confirm") {
    // האורח שלח תאריכים חדשים במקום כן/לא ("לא, 20/7 עד 23/7") —
    // מאמצים אותם ומאשרים מחדש, בלי להחזיר אותו שלב אחורה.
    const redo = validateStayDates(input);
    if (redo.ok) {
      patchSession(phone, { pendingStay: redo.value });
      await promptStage(phone, "waiting_dates_confirm", lang, {
        prefix: lang === "he" ? "תודה על התיקון 🙏" : "Thank you for the correction 🙏",
      });
      return;
    }

    if (isNegative(input)) {
      patchSession(phone, { checkinStage: "waiting_dates", pendingStay: null, pendingDatesText: null });
      await promptStage(phone, "waiting_dates", lang, {
        prefix: lang === "he" ? "אין בעיה, נתקן את זה יחד." : "No problem, let's put that right.",
      });
      return;
    }

    if (isAffirmative(input)) {
      patchSession(phone, { checkinStage: "waiting_details" });
      await promptStage(phone, "waiting_details", lang, {
        prefix: (lang === "he" ? `✅ *תאריכי השהייה נקלטו:*\n` : `✅ *Your stay dates are set:*\n`)
          + formatStayDates(session.pendingStay, lang),
      });
      return;
    }

    await promptStage(phone, "waiting_dates_confirm", lang, {
      prefix: hint("dates_confirm", input ? "unclear" : "empty", lang),
    });
    return;
  }

  // ── פרטים נוספים (אופציונלי) ─────────────────────────
  // כל השדות אופציונליים; כל תשובה מתקדמת (לא חוסמים על חוסר פרטים).
  // מחלץ best-effort מהודעה חופשית אחת ושומר בסשן — יגיע להזמנה ולסיכום.
  if (stage === "waiting_details") {
    const d = parseCheckinDetails(input);
    patchSession(phone, {
      checkinStage:    "waiting_id",
      idAttempts:      0,
      pendingGuests:   d.guests   ?? null,
      pendingEta:      d.eta      ?? null,
      pendingVehicle:  d.vehicle  ?? null,
      pendingRequests: d.requests ?? null,
    });
    // אישור חם וקצר של מה שנקלט (רק אם נמסר משהו) — מראה לאורח שהוקשב לו.
    const summary = formatCheckinDetails(d, lang);
    await promptStage(phone, "waiting_id", lang, {
      prefix: summary
        ? (lang === "he" ? `רשמתי, תודה 🙏\n${summary}` : `Noted, thank you 🙏\n${summary}`)
        : "",
    });
    return;
  }

  // ── אימות זהות (Bug #7, #8) ──────────────────────────
  if (stage === "waiting_id") {
    await handleIdStage(phone, media, lang);
    return;
  }

  // ── אישור תנאי השהייה ────────────────────────────────
  // שער חובה: בלי אישור מפורש אין חדר ואין פיקדון. האישור נשמר עם
  // חותמת זמן ומספר נוסח — כדי שתמיד יהיה ידוע *מה* האורח אישר.
  if (stage === "waiting_terms") {
    const v = validateTermsConfirmation(input);

    if (!v.ok) {
      if (v.reason === "declined") {
        await handleTermsDeclined(phone, lang);
        return;
      }
      // "כן"/"ok" — הבנו את הכוונה, אבל לתנאים צריך נוסח מפורש.
      await promptStage(phone, "waiting_terms", lang, {
        prefix: hint("terms", v.reason, lang),
        brief:  v.reason !== "empty",
      });
      return;
    }

    patchSession(phone, {
      checkinStage:    "waiting_payment",
      termsAcceptedAt: new Date().toISOString(),
      termsVersion:    hotelConfig.terms?.version || null,
    });
    await promptStage(phone, "waiting_payment", lang, {
      prefix: lang === "he"
        ? `✅ *תודה — תנאי השהייה אושרו.*`
        : `✅ *Thank you — the stay terms have been accepted.*`,
    });
    return;
  }

  // ── ממתינים לפיקדון ──────────────────────────────────
  if (stage === "waiting_payment") {
    await promptStage(phone, "waiting_payment", lang);
    return;
  }

  // ── רשת ביטחון: שלב לא מזוהה → לעולם לא שקט (Bug #2) ──
  // אם ה-checkinStage קיבל ערך שאף ענף למעלה לא מטפל בו, אסור
  // ש-handleCheckin יחזור בשקט. משדרים מחדש את השלב הנוכחי אם ניתן,
  // אחרת מאתחלים לשם — האורח תמיד מקבל מענה ולא נתקע.
  console.error(`⚠️ handleCheckin: שלב לא מזוהה "${stage}" (${phone.slice(-8)}) — משדרים מחדש כדי לא להשתיק את הבוט.`);
  const known = new Set(["waiting_name", "waiting_reservation", "waiting_dates",
    "waiting_dates_confirm", "waiting_details", "waiting_id", "waiting_terms", "waiting_payment"]);
  if (known.has(stage)) {
    await promptStage(phone, stage, lang);
  } else {
    patchSession(phone, { checkinStage: "waiting_name", idAttempts: 0 });
    await promptStage(phone, "waiting_name", lang, {
      prefix: lang === "he"
        ? `נמשיך בצ'ק אין 😊`
        : `Let's continue your check-in 😊`,
    });
  }
}

// ── אורח שסירב לתנאים ──────────────────────────────────
// לא לוחצים ולא מתווכחים. עוצרים את הצ'ק אין הדיגיטלי במקום, מסלימים
// לאדם בקבלה, ומשאירים את האורח בשלב — כדי שיוכל לאשר בהמשך אם ירצה.
async function handleTermsDeclined(phone, lang) {
  const s  = getSession(phone);
  const he = lang === "he";

  await notifyStaff({
    phone,
    dept: "reception",
    roomNumber: s.roomNumber,
    roomNote: ROOM_NOTE_PENDING_CHECKIN,
    guestName: s.guestName,
    message:
      `📜 *האורח לא אישר את תנאי השהייה* בצ'ק אין הדיגיטלי\n` +
      `👤 ${s.guestName || "—"}\n🔖 הזמנה: ${s.pendingReservation || "—"}\n` +
      `⛔ הצ'ק אין נעצר לפני הפיקדון. נדרשת פנייה אנושית לאורח.`,
    priority: "high",
  });

  await wa(phone, he
    ? `אני מבין, ותודה על הכנות 🙏\n\nבלי אישור תנאי השהייה איני יכול להשלים את הצ'ק אין הדיגיטלי — ` +
      `אבל זו ממש לא בעיה: מהקבלה יחזרו אליך בהקדם ויענו על כל שאלה לגבי התנאים.\n\n` +
      `אפשר לחזור לכאן בכל שלב ולכתוב *אני מאשר* — ונמשיך מהנקודה הזו.`
    : `I understand, and thank you for telling me 🙏\n\nWithout accepting the stay terms I can't complete the digital check-in — ` +
      `but that's absolutely fine: reception will be in touch shortly and will answer any question you have about the terms.\n\n` +
      `You can come back here at any point and type *I confirm* — we'll pick up right where we left off.`, { lang });
}

// שלב תעודת הזהות — הופרד כי הוא הכי עשיר: אימות אמיתי מול ה-AI,
// סוג המסמך בהתראה לצוות — בעברית. המפתח הפנימי ("id_card") הוא שם
// שדה בקוד, לא טקסט לקריאת אדם; הצוות קיבל "סוג מסמך: id_card".
// נוסחי "אין מספר חדר" לפי המצב — כדי שהצוות יבין מיד אם זו תקלה
// (אורח שאיננו יודעים איפה הוא) או מהלך תקין (חדר שטרם הוקצה).
const ROOM_NOTE_PENDING_CHECKIN = "טרם הוקצה — יוקצה עם אישור הפיקדון";
const ROOM_NOTE_CHECKED_OUT     = "החדר כבר פונה (לאחר צ'ק אאוט)";

function docTypeHe(type) {
  return { id_card: "תעודת זהות", passport: "דרכון", drivers_license: "רישיון נהיגה" }[type]
    || type || "—";
}

// דחייה מנומסת, שמירה, והתראה לקבלה.
async function handleIdStage(phone, media, lang) {
  const he = lang === "he";

  // 1. חייבת להיות תמונה (Bug #3) — טקסט/קובץ אחר → מבקשים שוב, השלב נשמר.
  const m = validateIdMedia(media);
  if (!m.ok) {
    await promptStage(phone, "waiting_id", lang, { prefix: hint("id", m.reason, lang) });
    return;
  }

  const s                 = getSession(phone);
  const guestNameHe       = s.pendingNameHe || s.pendingName || "אורח";
  const guestNameEn       = s.pendingNameEn || s.pendingName || "Guest";
  const guestName         = guestNameHe; // צוות המלון עובד בעברית
  const reservationNumber = s.pendingReservation || "";

  await wa(phone, he
    ? "🔎 רגע אחד, בודק את המסמך…"
    : "🔎 One moment, I'm checking your document…", { lang });

  // 2. אימות אמיתי דרך שכבת idverify המבודדת (Claude vision).
  //    לא זורק בזרימה רגילה — תקלה טכנית חוזרת כ-"manual_review".
  //    🔴 עוטפים ב-timeout קשיח (מירוץ מול 40 שניות): גם אם משהו בשרשרת
  //    האימות נתקע (רשת/AI), האורח לא יישאר לעולם על "🔎 בודק…". חריגת
  //    זמן = בדיקה ידנית, והצ'ק אין ממשיך — לעולם לא שקט (Bug #1).
  let result;
  try {
    result = await Promise.race([
      idVerify.verifyDocument({
        reservationId: reservationNumber,
        phone,
        guestName,
        mediaUrl: media.url,
        contentType: m.value,
        documentType: "id_or_passport",
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("id verify timeout")), 40_000)),
    ]);
  } catch (e) {
    console.error("ID verification crashed/timed out:", e?.message || e);
    result = { status: "manual_review", storedPath: null, documentType: "id" };
  }

  // 3א. תקלה טכנית אצלנו — לא הצלחנו למשוך את הקובץ. מבקשים לשלוח שוב;
  //     אחרי 3 פעמים לא מענישים את האורח — ממשיכים והקבלה תשלים ידנית.
  if (result.status === "retry") {
    const attempts = (s.idAttempts || 0) + 1;
    patchSession(phone, { idAttempts: attempts });
    if (attempts < 3) {
      await promptStage(phone, "waiting_id", lang, {
        prefix: `🪪 ${he ? result.reasonHe : result.reasonEn}`,
      });
      return;
    }
    result = { ...result, status: "manual_review" }; // → ממשיכים לפיקדון למטה
  }

  // 3ב. נדחה — לא תעודה / לא קריא. מבקשים שוב בנימוס, נשארים בשלב.
  if (result.status === "rejected") {
    const attempts = (s.idAttempts || 0) + 1;
    patchSession(phone, { idAttempts: attempts });
    const why = (he ? result.reasonHe : result.reasonEn) ||
      (he ? "התמונה אינה נראית כמו תעודת זהות או דרכון." : "The image doesn't look like an ID card or passport.");

    // אחרי 3 ניסיונות — הסלמה לאדם, אבל האורח עדיין יכול לנסות שוב.
    if (attempts >= 3) {
      await notifyStaff({
        phone,
        dept: "reception",
        roomNumber: s.roomNumber,
        roomNote: ROOM_NOTE_PENDING_CHECKIN,
        guestName,
        message:
          `🪪 *אימות זהות נכשל ${attempts} פעמים* בצ'ק אין הדיגיטלי\n` +
          `👤 אורח: ${guestName}\n🔖 הזמנה: ${reservationNumber || "—"}\n` +
          `📸 המסמך שנשלח אינו מזוהה כתעודה. נדרש טיפול אנושי.`,
        priority: "high",
      });
      await wa(phone, he
        ? `${why}\n\nאין בעיה — מהקבלה יחזרו אליך ויסייעו באימות. 🌟\nבינתיים אפשר לנסות לשלוח צילום נוסף, ברור ומלא.`
        : `${why}\n\nNo problem — reception will be in touch to help with the verification. 🌟\nIn the meantime, feel free to send another clear, full photo.`, { lang });
      return;
    }

    await promptStage(phone, "waiting_id", lang, { prefix: `🪪 ${why}` });
    return;
  }

  // 4. אומת (או ממתין לבדיקה אנושית) — מתקדמים לאישור התנאים.
  patchSession(phone, { checkinStage: "waiting_terms", guestName, guestNameHe, guestNameEn, idAttempts: 0 });

  const verified = result.status === "verified";

  // ── התראה לקבלה: וואטסאפ + מייל (Bug #8) ─────────────
  // כוללת שם אורח, מספר חדר (אם כבר הוקצה) והיכן נשמר המסמך.
  await notifyStaff({
    phone,
    dept: "reception",
    roomNumber: s.roomNumber || null,
    roomNote: ROOM_NOTE_PENDING_CHECKIN,
    guestName,
    message:
      (verified
        ? `🪪 *אימות זהות הושלם בצ'ק אין הדיגיטלי*\n`
        : `⚠️ *מסמך זיהוי התקבל — לא אומת אוטומטית, נדרשת בדיקה ידנית*\n`) +
      // שם האורח והחדר כבר מופיעים בכותרת ההתראה — לא חוזרים עליהם כאן.
      `🔖 הזמנה: ${reservationNumber || "—"}\n` +
      `📄 סוג מסמך: ${docTypeHe(result.documentType)}\n` +
      (result.storedPath
        ? `📸 המסמך נשמר: ${result.storedPath}\n   ⚠️ אחסון דמו מקומי — בפרודקשן: אחסון מאובטח ומוצפן\n`
        : `📸 המסמך לא נשמר\n`) +
      (verified ? `ניתן להמשיך בהקצאת חדר/כרטיס.` : `נא לאמת את זהות האורח בקבלה.`),
    priority: verified ? "normal" : "high",
  });

  // 5. שלב תנאי השהייה — בשפת השיחה הנוכחית. אומרים "אומת" *רק* אם באמת אומת.
  await promptStage(phone, "waiting_terms", lang, {
    prefix: verified
      ? (he
          ? "✅ *תעודת הזהות אומתה בהצלחה!* 🪪"
          : "✅ *Your ID was verified successfully!* 🪪")
      : (he
          ? "🪪 קיבלנו את המסמך, תודה! השלמת האימות תיעשה מול הקבלה — נמשיך בינתיים."
          : "🪪 We've received your document, thank you! Reception will complete the verification — let's continue in the meantime."),
  });
}

function isAffirmative(text) {
  const t = text.replace(/['''`״׳.!]/g, "").toLowerCase().trim();
  return ["כן", "yes", "yep", "yeah", "yup", "אישור", "מאשר", "מאשרת", "אוקיי", "אוקי",
          "בסדר", "סבבה", "ok", "okay", "confirm", "y", "כן בבקשה", "מאשר/ת"].includes(t);
}

function isNegative(text) {
  const t = text.replace(/['''`״׳.!]/g, "").toLowerCase().trim();
  return ["לא", "no", "nope", "ביטול", "בטל", "בטלי", "cancel", "n", "עוד לא", "לא עכשיו"].includes(t);
}

// שלב 1 — מציג לאורח את כל החיובים ומבקש אישור
async function startCheckout(phone, lang) {
  const res = getActiveReservation(phone);
  if (!res) {
    await wa(phone, lang === "he"
      ? "לא מצאתי הזמנה פעילה על שמך. אפשר לפנות לקבלה בשלוחה 0 ונשמח לסייע."
      : "I couldn't find an active reservation in your name. Reception is available at Ext. 0 and will be glad to help.", { lang });
    return;
  }
  patchSession(phone, { checkoutStage: "awaiting_confirmation" });
  const bill = formatFolio(res, lang);
  const header = lang === "he"
    ? `🚪 *בקשת צ'ק אאוט*\n\nלהלן סיכום מלא של החיובים שלך:\n\n`
    : `🚪 *Check-out request*\n\nHere is a full summary of your charges:\n\n`;
  const footer = lang === "he"
    ? `\n\nנא להשיב *כן* לאישור הצ'ק אאוט (החיובים ינוכו מהפיקדון במידת הצורך), או *לא* לביטול.`
    : `\n\nPlease reply *yes* to confirm check-out (any charges will be deducted from the deposit), or *no* to cancel.`;
  await wa(phone, header + bill + footer, { lang });
}

// שלב 2 — מבצע בפועל: מחייב מהפיקדון לפי שלושת המקרים
async function confirmCheckout(phone, session, lang) {
  try {
    const res = await processCheckout(phone, session.reservationId || null, lang);
    patchSession(phone, {
      stage: "checked_out", checkinStage: null, checkoutStage: null,
      // ── משוב: מסמנים שממתינים למשוב האורח (ההודעה הבאה שלו) ──
      feedbackPending:       true,
      feedbackReservationId: res?.id || session.reservationId || null,
    });
    // בקשת משוב עדינה — הודעה נפרדת אחרי אישור הצ'ק אאוט, לא דחפנית.
    await promptFeedback(phone, lang);
  } catch (e) {
    console.error("Checkout error:", e.message);
    patchSession(phone, { checkoutStage: null });
    await wa(phone, lang === "he"
      ? "לא מצאתי הזמנה פעילה על שמך. אפשר לפנות לקבלה בשלוחה 0 ונשמח לסייע."
      : "I couldn't find an active reservation in your name. Reception is available at Ext. 0 and will be glad to help.", { lang });
  }
}

// ── משוב האורח — בקשה נעימה ולא מעיקה ─────────────────
async function promptFeedback(phone, lang) {
  // ניסוח נטול-מין: "נשמח", "אפשר", "לדרג" — נכונים לזכר ולנקבה כאחד.
  await wa(phone, lang === "he"
    ? `לפני שניפרד — נשמח מאוד לשמוע איך הייתה השהייה 🌟\n` +
      `אפשר לדרג מ-*1 עד 5*, או לכתוב מילה קצרה. וכמובן — אפשר גם פשוט לכתוב *דלג*.`
    : `Before you go — we'd love to hear how your stay was 🌟\n` +
      `Feel free to rate it *1 to 5*, or drop a quick note. Or just type *skip*, of course.`, { lang });
}

// מטפל בהודעת המשוב של האורח: מחלץ דירוג (1–5) ו/או טקסט, שומר על
// ההזמנה, מודה בחום ומעדכן את ההנהלה. משוב הוא אופציונלי — "דלג" מסיים.
async function handleFeedback(phone, text, lang) {
  const s   = getSession(phone);
  const he  = lang === "he";
  const raw = String(text || "").trim();
  // שומרים את מזהה ההזמנה *לפני* הניקוי (patchSession מאפס אותו על אותו אובייקט).
  const rid = s.feedbackReservationId || s.reservationId || null;

  patchSession(phone, { feedbackPending: false, feedbackReservationId: null });

  // דילוג — פרידה חמה בלי לשמור משוב.
  if (isSkipWord(raw)) {
    await wa(phone, he
      ? "בשמחה, אין צורך 🙏 תודה ששהית איתנו — נסיעה טובה ולהתראות! 🌟"
      : "Of course, no problem 🙏 Thank you for staying with us — safe travels and see you again! 🌟", { lang });
    return;
  }

  // דירוג 1–5 אם צוין (ספרה בודדת או "5/5"), והטקסט כמשוב מילולי.
  const m = raw.match(/\b([1-5])\s*(?:\/\s*5|כוכבים|stars?)?\b/);
  const rating = m ? +m[1] : null;
  if (rid) {
    try { saveFeedback(rid, { rating, text: raw }); }
    catch (e) { console.error("saveFeedback failed:", e?.message || e); }
  }

  // עדכון ההנהלה/קבלה — כדי שמשוב (ובמיוחד דירוג נמוך) לא ייעלם.
  try {
    await notifyStaff({
      phone,
      dept: "reception",
      roomNumber: s.roomNumber,
      roomNote: ROOM_NOTE_CHECKED_OUT,
      guestName: s.guestName,
      message:
        `⭐ *משוב אורח בצ'ק אאוט*\n` +
        (rating ? `דירוג: ${rating}/5\n` : "") +
        `"${raw.slice(0, 400)}"`,
      priority: rating && rating <= 2 ? "high" : "normal",
    });
  } catch (e) { console.error("feedback notify failed:", e?.message || e); }

  // תודה חמה — מותאמת לדירוג אם ניתן.
  // ניסוח נטול-מין ובלשון יחיד — עקבי עם הפרידה בצ'ק אאוט ("לראותך").
  const warm = rating && rating <= 3
    ? (he
        ? "תודה על הכנות — כל מילה עוזרת לנו להשתפר 🙏 נשמח לארח אותך שוב ולתת חוויה טובה עוד יותר."
        : "Thank you for your honesty — every word helps us improve 🙏 We'd love to host you again and do even better.")
    : (he
        ? "תודה רבה על המילים החמות! 🌟 שמחנו מאוד לארח אותך, ונשמח לראותך שוב."
        : "Thank you so much for the kind words! 🌟 It was a pleasure hosting you, and we can't wait to welcome you back.");
  await wa(phone, warm, { lang });
}

// ════════════════════════════════════════════════════════
//  חירום — טיפול דטרמיניסטי, לפני כל דבר אחר (Bug קריטי)
//  ----------------------------------------------------------
//  נקרא מ-processIncoming ברגע שזוהה חירום, *לפני* מכונת הצ'ק אין,
//  הצ'ק אאוט וה-AI. הסדר קריטי: קודם שולחים לאורח את ההנחיה (לפני כל
//  await שעלול לזרוק) — כך שגם אם ההסלמה לצוות תיכשל, האורח כבר קיבל
//  את מספרי החירום. כל שלב עטוף ב-try/catch משלו: שום כשל לא משתיק את
//  ההנחיה שהאורח כבר קיבל.
// ════════════════════════════════════════════════════════
async function handleEmergency(phone, text, lang, kind) {
  const raw = String(text ?? "").trim();
  const s   = getSession(phone);

  // מיקום האורח — הדבר הקריטי ביותר בהתראת חירום. הסשן הוא המקור הראשון,
  // אבל סשן שאופס/אורח שעשה צ'ק אין בקבלה עדיין יכול להיות מקושר להזמנה
  // פעילה — ולכן נופלים אליה לפני שמוותרים.
  let roomNumber = s.roomNumber;
  if (!roomNumber) {
    try { roomNumber = getActiveReservation(phone)?.roomNumber || null; } catch { /* לא חוסם */ }
  }
  const guestName = s.guestName || (() => {
    try { return getActiveReservation(phone)?.guestName || null; } catch { return null; }
  })();

  // 1) האורח מקבל את ההנחיה *מיד* — הדבר הראשון, לפני כל דבר שעלול לזרוק.
  //    אם אין מספר חדר, ההנחיה כוללת גם בקשת מיקום.
  const guestMsg = emergencyGuestMessage(kind, lang, { locationKnown: !!roomNumber });
  try {
    await wa(phone, guestMsg, { lang });
  } catch (e) {
    console.error("🚨 כשל בשליחת הנחיית החירום לאורח:", e?.message || e);
  }

  // 2) תיעוד מובנה של האירוע (לא חוסם — נכשל בשקט ללוג בלבד).
  try {
    logIncident({
      phone,
      roomNumber,
      guestName,
      kind,
      description: `[${kind}] ${raw.slice(0, 300)}`,
      channel:     "whatsapp",
    });
  } catch (e) {
    console.error("🚨 כשל בתיעוד אירוע החירום:", e?.message || e);
  }

  // 3) הסלמה מובטחת לצוות הביטחון (אדם) — בעדיפות גבוהה, בעברית.
  try {
    await notifyStaff({
      phone,
      dept:       "security",
      roomNumber,
      guestName,
      message:
        `🚨 *חירום — ${emergencyKindHe(kind)}*\n` +
        `האורח דיווח: "${raw.slice(0, 400)}"\n` +
        `🗣️ שפת האורח: ${lang === "en" ? "אנגלית" : "עברית"}\n` +
        (roomNumber
          ? `📍 מיקום: חדר ${roomNumber}\n`
          : `📍 *מיקום לא ידוע* — האורח אינו משויך לחדר. התקשרו אליו *עכשיו* למספר שלמעלה; נשלחה אליו בקשה לציין מיקום, וכל תשובה תועבר אליכם.\n`) +
        `📞 האורח קיבל הנחיה להתקשר ${emergencyDial(kind)} (וכל מספרי החירום).\n` +
        `⏱️ נדרש טיפול אנושי *מיידי* — ביטחון/מנהל תורן.`,
      priority: "high",
    });
  } catch (e) {
    console.error("🚨 כשל בהסלמת החירום לצוות:", e?.message || e);
  }

  // 3ב) יתירות בטיחותית: מסלימים *גם* לקבלה, כדי שלא נסתמך על מספר
  //     ביטחון בודד שאולי לא מאויש באותו רגע. שני אנשים מקבלים התראה.
  try {
    await notifyStaff({
      phone,
      dept:       "reception",
      roomNumber,
      guestName,
      message:
        `🚨 *גיבוי חירום — ${emergencyKindHe(kind)}* (הסלמה מקבילה לביטחון)\n` +
        `האורח דיווח: "${raw.slice(0, 400)}"\n` +
        `ודאו שצוות הביטחון/המנהל התורן מטפל *עכשיו*.`,
      priority: "high",
    });
  } catch (e) {
    console.error("🚨 כשל בהסלמת גיבוי החירום לקבלה:", e?.message || e);
  }

  // 3ג) אם אין מיקום — ההודעה הבאה של האורח היא תשובת המיקום, והיא
  //     מועברת לביטחון מיד (הטיפול ב-processIncoming), ולא ל-AI.
  try {
    patchSession(phone, { emergencyAwaitLocation: roomNumber ? null : kind });
  } catch (e) {
    console.error("🚨 כשל בסימון המתנה למיקום:", e?.message || e);
  }

  // 4) שמירת ההקשר בהיסטוריה — כדי שהמשך השיחה ("הלו?", עדכון) יגיע
  //    ל-AI עם ההקשר המלא ולא כאילו כלום לא קרה.
  try {
    if (raw) pushHistory(phone, "user", raw);
    pushHistory(phone, "assistant", guestMsg);
  } catch (e) {
    console.error("🚨 כשל בשמירת היסטוריית החירום:", e?.message || e);
  }
}

// ── שער הכניסה — לעולם לא משאיר אורח בלי מענה (Bug #2) ──
// כל שגיאה, מכל מקום בזרימה, נתפסת כאן: האורח תמיד מקבל הודעה,
// והתקלה מוסלמת לקבלה (אדם) כדי שמישהו יטפל. אף פעם לא שקט מוחלט.
export async function handleIncoming(phone, text, media = null) {
  try {
    await processIncoming(phone, text, media);
  } catch (e) {
    console.error("🚨 handleIncoming failed:", e?.stack || e?.message || e);
    const lang = sessions[phone]?.lang || detectLangSignal(text) || "he";

    try {
      await wa(phone, FALLBACK_MSG[lang], { lang });
    } catch (e2) {
      console.error("🚨 Fallback message failed to send:", e2?.message || e2);
    }

    try {
      await notifyStaff({
        phone,
        dept: "reception",
        roomNumber: sessions[phone]?.roomNumber,
        guestName: sessions[phone]?.guestName,
        message: `⚠️ תקלה טכנית בטיפול בהודעת אורח (${phone}). האורח קיבל הודעת המתנה — נדרש מעקב אנושי.\nשגיאה: ${e?.message || e}`,
        priority: "high",
      });
    } catch (e3) {
      console.error("🚨 Staff escalation failed:", e3?.message || e3);
    }
  }
}

async function processIncoming(phone, text, media = null) {
  const session = getSession(phone);
  recordActivity(phone); // רישום ההודעה הנכנסת (messageCount/פעילות) — פעם אחת בלבד (Bug #2)

  // ── בקשה מפורשת לעבור שפה — קודמת לכל דבר אחר (Bug #4) ─
  // "אתה יכול לדבר איתי בעברית?" → עוברים מיד, בלי שום תירוץ, גם באמצע
  // צ'ק אין. מסירים את הבקשה מהטקסט כדי שהשארית ("10") עדיין תטופל
  // כקלט של השלב הנוכחי — כך גם מחליפים שפה וגם מתקדמים באותה הודעה.
  const langRequest  = detectLanguageRequest(text);
  const langSwitched = !!langRequest;
  let   body         = langSwitched ? stripLanguageRequest(text) : String(text ?? "");

  // ── שפת השיחה דינמית לפי כל הודעה ─────────────────────
  // מזהים את שפת ההודעה הנוכחית ומעדכנים את שפת השיחה בהתאם — כך אורח
  // שכותב אנגלית מקבל תשובה באנגלית מיד, בלי לבקש "In English?".
  // חריג: כשאנחנו באמצע זרימת צ'ק אין/אאוט, הקלט הוא נתונים (שם/מספר הזמנה/
  // כן-לא) ואסור שיחליף את שפת השיחה — לכן נועלים לשפה שכבר נקבעה.
  // בקשה מפורשת (langRequest) גוברת תמיד, גם באמצע זרימה (Bug #5).
  const signal  = detectLangSignal(body); // "he" | "en" | null (אין אות שפה)
  const inFlow  = !!session.checkinStage || session.checkoutStage === "awaiting_confirmation";
  const lang    = langRequest
    ? langRequest
    : inFlow
      ? (session.lang || signal || "en")
      : (signal || session.lang || "en");
  if (session.lang !== lang) patchSession(phone, { lang });

  // ── 🚨 חירום — קודם לכל דבר אחר (בטיחות) ─────────────
  // זיהוי דטרמיניסטי (emergency.js), לא תלוי ב-AI, שרץ *לפני* מכונת
  // הצ'ק אין, הצ'ק אאוט וה-AI. אורח שכותב "יש פצוע" — גם באמצע צ'ק אין,
  // גם כשה-AI למטה — מקבל מיד את מספרי החירום, והביטחון מוסלם. זו
  // ההגנה מפני השתיקה בחירום. מזהים על הטקסט הגולמי (לפני כל עיבוד).
  const emergency = detectEmergency(text);
  if (emergency) {
    await handleEmergency(phone, text, lang, emergency.kind);
    return;
  }

  // ── תשובת המיקום שביקשנו באירוע חירום ────────────────
  // באירוע חירום בלי מספר חדר ביקשנו מהאורח לציין איפה הוא. ההודעה הבאה
  // היא התשובה — והיא חייבת להגיע לביטחון *מיד*, ולא להיבלע ע"י ה-AI או
  // ע"י מכונת הצ'ק אין. בלי זה ההבטחה "הם בדרך אליכם" חסרת משמעות.
  if (session.emergencyAwaitLocation) {
    const kind = session.emergencyAwaitLocation;
    const room = extractRoomNumber(body);
    patchSession(phone, {
      emergencyAwaitLocation: null,
      ...(room ? { roomNumber: room } : {}),
    });
    try {
      await notifyStaff({
        phone,
        dept:       "security",
        roomNumber: room,
        guestName:  session.guestName,
        message:
          `📍 *עדכון מיקום לאירוע החירום (${emergencyKindHe(kind)})*\n` +
          `האורח מסר: "${String(body).slice(0, 300)}"\n` +
          `⏱️ המשיכו לטפל *עכשיו*.`,
        priority: "high",
      });
    } catch (e) {
      console.error("🚨 כשל בהעברת מיקום החירום לצוות:", e?.message || e);
    }
    const ack = lang === "he"
      ? "קיבלתי, והעברתי את המיקום לצוות הביטחון — הם בדרך.\nאם המצב מחמיר, התקשרו שוב למוקד החירום. אני כאן."
      : "Got it — I've passed your location to the security team and they're on their way.\nIf anything gets worse, call the emergency services again. I'm here.";
    await wa(phone, ack, { lang });
    pushHistory(phone, "user", String(body));
    pushHistory(phone, "assistant", ack);
    return;
  }

  // ── ממתינים למספר חדר כדי להעביר בקשה למחלקה (Bug #3) ─
  // בקשה למחלקת "בתוך החדר" (ניקיון/אחזקה/רום סרוויס) מאורח שאין לו חדר
  // ידוע — עוכבה עד שהאורח ימסור את מספר החדר. ההודעה הזו אמורה להיות
  // מספר החדר: אם כן — משחררים את הבקשה עם החדר הנכון; אם לא — מבקשים
  // שוב פעם אחת, ואז מעבירים לקבלה (מזהה לפי הטלפון) בלי לאבד את הבקשה.
  if (session.pendingRoomActionRaw) {
    const heldRaw  = session.pendingRoomActionRaw;
    const heldLang = session.pendingRoomLang || lang;
    const room     = extractRoomNumber(body);

    if (room) {
      patchSession(phone, { roomNumber: room, pendingRoomActionRaw: null, pendingRoomLang: null, pendingRoomAttempts: 0 });
      let reply = stripInternalTags(await runActions(heldRaw, sessions[phone] || session, phone));
      if (!reply) reply = heldLang === "he"
        ? `מצוין — חדר *${room}*! 🌟 העברתי את הבקשה לצוות המתאים, והם מטפלים בזה כעת.`
        : `Perfect — room *${room}*! 🌟 I've passed your request to the right team and they're on it.`;
      await wa(phone, reply, { lang: heldLang });
      pushHistory(phone, "assistant", reply);
      return;
    }

    const attempts = (session.pendingRoomAttempts || 0) + 1;
    if (attempts < 2) {
      patchSession(phone, { pendingRoomAttempts: attempts });
      await wa(phone, lang === "he"
        ? "רק כדי שהבקשה תגיע למקום הנכון — מה מספר החדר? (למשל 512)"
        : "Just so your request reaches the right place — what's your room number? (e.g. 512)", { lang });
      return;
    }
    // אחרי שני ניסיונות בלי מספר חדר — לא מאבדים את הבקשה: מעבירים לצוות
    // (הקבלה מזהה את האורח לפי הטלפון), ומטפלים בהודעה הנוכחית כרגיל.
    patchSession(phone, { pendingRoomActionRaw: null, pendingRoomLang: null, pendingRoomAttempts: 0 });
    await runActions(heldRaw, sessions[phone] || session, phone).catch(() => {});
  }

  // הודעה ראשונה: שולחים תפריט/פתיחה רק אם זו ברכה כללית בלבד ("שלום"/"היי").
  // אם יש בהודעה הראשונה כוונה ברורה (צ'ק אין/אאוט, בקשת מחלקה, שאלה) —
  // ממשיכים מיד לטיפול בה למטה, בלי לשלוח תפריט מקדים.
  if (session.messageCount === 1) {
    patchSession(phone, { stage: "active" });
    if (isGenericGreeting(body)) {
      const welcome = hotelConfig.welcome[lang] || hotelConfig.welcome.en;
      await wa(phone, welcome, { lang });
      pushHistory(phone, "assistant", welcome);
      return;
    }
  }

  // ── משוב צ'ק אאוט — ההודעה הראשונה אחרי הפרידה ────────
  // אחרי צ'ק אאוט ביקשנו משוב; ההודעה הבאה של האורח מטופלת כמשוב —
  // אלא אם היא בקשה חדשה (צ'ק אין/אאוט) שגוברת ומאפסת את ההמתנה למשוב.
  if (session.feedbackPending && body) {
    if (isCheckinIntent(body) || isCheckoutIntent(body)) {
      patchSession(phone, { feedbackPending: false, feedbackReservationId: null });
    } else {
      await handleFeedback(phone, body, lang);
      return;
    }
  }

  if (isCheckinIntent(body) && !session.checkinStage && session.stage !== "checked_in") {
    patchSession(phone, { checkinStage: "start" });
    await handleCheckin(phone, body, lang, media, { langSwitched });
    return;
  }

  // באמצע צ'ק אין — כולל שלב הפיקדון. אורח שכותב "להמשיך בצ'ק אין"
  // בזמן שהוא ממתין לתשלום מקבל את קישור הפיקדון שוב (Bug #1: פעם
  // ההודעה הזו נפלה ל-AI, שהחזיר [CHECKIN] — והתג נשלח לאורח).
  if (session.checkinStage) {
    const waitingPayment = session.checkinStage === "waiting_payment";
    if (!waitingPayment || langSwitched || isCheckinIntent(body) || !body) {
      await handleCheckin(phone, body, lang, media, { langSwitched });
      return;
    }
    // בשלב הפיקדון אפשר עדיין לשאול את הקונסיירז' שאלות רגילות — ממשיכים.
  }

  // אורח שנמצא באמצע אישור צ'ק אאוט — מטפלים בתשובה כן/לא
  if (session.checkoutStage === "awaiting_confirmation") {
    // החליף שפה באמצע → שולחים את החשבון מחדש בשפה החדשה וממשיכים משם.
    if (langSwitched && !body) {
      await startCheckout(phone, lang);
      return;
    }
    if (isNegative(body)) {
      patchSession(phone, { checkoutStage: null });
      await wa(phone, lang === "he"
        ? "הצ'ק אאוט בוטל. אנחנו כאן לכל דבר נוסף 😊"
        : "Check-out cancelled. We're here for anything else you need 😊", { lang });
    } else if (isAffirmative(body)) {
      await confirmCheckout(phone, session, lang);
    } else {
      await wa(phone, lang === "he"
        ? "לא הצלחתי לזהות אם זה אישור. נא להשיב *כן* לאישור הצ'ק אאוט, או *לא* לביטול."
        : "I couldn't tell whether that was a yes. Please reply *yes* to confirm check-out, or *no* to cancel.", { lang });
    }
    return;
  }

  if (isCheckoutIntent(body) && (session.stage === "checked_in" || getActiveReservation(phone))) {
    await startCheckout(phone, lang);
    return;
  }

  // ── בקשת שפה "טהורה" — עונים מיד, בלי לערב את ה-AI (Bug #4) ──
  // אין שום תוכן מלבד הבקשה → אישור קצר בשפה החדשה. כך אין שום סיכוי
  // לתירוץ מהסוג של "אני משתדל לתקשר באנגלית".
  if (langSwitched && !body) {
    await wa(phone, lang === "he"
      ? "בוודאי! מכאן נמשיך בעברית 😊\nאיך אוכל לעזור?"
      : "Of course! We'll continue in English from here 😊\nHow can I help?", { lang });
    return;
  }

  // ── שורש Bug #2: הודעה ריקה בהיסטוריה = בוט מת לצמיתות ──
  // אורח ששלח *רק* מדיה (תמונה אקראית, ללא טקסט) הכניס לכאן מחרוזת
  // ריקה. ה-API של Claude דוחה content ריק ב-400, ההיסטוריה נשמרת
  // ל-SQLite — ולכן *כל* הודעה הבאה של אותו אורח נכשלה שוב, גם אחרי
  // ריסטארט. מתארים את המדיה במילים במקום לדחוף ריק.
  const userMsg = body
    || (media ? (lang === "he" ? "(האורח שלח תמונה ללא טקסט)" : "(the guest sent an image with no text)") : "")
    || String(text ?? "").trim();

  if (!userMsg) {
    // אין טקסט ואין מדיה — אין על מה לענות, ואסור להרעיל את ההיסטוריה.
    await wa(phone, lang === "he"
      ? "לא הצלחתי לקרוא את ההודעה 🙏 אפשר לנסח אותה שוב?"
      : "I couldn't read that message 🙏 Could you send it again?", { lang });
    return;
  }

  pushHistory(phone, "user", userMsg);
  let raw;
  try {
    raw = await runConciergeTurn(sessions[phone] || session, lang, phone);
    if (!raw) throw new Error("empty AI response");
  } catch (e) {
    console.error("AI error (all retries failed):", e?.message || e);
    raw = lang === "he"
      ? "מצטערים, אירעה תקלה זמנית אצלנו. אפשר לנסות שוב בעוד רגע, ולכל דבר דחוף הקבלה זמינה בשלוחה 0."
      : "Apologies, we hit a temporary glitch. Please try again in a moment — and for anything urgent, reception is available at Ext. 0.";
  }

  // ── גיבוי זיהוי כוונה מבוסס-AI ─────────────────────────
  // הכללים המהירים למעלה תופסים ניסוחים ברורים בלי קריאת AI. כשהם מפספסים
  // (שגיאות כתיב, ניסוח חופשי), הקונסיירז' מזהה את הכוונה ומחזיר תג בלבד —
  // [CHECKIN] / [CHECKOUT] — ואנחנו מנתבים למכונת המצבים במקום לענות.
  //
  // ⚠️ Bug #1: כאן *חייבים* לטפל בכל מצב אפשרי. בעבר התנאי סינן מצבים
  // מסוימים (למשל אורח בשלב הפיקדון), התג לא נתפס — ונשלח לאורח כטקסט
  // גולמי: "[CHECKIN]". עכשיו כל ענף מסתיים בפעולה + return, ותג פנימי
  // לעולם לא ממשיך לנתיב השליחה. (ו-wa() מסנן כרשת ביטחון אחרונה.)
  // `(?:\]|\s|$)` — גם תג שנקטע ללא סוגר ("[CHECKIN") מזוהה ומנותב,
  // במקום ליפול הלאה ולהישלח לאורח כטקסט.
  if (/\[CHECKIN(?:\]|\s|$)/i.test(raw)) {
    if (session.stage === "checked_in") {
      await wa(phone, lang === "he"
        ? `הצ'ק אין שלך כבר הושלם — חדר *${session.roomNumber || "—"}* 🌟\nבמה אוכל לעזור?`
        : `You're already checked in — room *${session.roomNumber || "—"}* 🌟\nHow can I help?`, { lang });
    } else if (session.checkinStage) {
      // כבר באמצע צ'ק אין → ממשיכים מהשלב הנוכחי, לא מתחילים מהתחלה.
      await promptStage(phone, session.checkinStage, lang);
    } else {
      patchSession(phone, { checkinStage: "start" });
      await handleCheckin(phone, body, lang, media, { langSwitched });
    }
    return;
  }
  if (/\[CHECKOUT(?:\]|\s|$)/i.test(raw)) {
    if (session.stage === "checked_in" || getActiveReservation(phone)) {
      await startCheckout(phone, lang);
    } else {
      await wa(phone, lang === "he"
        ? "לא מצאתי הזמנה פעילה על שמך לצ'ק אאוט. אם כבר ביצעת צ'ק אין, אפשר לפנות לקבלה בשלוחה 0 ונשלים זאת מיד."
        : "I couldn't find an active reservation to check out. If you've already checked in, reception at Ext. 0 will sort it out right away.", { lang });
    }
    return;
  }

  // ── מספר חדר חובה לבקשת מחלקה "בתוך החדר" (Bug #3) ────
  // ה-AI ביקש להעביר בקשה לניקיון/אחזקה/רום סרוויס, אבל אין לנו מספר חדר
  // (אורח שלא עשה צ'ק אין דרך הבוט). לא מעבירים בקשה בלי חדר — הצוות לא
  // יידע לאן ללכת. עוצרים, זוכרים את הבקשה, ומבקשים את מספר החדר. ההודעה
  // הבאה של האורח תשחרר את הבקשה עם החדר הנכון (הטיפול למעלה).
  const sess = sessions[phone] || session;
  if (needsRoomNumber(raw) && !sess.roomNumber) {
    patchSession(phone, { pendingRoomActionRaw: raw, pendingRoomLang: lang, pendingRoomAttempts: 0 });
    const ask = lang === "he"
      ? "בשמחה אדאג לזה 🙏 מה מספר החדר שלך? (כדי שהצוות יגיע למקום הנכון)"
      : "I'd be glad to sort that out for you 🙏 What's your room number? (so the team reaches the right place)";
    await wa(phone, ask, { lang });
    pushHistory(phone, "assistant", ask);
    return;
  }

  // runActions מטפל בתגי המחלקות ומסיר אותם; stripInternalTags מנקה כל
  // תג אחר שנותר (כולל כזה שהמצאנו/המצא ה-AI) לפני שליחה ולפני היסטוריה.
  let reply = stripInternalTags(await runActions(raw, sessions[phone] || session, phone));

  // התשובה הייתה תגים בלבד → אחרי הניקוי לא נשאר טקסט. שולחים אישור
  // אנושי במקום כלום — האורח לעולם לא נשאר בלי מענה (Bug #2).
  if (!reply) {
    reply = lang === "he"
      ? "קיבלתי! 🌟 העברתי את הבקשה לצוות המתאים, והם מטפלים בזה עכשיו."
      : "Got it! 🌟 I've passed your request to the right team and they're on it.";
  }

  await wa(phone, reply, { lang });
  pushHistory(phone, "assistant", reply);

  // הזמנת אוכל שנבחרה אך לא נשלחה — נזכרת לתור הבא, ומוסלמת אם נתקעה.
  // אחרי השליחה לאורח: מעקב לעולם לא מעכב את התשובה ולא מפיל אותה.
  await trackFoodOrder(phone, lang, {
    guestText: userMsg,
    reply:     raw,
    sent:      /\[ROOMSERVICE/i.test(raw),
  }).catch(e => console.error("trackFoodOrder failed:", e?.message || e));
}
