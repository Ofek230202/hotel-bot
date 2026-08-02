// ════════════════════════════════════════════════════════
//  ESCALATION — אף אירוע חירום לא נשאר בלי אדם שאישר קבלה
//  ----------------------------------------------------------
//  ── מה היה חסר, ולמה זה הפער הכי מסוכן בפרויקט ──────────
//  זרימת החירום זיהתה, הנחתה את האורח להתקשר 101, והסלימה לביטחון
//  ולקבלה. ואז — כלום. **אף אחד לא אישר קבלה.** אם טלפון הביטחון כבוי,
//  אם המשמרת התחלפה, אם ההודעה נבלעה — האורח פצוע בחדר, המערכת מדווחת
//  "טופל", ואיש אינו בדרך. שקט שנראה כמו הצלחה.
//
//  ── מה יש כאן ───────────────────────────────────────────
//  סולם הסלמה עם מועד יעד לאישור. ההתראה הראשונה מבקשת אישור מפורש; אם
//  לא הגיע אישור תוך `ACK_TIMEOUT_MS`, האירוע מוסלם **לדרג הבא** ונשלח
//  שוב — עד שמישהו מאשר, או עד שנגמרו הדרגים ואז הבעיה עצמה מוכרזת.
//
//    דרג 0 → ביטחון + קבלה   (ההסלמה המקורית)
//    דרג 1 → מנהל תורן        (duty_manager_number)
//    דרג 2 → כל המחלקות + הכרזה שאין אישור — "אף אחד לא אישר קבלה"
//
//  ── למה זה נשען על ה-DB ולא על setTimeout ───────────────
//  🔴 `setTimeout` חי בזיכרון של תהליך אחד. ריסטארט (deploy ב-Railway
//     קורה בדיוק כשמשהו נשבר) היה מוחק את כל הטיימרים — ואירוע פתוח היה
//     נשכח בשקט. לכן `ackDeadline` נשמר **על האירוע ב-DB**, וסורק תקופתי
//     מוצא כל אירוע שעבר את מועדו. עלייה מחדש ממשיכה מאיפה שהפסיקה.
//
//  ── ריבוי תהליכים ───────────────────────────────────────
//  הסורק רץ בכל עותק. בלי הגנה, שלושה עותקים היו שולחים שלוש אזעקות על
//  אותו אירוע. `withGuestLock` על מזהה האירוע מוודא שרק אחד מסלים, וסימון
//  `escalationLevel` ב-DB מונע הסלמה כפולה גם אם הנעילה נכשלה.
//
//  ⚠️ מודע: זה מבטיח ש**נשלחה** התראה ושמישהו אישר קבלה בערוץ. זה אינו
//     מבטיח שאדם באמת יצא לחדר. אין תחליף לנוהל מלון — אבל עכשיו לפחות
//     אי אפשר שאיש לא יידע.
// ════════════════════════════════════════════════════════
import { updateIncident, updateIncidentAsync, getIncidentAsync, findUnacknowledgedIncidents, logAlert } from "./state.js";
import { configFor, hotelModel, DEPARTMENTS } from "./config.js";
import { runInTenant } from "./tenant.js";
import { withGuestLock } from "./store/index.js";

// כמה זמן ממתינים לאישור קבלה לפני הסלמה לדרג הבא.
export const ACK_TIMEOUT_MS = Number(process.env.EMERGENCY_ACK_TIMEOUT_MS) || 3 * 60_000;
// כל כמה זמן סורקים אירועים שלא אושרו.
export const SWEEP_INTERVAL_MS = Number(process.env.EMERGENCY_SWEEP_MS) || 30_000;
export const MAX_LEVEL = 2;

// ── הזרקת השולח ────────────────────────────────────────
// `notifyStaff` יושב ב-bot.js, ש-`checkin.js` כבר מייבא ממנו — ייבוא ישיר
// כאן היה סוגר מעגל. במקום זה `bot.js` רושם את עצמו בעלייה.
let notify = async () => {};
export function setNotifier(fn) { if (typeof fn === "function") notify = fn; }

// מזרים לאירוע חדש מועד יעד לאישור. נקרא **מיד** אחרי `logIncident`, ולכן
// הרשומה עדיין ב-cache החי וגרסה סינכרונית בטוחה כאן. כל שאר העדכונים
// (אישור, סגירה, הסלמה) נוגעים באירועים שעשויים להיות ישנים — ולכן הם
// אסינכרוניים: אחרי ריסטארט האירוע כבר לא בזיכרון.
export function armIncident(incidentId, { now = new Date() } = {}) {
  return updateIncident(incidentId, {
    ackDeadline:     new Date(now.getTime() + ACK_TIMEOUT_MS).toISOString(),
    escalationLevel: 0,
    ackAt:           null,
    ackBy:           null,
  });
}

/**
 * אישור קבלה על ידי איש צוות. מכאן אין יותר הסלמות.
 * `actor` — מי אישר. נרשם, כי "מישהו אישר" בלי שם אינו שרשרת אחריות.
 */
export async function acknowledgeIncident(incidentId, { actor = "staff", note = null } = {}) {
  const inc = await getIncidentAsync(incidentId);
  if (!inc) return { notFound: true };
  if (inc.ackAt) return { alreadyAcked: true, incident: inc };

  const updated = await updateIncidentAsync(incidentId, {
    ackAt: new Date().toISOString(), ackBy: actor, ackNote: note || null,
    ackDeadline: null,           // ← מנטרל את הסולם
  });
  logAlert({
    hotelId: inc.hotelId, dept: "security", priority: "normal",
    message: `✅ אירוע חירום ${incidentId.slice(0, 8)} אושר על ידי ${actor}`,
  });
  console.log(`✅ אירוע ${incidentId.slice(0, 8)} אושר (${actor})`);
  return { ok: true, incident: updated };
}

/** סגירת אירוע. דורשת תיאור מה נעשה — אירוע שנסגר בלי תיעוד אינו סגור. */
export async function closeIncident(incidentId, { actor = "staff", resolution = null } = {}) {
  const inc = await getIncidentAsync(incidentId);
  if (!inc) return { notFound: true };
  if (!resolution || !String(resolution).trim()) {
    return { needsResolution: true };
  }
  const updated = await updateIncidentAsync(incidentId, {
    status: "closed", closedAt: new Date().toISOString(), closedBy: actor,
    resolution: String(resolution).trim(),
    // אירוע סגור שלא אושר — מסמנים את הסגירה גם כאישור, אחרת הסורק
    // ימשיך להסלים אירוע שכבר טופל.
    ackAt: inc.ackAt || new Date().toISOString(),
    ackBy: inc.ackBy || actor,
    ackDeadline: null,
  });
  console.log(`🔒 אירוע ${incidentId.slice(0, 8)} נסגר (${actor}): ${updated.resolution.slice(0, 60)}`);
  return { ok: true, incident: updated };
}

// ── טקסט ההתראה לכל דרג ────────────────────────────────
function escalationMessage(inc, level, cfg) {
  const where = inc.roomNumber ? `חדר ${inc.roomNumber}` : "מיקום לא ידוע";
  const who   = inc.guestName ? ` · ${inc.guestName}` : "";
  const mins  = Math.round(ACK_TIMEOUT_MS / 60_000);
  const head  = `🚨 *אירוע חירום ללא אישור קבלה* (${mins} דק׳)\n` +
                `${where}${who}\n` +
                `📝 ${String(inc.description || "").slice(0, 300)}\n`;

  if (level === 1) {
    return head +
      `⏱️ ההתראה לביטחון ולקבלה *לא אושרה*. מנהל תורן — נא לוודא טיפול *עכשיו* ולאשר קבלה.\n` +
      `📞 האורח: ${inc.phone || "—"}`;
  }
  return head +
    `🔴 *אף אחד לא אישר קבלה* אחרי שתי הסלמות. זו תקלה בנוהל החירום של המלון.\n` +
    `נא לטפל באירוע *ומיד אחריו* לבדוק מדוע ההתראות אינן נענות.\n` +
    `📞 האורח: ${inc.phone || "—"}`;
}

// לאיזה יעדים שולחים בכל דרג. תמיד לפי **המלון של האירוע**.
function targetsFor(level, hotelId) {
  if (level === 1) {
    const model = hotelModel(hotelId);
    // מנהל תורן. אם לא הוגדר, `hotelModel` כבר נופל למספר הביטחון —
    // פחות טוב, אבל עדיף מלשלוח לשום מקום.
    return [{ dept: "security", directNumber: model.dutyManagerNumber, label: "מנהל תורן" }];
  }
  // דרג אחרון: כל המחלקות. מישהו חייב לראות את זה.
  return DEPARTMENTS.map(dept => ({ dept, directNumber: null, label: dept }));
}

/**
 * מסלים אירוע בודד לדרג הבא. אידמפוטנטי: אם דרג זה כבר נשלח, לא חוזר.
 */
export async function escalateIncident(inc, { now = new Date() } = {}) {
  const hotelId = inc.hotelId;
  const next    = (inc.escalationLevel ?? 0) + 1;
  if (next > MAX_LEVEL) {
    // מיצינו את הסולם. מפסיקים להציף, אבל **לא** מסמנים כמטופל.
    await updateIncidentAsync(inc.id, { ackDeadline: null, escalationExhausted: true });
    console.error(`🚨 אירוע ${inc.id.slice(0, 8)}: סולם ההסלמה מוצה ואיש לא אישר קבלה.`);
    return { exhausted: true };
  }

  const cfg     = configFor(hotelId);
  const message = escalationMessage(inc, next, cfg);

  for (const t of targetsFor(next, hotelId)) {
    try {
      await notify({
        hotelId, dept: t.dept, phone: inc.phone,
        roomNumber: inc.roomNumber, guestName: inc.guestName,
        message, priority: "high",
        ...(t.directNumber ? { directNumber: t.directNumber } : {}),
      });
    } catch (e) {
      console.error(`🚨 הסלמת אירוע ${inc.id.slice(0, 8)} ל-${t.label} נכשלה:`, e?.message || e);
    }
  }

  // מועד יעד חדש — הדרג הבא ייבדק בעוד ACK_TIMEOUT_MS.
  await updateIncidentAsync(inc.id, {
    escalationLevel: next,
    ackDeadline:     new Date(now.getTime() + ACK_TIMEOUT_MS).toISOString(),
    escalations:     [...(inc.escalations || []), { level: next, at: now.toISOString() }],
  });
  console.warn(`⏫ אירוע ${inc.id.slice(0, 8)} הוסלם לדרג ${next} (לא אושר תוך ${Math.round(ACK_TIMEOUT_MS / 60_000)} דק׳)`);
  return { escalated: true, level: next };
}

/**
 * סורק אירועים פתוחים שעבר מועד האישור שלהם ומסלים אותם.
 * נקרא מחזורית מ-`server.js`, וגם ידנית מ-`POST /api/incidents/sweep`.
 */
export async function sweepUnacknowledged(now = new Date()) {
  const due = await findUnacknowledgedIncidents(now);
  let escalated = 0;
  for (const inc of due) {
    // 🔴 נעילה על מזהה האירוע: עם כמה עותקים, כולם היו מוצאים את אותו
    //    אירוע ושולחים אזעקה כל אחד. אזעקה משולשת שוחקת אמון בהתראות.
    await withGuestLock(`incident:${inc.id}`, async () => {
      // קריאה חוזרת *בתוך* הנעילה — ייתכן שעותק אחר כבר הסלים או שמישהו
      // אישר בזמן שחיכינו.
      const fresh = await getIncidentAsync(inc.id);
      if (!fresh || fresh.ackAt || !fresh.ackDeadline) return;
      if (new Date(fresh.ackDeadline) > now) return;
      await runInTenant(fresh.hotelId, () => escalateIncident(fresh, { now }));
      escalated++;
    });
  }
  return { scanned: due.length, escalated };
}

/** מפעיל את הסורק המחזורי. `unref` כדי שלא יעכב יציאה תקינה. */
export function startEscalationSweeper() {
  const timer = setInterval(() => {
    sweepUnacknowledged().catch(e => console.error("🚨 סריקת אירועי חירום נכשלה:", e?.message || e));
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
