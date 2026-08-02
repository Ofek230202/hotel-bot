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

test("לא תופס: שם עסק אמיתי בהדגשה אינו צעקה", () => {
  // 🔴 נצפה ב-preflight: הבוט המליץ על בר תל אביבי ששמו באותיות גדולות,
  //    והמבקר הודיע שהוא "צועק". שם מקום מוצג תמיד בהדגשה, ובתל אביב
  //    שמות כאלה הם הכלל. להעניש על ציטוט נכון של שם זו תקלה במבקר.
  assert.ok(!has("🍸 *BELLBOY* · דיזנגוף 95 · פתוח עכשיו", "all-caps"));
  assert.ok(!has("• *TEDER FM* (בר) — קרליבך 12", "all-caps"));
  assert.ok(!has("I'd suggest *SPEAKEASY* on Rothschild", "all-caps"));
  // אבל צעקה בתוך משפט רגיל — עדיין נתפסת, גם כשיש שם מודגש לידה.
  assert.ok(has("🍸 *BELLBOY* — PLEASE HURRY UP", "all-caps"));
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
// ════════════════════════════════════════════════════════
//  עמודי HTML
// ════════════════════════════════════════════════════════
const { auditHtml, visibleText } = await import("./voice.js");
const htmlIds = (h, o) => auditHtml(h, o).map(v => v.rule);

const GOOD_PAGE = `<!DOCTYPE html>
<html lang="he" dir="rtl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>אישור פיקדון — לאלה בוטיק</title></head>
<body><div class="hotel">✦ לאלה בוטיק</div>
<h1>אישור פיקדון שהייה</h1>
<a href="https://wa.me/15550001007" class="back-btn">💬 חזרה לצ'אט</a>
</body></html>`;

test("HTML: עמוד תקין עובר", () => {
  assert.deepEqual(auditHtml(GOOD_PAGE).filter(v => v.severity !== "info"), []);
});

test("HTML: תופס חוסרים שמשפיעים על אורח בטלפון", () => {
  assert.ok(htmlIds(GOOD_PAGE.replace(' lang="he"', "")).includes("html-no-lang"));
  assert.ok(htmlIds(GOOD_PAGE.replace(' dir="rtl"', "")).includes("html-no-dir"));
  assert.ok(htmlIds(GOOD_PAGE.replace(/<meta name="viewport"[^>]*>/, "")).includes("html-no-viewport"));
  assert.ok(htmlIds(GOOD_PAGE.replace(/<meta charset[^>]*>/, "")).includes("html-no-charset"));
  assert.ok(htmlIds(GOOD_PAGE.replace(/<title>.*?<\/title>/, "")).includes("html-no-title"));
  // עמוד עברי שסומן ltr — הפיסוק יקפוץ לצד הלא נכון
  assert.ok(htmlIds(GOOD_PAGE.replace('dir="rtl"', 'dir="ltr"')).includes("html-dir-mismatch"));
});

test("HTML: תופס קישור מת וקישור בלי טקסט", () => {
  assert.ok(htmlIds(GOOD_PAGE.replace(/href="[^"]*"/, 'href="#"')).includes("html-dead-link"));
  assert.ok(htmlIds(GOOD_PAGE.replace(/>💬 חזרה לצ'אט</, "><")).includes("html-empty-link"));
});

// 🔴 שני הבאגים האמיתיים שנמצאו בעמודים, ושהיו בלתי נראים עם מלון אחד.
test("HTML: תופס כפתור צ'אט שמוביל למלון אחר", () => {
  const r = auditHtml(GOOD_PAGE, { expectWhatsApp: "+15550001001" });
  const v = r.find(x => x.rule === "html-wrong-whatsapp");
  assert.ok(v, "🔴 אורח נשלח לוואטסאפ של מלון אחר ואיש לא שם לב");
  assert.match(v.why, /15550001007/);
  // עם הציפייה הנכונה — נקי
  assert.ok(!htmlIds(GOOD_PAGE, { expectWhatsApp: "+15550001007" }).includes("html-wrong-whatsapp"));
});

test("HTML: תופס עמוד שממותג בשם מלון אחר", () => {
  assert.ok(htmlIds(GOOD_PAGE, { expectHotelName: "מלון קמפינסקי" }).includes("html-wrong-hotel"),
    "🔴 עמוד הפיקדון של LALA היה ממותג Kempinski");
  assert.ok(!htmlIds(GOOD_PAGE, { expectHotelName: "לאלה בוטיק" }).includes("html-wrong-hotel"));
});

test("HTML: תקן הניסוח חל גם על הטקסט הנראה", () => {
  assert.ok(htmlIds(GOOD_PAGE.replace("אישור פיקדון שהייה", "החדר שלך undefined")).includes("code-value"),
    "🔴 'undefined' בעמוד — בדיוק מה שקרה בשורת הבריכה במלון בלי בריכה");
  assert.ok(htmlIds(GOOD_PAGE.replace("אישור פיקדון שהייה", "רגע...")).includes("three-dots"));
});

test("HTML: חילוץ הטקסט הנראה מתעלם מ-CSS ו-JS", () => {
  const t = visibleText(`<style>body{color:red}</style><script>var x="הודעה סודית"</script><p>שלום</p>`);
  assert.equal(t, "שלום", "CSS/JS לא נכנסים לביקורת — אחרת מדווחים שטויות");
  assert.ok(!visibleText(GOOD_PAGE).includes("<"), "אין תגיות בטקסט הנראה");
  assert.ok(!/[ \t]$/m.test(visibleText(GOOD_PAGE)), "אין רווחים בקצה שורה מהחילוץ עצמו");
});

test("HTML: דגל הוא אמוג׳י אחד, לא שניים", () => {
  // 🔴 "💳 🇮🇱" בעמוד הפיקדון סומן כשלושה אמוג׳י ברצף: הדגל הוא זוג
  //    Regional Indicators, וטווח האמוג׳י הכללי בלע כל חצי בנפרד.
  assert.ok(!htmlIds(GOOD_PAGE.replace("<h1>", "<h1>💳 🇮🇱 ")).includes("emoji-run"));
  assert.ok(auditText("💳 🇮🇱").length === 0, "שני אמוג׳י אינם רצף");
  assert.ok(has("🎉 🎊 🥳 🌟", "emoji-run"), "אבל ארבעה כן");
});

test("HTML: אין מספר וואטסאפ קשיח בקוד המקור", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("checkin-routes.js", "utf8");
  const hard = src.match(/wa\.me\/\d{6,}/g) || [];
  assert.deepEqual(hard, [],
    `🔴 מספר קשיח בקוד: ${hard.join(", ")} — חייב להיגזר מ-fromNumberFor(hotelId)`);
});

test("הודעות הפתיחה של שני המלונות עומדות בתקן", async () => {
  const config = await import("./config.js");
  for (const hid of ["lala", "kempinski"]) {
    for (const lang of ["he", "en"]) {
      const errs = auditText(config.welcomeFor(hid, lang)).filter(v => v.severity !== "info");
      assert.equal(errs.length, 0, `${hid}/${lang}: ${JSON.stringify(errs)}`);
    }
  }
});
