// ════════════════════════════════════════════════════════
//  BOT BRAIN v6 — Production Ready
// ════════════════════════════════════════════════════════
import Anthropic from "@anthropic-ai/sdk";
import twilio    from "twilio";
import dotenv    from "dotenv";
import { hotelConfig }                                    from "./config.js";
import { getSession, recordActivity, pushHistory, patchSession, logAlert, logIncident, stats, sessions } from "./state.js";
import { detectLangSignal, detectLanguageRequest, stripLanguageRequest } from "./i18n.js";
import { stripInternalTags, hasInternalTag, validateFullName, validateReservationNumber, validateIdMedia, validateStayDates, validateTermsConfirmation } from "./validate.js";
import { resolveNameForms, nameFor }                      from "./names.js";
import { startCheckin, processCheckout, getActiveReservation, getPendingReservation, formatFolio, depositExplainer, formatStayDates } from "./checkin.js";
import { email }                                          from "./email/index.js";
import { idVerify }                                       from "./idverify/index.js";
import { concierge, REQUEST_TYPES }                       from "./concierge/index.js";

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
export async function wa(to, body, { lang = "he" } = {}) {
  const raw = String(body ?? "");
  if (hasInternalTag(raw)) {
    console.error(`🚨 תג פנימי נתפס לפני שליחה לאורח (${to.slice(-8)}) — סונן: ${raw.slice(0, 120)}`);
  }

  let text = stripInternalTags(raw);
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

export async function notifyStaff({ dept, roomNumber, guestName, message, priority = "normal" }) {
  const numberMap = {
    housekeeping: hotelConfig.housekeeping_number,
    reception:    hotelConfig.reception_number,
    maintenance:  hotelConfig.maintenance_number,
    concierge:    hotelConfig.concierge_number,
    security:     hotelConfig.security_number,
  };
  const emailMap = {
    housekeeping: hotelConfig.housekeeping_email,
    reception:    hotelConfig.reception_email,
    maintenance:  hotelConfig.maintenance_email,
    concierge:    hotelConfig.concierge_email,
    security:     hotelConfig.security_email,
  };
  const emoji = { housekeeping: "🧹", reception: "🏨", maintenance: "🔧", concierge: "⭐", security: "🚨" }[dept] || "🔔";
  const urgency = priority === "high" ? "🚨 *דחוף* 🚨\n" : "";
  const { full } = israelTime();
  const body = `${urgency}${emoji} *${dept.toUpperCase()}*\n\n👤 אורח: ${guestName || "—"}\n🚪 חדר: ${roomNumber || "—"}\n📝 ${message}\n⏰ ${full}`;

  // ── ערוץ 1: וואטסאפ ──────────────────────────────────
  const to = numberMap[dept];
  if (to) {
    try { await wa(to, body); } catch (e) { console.error("Staff notify (WhatsApp) failed:", e.message); }
  }

  // ── ערוץ 2: מייל (דרך שכבת המייל המבודדת) ────────────
  const toEmail = emailMap[dept];
  if (toEmail) {
    const subject = `${priority === "high" ? "🚨 דחוף — " : ""}${dept.toUpperCase()} | חדר ${roomNumber || "—"} | ${guestName || "—"}`;
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

  if (lang === "he") {
    return `אתה הקונסיירז׳ הדיגיטלי של ${cfg.name_he}, מלון יוקרה 5 כוכבים.
השעה הנוכחית בישראל: ${nowFull}

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
  שהוא לתוך משפט. הצורות הנכונות: "תוכל לומר לי לאיזה יום ושעה?",
  "לאיזו שעה נוח לך?".
- פנייה לאורח: בגוף שני, בנימוס טבעי. אל תמציא צורות פועל.
- אל תדביק את מה שהאורח כתב לתוך משפט שלך. הפנייה בשם היא משפט נפרד.

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

⛔⛔ אסור להמציא מקומות — החוק החשוב ביותר בהמלצות:
- מותר להמליץ *אך ורק* על מקומות שכתובים בנתונים למטה (שירותי המלון + הסביבה).
  אלה המקומות שהמלון בדק ועומד מאחוריהם.
- ⛔ אל תנקוב בשם של מסעדה, בר, חנות, מועדון, ספק או עסק שאינו ברשימה — גם אם
  אתה "מכיר" אותו, גם אם הוא מפורסם, וגם אם האורח מפציר. שם שהמצאת עלול להיות
  מקום שנסגר, שלא קיים, או שהמלון לא היה שולח אליו אורח. אורח שמגיע למקום
  שהמצאת — זה כישלון של המלון, לא שלך.
- ⛔ אל תמציא כתובת, מספר טלפון, שעות פתיחה, מחיר או מרחק. אם זה לא כתוב למטה,
  אתה לא יודע את זה.
- אין באזור מה שהאורח מחפש (סושי, מקום כשר, מועדון ספציפי)? אל תמציא ואל תגיד
  רק "אני לא יודע" ותשאיר אותו תלוי באוויר. זה הניסוח הנכון:
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
  • מונית / הסעה: היעד · שעת האיסוף · מספר הנוסעים
  • שולחן במסעדה: שם המסעדה · היום והשעה · מספר הסועדים · בקשות מיוחדות
  • ספא: סוג הטיפול · היום והשעה · מספר המטופלים
  • טיול / סיור: איזה סיור · התאריך · מספר המשתתפים · שפת ההדרכה
  • בקשה מיוחדת: מה בדיוק · למתי · לאן להביא
- כשיש לך את הפרטים — הוסף את התג [CONCIERGE:<סוג>|<כל הפרטים>] והודע לאורח.

⚠️⚠️ מה מותר להבטיח — חוק ברזל של אמינות:
אתה *מעביר* את הבקשה לקונסיירז' האנושי, והוא זה שמבצע אותה מול המסעדה/חברת
המוניות. בזמן שאתה כותב לאורח, שום דבר עדיין לא בוצע ושום דבר עדיין לא אושר.
לכן, בלי יוצא מן הכלל:
- ✅ הניסוח הנכון: *"אעביר את בקשתך לקונסיירז' שלנו ואחזור אליך עם אישור"* /
  "העברתי את הבקשה, ואעדכן אותך ברגע שהיא מאושרת".
- ⛔ אסור בהחלט: "הזמנתי לך מונית ל-20:00", "השולחן שלך שמור", "סידרתי לך",
  "זה מטופל, המונית בדרך". אלה הבטחות שאתה לא יכול לקיים — ואורח שיורד ללובי
  ומגלה שאין מונית הוא כישלון חמור.
- ⛔ אל תמציא אישור, שעה שסוכמה, מספר אסמכתא, שם נהג או שם של מי שמטפל בבקשה.
- אל תתנצל על כך ואל תסביר לאורח איך המערכת עובדת מבפנים — אמור בביטחון ובחום
  מה קורה עכשיו ומתי הוא יקבל תשובה. זה מה שקונסיירז' אנושי אומר.

*פרואקטיביות* — החום של מלון יוקרה:
- סיים כמעט כל תשובה בהצעה קונקרטית אחת, לא ב-"יש עוד משהו?" הכללי והריק.
  אחרי שעות הספא: "אשמח לתפוס לך תור — יש לך יום ושעה שנוחים?"
  אחרי המלצה על מסעדה: "רוצה שאזמין שולחן?"
  אחרי "אני נוסע מחר לנתב"ג": "אסדר לך הסעה? כדאי לצאת בסביבות 05:30."
- חבר בין דברים שהאורח סיפר: מי שביקש מסעדה רומנטית ל-20:00 — הצע גם מונית.
- הצע רק מה שבאמת קיים בנתונים למטה. הצעה חמה על משהו שלא קיים היא שקר.

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
WiFi: רשת ${cfg.wifi.name} | סיסמה: ${cfg.wifi.password}
צ׳ק אין: ${cfg.checkin_time} | צ׳ק אאוט: ${cfg.checkout_time}
צ׳ק אין מוקדם: ${cfg.early_checkin ? "זמין בתיאום" : "לא זמין"}
צ׳ק אאוט מאוחר: ${cfg.late_checkout ? "זמין בתיאום" : "לא זמין"}

שירותי המלון:
${svcs}

▸ חניה
${park}

🗺️ הסביבה — הידע שלך על מחוץ למלון (זה מה שהופך אותך לקונסיירז'):
כל ההמלצות שלך מגיעות *מכאן בלבד*. אל תמליץ על מקום שאינו ברשימה, גם אם
אתה "מכיר" אותו — מלון 5 כוכבים עומד מאחורי כל המלצה שהוא נותן.
${area}

שאלות נפוצות:
${faqs}

פרטי האורח:
שם: ${nameFor(session, "he") || "—"} | חדר: ${session.roomNumber || "—"} | מצב: ${session.stage || "—"}

פקודות פנימיות (הוסף בסוף תגובתך בשורה נפרדת, האורח לא יראה אותן):
[HK:<תיאור>] — בקשת ניקיון
[HK_URGENT:<תיאור>] — ניקיון דחוף
[MAINTENANCE:<תיאור>] — תקלה טכנית
[RECEPTION:<תיאור>] — העברה לנציג אנושי
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

⛔⛔ NEVER INVENT A PLACE — the most important rule in recommendations:
- You may recommend *only* places written in the data below (hotel services + the area).
  Those are the places the hotel has vetted and stands behind.
- ⛔ Never name a restaurant, bar, shop, club, supplier or business that isn't on that
  list — not even if you "know" it, not even if it's famous, not even if the guest
  presses you. A name you invented may be somewhere that has closed, that doesn't
  exist, or that the hotel would never send a guest to. A guest arriving at a place
  you made up is the hotel's failure, not yours.
- ⛔ Never invent an address, a phone number, opening hours, a price or a distance.
  If it isn't written below, you don't know it.
- The area doesn't have what the guest wants (sushi, a kosher place, a specific club)?
  Don't invent, and don't just say "I don't know" and leave them hanging. Say this:
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
  • Taxi / transfer: the destination · the pick-up time · the number of passengers
  • Restaurant table: which restaurant · the day and time · the number of diners · any requests
  • Spa: which treatment · the day and time · how many people
  • Tour: which tour · the date · how many people · the language
  • Special request: what exactly · by when · where to deliver it
- Once you have the details — append [CONCIERGE:<type>|<all the details>] and tell the guest.

⚠️⚠️ WHAT YOU MAY PROMISE — an iron rule of honesty:
You *pass* the request to our human concierge, and they are the one who carries it out with
the restaurant or the taxi company. At the moment you write to the guest, nothing has been
done yet and nothing has been confirmed yet. Therefore, without exception:
- ✅ The right phrasing: *"I'll pass your request to our concierge and come back to you with
  a confirmation"* / "I've passed it on and I'll update you the moment it's confirmed."
- ⛔ Never: "I've booked you a taxi for 20:00", "Your table is reserved", "It's all sorted,
  the car is on its way." Those are promises you cannot keep — and a guest who goes down to
  the lobby to find no taxi is a serious failure.
- ⛔ Never invent a confirmation, an agreed time, a reference number, a driver's name, or
  the name of whoever is handling the request.
- Don't apologise for this and don't explain the internals to the guest — say, warmly and
  with confidence, what is happening now and when they'll hear back. That's what a human
  concierge does.

*Being proactive* — the warmth of a luxury hotel:
- End almost every reply with one concrete offer, not a hollow "anything else?".
  After the spa hours: "Shall I book you in — do you have a day and time in mind?"
  After a restaurant recommendation: "Would you like me to reserve a table?"
  After "I fly out tomorrow": "Shall I arrange your transfer? You'd want to leave around 05:30."
- Connect the dots: a guest who asked for a romantic restaurant at 20:00 — offer the taxi too.
- Only offer what actually exists in the data below. A warm offer of something that
  doesn't exist is a lie.

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
WiFi: Network ${cfg.wifi.name} | Password: ${cfg.wifi.password}
Check-in: ${cfg.checkin_time} | Check-out: ${cfg.checkout_time}
Early check-in: ${cfg.early_checkin ? "Available upon request" : "Not available"}
Late check-out: ${cfg.late_checkout ? "Available upon request" : "Not available"}

Hotel services:
${svcs}

▸ Parking
${park}

🗺️ THE AREA — your knowledge beyond the hotel (this is what makes you a concierge):
Every recommendation you give comes *from here alone*. Never recommend a place that
isn't on this list, even if you "know" it — a 5-star hotel stands behind every
recommendation it makes.
${area}

FAQ:
${faqs}

Guest:
Name: ${nameFor(session, "en") || "—"} | Room: ${session.roomNumber || "—"}

Internal commands (add at end of reply on a new line, guest never sees these):
[HK:<description>] — housekeeping request
[HK_URGENT:<description>] — urgent housekeeping
[MAINTENANCE:<description>] — technical issue
[RECEPTION:<description>] — escalate to human agent
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
// שמקבל את ההודעה הזו. כשיתחבר ספק אמיתי, `status` יחזור "confirmed"
// וכאן יתווסף עדכון לאורח. נכשל? הבקשה עדיין עוברת לאדם — בלי אסמכתא.
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

  const title = CONCIERGE_TITLE_HE[type] || CONCIERGE_TITLE_HE[REQUEST_TYPES.OTHER];
  return `${title}\n${details || "—"}` +
         (result?.reference ? `\n🔖 אסמכתא: ${result.reference}` : "");
}

// ── תגי פעולה — כולל תג *קטוע* ─────────────────────────
// `(\]|$)` הוא מה שמציל בקשה שנקטעה: כשה-AI נעצר באמצע כתיבת התג
// (max_tokens), אין "]" סוגר. הרגקס הישן, שדרש סוגר, פשוט לא התאים —
// ולכן קרו *שני* דברים רעים בבת אחת: הבקשה של האורח לא הועברה לאף
// אחד, והטקסט "[CONCIERGE:restaurant|" נשלח אליו כהודעה.
// עכשיו התג נתפס, הבקשה עוברת לאדם (מסומנת כחלקית), והטקסט מוסר.
const ACTION_TAG_RE = /\[(HK|HK_URGENT|MAINTENANCE|CONCIERGE|RECEPTION|EMERGENCY):([^\]]*?)(\]|$)/g;

async function runActions(raw, session, phone) {
  const re = new RegExp(ACTION_TAG_RE.source, "g");
  let m;
  while ((m = re.exec(raw)) !== null) {
    const [, type, payloadRaw, closer] = m;
    // תג בלי סוגר = התשובה נקטעה באמצע. הפרטים שנאספו חלקיים, ולכן
    // הבקשה עוברת לאדם בעדיפות גבוהה עם סימון מפורש — עדיף טלפון חוזר
    // לאורח מאשר בקשה שנעלמה בשקט.
    const truncated = closer !== "]";
    const payload   = truncated
      ? `${payloadRaw.trim()}\n⚠️ *הבקשה נקטעה באמצע ולא נקלטה במלואה — נא ליצור קשר עם האורח להשלמת הפרטים.*`
      : payloadRaw;
    if (truncated) {
      console.error(`🚨 תג ${type} נקטע באמצע (${phone.slice(-8)}) — הועבר לצוות כבקשה חלקית: ${payloadRaw.slice(0, 80)}`);
    }
    const dept = {
      HK: "housekeeping", HK_URGENT: "housekeeping",
      MAINTENANCE: "maintenance", CONCIERGE: "concierge", RECEPTION: "reception",
      EMERGENCY: "security",
    }[type];
    // בקשה קטועה = פרטים חסרים = חייבת עין אנושית, יהיה הסוג אשר יהיה.
    const priority = truncated || type.includes("URGENT") || type === "RECEPTION" || type === "EMERGENCY"
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
    const message = type === "CONCIERGE"
      ? await submitConciergeRequest(payload, session, phone)
      : payload;

    await notifyStaff({
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
    not_numeric: { he: "מספר ההזמנה מורכב מספרות בלבד.", en: "A reservation number contains digits only." },
    extra_text:  { he: "מספר ההזמנה מורכב מספרות בלבד.", en: "A reservation number contains digits only." },
    ambiguous:   { he: "קיבלתי כמה מספרים — אשמח למספר ההזמנה בלבד.", en: "I received several numbers — just the reservation number please." },
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

// ── מקור האמת לניסוח כל שלב ────────────────────────────
// prefix = הסבר על קלט קודם שלא התקבל (ריק בפעם הראשונה).
// נקרא גם בפתיחת שלב, גם אחרי קלט לא תקין, וגם כשאורח מחליף שפה
// באמצע — ואז השלב פשוט נשלח מחדש בשפה החדשה וממשיכים משם.
//
// ⚠️ כלל: ההודעה של כל שלב היא *משפט שלם ועצמאי*. אסור להשחיל לתוכה
// טקסט שהאורח הקליד — כך נולד "I want to check in, please enter your
// reservation number": השם הקודם הודבק כפנייה בתחילת המשפט הבא.
// פנייה בשם, אם יש, מגיעה כ-prefix בשורה נפרדת משלה.
async function promptStage(phone, stage, lang, { prefix = "", brief = false } = {}) {
  const he = lang === "he";
  const p  = prefix ? prefix + "\n\n" : "";

  if (stage === "waiting_name") {
    return wa(phone, p + (he
      ? `מה *שמך המלא*? (שם פרטי ושם משפחה)`
      : `What is your *full name*? (first and last)`), { lang });
  }

  if (stage === "waiting_reservation") {
    return wa(phone, p + (he
      ? `ומה *מספר ההזמנה* שלך? (ספרות בלבד)`
      : `And what is your *reservation number*? (digits only)`), { lang });
  }

  if (stage === "waiting_dates") {
    // ⚠️ הדוגמאות חייבות להיות מסומנות *במפורש* כדוגמאות. קודם הן הוצגו
    // כשורה מודגשת בלי הסבר, ואורחים הבינו ש-20/07/2026 הוא תאריך אמיתי
    // שהמלון כבר יודע עליו. תאריך לדוגמה שנקרא כתאריך אמיתי = שהייה שגויה.
    return wa(phone, p + (he
      ? `📅 מהם *תאריכי השהייה* שלך?\n\n` +
        `אפשר לשלוח תאריך הגעה ותאריך עזיבה, או תאריך הגעה ומספר לילות.\n\n` +
        `_כך נראה הפורמט — אלה דוגמאות בלבד, לא התאריכים שלך:_\n` +
        `_«11/11/2026 - 14/11/2026»_\n` +
        `_«11/11/2026, 3 לילות»_`
      : `📅 What are your *stay dates*?\n\n` +
        `You can send an arrival and a departure date, or an arrival date and the number of nights.\n\n` +
        `_This is what the format looks like — these are examples only, not your dates:_\n` +
        `_«11/11/2026 - 14/11/2026»_\n` +
        `_«11/11/2026, 3 nights»_`), { lang });
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
      }
    );
    return paymentUrl;
  } catch (e) {
    console.error("Deposit link creation failed:", e?.message || e);
    // הסלמה לאדם — האורח לא נשאר תקוע בלי טיפול.
    await notifyStaff({
      dept: "reception",
      roomNumber: s.roomNumber,
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
        ? `ברוך הבא! 🌟 נשמח לעשות עבורך צ׳ק אין דיגיטלי.`
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

  // ── מספר הזמנה — ספרות בלבד (Bug #3) ─────────────────
  if (stage === "waiting_reservation") {
    const v = validateReservationNumber(input);
    if (!v.ok) {
      await promptStage(phone, "waiting_reservation", lang, { prefix: hint("reservation", v.reason, lang) });
      return;
    }
    patchSession(phone, { checkinStage: "waiting_dates", pendingReservation: v.value });
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
    const v = validateStayDates(input);
    if (!v.ok) {
      await promptStage(phone, "waiting_dates", lang, { prefix: hint("dates", v.reason, lang) });
      return;
    }
    // לא ממשיכים ישר לשלב הבא — קודם מאשרים מול האורח מה הבנו.
    patchSession(phone, { checkinStage: "waiting_dates_confirm", pendingStay: v.value });
    await promptStage(phone, "waiting_dates_confirm", lang);
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
      patchSession(phone, { checkinStage: "waiting_dates", pendingStay: null });
      await promptStage(phone, "waiting_dates", lang, {
        prefix: lang === "he" ? "אין בעיה, בוא נתקן את זה." : "No problem, let's put that right.",
      });
      return;
    }

    if (isAffirmative(input)) {
      patchSession(phone, { checkinStage: "waiting_id", idAttempts: 0 });
      await promptStage(phone, "waiting_id", lang, {
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
  }
}

// ── אורח שסירב לתנאים ──────────────────────────────────
// לא לוחצים ולא מתווכחים. עוצרים את הצ'ק אין הדיגיטלי במקום, מסלימים
// לאדם בקבלה, ומשאירים את האורח בשלב — כדי שיוכל לאשר בהמשך אם ירצה.
async function handleTermsDeclined(phone, lang) {
  const s  = getSession(phone);
  const he = lang === "he";

  await notifyStaff({
    dept: "reception",
    roomNumber: s.roomNumber,
    guestName: s.guestName,
    message:
      `📜 *האורח לא אישר את תנאי השהייה* בצ'ק אין הדיגיטלי\n` +
      `👤 ${s.guestName || "—"}\n📱 ${phone}\n🔖 הזמנה: ${s.pendingReservation || "—"}\n` +
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
  let result;
  try {
    result = await idVerify.verifyDocument({
      reservationId: reservationNumber,
      phone,
      guestName,
      mediaUrl: media.url,
      contentType: m.value,
      documentType: "id_or_passport",
    });
  } catch (e) {
    console.error("ID verification crashed:", e?.message || e);
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
        dept: "reception",
        roomNumber: s.roomNumber,
        guestName,
        message:
          `🪪 *אימות זהות נכשל ${attempts} פעמים* בצ'ק אין הדיגיטלי\n` +
          `👤 אורח: ${guestName}\n📱 ${phone}\n🔖 הזמנה: ${reservationNumber || "—"}\n` +
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
    dept: "reception",
    roomNumber: s.roomNumber || null,
    guestName,
    message:
      (verified
        ? `🪪 *אימות זהות הושלם בצ'ק אין הדיגיטלי*\n`
        : `⚠️ *מסמך זיהוי התקבל — לא אומת אוטומטית, נדרשת בדיקה ידנית*\n`) +
      `👤 אורח: ${guestName}\n` +
      `🔖 הזמנה: ${reservationNumber || "—"}\n` +
      `🏠 חדר: ${s.roomNumber || "יוקצה בשלב הפיקדון"}\n` +
      `📄 סוג מסמך: ${result.documentType || "—"}\n` +
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
    await processCheckout(phone, session.reservationId || null, lang);
    patchSession(phone, { stage: "checked_out", checkinStage: null, checkoutStage: null });
  } catch (e) {
    console.error("Checkout error:", e.message);
    patchSession(phone, { checkoutStage: null });
    await wa(phone, lang === "he"
      ? "לא מצאתי הזמנה פעילה על שמך. אפשר לפנות לקבלה בשלוחה 0 ונשמח לסייע."
      : "I couldn't find an active reservation in your name. Reception is available at Ext. 0 and will be glad to help.", { lang });
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
    const r = await createMessageWithRetry({
      model: AI_MODEL,
      // ⚠️ היה 500 — וזו הייתה הסיבה לדליפת "[CONCIERGE:restaurant|":
      // תשובה עם רשימת המלצות + תג בסופה חרגה מהתקציב, ה-AI נקטע באמצע
      // כתיבת התג, והשארית נשלחה לאורח. התקציב הוכפל כדי שתשובה רגילה
      // *עם* תג תיכנס בנוחות. (הקטיעה עדיין מטופלת בכל השכבות למטה —
      // תקציב גדול יותר מקטין את הסיכוי, לא מחליף את ההגנה.)
      max_tokens: 1000,
      system: buildPrompt(sessions[phone] || session, lang),
      messages: (sessions[phone] || session).history,
    });
    // חילוץ עמיד של הטקסט — מתעלמים מבלוקים שאינם טקסט (thinking וכו').
    raw = (r.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();
    if (!raw) throw new Error("empty AI response");
    // תשובה שנקטעה בגלל התקציב — נרשמת ללוג כדי שנדע. הטיפול עצמו
    // (תג קטוע → פעולה + סינון) קורה בהמשך ואינו תלוי בבדיקה הזו.
    if (r.stop_reason === "max_tokens") {
      console.error(`⚠️ תשובת ה-AI נקטעה (max_tokens) עבור ${phone.slice(-8)} — סוף התשובה: …${raw.slice(-80)}`);
    }
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
}
