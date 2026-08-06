// ════════════════════════════════════════════════════════
//  חירום רפואי — שתי הדרגות, ומה שביניהן
//  ----------------------------------------------------------
//  🔴 ארבעה פערים אמיתיים שנמצאו בבדיקה (05.08.2026), כולם בניסוחים
//     שאורח באמת כותב:
//
//   1. "יש לי *כאב חזק* בחזה" — לא זוהה. הרשימה דרשה "כאב בחזה" צמוד,
//      ותואר באמצע ניתק את ההתאמה. כאב בחזה הוא מהתסמינים הקריטיים
//      ביותר שקיימים.
//   2. "אני לא מצליח לנשום" — לא זוהה ("לא נושם" בלבד היה ברשימה).
//   3. "my wife fainted" — **"fainted" פשוט לא היה ברשימה**, אף שהוא
//      הניסוח האנגלי הנפוץ ביותר לעילפון.
//   4. "אשתי לא מרגישה טוב" — לא הפעיל **כלום**. זה כנראה הניסוח
//      הנפוץ ביותר שבו אורח מדווח שמישהו חולה, והמלון שתק לחלוטין.
//
//  (4) קיבל דרגה משלו ולא עוד מילה ברשימת החירום, כי "לא מרגיש טוב"
//  נע מכאב בטן ועד התקף לב מתחיל: "התקשרו 101!" על כאב ראש הוא אזעקת
//  שווא ששוחקת את אמון הצוות בהתראות, והתעלמות היא נטישת אורח חולה.
// ════════════════════════════════════════════════════════
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH                = freshTestDbPath("medical");
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
mock.module("@anthropic-ai/sdk", {
  defaultExport: class {
    messages = { create: async () => ({ content: [{ type: "text", text: "בוודאי." }], stop_reason: "end_turn" }) };
  },
});

const { detectEmergency, detectMedicalConcern, medicalConcernMessage } = await import("./emergency.js");
const { handleIncoming } = await import("./bot.js");
const { registerHotelNumber } = await import("./tenant.js");

const HOTEL_NUM = "whatsapp:+10000000000";
registerHotelNumber(HOTEL_NUM, "kempinski");

let seq = 0;
const nextPhone = () => `whatsapp:+9725888${String(++seq).padStart(4, "0")}`;
beforeEach(() => { sent.length = 0; });
const guestText = (p) => sent.filter(s => s.to === p).map(s => s.body).join("\n");
const staffText = (p) => sent.filter(s => s.to !== p).map(s => s.body).join("\n");

// ── דרגה 1: חירום מלא ──────────────────────────────────
test("חירום: התסמינים הקריטיים מזוהים גם עם תואר באמצע", () => {
  for (const t of [
    "יש לי כאב חזק בחזה",          // 🔴 הבאג: תואר ניתק את ההתאמה
    "יש לי כאבים חזקים מאוד בחזה",
    "כאב בחזה",
    "אני לא מצליח לנשום",           // 🔴 הבאג
    "קשה לי לנשום",
    "מתקשה לנשום",
  ]) {
    assert.equal(detectEmergency(t)?.kind, "medical", `לא זוהה כחירום: "${t}"`);
  }
});

test("חירום: עילפון באנגלית — 'fainted' היה חסר לגמרי", () => {
  for (const t of [
    "my wife fainted",              // 🔴 הבאג
    "she fainted in the lobby",
    "my husband is feeling faint",
    "he has difficulty breathing",
    "she is short of breath",
  ]) {
    assert.equal(detectEmergency(t)?.kind, "medical", `לא זוהה כחירום: "${t}"`);
  }
});

test("חירום: מצוקה של אדם *אחר* — לא רק גוף ראשון", () => {
  for (const t of [
    "אשתי התעלפה", "בעלי התמוטט", "הילד שלי לא מגיב",
    "אמא שלי נפלה ולא קמה", "התינוק שלי נחנק",
    "my husband collapsed", "someone is unconscious in the lobby",
    "my friend needs an ambulance",
  ]) {
    assert.equal(detectEmergency(t)?.kind, "medical", `מצוקה של אדם אחר לא זוהתה: "${t}"`);
  }
});

// ── דרגה 2: "לא מרגיש טוב" ─────────────────────────────
test("🔴 'אשתי לא מרגישה טוב' — הפער המרכזי — מזוהה כמצוקה רפואית", () => {
  for (const t of [
    "אשתי לא מרגישה טוב",
    "הבן שלי לא מרגיש טוב בכלל",
    "אני מרגיש רע",
    "יש לילד חום גבוה",
    "יש לי כאב בטן חזק",
    "אני קצת מסוחרר",
  ]) {
    assert.equal(detectMedicalConcern(t)?.kind, "unwell", `לא זוהה כמצוקה: "${t}"`);
  }
});

test("🔴 'doesn't feel well' באנגלית — אותו פער", () => {
  for (const t of [
    "my son doesn't feel well",
    "my wife is not feeling well",
    "she feels sick",
    "he has a high fever",
    "she's been vomiting all night",
    "my daughter is very dizzy",
  ]) {
    assert.equal(detectMedicalConcern(t)?.kind, "unwell", `לא זוהה כמצוקה: "${t}"`);
  }
});

test("חירום אמיתי גובר על 'לא מרגיש טוב' — לא מדרדרים חומרה", () => {
  for (const t of ["אשתי התעלפה", "יש לי כאב חזק בחזה", "my wife fainted", "אני לא מצליח לנשום"]) {
    assert.ok(detectEmergency(t), `"${t}" חייב להיות חירום מלא`);
    assert.equal(detectMedicalConcern(t), null, `"${t}" סווג כמצוקה קלה במקום חירום`);
  }
});

test("אזעקת שווא: שאלה כללית ובקשה רגילה אינן מצוקה רפואית", () => {
  for (const t of [
    "מה עושים אם מרגישים לא טוב?",
    "המזגן לא עובד", "אני רוצה מגבות", "המיטה לא נוחה",
    "יש לי אלרגיה לבוטנים",
    "the room is not clean",
  ]) {
    assert.equal(detectMedicalConcern(t), null, `אזעקת שווא: "${t}"`);
  }
});

// ── מה שהאורח והצוות באמת מקבלים ───────────────────────
test("מצוקה: האורח מקבל את התסמינים שמחייבים 101 — בלי ייעוץ רפואי", async () => {
  const phone = nextPhone();
  await handleIncoming(phone, "אשתי לא מרגישה טוב", null, { to: HOTEL_NUM });
  const reply = guestText(phone);

  assert.ok(reply.trim(), "אורח שדיווח על מחלה חייב לקבל מענה");
  assert.match(reply, /101/, "חייב למסור את מספר מד\"א");
  assert.match(reply, /חזה|נשימה|הכרה/, "חייב לפרט את התסמינים שמחייבים חיוג מיידי");
  assert.match(reply, /הצוות|המנהל/, "חייב לומר שאדם יוצר קשר");

  // 🔴 אסור ייעוץ רפואי בשום צורה.
  assert.doesNotMatch(reply, /קח |תיקח|לקחת (?:כדור|תרופ)|אקמול|נורופן|אדוויל|ibuprofen|paracetamol/i,
    "🔴 הבוט נתן ייעוץ רפואי");
  assert.doesNotMatch(reply, /כנראה|נשמע כמו|זה בטח|probably|sounds like/i,
    "🔴 הבוט אבחן במקום להפנות");
});

test("מצוקה: הצוות מקבל התראה מיידית עם הנחיה לא לייעץ", async () => {
  const phone = nextPhone();
  await handleIncoming(phone, "my son doesn't feel well", null, { to: HOTEL_NUM });
  const staff = staffText(phone);
  assert.ok(staff.trim(), "🔴 הצוות לא קיבל התראה — אורח חולה ואיש לא יודע");
  assert.match(staff, /ליצור קשר|להתקשר/, "ההתראה חייבת לומר לצוות ליצור קשר");
  assert.match(staff, /101/, "ההתראה חייבת להזכיר את מד\"א");
  assert.match(staff, /אין לתת ייעוץ רפואי/, "הצוות חייב לדעת שלא לייעץ");
});

test("מצוקה באנגלית: המענה בשפת האורח", async () => {
  const phone = nextPhone();
  await handleIncoming(phone, "hello", null, { to: HOTEL_NUM });
  sent.length = 0;
  await handleIncoming(phone, "my wife is not feeling well", null, { to: HOTEL_NUM });
  const reply = guestText(phone);
  assert.match(reply, /101/);
  assert.match(reply, /chest|breathing|consciousness/i, "התסמינים חייבים להיות באנגלית");
  assert.doesNotMatch(reply, /[֐-׿]/, "אורח אנגלי קיבל עברית");
});

test("ניסוח: הודעת המצוקה עומדת בתקן הניסוח", async () => {
  const { auditText } = await import("./voice.js");
  for (const lang of ["he", "en"]) {
    const msg = medicalConcernMessage(lang, { onSiteTeam: true });
    const v = auditText(msg).filter(x => x.severity === "error");
    assert.equal(v.length, 0, `${lang}: ${v.map(x => `${x.rule} — ${x.why}`).join("; ")}`);
  }
});

test("בוטיק: לא מבטיחים 'הצוות בדרך' במלון בלי צוות במקום", () => {
  const boutique = medicalConcernMessage("he", { onSiteTeam: false });
  assert.match(boutique, /מנהל התורן/, "בוטיק מסלים למנהל תורן");
  const full = medicalConcernMessage("he", { onSiteTeam: true });
  assert.match(full, /הצוות/);
});
