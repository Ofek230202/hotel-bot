// ════════════════════════════════════════════════════════
//  AUTH — תפקידים והרשאות
//  ----------------------------------------------------------
//  ── מה היה קודם ─────────────────────────────────────────
//  🔴 **סיסמה אחת לכל המערכת.** מי שיש לו אותה רואה הכול: שיחות של
//     אורחים, **מסמכי זהות מוצפנים**, חשבוניות, ויכול למחוק סשנים
//     ולחייב כרטיסים. במלון עם עשרים עובדים זה לא עומד בשום תקן —
//     ומספיק שעובד אחד עוזב כדי שהסיסמה תהיה בחוץ.
//
//  ── העיקרון ─────────────────────────────────────────────
//  **הרשאה מינימלית.** לכל תפקיד רק מה שהוא צריך כדי לעבוד:
//   • משק בית רואה בקשות — לא חשבוניות ולא ת"ז.
//   • קבלה מנהלת שיחות — לא נוגעת בכספים.
//   • הנהלת חשבונות רואה חשבוניות — לא קוראת שיחות אורחים.
//   • רק מנהל ניגש למסמכי זהות, ורק דרך המסלול המתועד (audit).
//
//  ── תאימות לאחור, בכוונה ────────────────────────────────
//  🔴 בלי `STAFF_TOKENS` מוגדר, `DASHBOARD_PASSWORD` ממשיך לעבוד בדיוק
//     כמו היום, עם הרשאות מלאות. פריסה קיימת לא נשברת, והמעבר לתפקידים
//     הוא הוספת משתנה סביבה — לא שינוי קוד.
//
//  ⚠️ מה זה **לא**: זו הרשאה מבוססת-טוקן, לא ניהול משתמשים. אין כאן
//     סיסמאות אישיות, איפוס סיסמה או SSO. למלון עם צוות גדול זה השלב
//     הבא, וההפרדה כאן היא התשתית שמאפשרת אותו.
// ════════════════════════════════════════════════════════
import { timingSafeEqual } from "node:crypto";

// ── יכולות (capabilities) — מה מותר לעשות ───────────────
// שמות פעולה, לא שמות מסכים: מסך משתנה, היכולת נשארת.
export const CAP = Object.freeze({
  VIEW_CONVERSATIONS: "conversations:view",
  REPLY_GUEST:        "conversations:reply",   // כולל השתלטות
  VIEW_ALERTS:        "alerts:view",
  CREATE_ALERTS:      "alerts:create",
  VIEW_REPORTS:       "reports:view",
  VIEW_BILLING:       "billing:view",          // חשבוניות, folio
  CHARGE:             "billing:charge",        // חיוב בפועל
  VIEW_ID_DOCS:       "id:view",               // 🔴 PII רגיש
  EDIT_CONFIG:        "config:edit",
  MANAGE_HOTELS:      "hotels:manage",
  ADMIN:              "admin",                 // הכול, כולל איפוסים
});

const ALL_CAPS = Object.values(CAP);

// ── תפקידים ─────────────────────────────────────────────
export const ROLES = Object.freeze({
  admin:        ALL_CAPS,
  manager: [
    CAP.VIEW_CONVERSATIONS, CAP.REPLY_GUEST, CAP.VIEW_ALERTS, CAP.CREATE_ALERTS,
    CAP.VIEW_REPORTS, CAP.VIEW_BILLING, CAP.CHARGE, CAP.VIEW_ID_DOCS, CAP.EDIT_CONFIG,
  ],
  reception: [
    CAP.VIEW_CONVERSATIONS, CAP.REPLY_GUEST, CAP.VIEW_ALERTS, CAP.CREATE_ALERTS,
  ],
  // 🔴 **מחלקות שירות רואות בקשות בלבד.** אין לאיש מהן שום סיבה לקרוא
  //    שיחות פרטיות של אורחים, לראות חשבוניות או לגשת למסמכי זהות.
  //    זו נקודת ההרשאה המינימלית: מי שמביא מגבות צריך לדעת שביקשו
  //    מגבות — ולא מה עוד האורח כתב באותה שיחה.
  //
  //    יש תפקיד לכל מחלקה ב-`DEPARTMENTS` (config.js), כדי שלא ייווצר
  //    מצב שבו מחלקה קיימת נאלצת לקבל טוקן של תפקיד רחב יותר "כי אין
  //    לה תפקיד משלה" — וזו בדיוק הדרך שבה הרשאות נשחקות בשטח.
  housekeeping: [CAP.VIEW_ALERTS],
  maintenance:  [CAP.VIEW_ALERTS],
  spa:          [CAP.VIEW_ALERTS],
  room_service: [CAP.VIEW_ALERTS],
  // קונסיירז' עונה לאורח על סידורים (מונית, שולחן) ולכן כן משיב בצ'אט —
  // אך אינו רואה כספים ואינו רואה מסמכי זהות.
  concierge:    [CAP.VIEW_ALERTS, CAP.CREATE_ALERTS, CAP.VIEW_CONVERSATIONS, CAP.REPLY_GUEST],
  // ביטחון מטפל באירועי חירום — צריך לראות את השיחה כדי להבין מה קרה,
  // ולהשיב. כספים ומסמכי זהות אינם חלק מזה.
  security:     [CAP.VIEW_ALERTS, CAP.CREATE_ALERTS, CAP.VIEW_CONVERSATIONS, CAP.REPLY_GUEST],
  // הנהלת חשבונות רואה כסף — ו**אינה קוראת שיחות**.
  accounting:   [CAP.VIEW_BILLING, CAP.VIEW_REPORTS],
  // צפייה בלבד — לבעלים/משקיע שרוצה לראות מספרים.
  viewer:       [CAP.VIEW_REPORTS, CAP.VIEW_ALERTS],
});

// תוויות בעברית — לדשבורד, ללוגים, ולהודעות השגיאה.
export const ROLE_LABELS_HE = Object.freeze({
  admin:        "מנהל מערכת",
  manager:      "מנהל מלון",
  reception:    "קבלה",
  concierge:    "קונסיירז'",
  security:     "ביטחון",
  housekeeping: "משק בית",
  maintenance:  "אחזקה",
  spa:          "ספא",
  room_service: "שירות חדרים",
  accounting:   "הנהלת חשבונות",
  viewer:       "צפייה בלבד",
});

export function capsForRole(role) {
  return ROLES[role] || [];
}

// ── טעינת הטוקנים ───────────────────────────────────────
// פורמט: STAFF_TOKENS="role:token:name,role:token:name"
//   דוגמה: "manager:s3cr3t:מיכל,reception:r3c:קבלה,housekeeping:hk:משק בית"
// השם הוא לתיעוד בלבד (מי ביצע פעולה), ואינו סוד.
function parseTokens(raw) {
  const out = [];
  for (const entry of String(raw || "").split(",")) {
    const [role, token, ...nameParts] = entry.split(":").map(s => s.trim());
    if (!role || !token) continue;
    if (!ROLES[role]) {
      console.error(`🚨 STAFF_TOKENS: תפקיד לא מוכר "${role}" — הרשומה מתעלמת.`);
      continue;
    }
    out.push({ role, token, name: nameParts.join(":") || role });
  }
  return out;
}

let TOKENS = parseTokens(process.env.STAFF_TOKENS);

/** לבדיקות ולריענון אחרי שינוי env. */
export function reloadTokens(raw = process.env.STAFF_TOKENS) {
  TOKENS = parseTokens(raw);
  return TOKENS.length;
}

export function tokensConfigured() { return TOKENS.length > 0; }

// השוואה בזמן קבוע — מונעת דליפת הטוקן תו-תו דרך מדידת זמן.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * מזהה את בעל הטוקן.
 *
 * 🔴 **תאימות לאחור:** בלי `STAFF_TOKENS`, ה-`DASHBOARD_PASSWORD` הישן
 *    מזוהה כ-admin. פריסה קיימת ממשיכה לעבוד בדיוק כמו קודם.
 *    כש-`STAFF_TOKENS` **כן** מוגדר, סיסמת ה-admin הישנה עדיין תקפה —
 *    כדי שלא תיווצר פריסה נעולה שאי אפשר להיכנס אליה.
 */
export function identify(token, { adminPassword = process.env.DASHBOARD_PASSWORD } = {}) {
  if (!token) return null;
  for (const t of TOKENS) {
    if (safeEqual(token, t.token)) {
      return { role: t.role, name: t.name, caps: capsForRole(t.role) };
    }
  }
  if (adminPassword && safeEqual(token, adminPassword)) {
    return { role: "admin", name: "admin", caps: ALL_CAPS };
  }
  return null;
}

export function can(actor, cap) {
  if (!actor) return false;
  return actor.caps.includes(CAP.ADMIN) || actor.caps.includes(cap);
}

/**
 * מידלוור: דורש יכולת מסוימת.
 *
 * 🔴 401 מול 403 אינו קוסמטי — 401 אומר "לא זוהית" ו-403 אומר "זוהית
 *    ואינך מורשה". איש צוות שמקבל 401 ינסה להתחבר שוב ושוב; 403 אומר
 *    לו לפנות למנהל. וגם: ניסיון חריגה **נרשם** — אחרת אין דרך לדעת
 *    שמישהו מנסה להגיע למקום שאסור לו.
 */
export function requireCap(cap) {
  return (req, res, next) => {
    const token = req.headers["x-dashboard-token"] || req.query.token;
    const actor = identify(token);
    if (!actor) return res.status(401).json({ error: "Unauthorized" });

    if (!can(actor, cap)) {
      console.warn(`🚫 גישה נדחתה: "${actor.name}" (${actor.role}) ניסה ${cap} ב-${req.method} ${req.path}`);
      return res.status(403).json({
        error: "Forbidden",
        need: cap,
        role: actor.role,
      });
    }
    req.actor = actor;            // זמין להאנדלר — לתיעוד "מי ביצע"
    next();
  };
}

/** לדשבורד: מה מותר למשתמש הזה, כדי להסתיר מסכים שאין לו גישה אליהם. */
export function describeActor(token) {
  const actor = identify(token);
  if (!actor) return null;
  return { role: actor.role, name: actor.name, caps: actor.caps };
}
