// ════════════════════════════════════════════════════════
//  HANDOVER — בקשה לא עוברת חילופי משמרת בלי שמישהו יראה אותה
//  ----------------------------------------------------------
//  ── הפער שזה סוגר ───────────────────────────────────────
//  לאירוע חירום כבר יש סולם אישור-קבלה (`escalation.js`). לבקשה רגילה
//  אין כלום: היא נשלחת למחלקה, ואם איש לא הרים — היא פשוט **נעלמת**.
//  האורח ביקש מגבות ב-15:00, המשמרת התחלפה ב-16:00, ואיש אינו יודע
//  שהבקשה קיימת. האורח בטוח שהמלון התעלם ממנו.
//
//  🔴 זה נראה קטן ליד חירום, אבל זה **הרבה יותר שכיח** — וזה בדיוק
//     ההבדל בין מלון שמרגיש מסודר לבין מלון ששוכח.
//
//  ── למה לא פשוט "עוד סולם הסלמה" ────────────────────────
//  כי בקשה רגילה אינה חירום, והתגובה חייבת להיות פרופורציונלית:
//   • חירום: 3 דק׳ → מנהל תורן → כל המחלקות. רועש בכוונה.
//   • בקשה רגילה: תזכורת שקטה לאותה מחלקה, ואז למנהל. **בלי** להעיר
//     את כל המלון על מגבות.
//
//  ⚠️ מודע: המערכת יודעת רק אם מישהו **אישר** במסך. היא אינה יודעת אם
//     המגבות הגיעו. זה מה שאפשר לדעת ממערכת הודעות, וזה עדיין ההבדל
//     בין "נשלח" ל"מישהו לקח אחריות".
// ════════════════════════════════════════════════════════
import { prepare, queryAllAsync } from "./store/Repo.js";
import { DEFAULT_HOTEL_ID } from "./db.js";
import { runInTenant } from "./tenant.js";
import { withGuestLock } from "./store/index.js";
import { configFor, ensureConfigLoaded } from "./config.js";

// כמה זמן בקשה ממתינה לאישור לפני תזכורת. נדיב בכוונה: משק בית באמצע
// קומה לא אמור לקבל תזכורת אחרי שתי דקות.
export const REQUEST_ACK_MS  = Number(process.env.REQUEST_ACK_MS)  || 15 * 60_000;
// ואחרי כמה זמן זה עולה למנהל.
export const REQUEST_ESC_MS  = Number(process.env.REQUEST_ESC_MS)  || 30 * 60_000;

const createTable = prepare(`
  CREATE TABLE IF NOT EXISTS open_requests (
    id          TEXT PRIMARY KEY,
    hotel_id    TEXT NOT NULL,
    dept        TEXT NOT NULL,
    phone       TEXT,
    room        TEXT,
    guest_name  TEXT,
    summary     TEXT,
    priority    TEXT,
    at          TEXT NOT NULL,
    ack_at      TEXT,
    ack_by      TEXT,
    done_at     TEXT,
    done_by     TEXT,
    reminders   INTEGER NOT NULL DEFAULT 0
  )
`);
try { createTable.run(); } catch { /* קיימת */ }
try { prepare(`CREATE INDEX IF NOT EXISTS idx_req_open ON open_requests (hotel_id, done_at, at)`).run(); } catch {}

const insertReq  = prepare(`INSERT INTO open_requests (id, hotel_id, dept, phone, room, guest_name, summary, priority, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const ackReq     = prepare(`UPDATE open_requests SET ack_at = ?, ack_by = ? WHERE id = ? AND ack_at IS NULL`);
const doneReq    = prepare(`UPDATE open_requests SET done_at = ?, done_by = ?, ack_at = COALESCE(ack_at, ?), ack_by = COALESCE(ack_by, ?) WHERE id = ?`);
const bumpRemind = prepare(`UPDATE open_requests SET reminders = reminders + 1 WHERE id = ?`);
const getReq     = prepare(`SELECT * FROM open_requests WHERE id = ?`);

let notify = async () => {};
export function setNotifier(fn) { if (typeof fn === "function") notify = fn; }

/** פותח מעקב על בקשה שנשלחה למחלקה. מחזיר את המזהה. */
export function trackRequest({ hotelId = DEFAULT_HOTEL_ID, dept, phone = null, room = null, guestName = null, summary = "", priority = "normal" } = {}) {
  if (!dept) return null;
  const id = `req_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  try {
    insertReq.run(id, hotelId, dept, phone, room, guestName, String(summary).slice(0, 400), priority, new Date().toISOString());
  } catch (e) { console.error("פתיחת מעקב בקשה נכשלה:", e?.message || e); return null; }
  return id;
}

export async function acknowledgeRequest(id, { by = "staff" } = {}) {
  const row = await getReq.getAsync(id);
  if (!row) return { notFound: true };
  if (row.ack_at) return { alreadyAcked: true, by: row.ack_by };
  await ackReq.runAsync(new Date().toISOString(), by, id);
  return { ok: true };
}

/** סגירה — "טופל". דורשת מי, כדי שתהיה שרשרת אחריות. */
export async function completeRequest(id, { by = "staff" } = {}) {
  const row = await getReq.getAsync(id);
  if (!row) return { notFound: true };
  const now = new Date().toISOString();
  await doneReq.runAsync(now, by, now, by, id);
  return { ok: true };
}

/** הבקשות הפתוחות — זה מה שמסך "מסירת משמרת" מציג. */
export async function openRequests({ hotelId = null, limit = 100 } = {}) {
  const rows = hotelId
    ? await queryAllAsync(`SELECT * FROM open_requests WHERE hotel_id = ? AND done_at IS NULL ORDER BY at LIMIT ?`, [hotelId, limit])
    : await queryAllAsync(`SELECT * FROM open_requests WHERE done_at IS NULL ORDER BY at LIMIT ?`, [limit]);
  const now = Date.now();
  return rows.map(r => ({
    id: r.id, hotelId: r.hotel_id, dept: r.dept, room: r.room, guest: r.guest_name,
    summary: r.summary, priority: r.priority, at: r.at,
    ackedBy: r.ack_by || null,
    waitingMin: Math.round((now - new Date(r.at).getTime()) / 60_000),
    // 🔴 הדגל שמסך מסירת המשמרת קיים בשבילו.
    unacknowledged: !r.ack_at,
  }));
}

/**
 * דוח מסירת משמרת — מה שהמשמרת הנכנסת חייבת לדעת.
 *
 * 🔴 זה לא "עוד רשימה": זו רשימה שמישהו **קורא בקול** בחילופי משמרת.
 *    לכן היא ממוינת לפי מה שהכי דחוף, ולא לפי זמן.
 */
export async function shiftReport({ hotelId = null } = {}) {
  const open = await openRequests({ hotelId, limit: 200 });
  const rank = r => (r.unacknowledged ? 0 : 1) * 100 - r.waitingMin;   // לא אושר + ותיק = ראשון
  const sorted = [...open].sort((a, b) => rank(a) - rank(b));
  return {
    hotelId: hotelId || "all",
    generatedAt: new Date().toISOString(),
    open: sorted.length,
    unacknowledged: sorted.filter(r => r.unacknowledged).length,
    oldestMin: sorted.length ? Math.max(...sorted.map(r => r.waitingMin)) : 0,
    items: sorted.slice(0, 40),
  };
}

/**
 * הסורק: תזכורת למחלקה, ואז הסלמה למנהל.
 * מוגן בנעילה פר-בקשה — עם כמה עותקים, אחרת שלוש תזכורות על אותה מגבת.
 */
export async function sweepRequests(now = Date.now()) {
  let rows = [];
  try { rows = await queryAllAsync(`SELECT * FROM open_requests WHERE done_at IS NULL AND ack_at IS NULL ORDER BY at LIMIT 200`, []); }
  catch { return { scanned: 0 }; }

  let reminded = 0, escalated = 0;
  for (const r of rows) {
    const age = now - new Date(r.at).getTime();
    const target = age >= REQUEST_ESC_MS ? "escalate" : age >= REQUEST_ACK_MS ? "remind" : null;
    if (!target) continue;
    if (target === "remind" && r.reminders >= 1) continue;     // תזכורת אחת, לא נדנוד
    if (target === "escalate" && r.reminders >= 2) continue;

    await withGuestLock(`req:${r.id}`, async () => {
      const fresh = await getReq.getAsync(r.id);
      if (!fresh || fresh.ack_at || fresh.done_at) return;

      await ensureConfigLoaded(r.hotel_id);
      const mins = Math.round(age / 60_000);
      const who  = [r.room ? `חדר ${r.room}` : null, r.guest_name].filter(Boolean).join(" · ") || "אורח";

      if (target === "remind") {
        await runInTenant(r.hotel_id, () => notify({
          hotelId: r.hotel_id, dept: r.dept, phone: r.phone, roomNumber: r.room,
          guestName: r.guest_name, priority: "high",
          message: `⏳ *בקשה ממתינה ${mins} דק׳ ואיש לא אישר קבלה*\n${who}\n📝 ${r.summary}\n` +
                   `נא לאשר קבלה במסך, או לסמן כטופל.`,
        })).catch(() => {});
        reminded++;
      } else {
        // 🔴 עולה ל**קבלה** ולא לכל המלון: בקשה שנשכחה אינה חירום, אבל
        //    היא כן צריכה עין של מי שאחראי על המשמרת.
        await runInTenant(r.hotel_id, () => notify({
          hotelId: r.hotel_id, dept: "reception", phone: r.phone, roomNumber: r.room,
          guestName: r.guest_name, priority: "high",
          message: `🔴 *בקשה נשכחה — ${mins} דק׳ ללא טיפול*\n${who}\n` +
                   `📝 ${r.summary}\n🏷️ הופנתה ל: ${r.dept}\n` +
                   `האורח ממתין. נא לוודא טיפול ולסמן במסך.`,
        })).catch(() => {});
        escalated++;
      }
      await bumpRemind.runAsync(r.id);
    });
  }
  if (reminded || escalated) console.log(`🔔 בקשות פתוחות: ${reminded} תזכורות, ${escalated} הסלמות`);
  return { scanned: rows.length, reminded, escalated };
}
