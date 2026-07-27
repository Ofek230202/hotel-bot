// ════════════════════════════════════════════════════════
//  TEST DB PATH — נתיב DB ייחודי ומתנקה לכל הרצת בדיקות
//  ----------------------------------------------------------
//  🔴 למה זה קיים: קבצי הבדיקה השתמשו ב-`hotel-<label>-${pid}.db`.
//     מערכת ההפעלה *ממחזרת* מזהי תהליך (pid), וקבצי DB ישנים נשארו
//     ב-tmpdir — כך שהרצה חדשה עם pid ממוחזר טענה (hydrate) סשנים
//     והזמנות מהרצה קודמת. זה גרם לבדיקת חירום להבהב: סשן "טרי" קיבל
//     מצב ישן (חדר 812, emergencyAwaitLocation) ושבר את זרימת המיקום.
//     (קוד המוצר תקין — הוא *אמור* לשמור ולשחזר; הבדיקה היא שדרשה בידוד.)
//
//  התיקון: נתיב ייחודי לכל *הרצה* (pid + זמן + אקראי) → אין התנגשות
//  לעולם, גם כשה-pid ממוחזר. בנוסף: מחיקה בכניסה (הגנה) וניקוי ביציאה
//  (למנוע הצטברות קבצים ב-tmpdir). כולל את קבצי ה-WAL/SHM של SQLite.
// ════════════════════════════════════════════════════════
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function freshTestDbPath(label = "test") {
  const p = path.join(
    os.tmpdir(),
    `hotel-${label}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`,
  );
  const clean = () => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try { fs.unlinkSync(p + suffix); } catch { /* לא קיים — תקין */ }
    }
  };
  clean();                     // הגנה: אם איכשהו כבר קיים — מתחילים נקי
  process.on("exit", clean);   // ניקוי ביציאה — בלי להשאיר קבצים ב-tmpdir
  return p;
}
