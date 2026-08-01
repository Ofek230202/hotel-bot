// ════════════════════════════════════════════════════════
//  STATE — sessions persisted to SQLite (via db.js), multi-tenant
//  ----------------------------------------------------------
//  שלב 1 (persistence): הסשנים נשמרים ב-DB ושורדים ריסטארט.
//  שלב מולטי-טננט: כל סשן משויך למלון (hotelId). מפתח ה-cache הוא
//  מורכב — tenantKey(hotelId, phone) — כך שאותו מספר טלפון אצל שני
//  מלונות שונים הוא שני סשנים נפרדים לגמרי. אין התנגשות ואין דליפה
//  בין מלונות. hotelId מגיע מ-currentHotelId() (AsyncLocalStorage,
//  ראה tenant.js) כשהוא לא נמסר מפורשות — כך קוד קיים שלא מודע למלון
//  ממשיך לעבוד על מלון ברירת המחדל בדיוק כמו קודם.
//
//  ארכיטקטורה: cache חי בזיכרון (`sessions`) מגובה ל-DB בכתיבה
//  (write-through), מהודרר מה-DB בעליית התהליך. staffAlerts / incidents
//  / stats גם מתמידים. stats עטוף ב-Proxy ששומר ל-DB בכל שינוי.
//
//  ⚠️ הערת עומס-על: cache בזיכרון מגן על *תהליך בודד*. להרצה על כמה
//  תהליכים/מכונות במקביל, ה-cache צריך לעבור ל-Redis (מקור אמת משותף)
//  וה-DB ל-Postgres. ראה SCALING.md — נקודת ההחלפה מרוכזת כאן וב-db.js.
// ════════════════════════════════════════════════════════
import { v4 as uuidv4 } from "uuid";
import { db, DEFAULT_HOTEL_ID } from "./db.js";
import { currentHotelId, tenantKey } from "./tenant.js";

import { LruCache } from "./store/LruCache.js";

// ── cache הסשנים — חסום, read-through ──────────────────
// 🔴 השינוי שמסיר את תקרת הסקייל. קודם זה היה `{}` שגדל לנצח והחזיק את
//    **כל** הסשנים של **כל** המלונות; מיליון מלונות = קריסת זיכרון.
//    עכשיו: LRU חסום. אורח פעיל יושב בזיכרון, אורח שסיים מפונה, וכשהוא
//    כותב שוב הסשן נטען מה-DB. בטוח **רק** משום שהכתיבה היא write-through
//    (ראה `persist`) — כל שינוי כבר ב-DB לפני שהפינוי יכול לקרות.
//
//    ברירת המחדל 50k סשנים ~ מלונות רבים בו-זמנית; TTL של 24ש' מוודא
//    שסשן נטוש לא תופס מקום. שניהם ניתנים לכוונון ב-env.
export const sessionCache = new LruCache({
  max:   Number(process.env.SESSION_CACHE_MAX) || 50_000,
  ttlMs: Number(process.env.SESSION_CACHE_TTL_MS) || 24 * 3600_000,
});

export const staffAlerts = [];  // התראות צוות — cache חי, מגובה ל-DB
export const incidents   = [];  // יומן אירועי חירום — cache חי, מגובה ל-DB

// ── stats — מונים מתמידים (Proxy → שמירה ל-DB בכל שינוי) ─
// כרגע מונים ברמת הפריסה (aggregate), נשמרים לשורת DEFAULT_HOTEL_ID.
// מונים per-hotel לדשבורד מולטי-טננט — עבודה עתידית (ראה SCALING.md).
const ALERTS_CAP = 200, INCIDENTS_CAP = 500;
const statsData = { totalMessages: 0, checkIns: 0, checkOuts: 0, serviceRequests: 0, emergencies: 0 };
{
  const row = db.prepare(`SELECT * FROM stats WHERE hotel_id = ?`).get(DEFAULT_HOTEL_ID);
  if (row) {
    statsData.totalMessages   = row.total_messages;
    statsData.checkIns        = row.check_ins;
    statsData.checkOuts       = row.check_outs;
    statsData.serviceRequests = row.service_requests;
    statsData.emergencies     = row.emergencies;
  }
}
const persistStatsStmt = db.prepare(`
  INSERT INTO stats (hotel_id, total_messages, check_ins, check_outs, service_requests, emergencies)
  VALUES (@hotel_id, @total_messages, @check_ins, @check_outs, @service_requests, @emergencies)
  ON CONFLICT(hotel_id) DO UPDATE SET
    total_messages   = excluded.total_messages,
    check_ins        = excluded.check_ins,
    check_outs       = excluded.check_outs,
    service_requests = excluded.service_requests,
    emergencies      = excluded.emergencies
`);
function persistStats() {
  persistStatsStmt.run({
    hotel_id:         DEFAULT_HOTEL_ID,
    total_messages:   statsData.totalMessages,
    check_ins:        statsData.checkIns,
    check_outs:       statsData.checkOuts,
    service_requests: statsData.serviceRequests,
    emergencies:      statsData.emergencies,
  });
}
// Proxy: כל השמה (למשל stats.checkIns++) נשמרת מיד ל-DB.
export let stats = new Proxy(statsData, {
  set(target, prop, value) { target[prop] = value; persistStats(); return true; },
});

// הידרציה: ההתראות/אירועים האחרונים מה-DB (החדשים ביותר קודם).
for (const row of db.prepare(`SELECT data FROM alerts ORDER BY at DESC LIMIT ${ALERTS_CAP}`).all()) {
  try { staffAlerts.push(JSON.parse(row.data)); } catch { /* שורה פגומה */ }
}
for (const row of db.prepare(`SELECT data FROM incidents ORDER BY at DESC LIMIT ${INCIDENTS_CAP}`).all()) {
  try { incidents.push(JSON.parse(row.data)); } catch { /* שורה פגומה */ }
}

// ── גישת DB לסשנים (פנימי) ────────────────────────────
// כל סשן נשמר כ-JSON מלא בעמודת data; hotel_id/stage/last_active_at
// נשלפים לעמודות נפרדות לצורך סינון/מיון יעיל.
const upsertStmt = db.prepare(`
  INSERT INTO sessions (hotel_id, phone, stage, last_active_at, data)
  VALUES (@hotel_id, @phone, @stage, @last_active_at, @data)
  ON CONFLICT(hotel_id, phone) DO UPDATE SET
    stage          = excluded.stage,
    last_active_at = excluded.last_active_at,
    data           = excluded.data
`);

function persist(s) {
  upsertStmt.run({
    hotel_id:       s.hotelId || DEFAULT_HOTEL_ID,
    phone:          s.phone,
    stage:          s.stage ?? null,
    last_active_at: s.lastActiveAt ?? null,
    data:           JSON.stringify(s),
  });
}

// ── read-through: טעינת סשן בודד מה-DB ─────────────────
// 🔴 זה מה שהופך את הפינוי לבטוח. קודם **כל** הסשנים של **כל** המלונות
//    נטענו לזיכרון בעלייה ונשארו שם לנצח — מה שעובד למלון–שניים ונופל
//    במיליוני מלונות. עכשיו ה-cache חסום, וסשן שפונה נטען בחזרה מה-DB
//    בפעם הבאה שנוגעים בו. שום מידע לא אובד, כי הכתיבה היא write-through.
//
// *ריפוי* היסטוריה נעשה כאן, בטעינה: הודעה ריקה בהיסטוריה גורמת ל-400
// מול Claude בכל הודעה הבאה.
function rowToSession(row) {
  if (!row?.data) return null;
  try {
    const s = JSON.parse(row.data);
    if (!s || !s.phone) return null;
    if (!s.hotelId) s.hotelId = row.hotel_id || DEFAULT_HOTEL_ID;
    if (Array.isArray(s.history)) {
      const clean = s.history.filter(h => typeof h?.content === "string" && h.content.trim());
      if (clean.length !== s.history.length) {
        console.log(`🧹 סשן ${s.phone}@${s.hotelId}: נוקו ${s.history.length - clean.length} הודעות ריקות מההיסטוריה`);
        s.history = clean;
        persist(s);
      }
    }
    return s;
  } catch { return null; }
}

const selectSessionStmt = db.prepare(`SELECT hotel_id, phone, data FROM sessions WHERE hotel_id = ? AND phone = ?`);

// טעינה סינכרונית (SQLite). מחזירה את הסשן או null.
function loadSession(phone, hotelId) {
  try { return rowToSession(selectSessionStmt.get(hotelId, phone)); }
  catch (e) { console.error("loadSession failed:", e?.message || e); return null; }
}

/**
 * מבטיח שהסשן נמצא ב-cache. נקרא **בכניסת ההודעה** (`handleIncoming`),
 * לפני כל הקוד הסינכרוני שקורא `getSession`.
 *
 * במסלול SQLite `getSession` יודע לטעון לבד, ולכן זו רשת ביטחון בלבד;
 * במסלול Postgres (קריאה אסינכרונית) זו **הנקודה היחידה** שבה הסשן
 * נטען, ובלעדיה סשן שפונה היה נראה כאורח חדש.
 */
export async function ensureSessionLoaded(phone, hotelId = currentHotelId()) {
  const key = tenantKey(hotelId, phone);
  if (sessionCache.has(key)) return sessionCache.get(key);
  const s = loadSession(phone, hotelId);
  if (s) sessionCache.set(key, s);
  return s;
}

// ── GuestSession schema ───────────────────────────────
// טהור (Bug #2): יוצר סשן אם לא קיים, אך אינו משנה מונים/זמנים.
// hotelId מבודד את הסשן למלון; ברירת מחדל — המלון של ההקשר הנוכחי.
export function getSession(phone, hotelId = currentHotelId()) {
  const key = tenantKey(hotelId, phone);
  let cached = sessionCache.get(key);

  // 🔴 read-through: החטאה ב-cache אינה "אורח חדש". הסשן עשוי להיות
  //    ב-DB ורק פונה מהזיכרון — יצירת סשן חדש כאן הייתה **מוחקת לאורח
  //    את ההיסטוריה באמצע שיחה**. לכן מנסים לטעון לפני שיוצרים.
  if (!cached) {
    const loaded = loadSession(phone, hotelId);
    if (loaded) { sessionCache.set(key, loaded); cached = loaded; }
  }

  if (!cached) {
    const s = {
      id:            uuidv4(),
      phone,
      hotelId,                       // ← שיוך המלון, על הסשן עצמו
      lang:          null,          // detected: "he" | "en"
      stage:         "new",         // new | active | checked_in | checked_out
      guestName:     null,
      roomNumber:    null,
      reservationId: null,
      checkInAt:     null,
      checkOutAt:    null,
      history:       [],            // Claude message history
      requests:      [],            // service requests log
      createdAt:     new Date().toISOString(),
      lastActiveAt:  new Date().toISOString(),
      messageCount:  0,
      sentiment:     "neutral",     // positive | neutral | negative
    };
    sessionCache.set(key, s);
    persist(s);
    return s;
  }
  return cached;
}

// מציץ בסשן קיים בלי ליצור חדש (undefined אם אין). משמש היכן שיצירת
// סשן היא תופעת לוואי לא רצויה (למשל קריאת lang בטיפול בשגיאה).
// גם כאן read-through — אחרת "אין סשן" היה תלוי בשאלה אם הוא פונה,
// והתנהגות המערכת הייתה משתנה לפי מצב הזיכרון.
export function peekSession(phone, hotelId = currentHotelId()) {
  const key = tenantKey(hotelId, phone);
  const hit = sessionCache.get(key);
  if (hit) return hit;
  const loaded = loadSession(phone, hotelId);
  if (loaded) sessionCache.set(key, loaded);
  return loaded || undefined;
}

// ── רישום פעילות של הודעה נכנסת ────────────────────────
export function recordActivity(phone, hotelId = currentHotelId()) {
  const s = getSession(phone, hotelId);
  s.lastActiveAt = new Date().toISOString();
  s.messageCount++;
  stats.totalMessages++;
  persist(s);
  return s;
}

// ── היסטוריית השיחה — לעולם לא ריקה (הגנה בעומק, Bug #2) ──
export function pushHistory(phone, role, content, hotelId = currentHotelId()) {
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) {
    console.error(`⚠️ pushHistory: ניסיון להוסיף הודעת ${role} ריקה (${phone}) — נחסם.`);
    return;
  }
  const s = getSession(phone, hotelId);
  s.history.push({ role, content: text });
  if (s.history.length > 30) s.history = s.history.slice(-30);
  persist(s);
}

export function patchSession(phone, patch, hotelId = currentHotelId()) {
  const s = getSession(phone, hotelId);
  Object.assign(s, patch);
  persist(s);
}

// ── מחיקת סשן (reset) — מהזיכרון וגם מה-DB ─────────────
export function deleteSession(phone, hotelId = currentHotelId()) {
  const key = tenantKey(hotelId, phone);
  // "היה קיים" נקבע מול ה-DB ולא מול ה-cache: סשן שפונה מהזיכרון עדיין
  // קיים, ודיווח "לא היה" היה שקר שתלוי במצב הזיכרון.
  const existed = sessionCache.has(key) || !!loadSession(phone, hotelId);
  sessionCache.delete(key);
  db.prepare(`DELETE FROM sessions WHERE hotel_id = ? AND phone = ?`).run(hotelId, phone);
  return existed;
}

// ── איפוס כל הסשנים (כל המלונות) — מהזיכרון וגם מה-DB ───
export function clearAllSessions() {
  // נספר מול ה-DB ולא מול ה-cache: אחרי פינוי, הספירה בזיכרון קטנה
  // מהאמת, והדיווח "אופסו N סשנים" היה שגוי.
  let count = 0;
  try { count = db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get()?.n || 0; } catch { /* ignore */ }
  sessionCache.clear();
  db.prepare(`DELETE FROM sessions`).run();
  return count;
}

/** מספר הסשנים הקיימים (מקור אמת: ה-DB, לא ה-cache). */
export function sessionCount(hotelId = null) {
  try {
    const row = hotelId
      ? db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE hotel_id = ?`).get(hotelId)
      : db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get();
    return row?.n || 0;
  } catch { return sessionCache.size; }
}

/** מצב ה-cache — לניטור ולדשבורד. */
export function sessionCacheInfo() { return sessionCache.info(); }

const insertAlertStmt = db.prepare(
  `INSERT INTO alerts (id, hotel_id, dept, priority, at, data) VALUES (?, ?, ?, ?, ?, ?)`
);
const pruneAlertsStmt = db.prepare(
  `DELETE FROM alerts WHERE hotel_id = ? AND id NOT IN (
     SELECT id FROM alerts WHERE hotel_id = ? ORDER BY at DESC LIMIT ${ALERTS_CAP})`
);
export function logAlert(alert) {
  const hotelId = alert.hotelId || currentHotelId();
  const rec = { ...alert, hotelId, id: uuidv4(), at: new Date().toISOString() };
  staffAlerts.unshift(rec);
  if (staffAlerts.length > ALERTS_CAP) staffAlerts.pop();
  insertAlertStmt.run(rec.id, hotelId, rec.dept ?? null, rec.priority ?? null, rec.at, JSON.stringify(rec));
  pruneAlertsStmt.run(hotelId, hotelId);
  return rec;
}

// ── Emergency incident log ────────────────────────────
const insertIncidentStmt = db.prepare(
  `INSERT INTO incidents (id, hotel_id, status, at, data) VALUES (?, ?, ?, ?, ?)`
);
const pruneIncidentsStmt = db.prepare(
  `DELETE FROM incidents WHERE hotel_id = ? AND id NOT IN (
     SELECT id FROM incidents WHERE hotel_id = ? ORDER BY at DESC LIMIT ${INCIDENTS_CAP})`
);
export function logIncident(incident) {
  const hotelId = incident.hotelId || currentHotelId();
  const rec = { ...incident, hotelId, id: uuidv4(), at: new Date().toISOString(), status: incident.status || "open" };
  incidents.unshift(rec);
  if (incidents.length > INCIDENTS_CAP) incidents.pop();
  insertIncidentStmt.run(rec.id, hotelId, rec.status, rec.at, JSON.stringify(rec));
  pruneIncidentsStmt.run(hotelId, hotelId);
  stats.emergencies++; // דרך ה-Proxy → נשמר ל-DB
  return rec;
}

// כל הסשנים (בכל המלונות), החדשים בפעילות קודם. אופציונלית לפי מלון.
//
// 🔴 שואל את ה-DB ולא את ה-cache. אחרי הפינוי, סריקת הזיכרון הייתה
//    מחזירה רק את מי שפעיל *כרגע* — כלומר הדשבורד היה מציג חלק שרירותי
//    מהאורחים ונראה כאילו אורחים נעלמו.
//    `limit` מגן על דשבורד של מיליוני סשנים.
export function allSessions(hotelId = null, { limit = 500 } = {}) {
  try {
    const rows = hotelId
      ? db.prepare(`SELECT hotel_id, phone, data FROM sessions WHERE hotel_id = ?
                     ORDER BY last_active_at DESC LIMIT ?`).all(hotelId, limit)
      : db.prepare(`SELECT hotel_id, phone, data FROM sessions
                     ORDER BY last_active_at DESC LIMIT ?`).all(limit);
    return rows.map(rowToSession).filter(Boolean);
  } catch (e) {
    console.error("allSessions failed:", e?.message || e);
    // נפילה חיננית: לפחות מה שחם בזיכרון, כדי שהדשבורד לא יישבר.
    let list = sessionCache.values();
    if (hotelId) list = list.filter(s => (s.hotelId || DEFAULT_HOTEL_ID) === hotelId);
    return list.sort((a, b) => new Date(b.lastActiveAt) - new Date(a.lastActiveAt));
  }
}

// ── מציאת סשן לפי מספר חדר (Part ו') ───────────────────
// מנהל/קבלה נכנסים לשיחה של חדר מסוים: החדר → הסשן → הטלפון וההיסטוריה.
// אם אותו חדר אוכלס יותר מפעם אחת (אורח קודם + נוכחי) — מחזירים את הפעיל
// בפעילות האחרונה. סינון אופציונלי לפי מלון (בידוד מולטי-טננט).
export function sessionByRoom(room, hotelId = null) {
  const key = String(room);
  // מול ה-DB: אורח ששוהה בחדר אך לא כתב לאחרונה עשוי להיות מפונה
  // מהזיכרון — והקבלה הייתה מקבלת "לא נמצא" על אורח שקיים.
  try {
    const rows = hotelId
      ? db.prepare(`SELECT hotel_id, phone, data FROM sessions WHERE hotel_id = ?
                     ORDER BY last_active_at DESC LIMIT 2000`).all(hotelId)
      : db.prepare(`SELECT hotel_id, phone, data FROM sessions
                     ORDER BY last_active_at DESC LIMIT 2000`).all();
    for (const row of rows) {
      const s = rowToSession(row);
      if (s && String(s.roomNumber) === key) return s;
    }
    return null;
  } catch (e) {
    console.error("sessionByRoom failed:", e?.message || e);
    return sessionCache.values()
      .filter(s => String(s.roomNumber) === key && (!hotelId || (s.hotelId || DEFAULT_HOTEL_ID) === hotelId))
      .sort((a, b) => new Date(b.lastActiveAt) - new Date(a.lastActiveAt))[0] || null;
  }
}
