// ════════════════════════════════════════════════════════
//  MESSAGES — נוסח ההודעות היזומות, ברמת קמפינסקי
//  ----------------------------------------------------------
//  ── שלושה כללים שכל הודעה כאן מצייתת להם ───────────────
//  1. **הכול מהקונפיג של אותו מלון.** אין שם מלון, כתובת, שעה או שירות
//     קשיחים בקוד. מלון בלי ספא לא יציע ספא; מלון בוטיק ידבר על קוד
//     דלת, מלון מלא על כרטיס בקבלה. זה מה שמאפשר להוסיף מלון בלי קוד.
//  2. **שדה שאין לו ערך פשוט אינו מופיע.** לעולם לא "בריכה: undefined"
//     ולא שורה ריקה. זו בדיוק התקלה שכבר תועדה בעמודי ה-HTML.
//  3. **שפת האורח.** הודעה יזומה נשלחת בשפה שבה האורח מדבר עם המלון;
//     אין לו הזדמנות "לתקן" אותנו לפני שהיא יוצאת.
//
//  ── למה הטון כאן שונה מהצ'אט ────────────────────────────
//  🔴 הודעה יזומה נכנסת לאורח בלי שביקש. לכן היא **קצרה, שימושית,
//     ונגמרת**. שיחה יכולה להתפתח; הודעה יזומה ארוכה נקראת כספאם, וזה
//     ההפך המדויק מרושם של מלון יוקרה. כל הודעה כאן: פנייה בשם, הדבר
//     שבשבילו נשלחה, ודלת פתוחה להמשך — ולא יותר.
//
//  ── מכירה ───────────────────────────────────────────────
//  ההצעה היחידה שמותרת היא **הצעה אחת, רלוונטית לשלב**, ורק אם המלון
//  באמת מציע את השירות. "יום לפני" הוא הרגע הרווחי ביותר בשהייה —
//  האורח מתרגש ועוד לא הגיע — ולכן שם ההצעה, ולא בכל הודעה.
// ════════════════════════════════════════════════════════
import { configFor, hotelModel } from "./config.js";
import { nameFor } from "./names.js";
import { peekSession } from "./state.js";
import { MESSAGE_KINDS } from "./schedule.js";
import { stayOf, formatStayShort, shekels } from "./checkin.js";

// ── עזרים ───────────────────────────────────────────────
/** שפת האורח: מה שנקבע בשיחה, אחרת עברית (מלון ישראלי). */
export function guestLang(res) {
  const s = peekSession(res.phone, res.hotelId);
  return s?.lang === "en" ? "en" : "he";
}

/**
 * מרכיב שורות. `null`/`undefined` נושרים, אבל `""` נשמר **בכוונה** כמפריד.
 *
 * 🔴 בגרסה הראשונה גם `""` סונן — ולכן ההודעה יצאה כגוש אחד צפוף בלי שום
 *    רווח, וזה בדיוק ההפך מרושם של מלון יוקרה. ואחרי ששדה נושר, המפריד
 *    שלידו יוצר רצף של שורות ריקות — לכן מכווצים 3+ ל-2.
 */
const lines = (...parts) => parts.flat()
  .filter(p => p !== null && p !== undefined && p !== false)
  .map(p => String(p))
  .join("\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

/** ערך מהקונפיג לפי שפה, עם נפילה לשפה השנייה. */
const byLang = (obj, lang) => obj?.[lang] ?? obj?.[lang === "he" ? "en" : "he"] ?? null;

/**
 * הופך ערך מהקונפיג לשורה אחת קריאה.
 *
 * 🔴 שדות בקונפיג אינם תמיד מחרוזות. `parking.he` הוא **אובייקט** עם
 *    type/price/hours/location/ev_charging/…, וכך גם `arrival.he`.
 *    שרשור ישיר הפיק `🅿️ [object Object]` — בדיוק מחלקת התקלות שכבר
 *    תועדה ("בריכה: undefined"). כאן זה נתפס בשורש.
 *
 * ולמה **שורה אחת** ולא הכול: הודעה יזומה חייבת להיות קצרה. שפיכת שמונה
 * שדות חניה על אורח שעוד לא הגיע נקראת כספאם. בוחרים את השדות שבאמת
 * עוזרים עכשיו, ומי שרוצה עוד — פשוט שואל.
 */
function oneLine(value, preferred = [], { max = 2 } = {}) {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(v => oneLine(v, preferred, { max })).filter(Boolean);
    return parts.length ? parts.slice(0, max).join(" · ") : null;
  }
  if (typeof value !== "object") return null;

  // קודם השדות המועדפים לפי הסדר, ואם אין — הראשונים שהם מחרוזת.
  const picked = [];
  for (const k of preferred) {
    const v = value[k];
    if (typeof v === "string" && v.trim()) picked.push(v.trim());
    if (picked.length >= max) break;
  }
  if (!picked.length) {
    for (const v of Object.values(value)) {
      if (typeof v === "string" && v.trim()) picked.push(v.trim());
      if (picked.length >= max) break;
    }
  }
  return picked.length ? picked.join(" · ") : null;
}

/** האם המלון באמת מציע את השירות (ולא רק שהמפתח קיים). */
function hasService(cfg, key) {
  const s = cfg.services?.[key];
  if (!s) return false;
  if (s.available === false) return false;
  return Boolean(s.he || s.en || s.available === true);
}

/** קישור ניווט — Waze אם יש קואורדינטות, אחרת חיפוש בגוגל מפות. */
function navLink(cfg) {
  const { lat, lng } = cfg.location || {};
  if (lat != null && lng != null) return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
  const addr = cfg.location?.address || cfg.location?.address_he;
  return addr ? `https://maps.google.com/?q=${encodeURIComponent(addr)}` : null;
}

const addressOf = (cfg, lang) =>
  (lang === "he" ? cfg.location?.address_he : cfg.location?.address) ||
  cfg.location?.address || cfg.location?.address_he || null;

const hotelName = (cfg, lang) =>
  (lang === "he" ? (cfg.name_he || cfg.name) : (cfg.name || cfg.name_he)) || "";

// ════════════════════════════════════════════════════════
//  1. אישור הזמנה — מיד אחרי שההזמנה נקלטה
// ════════════════════════════════════════════════════════
function bookingConfirmed(res, cfg, lang) {
  const he   = lang === "he";
  const name = nameFor(res, lang);
  const stay = formatStayShort(stayOf(res), lang);
  const g    = res.guestsCount ? (he ? `${res.guestsCount} אורחים` : `${res.guestsCount} guests`) : null;

  return he ? lines(
    `שלום ${name}, ההזמנה שלך ב*${hotelName(cfg, "he")}* אושרה ✨`,
    ``,
    stay ? `📅 ${stay}` : null,
    g ? `👥 ${g}` : null,
    ``,
    `פרטי הכניסה — כתובת, שעות ואופן הכניסה — יישלחו אליך יום לפני ההגעה.`,
    `בכל שאלה עד אז, אפשר פשוט להשיב כאן.`,
  ) : lines(
    `Hello ${name}, your reservation at *${hotelName(cfg, "en")}* is confirmed ✨`,
    ``,
    stay ? `📅 ${stay}` : null,
    g ? `👥 ${g}` : null,
    ``,
    `Your arrival details — address, timing and how to get in — will reach you the day before you arrive.`,
    `Until then, simply reply here with any question.`,
  );
}

// ════════════════════════════════════════════════════════
//  2. יום לפני — הוראות הגעה + ההצעה היחידה של השהייה
// ════════════════════════════════════════════════════════
function dayBefore(res, cfg, lang) {
  const he   = lang === "he";
  const name = nameFor(res, lang);
  const addr = addressOf(cfg, lang);
  const nav  = navLink(cfg);
  // שורה אחת שימושית לכל אחד — לא כל שדות הקונפיג. השדות המועדפים
  // נבחרו לפי מה שאורח שנוסע מחר באמת צריך לדעת.
  const arrival = oneLine(byLang(cfg.arrival, lang), ["by_car", "from_airport", "directions", "note"], { max: 1 });
  const parking = cfg.parking?.available === false
    ? (he ? "אין חניה במקום — נשמח להמליץ על חניון סמוך" : "No on-site parking — we'll gladly recommend a nearby car park")
    : oneLine(byLang(cfg.parking, lang), ["type", "price", "hours"], { max: 2 });

  // ההצעה: ספא אם יש, אחרת מסעדה, אחרת שום דבר. **אחת בלבד.**
  let offer = null;
  if (hasService(cfg, "spa")) {
    offer = he
      ? `נשמח לשמור טיפול בספא לשעה שאחרי ההגעה — די לומר, ואסדר זאת מראש.`
      : `If you'd like a spa treatment held for shortly after you arrive, I'd be glad to arrange it in advance.`;
  } else if (hasService(cfg, "restaurant")) {
    offer = he
      ? `נשמח לשריין שולחן במסעדה לערב ההגעה — די לומר.`
      : `If you'd like a table at the restaurant for your first evening, I'd be glad to reserve it in advance.`;
  }

  return he ? lines(
    `${name}, מחר אנחנו מצפים לך ב*${hotelName(cfg, "he")}* 🌟`,
    ``,
    addr ? `📍 ${addr}` : null,
    nav ? `🧭 ניווט: ${nav}` : null,
    cfg.checkin_time ? `🕒 הכניסה לחדרים מ-${cfg.checkin_time}` : null,
    parking ? `🅿️ ${parking}` : null,
    arrival ? `🚗 ${arrival}` : null,
    ``,
    offer,
    `אם ידועה לך שעת ההגעה המשוערת, אשמח לדעת — כדי שנהיה מוכנים.`,
  ) : lines(
    `${name}, we look forward to welcoming you to *${hotelName(cfg, "en")}* tomorrow 🌟`,
    ``,
    addr ? `📍 ${addr}` : null,
    nav ? `🧭 Navigation: ${nav}` : null,
    cfg.checkin_time ? `🕒 Rooms are ready from ${cfg.checkin_time}` : null,
    parking ? `🅿️ ${parking}` : null,
    arrival ? `🚗 ${arrival}` : null,
    ``,
    offer,
    `If you know your approximate arrival time, do let me know — so we can be ready for you.`,
  );
}

// ════════════════════════════════════════════════════════
//  3. בוקר ההגעה — איך נכנסים, לפי סוג המלון
// ════════════════════════════════════════════════════════
function arrivalDay(res, cfg, lang) {
  const he    = lang === "he";
  const name  = nameFor(res, lang);
  const model = hotelModel(res.hotelId);

  // 🔴 אופן הכניסה נגזר מסוג המלון, לא מהנחה. מלון בוטיק לא-מאויש
  //    שולח קוד; מלון מלא מכוון לקבלה. הבטחה שגויה כאן = אורח שעומד
  //    מול דלת נעולה.
  const entry = model.keyDelivery === "door_code"
    ? (res.doorCode
        ? (he ? `🔐 קוד הכניסה שלך: *${res.doorCode}*` : `🔐 Your entry code: *${res.doorCode}*`)
        : (he ? `🔐 קוד הכניסה יישלח אליך עם השלמת הצ'ק אין.` : `🔐 Your entry code will be sent once check-in is complete.`))
    : (he ? `🛎️ הכרטיס ימתין בקבלה — די להזכיר את השם.`
          : `🛎️ Your key card will be waiting at reception — simply give your name.`);

  const wifi = cfg.wifi?.name
    ? (he ? `📶 רשת ${cfg.wifi.name}${cfg.wifi.password ? ` · סיסמה ${cfg.wifi.password}` : ""}`
          : `📶 Network ${cfg.wifi.name}${cfg.wifi.password ? ` · Password ${cfg.wifi.password}` : ""}`)
    : null;

  return he ? lines(
    `בוקר טוב ${name} — היום אנחנו מארחים אותך ב*${hotelName(cfg, "he")}* ✨`,
    ``,
    res.roomNumber ? `🚪 חדר ${res.roomNumber}` : null,
    entry,
    cfg.checkin_time ? `🕒 מ-${cfg.checkin_time}` : null,
    wifi,
    ``,
    `אני כאן לכל דבר לאורך השהייה — די להשיב להודעה זו.`,
  ) : lines(
    `Good morning ${name} — we're delighted to host you at *${hotelName(cfg, "en")}* today ✨`,
    ``,
    res.roomNumber ? `🚪 Room ${res.roomNumber}` : null,
    entry,
    cfg.checkin_time ? `🕒 From ${cfg.checkin_time}` : null,
    wifi,
    ``,
    `I'm here for anything at all during your stay — simply reply to this message.`,
  );
}

// ════════════════════════════════════════════════════════
//  4. "הכל כרצונך?" — שעתיים אחרי הכניסה
// ════════════════════════════════════════════════════════
// ההודעה הזולה ביותר לבנייה והמשמעותית ביותר לתחושה. היא גם תופסת
// תקלה קטנה לפני שהיא הופכת לתלונה בביקורת.
function settledIn(res, cfg, lang) {
  const he   = lang === "he";
  const name = nameFor(res, lang);
  return he ? lines(
    `${name}, מקווה שהתמקמת בנוחות 🌿`,
    `הכול כרצונך בחדר?`,
    ``,
    `אם חסר משהו — אפילו הקטן ביותר — זה בדיוק הרגע לומר, ואטפל בזה מיד.`,
  ) : lines(
    `${name}, I hope you've settled in comfortably 🌿`,
    `Is everything to your liking in the room?`,
    ``,
    `If anything is missing — however small — this is exactly the moment to say so, and I'll see to it right away.`,
  );
}

// ════════════════════════════════════════════════════════
//  5. ערב לפני העזיבה
// ════════════════════════════════════════════════════════
function departureEve(res, cfg, lang) {
  const he   = lang === "he";
  const name = nameFor(res, lang);
  const late = cfg.late_checkout;
  const lateLine = late?.available === false ? null
    : late?.price_cents
      ? (he ? `🕓 יציאה מאוחרת אפשרית בתוספת ₪${shekels(late.price_cents)}${late.until ? ` עד ${late.until}` : ""} — בכפוף לזמינות.`
            : `🕓 A late check-out is available for ₪${shekels(late.price_cents)}${late.until ? ` until ${late.until}` : ""}, subject to availability.`)
      : (he ? `🕓 ליציאה מאוחרת — אשמח לבדוק זמינות.`
            : `🕓 If you'd like a late check-out, I'd be glad to check availability.`);

  const bf = hasService(cfg, "breakfast")
    ? (he ? `🍳 ארוחת הבוקר מוגשת גם מחר — אשמח לשמור לך מקום.`
          : `🍳 Breakfast is served tomorrow as well — I'd be glad to hold a table for you.`)
    : null;

  return he ? lines(
    `${name}, מחר יום העזיבה — וכבר מתגעגעים 🌟`,
    ``,
    cfg.checkout_time ? `🕛 צ'ק אאוט עד ${cfg.checkout_time}` : null,
    lateLine,
    bf,
    ``,
    `להשארת מזוודות אחרי הפינוי, או להזמנת מונית — אני כאן.`,
  ) : lines(
    `${name}, tomorrow is your departure — and we'll miss you already 🌟`,
    ``,
    cfg.checkout_time ? `🕛 Check-out by ${cfg.checkout_time}` : null,
    lateLine,
    bf,
    ``,
    `If you'd like to leave luggage after check-out, or have me arrange a taxi — I'm here.`,
  );
}

// ════════════════════════════════════════════════════════
//  6. אחרי העזיבה — תודה, חשבונית, ודלת פתוחה
// ════════════════════════════════════════════════════════
function postStay(res, cfg, lang) {
  const he      = lang === "he";
  const name    = nameFor(res, lang);
  const base    = (process.env.BASE_URL || "").replace(/\/$/, "");
  const invoice = res.invoice && base ? `${base}/invoice/${res.id}` : null;
  const review  = cfg.review_url || null;

  return he ? lines(
    `${name}, תודה שבחרת ב*${hotelName(cfg, "he")}* 🌟`,
    `היה לנו עונג לארח אותך.`,
    ``,
    invoice ? `🧾 החשבונית שלך: ${invoice}` : null,
    review ? `אם השהייה הייתה לרוחך, נשמח מאוד לשיתוף: ${review}` : null,
    ``,
    `אם נשכח משהו בחדר — די לכתוב לי, ואטפל בזה אישית.`,
    `נשמח לארח אותך שוב.`,
  ) : lines(
    `${name}, thank you for choosing *${hotelName(cfg, "en")}* 🌟`,
    `It was our pleasure to host you.`,
    ``,
    invoice ? `🧾 Your invoice: ${invoice}` : null,
    review ? `If your stay was to your liking, we'd be delighted if you shared it: ${review}` : null,
    ``,
    `If anything was left behind in the room, write to me and I'll see to it personally.`,
    `We'd be delighted to welcome you back.`,
  );
}

// ════════════════════════════════════════════════════════
//  נקודת הכניסה
// ════════════════════════════════════════════════════════
const BUILDERS = {
  [MESSAGE_KINDS.BOOKING_CONFIRMED]: bookingConfirmed,
  [MESSAGE_KINDS.DAY_BEFORE]:        dayBefore,
  [MESSAGE_KINDS.ARRIVAL_DAY]:       arrivalDay,
  [MESSAGE_KINDS.SETTLED_IN]:        settledIn,
  [MESSAGE_KINDS.DEPARTURE_EVE]:     departureEve,
  [MESSAGE_KINDS.POST_STAY]:         postStay,
};

/**
 * בונה את ההודעה היזומה. מחזיר `{ text, lang }` או `null` אם אין מה לשלוח.
 * לעולם לא זורק — הודעה שלא נבנתה פשוט לא נשלחת.
 */
export function composeScheduled(kind, res) {
  const build = BUILDERS[kind];
  if (!build || !res) return null;
  try {
    const cfg  = configFor(res.hotelId);
    const lang = guestLang(res);
    const text = build(res, cfg, lang);
    return text?.trim() ? { text: text.trim(), lang } : null;
  } catch (e) {
    console.error(`בניית הודעה יזומה (${kind}) נכשלה:`, e?.message || e);
    return null;
  }
}

export const __test = { hasService, navLink, lines, byLang, oneLine };
