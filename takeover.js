// ════════════════════════════════════════════════════════
//  TAKEOVER — איש צוות נכנס לשיחה, והבוט מפנה מקום
//  ----------------------------------------------------------
//  ── למה זה חייב להתקיים ─────────────────────────────────
//  אורח כועס, תלונה רגישה, מקרה חריג — יש רגעים שבהם התשובה הנכונה היא
//  **אדם**, לא בוט. בלי המנגנון הזה, מנהל שרוצה להתערב יכול רק להתקשר
//  לאורח בנפרד, והשיחה בוואטסאפ ממשיכה להיענות אוטומטית במקביל. זה
//  נראה לאורח כמו שני גורמים שלא מדברים ביניהם — הרושם ההפוך מיוקרה.
//
//  ── ההחלטה שמונעת את הנזק הגרוע ביותר ──────────────────
//  🔴 **פקיעה אוטומטית.** גיא ביקש "עצירת אוטומציה" ו"החזרה לאוטומטי"
//     כשני כפתורים. זו מלכודת: מנהל שעוצר ושוכח משאיר אורח מול **שקט
//     מוחלט** — וזה גרוע בהרבה מבוט שעונה בסדר. אורח שכתב ולא נענה
//     כלל הוא הכישלון החמור ביותר של מערכת שירות.
//
//     לכן להשתלטות יש **מועד פקיעה**. כשהוא מתקרב, איש הצוות מקבל
//     תזכורת; אם לא האריך — הבוט חוזר לענות, ומודיע על כך לצוות.
//     ההשתלטות היא מצב זמני מוצהר, לא מתג שנשכח.
//
//  ── מה קורה בזמן השתלטות ────────────────────────────────
//  הבוט **אינו** עונה לאורח, אבל **כן**:
//   • שומר את ההודעה בהיסטוריה (כדי שהמנהל יראה הכול)
//   • מזהה חירום ומטפל בו כרגיל 🔴 — ראה למטה
//   • מעביר לאיש הצוות התראה שהאורח כתב
//
//  🔴 **חירום גובר על השתלטות, תמיד.** אם אורח כותב "נפלתי" בזמן
//     שמנהל "מחזיק" את השיחה ואינו מסתכל בטלפון — זרימת החירום חייבת
//     לרוץ. אין מצב שבו שיקול תפעולי דוחה הנחיית 101.
// ════════════════════════════════════════════════════════
import { peekSession, patchSession, ensureSessionLoaded } from "./state.js";
import { currentHotelId } from "./tenant.js";

// כמה זמן השתלטות מחזיקה לפני שהבוט חוזר לענות.
export const TAKEOVER_TTL_MS = Number(process.env.TAKEOVER_TTL_MS) || 30 * 60_000;
// מתי מזכירים לאיש הצוות שההשתלטות עומדת לפקוע.
export const TAKEOVER_WARN_MS = Number(process.env.TAKEOVER_WARN_MS) || 5 * 60_000;

/**
 * מצב ההשתלטות של שיחה. מחזיר תמיד אובייקט — לעולם לא `null` —
 * כדי שהקורא לא יצטרך להתגונן.
 */
export function takeoverState(phone, hotelId = currentHotelId(), { now = Date.now() } = {}) {
  const s = peekSession(phone, hotelId);
  const t = s?.takeover;
  if (!t?.active) return { active: false };
  // פג תוקף → נחשב לא פעיל, גם אם עוד לא נסרק.
  if (t.expiresAt && new Date(t.expiresAt).getTime() <= now) {
    return { active: false, expired: true, by: t.by, since: t.since };
  }
  return {
    active: true, by: t.by, since: t.since, expiresAt: t.expiresAt,
    reason: t.reason || null,
    msLeft: t.expiresAt ? new Date(t.expiresAt).getTime() - now : null,
  };
}

/** האם הבוט צריך לשתוק בשיחה הזו. */
export function isHumanHandling(phone, hotelId = currentHotelId()) {
  return takeoverState(phone, hotelId).active === true;
}

/**
 * איש צוות משתלט על השיחה.
 * `by` — מי. נרשם, כי "מישהו השתלט" בלי שם אינו שרשרת אחריות.
 */
export async function takeOver(phone, { by = "staff", reason = null, hotelId = currentHotelId(), ttlMs = TAKEOVER_TTL_MS } = {}) {
  await ensureSessionLoaded(phone, hotelId);
  const now = Date.now();
  const t = {
    active: true, by, reason,
    since: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    warned: false,
  };
  patchSession(phone, { takeover: t }, hotelId);
  console.log(`🙋 השתלטות אנושית: ${by} נכנס לשיחה עם ${String(phone).slice(-8)} (עד ${new Date(now + ttlMs).toLocaleTimeString("he-IL")})`);
  return t;
}

/** הארכה — בלי לאבד את זהות מי שמטפל. */
export async function extendTakeover(phone, { hotelId = currentHotelId(), ttlMs = TAKEOVER_TTL_MS } = {}) {
  const cur = takeoverState(phone, hotelId);
  if (!cur.active) return { notActive: true };
  const t = {
    active: true, by: cur.by, reason: cur.reason, since: cur.since,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(), warned: false,
  };
  patchSession(phone, { takeover: t }, hotelId);
  return t;
}

/** שחרור מפורש — הבוט חוזר לענות. */
export async function releaseTakeover(phone, { by = "staff", hotelId = currentHotelId() } = {}) {
  await ensureSessionLoaded(phone, hotelId);
  const cur = takeoverState(phone, hotelId);
  patchSession(phone, {
    takeover: { active: false, releasedBy: by, releasedAt: new Date().toISOString(), by: cur.by || null },
  }, hotelId);
  console.log(`🤖 השיחה עם ${String(phone).slice(-8)} חזרה לבוט (שוחררה ע"י ${by})`);
  return { released: true };
}

// ── הסורק: תזכורת לפני פקיעה, והחזרה לבוט אחריה ─────────
// מוזרק, כדי ש-`takeover.js` לא ייבא את `bot.js` (מעגל).
let notify = async () => {};
export function setNotifier(fn) { if (typeof fn === "function") notify = fn; }

// מקור הסשנים לסריקה — מוזרק כדי שהמודול יישאר טהור וניתן לבדיקה.
let listSessions = async () => [];
export function setSessionSource(fn) { if (typeof fn === "function") listSessions = fn; }

/**
 * סורק השתלטויות: מזכיר לפני פקיעה, ומחזיר לבוט אחרי.
 *
 * 🔴 ההודעה לצוות בפקיעה אינה נימוס — היא מונעת את המצב שבו מנהל בטוח
 *    שהוא עדיין "מחזיק" את השיחה בזמן שהבוט כבר עונה במקומו.
 */
export async function sweepTakeovers(now = Date.now()) {
  let sessions = [];
  try { sessions = await listSessions(); } catch { return { scanned: 0 }; }

  let expired = 0, warned = 0;
  for (const s of sessions) {
    const t = s?.takeover;
    if (!t?.active || !t.expiresAt) continue;
    const left = new Date(t.expiresAt).getTime() - now;

    if (left <= 0) {
      patchSession(s.phone, {
        takeover: { active: false, expiredAt: new Date(now).toISOString(), by: t.by || null },
      }, s.hotelId);
      expired++;
      await notify({
        hotelId: s.hotelId, dept: "reception", phone: s.phone,
        roomNumber: s.roomNumber, guestName: s.guestName, priority: "normal",
        message: `🤖 ההשתלטות של ${t.by || "הצוות"} על השיחה פגה — הבוט חזר לענות לאורח.\n` +
                 `אם הטיפול עדיין פתוח, יש להשתלט מחדש.`,
      }).catch(() => {});
      continue;
    }

    if (!t.warned && left <= TAKEOVER_WARN_MS) {
      patchSession(s.phone, { takeover: { ...t, warned: true } }, s.hotelId);
      warned++;
      await notify({
        hotelId: s.hotelId, dept: "reception", phone: s.phone,
        roomNumber: s.roomNumber, guestName: s.guestName, priority: "normal",
        message: `⏳ ההשתלטות על השיחה תפוג בעוד ${Math.max(1, Math.round(left / 60_000))} דק׳ — ` +
                 `אחריה הבוט יחזור לענות. להארכה, יש להמשיך לטפל דרך המסך.`,
      }).catch(() => {});
    }
  }
  return { scanned: sessions.length, expired, warned };
}
