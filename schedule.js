// ════════════════════════════════════════════════════════
//  SCHEDULE — מנוע הזמן: המערכת יוזמת, לא רק עונה
//  ----------------------------------------------------------
//  ── מה זה משנה ──────────────────────────────────────────
//  עד כאן המערכת הייתה **עונה** מצוינת: אורח כותב, היא משיבה. פקידת
//  קבלה אמיתית לא מחכה שישאלו אותה — היא שולחת הוראות הגעה יום לפני,
//  בודקת אחרי הכניסה שהכול כרצונו, ומזכירה בערב שלפני העזיבה.
//  זה ההבדל בין "בוט" ל"קבלה", והוא כולו כאן.
//
//  ── למה זה המקום המסוכן ביותר במערכת ───────────────────
//  🔴 הודעה יזומה היא הדבר היחיד שהמערכת שולחת **בלי שאורח ביקש**.
//     ולכן כל טעות בה נראית לאורח כרשלנות של המלון, לא כתקלה טכנית:
//       • הודעה כפולה  → "המלון הזה מבולגן"
//       • הודעה ב-03:00 → מעיר אורח משינה
//       • הודעה לאורח שכבר עזב / ביטל → מביך
//     לכן ארבע הגנות, וכולן חובה:
//       1. **אידמפוטנטיות** — מפתח ייחודי (הזמנה + סוג). אי אפשר לתזמן
//          פעמיים, וגם ריצה כפולה של הסורק לא תשלח פעמיים.
//       2. **שעות שקטות** — לא שולחים בלילה. הודעה שנופלת בלילה נדחית
//          לשעה תרבותית, ולא "מתפספסת".
//       3. **ביטול מדורג** — צ'ק אאוט/ביטול מבטלים את כל העתיד.
//       4. **מגובה-DB** — לא `setTimeout`. deploy קורה בדיוק כשמשהו
//          נשבר, וטיימר בזיכרון היה נעלם בשקט.
//
//  ── אזור זמן פר-מלון ───────────────────────────────────
//  🔴 "יום לפני, בשש בערב" חייב להיות שש בערב **אצל האורח**. מלון
//     בניו יורק אינו שולח לפי שעון ישראל. כל חישוב כאן עובר דרך
//     `location.timezone` של אותו מלון.
//
//  ── בידוד ──────────────────────────────────────────────
//  כל שליחה עטופה ב-`runInTenant(hotelId)`: `wa()` גוזר את המספר היוצא
//  מההקשר, וסורק שרץ מחוץ להקשר היה שולח מהמספר של מלון אחר.
// ════════════════════════════════════════════════════════
import { v4 as uuidv4 } from "uuid";
import { prepare, queryAllAsync } from "./store/Repo.js";
import { DEFAULT_HOTEL_ID } from "./db.js";
import { runInTenant } from "./tenant.js";
import { withGuestLock } from "./store/index.js";
import { configFor, ensureConfigLoaded, hotelModel } from "./config.js";
import { ensureSessionLoaded, peekSession } from "./state.js";

// ── סוגי ההודעות היזומות ────────────────────────────────
// הסדר הוא סדר המסע של האורח. `offsetOf` קובע מתי כל אחת נשלחת.
export const MESSAGE_KINDS = Object.freeze({
  BOOKING_CONFIRMED: "booking_confirmed",  // מיד עם ההזמנה
  DAY_BEFORE:        "day_before",         // יום לפני, 18:00 מקומי
  ARRIVAL_DAY:       "arrival_day",        // בוקר ההגעה, 09:00 מקומי
  SETTLED_IN:        "settled_in",         // שעתיים אחרי הכניסה בפועל
  DEPARTURE_EVE:     "departure_eve",      // ערב לפני העזיבה, 19:00 מקומי
  POST_STAY:         "post_stay",          // יום אחרי, 11:00 מקומי
});

// שעות שקטות — לא שולחים בין 21:00 ל-08:00 **בשעון המלון**.
export const QUIET_FROM = Number(process.env.QUIET_HOURS_FROM) || 21;
export const QUIET_TO   = Number(process.env.QUIET_HOURS_TO)   || 8;

// ── טבלה ────────────────────────────────────────────────
// `UNIQUE(reservation_id, kind)` הוא לב האידמפוטנטיות: אי אפשר לתזמן
// את אותה הודעה פעמיים, גם אם הקוד ינסה.
const createTable = prepare(`
  CREATE TABLE IF NOT EXISTS scheduled_messages (
    id             TEXT PRIMARY KEY,
    hotel_id       TEXT NOT NULL,
    reservation_id TEXT NOT NULL,
    phone          TEXT NOT NULL,
    kind           TEXT NOT NULL,
    send_at        TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    attempts       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT,
    sent_at        TEXT,
    error          TEXT,
    UNIQUE (reservation_id, kind)
  )
`);
try { createTable.run(); } catch { /* קיימת */ }
try { prepare(`CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled_messages (status, send_at)`).run(); } catch { /* קיים */ }

const insertStmt = prepare(`
  INSERT INTO scheduled_messages (id, hotel_id, reservation_id, phone, kind, send_at, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  ON CONFLICT (reservation_id, kind) DO NOTHING
`);
const dueStmt      = prepare(`SELECT * FROM scheduled_messages WHERE status = 'pending' AND send_at <= ? ORDER BY send_at LIMIT 200`);
const markSentStmt = prepare(`UPDATE scheduled_messages SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'`);
const markFailStmt = prepare(`UPDATE scheduled_messages SET status = ?, attempts = attempts + 1, error = ? WHERE id = ?`);
const cancelStmt   = prepare(`UPDATE scheduled_messages SET status = 'cancelled' WHERE reservation_id = ? AND status = 'pending'`);
const cancelKind   = prepare(`UPDATE scheduled_messages SET status = 'cancelled' WHERE reservation_id = ? AND kind = ? AND status = 'pending'`);
const forResStmt   = prepare(`SELECT kind, send_at, status, sent_at FROM scheduled_messages WHERE reservation_id = ? ORDER BY send_at`);

// כמה ניסיונות לפני שמוותרים. הודעה שנכשלת שוב ושוב לא תישלח לנצח.
const MAX_ATTEMPTS = 3;

// ── זמן מקומי של המלון ──────────────────────────────────
/** ההיסט (בדקות) של אזור הזמן של המלון בנקודת זמן נתונה — מודע לשעון קיץ. */
function tzOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(date).find(p => p.type === "timeZoneName")?.value || "GMT+00:00";
  const m = parts.match(/GMT([+-])(\d{2}):(\d{2})/);
  return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0;
}

/** `YYYY-MM-DD` + `HH:MM` בשעון המלון → Date אמיתי (UTC). */
export function hotelDateTime(ymd, hhmm, timeZone = "Asia/Jerusalem") {
  const guess  = new Date(`${ymd}T${hhmm}:00Z`);
  const offset = tzOffsetMinutes(guess, timeZone);
  return new Date(guess.getTime() - offset * 60_000);
}

/** השעה (0–23) בשעון המלון עבור רגע נתון. */
export function hourInHotel(date, timeZone = "Asia/Jerusalem") {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "2-digit", hour12: false,
  }).format(date));
}

/**
 * דוחה רגע שנופל בשעות השקטות לשעת הפתיחה הקרובה.
 *
 * 🔴 דוחים ולא מדלגים: הודעת "הוראות הגעה" שנופלת ב-23:00 עדיין חייבת
 *    להישלח — פשוט בבוקר. הודעה שמתפספסת גרועה מהודעה שמאחרת.
 */
export function shiftOutOfQuietHours(date, timeZone = "Asia/Jerusalem") {
  let d = new Date(date);
  for (let i = 0; i < 48; i++) {          // חסם קשיח — לעולם לא לולאה אינסופית
    const h = hourInHotel(d, timeZone);
    if (h >= QUIET_TO && h < QUIET_FROM) return d;
    d = new Date(d.getTime() + 3600_000);  // שעה קדימה עד שנכנסים לחלון
  }
  return d;
}

// ── מתי כל הודעה נשלחת ──────────────────────────────────
const DAY = 86_400_000;

function ymdMinusDays(ymd, days) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function ymdPlusDays(ymd, days) { return ymdMinusDays(ymd, -days); }

/**
 * מחשב את מועד השליחה של סוג הודעה עבור הזמנה. `null` = לא רלוונטי.
 * הכול בשעון המלון, ואחרי דחייה משעות שקטות.
 */
export function sendAtFor(kind, res, { now = new Date(), timeZone } = {}) {
  const tz = timeZone || configFor(res.hotelId)?.location?.timezone || "Asia/Jerusalem";
  const ci = res.stayCheckIn, co = res.stayCheckOut;
  let at = null;

  switch (kind) {
    case MESSAGE_KINDS.BOOKING_CONFIRMED:
      at = new Date(now.getTime() + 60_000);           // דקה — לא באותה נשימה
      break;
    case MESSAGE_KINDS.DAY_BEFORE:
      if (!ci) return null;
      at = hotelDateTime(ymdMinusDays(ci, 1), "18:00", tz);
      break;
    case MESSAGE_KINDS.ARRIVAL_DAY:
      if (!ci) return null;
      at = hotelDateTime(ci, "09:00", tz);
      break;
    case MESSAGE_KINDS.SETTLED_IN:
      if (!res.checkedInAt) return null;
      at = new Date(new Date(res.checkedInAt).getTime() + 2 * 3600_000);
      break;
    case MESSAGE_KINDS.DEPARTURE_EVE:
      if (!co) return null;
      at = hotelDateTime(ymdMinusDays(co, 1), "19:00", tz);
      break;
    case MESSAGE_KINDS.POST_STAY:
      if (!co) return null;
      at = hotelDateTime(ymdPlusDays(co, 1), "11:00", tz);
      break;
    default: return null;
  }
  if (!at || Number.isNaN(at.getTime())) return null;
  return shiftOutOfQuietHours(at, tz);
}

// ── תזמון ───────────────────────────────────────────────
/**
 * מתזמן הודעה. אידמפוטנטי לחלוטין — קריאה שנייה לא עושה כלום.
 * מועד שכבר עבר **אינו** מתוזמן: לא שולחים "יום לפני" אחרי שהאורח הגיע.
 */
export function scheduleMessage(res, kind, { now = new Date() } = {}) {
  if (!res?.id || !res?.phone) return { skipped: "no-reservation" };
  const at = sendAtFor(kind, res, { now });
  if (!at) return { skipped: "not-applicable" };
  // 🔴 עבר זמנו → לא שולחים. אורח שהזמין יום לפני ההגעה לא אמור לקבל
  //    "נתראה מחר" רטרואקטיבית, וזה בדיוק מה שקורה בהזמנות של הרגע האחרון.
  if (at.getTime() <= now.getTime()) return { skipped: "in-the-past" };

  insertStmt.run(
    `sch_${uuidv4()}`, res.hotelId || DEFAULT_HOTEL_ID, res.id, res.phone,
    kind, at.toISOString(), new Date().toISOString(),
  );
  return { scheduled: true, kind, at: at.toISOString() };
}

/** מתזמן את כל ציר הזמן של הזמנה. נקרא בעת יצירת ההזמנה. */
export function scheduleStayTimeline(res, { now = new Date() } = {}) {
  const out = [];
  for (const kind of [
    MESSAGE_KINDS.BOOKING_CONFIRMED, MESSAGE_KINDS.DAY_BEFORE,
    MESSAGE_KINDS.ARRIVAL_DAY, MESSAGE_KINDS.DEPARTURE_EVE, MESSAGE_KINDS.POST_STAY,
  ]) {
    const r = scheduleMessage(res, kind, { now });
    if (r.scheduled) out.push({ kind, at: r.at });
  }
  return out;
}

/** מבטל את כל ההודעות העתידיות של הזמנה (ביטול / צ'ק אאוט מוקדם). */
export function cancelScheduled(reservationId, { kind = null } = {}) {
  if (!reservationId) return false;
  if (kind) cancelKind.run(reservationId, kind);
  else      cancelStmt.run(reservationId);
  return true;
}

/** לוח הזמנים של הזמנה — לדשבורד ולבדיקות. */
export async function scheduleForReservation(reservationId) {
  return forResStmt.allAsync(reservationId);
}

// ── שליחה ───────────────────────────────────────────────
// הבונים מוזרקים (`setComposer`) כדי שהמנוע לא יחזיק בתוכן, ולהפך.
// זה גם מה שמונע מעגל ייבוא מול bot.js.
let compose = async () => null;
let send    = async () => {};
export function setComposer(fn) { if (typeof fn === "function") compose = fn; }
export function setSender(fn)   { if (typeof fn === "function") send = fn; }

// לפני שליחה — האם עדיין רלוונטי? מוזרק, כדי ש-`schedule.js` לא יידע
// דבר על הזמנות. מחזיר `{ ok }` או `{ ok:false, reason }`.
let guard = async () => ({ ok: true });
export function setGuard(fn) { if (typeof fn === "function") guard = fn; }

/**
 * שולח הודעה מתוזמנת אחת. מוגן בנעילה, אידמפוטנטי, ועטוף בהקשר המלון.
 */
export async function deliverOne(row) {
  return withGuestLock(`sched:${row.id}`, async () => {
    // קריאה חוזרת בתוך הנעילה: ייתכן שעותק אחר כבר שלח או שבוטלה.
    const fresh = await forResStmt.allAsync(row.reservation_id);
    const mine  = fresh.find(r => r.kind === row.kind);
    if (mine && mine.status !== "pending") return { skipped: mine.status };

    await ensureConfigLoaded(row.hotel_id);
    await ensureSessionLoaded(row.phone, row.hotel_id);

    const verdict = await guard(row);
    if (!verdict.ok) {
      markFailStmt.run("cancelled", verdict.reason || "guard", row.id);
      return { skipped: verdict.reason || "guard" };
    }

    try {
      const built = await runInTenant(row.hotel_id, () => compose(row));
      if (!built?.text) {
        // אין תוכן = אין מה לשלוח. מסמנים כמבוטל, לא ככישלון לנסות שוב.
        markFailStmt.run("cancelled", "no-content", row.id);
        return { skipped: "no-content" };
      }
      // 🔴 השליחה בתוך הקשר המלון: `wa()` גוזר ממנו את המספר היוצא.
      await runInTenant(row.hotel_id, () => send(row.phone, built.text, { lang: built.lang }));
      markSentStmt.run(new Date().toISOString(), row.id);
      return { sent: true, kind: row.kind };
    } catch (e) {
      const attempts = (row.attempts || 0) + 1;
      const status   = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
      markFailStmt.run(status, String(e?.message || e).slice(0, 300), row.id);
      console.error(`🚨 הודעה מתוזמנת ${row.kind} נכשלה (ניסיון ${attempts}):`, e?.message || e);
      return { failed: true, willRetry: status === "pending" };
    }
  });
}

/** סורק ושולח את כל מה שהגיע זמנו. זו העבודה המחזורית. */
export async function deliverDue(now = new Date()) {
  let rows = [];
  try { rows = await dueStmt.allAsync(now.toISOString()); }
  catch (e) { console.error("סריקת הודעות מתוזמנות נכשלה:", e?.message || e); return { scanned: 0, sent: 0 }; }

  let sent = 0, skipped = 0, failed = 0;
  for (const row of rows) {
    const r = await deliverOne(row);
    if (r.sent) sent++; else if (r.failed) failed++; else skipped++;
  }
  if (sent || failed) console.log(`📨 הודעות יזומות: נשלחו ${sent}, דולגו ${skipped}, נכשלו ${failed}`);
  return { scanned: rows.length, sent, skipped, failed };
}

/** לניטור ולדוחות. */
export async function scheduleStats(hotelId = null) {
  const sql = hotelId
    ? `SELECT kind, status, COUNT(*) AS n FROM scheduled_messages WHERE hotel_id = ? GROUP BY kind, status`
    : `SELECT kind, status, COUNT(*) AS n FROM scheduled_messages GROUP BY kind, status`;
  const rows = await queryAllAsync(sql, hotelId ? [hotelId] : []);
  return rows.map(r => ({ ...r, n: Number(r.n) }));
}

export const __test = { ymdMinusDays, ymdPlusDays, tzOffsetMinutes };
