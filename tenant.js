// ════════════════════════════════════════════════════════
//  TENANT — ריבוי מלונות (multi-tenant): זהות המלון בכל הזרימה
//  ----------------------------------------------------------
//  הבעיה שזה פותר: המערכת משרתת 100+ מלונות מאותו תהליך. הודעה נכנסת
//  חייבת "לדעת" לאיזה מלון היא שייכת, וזהות זו חייבת ללוות אותה בכל
//  קריאה — סשן, הזמנה, קונפיג, התראות צוות — בלי שבקשה של מלון א' תיגע
//  במלון ב'.
//
//  איך זה עובד בלי לחווט hotelId דרך 54 קריאות ב-bot.js:
//  AsyncLocalStorage. בכניסה (handleIncoming) פותרים את המלון מ-To של
//  Twilio ומריצים את כל הטיפול בתוך runInTenant(hotelId, ...). כל קוד
//  שרץ *בתוך* ההקשר הזה יכול לקרוא currentHotelId() ולקבל את המלון הנכון,
//  בלי פרמטר. הודעות מקבילות של מלונות שונים מקבלות כל אחת הקשר משלה —
//  זו בדיוק ההבטחה של AsyncLocalStorage (בידוד per async-context).
//
//  ברירת מחדל: אין הקשר / מספר לא מזוהה → DEFAULT_HOTEL_ID. כך פריסה
//  של מלון בודד וכל הבדיקות הקיימות ממשיכות לעבוד בדיוק כמו קודם.
//
//  מגבלה מודעת: AsyncLocalStorage מגן על *תהליך בודד*. לריבוי תהליכים
//  הזהות עוברת ממילא בכל הודעה (To → hotelId), כך שכל תהליך פותר לבד —
//  אין מצב משותף לאבד. ראה SCALING.md.
// ════════════════════════════════════════════════════════
import { AsyncLocalStorage } from "node:async_hooks";
import { db, DEFAULT_HOTEL_ID } from "./db.js";

export { DEFAULT_HOTEL_ID };

const als = new AsyncLocalStorage();

// מריץ fn כשזהות המלון קשורה להקשר האסינכרוני. כל ה-await-ים שבתוך fn
// (וה-timers, וה-promises) יראו את אותו hotelId.
export function runInTenant(hotelId, fn) {
  return als.run({ hotelId: hotelId || DEFAULT_HOTEL_ID }, fn);
}

// המלון של ההקשר הנוכחי. מחוץ לכל runInTenant → ברירת המחדל (מלון בודד).
export function currentHotelId() {
  return als.getStore()?.hotelId || DEFAULT_HOTEL_ID;
}

// ── נרמול מספר ──────────────────────────────────────────
// Twilio שולח את המספר כ-"whatsapp:+972...". משווים לפי E.164 בלבד
// (ספרות + '+' מוביל), כדי ש-"whatsapp:+972...", "+972..." ו-"972..."
// יתמפו לאותו מלון.
export function normalizeNumber(raw) {
  if (!raw) return "";
  let s = String(raw).trim().replace(/^whatsapp:/i, "").replace(/[^\d+]/g, "");
  if (s && !s.startsWith("+")) s = "+" + s;
  return s;
}

// ── מטמון מיפוי מספר → מלון ─────────────────────────────
// נטען מ-DB (טבלת hotel_numbers) ומתרענן ב-reloadHotelNumbers. מספר
// בודד שמוגדר ב-env (TWILIO_WHATSAPP_NUMBER) ממופה ל-DEFAULT_HOTEL_ID
// כברירת מחדל — כך פריסת מלון בודד עובדת בלי להגדיר כלום.
let numberMap = new Map();   // normalizedNumber → { hotelId, fromNumber }

export function reloadHotelNumbers() {
  const map = new Map();
  try {
    for (const row of db.prepare(`SELECT number, hotel_id, from_number FROM hotel_numbers`).all()) {
      const n = normalizeNumber(row.number);
      if (n) map.set(n, { hotelId: row.hotel_id, fromNumber: row.from_number || n });
    }
  } catch (e) {
    console.error("⚠️ טעינת hotel_numbers נכשלה:", e?.message || e);
  }
  // ברירת מחדל למלון בודד: המספר שב-env שייך למלון ברירת המחדל, אם לא
  // הוגדר אחרת מפורשות ב-DB.
  const envNum = normalizeNumber(process.env.TWILIO_WHATSAPP_NUMBER);
  if (envNum && !map.has(envNum)) {
    map.set(envNum, { hotelId: DEFAULT_HOTEL_ID, fromNumber: envNum });
  }
  numberMap = map;
  return map;
}
reloadHotelNumbers();

// רישום/עדכון מספר של מלון (למשל בעת onboarding של מלון חדש).
const upsertNumberStmt = db.prepare(`
  INSERT INTO hotel_numbers (number, hotel_id, from_number, updated_at)
  VALUES (@number, @hotel_id, @from_number, @updated_at)
  ON CONFLICT(number) DO UPDATE SET
    hotel_id    = excluded.hotel_id,
    from_number = excluded.from_number,
    updated_at  = excluded.updated_at
`);
export function registerHotelNumber(number, hotelId, fromNumber = null) {
  const n = normalizeNumber(number);
  if (!n) throw new Error("registerHotelNumber: number required");
  if (!hotelId) throw new Error("registerHotelNumber: hotelId required");
  upsertNumberStmt.run({
    number: n, hotel_id: hotelId,
    from_number: fromNumber ? normalizeNumber(fromNumber) : n,
    updated_at: new Date().toISOString(),
  });
  reloadHotelNumbers();
  return { number: n, hotelId, fromNumber: fromNumber ? normalizeNumber(fromNumber) : n };
}

// ── פתרון המלון מהמספר הנכנס (To של Twilio) ─────────────
// מספר לא מזוהה → DEFAULT_HOTEL_ID (עם אזהרה, כי בפרודקשן זה אומר שמלון
// לא הוגדר נכון). לעולם לא זורק — הודעה חייבת להיות מטופלת גם אם המיפוי
// חסר, אחרת אורח נשאר בלי מענה.
export function resolveHotelId(toNumber) {
  const n = normalizeNumber(toNumber);
  if (n && numberMap.has(n)) return numberMap.get(n).hotelId;
  if (n) {
    console.warn(`⚠️ מספר נכנס לא ממופה למלון: ${n} — משתמשים ב-"${DEFAULT_HOTEL_ID}". הגדירו ב-hotel_numbers.`);
  }
  return DEFAULT_HOTEL_ID;
}

// המספר שממנו יש לשלוח לאורח, לפי המלון. כך כל מלון עונה מהמספר שלו.
// לא נמצא → env TWILIO_WHATSAPP_NUMBER (פריסת מלון בודד).
export function fromNumberFor(hotelId) {
  for (const { hotelId: hid, fromNumber } of numberMap.values()) {
    if (hid === hotelId && fromNumber) return fromNumber;
  }
  return normalizeNumber(process.env.TWILIO_WHATSAPP_NUMBER) || null;
}

// מפתח סשן/נעילה מורכב — מבודד אורח של מלון א' מאורח (אותו מספר) של
// מלון ב'. \x00 לא יופיע במספר ולכן אין התנגשות מפתחות.
export function tenantKey(hotelId, phone) {
  return `${hotelId || DEFAULT_HOTEL_ID}\x00${phone}`;
}
