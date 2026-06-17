// ════════════════════════════════════════════════════════
//  IN-MEMORY STATE  (swap for Redis/DB in production)
// ════════════════════════════════════════════════════════
import { v4 as uuidv4 } from "uuid";

export const sessions   = {};   // phone → GuestSession
export const staffAlerts = [];  // log of all staff notifications
export const incidents   = [];  // structured log of every emergency incident
export let   stats = { totalMessages: 0, checkIns: 0, checkOuts: 0, serviceRequests: 0, emergencies: 0 };

// ── GuestSession schema ───────────────────────────────
export function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = {
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
  }
  sessions[phone].lastActiveAt = new Date().toISOString();
  sessions[phone].messageCount++;
  stats.totalMessages++;
  return sessions[phone];
}

export function pushHistory(phone, role, content) {
  const s = getSession(phone);
  s.history.push({ role, content });
  if (s.history.length > 30) s.history = s.history.slice(-30);
}

export function patchSession(phone, patch) {
  Object.assign(sessions[phone], patch);
}

export function logAlert(alert) {
  staffAlerts.unshift({ ...alert, id: uuidv4(), at: new Date().toISOString() });
  if (staffAlerts.length > 200) staffAlerts.pop();
}

// ── Emergency incident log ────────────────────────────
// תיעוד מובנה של כל אירוע חירום — נשמר בנפרד מהתראות הרגילות
// כדי שיהיה ניתן לעקוב, לבדוק שטופל, ולתחקר בדיעבד.
export function logIncident(incident) {
  const rec = { ...incident, id: uuidv4(), at: new Date().toISOString(), status: incident.status || "open" };
  incidents.unshift(rec);
  if (incidents.length > 500) incidents.pop();
  stats.emergencies++;
  return rec;
}

export function allSessions() {
  return Object.values(sessions).sort(
    (a, b) => new Date(b.lastActiveAt) - new Date(a.lastActiveAt)
  );
}
