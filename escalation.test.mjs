// ════════════════════════════════════════════════════════
//  ESCALATION — אף אירוע חירום לא נשאר בלי אדם שאישר קבלה
//  ----------------------------------------------------------
//  זה הפער המסוכן ביותר שהיה בפרויקט: ההסלמה נשלחה, ואיש לא אישר קבלה.
//  טלפון ביטחון כבוי או משמרת שהתחלפה = אורח פצוע שאף אחד אינו בדרך
//  אליו, בזמן שהמערכת מדווחת "טופל". הבדיקות כאן מוודאות שהמעגל נסגר.
// ════════════════════════════════════════════════════════
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH = freshTestDbPath("escalation");
process.env.TWILIO_ACCOUNT_SID     = "ACtest";
process.env.TWILIO_AUTH_TOKEN      = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.ANTHROPIC_API_KEY      = "sk-test";
process.env.BASE_URL               = "http://test.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);
process.env.EMERGENCY_ACK_TIMEOUT_MS = "60000";   // דקה, כדי לשלוט בזמן בבדיקה

mock.module("twilio", {
  exports: { default: () => ({ messages: { create: async () => ({ sid: "SMtest" }) } }) },
});
const { email } = await import("./email/index.js");
email.send = async () => ({ success: true });

const state = await import("./state.js");
const esc   = await import("./escalation.js");
const config = await import("./config.js");
const tenant = await import("./tenant.js");

const HID = tenant.DEFAULT_HOTEL_ID;

// לוכדים את ההתראות במקום לשלוח אותן.
const sent = [];
esc.setNotifier(async (a) => { sent.push(a); });

// חדר ייחודי לכל אירוע. הסורק (בצדק) מטפל ב**כל** האירוע הפתוחים, כולל
// כאלה שנשארו מבדיקות קודמות — ולכן מונה גלובלי אינו מבחין בין "האירוע
// שלי הוסלם" ל"משהו אחר הוסלם". מסננים לפי החדר.
let roomSeq = 500;
function newIncident(extra = {}) {
  sent.length = 0;
  const room = String(++roomSeq);
  const inc = state.logIncident({
    hotelId: HID, phone: "whatsapp:+972501112233", roomNumber: room,
    guestName: "דנה כהן", kind: "injury",
    description: "[injury] נפלתי במקלחת ואני לא מצליחה לקום",
    ...extra,
  });
  esc.armIncident(inc.id);
  return state.getIncident(inc.id);
}

const forRoom = room => sent.filter(m => m.roomNumber === room);

const future = ms => new Date(Date.now() + ms);

// ════════════════════════════════════════════════════════
//  מועד היעד לאישור
// ════════════════════════════════════════════════════════
test("אירוע חדש מקבל מועד יעד לאישור — אחרת הוא נשכח", () => {
  const inc = newIncident();
  assert.ok(inc.ackDeadline, "🔴 אין מועד יעד — האירוע לעולם לא יוסלם ואיש לא יידע");
  assert.equal(inc.escalationLevel, 0);
  assert.equal(inc.ackAt, null);
  assert.ok(new Date(inc.ackDeadline) > new Date(), "המועד בעתיד");
});

test("לפני שעבר הזמן — אין הסלמה", async () => {
  const inc = newIncident();
  await esc.sweepUnacknowledged(new Date());
  assert.equal(forRoom(inc.roomNumber).length, 0,
    "🔴 הוסלם מוקדם — הצוות יקבל אזעקה מיותרת ויפסיק להאמין להתראות");
  assert.equal(state.getIncident(inc.id).escalationLevel, 0);
});

// ════════════════════════════════════════════════════════
//  סולם ההסלמה
// ════════════════════════════════════════════════════════
test("עבר הזמן בלי אישור → הסלמה לדרג 1 (מנהל תורן)", async () => {
  const inc = newIncident();
  await esc.sweepUnacknowledged(future(esc.ACK_TIMEOUT_MS + 1000));

  const mine = forRoom(inc.roomNumber);
  assert.ok(mine.length >= 1, "🔴 האירוע לא הוסלם — זה בדיוק המצב שבו איש אינו בדרך");
  assert.ok(mine.every(m => m.priority === "high"));
  assert.match(mine[0].message, /ללא אישור קבלה/);
  assert.match(mine[0].message, /מנהל תורן/);
  assert.match(mine[0].message, new RegExp(inc.roomNumber),
    "מספר החדר חייב להופיע — בלעדיו אין לאן ללכת");

  const after = state.getIncident(inc.id);
  assert.equal(after.escalationLevel, 1);
  assert.ok(new Date(after.ackDeadline) > new Date(), "🔴 נקבע מועד יעד חדש לדרג הבא");
});

test("עדיין בלי אישור → דרג 2 מודיע לכל המחלקות שאיש לא אישר", async () => {
  const inc = newIncident();
  await esc.sweepUnacknowledged(future(esc.ACK_TIMEOUT_MS + 1000));
  sent.length = 0;
  await esc.sweepUnacknowledged(future(2 * esc.ACK_TIMEOUT_MS + 2000));

  const after = state.getIncident(inc.id);
  assert.equal(after.escalationLevel, 2);
  const mine = forRoom(inc.roomNumber);
  assert.equal(mine.length, config.DEPARTMENTS.length,
    `🔴 דרג אחרון חייב להגיע לכל ${config.DEPARTMENTS.length} המחלקות (נשלחו ${mine.length})`);
  assert.match(mine[0].message, /אף אחד לא אישר קבלה/);
});

test("סולם מוצה: מפסיקים להציף — אבל **לא** מסמנים כמטופל", async () => {
  const inc = newIncident();
  await esc.sweepUnacknowledged(future(1 * esc.ACK_TIMEOUT_MS + 1000));
  await esc.sweepUnacknowledged(future(2 * esc.ACK_TIMEOUT_MS + 1000));
  sent.length = 0;
  await esc.sweepUnacknowledged(future(3 * esc.ACK_TIMEOUT_MS + 1000));

  const after = state.getIncident(inc.id);
  assert.equal(after.escalationExhausted, true);
  assert.equal(after.ackDeadline, null, "אין יותר הסלמות");
  assert.equal(after.ackAt, null, "🔴 אירוע שאיש לא אישר לא ייחשב מאושר לעולם");
  assert.equal(after.status, "open", "🔴 והוא בוודאי לא נסגר מעצמו");
  assert.equal(forRoom(inc.roomNumber).length, 0, "מפסיקים להציף אחרי שהסולם מוצה");
});

// ════════════════════════════════════════════════════════
//  אישור קבלה
// ════════════════════════════════════════════════════════
test("אישור קבלה עוצר את הסולם", async () => {
  const inc = newIncident();
  const ack = await esc.acknowledgeIncident(inc.id, { actor: "יוסי (ביטחון)" });
  assert.equal(ack.ok, true);
  assert.equal(ack.incident.ackBy, "יוסי (ביטחון)");
  assert.ok(ack.incident.ackAt);
  assert.equal(ack.incident.ackDeadline, null);

  sent.length = 0;
  await esc.sweepUnacknowledged(future(5 * esc.ACK_TIMEOUT_MS));
  assert.equal(forRoom(inc.roomNumber).length, 0,
    "🔴 אירוע מאושר הוסלם שוב — הצוות יפסיק להאמין להתראות");
});

test("אישור כפול אינו כותב על הראשון (מי אישר באמת)", async () => {
  const inc = newIncident();
  await esc.acknowledgeIncident(inc.id, { actor: "ראשון" });
  const second = await esc.acknowledgeIncident(inc.id, { actor: "שני" });
  assert.equal(second.alreadyAcked, true);
  assert.equal(state.getIncident(inc.id).ackBy, "ראשון",
    "🔴 שרשרת האחריות נדרסה — לא ידוע מי באמת אישר");
});

test("אישור לאירוע שאינו קיים אינו יוצר אחד", async () => {
  const out = await esc.acknowledgeIncident("no-such-incident");
  assert.equal(out.notFound, true);
});

// ════════════════════════════════════════════════════════
//  סגירת אירוע
// ════════════════════════════════════════════════════════
test("סגירה דורשת תיאור מה נעשה — אחרת האירוע אינו סגור", async () => {
  const inc = newIncident();
  const bad = await esc.closeIncident(inc.id, { actor: "מנהל" });
  assert.equal(bad.needsResolution, true);
  assert.equal(state.getIncident(inc.id).status, "open");

  const ok = await esc.closeIncident(inc.id, {
    actor: "מנהל", resolution: "מד\"א פינו את האורחת לבית חולים; דוח נמסר לביטוח.",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.incident.status, "closed");
  assert.equal(ok.incident.closedBy, "מנהל");
  assert.match(ok.incident.resolution, /מד"א/);
});

test("סגירה בלי אישור קודם נחשבת גם כאישור — ולא מסלימה שוב", async () => {
  const inc = newIncident();
  await esc.closeIncident(inc.id, { actor: "מנהל תורן", resolution: "טופל במקום" });
  sent.length = 0;
  await esc.sweepUnacknowledged(future(5 * esc.ACK_TIMEOUT_MS));
  assert.equal(forRoom(inc.roomNumber).length, 0,
    "🔴 אירוע סגור הוסלם — אזעקת שווא על משהו שטופל");
  assert.equal(state.getIncident(inc.id).ackAt !== null, true);
});

// ════════════════════════════════════════════════════════
//  התמדה ובידוד — מה שהופך את זה לאמין
// ════════════════════════════════════════════════════════
test("🔴 מצב האירוע נשמר ל-DB, לא רק בזיכרון (שורד ריסטארט)", async () => {
  const inc = newIncident();
  await esc.acknowledgeIncident(inc.id, { actor: "בודק" });

  // מדמים ריסטארט: מרוקנים את ה-cache החי וקוראים מה-DB.
  state.incidents.length = 0;
  const fromDb = await state.getIncidentAsync(inc.id);
  assert.ok(fromDb, "🔴 האירוע לא נשמר ל-DB כלל");
  assert.equal(fromDb.ackBy, "בודק",
    "🔴 האישור חי רק בזיכרון — אחרי deploy האירוע היה מוסלם שוב על משהו שטופל");
  assert.equal(fromDb.ackDeadline, null);
});

test("אירוע פתוח שורד ריסטארט וממשיך להיות מוסלם", async () => {
  const inc = newIncident();
  state.incidents.length = 0;                      // "ריסטארט"
  sent.length = 0;
  await esc.sweepUnacknowledged(future(esc.ACK_TIMEOUT_MS + 1000));
  assert.ok(forRoom(inc.roomNumber).length >= 1,
    "🔴 אירוע פתוח נשכח אחרי ריסטארט — הכשל השקט שבגללו הסורק מגובה-DB");
});

test("בידוד: ההסלמה הולכת למלון של האירוע בלבד", async () => {
  config.updateConfigFor("esc_hotel_x", {
    name: "Hotel X", name_he: "מלון איקס",
    security_number: "+15550001111", security_email: "sec@x.test",
    duty_manager_number: "+15550002222",
  });
  const inc = state.logIncident({
    hotelId: "esc_hotel_x", phone: "whatsapp:+972509998877",
    roomNumber: "9", guestName: "אורח של איקס", kind: "medical",
    description: "[medical] כאבים בחזה",
  });
  esc.armIncident(inc.id);
  sent.length = 0;
  await esc.sweepUnacknowledged(future(esc.ACK_TIMEOUT_MS + 1000));

  assert.ok(sent.length >= 1);
  assert.ok(sent.every(m => m.hotelId === "esc_hotel_x"),
    "🔴 התראת חירום של מלון אחד הגיעה למלון אחר");
  assert.equal(sent[0].directNumber, "+15550002222",
    "🔴 ההסלמה לא הגיעה למנהל התורן של אותו מלון");
});
