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
import { db, DEFAULT_HOTEL_ID, isPostgres } from "./db.js";
import { prepare } from "./store/Repo.js";
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
const selectStatsStmt = prepare(`SELECT * FROM stats WHERE hotel_id = ?`);

function applyStatsRow(row) {
  if (!row) return;
  statsData.totalMessages   = Number(row.total_messages)   || 0;
  statsData.checkIns        = Number(row.check_ins)        || 0;
  statsData.checkOuts       = Number(row.check_outs)       || 0;
  statsData.serviceRequests = Number(row.service_requests) || 0;
  statsData.emergencies     = Number(row.emergencies)      || 0;
}

const persistStatsStmt = prepare(`
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

// ── הידרציה: ההתראות/אירועים האחרונים (החדשים ביותר קודם) ─
// 🔴 למה זו פונקציה ולא קוד ברמת המודול: ייבוא המודול קורה **לפני**
//    ש-`initPersistence()` מזריק את דרייבר ה-Postgres, ולכן הידרציה
//    ברמת המודול הייתה קוראת תמיד מ-SQLite — כלומר בענן היא הייתה
//    מחזירה רשימה ריקה, בשקט, בלי שאיש ידע שהתראות אבדו.
const selectAlertsStmt    = prepare(`SELECT data FROM alerts ORDER BY at DESC LIMIT ${ALERTS_CAP}`);
const selectIncidentsStmt = prepare(`SELECT data FROM incidents ORDER BY at DESC LIMIT ${INCIDENTS_CAP}`);

function fill(target, rows) {
  target.length = 0;
  for (const row of rows) {
    try { target.push(JSON.parse(row.data)); } catch { /* שורה פגומה */ }
  }
}

// במסלול SQLite ההידרציה קורית מיד בייבוא, בדיוק כמו קודם — כך שכל
// קוד (ובדיקה) שקורא `stats`/`staffAlerts` מיד אחרי import לא משתנה.
//
// 🔴 ובמסלול Postgres — **מדלגים**. בדרך כלל המודול נטען לפני
//    `initPersistence`, אבל לא תמיד (`await import(...)` עצל, בדיקה,
//    סקריפט תחזוקה), ואז הקריאה הסינכרונית זורקת ומפילה את הייבוא עצמו.
//    ההידרציה האמיתית שם היא `hydrateState()`, שנקראת אחרי בחירת ה-DB.
if (!isPostgres()) {
  applyStatsRow(selectStatsStmt.get(DEFAULT_HOTEL_ID));
  fill(staffAlerts, selectAlertsStmt.all());
  fill(incidents,   selectIncidentsStmt.all());
}

/**
 * הידרציה מחדש **אחרי** שנבחר מסד הנתונים. `server.js` קורא לזה מיד
 * אחרי `initPersistence()`. במסלול SQLite זו פעולה חוזרת ולא מזיקה.
 */
export async function hydrateState() {
  applyStatsRow(await selectStatsStmt.getAsync(DEFAULT_HOTEL_ID));
  fill(staffAlerts, await selectAlertsStmt.allAsync());
  fill(incidents,   await selectIncidentsStmt.allAsync());
  return { alerts: staffAlerts.length, incidents: incidents.length };
}

// ── גישת DB לסשנים (פנימי) ────────────────────────────
// כל סשן נשמר כ-JSON מלא בעמודת data; hotel_id/stage/last_active_at
// נשלפים לעמודות נפרדות לצורך סינון/מיון יעיל.
const upsertStmt = prepare(`
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

const selectSessionStmt = prepare(`SELECT hotel_id, phone, data FROM sessions WHERE hotel_id = ? AND phone = ?`);

// טעינה סינכרונית — SQLite בלבד. במסלול Postgres היא **זורקת** במכוון
// (`SyncReadUnavailable`), ולכן `getSession` מטפל בכך: ראה ההערה שם.
function loadSession(phone, hotelId) {
  try { return rowToSession(selectSessionStmt.get(hotelId, phone)); }
  catch (e) {
    if (e?.name === "SyncReadUnavailable") throw e;
    console.error("loadSession failed:", e?.message || e);
    return null;
  }
}

// טעינה אסינכרונית — עובדת בשני המסלולים.
async function loadSessionAsync(phone, hotelId) {
  try { return rowToSession(await selectSessionStmt.getAsync(hotelId, phone)); }
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
  const s = await loadSessionAsync(phone, hotelId);
  if (s) { sessionCache.set(key, s); confirmedAbsent.delete(key); }
  else confirmedAbsent.add(key);   // ← ראה `confirmedAbsent`
  return s;
}

// ── "נבדק ואינו קיים" ──────────────────────────────────
// 🔴 בלי זה, אורח **חדש לגמרי** לא יכול להיווצר במסלול Postgres: החטאה
//    ב-cache גורמת ל-`getSession` לנסות לטעון, הטעינה הסינכרונית זורקת,
//    וההודעה הראשונה של האורח נכשלת. אבל אסור גם פשוט ליצור סשן חדש
//    בהחטאה — זה בדיוק אובדן ההיסטוריה שממנו נזהרנו.
//
//    ההבחנה: `ensureSessionLoaded` **כן** בדק את ה-DB. אם לא מצא, זהו
//    באמת אורח חדש, וסימון כאן מרשה ל-`getSession` ליצור בלי לשאול שוב.
//    כל יצירה/מחיקה מנקה את הסימון, כדי שהוא לעולם לא יהפוך לתשובה ישנה.
const confirmedAbsent = new Set();

// ── GuestSession schema ───────────────────────────────
// טהור (Bug #2): יוצר סשן אם לא קיים, אך אינו משנה מונים/זמנים.
// hotelId מבודד את הסשן למלון; ברירת מחדל — המלון של ההקשר הנוכחי.
export function getSession(phone, hotelId = currentHotelId()) {
  const key = tenantKey(hotelId, phone);
  let cached = sessionCache.get(key);

  // 🔴 read-through: החטאה ב-cache אינה "אורח חדש". הסשן עשוי להיות
  //    ב-DB ורק פונה מהזיכרון — יצירת סשן חדש כאן הייתה **מוחקת לאורח
  //    את ההיסטוריה באמצע שיחה**. לכן מנסים לטעון לפני שיוצרים.
  if (!cached && !confirmedAbsent.has(key)) {
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
    confirmedAbsent.delete(key);   // מעכשיו הוא קיים
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
  if (confirmedAbsent.has(key)) return undefined;
  const loaded = loadSession(phone, hotelId);
  if (loaded) sessionCache.set(key, loaded);
  return loaded || undefined;
}

/** peek שעובד גם מול Postgres. */
export async function peekSessionAsync(phone, hotelId = currentHotelId()) {
  const key = tenantKey(hotelId, phone);
  const hit = sessionCache.get(key);
  if (hit) return hit;
  const loaded = await loadSessionAsync(phone, hotelId);
  if (loaded) { sessionCache.set(key, loaded); confirmedAbsent.delete(key); }
  else confirmedAbsent.add(key);
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
  const existed = sessionCache.has(key) || (!confirmedAbsent.has(key) && !!loadSession(phone, hotelId));
  sessionCache.delete(key);
  confirmedAbsent.add(key);   // נמחק = ידוע שאינו קיים
  deleteSessionStmt.run(hotelId, phone);
  return existed;
}

const deleteSessionStmt = prepare(`DELETE FROM sessions WHERE hotel_id = ? AND phone = ?`);
const deleteAllStmt     = prepare(`DELETE FROM sessions`);
const countAllStmt      = prepare(`SELECT COUNT(*) AS n FROM sessions`);
const countHotelStmt    = prepare(`SELECT COUNT(*) AS n FROM sessions WHERE hotel_id = ?`);

/** מחיקת סשן שעובדת גם מול Postgres (מסלול אסינכרוני). */
export async function deleteSessionAsync(phone, hotelId = currentHotelId()) {
  const key = tenantKey(hotelId, phone);
  const existed = sessionCache.has(key) || !!(await loadSessionAsync(phone, hotelId));
  sessionCache.delete(key);
  confirmedAbsent.add(key);
  await deleteSessionStmt.runAsync(hotelId, phone);
  return existed;
}

// ── איפוס כל הסשנים (כל המלונות) — מהזיכרון וגם מה-DB ───
export async function clearAllSessions() {
  // נספר מול ה-DB ולא מול ה-cache: אחרי פינוי, הספירה בזיכרון קטנה
  // מהאמת, והדיווח "אופסו N סשנים" היה שגוי.
  let count = 0;
  try { count = (await countAllStmt.getAsync())?.n || 0; } catch { /* ignore */ }
  sessionCache.clear();
  confirmedAbsent.clear();   // אחרי איפוס גורף אין ידע קודם על אף אחד
  await deleteAllStmt.runAsync();
  return count;
}

/**
 * מספר הסשנים הקיימים (מקור אמת: ה-DB, לא ה-cache).
 *
 * ⚠️ הגרסה הסינכרונית עובדת ב-SQLite בלבד; ב-Postgres היא נופלת ל-cache
 * ומחזירה **פחות** מהאמת. לדשבורד ולניטור יש להשתמש ב-`sessionCountAsync`.
 */
export function sessionCount(hotelId = null) {
  try {
    const row = hotelId ? countHotelStmt.get(hotelId) : countAllStmt.get();
    return row?.n || 0;
  } catch { return sessionCache.size; }
}

export async function sessionCountAsync(hotelId = null) {
  try {
    const row = hotelId ? await countHotelStmt.getAsync(hotelId) : await countAllStmt.getAsync();
    return row?.n || 0;
  } catch { return sessionCache.size; }
}

/** מצב ה-cache — לניטור ולדשבורד. */
export function sessionCacheInfo() { return sessionCache.info(); }

const insertAlertStmt = prepare(
  `INSERT INTO alerts (id, hotel_id, dept, priority, at, data) VALUES (?, ?, ?, ?, ?, ?)`
);
const pruneAlertsStmt = prepare(
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
const insertIncidentStmt = prepare(
  `INSERT INTO incidents (id, hotel_id, status, at, data) VALUES (?, ?, ?, ?, ?)`
);
const pruneIncidentsStmt = prepare(
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

// ── עדכון אירוע קיים (אישור קבלה / הסלמה / סגירה) ──────
// 🔴 האירוע חייב להתעדכן **גם ב-DB ולא רק בזיכרון**: סולם ההסלמה נשען על
//    `ackDeadline` שנקרא מה-DB אחרי ריסטארט. אירוע שאושר בזיכרון בלבד היה
//    מוסלם שוב אחרי עלייה מחדש — צוות שמקבל אזעקה חוזרת על אירוע סגור
//    מפסיק להאמין להתראות, וזה הנזק הגרוע ביותר במערכת בטיחות.
const updateIncidentStmt = prepare(`UPDATE incidents SET status = ?, data = ? WHERE id = ?`);
const selectIncidentStmt = prepare(`SELECT data FROM incidents WHERE id = ?`);

export function getIncident(id) {
  const hot = incidents.find(i => i.id === id);
  if (hot) return hot;
  try {
    const row = selectIncidentStmt.get(id);
    return row?.data ? JSON.parse(row.data) : null;
  } catch { return null; }
}

export async function getIncidentAsync(id) {
  const hot = incidents.find(i => i.id === id);
  if (hot) return hot;
  try {
    const row = await selectIncidentStmt.getAsync(id);
    return row?.data ? JSON.parse(row.data) : null;
  } catch { return null; }
}

/** ממזג שדות לאירוע ושומר. מחזיר את הרשומה המעודכנת, או null אם אין. */
export function updateIncident(id, patch = {}) {
  const cur = getIncident(id);
  if (!cur) return null;
  const next = { ...cur, ...patch, id: cur.id, hotelId: cur.hotelId, at: cur.at };
  const idx = incidents.findIndex(i => i.id === id);
  if (idx >= 0) incidents[idx] = next; else incidents.unshift(next);
  updateIncidentStmt.run(next.status || "open", JSON.stringify(next), id);
  return next;
}

/** אירועים שממתינים לאישור קבלה ועבר זמנם — הדלק של סולם ההסלמה. */
const overdueIncidentsStmt = prepare(
  `SELECT data FROM incidents WHERE status = 'open' ORDER BY at DESC LIMIT ${INCIDENTS_CAP}`
);

export async function findUnacknowledgedIncidents(now = new Date()) {
  let rows = [];
  try { rows = await overdueIncidentsStmt.allAsync(); } catch { return []; }
  const out = [];
  for (const row of rows) {
    try {
      const inc = JSON.parse(row.data);
      if (inc.ackAt || !inc.ackDeadline) continue;
      if (new Date(inc.ackDeadline) <= now) out.push(inc);
    } catch { /* שורה פגומה */ }
  }
  return out;
}

// כל הסשנים (בכל המלונות), החדשים בפעילות קודם. אופציונלית לפי מלון.
//
// 🔴 שואל את ה-DB ולא את ה-cache. אחרי הפינוי, סריקת הזיכרון הייתה
//    מחזירה רק את מי שפעיל *כרגע* — כלומר הדשבורד היה מציג חלק שרירותי
//    מהאורחים ונראה כאילו אורחים נעלמו.
//    `limit` מגן על דשבורד של מיליוני סשנים.
const listByHotelStmt = prepare(`SELECT hotel_id, phone, data FROM sessions WHERE hotel_id = ?
                                  ORDER BY last_active_at DESC LIMIT ?`);
const listAllStmt     = prepare(`SELECT hotel_id, phone, data FROM sessions
                                  ORDER BY last_active_at DESC LIMIT ?`);

// נפילה חיננית משותפת: לפחות מה שחם בזיכרון, כדי שהדשבורד לא יישבר.
function sessionsFromCache(hotelId) {
  let list = sessionCache.values();
  if (hotelId) list = list.filter(s => (s.hotelId || DEFAULT_HOTEL_ID) === hotelId);
  return list.sort((a, b) => new Date(b.lastActiveAt) - new Date(a.lastActiveAt));
}

export function allSessions(hotelId = null, { limit = 500 } = {}) {
  try {
    const rows = hotelId ? listByHotelStmt.all(hotelId, limit) : listAllStmt.all(limit);
    return rows.map(rowToSession).filter(Boolean);
  } catch (e) {
    console.error("allSessions failed:", e?.message || e);
    return sessionsFromCache(hotelId);
  }
}

/** גרסה שעובדת גם מול Postgres. הדשבורד משתמש בזו. */
export async function allSessionsAsync(hotelId = null, { limit = 500 } = {}) {
  try {
    const rows = hotelId ? await listByHotelStmt.allAsync(hotelId, limit) : await listAllStmt.allAsync(limit);
    return rows.map(rowToSession).filter(Boolean);
  } catch (e) {
    console.error("allSessions failed:", e?.message || e);
    return sessionsFromCache(hotelId);
  }
}

// ── מציאת סשן לפי מספר חדר (Part ו') ───────────────────
// מנהל/קבלה נכנסים לשיחה של חדר מסוים: החדר → הסשן → הטלפון וההיסטוריה.
// אם אותו חדר אוכלס יותר מפעם אחת (אורח קודם + נוכחי) — מחזירים את הפעיל
// בפעילות האחרונה. סינון אופציונלי לפי מלון (בידוד מולטי-טננט).
const ROOM_SCAN_LIMIT = 2000;

function pickRoom(rows, key) {
  for (const row of rows) {
    const s = rowToSession(row);
    if (s && String(s.roomNumber) === key) return s;
  }
  return null;
}

function roomFromCache(key, hotelId) {
  return sessionCache.values()
    .filter(s => String(s.roomNumber) === key && (!hotelId || (s.hotelId || DEFAULT_HOTEL_ID) === hotelId))
    .sort((a, b) => new Date(b.lastActiveAt) - new Date(a.lastActiveAt))[0] || null;
}

export function sessionByRoom(room, hotelId = null) {
  const key = String(room);
  // מול ה-DB: אורח ששוהה בחדר אך לא כתב לאחרונה עשוי להיות מפונה
  // מהזיכרון — והקבלה הייתה מקבלת "לא נמצא" על אורח שקיים.
  try {
    return pickRoom(
      hotelId ? listByHotelStmt.all(hotelId, ROOM_SCAN_LIMIT) : listAllStmt.all(ROOM_SCAN_LIMIT),
      key,
    );
  } catch (e) {
    console.error("sessionByRoom failed:", e?.message || e);
    return roomFromCache(key, hotelId);
  }
}

export async function sessionByRoomAsync(room, hotelId = null) {
  const key = String(room);
  try {
    return pickRoom(
      hotelId ? await listByHotelStmt.allAsync(hotelId, ROOM_SCAN_LIMIT)
              : await listAllStmt.allAsync(ROOM_SCAN_LIMIT),
      key,
    );
  } catch (e) {
    console.error("sessionByRoom failed:", e?.message || e);
    return roomFromCache(key, hotelId);
  }
}
