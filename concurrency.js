// ════════════════════════════════════════════════════════
//  CONCURRENCY — עומס גבוה בלי קריסה, בלי כפילויות, בלי אובדן
//  ----------------------------------------------------------
//  היעד: 100 מלונות × 1000 אורחים שכותבים בו-זמנית. שלוש בעיות עומס
//  שונות, וכלי אחד לכל אחת. אין כאן שום תלות חיצונית — הכול בזיכרון
//  התהליך, ולכן זה מגן על *תהליך בודד*. לריבוי תהליכים/מכונות צריך את
//  אותם רעיונות מעל Redis (נעילה מבוזרת) — ראה SCALING.md.
//
//   1. withLock       — סריאליזציה per-key. שתי הודעות של אותו אורח
//                       לא ירוצו במקביל ולא ידרסו זו את מצב זו.
//   2. Semaphore      — תקרה על פעולות יקרות במקביל (קריאות ל-AI), כדי
//                       ש-1000 אורחים לא יפתחו 1000 חיבורים ל-Anthropic.
//   3. RateLimiter    — דלי אסימונים per-key (אורח/מלון) נגד הצפה/abuse.
//   + withTimeout / retryWithBackoff — שירות איטי או תקלה חולפת לא
//     תוקעים ולא מפילים; מנסים שוב עם השהיה גדֵלה.
// ════════════════════════════════════════════════════════

// ── 1. נעילה per-key (mutex תורי) ──────────────────────
// כל מפתח (למשל "hotel\0phone") מקבל שרשרת promise. עבודה חדשה מחכה
// לזנב השרשרת ואז רצה — כך פעולות על אותו מפתח מבוצעות *בזו אחר זו*,
// גם אם הגיעו יחד. מפתחות שונים רצים במקביל בלי הפרעה.
//
// חשוב: השגיאה של fn מוחזרת לקורא (await withLock ...), אבל *הזנב*
// לעולם לא נדחה — אחרת כשל אחד היה שובר את התור של אותו אורח לתמיד.
const _chains = new Map();

export function withLock(key, fn) {
  const prev = _chains.get(key) || Promise.resolve();
  // מריצים את fn אחרי שהקודם נגמר — לא משנה אם הצליח או נכשל.
  const run = prev.then(fn, fn);
  // הזנב בולע תוצאה/שגיאה כדי שהשרשרת תמשיך תמיד.
  const tail = run.then(noop, noop).finally(() => {
    // ניקוי דליפת זיכרון: אם אנחנו הזנב האחרון, מוחקים את המפתח.
    if (_chains.get(key) === tail) _chains.delete(key);
  });
  _chains.set(key, tail);
  return run;
}

// כמה מפתחות פעילים כרגע (לניטור/בדיקות).
export function lockDepth() {
  return _chains.size;
}

function noop() {}

// ── 2. סמפור — תקרת מקביליות גלובלית ───────────────────
// מגביל כמה פעולות יקרות רצות בו-זמנית. עבודה מעבר לתקרה ממתינה בתור
// FIFO ומשוחררת כשמשבצת מתפנה. משמש לקריאות ל-Anthropic: 1000 אורחים
// בו-זמנית → לכל היותר N קריאות פתוחות, השאר מחכות רגע. בלי זה מציפים
// את ה-API (429) ואת הזיכרון.
export function createSemaphore(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length) {
      active++;
      const { fn, resolve, reject } = queue.shift();
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => { active--; pump(); });
    }
  };
  const run = (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
  run.stats = () => ({ active, queued: queue.length, max });
  return run;
}

// ── 3. withTimeout — פעולה תקועה לא תוקעת את הכול ───────
// עוטף פעולה ב-timeout קשיח. אם עברו ms — דוחה בשגיאה ברורה. הקורא
// יכול לתפוס ולתת לאורח מענה גיבוי במקום להקפיא אותו.
export function withTimeout(fn, ms, label = "operation") {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    Promise.resolve()
      .then(fn)
      .then(
        (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
        (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } },
      );
  });
}

// ── retryWithBackoff — תקלה חולפת → מנסים שוב, בהשהיה גדֵלה ──
// baseMs, factor: 300ms → 600ms → 1200ms. jitter מפזר את הניסיונות כדי
// שלא כל האורחים ינסו שוב באותו רגע (thundering herd). shouldRetry
// מאפשר לא לנסות שוב על שגיאות שלא ישתנו (למשל 400/401).
export async function retryWithBackoff(fn, opts = {}) {
  const { attempts = 3, baseMs = 300, factor = 2, jitter = true, shouldRetry } = opts;
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (shouldRetry && !shouldRetry(e)) break;
      if (i < attempts) {
        let delay = baseMs * factor ** (i - 1);
        if (jitter) delay = delay / 2 + Math.random() * (delay / 2);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── RateLimiter — דלי אסימונים per-key ─────────────────
// capacity אסימונים, מתמלאים refillPerSec לשנייה. כל בקשה מבזבזת אסימון;
// אין אסימונים → allow=false והקורא דוחה בנימוס. מגן מפני אורח בודד
// (או תקלה) שמפציץ הודעות, ומפני מלון שמנצל יתר על המידה משאב משותף.
// now מוזרק אופציונלית כדי שבדיקות יוכלו לשלוט בזמן.
export function createRateLimiter({ capacity = 20, refillPerSec = 1 } = {}) {
  const buckets = new Map();
  const limiter = (key, now = Date.now()) => {
    let b = buckets.get(key);
    if (!b) { b = { tokens: capacity, last: now }; buckets.set(key, b); }
    const elapsed = Math.max(0, (now - b.last) / 1000);
    b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
    b.last = now;
    if (b.tokens >= 1) { b.tokens -= 1; return true; }
    return false;
  };
  limiter.size = () => buckets.size;
  // ניקוי דליים ישנים (למניעת דליפה כשיש מיליוני מפתחות לאורך זמן).
  limiter.sweep = (now = Date.now(), idleMs = 3600_000) => {
    for (const [k, b] of buckets) if (now - b.last > idleMs) buckets.delete(k);
  };
  return limiter;
}
