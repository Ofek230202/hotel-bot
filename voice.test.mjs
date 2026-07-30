// ════════════════════════════════════════════════════════
//  VOICE — בדיקות לתקן הניסוח
//  ----------------------------------------------------------
//  מבקר סגנון שווה בדיוק כמה שאפשר לסמוך עליו. מבקר שמדווח הפרה שאינה
//  קיימת — מפסיקים להקשיב לו, וזה גרוע מלא לבדוק בכלל. לכן כל כלל נבדק
//  **בשני הכיוונים**: תופס את מה שצריך, ו**לא** תופס את מה שתקין.
//
//  שלושת המקרים התקינים שנפלו בגרסה הראשונה מתועדים כאן במפורש — הם
//  היו שקריים, והבדיקות האלה מונעות מהם לחזור.
// ════════════════════════════════════════════════════════
import { test } from "node:test";
import assert from "node:assert/strict";

const { auditText, auditAll, VOICE_RULES } = await import("./voice.js");

const ids = (t, opts) => auditText(t, opts).map(v => v.rule);
const has = (t, rule, opts) => ids(t, opts).includes(rule);

// ════════════════════════════════════════════════════════
//  תופס את מה שצריך
// ════════════════════════════════════════════════════════
test("תופס: מכניקה שמסגירה כתיבה חפוזה", () => {
  assert.ok(has("שלום  לך", "double-space"));
  assert.ok(has("רגע אחד...", "three-dots"));
  assert.ok(has("באמת?!?", "double-punct"));
  assert.ok(has("תודה , דנה", "space-before-punct"));
  assert.ok(has("א\n\n\n\nב", "blank-lines"));
});

test("תופס: טקסט שנכתב למסך אחר", () => {
  assert.ok(has("**מודגש**", "markdown-leak"));
  assert.ok(has("| --- | --- |", "markdown-leak"));
  assert.ok(has("ברוכים הבאים ל{hotel}", "placeholder"));
  assert.ok(has("החדר שלך undefined", "code-value"));
  assert.ok(has("מעביר [HK: מגבות]", "internal-tag"));
});

test("תופס: טון שאינו של מלון יוקרה", () => {
  assert.ok(has("מעולה! נהדר! מושלם!", "exclamations"));
  assert.ok(has("היי 😊🌟✨ ברוכים הבאים", "emoji-run"));
  assert.ok(has("נא להקליד/י את השם", "slash-gender"));
  assert.ok(has("PLEASE CONFIRM YOUR BOOKING", "all-caps"));
});

test("תופס: ביטויים אסורים — עם הסבר למה", () => {
  for (const t of [
    "אני בוט ואשמח לעזור",
    "אין לי מידע על השעות",
    "אירעה תקלה טכנית",
    "אולי כדאי, אולי לא",
    "מצטער, מצטער על ההמתנה",
  ]) {
    const v = auditText(t).find(x => x.rule === "forbidden-phrase");
    assert.ok(v, `לא נתפס: "${t}"`);
    assert.ok(v.why && v.why.length > 12, "לכל הפרה יש הסבר שמלמד מה לעשות במקום");
  }
});

test("תופס: הודעה ריקה", () => assert.ok(has("   ", "empty")));

// ════════════════════════════════════════════════════════
//  לא תופס תקין — שלושת המקרים שנפלו בגרסה הראשונה
// ════════════════════════════════════════════════════════
test("לא תופס: מזהה הזמנה אינו צעקה באנגלית", () => {
  // 🔴 "RES-VOICE-1" סומן כ-all-caps. מזהים אינם צעקה.
  assert.ok(!has("✅ *הזמנה מספר RES-VOICE-1 אותרה!*", "all-caps"));
  assert.ok(!has("Reservation KEMP-5502 found", "all-caps"));
  assert.ok(!has("WiFi: LALA_Guest", "all-caps"));
  // אבל מילה אמיתית בקפסלוק כן נתפסת
  assert.ok(has("URGENT PLEASE RESPOND", "all-caps"));
});

test("לא תופס: גרשיים בראשי תיבות עבריים הם כתיב תקני", () => {
  // 🔴 בע"מ / ת"ז / ע.מ סומנו כ"ציטוט". זה כתיב תקני.
  assert.ok(!has('לאלה בוטיק בע"מ · ע.מ/ח.פ 515111222', "hebrew-quotes"));
  assert.ok(!has('נדרשת ת"ז בתוקף', "hebrew-quotes"));
  // ציטוט אמיתי של ביטוי כן מסומן (info)
  assert.ok(has('האורח כתב "היה מצוין מאוד"', "hebrew-quotes"));
});

test("לא תופס: אמוג׳י כתווית שדה, ו-⚠️ אינו שני אמוג׳י", () => {
  // 🔴 שתי תקלות: (א) אמוג׳י בתחילת שורה הוא תווית ולא קישוט;
  //    (ב) "⚠️" הוא שני קודפוינטים, ונספר כשניים — כך "📝 ⚠️" נראה
  //    כשלושה ברצף. שתיהן דיווחו הפרות שלא היו.
  const fieldLabels = "🚪 חדר: 7\n📅 הגעה: ראשון\n📆 עזיבה: שלישי\n👥 אורחים: 2\n🕐 שעה: 16:00\n🔑 קוד: 1234";
  assert.ok(!has(fieldLabels, "emoji-density"), "תוויות שדה אינן צפיפות");
  assert.ok(!has(fieldLabels, "emoji-run"), "שורות נפרדות אינן רצף");

  assert.ok(!has("📝 ⚠️ חיובים מעל הפיקדון", "emoji-run"), "⚠️ אינו שני אמוג׳י");
  assert.ok(!has("🚨 *דחוף* 🚨\n🏨 *RECEPTION*", "emoji-run"), "טקסט בין אמוג׳י אינו רצף");

  // רצף אמיתי כן נתפס
  assert.ok(has("תודה 🌟✨😊 שהגעת", "emoji-run"));
});

test("לא תופס: הודעות אמיתיות מהמערכת נקיות", () => {
  const real = [
    "✅ *צ'ק אין אושר!*\n\nברוכים הבאים, *דנה כהן*! 🌟\n\n🚪 *חדר:* 7\n\nלכל בקשה — אני כאן.",
    "📅 מתי מתוכננת השהייה שלך — תאריך הגעה ותאריך עזיבה?",
    "🔎 רגע אחד — בודקים את המסמך…",
    "Thank you so much for the kind words! 🌟 It was a pleasure hosting you.",
    "🧾 *חשבונית מס-קבלה* — מס' 2026-00001\nלאלה בוטיק בע\"מ · ע.מ/ח.פ 515111222",
  ];
  for (const t of real) {
    const errs = auditText(t).filter(v => v.severity === "error");
    assert.equal(errs.length, 0, `הודעה תקינה סומנה: ${JSON.stringify(errs)}\n${t}`);
  }
});

// ════════════════════════════════════════════════════════
//  התראות צוות — מסמך תפעולי, לא חוויית אורח
// ════════════════════════════════════════════════════════
test("צוות: כללי אלגנטיות לא חלים, אך כללי נכונות כן", () => {
  const alert = "🚨 *דחוף* 🚨\n🏨 *RECEPTION*\n\n👤 אורח: דנה כהן\n🚪 חדר: 7\n📝 בקשה!!! דחופה";
  const r = ids(alert, { staff: true });
  assert.ok(!r.includes("emoji-density"), "צפיפות מותרת בהתראה תפעולית");
  assert.ok(r.includes("double-punct"), "אבל פיסוק שבור עדיין נתפס");

  // תג פנימי בהתראת צוות הוא תקין — זה בדיוק מה שהיא מעבירה.
  assert.ok(!ids("📝 [HK: מגבות]", { staff: true }).includes("internal-tag"));
  assert.ok(ids("📝 [HK: מגבות]").includes("internal-tag"), "אבל לאורח — לעולם לא");
});

// ════════════════════════════════════════════════════════
//  שלמות
// ════════════════════════════════════════════════════════
test("שלמות: לכל כלל יש מזהה, חומרה והסבר", () => {
  assert.ok(VOICE_RULES.length >= 15);
  for (const r of VOICE_RULES) {
    assert.ok(r.id, "לכל כלל מזהה");
    assert.ok(["error", "warn", "info"].includes(r.severity), `${r.id}: חומרה לא חוקית`);
    assert.ok(r.why && r.why.length > 8, `${r.id}: הסבר חסר`);
    assert.equal(typeof r.test, "function");
  }
  const dupes = VOICE_RULES.map(r => r.id).filter((v, i, a) => a.indexOf(v) !== i);
  assert.deepEqual(dupes, [], "מזהי כללים ייחודיים");
});

test("auditAll מסכם לפי חומרה וכלל", () => {
  const res = auditAll([
    { body: "שלום  לך", to: "a" },
    { body: "טקסט תקין לגמרי", to: "b" },
    { body: "רגע...", to: "c" },
  ]);
  assert.equal(res.bySeverity.error, 2);
  assert.equal(res.clean, false);
  assert.ok(res.byRule["double-space"] === 1 && res.byRule["three-dots"] === 1);
  assert.ok(res.violations.every(v => v.sample), "לכל הפרה יש דוגמה שמישה");

  assert.equal(auditAll([{ body: "הכול בסדר גמור", to: "x" }]).clean, true);
});

// ════════════════════════════════════════════════════════
//  הפלט האמיתי של המערכת עומד בתקן
// ════════════════════════════════════════════════════════
test("הודעות הפתיחה של שני המלונות עומדות בתקן", async () => {
  const config = await import("./config.js");
  for (const hid of ["lala", "kempinski"]) {
    for (const lang of ["he", "en"]) {
      const errs = auditText(config.welcomeFor(hid, lang)).filter(v => v.severity !== "info");
      assert.equal(errs.length, 0, `${hid}/${lang}: ${JSON.stringify(errs)}`);
    }
  }
});
