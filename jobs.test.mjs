// ════════════════════════════════════════════════════════
//  JOBS — משגיח העבודות המחזוריות
//  ----------------------------------------------------------
//  🔴 הבאג שזה סוגר: חיוב ה-no-show היה קיים, נבדק, ומתועד כ"cron יריץ
//     את זה" — ושום דבר לא הריץ אותו. אורח שעזב בלי צ'ק אאוט לא חויב,
//     בשקט. הבדיקות כאן מוודאות שהמשגיח עצמו אמין: לא חופף, לא נופל,
//     ולא "נעלם" בלי שאפשר לראות זאת.
// ════════════════════════════════════════════════════════
import { test } from "node:test";
import assert from "node:assert/strict";
import { startJob, stopJob, stopAllJobs, jobsStatus, runJobNow } from "./jobs.js";

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

test("עבודה רצה מיד בעלייה, ואפשר לראות את מצבה", async () => {
  let runs = 0;
  startJob("t-basic", () => { runs++; return { ok: runs }; }, { everyMs: 60_000 });
  await tick();

  assert.equal(runs, 1, "🔴 עבודה שלא רצה בעלייה מתחילה לעבוד רק אחרי המרווח הראשון");
  const s = jobsStatus().find(j => j.name === "t-basic");
  assert.equal(s.runs, 1);
  assert.equal(s.errors, 0);
  assert.deepEqual(s.lastResult, { ok: 1 });
  assert.ok(s.lastRunAt, "יש חותמת זמן — בלעדיה אי אפשר לדעת שהעבודה מתה");
  stopJob("t-basic");
});

test("🔴 עבודה איטית אינה חופפת לעצמה", async () => {
  let started = 0, finished = 0;
  startJob("t-slow", async () => {
    started++;
    await tick(120);          // ארוך מהמרווח — בכוונה
    finished++;
  }, { everyMs: 20 });

  await tick(200);
  stopJob("t-slow");
  // בלי הגנת אי-חפיפה, `started` היה מזנק (כל 20ms עוד ריצה) והתהליך
  // היה נחנק תחת עומס.
  assert.ok(started <= 3, `🔴 העבודה נערמה על עצמה — ${started} ריצות במקביל`);
  assert.ok(finished >= 1);
});

test("🔴 שגיאה בעבודה אינה מפילה ואינה עוצרת את הסבבים הבאים", async () => {
  let runs = 0;
  startJob("t-throws", () => {
    runs++;
    throw new Error("כשל מכוון");
  }, { everyMs: 25 });

  await tick(120);
  const s = jobsStatus().find(j => j.name === "t-throws");
  stopJob("t-throws");

  assert.ok(runs >= 2, "🔴 סבב שנכשל עצר את העבודה לתמיד");
  assert.ok(s.errors >= 2);
  assert.equal(s.runs, 0, "ריצה שנכשלה אינה נספרת כהצלחה");
  assert.match(s.lastError, /כשל מכוון/, "השגיאה נשמרת — אחרת אי אפשר לאבחן");
});

test("רישום כפול אינו יוצר שתי עבודות", async () => {
  let a = 0;
  startJob("t-dup", () => { a++; }, { everyMs: 60_000 });
  startJob("t-dup", () => { a += 100; }, { everyMs: 60_000 });   // מתעלם
  await tick();
  assert.equal(a, 1, "🔴 שני טיימרים על אותה עבודה = חיוב/התראה כפולים");
  assert.equal(jobsStatus().filter(j => j.name === "t-dup").length, 1);
  stopJob("t-dup");
});

test("הרצה מיידית ידנית (כפתור בדשבורד)", async () => {
  let runs = 0;
  startJob("t-manual", () => { runs++; }, { everyMs: 60_000, runAtStart: false });
  assert.equal(runs, 0, "runAtStart:false אכן לא הריץ");

  await runJobNow("t-manual");
  assert.equal(runs, 1);
  assert.deepEqual(await runJobNow("nope"), { notFound: true });
  stopJob("t-manual");
});

test("עצירה מפסיקה באמת (כיבוי חינני)", async () => {
  let runs = 0;
  startJob("t-stop", () => { runs++; }, { everyMs: 20 });
  await tick(60);
  const at = runs;
  stopJob("t-stop");
  await tick(80);
  assert.equal(runs, at, "🔴 העבודה המשיכה אחרי עצירה");
  assert.equal(jobsStatus().find(j => j.name === "t-stop"), undefined);
});

test("stopAllJobs מנקה הכול", async () => {
  startJob("t-a", () => {}, { everyMs: 60_000 });
  startJob("t-b", () => {}, { everyMs: 60_000 });
  assert.ok(jobsStatus().length >= 2);
  stopAllJobs();
  assert.equal(jobsStatus().length, 0);
});
