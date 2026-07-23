// ════════════════════════════════════════════════════════
//  ID POLICY — verify-then-discard, שדות לחילוץ, והודעת האיסוף
//  ----------------------------------------------------------
//  מקור אמת אחד לשאלה "מה עושים עם תמונת המסמך": האם מוחקים אותה
//  אחרי האימות (ברירת המחדל התואמת-רגולציה) או שומרים אותה (רק עם
//  בסיס חוקי מתועד). כל שאר הקוד — MockIdProvider, bot.js — קורא מכאן,
//  כדי שההתנהגות בפועל וההודעה לאורח לעולם לא יסתרו זו את זו.
//
//  הכרעה (לפי עדיפות):
//   1. משתנה סביבה ID_STORE_MODE — לדמו/בדיקות (store_encrypted | verify_discard).
//   2. קונפיג המלון id_policy.retain_image + legal_basis (per-hotel).
//   3. ברירת מחדל: verify-then-discard (לא שומרים).
//
//  ⚠️ שמירת תמונה *נחסמת* אם אין legal_basis — לא שומרים PII רגיש
//     "ליתר ביטחון". חייב בסיס חוקי מפורש (ראה SECURITY.md §0).
// ════════════════════════════════════════════════════════
import { configFor } from "../config.js";

// השדות המינימליים שמחלצים כברירת מחדל אם המלון לא הגדיר אחרת.
const DEFAULT_EXTRACT_FIELDS = [
  "full_name", "document_type", "document_number",
  "nationality", "date_of_birth", "expiry_date",
];
const DEFAULT_RETENTION_DAYS = 30;

// מסמכי env — נבדקים פעם אחת. ID_STORE_MODE גובר (נוח לדמו/בדיקות).
function envStoreMode() {
  const m = (process.env.ID_STORE_MODE || "").toLowerCase().trim();
  if (m === "verify_discard" || m === "discard") return { retain: false };
  if (m === "store_encrypted" || m === "store")  return { retain: true, envDemo: true };
  return null; // לא הוגדר — נחליט לפי הקונפיג
}

/**
 * מחזיר את מדיניות מסמכי הזיהוי האפקטיבית למלון.
 * @returns {{ retainImage:boolean, legalBasis:string|null,
 *             retentionDays:number, extractFields:string[], reason:string }}
 */
export function resolveIdPolicy(hotelId) {
  let cfg = {};
  try { cfg = configFor(hotelId)?.id_policy || {}; } catch { cfg = {}; }

  const extractFields = Array.isArray(cfg.extract_fields) && cfg.extract_fields.length
    ? cfg.extract_fields
    : DEFAULT_EXTRACT_FIELDS;

  const retentionDays = Number(process.env.ID_RETENTION_DAYS)
    || Number(cfg.retention_days)
    || DEFAULT_RETENTION_DAYS;

  const legalBasis = cfg.legal_basis || null;

  // 1. env גובר (דמו/בדיקות).
  const env = envStoreMode();
  if (env) {
    return {
      retainImage: env.retain,
      legalBasis: env.retain ? (legalBasis || "demo (ID_STORE_MODE=store_encrypted)") : null,
      retentionDays, extractFields,
      reason: env.retain ? "env:store_encrypted" : "env:verify_discard",
    };
  }

  // 2. קונפיג המלון — שמירה *רק* עם בסיס חוקי מתועד.
  if (cfg.retain_image === true) {
    if (legalBasis) {
      return { retainImage: true, legalBasis, retentionDays, extractFields, reason: "config:legal_basis" };
    }
    // ביקשו לשמור בלי בסיס חוקי — חוסמים ומוחקים בכל זאת (ברירת מחדל בטוחה).
    console.warn(`🪪 [ID] id_policy.retain_image=true אך אין legal_basis למלון "${hotelId}" — נמחקת התמונה (verify-then-discard) כדי לא לשמור PII בלי בסיס חוקי.`);
    return { retainImage: false, legalBasis: null, retentionDays, extractFields, reason: "config:retain_without_basis_blocked" };
  }

  // 3. ברירת המחדל התואמת-רגולציה.
  return { retainImage: false, legalBasis: null, retentionDays, extractFields, reason: "default:verify_discard" };
}

// ── הודעת האיסוף לאורח (GDPR Arts. 13–14 / חוק הגנת הפרטיות §11) ──
// חייבת לומר את *האמת* לפי המדיניות בפועל: אם מוחקים — אומרים שמוחקים;
// אם שומרים — אומרים למה (בסיס חוקי) ולכמה זמן. מנוסחת כאן ולא ב-AI.
export function idCollectionNotice(policy, lang = "he") {
  const he = lang === "he";
  if (!policy.retainImage) {
    return he
      ? "🔒 *פרטיות:* התמונה משמשת *אך ורק* לאימות זהותך. מיד לאחר האימות אנו מחלצים רק את הפרטים הנדרשים לרישום ו*מוחקים את התמונה* — היא אינה נשמרת."
      : "🔒 *Privacy:* the photo is used *only* to verify your identity. Immediately after verification we extract only the required registration details and *delete the image* — it is not stored.";
  }
  const days = policy.retentionDays;
  return he
    ? `🔒 *פרטיות:* התמונה משמשת לאימות זהותך ותישמר *מוצפנת* לתקופה מוגבלת (עד ${days} ימים) בלבד למטרה חוקית${policy.legalBasis ? ` (${policy.legalBasis})` : ""}, בגישה מבוקרת ומתועדת, ולאחר מכן תימחק אוטומטית.`
    : `🔒 *Privacy:* the photo is used to verify your identity and will be kept *encrypted* for a limited period (up to ${days} days) only for a lawful purpose${policy.legalBasis ? ` (${policy.legalBasis})` : ""}, with controlled and logged access, and then automatically deleted.`;
}

export { DEFAULT_EXTRACT_FIELDS };
