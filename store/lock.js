// ════════════════════════════════════════════════════════
//  DISTRIBUTED LOCK — סריאליזציה של אורח **בין תהליכים**
//  ----------------------------------------------------------
//  `withLock` של concurrency.js מסדר בתור הודעות של אותו אורח בתוך
//  תהליך אחד. ברגע שיש שני עותקים, שתי הודעות של אותו אורח יכולות
//  ליפול על תהליכים שונים ולרוץ **בו-זמנית** — וזה בדיוק מה שיוצר
//  צ'ק אין שנדרס או **הזמנת אוכל כפולה**.
//
//  `withGuestLock` מרכיב את שתי ההגנות:
//    1. נעילה בתהליך (זולה, מיידית) — מגנה על מקביליות פנימית.
//    2. נעילה מבוזרת (רק כשיש Redis) — מגנה בין תהליכים.
//  בלי Redis הרכיב השני פשוט לא קיים, וההתנהגות זהה למה שיש היום.
//
//  ── שלוש החלטות שמונעות תקלות אמיתיות ─────────────────
//  • **TTL על הנעילה**: תהליך שקורס באמצע לא נועל את האורח לנצח.
//  • **טוקן ייחודי + שחרור מותנה**: משחררים רק נעילה *שלנו*. אחרת
//    תהליך איטי שהנעילה שלו פגה היה משחרר את הנעילה של מי שבא אחריו.
//  • **fail-open בתקלת Redis**: אם ה-store לא זמין, ממשיכים עם הנעילה
//    המקומית בלבד. אורח שלא מקבל מענה גרוע מסיכון תיאורטי לכפילות —
//    ו-Redis שנפל אחרי retry לא צריך להשבית את המלון.
// ════════════════════════════════════════════════════════
import { withLock } from "../concurrency.js";
import { store, isDistributed } from "./index.js";

let _seq = 0;
// טוקן ייחודי לבעלות על הנעילה. אין צורך ב-crypto: pid+זמן+מונה מספיק
// כדי להיות ייחודי בין תהליכים, וזה גם קריא בלוג.
function lockToken() {
  return `${process.pid}-${Date.now().toString(36)}-${(++_seq).toString(36)}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * מנסה לתפוס נעילה מבוזרת. מחזיר טוקן, או null אם לא הצליח בזמן.
 * ממתין בהדרגה (backoff) במקום להציף את Redis.
 */
export async function acquireLock(key, { ttlMs = 30_000, waitMs = 10_000 } = {}) {
  const s = store();
  const token = lockToken();
  const deadline = Date.now() + waitMs;
  let delay = 25;
  for (;;) {
    let ok = false;
    try {
      ok = await s.setIfAbsent(`lock:${key}`, token, { ttlMs });
    } catch (e) {
      console.warn(`⚠️ נעילה מבוזרת לא זמינה (${e?.message || e}) — ממשיכים עם נעילה מקומית בלבד.`);
      return null;
    }
    if (ok) return token;
    if (Date.now() >= deadline) return null;
    await sleep(delay);
    delay = Math.min(250, Math.round(delay * 1.6));
  }
}

export async function releaseLock(key, token) {
  if (!token) return false;
  try { return await store().deleteIfEquals(`lock:${key}`, token); }
  catch { return false; }
}

/**
 * ההגנה שהקוד העסקי משתמש בה: נעילה מקומית תמיד, ומבוזרת כשיש Redis.
 *
 * חשוב: הנעילה המבוזרת נתפסת **בתוך** המקומית. כך תהליך אחד לא שולח
 * עשרות בקשות מקבילות ל-Redis על אותו מפתח — הוא כבר סדר אותן בתור.
 */
export async function withGuestLock(key, fn, { ttlMs = 30_000, waitMs = 10_000 } = {}) {
  return withLock(key, async () => {
    if (!isDistributed()) return fn();
    const token = await acquireLock(key, { ttlMs, waitMs });
    if (!token) {
      // לא הצלחנו לתפוס (עומס/תקלה) — ממשיכים בכל זאת. עדיף סיכון
      // נדיר לכפילות מאשר אורח שנשאר בלי מענה.
      console.warn(`⚠️ לא נתפסה נעילה מבוזרת ל-"${key}" תוך ${waitMs}ms — ממשיכים עם הנעילה המקומית.`);
      return fn();
    }
    try { return await fn(); }
    finally { await releaseLock(key, token); }
  });
}

/**
 * הגבלת קצב משותפת לכל התהליכים — חלון קבוע.
 * בלי זה N תהליכים = פי N הודעות מותרות לאותו אורח.
 * מחזיר { allowed, count, limit }.
 */
export async function checkSharedRate(key, { limit = 60, windowMs = 60_000 } = {}) {
  try {
    const count = await store().increment(`rate:${key}`, { ttlMs: windowMs });
    return { allowed: count <= limit, count, limit };
  } catch {
    // תקלה ב-store לא חוסמת אורחים.
    return { allowed: true, count: 0, limit, degraded: true };
  }
}
