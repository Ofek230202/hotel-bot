// ════════════════════════════════════════════════════════
//  STATE — sessions persisted to SQLite (via db.js)
//  ----------------------------------------------------------
//  שלב 1 (persistence): הסשנים נשמרים עכשיו ב-DB ושורדים ריסטארט.
//
//  ארכיטקטורה: cache חי בזיכרון (`sessions`) שמגובה ל-DB בכתיבה
//  (write-through). כל קריאה/פאטצ' מעדכנת גם את הזיכרון וגם את ה-DB;
//  בעליית התהליך ה-cache מהודרר מה-DB. כך כל הקוד שקורא ישירות
//  ל-sessions[phone] (bot.js / checkin.js / checkin-routes.js) ממשיך
//  לעבוד בלי שינוי — אותה הפניה חיה — אבל המידע כבר לא נמחק בריסטארט.
//
//  שלב 3: staffAlerts / incidents / stats גם הם מתמידים (persistent) —
//  cache חי בזיכרון (לקריאות ישירות) מגובה ל-DB, ומהודרר בעליית התהליך.
//  stats עטוף ב-Proxy ששומר ל-DB בכל שינוי, כדי ש-stats.checkIns++
//  בקבצים אחרים ימשיך לעבוד בלי שינוי וגם יישמר.
// ════════════════════════════════════════════════════════
import { v4 as uuidv4 } from "uuid";
import { db, DEFAULT_HOTEL_ID } from "./db.js";

const HOTEL = DEFAULT_HOTEL_ID;

export const sessions    = {};  // phone → GuestSession (cache חי, מגובה ל-DB)
export const staffAlerts = [];  // התראות צוות — cache חי, מגובה ל-DB
export const incidents   = [];  // יומן אירועי חירום — cache חי, מגובה ל-DB

// ── stats — מונים מתמידים (Proxy → שמירה ל-DB בכל שינוי) ─
const ALERTS_CAP = 200, INCIDENTS_CAP = 500;
const statsData = { totalMessages: 0, checkIns: 0, checkOuts: 0, serviceRequests: 0, emergencies: 0 };
{
  const row = db.prepare(`SELECT * FROM stats WHERE hotel_id = ?`).get(HOTEL);
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
    hotel_id:         HOTEL,
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
for (const row of db.prepare(`SELECT data FROM alerts WHERE hotel_id = ? ORDER BY at DESC LIMIT ${ALERTS_CAP}`).all(HOTEL)) {
  try { staffAlerts.push(JSON.parse(row.data)); } catch { /* שורה פגומה */ }
}
for (const row of db.prepare(`SELECT data FROM incidents WHERE hotel_id = ? ORDER BY at DESC LIMIT ${INCIDENTS_CAP}`).all(HOTEL)) {
  try { incidents.push(JSON.parse(row.data)); } catch { /* שורה פגומה */ }
}

// ── גישת DB לסשנים (פנימי) ────────────────────────────
// כל סשן נשמר כ-JSON מלא בעמודת data; stage ו-last_active_at נשלפים
// לעמודות נפרדות לצורך סינון/מיון יעיל.
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
    hotel_id:       HOTEL,
    phone:          s.phone,
    stage:          s.stage ?? null,
    last_active_at: s.lastActiveAt ?? null,
    data:           JSON.stringify(s),
  });
}

// ── הידרציה: טעינת כל הסשנים מה-DB ל-cache בעליית התהליך ──
// כולל *ריפוי* של סשנים שנפגעו: הודעה ריקה בהיסטוריה גורמת ל-400 מול
// Claude בכל הודעה הבאה, ומכיוון שההיסטוריה נשמרת ב-DB — האורח נשאר
// תקוע גם אחרי ריסטארט. מנקים את הרשומות הריקות כאן, פעם אחת, כדי
// לשחרר סשנים שכבר נשברו בשטח לפני התיקון (Bug #2).
for (const row of db.prepare(`SELECT data FROM sessions WHERE hotel_id = ?`).all(HOTEL)) {
  try {
    const s = JSON.parse(row.data);
    if (!s || !s.phone) continue;
    if (Array.isArray(s.history)) {
      const clean = s.history.filter(h => typeof h?.content === "string" && h.content.trim());
      if (clean.length !== s.history.length) {
        console.log(`🧹 סשן ${s.phone}: נוקו ${s.history.length - clean.length} הודעות ריקות מההיסטוריה`);
        s.history = clean;
        sessions[s.phone] = s;
        persist(s);
        continue;
      }
    }
    sessions[s.phone] = s;
  } catch { /* שורה פגומה — מדלגים */ }
}

// ── GuestSession schema ───────────────────────────────
// טהור (Bug #2): יוצר סשן אם לא קיים, אך אינו משנה מונים/זמנים.
// עדכון הפעילות (messageCount / lastActiveAt) עבר ל-recordActivity,
// שנקראת פעם אחת לכל הודעה נכנסת.
export function getSession(phone) {
  if (!sessions[phone]) {
    const s = {
      id:            uuidv4(),
      phone,
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
    sessions[phone] = s;
    persist(s);
  }
  return sessions[phone];
}

// ── רישום פעילות של הודעה נכנסת ────────────────────────
// נקראת פעם אחת לכל הודעה (מ-handleIncoming). מרכזת את תופעות-הלוואי
// שהיו בעבר ב-getSession — כדי שהמונה יהיה אמין ולא יזחל בכל קריאה.
export function recordActivity(phone) {
  const s = getSession(phone);
  s.lastActiveAt = new Date().toISOString();
  s.messageCount++;
  stats.totalMessages++;
  persist(s);
  return s;
}

// ── היסטוריית השיחה — לעולם לא ריקה (הגנה בעומק, Bug #2) ──
// ה-API של Claude דוחה content ריק ב-400. מכיוון שההיסטוריה נשמרת
// ל-DB, רשומה ריקה אחת "הורגת" את השיחה של האורח לתמיד — גם אחרי
// ריסטארט. לכן פשוט לא מכניסים רשומות ריקות, מאיזה קורא שלא יהיה.
export function pushHistory(phone, role, content) {
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) {
    console.error(`⚠️ pushHistory: ניסיון להוסיף הודעת ${role} ריקה (${phone}) — נחסם.`);
    return;
  }
  const s = getSession(phone);
  s.history.push({ role, content: text });
  if (s.history.length > 30) s.history = s.history.slice(-30);
  persist(s);
}

export function patchSession(phone, patch) {
  const s = getSession(phone);
  Object.assign(s, patch);
  persist(s);
}

// ── מחיקת סשן (reset) — מהזיכרון וגם מה-DB ─────────────
// מחזירה true אם הסשן היה קיים. משמש את endpoints של האיפוס ב-server.js
// כדי שהמחיקה תשרוד ריסטארט (אחרת הסשן היה חוזר מה-DB).
export function deleteSession(phone) {
  const existed = !!sessions[phone];
  delete sessions[phone];
  db.prepare(`DELETE FROM sessions WHERE hotel_id = ? AND phone = ?`).run(HOTEL, phone);
  return existed;
}

// ── איפוס כל הסשנים — מהזיכרון וגם מה-DB ───────────────
// מחזירה את מספר הסשנים שנמחקו.
export function clearAllSessions() {
  const count = Object.keys(sessions).length;
  for (const k of Object.keys(sessions)) delete sessions[k];
  db.prepare(`DELETE FROM sessions WHERE hotel_id = ?`).run(HOTEL);
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
  const rec = { ...alert, id: uuidv4(), at: new Date().toISOString() };
  staffAlerts.unshift(rec);
  if (staffAlerts.length > ALERTS_CAP) staffAlerts.pop();
  insertAlertStmt.run(rec.id, HOTEL, rec.dept ?? null, rec.priority ?? null, rec.at, JSON.stringify(rec));
  pruneAlertsStmt.run(HOTEL, HOTEL);
  return rec;
}

// ── Emergency incident log ────────────────────────────
// תיעוד מובנה של כל אירוע חירום — נשמר בנפרד מהתראות הרגילות
// כדי שיהיה ניתן לעקוב, לבדוק שטופל, ולתחקר בדיעבד.
const insertIncidentStmt = db.prepare(
  `INSERT INTO incidents (id, hotel_id, status, at, data) VALUES (?, ?, ?, ?, ?)`
);
const pruneIncidentsStmt = db.prepare(
  `DELETE FROM incidents WHERE hotel_id = ? AND id NOT IN (
     SELECT id FROM incidents WHERE hotel_id = ? ORDER BY at DESC LIMIT ${INCIDENTS_CAP})`
);
export function logIncident(incident) {
  const rec = { ...incident, id: uuidv4(), at: new Date().toISOString(), status: incident.status || "open" };
  incidents.unshift(rec);
  if (incidents.length > INCIDENTS_CAP) incidents.pop();
  insertIncidentStmt.run(rec.id, HOTEL, rec.status, rec.at, JSON.stringify(rec));
  pruneIncidentsStmt.run(HOTEL, HOTEL);
  stats.emergencies++; // דרך ה-Proxy → נשמר ל-DB
  return rec;
}

export function allSessions() {
  return Object.values(sessions).sort(
    (a, b) => new Date(b.lastActiveAt) - new Date(a.lastActiveAt)
  );
}
