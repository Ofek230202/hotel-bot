// ════════════════════════════════════════════════════════
//  JOBS — עבודות מחזוריות שחייבות לרוץ בלי שאיש לוחץ על כלום
//  ----------------------------------------------------------
//  ── הבאג שזה סוגר ───────────────────────────────────────
//  🔴 חיוב ה-no-show היה קיים, נבדק, ומתועד כ"בפרודקשן cron יריץ את זה"
//     — **ושום דבר לא הריץ אותו.** רק `POST /api/no-show` ידני. כלומר
//     אורח שעזב בלי צ'ק אאוט פשוט לא חויב, בשקט, והמלון ספג את ההפרש.
//     "יש cron" בתיעוד בלי cron בקוד גרוע מפיצ'ר חסר: כולם מניחים שהוא
//     עובד.
//
//  ── למה מודול נפרד ולא עוד `setInterval` ב-server.js ───
//  כל עבודה מחזורית צריכה את אותם ארבעה דברים, ואם כל אחת מממשת אותם
//  לבד — אחת מהן תשכח:
//   1. **לא חופפת לעצמה** — ריצה שנתקעה לא מפעילה שנייה מעליה.
//   2. **לא מפילה את התהליך** — שגיאה נרשמת וממשיכים לסבב הבא.
//   3. **`unref`** — עבודה מחזורית לא מונעת יציאה תקינה של התהליך.
//   4. **ניתנת לניטור** — כמה רצה, כמה נכשלה, מתי הריצה האחרונה.
//
//  ⚠️ ריבוי עותקים: העבודות עצמן מגינות על עצמן (`withGuestLock` על
//     ההזמנה/האירוע), ולכן בטוח שכל עותק יריץ את הסורק. אין "מנהיג".
// ════════════════════════════════════════════════════════

const registry = new Map();   // name → job state

/**
 * רושם ומפעיל עבודה מחזורית.
 * `fn` יכולה להיות אסינכרונית; ריצה חדשה לא תתחיל לפני שהקודמת נגמרה.
 */
export function startJob(name, fn, { everyMs, runAtStart = true } = {}) {
  if (registry.has(name)) return registry.get(name);   // אידמפוטנטי

  const state = {
    name, everyMs, running: false,
    runs: 0, errors: 0, lastRunAt: null, lastError: null, lastResult: null,
  };

  const tick = async () => {
    // 🔴 אי-חפיפה: סורק שלוקח יותר מהמרווח היה מצטבר על עצמו עד שהתהליך
    //    נחנק. מדלגים במקום לערום.
    if (state.running) {
      console.warn(`⏭️  עבודה "${name}" עדיין רצה — מדלגים על הסבב הזה.`);
      return;
    }
    state.running = true;
    try {
      state.lastResult = await fn();
      state.runs++;
    } catch (e) {
      state.errors++;
      state.lastError = e?.message || String(e);
      // שגיאה בעבודה אחת לא מפילה את התהליך ולא עוצרת את הסבבים הבאים.
      console.error(`🚨 עבודה מחזורית "${name}" נכשלה:`, e?.stack || e?.message || e);
    } finally {
      state.running = false;
      state.lastRunAt = new Date().toISOString();
    }
  };

  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  state.timer = timer;
  state._tick = tick;          // להרצה מיידית (`runJobNow`) — כולל אי-החפיפה
  registry.set(name, state);

  if (runAtStart) tick().catch(() => {});
  return state;
}

/** עוצר עבודה (בעיקר לבדיקות ולכיבוי חינני). */
export function stopJob(name) {
  const s = registry.get(name);
  if (!s) return false;
  clearInterval(s.timer);
  registry.delete(name);
  return true;
}

export function stopAllJobs() {
  for (const name of [...registry.keys()]) stopJob(name);
}

/** מצב כל העבודות — ל-`/api/jobs` ולבדיקת בריאות. */
export function jobsStatus() {
  return [...registry.values()].map(({ timer, _tick, ...s }) => ({ ...s }));
}

/** הרצה מיידית של עבודה, מחוץ לסבב (לבדיקות ולכפתור בדשבורד). */
export async function runJobNow(name) {
  const s = registry.get(name);
  if (!s) return { notFound: true };
  const before = s.runs;
  await s._tick?.();
  return { ran: s.runs > before, ...jobsStatus().find(j => j.name === name) };
}
