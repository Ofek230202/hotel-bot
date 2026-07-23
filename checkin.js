// ════════════════════════════════════════════════════════
//  CHECKIN v4 — Full billing, deposit capture, checkout
// ════════════════════════════════════════════════════════
import { v4 as uuidv4 } from "uuid";
import { wa, notifyStaff } from "./bot.js";
import { logAlert, stats, patchSession, peekSession } from "./state.js";
import { payments, PAYMENT_CURRENCY } from "./payments/index.js";
import { nameFor } from "./names.js";
import { configFor } from "./config.js";
import { db, DEFAULT_HOTEL_ID } from "./db.js";
import { currentHotelId } from "./tenant.js";

// הקונפיג של המלון שאליו שייכת ההזמנה. הזמנה נושאת hotelId משלה, ולכן
// גם פונקציות שרצות *מחוץ* להקשר ה-tenant (למשל דף התשלום ב-checkin-routes)
// יבנו את ההודעה עם הקונפיג הנכון של אותו מלון. נופל להקשר הנוכחי אם אין.
function cfgOf(res) {
  return configFor(res?.hotelId || currentHotelId());
}

// נקרא תמיד בזמן-קריאה (lazy), אחרי ש-dotenv.config() כבר רץ.
// אם נשמר כקבוע בראש הקובץ הוא נתפס כ-undefined בגלל סדר טעינת המודולים
// (checkin.js מיובא לפני ש-dotenv.config() רץ ב-bot.js/server.js) — מה שגרם
// לקישורי תשלום מסוג "undefined/checkin/success...".
function baseUrl() {
  return process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
}

export const reservations = {};

// ── persistence (שלב 2) — write-through ל-DB דרך db.js ─
// כל הזמנה נשמרת כ-JSON מלא (כולל ה-folio) בעמודת data; id/phone/room/
// stage/checkout_date נשלפים לעמודות לצורך סינון. cache חי בזיכרון
// (reservations) מגובה ל-DB בכל מוטציה, ומהודרר מה-DB בעליית התהליך —
// כך כל הקוד שקורא reservations[id] ממשיך לעבוד, אך המידע שורד ריסטארט.
const HOTEL = DEFAULT_HOTEL_ID;
const resUpsert = db.prepare(`
  INSERT INTO reservations (id, hotel_id, phone, room_number, stage, checkout_date, data)
  VALUES (@id, @hotel_id, @phone, @room_number, @stage, @checkout_date, @data)
  ON CONFLICT(id) DO UPDATE SET
    phone         = excluded.phone,
    room_number   = excluded.room_number,
    stage         = excluded.stage,
    checkout_date = excluded.checkout_date,
    data          = excluded.data
`);

function persist(res) {
  resUpsert.run({
    id:            res.id,
    hotel_id:      res.hotelId || HOTEL,
    phone:         res.phone ?? null,
    room_number:   res.roomNumber ?? null,
    stage:         res.stage ?? null,
    checkout_date: res.checkoutDate ?? null,
    data:          JSON.stringify(res),
  });
}

// הידרציה: טעינת ההזמנות מה-DB ל-cache בעליית התהליך (כל המלונות).
// הזמנות ממופתחות לפי id (uuid גלובלי), אבל כל אחת נושאת hotelId משלה
// כדי שחיפושים לפי טלפון/חדר יסננו לפי המלון הנכון.
for (const row of db.prepare(`SELECT hotel_id, data FROM reservations`).all()) {
  try {
    const r = JSON.parse(row.data);
    if (r && r.id) {
      if (!r.hotelId) r.hotelId = row.hotel_id || HOTEL;
      reservations[r.id] = r;
    }
  } catch { /* שורה פגומה — מדלגים */ }
}

// ── סכומים — מקור אמת אחד ─────────────────────────────
// סכום הפיקדון מגיע מ-hotelConfig (per-hotel, מוכן למולטי-טננט) ולא
// מקבוע מפוזר. `shekels` מעצב אגורות → "₪500" בכל ההודעות.
export function depositAmount(hotelId = currentHotelId()) {
  return configFor(hotelId).deposit_amount ?? 50000;
}
export function shekels(agorot) {
  const n = (agorot || 0) / 100;
  return `₪${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

// ── תצוגת תאריכי שהייה — מקור אמת אחד ─────────────────
// stay = { checkIn: "YYYY-MM-DD", checkOut: "YYYY-MM-DD", nights }.
// מוצג לפי שפת השיחה: עברית → "יום שני, 20 ביולי 2026"; אנגלית →
// "Monday, 20 July 2026". חצות UTC כדי שהתאריך לא יזוז באזור זמן.
export function formatStayDates(stay, lang = "he") {
  if (!stay?.checkIn || !stay?.checkOut) return "";
  const he  = lang === "he";
  const fmt = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString(he ? "he-IL" : "en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
  const n = stay.nights;
  return he
    ? `📅 *הגעה:* ${fmt(stay.checkIn)}\n📅 *עזיבה:* ${fmt(stay.checkOut)}\n🌙 *${n} ${n === 1 ? "לילה" : "לילות"}*`
    : `📅 *Arrival:* ${fmt(stay.checkIn)}\n📅 *Departure:* ${fmt(stay.checkOut)}\n🌙 *${n} ${n === 1 ? "night" : "nights"}*`;
}

// גרסה קצרה לשורה אחת — לחשבון, לעמוד האישור ולהתראות הצוות.
export function formatStayShort(stay, lang = "he") {
  if (!stay?.checkIn || !stay?.checkOut) return "";
  const he  = lang === "he";
  const fmt = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC" }); // DD/MM/YYYY
  const n = stay.nights;
  return he
    ? `${fmt(stay.checkIn)} – ${fmt(stay.checkOut)} · ${n} ${n === 1 ? "לילה" : "לילות"}`
    : `${fmt(stay.checkIn)} – ${fmt(stay.checkOut)} · ${n} ${n === 1 ? "night" : "nights"}`;
}

// ── תצוגת פרטי הצ'ק אין הנוספים (אורחים / ETA / רכב / בקשות) ──
// מקור אמת אחד, בשתי השפות. מחזיר בלוק שורות מתויגות או "" אם אין פרט.
// משמש בהודעת האישור לאורח (בשפתו) ובהתראה לצוות (תמיד עברית).
export function formatStayExtras(res, lang = "he") {
  if (!res) return "";
  const he = lang === "he";
  const lines = [];
  if (res.guestsCount)     lines.push(he ? `👥 אורחים: ${res.guestsCount}`           : `👥 Guests: ${res.guestsCount}`);
  if (res.eta)             lines.push(he ? `🕐 הגעה משוערת: ${res.eta}`               : `🕐 Estimated arrival: ${res.eta}`);
  if (res.vehiclePlate)    lines.push(he ? `🚗 רכב (לחניה): ${res.vehiclePlate}`       : `🚗 Vehicle (for parking): ${res.vehiclePlate}`);
  if (res.specialRequests) lines.push(he ? `📝 בקשה מיוחדת: ${res.specialRequests}`    : `📝 Special request: ${res.specialRequests}`);
  return lines.join("\n");
}

// שולף את פרטי השהייה מתוך הזמנה (הם שמורים שטוחים על ההזמנה).
export function stayOf(res) {
  return res?.stayCheckIn && res?.stayCheckOut
    ? { checkIn: res.stayCheckIn, checkOut: res.stayCheckOut, nights: res.nights }
    : null;
}

// ── תאריך+שעה בשעון ישראל ─────────────────────────────
// בונה Date עבור "YYYY-MM-DD" + "HH:MM" *בשעון ישראל*, כולל שעון קיץ
// (ההיסט נשלף בפועל מהתאריך עצמו, לא מקובע ל-+03:00). משמש כדי לקבוע
// את רגע הצ'ק אאוט — שממנו מנוע ה-no-show מזהה אורח שלא סגר את השהייה.
function israelDateTime(ymd, hhmm = "12:00") {
  const guess  = new Date(`${ymd}T${hhmm}:00Z`);
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem", timeZoneName: "longOffset",
  }).formatToParts(guess).find(p => p.type === "timeZoneName")?.value || "GMT+03:00";
  const m    = offset.match(/GMT([+-])(\d{2}):(\d{2})/);
  const mins = m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : 180;
  return new Date(guess.getTime() - mins * 60_000);
}

// ── ניסוח הפיקדון — מקור אמת אחד ─────────────────────
// כל ההודעות (צ'ק אין, צ'ק אאוט, עמוד התשלום, דף האישור) שואבות מכאן
// כדי שהניסוח יהיה זהה בכל מקום ולא ייווצר drift. ברור ופשוט לאורח.
export function depositExplainer(lang = "he") {
  const amt = shekels(depositAmount());
  // ⚠️ "היתרה תשוחרר" בלי סייג יוצר ציפייה שגויה: כשהחיובים גדולים
  //    מהפיקדון אין שום יתרה, ולהפך — מחייבים את ההפרש. לכן כל שורה
  //    מנוסחת כך שהיא נכונה גם כשהיתרה היא אפס.
  return lang === "he"
    ? `🔒 הפיקדון (${amt}) מוקפא בכרטיסך להבטחת השהייה — זו הקפאה בלבד, לא חיוב.\n` +
      "בצ'ק אאוט:\n" +
      "- אם אין חיובים — לא מבוצע חיוב, וההקפאה משוחררת על ידי חברת האשראי תוך 3-5 ימי עסקים.\n" +
      "- אם יש חיובים — הם ינוכו מהפיקדון, ויתרת הפיקדון (אם נותרה) משוחררת באותו אופן.\n" +
      "- אם החיובים גדולים מהפיקדון — הפיקדון ינוכה במלואו, לא תיוותר יתרה, וההפרש יחויב בנפרד מאותו כרטיס."
    : `🔒 The ${amt} deposit is held on your card to secure your stay — a hold only, not a charge.\n` +
      "At check-out:\n" +
      "- If there are no charges — nothing is charged, and the hold is released by your card issuer within 3–5 business days.\n" +
      "- If there are charges — they are deducted from the deposit, and any remaining balance is released the same way.\n" +
      "- If charges exceed the deposit — the deposit is deducted in full, no balance remains, and the difference is charged separately to the same card.";
}

export const FOLIO_CATEGORIES = {
  MINIBAR:      { he: "מיני בר",       en: "Mini Bar",     icon: "🍾" },
  RESTAURANT:   { he: "מסעדה",         en: "Restaurant",   icon: "🍽️" },
  ROOM_SERVICE: { he: "שירות לחדר",    en: "Room Service", icon: "🛎️" },
  SPA:          { he: "ספא",           en: "Spa",          icon: "🧖" },
  PARKING:      { he: "חניה",          en: "Parking",      icon: "🅿️" },
  LAUNDRY:      { he: "כביסה",         en: "Laundry",      icon: "👕" },
  OTHER:        { he: "שונות",         en: "Other",        icon: "📋" },
};

// ── Start check-in ────────────────────────────────────
// nameInput יכול להיות מחרוזת (שם בודד, תאימות לאחור) או אובייקט עם שתי
// הצורות { guestName, guestNameHe, guestNameEn } — כדי שלא ייווצר ערבוב
// שפות בשם האורח (Bug 2). שומרים תמיד את שתי הצורות על ההזמנה.
// opts.stay  — { checkIn: "YYYY-MM-DD", checkOut: "YYYY-MM-DD", nights } כפי
//              שהאורח מסר ואומת (validateStayDates). מחליף את הקבוע
//              NIGHTS=3 שהיה כאן וקבע 3 לילות לכל אורח באשר הוא.
// opts.terms — { version, acceptedAt } — *איזה* נוסח תנאים האורח אישר
//              ומתי. נשמר על ההזמנה כראיה, ולא רק כדגל בוליאני.
export async function startCheckin(phone, nameInput, reservationId, opts = {}) {
  const obj         = nameInput && typeof nameInput === "object" ? nameInput : null;
  const guestNameHe = obj ? (obj.guestNameHe || obj.guestName || "") : (nameInput || "");
  const guestNameEn = obj ? (obj.guestNameEn || obj.guestName || "") : (nameInput || "");
  const guestName   = obj ? (obj.guestName || guestNameHe) : (nameInput || "");
  const id      = uuidv4();
  const hotelId = currentHotelId();          // ← שיוך ההזמנה למלון (multi-tenant)
  const DEPOSIT = depositAmount(hotelId);
  const stay    = opts.stay || null;
  const details = opts.details || {};
  // מספר הלילות מגיע מהאורח. אם משום מה אין (זרימה ישנה/חריגה) — לילה
  // אחד, שמרני: עדיף כרטיס חדר קצר מדי שמאריכים בקבלה, מאשר חדר שנשאר
  // פתוח ימים מיותרים.
  const NIGHTS  = stay?.nights || 1;

  reservations[id] = {
    id, phone, hotelId, guestName, guestNameHe, guestNameEn, reservationId,
    roomNumber: null,
    stage: "pending_payment",
    deposit: DEPOSIT,
    nights: NIGHTS,
    stayCheckIn:  stay?.checkIn  || null,
    stayCheckOut: stay?.checkOut || null,
    termsVersion:    opts.terms?.version    || null,
    termsAcceptedAt: opts.terms?.acceptedAt || null,
    // ── פרטי צ'ק אין נוספים (אופציונליים) — נאספו בשלב waiting_details ──
    guestsCount:     details.guests   ?? null,   // מספר אורחים
    eta:             details.eta       || null,  // שעת הגעה משוערת
    vehiclePlate:    details.vehicle   || null,  // מספר רכב (לחניה)
    specialRequests: details.requests  || null,  // בקשות מיוחדות
    feedback:        null,                        // משוב האורח (נאסף בצ'ק אאוט)
    checkoutDate: null, // רגע הצ'ק אאוט בפועל — נקבע ב-completeCheckin
    currency: PAYMENT_CURRENCY,
    folio: [],
    paymentId: null,
    paymentUrl: null,
    createdAt: new Date().toISOString(),
    paidAt: null, checkedInAt: null, checkedOutAt: null,
    refunded: false, captured: false, capturedAmount: 0,
    balanceAmount: 0, balancePaymentUrl: null,
    // חיוב ההפרש כשהחיובים עולים על הפיקדון (מקרה C):
    overageCharged: false,      // האם ההפרש מעל הפיקדון חויב
    overageAmount: 0,           // סכום ההפרש שחויב (באגורות)
    overageChargedTo: null,     // "deposit_card" (ברירת מחדל) | "alternate_card"
    altCardUrl: null,           // קישור לתשלום ההפרש בכרטיס אחר
    noShow: false,              // חויב אוטומטית עקב אי-ביצוע צ'ק אאוט (בריחה)
    confirmationSent: false, // הגנת idempotency — אישור צ'ק אין יישלח פעם אחת בלבד
  };

  const auth = await payments.authorizeDeposit({
    reservationId: id,
    amount: DEPOSIT,
    currency: PAYMENT_CURRENCY,
    guestName,
    phone,
    description: `פיקדון שהייה — ${configFor(hotelId).name}`,
    // עמוד התשלום (אצל ספק אמיתי — דף הסליקה המתארח שלו; אצל ה-Mock —
    // דף תשלום הדמו הפנימי שלנו). לשם נשלח האורח כדי "לשלם".
    paymentPageUrl: `${baseUrl()}/checkin/pay?rid=${id}`,
    successUrl: `${baseUrl()}/checkin/success?rid=${id}`,
    cancelUrl:  `${baseUrl()}/checkin/cancel?rid=${id}`,
  });

  reservations[id].paymentId  = auth.paymentId;
  reservations[id].paymentUrl = auth.redirectUrl;
  persist(reservations[id]);
  return { reservationId: id, paymentUrl: auth.redirectUrl };
}

// ── Complete check-in ─────────────────────────────────
export async function completeCheckin(reservationId, roomNumber) {
  const res = reservations[reservationId];
  if (!res) throw new Error("Reservation not found");

  // ── הגנת idempotency (Bug #2) ─────────────────────────
  // דף האישור (GET /checkin/success) עלול להיטען כמה פעמים — preview
  // crawlers של וואטסאפ, prefetch, רענון של האורח — וכל טעינה קראה
  // ל-completeCheckin ושלחה שוב הודעת "צ'ק אין אושר" (נצפו 4 כפילויות).
  // אם כבר נשלח אישור להזמנה הזו — לא שולחים שוב, פשוט מחזירים אותה.
  if (res.confirmationSent) return res;
  res.confirmationSent = true; // מסומן סינכרונית, לפני ה-await, כדי שטעינות
                               // מקבילות לא יעקפו את ההגנה.

  // הפיקדון כבר אושר בשלב startCheckin (paymentId שמור) — אין צורך
  // לשלוף שום דבר מהספק כאן.
  res.roomNumber  = roomNumber || "304";
  res.stage       = "checked_in";
  res.checkedInAt = new Date().toISOString();
  res.paidAt      = new Date().toISOString();
  stats.checkIns++;

  // ── רגע הצ'ק אאוט ────────────────────────────────────
  // מקור ראשון: תאריך העזיבה שהאורח מסר, בשעת הצ'ק אאוט של המלון.
  // גיבוי (הזמנה ישנה בלי תאריכים): תאריך הכניסה + מספר הלילות.
  // משמש גם לתיקוף כרטיס החדר וגם לזיהוי no-show.
  const nights = res.nights || 1;
  let coDate;
  if (res.stayCheckOut) {
    coDate = israelDateTime(res.stayCheckOut, cfgOf(res).checkout_time || "12:00");
  } else {
    coDate = new Date(res.checkedInAt);
    coDate.setDate(coDate.getDate() + nights);
  }
  res.checkoutDate  = coDate.toISOString();
  persist(res); // שמירת מצב הצ'ק אין (checked_in + confirmationSent) לפני שליחת ההודעות
  const checkoutStr = coDate.toLocaleDateString("he-IL", {
    weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Jerusalem",
  });

  // ── קישור session ↔ reservation (Bug #3) ─────────────
  // מסמן את ה-session כ-checked_in ושומר reservationId + roomNumber,
  // כדי שזרימת הצ'ק אאוט תהיה נגישה דרך הצ'אט.
  patchSession(res.phone, {
    stage:         "checked_in",
    reservationId: res.id,
    roomNumber:    res.roomNumber,
    guestName:     res.guestName,
    guestNameHe:   res.guestNameHe,
    guestNameEn:   res.guestNameEn,
    checkinStage:  null,
    checkInAt:     res.checkedInAt,
  }, res.hotelId);

  // ── הודעת האישור לאורח — בשפת השיחה שלו, מהתחלה ועד הסוף ──
  // כל הפרטים נשאבים מ-hotelConfig לפי השפה (ולא ממחרוזות קשיחות),
  // כדי שאורח אנגלי לא יקבל "מסעדת הגן, קומה 1" באמצע משפט באנגלית.
  const lang = peekSession(res.phone, res.hotelId)?.lang === "en" ? "en" : "he";
  const he   = lang === "he";
  const name = nameFor(res, lang); // שם בשפת השיחה — בלי ערבוב (Bug 2)
  const cfg  = cfgOf(res);
  const svc  = (key) => cfg.services[key]?.[lang] || cfg.services[key]?.en || {};
  const bf   = svc("breakfast"), pool = svc("pool"), rs = svc("room_service");
  const stayLines = formatStayDates(stayOf(res), lang);
  const extras    = formatStayExtras(res, lang);

  await wa(res.phone, he
    ? `✅ *צ'ק אין אושר!*\n\n` +
      `ברוכים הבאים, *${name}*! 🌟\n\n` +
      `🚪 *חדר:* ${res.roomNumber}\n` +
      (stayLines ? `${stayLines}\n` : "") +
      (extras ? `${extras}\n` : "") +
      `🔑 *כרטיס החדר מחכה לך מוכן בקבלה* — אפשר לאסוף אותו בכל שעה, והוא מתוקף לכל משך השהייה\n\n` +
      `${depositExplainer("he")}\n\n` +
      `📶 WiFi: ${cfg.wifi.name} | ${cfg.wifi.password}\n` +
      `🍳 ארוחת בוקר: ${bf.hours} | ${bf.location}\n` +
      `🏊 בריכה: ${pool.hours} | ${pool.location}\n` +
      `🛎️ שירות לחדר: ${rs.hours} | ${rs.dial}\n\n` +
      `לכל בקשה — אני כאן! 😊`
    : `✅ *Check-in confirmed!*\n\n` +
      `Welcome, *${name}*! 🌟\n\n` +
      `🚪 *Room:* ${res.roomNumber}\n` +
      (stayLines ? `${stayLines}\n` : "") +
      (extras ? `${extras}\n` : "") +
      `🔑 *Your room key is ready and waiting at reception* — please pick it up; it's valid for your entire stay\n\n` +
      `${depositExplainer("en")}\n\n` +
      `📶 WiFi: ${cfg.wifi.name} | ${cfg.wifi.password}\n` +
      `🍳 Breakfast: ${bf.hours} | ${bf.location}\n` +
      `🏊 Pool: ${pool.hours} | ${pool.location}\n` +
      `🛎️ Room service: ${rs.hours} | ${rs.dial}\n\n` +
      `I'm here for anything you need! 😊`,
    { lang }
  );

  // ── התראה לקבלה: להכין כרטיס לחדר מוכן לאיסוף ──────────
  // נשלחת גם בוואטסאפ וגם במייל (דרך notifyStaff). כוללת את כל הפרטים
  // הדרושים להכנת הכרטיס מראש, ומדגישה לתקף את הכרטיס לכל משך השהייה.
  // תמיד בעברית — צוות המלון עובד בעברית, ללא קשר לשפת האורח.
  const stayShort = formatStayShort(stayOf(res), "he");
  await notifyStaff({
    phone: res.phone,
    hotelId: res.hotelId,
    dept: "reception",
    roomNumber: res.roomNumber,
    guestName: res.guestName,
    message:
      `🔑 *להכין כרטיס לחדר מוכן לאיסוף בקבלה*\n` +
      `✅ צ'ק אין דיגיטלי הושלם | פיקדון ${shekels(res.deposit)} מאושר\n` +
      (stayShort ? `📆 שהייה: ${stayShort}\n` : `🌙 לילות: ${nights}\n`) +
      `📅 צ'ק אאוט: ${checkoutStr}\n` +
      (formatStayExtras(res, "he") ? `${formatStayExtras(res, "he")}\n` : "") +
      (res.termsAcceptedAt ? `📝 תנאי שהייה: אושרו ע"י האורח (נוסח ${res.termsVersion || "—"})\n` : "") +
      `🗣️ שפת האורח: ${he ? "עברית" : "אנגלית"}\n` +
      `⏳ *תקף את הכרטיס לכל משך השהייה* (עד ${checkoutStr}) — לא ליום אחד`,
    priority: "normal",
  });

  return res;
}

// ── Add item to folio ─────────────────────────────────
export function addFolioItem(reservationId, category, description, amountCents) {
  const res = reservations[reservationId];
  if (!res) throw new Error("Reservation not found");
  res.folio.push({ id: uuidv4(), category, description, amount: amountCents, addedAt: new Date().toISOString() });
  persist(res);
  return res;
}

export function getFolioTotal(reservationId) {
  const res = reservations[reservationId];
  if (!res) return 0;
  return res.folio.reduce((sum, item) => sum + item.amount, 0);
}

// ── Format bill for WhatsApp ──────────────────────────
// opts.settled — האם החשבון כבר נסלק (צ'ק אאוט בוצע). משנה *רק* את שורות
// הסיכום התחתונות מזמן עתיד ("ינוכה", "יחויב") לזמן עבר ("נוכה", "חויב"),
// ומוסיף את מועד שחרור היתרה — כדי שהחשבון בהודעת הצ'ק אאוט יהיה מקור
// אמת אחד ומלא, בלי שההודעה תחזור על אותן שורות פעם שנייה (drift/כפילות).
// ברירת מחדל (preview): זמן עתיד, לתצוגה מקדימה לפני האישור.
export function formatFolio(res, lang = "he", { settled = false } = {}) {
  const total   = getFolioTotal(res.id);
  const deposit = res.deposit;
  const he      = lang === "he";
  const RULE    = "━━━━━━━━━━━━━━━━━━━━";

  // כותרת החשבון — כוללת את תאריכי השהייה כפי שהאורח מסר בצ'ק אין,
  // כדי שיוכל לוודא שחויב על התקופה הנכונה.
  const stayShort = formatStayShort(stayOf(res), lang);
  const header = he
    ? `📋 *סיכום חשבון — חדר ${res.roomNumber}*\n` + (stayShort ? `📆 ${stayShort}\n` : "")
    : `📋 *Bill — Room ${res.roomNumber}*\n` + (stayShort ? `📆 ${stayShort}\n` : "");

  if (res.folio.length === 0) {
    return he
      ? header +
        `${RULE}\n✅ אין חיובים\n${RULE}\n` +
        `💚 ${settled ? "לא בוצע חיוב" : "אין מה לנכות — לא יבוצע חיוב"} — ההקפאה על הפיקדון (${shekels(deposit)}) תשוחרר על ידי חברת האשראי תוך 3-5 ימי עסקים`
      : header +
        `${RULE}\n✅ No charges\n${RULE}\n` +
        `💚 ${settled ? "Nothing was charged" : "Nothing to deduct — no charge will be made"} — the ${shekels(deposit)} hold will be released by your card issuer within 3–5 business days`;
  }

  // ── חשבונית מפורטת ומקובצת לפי קטגוריה ────────────────
  // כל קטגוריה (מיני בר, מסעדה, ספא…) מוצגת בנפרד עם הפריטים שלה, ואם
  // יש בה יותר מפריט אחד — גם סכום ביניים. כך "מיני בר בנפרד" מתקבל
  // מאליו, והאורח רואה חשבון ברור במקום רשימה שטוחה.
  const order = Object.keys(FOLIO_CATEGORIES);
  const groups = new Map();
  for (const item of res.folio) {
    const key = FOLIO_CATEGORIES[item.category] ? item.category : "OTHER";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const money = (a) => `₪${(a / 100).toFixed(2)}`;
  const lines = [...groups.keys()]
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((key) => {
      const cat   = FOLIO_CATEGORIES[key];
      const items = groups.get(key);
      const subtotal = items.reduce((s, it) => s + it.amount, 0);
      const head  = `${cat.icon} *${he ? cat.he : cat.en}*`;
      const rows  = items.map(it => `  • ${it.description || (he ? cat.he : cat.en)} — ${money(it.amount)}`).join("\n");
      // סכום ביניים רק כשיש יותר מפריט אחד בקטגוריה (אחרת מיותר).
      const sub   = items.length > 1
        ? `\n  _${he ? "סה\"כ" : "Subtotal"} ${he ? cat.he : cat.en}: ${money(subtotal)}_`
        : "";
      return `${head}\n${rows}${sub}`;
    })
    .join("\n\n");

  const totalStr   = (total/100).toFixed(2);
  const depositStr = (deposit/100).toFixed(2);
  const totals = he
    ? `סה"כ חיובים:  ₪${totalStr}\nפיקדון:       ₪${depositStr}`
    : `Total charges:  ₪${totalStr}\nDeposit:        ₪${depositStr}`;

  let outcome;
  if (total <= deposit) {
    const refund = ((deposit - total)/100).toFixed(2);
    outcome = he
      ? (settled
          ? `💳 *נוכה מהפיקדון: ₪${totalStr}*\n💚 *יתרת הפיקדון (₪${refund}) תשוחרר* על ידי חברת האשראי תוך *3-5 ימי עסקים*`
          : `💳 ינוכה מהפיקדון: ₪${totalStr}\n💚 יתרת הפיקדון שתשתחרר: ₪${refund}`)
      : (settled
          ? `💳 *Deducted from your deposit: ₪${totalStr}*\n💚 *The remaining ₪${refund} will be released* by your card issuer within *3–5 business days*`
          : `💳 Deducted from deposit: ₪${totalStr}\n💚 Remaining deposit released: ₪${refund}`);
  } else {
    const balance = ((total - deposit)/100).toFixed(2);
    outcome = he
      ? (settled
          ? `💳 *הפיקדון (₪${depositStr}) נוכה במלואו.*\n✅ *ההפרש (₪${balance}) חויב* מכרטיס האשראי שהזנת בצ'ק אין`
          : `💳 הפיקדון (₪${depositStr}) ינוכה במלואו\n🔴 *ההפרש מעל הפיקדון: ₪${balance}* — יחויב מהכרטיס`)
      : (settled
          ? `💳 *The ₪${depositStr} deposit was deducted in full.*\n✅ *The difference (₪${balance}) was charged* to the card you entered at check-in`
          : `💳 The deposit (₪${depositStr}) is deducted in full\n🔴 *Amount over the deposit: ₪${balance}* — charged to the card`);
  }

  return header + `${RULE}\n${lines}\n${RULE}\n${totals}\n${RULE}\n${outcome}`;
}

// ── מנוע סליקת החשבון — משותף לצ'ק אאוט ולחיוב no-show ──
// מבצע את פעולות התשלום בפועל מול שכבת התשלום המבודדת (payments), לפי
// היחס בין סך החיובים לפיקדון, ומעדכן את שדות ההזמנה. אינו שולח הודעות
// לאורח — האחריות לכך על הקורא (processCheckout / autoChargeOnNoShow).
// מחזיר: { total, deposit, captured, overage, released }
async function settleFolio(res, { overageDescription } = {}) {
  const total   = getFolioTotal(res.id);
  const deposit = res.deposit;

  // ── idempotency לכל שלב (הגנת חיוב כפול אחרי ריסטארט) ──
  // כל פעולת תשלום חיצונית מוגנת בדגל משלה ונשמרת ל-DB *מיד* אחריה.
  // כך, אם התהליך קרס בין הפעולה החיצונית לשמירה, ריצה חוזרת (למשל
  // ע"י מנוע ה-no-show) תדלג על מה שכבר בוצע ולא תחייב פעמיים.

  // A: אין חיובים → ביטול ההרשאה, שום חיוב.
  if (total === 0) {
    if (!res.refunded && !res.captured) {
      try { await payments.cancel({ paymentId: res.paymentId }); }
      catch (e) { console.error("Cancel error:", e.message); }
      res.refunded = true;
      persist(res);
    }
    return { total, deposit, captured: 0, overage: 0, released: deposit };
  }

  // לכידת חלק הפיקדון — min(חיובים, פיקדון). פעם אחת בלבד.
  // B: חיובים ≤ פיקדון → נלכד בדיוק סכום החיובים; היתרה משתחררת.
  // C: חיובים > פיקדון → נלכד מלוא הפיקדון (וההפרש בהמשך).
  const captureAmount = Math.min(total, deposit);
  if (!res.captured) {
    try {
      const cap = await payments.capture({ paymentId: res.paymentId, amount: captureAmount });
      res.captured = true; res.capturedAmount = cap.capturedAmount;
    } catch (e) { console.error("Capture error:", e.message); }
    persist(res);
  }

  // B: בתוך גבול הפיקדון → סיימנו.
  if (total <= deposit) {
    return { total, deposit, captured: captureAmount, overage: 0, released: deposit - total };
  }

  // C: ההפרש מעל הפיקדון מחויב *מאותו כרטיס* (ברירת מחדל). פעם אחת בלבד.
  //    האורח יוכל לאחר מכן להחליף לכרטיס אחר דרך הקישור (ראה processCheckout).
  const overage = total - deposit;
  if (!res.overageCharged) {
    try {
      const extra = await payments.chargeSameCard({
        paymentId: res.paymentId,
        amount: overage,
        currency: res.currency || PAYMENT_CURRENCY,
        description: overageDescription || `הפרש מעל פיקדון — חדר ${res.roomNumber}`,
      });
      res.overageCharged = true;
      res.overageAmount  = extra.chargedAmount;
    } catch (e) { console.error("Overage charge error:", e.message); }
    res.overageChargedTo = "deposit_card";
    persist(res);
  }
  return { total, deposit, captured: deposit, overage, released: 0 };
}

// ── Process check-out ─────────────────────────────────
export async function processCheckout(phone, reservationId, lang = "he") {
  const hid = currentHotelId();
  const res = reservationId
    ? reservations[reservationId]
    : Object.values(reservations).find(r => r.phone === phone && r.stage === "checked_in" && (r.hotelId || HOTEL) === hid);

  if (!res) throw new Error("No active reservation found");

  const he   = lang === "he";
  const name = nameFor(res, lang); // שם בשפת השיחה לכל ההודעות לאורח (Bug 2)
  const s  = await settleFolio(res, {
    overageDescription: he
      ? `יתרה מעל פיקדון — חדר ${res.roomNumber} · ${res.guestNameHe || res.guestName}`
      : `Amount over deposit — Room ${res.roomNumber} · ${res.guestNameEn || res.guestName}`,
  });

  res.stage        = "checked_out";
  res.checkedOutAt = new Date().toISOString();
  persist(res); // מצב הצ'ק אאוט + תוצאת הסליקה נשמרים יחד (עקבי) לפני ההודעות
  stats.checkOuts++;

  // ── A: No charges → deposit released in full ──────
  if (s.total === 0) {
    await wa(res.phone, he
      ? `🚪 *צ'ק אאוט הושלם!*\n\n` +
        `תודה, *${name}*! שמחנו לארח אותך 🌟\n\n` +
        `✅ אין חיובים — *לא בוצע חיוב.*\n` +
        `💚 ההקפאה על הפיקדון (${shekels(res.deposit)}) תשוחרר על ידי חברת האשראי תוך *3-5 ימי עסקים*.\n\n` +
        `נשמח לראותך שוב! ⭐`
      : `🚪 *Check-out complete!*\n\n` +
        `Thank you, *${name}*! It was a pleasure hosting you 🌟\n\n` +
        `✅ No charges — *nothing was charged.*\n` +
        `💚 The hold on your ${shekels(res.deposit)} deposit will be released by your card issuer within *3–5 business days*.\n\n` +
        `We hope to see you again! ⭐`,
      { lang }
    );
  }

  // ── B: Charges ≤ deposit → deducted, remainder released ──
  // ההסבר על הניכוי ושחרור היתרה חי *בתוך* formatFolio(settled) — כדי
  // שההודעה לא תחזור על אותן שורות פעם שנייה. ההודעה מוסיפה רק את הפרידה.
  else if (s.overage === 0) {
    await wa(res.phone, he
      ? `🚪 *צ'ק אאוט הושלם!*\n\n` +
        `תודה, *${name}*! שמחנו לארח אותך 🌟\n\n` +
        formatFolio(res, lang, { settled: true }) + "\n\n" +
        `נשמח לראותך שוב! ⭐`
      : `🚪 *Check-out complete!*\n\n` +
        `Thank you, *${name}*! It was a pleasure hosting you 🌟\n\n` +
        formatFolio(res, lang, { settled: true }) + "\n\n" +
        `We hope to see you again! ⭐`,
      { lang }
    );
  }

  // ── C: Charges > deposit → deposit captured + overage charged to same card ──
  else {
    // אפשרות לאורח לשלם את ההפרש בכרטיס *אחר* במקום כרטיס הפיקדון.
    // הקישור מוביל לעמוד תשלום שבו הוא מזין כרטיס חדש; אם ישלם שם — ההפרש
    // "יעבור" לכרטיס האחר (ראה /checkout/balance/pay). בינתיים, כברירת מחדל,
    // ההפרש כבר חויב מכרטיס הפיקדון (settleFolio) כדי להגן על המלון.
    const altPayment = await payments.createBalancePayment({
      reservationId: res.id,
      amount: s.overage,
      currency: PAYMENT_CURRENCY,
      description: he
        ? `יתרה מעל פיקדון — חדר ${res.roomNumber} · ${name}`
        : `Amount over deposit — Room ${res.roomNumber} · ${name}`,
      paymentPageUrl: `${baseUrl()}/checkout/balance/pay?rid=${res.id}`,
      successUrl: `${baseUrl()}/checkout/paid?rid=${res.id}`,
      cancelUrl:  `${baseUrl()}/checkout/skip?rid=${res.id}`,
    });

    res.balanceAmount = s.overage;
    res.altCardUrl    = altPayment.redirectUrl;
    persist(res);

    await wa(res.phone, he
      ? `🚪 *צ'ק אאוט הושלם — חדר ${res.roomNumber}*\n\n` +
        `תודה, *${name}*! שמחנו לארח אותך 🌟\n\n` +
        formatFolio(res, lang, { settled: true }) + "\n\n" +
        `אם נוח יותר לשלם את ההפרש בכרטיס אחר — אפשר להחליף כאן:\n👉 ${res.altCardUrl}\n\n` +
        `_לשאלות: קבלה, שלוחה 0_`
      : `🚪 *Check-out complete — Room ${res.roomNumber}*\n\n` +
        `Thank you, *${name}*! It was a pleasure hosting you 🌟\n\n` +
        formatFolio(res, lang, { settled: true }) + "\n\n" +
        `Prefer to pay the difference with a different card? You can switch here:\n👉 ${res.altCardUrl}\n\n` +
        `_Questions? Reception, Ext. 0_`,
      { lang }
    );

    const totalStr   = (s.total/100).toFixed(2);
    const balanceStr = (s.overage/100).toFixed(2);
    // הסלמה *פעילה* לקבלה (וואטסאפ + מייל), לא רק לוג בדשבורד — חיוב מעל
    // הפיקדון הוא אירוע שקבלה צריכה לדעת עליו בזמן אמת.
    await notifyStaff({
      dept: "reception", hotelId: res.hotelId, phone: res.phone, roomNumber: res.roomNumber, guestName: res.guestName,
      message: `⚠️ חיובים ₪${totalStr} מעל פיקדון | הפרש ₪${balanceStr} חויב מכרטיס הפיקדון | הוצעה החלפת כרטיס`,
      priority: "high",
    });
  }

  // ── התראה פעילה למשק הבית: חדר התפנה ומחכה לניקיון ──────
  // notifyStaff (ולא logAlert בלבד) — כדי שמשק הבית באמת יקבל וואטסאפ+מייל
  // ויכין את החדר לאורח הבא, בדיוק כמו שהקבלה מקבלת התראה בצ'ק אין.
  await notifyStaff({
    dept: "housekeeping", hotelId: res.hotelId, phone: res.phone, roomNumber: res.roomNumber, guestName: res.guestName,
    message: `🧹 חדר ${res.roomNumber} פנוי — ניקיון מלא נדרש`,
    priority: "normal",
  });

  return res;
}

// ── מעבר לכרטיס אחר לתשלום ההפרש ──────────────────────
// נקרא כשהאורח בוחר לשלם את ההפרש (מעל הפיקדון) בכרטיס שונה מזה של
// הפיקדון, דרך עמוד /checkout/balance/pay. ב-Mock: מסמנים שההפרש עבר
// לכרטיס האחר ומודיעים לאורח. בפרודקשן (CardCom): מבטלים את חיוב ההפרש
// מכרטיס הפיקדון ומחייבים את הכרטיס החדש — הכל דרך אותה שכבת payments.
export async function switchOverageToAlternateCard(reservationId, lang = "he") {
  const res = reservations[reservationId];
  if (!res) throw new Error("Reservation not found");
  if (!res.overageAmount) return res; // אין הפרש — אין מה להחליף

  res.overageChargedTo = "alternate_card";
  persist(res);
  const he = lang === "he";
  const balanceStr = (res.overageAmount/100).toFixed(2);

  await wa(res.phone, he
    ? `✅ *עודכן!*\n\nההפרש (₪${balanceStr}) חויב מהכרטיס החדש שהזנת, ולא מכרטיס הפיקדון.\n\nתודה! ⭐`
    : `✅ *Updated!*\n\nThe difference (₪${balanceStr}) was charged to the new card you entered, not to the deposit card.\n\nThank you! ⭐`,
    { lang }
  );

  await logAlert({
    dept: "reception", hotelId: res.hotelId, phone: res.phone, roomNumber: res.roomNumber, guestName: res.guestName,
    message: `🔁 חדר ${res.roomNumber}: הפרש ₪${balanceStr} הועבר לכרטיס אחר (לבקשת האורח)`,
    priority: "normal",
  });
  return res;
}

// ── No-show / אורח שעזב בלי לשלם — חיוב פיקדון אוטומטי ──
// אם אורח הגיע לתאריך הצ'ק אאוט אך לא ביצע צ'ק אאוט ולא שילם, המלון מחייב
// אוטומטית את הפיקדון (ואם יש חוב מעל הפיקדון — גם את ההפרש מאותו כרטיס),
// כדי להגן מפני "בריחה". משתמש באותה סליקה (settleFolio) של הצ'ק אאוט הרגיל.
//
// ⚠️ דמו: כאן מפעילים ידנית (endpoint /api/no-show, או findNoShowReservations
// בלולאה). בפרודקשן זה ייקרא אוטומטית ע"י cron/מנוע זמן שירוץ בשעת הצ'ק אאוט
// לכל הזמנה שעברה את checkoutDate ועדיין במצב checked_in.
export async function autoChargeOnNoShow(reservationId, lang = "he") {
  const res = reservations[reservationId];
  if (!res) throw new Error("Reservation not found");
  if (res.stage !== "checked_in") {
    // כבר עשה צ'ק אאוט / כבר טופל — לא מחייבים פעמיים.
    return { alreadyHandled: true, reservation: res };
  }

  const he   = lang === "he";
  const name = nameFor(res, lang);
  const s  = await settleFolio(res, {
    overageDescription: he
      ? `חיוב אוטומטי (no-show) — חדר ${res.roomNumber} · ${name}`
      : `Auto-charge (no-show) — Room ${res.roomNumber} · ${name}`,
  });

  res.stage        = "checked_out";
  res.noShow       = true;
  res.checkedOutAt = new Date().toISOString();
  persist(res); // מצב ה-no-show + תוצאת הסליקה נשמרים יחד לפני ההודעות
  stats.checkOuts++;

  const totalStr = (s.total/100).toFixed(2);

  // הודעה לאורח — לפי מצב החיוב
  if (s.total === 0) {
    // אין חיובים כלל — משחררים את הפיקדון גם ב-no-show (אין מה לגבות).
    await wa(res.phone, he
      ? `🚪 *הצ'ק אאוט בוצע אוטומטית — חדר ${res.roomNumber}*\n\n` +
        `לא ביצעת צ'ק אאוט עד שעת הסיום, אז סגרנו את השהייה עבורך.\n` +
        `✅ אין חיובים — *לא בוצע חיוב*. ההקפאה על הפיקדון (${shekels(res.deposit)}) תשוחרר על ידי חברת האשראי תוך *3-5 ימי עסקים*.\n\nתודה! ⭐`
      : `🚪 *Check-out was completed automatically — Room ${res.roomNumber}*\n\n` +
        `You didn't check out by the deadline, so we closed the stay for you.\n` +
        `✅ No charges — *nothing was charged*. The hold on your ${shekels(res.deposit)} deposit will be released by your card issuer within *3–5 business days*.\n\nThank you! ⭐`,
      { lang }
    );
  } else if (s.overage === 0) {
    await wa(res.phone, he
      ? `🚪 *הצ'ק אאוט בוצע אוטומטית — חדר ${res.roomNumber}*\n\n` +
        `לא ביצעת צ'ק אאוט עד שעת הסיום, אז סגרנו את השהייה עבורך.\n\n` +
        formatFolio(res, lang, { settled: true }) + "\n\n" +
        `לשאלות: קבלה, שלוחה 0`
      : `🚪 *Check-out was completed automatically — Room ${res.roomNumber}*\n\n` +
        `You didn't check out by the deadline, so we closed the stay for you.\n\n` +
        formatFolio(res, lang, { settled: true }) + "\n\n" +
        `Questions? Reception, Ext. 0`,
      { lang }
    );
  } else {
    await wa(res.phone, he
      ? `🚪 *הצ'ק אאוט בוצע אוטומטית — חדר ${res.roomNumber}*\n\n` +
        `לא ביצעת צ'ק אאוט עד שעת הסיום, אז סגרנו את השהייה עבורך.\n\n` +
        formatFolio(res, lang, { settled: true }) + "\n\n" +
        `לשאלות: קבלה, שלוחה 0`
      : `🚪 *Check-out was completed automatically — Room ${res.roomNumber}*\n\n` +
        `You didn't check out by the deadline, so we closed the stay for you.\n\n` +
        formatFolio(res, lang, { settled: true }) + "\n\n" +
        `Questions? Reception, Ext. 0`,
      { lang }
    );
  }

  // הסלמה פעילה (וואטסאפ + מייל) — no-show הוא אירוע שקבלה ומשק הבית
  // חייבים לדעת עליו בזמן אמת, לא רק כרשומה בדשבורד.
  await notifyStaff({
    dept: "reception", hotelId: res.hotelId, phone: res.phone, roomNumber: res.roomNumber, guestName: res.guestName,
    message: `🏃 *NO-SHOW* חדר ${res.roomNumber} · ${res.guestName} — לא בוצע צ'ק אאוט; חויב אוטומטית ₪${totalStr}`,
    priority: "high",
  });
  await notifyStaff({
    dept: "housekeeping", hotelId: res.hotelId, phone: res.phone, roomNumber: res.roomNumber, guestName: res.guestName,
    message: `🧹 חדר ${res.roomNumber} פנוי (no-show) — ניקיון מלא נדרש`,
    priority: "normal",
  });

  // ── קישור session ↔ reservation ──────────────────────
  patchSession(res.phone, { stage: "checked_out", checkinStage: null, checkoutStage: null }, res.hotelId);

  return { alreadyHandled: false, settlement: s, reservation: res };
}

// ── מאתר הזמנות no-show — עברו את תאריך הצ'ק אאוט ועדיין checked_in ──
// בפרודקשן: cron יריץ את זה מדי כמה דקות ויקרא ל-autoChargeOnNoShow לכל אחת.
export function findNoShowReservations(now = new Date()) {
  return Object.values(reservations).filter(r =>
    r.stage === "checked_in" && r.checkoutDate && new Date(r.checkoutDate) <= now
  );
}

export function getActiveReservation(phone, hotelId = currentHotelId()) {
  return Object.values(reservations).find(
    r => r.phone === phone && r.stage === "checked_in" && (r.hotelId || HOTEL) === hotelId
  );
}

// ── הזמנה שממתינה לתשלום הפיקדון ──────────────────────
// משמשת כדי *לחדש* את שלב הפיקדון בלי ליצור הזמנה חדשה: אורח שביקש
// לעבור שפה באמצע, או שכתב "להמשיך בצ'ק אין", מקבל את אותו קישור תשלום
// שוב — במקום להתחיל את הצ'ק אין מהתחלה. מחזירה את החדשה ביותר.
export function getPendingReservation(phone, hotelId = currentHotelId()) {
  return Object.values(reservations)
    .filter(r => r.phone === phone && r.stage === "pending_payment" && r.paymentUrl && (r.hotelId || HOTEL) === hotelId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

// ── סימון "תשלום התקבל" (webhook) — מעדכן paidAt ושומר ל-DB ──
// נקרא מ-checkin-routes.js (webhook) במקום מוטציה ישירה על reservations,
// כדי שהעדכון יישמר ל-DB. מחזיר את ההזמנה, או null אם לא נמצאה.
export function markPaid(reservationId) {
  const res = reservations[reservationId];
  if (!res) return null;
  res.paidAt = new Date().toISOString();
  persist(res);
  return res;
}

// ── משוב האורח בצ'ק אאוט ──────────────────────────────
// נשמר על ההזמנה (שורד ריסטארט) כדי שהנהלת המלון תוכל לעקוב אחר שביעות
// הרצון. rating (1–5) ו/או טקסט חופשי — שניהם אופציונליים.
export function saveFeedback(reservationId, { rating = null, text = null } = {}) {
  const res = reservations[reservationId];
  if (!res) return null;
  res.feedback = { rating: rating ?? null, text: text || null, at: new Date().toISOString() };
  persist(res);
  return res;
}

// ── Demo helper — adds sample charges for presentation ─
export function addDemoCharges(reservationId) {
  addFolioItem(reservationId, "RESTAURANT",   "ארוחת בוקר × 2",     18000);
  addFolioItem(reservationId, "MINIBAR",      "מיני בר",              9500);
  addFolioItem(reservationId, "SPA",          "עיסוי שוודי 60 דק",  35000);
}
