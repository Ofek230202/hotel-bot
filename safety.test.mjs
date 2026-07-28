// ════════════════════════════════════════════════════════
//  SAFETY — בדיקות רגרסיה לתיקוני הבטיחות והניתוב
//  ----------------------------------------------------------
//  כל בדיקה כאן משחזרת תקלה שנמצאה בסריקה מול "איך מלון 5 כוכבים
//  אמיתי עובד", ושתוקנה:
//   1. זיהוי חירום הפעיל פינוי שריפה על "Can I smoke on the balcony?"
//   2. התראה לצוות בלי טלפון ובלי מיקום — לא ניתנת לביצוע
//   3. חירום בלי מספר חדר — "הם בדרך אליכם" בלי לדעת לאן
//   4. תג מחלקה בלי פרטים ("[HK]") — נעלם בשקט
//
//  הרצה: npm test
// ════════════════════════════════════════════════════════
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

// נתיב DB ייחודי ומתנקה — מונע טעינת מצב מהרצה קודמת (pid ממוחזר).
process.env.DB_PATH                = freshTestDbPath("safety");
process.env.TWILIO_ACCOUNT_SID     = "ACtest";
process.env.TWILIO_AUTH_TOKEN      = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.ANTHROPIC_API_KEY      = "sk-test";
process.env.BASE_URL               = "http://test.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);

const sent = [];
mock.module("twilio", {
  exports: {
    default: () => ({
      messages: {
        create: async ({ to, body }) => {
          if (!body) throw new Error("Twilio: body is required");
          sent.push({ to, body });
          return { sid: "SMtest" };
        },
      },
    }),
  },
});

let aiReply = "שלום!";
mock.module("@anthropic-ai/sdk", {
  exports: {
    default: class Anthropic {
      messages = { create: async () => ({ content: [{ type: "text", text: aiReply }] }) };
    },
  },
});

mock.module("./places/index.js", {
  exports: {
    places: { searchNearby: async () => ({ ok: true, provider: "mock", results: [] }) },
    placesLive: false,
    PLACE_CATEGORIES: Object.freeze({ restaurant: "restaurant" }),
  },
});

let bot, detectEmergency;
before(async () => {
  bot = await import("./bot.js");
  ({ detectEmergency } = await import("./emergency.js"));
});

let phoneSeq = 0;
const freshGuest = () => `whatsapp:+9725100000${String(++phoneSeq).padStart(2, "0")}`;
beforeEach(() => { sent.length = 0; aiReply = "שלום!"; });

// ההודעות שהלכו לצוות (כל מה שאינו האורח עצמו).
const staffMsgs = (guest) => sent.filter(m => m.to !== guest).map(m => m.body);
const guestMsgs = (guest) => sent.filter(m => m.to === guest).map(m => m.body);

// ════════════════════════════════════════════════════════
//  1 — זיהוי חירום: דיווח אמיתי מול שאלה תמימה
// ════════════════════════════════════════════════════════
// נצפה בבדיקה: "Can I smoke on the balcony?" שלח לאורח הנחיית פינוי
// שריפה והזעיק ביטחון + קבלה. זאב שקורא לשווא = צוות שמתעלם מהאמיתי.
const REAL_EMERGENCIES = [
  ["נפצעתי בחדר",                    "medical"],
  ["נפלתי במקלחת, כואב לי מאוד הגב", "medical"],  // נפילה בגוף ראשון — היה FN (נתפס בסימולציה חיה)
  ["החלקתי ונפלתי",                  "medical"],
  ["התעלפתי",                        "medical"],  // סיומת גוף ראשון — היה FN
  ["חדר 512, אישה התמוטטה",           "medical"],  // היה FN
  ["אשתי לא מגיבה",                   "medical"],
  ["my husband is unconscious",       "medical"],
  ["I am bleeding badly",             "medical"],
  ["תגובה אלרגית קשה",                "medical"],
  ["יש שריפה בחדר",                   "fire"],
  ["יש אש במסדרון",                   "fire"],
  ["ריח גז חזק בחדר",                 "fire"],
  ["there is smoke coming from the kitchen", "fire"],
  ["Is there a fire in the lobby?!",  "fire"],     // שאלה — ובכל זאת חירום אמיתי
  ["נשדדתי במעלית",                   "security"], // סיומת גוף ראשון — היה FN
  ["נדקרתי",                          "security"],
  ["someone broke into my room",      "security"], // היה FN
  ["there is a man with a gun",       "security"],
];

const INNOCENT_QUESTIONS = [
  "Can I smoke on the balcony?",
  "Do you have a smoking area?",
  "I need a smoking room",
  "where can I smoke?",
  "Is the beach dangerous at night?",
  "is it dangerous to walk there",
  "where is the nearest police station",
  "what is the emergency number?",
  "emergency exit where?",
  "איפה יציאת החירום?",
  "מה מספר המשטרה?",
  "כמה עולה מונית למשטרה?",
  "אפשר לעשן במרפסת?",
  "יש חדר מעשנים?",
  "האם יש אש במטבח הפתוח?",
  "יש לי אלרגיה לבוטנים",
  "אני צמחוני יש לי אלרגיה לגלוטן",
  "I have a peanut allergy",
  "המזגן לא עובד",
  "נשפך קפה על השטיח",
];

test("חירום: כל דיווח אמיתי מזוהה — כולל סיומות עברית וחירום בתוך שאלה", () => {
  for (const [text, kind] of REAL_EMERGENCIES) {
    const r = detectEmergency(text);
    assert.ok(r, `חירום אמיתי לא זוהה: "${text}"`);
    assert.equal(r.kind, kind, `סוג שגוי ל-"${text}": ${r.kind}`);
  }
});

// ── אזעקת טילים (Part 4) + צרחות (Part 5) ──────────────
test("Part 4/5: אזעקת טילים=rocket, צרחות=security, guard על 'אזעקת אש'", () => {
  const rocket = ["יש אזעקה!", "צבע אדום", "נופלים טילים", "rocket attack", "red alert", "azaka", "יש אזעקת טילים"];
  for (const t of rocket) assert.equal(detectEmergency(t)?.kind, "rocket", `לא זוהתה אזעקה: "${t}"`);
  // "אזעקת אש" חייבת להיות אש/פינוי, לא מרחב מוגן.
  assert.equal(detectEmergency("יש אזעקת אש בקומה")?.kind, "fire", "אזעקת אש → אש, לא טיל");
  // צרחות → ביטחון (לא לעמת, הביטחון בודק).
  for (const t of ["אני שומע צרחות מהחדר ליד", "מישהו צורח במסדרון", "I hear screaming next door"]) {
    assert.equal(detectEmergency(t)?.kind, "security", `צרחות לא נותבו לביטחון: "${t}"`);
  }
});

test("חירום: שאלה תמימה לעולם לא מפעילה פינוי/הזעקה", () => {
  for (const text of INNOCENT_QUESTIONS) {
    const r = detectEmergency(text);
    assert.equal(r, null, `התראת שווא על "${text}" → ${r?.kind}`);
  }
});

test("חירום: 'אפשר לעשן במרפסת?' מקבל תשובת קונסיירז' רגילה — לא הנחיית פינוי", async () => {
  const p = freshGuest();
  aiReply = "העישון מותר במרפסת החדר בלבד 🙏";
  await bot.handleIncoming(p, "אפשר לעשן במרפסת?");
  const out = guestMsgs(p).join("\n");
  assert.doesNotMatch(out, /102|כבאות|צאו מהחדר/, `נשלחה הנחיית חירום על שאלה תמימה: ${out}`);
  assert.equal(staffMsgs(p).length, 0, "הוזעק צוות על שאלה תמימה");
});

// ════════════════════════════════════════════════════════
//  2 — כל התראה לצוות חייבת להיות ניתנת לפעולה
// ════════════════════════════════════════════════════════
test("ניתוב: התראה לצוות כוללת תמיד את טלפון האורח", async () => {
  const p = freshGuest();
  aiReply = "אני מטפל בזה [MAINTENANCE:המזגן לא מקרר]";
  await bot.handleIncoming(p, "המזגן לא מקרר");
  // אחזקה היא מחלקת "בתוך החדר" — קודם נשאל מספר החדר, ואז הבקשה משוחררת.
  await bot.handleIncoming(p, "402");
  const staff = staffMsgs(p).join("\n");
  assert.ok(staff.length, "לא נשלחה התראה לצוות");
  assert.match(staff, /📱/, `אין שורת טלפון בהתראה: ${staff}`);
  assert.match(staff, new RegExp(p.replace("whatsapp:", "").replace("+", "\\+")),
    `הטלפון של האורח לא מופיע בהתראה: ${staff}`);
});

test("ניתוב: חדר לא ידוע מוצג כהוראת פעולה, לא כמקף שקט", async () => {
  const p = freshGuest();
  aiReply = "בשמחה [CONCIERGE:taxi|מונית לשדה התעופה מחר ב-06:00]";
  await bot.handleIncoming(p, "אפשר מונית לשדה התעופה מחר ב-6?");
  const staff = staffMsgs(p).join("\n");
  assert.match(staff, /חדר: \*לא ידוע\*/, `החדר החסר לא סומן במפורש: ${staff}`);
  assert.match(staff, /ליצור קשר עם האורח/, "אין הוראה ליצור קשר עם האורח");
});

// ════════════════════════════════════════════════════════
//  3 — חירום בלי מספר חדר: לבקש מיקום ולהעביר אותו
// ════════════════════════════════════════════════════════
test("חירום בלי חדר: האורח מתבקש לציין מיקום, והביטחון מקבל 'מיקום לא ידוע'", async () => {
  const p = freshGuest();
  await bot.handleIncoming(p, "אשתי נפלה ולא מגיבה");

  const toGuest = guestMsgs(p).join("\n");
  assert.match(toGuest, /101/, "לא נמסר מספר מד\"א");
  assert.match(toGuest, /איפה אתם נמצאים/, `לא נשאלה שאלת מיקום: ${toGuest}`);

  const staff = staffMsgs(p).join("\n");
  assert.match(staff, /מיקום לא ידוע/, `הביטחון לא יודע שאין מיקום: ${staff}`);
  assert.match(staff, /התקשרו אליו \*עכשיו\*/, "אין הוראה להתקשר לאורח");
});

test("חירום: תשובת המיקום של האורח מגיעה לביטחון מיד — לא ל-AI", async () => {
  const p = freshGuest();
  await bot.handleIncoming(p, "אשתי נפלה ולא מגיבה");
  // הגנה: הסשן חייב להיות טרי — חירום בלי חדר מבקש מיקום. אם מצב ישן
  // דלף (חדר מהרצה קודמת), הבקשה לא הייתה נשלחת. תופס רגרסיית בידוד-DB.
  assert.match(guestMsgs(p).join("\n"), /איפה אתם נמצאים/,
    "הסשן לא היה טרי — לא נשאלה שאלת מיקום (בדוק בידוד DB בין הרצות)");
  sent.length = 0;

  aiReply = "לא אמור להיקרא";
  await bot.handleIncoming(p, "חדר 812");

  const staff = staffMsgs(p).join("\n");
  assert.match(staff, /עדכון מיקום/, `המיקום לא הועבר לביטחון: ${staff}`);
  assert.match(staff, /812/, "מספר החדר לא הגיע לביטחון");
  assert.match(guestMsgs(p).join("\n"), /העברתי את המיקום/, "האורח לא קיבל אישור");
});

test("חירום: חירום שני אחרי בקשת מיקום עדיין מטופל כחירום", async () => {
  const p = freshGuest();
  await bot.handleIncoming(p, "אשתי נפלה ולא מגיבה");
  sent.length = 0;
  await bot.handleIncoming(p, "עכשיו יש גם שריפה במסדרון!");
  assert.match(guestMsgs(p).join("\n"), /102/, "החירום השני לא זוהה");
});

test("Part 4: אזעקה → הנחיית מרחב מוגן (לא '101'), בלי בקשת מיקום, צוות מיודע", async () => {
  const p = freshGuest();
  await bot.handleIncoming(p, "יש אזעקה!!");
  const guest = guestMsgs(p).join("\n");
  assert.match(guest, /מרחב מוגן/, "לא ניתנה הנחיית מרחב מוגן");
  assert.match(guest, /10 דקות/, "לא צוין להישאר 10 דקות");
  assert.match(guest, /מעלית/, "לא הוזהר מפני מעלית");
  assert.ok(!/איפה אתם נמצאים/.test(guest), "אין לבקש מיקום באזעקה — צריך להיכנס למרחב מוגן");
  // הצוות מקבל התראה על אזעקה (אינפורמטיבית, לא 'התקשרו אליו עכשיו').
  assert.match(staffMsgs(p).join("\n"), /אזעקת טילים/, "הצוות לא קיבל התראת אזעקה");
});

test("Part 4: אזעקה — ההודעה הבאה מטופלת כרגיל (לא נלכדת כ'מיקום')", async () => {
  const p = freshGuest();
  await bot.handleIncoming(p, "צבע אדום");
  sent.length = 0;
  aiReply = "בשמחה, אני כאן 🌟";
  await bot.handleIncoming(p, "אני בטוח עכשיו, תודה");
  // אין הסלמה 'עדכון מיקום' — האזעקה לא סימנה emergencyAwaitLocation.
  assert.ok(!/עדכון מיקום/.test(staffMsgs(p).join("\n")), "אזעקה לא אמורה ללכוד את ההודעה הבאה כמיקום");
});

// ════════════════════════════════════════════════════════
//  4 — תג מחלקה בלי פרטים לא נעלם בשקט
// ════════════════════════════════════════════════════════
test("ניתוב: '[HK]' בלי פרטים מנותב לאדם ולא נעלם בשקט", async () => {
  const p = freshGuest();
  aiReply = "מטפלים בזה [HK]";
  await bot.handleIncoming(p, "אפשר מגבות נוספות לחדר 305?");
  // אין מספר חדר בסשן → נשאלת שאלת חדר; התשובה משחררת את הבקשה.
  await bot.handleIncoming(p, "305");

  const staff = staffMsgs(p).join("\n");
  assert.ok(staff.length, "בקשה בלי פרטים נעלמה — אף אחד לא קיבל אותה");
  assert.match(staff, /ללא פרטים/, `הבקשה לא סומנה כחסרת פרטים: ${staff}`);
  assert.match(staff, /HOUSEKEEPING/, "לא נותבה למשק בית");
});

test("ניתוב: תג בלי פרטים לעולם לא דולף לאורח", async () => {
  const p = freshGuest();
  aiReply = "מיד מטפלים [HK]";
  await bot.handleIncoming(p, "אפשר מגבות?");
  for (const b of guestMsgs(p)) {
    assert.doesNotMatch(b, /\[HK/, `תג דלף לאורח: ${b}`);
  }
});
