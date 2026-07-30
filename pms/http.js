// ════════════════════════════════════════════════════════
//  PMS HTTP — שכבת התקשורת המשותפת לכל ספקי ה-PMS
//  ----------------------------------------------------------
//  כל אדפטר PMS (Optima, Apaleo, Mews, Opera…) צריך בדיוק את אותם דברים:
//  timeout קשיח, ניסיונות חוזרים על תקלה *חולפת בלבד*, סיווג שגיאות אחיד,
//  ו**איסור מוחלט על הדפסת סודות**. במקום לשכפל את זה בכל ספק — כאן.
//
//  🔴 סיווג השגיאות הוא העיקר, ולא קישוט: בלי הבחנה בין "המפתח שגוי"
//     (תקלה קבועה — אין טעם לנסות שוב, וצריך לצעוק) לבין "השרת עמוס"
//     (חולפת — כן לנסות שוב, לא להקים רעש), המערכת או מפציצה ספק שנפל
//     או שותקת על מפתח פסול. אותה טעות בדיוק כבר נתפסה ב-places/ (§7.2).
// ════════════════════════════════════════════════════════
import { withTimeout, retryWithBackoff } from "../concurrency.js";

export const PMS_ERROR = Object.freeze({
  AUTH:        "auth",          // 401/403 — פרטי הזדהות שגויים/חסרי הרשאה. קבוע.
  NOT_FOUND:   "not_found",     // 404 — ההזמנה/החדר לא קיים. קבוע (ולגיטימי).
  RATE_LIMIT:  "rate_limited",  // 429 — חריגה מקצב. חולף.
  UNAVAILABLE: "unavailable",   // 5xx / רשת / timeout. חולף.
  BAD_REQUEST: "bad_request",   // 400/422 — הבקשה שגויה. קבוע (באג אצלנו).
  PARSE:       "parse",         // תשובה שלא הצלחנו לפרסר.
});

export class PmsHttpError extends Error {
  constructor(kind, message, { status = 0, provider = "pms", op = "", body = "" } = {}) {
    super(`[${provider}:${op}] ${message}`);
    this.name     = "PmsHttpError";
    this.kind     = kind;
    this.status   = status;
    this.provider = provider;
    this.op       = op;
    // גוף התשובה נשמר *מקוצר* לצורכי דיבוג. אף פעם לא כולל את הכותרות,
    // שם שם יושבים הטוקנים.
    this.body     = String(body || "").slice(0, 500);
    this.retryable = kind === PMS_ERROR.RATE_LIMIT || kind === PMS_ERROR.UNAVAILABLE;
  }
}

export function classifyStatus(status) {
  if (status === 401 || status === 403) return PMS_ERROR.AUTH;
  if (status === 404)                   return PMS_ERROR.NOT_FOUND;
  if (status === 429)                   return PMS_ERROR.RATE_LIMIT;
  if (status >= 500)                    return PMS_ERROR.UNAVAILABLE;
  if (status >= 400)                    return PMS_ERROR.BAD_REQUEST;
  return null;
}

// 🔒 ניקוי כותרות לפני *כל* לוג. הכלל: אף פעם לא מדפיסים ערך של כותרת
//    שקשורה להזדהות — רק את שמה, כדי שעדיין אפשר לדבג "שלחתי Authorization?".
const SECRET_HEADERS = /^(authorization|x-api-key|apikey|api-key|cookie|x-auth-token|password)$/i;
export function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADERS.test(k) ? "«redacted»" : v;
  }
  return out;
}

// 🔒 סוד ב-URL. ספקים שמזדהים דרך query string (`?apiKey=…`) הופכים כל
//    הדפסת כתובת לדליפה — בלוג, בטיקט תמיכה, או במייל לספק. מסננים לפי
//    שם הפרמטר, ומשאירים את שאר הכתובת קריאה לאבחון.
const SECRET_QUERY_PARAMS = /^(apikey|api_key|key|token|access_token|password|pwd|secret|sig|signature)$/i;
export function redactUrlSecrets(url) {
  try {
    const u = new URL(url);
    for (const name of [...u.searchParams.keys()]) {
      if (SECRET_QUERY_PARAMS.test(name)) u.searchParams.set(name, "«redacted»");
    }
    return u.toString();
  } catch {
    // לא URL תקין — עדיף להחזיר כלום מאשר להדליף בטעות.
    return String(url).replace(/([?&](?:api_?key|token|password|secret|sig)=)[^&]*/gi, "$1«redacted»");
  }
}

/**
 * קריאת HTTP לספק PMS, עם timeout, retry על תקלה חולפת בלבד, וסיווג אחיד.
 *
 * fetchImpl מוזרק כדי שבדיקות ירוצו בלי רשת — זו גם הדרך היחידה לבדוק
 * את מסלולי השגיאה (401/429/5xx) באופן דטרמיניסטי.
 */
export async function pmsFetch(url, {
  method = "GET",
  headers = {},
  body = null,
  timeoutMs = 12_000,
  attempts = 3,
  provider = "pms",
  op = "request",
  expect = "json",          // "json" | "text" | "xml"
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new PmsHttpError(PMS_ERROR.UNAVAILABLE, "no fetch implementation available", { provider, op });
  }

  const run = async () => {
    let res;
    try {
      res = await withTimeout(
        () => fetchImpl(url, { method, headers, body }),
        timeoutMs,
        `${provider}.${op}`,
      );
    } catch (e) {
      // רשת/timeout — חולף.
      throw new PmsHttpError(PMS_ERROR.UNAVAILABLE, e?.message || "network error", { provider, op });
    }

    const status = res?.status ?? 0;
    const kind   = classifyStatus(status);
    if (kind) {
      let text = "";
      try { text = await res.text(); } catch { /* גוף לא קריא */ }
      throw new PmsHttpError(kind, `HTTP ${status}`, { status, provider, op, body: text });
    }

    if (expect === "text" || expect === "xml") {
      try { return { status, data: await res.text() }; }
      catch (e) { throw new PmsHttpError(PMS_ERROR.PARSE, e?.message || "cannot read body", { status, provider, op }); }
    }
    try {
      return { status, data: await res.json() };
    } catch (e) {
      throw new PmsHttpError(PMS_ERROR.PARSE, `invalid JSON: ${e?.message || e}`, { status, provider, op });
    }
  };

  return retryWithBackoff(run, {
    attempts,
    baseMs: 400,
    // חוזרים *רק* על תקלה חולפת. מפתח שגוי או 404 — אין טעם, ורק מחמיר.
    shouldRetry: (e) => e instanceof PmsHttpError && e.retryable,
  });
}
