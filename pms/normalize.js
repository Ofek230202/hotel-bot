// ════════════════════════════════════════════════════════
//  PMS NORMALIZE — המבנה הקנוני שהקוד העסקי מקבל תמיד
//  ----------------------------------------------------------
//  הכלל שמחזיק את כל שכבת ה-PMS: **JSON של ספק לעולם לא יוצא מהאדפטר.**
//  כל ספק (Optima, Apaleo, Mews, Opera, Cloudbeds…) ממפה את התשובה שלו
//  למבנים שכאן, ולכן `checkin.js` נראה זהה בדיוק בין אם המלון על אופטימה,
//  על Mews, או בלי PMS בכלל.
//
//  בלי השכבה הזו כל ספק חדש היה מחייב לגעת בלוגיקה העסקית — וזו בדיוק
//  הדרך שבה "עוד אינטגרציה" הופכת לשכתוב.
//
//  💰 כסף: **תמיד באגורות/סנטים (מספר שלם)**, כמו בכל שאר המערכת
//     (`deposit_amount: 50000` = ₪500). ספק שמחזיר "1234.56" מומר כאן,
//     במקום אחד, ולא בכל קורא בנפרד.
//  📅 תאריכים: **`YYYY-MM-DD`** (תאריך שהייה) — בלי אזור זמן, כי לילה
//     במלון הוא תאריך ולא רגע.
// ════════════════════════════════════════════════════════

// ── כסף ─────────────────────────────────────────────────
// מקבל מספר, מחרוזת ("1,234.56"), או null. מחזיר אגורות שלמות.
// null/undefined/לא-מספר → null (ולא 0! "אין נתון" שונה מ"אפס").
export function toMinorUnits(value, { alreadyMinor = false } = {}) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return alreadyMinor ? Math.round(value) : Math.round(value * 100);
  }
  const cleaned = String(value).replace(/[^\d.,-]/g, "").replace(/,/g, "");
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  return alreadyMinor ? Math.round(n) : Math.round(n * 100);
}

// ── תאריכים ─────────────────────────────────────────────
// מקבל "2026-08-01", "01/08/2026", "20260801", או ISO מלא. מחזיר YYYY-MM-DD.
// לא מצליח לפרסר → null (לעולם לא תאריך מומצא — תאריך שגוי במלון = כרטיס
// שלא עובד, ראה §6 "תאריכי שהייה").
export function toStayDate(value) {
  if (!value) return null;
  const s = String(value).trim();

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);                 // ISO / YYYY-MM-DD
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);                       // YYYYMMDD
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);           // DD/MM/YYYY (ישראל)
  if (m) return `${m[3]}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

// מספר לילות בין שני תאריכי שהייה. null אם חסר/לא הגיוני.
export function nightsBetween(checkIn, checkOut) {
  if (!checkIn || !checkOut) return null;
  const a = new Date(`${checkIn}T00:00:00Z`), b = new Date(`${checkOut}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const n = Math.round((b - a) / 86_400_000);
  return n > 0 ? n : null;
}

// ── סטטוס הזמנה קנוני ───────────────────────────────────
// לכל ספק שמות משלו ("DUE_IN", "Confirmed", "1", "IN_HOUSE"…). ממפים
// לאוצר מילים אחד שהקוד העסקי מכיר.
export const RESERVATION_STATUS = Object.freeze({
  CONFIRMED:  "confirmed",   // הזמנה תקפה, האורח טרם הגיע
  IN_HOUSE:   "in_house",    // האורח עשה צ'ק אין ושוהה
  CHECKED_OUT:"checked_out",
  CANCELLED:  "cancelled",
  NO_SHOW:    "no_show",
  UNKNOWN:    "unknown",
});

const STATUS_WORDS = [
  [/cancel|בוטל/i,                        RESERVATION_STATUS.CANCELLED],
  [/no[\s_-]?show|לא הגיע/i,              RESERVATION_STATUS.NO_SHOW],
  [/checked?[\s_-]?out|departed|עזב|יצא/i, RESERVATION_STATUS.CHECKED_OUT],
  [/in[\s_-]?house|checked?[\s_-]?in|arrived|שוהה|נכנס/i, RESERVATION_STATUS.IN_HOUSE],
  [/confirm|due[\s_-]?in|reserved|booked|מאושר|הזמנה/i,   RESERVATION_STATUS.CONFIRMED],
];

export function toReservationStatus(raw) {
  if (!raw) return RESERVATION_STATUS.UNKNOWN;
  const s = String(raw);
  for (const [re, status] of STATUS_WORDS) if (re.test(s)) return status;
  return RESERVATION_STATUS.UNKNOWN;
}

// ── סטטוס חדר קנוני ─────────────────────────────────────
export const ROOM_STATUS = Object.freeze({
  CLEAN: "clean", DIRTY: "dirty", INSPECTED: "inspected",
  OUT_OF_ORDER: "out_of_order", UNKNOWN: "unknown",
});

export function toRoomStatus(raw) {
  if (!raw) return ROOM_STATUS.UNKNOWN;
  const s = String(raw);
  if (/out[\s_-]?of[\s_-]?order|ooo|תקול/i.test(s))      return ROOM_STATUS.OUT_OF_ORDER;
  if (/inspect|נבדק/i.test(s))                            return ROOM_STATUS.INSPECTED;
  if (/dirty|soil|מלוכלך|לניקיון/i.test(s))               return ROOM_STATUS.DIRTY;
  if (/clean|vacant[\s_-]?ready|ready|נקי|מוכן/i.test(s)) return ROOM_STATUS.CLEAN;
  return ROOM_STATUS.UNKNOWN;
}

// ── ההזמנה הקנונית ──────────────────────────────────────
// כל שדה שאינו ידוע = null, לעולם לא ניחוש. `raw` נשמר לדיבוג בלבד
// ואסור לקוד העסקי לקרוא ממנו (זו בדיוק הדליפה שהשכבה נועדה למנוע).
export function makeReservation({
  id = null, confirmationNumber = null, status = null,
  guestName = null, guestFirstName = null, guestLastName = null,
  phone = null, email = null, nationality = null,
  roomNumber = null, roomType = null,
  checkIn = null, checkOut = null, nights = null,
  adults = null, children = null,
  rateAmount = null, currency = "ILS",
  balance = null, notes = null, hotelCode = null, raw = null,
} = {}) {
  const ci = toStayDate(checkIn), co = toStayDate(checkOut);
  return {
    id: id != null ? String(id) : null,
    confirmationNumber: confirmationNumber != null ? String(confirmationNumber) : null,
    status: toReservationStatus(status),
    guestName: guestName || [guestFirstName, guestLastName].filter(Boolean).join(" ") || null,
    guestFirstName, guestLastName,
    phone, email, nationality,
    roomNumber: roomNumber != null ? String(roomNumber) : null,
    roomType,
    checkIn: ci, checkOut: co,
    nights: nights ?? nightsBetween(ci, co),
    adults: adults == null ? null : Number(adults) || null,
    children: children == null ? null : Number(children) || 0,
    rateAmount, currency: currency || "ILS",
    balance, notes, hotelCode,
    source: "pms",
    raw,
  };
}

// ── ה-folio הקנוני ──────────────────────────────────────
// שורות + מאזן. הסכומים באגורות; `balance` מחושב אם לא נמסר.
export function makeFolio({ id = null, lines = [], balance = null, currency = "ILS", raw = null } = {}) {
  const norm = (lines || []).map(l => ({
    id: l.id != null ? String(l.id) : null,
    description: l.description || l.desc || null,
    amount: typeof l.amount === "number" ? l.amount : toMinorUnits(l.amount),
    quantity: l.quantity == null ? 1 : Number(l.quantity) || 1,
    date: toStayDate(l.date),
    category: l.category || null,
  }));
  const computed = norm.reduce((s, l) => s + (l.amount || 0), 0);
  return {
    id: id != null ? String(id) : null,
    lines: norm,
    balance: balance == null ? computed : (typeof balance === "number" ? balance : toMinorUnits(balance)),
    currency: currency || "ILS",
    source: "pms",
    raw,
  };
}

// ── קריאת ערך לפי נתיב, עם שמות חלופיים ─────────────────
// ספקי PMS משנים שמות שדות בין גרסאות ובין התקנות. במקום להיתלות בשם
// אחד, כל מיפוי מקבל **רשימת מועמדים** ולוקח את הראשון שקיים.
// תומך בנתיב מקונן: "guest.firstName".
export function pick(obj, candidates = []) {
  for (const path of candidates) {
    const v = String(path).split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}
