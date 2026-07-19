// ════════════════════════════════════════════════════════
//  crypto.js — הצפנת מסמכי זיהוי במנוחה (at rest)
//  ----------------------------------------------------------
//  מסמכי זיהוי הם PII רגיש. גם באחסון הדמו המקומי, התמונה לא
//  נשמרת עוד כ-plaintext על הדיסק — היא מוצפנת ב-AES-256-GCM.
//
//  פורמט הקובץ המוצפן (`.enc`):  [IV 12B][authTag 16B][ciphertext]
//  ה-IV וה-authTag אינם סוד ולכן נשמרים לצד ה-ciphertext; המפתח בלבד
//  הוא הסוד, והוא לעולם לא נשמר עם הקובץ.
//
//  🔑 מקור המפתח:
//   • פרודקשן: ID_ENCRYPTION_KEY ב-env — 32 בייט (64 תווי hex, או base64).
//     יש להחזיק אותו ב-secret manager, לא בקוד ולא ב-repo.
//   • דמו (אין מפתח ב-env): נגזר מפתח *דטרמיניסטי* מ-passphrase קבוע
//     דרך scrypt, *רק* כדי שההדגמה תרוץ. ⚠️ זו אינה הצפנה בטוחה —
//     המפתח נגזר מערך ידוע. אסור בפרודקשן.
//
//  🏨 נקודת החיבור העתידית ל-PMS (אל תמחק):
//     במלון אמיתי מסמך הזיהוי לא יישמר כאן כלל — הוא יישלח ישירות
//     למערכת ה-PMS המאובטחת של המלון (או ל-secure vault/tokenization),
//     שם הוא נשמר מוצפן עם בקרת גישה, retention ותאימות לחוק. ההחלפה
//     נעשית במקום אחד: idverify/index.js (ספק אחסון חדש). המודול הזה
//     הוא רק הגנת at-rest ל*דמו* עד שה-PMS מחובר.
// ════════════════════════════════════════════════════════
import crypto from "node:crypto";

const ALGO   = "aes-256-gcm";
const IV_LEN = 12;   // מומלץ ל-GCM
const TAG_LEN = 16;

let cachedKey = null;
let usingDemoKey = false;

// טוען/גוזר את מפתח ההצפנה פעם אחת. לא זורק — אם אין מפתח תקין
// ב-env, נגזר מפתח דמו כדי שההדגמה תרוץ (עם אזהרה ברורה בלוג).
function getKey() {
  if (cachedKey) return cachedKey;

  const raw = process.env.ID_ENCRYPTION_KEY;
  if (raw) {
    let buf = null;
    // 64 תווי hex → 32 בייט
    if (/^[0-9a-fA-F]{64}$/.test(raw.trim())) buf = Buffer.from(raw.trim(), "hex");
    else {
      try {
        const b = Buffer.from(raw.trim(), "base64");
        if (b.length === 32) buf = b;
      } catch { /* לא base64 תקין */ }
    }
    if (buf && buf.length === 32) {
      cachedKey = buf;
      return cachedKey;
    }
    console.error("🔐 [ID] ID_ENCRYPTION_KEY אינו 32 בייט תקין (hex/base64) — נופל למפתח דמו. ⚠️ אסור בפרודקשן.");
  }

  // ── מפתח דמו (אין env) — דטרמיניסטי, לא בטוח, רק להדגמה ──
  usingDemoKey = true;
  console.error("🔐 [ID] אין ID_ENCRYPTION_KEY — משתמשים במפתח דמו נגזר. ⚠️ אחסון לא בטוח; בפרודקשן חובה מפתח אמיתי או PMS.");
  cachedKey = crypto.scryptSync("staybot-demo-id-key", "staybot-demo-salt", 32);
  return cachedKey;
}

export function isUsingDemoKey() {
  getKey();
  return usingDemoKey;
}

// מצפין buffer → buffer מוצפן ([IV][tag][ciphertext]).
export function encryptBuffer(plain) {
  const key = getKey();
  const iv  = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct  = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

// מפענח buffer שנוצר ע"י encryptBuffer. זורק אם המפתח שגוי או הקובץ פגום
// (authTag לא תואם) — כך שלא מחזירים plaintext שקרי.
export function decryptBuffer(blob) {
  const key = getKey();
  if (!Buffer.isBuffer(blob) || blob.length < IV_LEN + TAG_LEN) {
    throw new Error("encrypted blob too short / not a buffer");
  }
  const iv  = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct  = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export const ENC_ALGO = ALGO;
