// ════════════════════════════════════════════════════════
//  תקציב הזמן של הקונסיירז' + איסור דליפת תקלה פנימית לאורח
//  ----------------------------------------------------------
//  שתי תקלות שנמצאו בבדיקת עמידות חיה (04.08.2026), כששכבת המקומות
//  הוכרחה להיכשל בשמונה דרכים שונות מול Claude אמיתי:
//
//  1. 🔴 **36 שניות שקט.** כשגוגל *נתקע* (במקום להיכשל), 3 ניסיונות ×
//     9ש׳ + backoff הצטברו ל-36ש׳ לפני שהאורח קיבל משהו. retry מרפא
//     תקלת רגע; מול שירות תקוע הוא רק מכפיל את ההמתנה. עכשיו יש דדליין
//     אחד לכל הכלי, והניסיון נחתך לפי מה שנשאר ממנו.
//
//  2. 🔴 **הודעת המצב הפנימית דלפה לאורח.** ה-AI ניסח מחדש לאורח את
//     טקסט הסטטוס: "The tool didn't return live results". אורח בקמפינסקי
//     לא יודע שקיים כלי — ולכן הודעת הכשל אינה פרוזה שאפשר לצטט אלא
//     הוראה שאוסרת במפורש להזכיר אותה. (האכיפה עצמה ב-voice.js.)
//
//  אין כאן AI ואין רשת — רק הכלי עצמו מול שכבת מקומות מזויפת.
// ════════════════════════════════════════════════════════
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH                = freshTestDbPath("budget");
process.env.TWILIO_ACCOUNT_SID     = "ACtest";
process.env.TWILIO_AUTH_TOKEN      = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.ANTHROPIC_API_KEY      = "sk-test";
process.env.BASE_URL               = "http://test.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);
// תקציב קצר כדי שהבדיקה תרוץ מהר — הלוגיקה נבדקת, לא הקבוע.
process.env.PLACES_BUDGET_MS       = "1200";
process.env.PLACES_ATTEMPT_MS      = "600";

mock.module("twilio", {
  exports: { default: () => ({ messages: { create: async () => ({ sid: "SMtest" }) } }) },
});

const { runPlacesTool } = await import("./bot.js");
const { places }        = await import("./places/index.js");

const realSearch = places.searchNearby.bind(places);
function withPlaces(impl, fn) {
  places.searchNearby = impl;
  return Promise.resolve(fn()).finally(() => { places.searchNearby = realSearch; });
}

// ── 1. תקציב הזמן ───────────────────────────────────────

test("תקציב: ספק שנתקע לנצח — הכלי חוזר בתוך התקציב ולא אחריו", async () => {
  let calls = 0;
  await withPlaces(
    () => { calls++; return new Promise(() => {}); },   // לא נפתר לעולם
    async () => {
      const t0 = Date.now();
      const out = JSON.parse(await runPlacesTool({ query: "meat restaurant" }, "en"));
      const ms = Date.now() - t0;
      assert.equal(out.status, "unavailable");
      // 1200ms תקציב + מרווח נשימה. בלי הדדליין זה היה 3×600 + backoff.
      assert.ok(ms < 2500, `הכלי חרג מהתקציב: ${ms}ms`);
      assert.ok(calls >= 1, "לפחות ניסיון אחד רץ");
    },
  );
});

test("תקציב: לא מנסים שוב אחרי שהתקציב נגמר", async () => {
  let calls = 0;
  await withPlaces(
    async () => { calls++; await new Promise(r => setTimeout(r, 900)); return { ok: true, results: [] }; },
    async () => {
      await runPlacesTool({ query: "sushi" }, "en");
      // ניסיון אחד לוקח 600ms (timeout) מתוך 1200ms — אין מקום לשלושה.
      assert.ok(calls <= 2, `נעשו ${calls} ניסיונות אף שהתקציב נגמר`);
    },
  );
});

test("תקציב: תשובה מהירה לא נפגעת — התקציב אינו חותך הצלחה", async () => {
  await withPlaces(
    async () => ({ ok: true, provider: "fake", results: [
      { name: "Test Grill", address: "Somewhere 1", distanceText: "300 m", rating: 4.5, todayHours: "Tuesday: 12:00–23:00" },
    ] }),
    async () => {
      const out = JSON.parse(await runPlacesTool({ query: "grill" }, "en"));
      assert.equal(out.status, "ok");
      assert.equal(out.results[0].name, "Test Grill");
      assert.equal(out.results[0].todayHours, "Tuesday: 12:00–23:00");
    },
  );
});

// ── 2. הודעת הכשל היא הוראה פנימית, לא פרוזה לציטוט ──────

test("כשל: כל מצב כשל מסומן כלא-מיועד-לאורח ואוסר במפורש להזכיר אותו", async () => {
  const modes = [
    [async () => ({ ok: false, results: [], reason: "invalid_key" }),  ["invalid_key"]],
    // חריגת מכסה נשמרת כסיבה המדויקת ולא מטושטשת ל-"unavailable" — בלוג
    // זה ההבדל בין "גוגל חסם אותנו" ל"משהו נפל".
    // ⚠️ שתי התוצאות לגיטימיות: זו תקלה *חולפת*, ולכן היא עוברת ב-retry
    //    ובהשהיה. במכונה עמוסה (הסוויטה המלאה) התקציב עלול להיגמר בדיוק
    //    שם, ואז הסטטוס הוא "unavailable" — וזה **בדיוק ההתנהגות שרצינו**.
    //    בדיקה שדורשת אחת מהן בלבד נופלת לסירוגין, וסוויטה שנצבעת אדום
    //    באקראי היא בדיוק מה שמלמד להתעלם ממנה.
    [async () => ({ ok: false, results: [], reason: "rate_limited" }), ["rate_limited", "unavailable"]],
    [async () => ({ ok: true,  results: [] }),                          ["no_results"]],
    [async () => { throw new Error("boom"); },                          ["unavailable"]],
    [async () => null,                                                  ["unavailable"]],
  ];
  for (const [impl, expected] of modes) {
    const out = await withPlaces(impl, () => runPlacesTool({ query: "x" }, "en"));
    const j = JSON.parse(out);
    assert.ok(expected.includes(j.status), `סטטוס לא צפוי: ${j.status} (צפוי: ${expected})`);
    assert.equal(j.guest_facing, false, "הודעת כשל חייבת להיות מסומנת כפנימית");
    assert.match(j.instruction, /INTERNAL/, "ההודעה חייבת להיפתח כהוראה פנימית");
    assert.match(j.instruction, /NEVER tell the guest/i, "חייב איסור מפורש להזכיר את הכשל");
    assert.match(j.instruction, /\[RECEPTION:/, "חייב לנתב לאדם כשאין מענה");
    // 🔴 הלב: אין כאן משפט שאפשר להעתיק לאורח כמו שהוא.
    assert.doesNotMatch(j.instruction, /^The (live )?(search|tool)/,
      "הודעת הכשל נקראת כמשפט לאורח — בדיוק מה שדלף");
  }
});

test("כשל: אין מיקום למלון → כשל פנימי, לא הודעה לאורח", async () => {
  const { updateConfigFor } = await import("./config.js");
  const { runInTenant }     = await import("./tenant.js");
  await updateConfigFor("nolocation-hotel", { name: "No Location Hotel", location: null });
  const out = await runInTenant("nolocation-hotel", () => runPlacesTool({ query: "x" }, "en"));
  const j = JSON.parse(out);
  assert.equal(j.status, "no_location");
  assert.equal(j.guest_facing, false);
});
