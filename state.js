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

// ה-cache מפתוח לפי tenantKey(hotelId, phone). server.js משתמש ב-
// Object.keys(sessions).length כמונה סשנים פעילים (בכל המלונות) — עדיין תקף.
export const sessions    = {};  // tenantKey → GuestSession (cache חי, מגובה ל-DB)
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

// ── הידרציה: טעינת כל הסשנים (כל המלונות) ל-cache ──────
// כולל *ריפוי* של סשנים שנפגעו: הודעה ריקה בהיסטוריה גורמת ל-400 מול
// Claude בכל הודעה הבאה — מנקים אותן כאן פעם אחת.
for (const row of db.prepare(`SELECT hotel_id, phone, data FROM sessions`).all()) {
  try {
    const s = JSON.parse(row.data);
    if (!s || !s.phone) continue;
    if (!s.hotelId) s.hotelId = row.hotel_id || DEFAULT_HOTEL_ID;
    const key = tenantKey(s.hotelId, s.phone);
    if (Array.isArray(s.history)) {
      const clean = s.history.filter(h => typeof h?.content === "string" && h.content.trim());
      if (clean.length !== s.history.length) {
        console.log(`🧹 סשן ${s.phone}@${s.hotelId}: נוקו ${s.history.length - clean.length} הודעות ריקות מההיסטוריה`);
        s.history = clean;
        sessions[key] = s;
        persist(s);
        continue;
      }
    }
    sessions[key] = s;
  } catch { /* שורה פגומה — מדלגים */ }
}

// ── GuestSession schema ───────────────────────────────
// טהור (Bug #2): יוצר סשן אם לא קיים, אך אינו משנה מונים/זמנים.
// hotelId מבודד את הסשן למלון; ברירת מחדל — המלון של ההקשר הנוכחי.
export function getSession(phone, hotelId = currentHotelId()) {
  const key = tenantKey(hotelId, phone);
  if (!sessions[key]) {
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
    sessions[key] = s;
    persist(s);
  }
  return sessions[key];
}

// מציץ בסשן קיים בלי ליצור חדש (undefined אם אין). משמש היכן שיצירת
// סשן היא תופעת לוואי לא רצויה (למשל קריאת lang בטיפול בשגיאה).
export function peekSession(phone, hotelId = currentHotelId()) {
  return sessions[tenantKey(hotelId, phone)];
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
  const existed = !!sessions[key];
  delete sessions[key];
  db.prepare(`DELETE FROM sessions WHERE hotel_id = ? AND phone = ?`).run(hotelId, phone);
  return existed;
}

// ── איפוס כל הסשנים (כל המלונות) — מהזיכרון וגם מה-DB ───
export function clearAllSessions() {
  const count = Object.keys(sessions).length;
  for (const k of Object.keys(sessions)) delete sessions[k];
  db.prepare(`DELETE FROM sessions`).run();
  return count;
}

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
export function allSessions(hotelId = null) {
  let list = Object.values(sessions);
  if (hotelId) list = list.filter(s => (s.hotelId || DEFAULT_HOTEL_ID) === hotelId);
  return list.sort((a, b) => new Date(b.lastActiveAt) - new Date(a.lastActiveAt));
}
