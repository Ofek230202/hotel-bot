// ════════════════════════════════════════════════════════
//  HTTP-ASYNC — האנדלר אסינכרוני שזורק לא ישאיר בקשה תלויה
//  ----------------------------------------------------------
//  ── הבאג השקט ש-Express 4 מזמין ─────────────────────────
//  🔴 ב-Express 4 (בניגוד ל-5) דחיית promise בתוך האנדלר **אינה נתפסת**.
//     התוצאה אינה 500 — היא **כלום**: הבקשה נשארת פתוחה עד שהדפדפן
//     מוותר. האורח רואה עמוד שנטען לנצח בדיוק ברגע שהוא מוסר פרטי כרטיס,
//     ובלוג יש רק `unhandledRejection` בלי שום קשר לבקשה.
//
//  ── למה עטיפה מרכזית ולא try/catch בכל נתיב ────────────
//  היו 13 נתיבים אסינכרוניים בלי הגנה. אפשר היה להוסיף 13 בלוקים — אבל
//  אז הנתיב ה-14 שייכתב בעתיד ייכתב בלי, ואיש לא ישים לב. עטיפה של
//  ה-router עצמו חלה גם על מה שעוד לא נכתב, וזו ההגנה היחידה ששורדת.
//
//  לא נוגע ב-error middleware (4 ארגומנטים) ולא במידלוור סינכרוני.
// ════════════════════════════════════════════════════════

const METHODS = ["get", "post", "put", "patch", "delete", "all", "use"];

/**
 * עוטף את מתודות הניתוב של app/router כך שכל דחייה תגיע ל-`next(err)`,
 * ומשם ל-error handler — במקום להיעלם.
 * מחזיר את אותו אובייקט (לשרשור).
 */
export function catchAsyncRoutes(target) {
  for (const m of METHODS) {
    if (typeof target[m] !== "function") continue;
    const orig = target[m].bind(target);
    target[m] = (...args) =>
      orig(...args.map(a =>
        typeof a === "function" && a.length < 4 ? wrap(a) : a
      ));
  }
  return target;
}

function wrap(handler) {
  const wrapped = function (req, res, next) {
    try {
      const out = handler.call(this, req, res, next);
      // האנדלר סינכרוני → אין promise, אין מה לתפוס.
      if (out && typeof out.then === "function") out.catch(next);
      return out;
    } catch (e) {
      // חריגה סינכרונית — Express תופס אותה לבד, אבל מעבירים במפורש
      // כדי ששני המסלולים יתנהגו זהה.
      next(e);
    }
  };
  // שמירת השם עוזרת בסטאק טרייס ובדיבוג.
  Object.defineProperty(wrapped, "name", { value: handler.name || "asyncHandler" });
  return wrapped;
}

/**
 * ה-error handler הסופי. חייב להירשם **אחרי** כל הנתיבים.
 * מחזיר תשובה תמיד — זו כל הנקודה.
 *
 * `isHtml` — נתיבי עמודים מחזירים HTML קריא לאורח; נתיבי API מחזירים JSON.
 */
export function errorHandler({ onError = null } = {}) {
  return (err, req, res, _next) => {
    // לוג מלא לצוות, בלי לחשוף פרטים פנימיים ללקוח.
    console.error(`🚨 שגיאה בבקשה ${req.method} ${req.originalUrl}:`, err?.stack || err?.message || err);
    try { onError?.(err, req); } catch { /* לוג נכשל — לא מפיל את התשובה */ }

    if (res.headersSent) return;   // כבר התחלנו לענות — אין מה לעשות

    const wantsJson = req.originalUrl?.startsWith("/api/") ||
                      (req.headers?.accept || "").includes("application/json");

    if (wantsJson) {
      res.status(500).json({ error: "internal error" });
      return;
    }
    // עמוד לאורח: קצר, בשתי השפות, ובלי פרטים טכניים.
    res.status(500).type("html").send(
      `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>שגיאה זמנית</title></head><body style="font-family:system-ui;padding:2rem;text-align:center">` +
      `<h1 style="font-size:1.3rem">אירעה תקלה זמנית</h1>` +
      `<p>נא לנסות שוב בעוד רגע, או לפנות לקבלה.</p>` +
      `<hr style="margin:1.5rem 0;border:0;border-top:1px solid #ddd">` +
      `<p lang="en" dir="ltr">A temporary error occurred. Please try again shortly, or contact reception.</p>` +
      `</body></html>`
    );
  };
}
