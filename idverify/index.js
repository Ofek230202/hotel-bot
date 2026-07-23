// ════════════════════════════════════════════════════════
//  נקודת החיבור היחידה לספק אימות הזיהוי (single wiring point)
//  ----------------------------------------------------------
//  כאן — ורק כאן — בוחרים איזה ספק אימות/אחסון מסמכי זיהוי פעיל.
//  כל שאר הקוד מייבא את `idVerify` מכאן ולא יודע מי הספק בפועל.
//
//  מעבר לאחסון מאובטח אמיתי בעתיד = החלפת שורה אחת:
//      import { SecureIdProvider } from "./SecureIdProvider.js";
//      export const idVerify = new SecureIdProvider();
//
//  בדיוק כמו payments/index.js — אותו דפוס, החלפה במקום אחד.
// ════════════════════════════════════════════════════════
import { MockIdProvider } from "./MockIdProvider.js";

export const idVerify = new MockIdProvider();

// ── ניהול מסמכי הזיהוי (רישום, גישה מבוקרת + audit, retention) ──
// מיוצא מכאן — נקודת ההחלפה האחת. כשעוברים ל-vault/PMS אמיתי, מחליפים
// את הספק למעלה *וגם* את המימוש של הפונקציות האלה במקום אחד.
export {
  recordIdDocument, retrieveIdDocument, listIdDocuments,
  purgeExpiredIdDocuments, accessLogFor, logIdAccess, RETENTION_DAYS,
} from "./registry.js";
