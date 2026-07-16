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
    happy_hour: "שעת האפי האוור",
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
    happy_hour: "Happy hour",
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

🚨 חירום — עדיפות עליונה, לפני כל דבר אחר:
אם האורח מתאר פציעה, מצב רפואי, אש, ריח/דליפת גז, או סכנה מיידית — זהה זאת מיד (לפי המשמעות, לא לפי מילה מסוימת):
1. הגב מיד ובקצרה. אל תשאל שאלות מיותרות ואל תנהל סמול-טוק.
2. מקרה רפואי / פציעה → הנחה את האורח להתקשר *מיד ל-101 (מד"א)*.
   אש / גז → הנחה אותו *מיד ל-102 (כבאות)*, לצאת מהחדר ולהתרחק למקום בטוח.
3. הבהר לאורח: *"צוות הביטחון של המלון קיבל התראה ומטפל בכך כעת."* אל תבטיח שאדם מסוים בדרך ואל תנקוב בשם.
4. ⛔ אסור לך בשום אופן לתת הנחיות רפואיות, עזרה ראשונה או טיפול מכל סוג — לרבות אם לזוז או לא לזוז, ללחוץ על פצע, לתת תרופה, להזיז פצוע וכד'. אמור במפורש שאינך מוסמך לתת הנחיות רפואיות, ושיש לפעול אך ורק לפי הנחיות מוקד 101.
5. הוסף תמיד בסוף תגובתך את התג [EMERGENCY:<סוג + תיאור קצר>] — כדי שצוות הביטחון יקבל התראה דחופה (וואטסאפ + מייל) ויטופל על ידי אדם.
לעולם אל תסתמך על עצמך בלבד באירוע חירום — חובה להסלים דרך התג [EMERGENCY:...].

כללים:
- אסור לטפל בעצמך בצ׳ק אין או צ׳ק אאוט — המערכת מטפלת בזה אוטומטית.
  אם האורח מבקש *צ'ק אין* (בכל ניסוח, סלנג או שגיאת כתיב — "צק אין", "צכ אין",
  "תק אין", "רוצה להיכנס", "הגעתי" וכו') — אל תענה תשובה רגילה, החזר *אך ורק* את
  התג [CHECKIN] וכלום מלבדו. אם האורח מבקש *צ'ק אאוט* (בכל ניסוח/שגיאה —
  "צק אאוט", "צכ אאוט", "רוצה לעזוב", "מסיים") — החזר *אך ורק* את התג [CHECKOUT].
  המערכת תשתלט משם.
- אל תמציא מידע שאינו כתוב כאן
- לבקשות מחוץ לתחום — הפנה לקבלה בשלוחה 0
- מחלקת התיקונים הטכניים נקראת תמיד *"אחזקה"* — לעולם אל תכתוב "תחזוקה"
- השתמש ב-*bold* לדגש, אימוג׳י במידה

💰 מחירים, שעות ופרטי שירות — חוק ברזל:
- כל המידע על השירותים נמצא למטה, מסודר לפי שירות ולפי שדה מתויג.
  ענה ממנו ישירות — זה בדיוק מה שהאורח שאל עליו. אל תפנה לקבלה על
  משהו שכתוב כאן.
- ⛔ לעולם אל תמציא, תעגל או תשער מחיר, שעה או מדיניות. צטט *בדיוק*
  את מה שכתוב. אם משהו לא כתוב כאן — אמור שתבדוק והפנה לקבלה, אל תנחש.
- כשיש כמה אפשרויות (למשל עיסוי 60 דקות מול 90 דקות) — הצג את
  האפשרויות הרלוונטיות עם *השם המלא, המשך והמחיר יחד*, כדי שהאורח
  יידע בדיוק מה הוא מזמין.

מידע המלון:
WiFi: רשת ${cfg.wifi.name} | סיסמה: ${cfg.wifi.password}
צ׳ק אין: ${cfg.checkin_time} | צ׳ק אאוט: ${cfg.checkout_time}
צ׳ק אין מוקדם: ${cfg.early_checkin ? "זמין בתיאום" : "לא זמין"}
צ׳ק אאוט מאוחר: ${cfg.late_checkout ? "זמין בתיאום" : "לא זמין"}

שירותי המלון:
${svcs}

▸ חניה
${park}

שאלות נפוצות:
${faqs}

פרטי האורח:
שם: ${nameFor(session, "he") || "—"} | חדר: ${session.roomNumber || "—"} | מצב: ${session.stage || "—"}

פקודות פנימיות (הוסף בסוף תגובתך בשורה נפרדת, האורח לא יראה אותן):
[HK:<תיאור>] — בקשת ניקיון
[HK_URGENT:<תיאור>] — ניקיון דחוף
[MAINTENANCE:<תיאור>] — תקלה טכנית
[CONCIERGE:<תיאור>] — הזמנת שולחן / מונית / בקשה מיוחדת
[RECEPTION:<תיאור>] — העברה לנציג אנושי
[EMERGENCY:<סוג + תיאור>] — חירום (פציעה / רפואי / אש / גז / סכנה) — הסלמה דחופה לביטחון`;
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

🚨 EMERGENCY — highest priority, before anything else:
If the guest describes an injury, a medical event, fire, a gas smell/leak, or immediate danger — recognize it instantly (by meaning, not by a specific keyword):
1. Respond immediately and briefly. Do not ask unnecessary questions or make small talk.
2. Medical / injury → instruct the guest to *call 101 (Magen David Adom) now*.
   Fire / gas → instruct them to *call 102 (Fire & Rescue) now*, leave the room and move to a safe place.
3. Tell the guest clearly: *"The hotel's security team has been alerted and is handling this now."* Do not promise that a specific person is on the way or name anyone.
4. ⛔ You must NEVER give medical, first-aid, or treatment instructions of any kind — including whether to move or stay still, applying pressure to a wound, giving medication, moving an injured person, etc. State explicitly that you are not qualified to give medical guidance, and that they must follow the instructions of the 101 dispatcher only.
5. Always append the tag [EMERGENCY:<type + short description>] at the end — so security is alerted urgently (WhatsApp + email) and a human handles it.
Never rely on yourself alone in an emergency — you MUST escalate via the [EMERGENCY:...] tag.

Rules:
- Never handle check-in or check-out yourself — the system does this automatically.
  If the guest asks to *check in* (in any phrasing, slang or typo — "checkin",
  "chek in", "i wanna check in", "arrived", "want to get my room") — do NOT reply
  normally; return *only* the tag [CHECKIN] and nothing else. If the guest asks to
  *check out* (any phrasing/typo — "checkout", "chekout", "i'm leaving", "wrap up
  my stay") — return *only* the tag [CHECKOUT]. The system takes over from there.
- Never invent information not listed here
- For out-of-scope requests, direct to reception at Ext. 0
- Use *bold* for emphasis, emojis sparingly

💰 Prices, hours and service details — hard rule:
- All service information is below, organised per service with labelled fields.
  Answer from it directly — it is exactly what the guest is asking about. Never
  refer a guest to reception for something that is written here.
- ⛔ Never invent, round or estimate a price, an opening hour or a policy. Quote
  *exactly* what is written. If something isn't here, say you'll check and refer
  to reception — do not guess.
- When several options exist (e.g. a 60-minute versus a 90-minute massage),
  present the relevant options with *the full name, duration and price together*,
  so the guest knows exactly what they are booking.

Hotel Information:
WiFi: Network ${cfg.wifi.name} | Password: ${cfg.wifi.password}
Check-in: ${cfg.checkin_time} | Check-out: ${cfg.checkout_time}
Early check-in: ${cfg.early_checkin ? "Available upon request" : "Not available"}
Late check-out: ${cfg.late_checkout ? "Available upon request" : "Not available"}

Hotel services:
${svcs}

▸ Parking
${park}

FAQ:
${faqs}

Guest:
Name: ${nameFor(session, "en") || "—"} | Room: ${session.roomNumber || "—"}

Internal commands (add at end of reply on a new line, guest never sees these):
[HK:<description>] — housekeeping request
[HK_URGENT:<description>] — urgent housekeeping
[MAINTENANCE:<description>] — technical issue
[CONCIERGE:<description>] — restaurant/taxi/special request
[RECEPTION:<description>] — escalate to human agent
[EMERGENCY:<type + description>] — emergency (injury/medical/fire/gas/danger) — urgent escalation to security`;
}

async function runActions(raw, session, phone) {
  const re = /\[(HK|HK_URGENT|MAINTENANCE|CONCIERGE|RECEPTION|EMERGENCY):([^\]]*)\]/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const [, type, payload] = m;
    const dept = {
      HK: "housekeeping", HK_URGENT: "housekeeping",
      MAINTENANCE: "maintenance", CONCIERGE: "concierge", RECEPTION: "reception",
      EMERGENCY: "security",
    }[type];
    const priority = type.includes("URGENT") || type === "RECEPTION" || type === "EMERGENCY"
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

    await notifyStaff({
      dept,
      roomNumber: session.roomNumber,
      guestName: session.guestName,
      message: payload,
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
    one_date:   { he: "קיבלתי תאריך אחד בלבד.", en: "I only caught one date." },
    bad_date:   { he: "אחד התאריכים אינו תאריך קיים.", en: "One of those dates doesn't exist on the calendar." },
    not_after:  { he: "תאריך העזיבה חייב להיות אחרי תאריך ההגעה.", en: "The departure date must be after the arrival date." },
    past:       { he: "תאריך ההגעה כבר עבר.", en: "That arrival date has already passed." },
    too_long:   { he: "שהייה ארוכה מ-60 לילות מתואמת ישירות מול הקבלה.", en: "Stays longer than 60 nights are arranged directly with reception." },
    unclear:    { he: "לא הצלחתי לקרוא את התאריכים.", en: "I couldn't read those dates." },
  },
  terms: {
    empty:        { he: "לא קיבלתי אישור.", en: "I didn't receive a confirmation." },
    not_explicit: { he: "כדי לאשר את התנאים אני זקוק לנוסח המלא.", en: "To accept the terms I need the exact wording." },
    unclear:      { he: "לא הצלחתי לזהות אישור.", en: "I couldn't recognise that as a confirmation." },
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
      ? `אנא הקלד/י את *שמך המלא* (שם פרטי ושם משפחה):`
      : `Please enter your *full name* (first and last):`), { lang });
  }

  if (stage === "waiting_reservation") {
    return wa(phone, p + (he
      ? `אנא הקלד/י את *מספר ההזמנה* שלך (ספרות בלבד):`
      : `Please enter your *reservation number* (digits only):`), { lang });
  }

  if (stage === "waiting_dates") {
    return wa(phone, p + (he
      ? `📅 מהם *תאריכי השהייה* שלך?\n\n` +
        `אפשר לכתוב תאריך הגעה ותאריך עזיבה:\n*20/07/2026 - 23/07/2026*\n\n` +
        `או תאריך הגעה ומספר לילות:\n*20/07/2026, 3 לילות*`
      : `📅 What are your *stay dates*?\n\n` +
        `You can send an arrival and a departure date:\n*20/07/2026 - 23/07/2026*\n\n` +
        `or an arrival date and the number of nights:\n*20/07/2026, 3 nights*`), { lang });
  }

  if (stage === "waiting_id") {
    return wa(phone, p + (he
      ? `🪪 כדי להשלים את הצ'ק אין נדרש *אימות זהות*.\n\nאנא צלם/י ושלח/י כאן *כתמונה* את תעודת הזהות או הדרכון שלך — כך שכל הפרטים יהיו ברורים וקריאים.`
      : `🪪 To complete your check-in we need to *verify your identity*.\n\nPlease take a photo of your *ID card or passport* and send it here *as an image* — with all the details clear and readable.`), { lang });
  }

  if (stage === "waiting_terms") {
    // brief — האורח כבר ראה את התנאים ורק הניסוח שלו לא היה מפורש.
    // אין טעם להציף אותו שוב בכל הסעיפים; מבקשים רק את נוסח האישור.
    const ask = he
      ? `לאישור, אנא כתוב/כתבי: *אני מאשר*`
      : `To accept, please type: *I confirm*`;
    if (brief) return wa(phone, p + ask, { lang });

    return wa(phone, p + (he
      ? `📜 *תנאי השהייה*\n\nלפני קבלת החדר, אנא קרא/י ואשר/י:\n\n${renderTerms("he")}\n\n${ask}`
      : `📜 *Stay Terms*\n\nBefore we hand over the room, please read and accept:\n\n${renderTerms("en")}\n\n${ask}`), { lang });
  }

  if (stage === "waiting_payment") {
    // מחדשים את שלב הפיקדון: אותו קישור, בשפה הנוכחית. אם מסיבה כלשהי
    // אין קישור (תקלה קודמת) — מנסים ליצור אותו מחדש, ולא מחזירים את
    // האורח לתחילת הצ'ק אין.
    const url = await ensureDepositLink(phone, lang);
    if (!url) {
      return wa(phone, p + (he
        ? `⏳ אנחנו משלימים את שלב הפיקדון עבורך — נציג מהקבלה יחזור אליך מיד.\n\nלכל שאלה: קבלה, שלוחה 0.`
        : `⏳ We're finalising the deposit step for you — a receptionist will get back to you shortly.\n\nAny questions: reception, Ext. 0.`), { lang });
    }
    // ההודעה כאן מדברת *רק* על הפיקדון. הסטטוס של אימות הזהות מגיע
    // כ-prefix מהקורא — כדי שלא נכריז "אומת" כשהאימות עדיין ידני.
    return wa(phone, p + (he
      ? `שלב אחרון — *פיקדון שהייה*.\n\n${depositExplainer("he")}\n\nלחץ/י על הקישור להקפאת הפיקדון:\n👉 ${url}`
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
    patchSession(phone, { checkinStage: "waiting_id", pendingStay: v.value, idAttempts: 0 });
    await promptStage(phone, "waiting_id", lang, {
      prefix: (lang === "he" ? `✅ *תאריכי השהייה נקלטו:*\n` : `✅ *Your stay dates are set:*\n`)
        + formatStayDates(v.value, lang),
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
    ? `אני מבין, ותודה שאמרת 🙏\n\nבלי אישור תנאי השהייה איני יכול להשלים את הצ'ק אין הדיגיטלי — ` +
      `אבל זו ממש לא בעיה: נציג/ה מהקבלה יצור/תיצור איתך קשר בהקדם, ויענה/תענה על כל שאלה לגבי התנאים.\n\n` +
      `אם תרצה/י להמשיך כאן בכל שלב, פשוט כתוב/כתבי *אני מאשר*.`
    : `I understand, and thank you for telling me 🙏\n\nWithout accepting the stay terms I can't complete the digital check-in — ` +
      `but that's absolutely fine: a receptionist will contact you shortly and answer any question you have about the terms.\n\n` +
      `If you'd like to continue here at any point, just type *I confirm*.`, { lang });
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
    ? "🔎 בודק/ת את המסמך, רגע אחד…"
    : "🔎 Checking your document, one moment…", { lang });

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
        ? `${why}\n\nאין בעיה — נציג/ה מהקבלה יצור/תיצור איתך קשר לסייע באימות. 🌟\nבינתיים אפשר לנסות לשלוח צילום נוסף, ברור ומלא.`
        : `${why}\n\nNo problem — a receptionist will contact you to help with the verification. 🌟\nIn the meantime, feel free to send another clear, full photo.`, { lang });
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
      ? "לא מצאתי הזמנה פעילה על שמך. אנא פנה לקבלה בשלוחה 0."
      : "No active reservation found. Please contact reception at Ext. 0.", { lang });
    return;
  }
  patchSession(phone, { checkoutStage: "awaiting_confirmation" });
  const bill = formatFolio(res, lang);
  const header = lang === "he"
    ? `🚪 *בקשת צ'ק אאוט*\n\nלהלן סיכום מלא של החיובים שלך:\n\n`
    : `🚪 *Check-out request*\n\nHere is a full summary of your charges:\n\n`;
  const footer = lang === "he"
    ? `\n\nלאישור הצ'ק אאוט (כולל חיוב מהפיקדון במידת הצורך), השב *כן*.\nלביטול, השב *לא*.`
    : `\n\nReply *yes* to confirm check-out (deposit will be charged if needed).\nReply *no* to cancel.`;
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
      ? "לא מצאתי הזמנה פעילה על שמך. אנא פנה לקבלה בשלוחה 0."
      : "No active reservation found. Please contact reception at Ext. 0.", { lang });
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
        ? "הצ'ק אאוט בוטל. אנחנו כאן אם תצטרך משהו נוסף 😊"
        : "Check-out cancelled. We're here if you need anything else 😊", { lang });
    } else if (isAffirmative(body)) {
      await confirmCheckout(phone, session, lang);
    } else {
      await wa(phone, lang === "he"
        ? "לאישור הצ'ק אאוט השב *כן*, או *לא* לביטול."
        : "Reply *yes* to confirm check-out, or *no* to cancel.", { lang });
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
      max_tokens: 500,
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
  } catch (e) {
    console.error("AI error (all retries failed):", e?.message || e);
    raw = lang === "he"
      ? "מצטערים, אירעה שגיאה זמנית. אנא נסה שוב בעוד רגע, או פנה לקבלה בשלוחה 0."
      : "Sorry, a temporary error occurred. Please try again in a moment, or contact reception at Ext. 0.";
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
  if (/\[CHECKIN\]/i.test(raw)) {
    if (session.stage === "checked_in") {
      await wa(phone, lang === "he"
        ? `אתה כבר רשום אצלנו — חדר *${session.roomNumber || "—"}* 🌟\nאיך אוכל לעזור?`
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
  if (/\[CHECKOUT\]/i.test(raw)) {
    if (session.stage === "checked_in" || getActiveReservation(phone)) {
      await startCheckout(phone, lang);
    } else {
      await wa(phone, lang === "he"
        ? "לא מצאתי הזמנה פעילה על שמך לצ'ק אאוט. אם כבר ביצעת צ'ק אין, פנה לקבלה בשלוחה 0."
        : "I couldn't find an active reservation to check out. If you've already checked in, please contact reception at Ext. 0.", { lang });
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
