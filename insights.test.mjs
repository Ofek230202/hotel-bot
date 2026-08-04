// ════════════════════════════════════════════════════════
//  INSIGHTS — ארבעת הדוחות
//  ----------------------------------------------------------
//  ⭐ הדוח החשוב הוא "מה הבוט לא ידע": כל שורה בו היא שדה קונפיג חסר,
//     כלומר רשימת המשימות לשיפור המוצר. הבדיקות כאן מוודאות שהוא באמת
//     נאסף, שהוא מקבץ שאלות דומות, ושהוא **מבודד בין מלונות** — דוח
//     שמערבב מלונות אינו רק שגוי, הוא דליפת מידע עסקי בין לקוחות.
// ════════════════════════════════════════════════════════
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH = freshTestDbPath("insights");
process.env.TWILIO_ACCOUNT_SID     = "ACtest";
process.env.TWILIO_AUTH_TOKEN      = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.ANTHROPIC_API_KEY      = "sk-test";
process.env.BASE_URL               = "http://test.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);

mock.module("twilio", {
  exports: { default: () => ({ messages: { create: async () => ({ sid: "SM" }) } }) },
});
const { email } = await import("./email/index.js");
email.send = async () => ({ success: true });

const ins    = await import("./insights.js");
const state  = await import("./state.js");
const tenant = await import("./tenant.js");

const HID = tenant.DEFAULT_HOTEL_ID;

// ════════════════════════════════════════════════════════
//  נרמול — מה שהופך 300 שאלות ל-5 נושאים
// ════════════════════════════════════════════════════════
test("שאלות שונות באותו נושא מתקבצות יחד", () => {
  const a = ins.normalizeQuestion("יש לכם מיטת תינוק?");
  const b = ins.normalizeQuestion("אפשר מיטת תינוק בבקשה");
  const c = ins.normalizeQuestion("מיטת תינוק");
  assert.equal(a, b, "🔴 ניסוחים שונים לאותה שאלה לא התקבצו — הדוח יהיה רשימה ולא תובנה");
  assert.equal(b, c);
});

test("שאלות בנושאים שונים אינן מתקבצות", () => {
  assert.notEqual(ins.normalizeQuestion("יש מיטת תינוק?"), ins.normalizeQuestion("יש חניה?"));
});

test("סדר המילים אינו משנה, אבל הנושא כן", () => {
  assert.equal(ins.normalizeQuestion("חניה יש במלון"), ins.normalizeQuestion("במלון יש חניה"));
});

test("שאלה ריקה או קצרה מדי אינה נרשמת", () => {
  assert.equal(ins.recordKnowledgeGap({ hotelId: HID, question: "" }), null);
  assert.equal(ins.recordKnowledgeGap({ hotelId: HID, question: "?" }), null);
});

// ════════════════════════════════════════════════════════
//  ⭐ הדוח: מה הבוט לא ידע
// ════════════════════════════════════════════════════════
test("⭐ פערי ידע נאספים ומדורגים לפי תדירות", async () => {
  for (const q of ["יש מיטת תינוק?", "אפשר מיטת תינוק", "מיטת תינוק בבקשה", "יש חניה לנכים?"]) {
    ins.recordKnowledgeGap({ hotelId: HID, question: q, lang: "he", phone: "whatsapp:+972561110001" });
  }
  const gaps = await ins.knowledgeGaps({ hotelId: HID, days: 30 });
  assert.ok(gaps.length >= 2, "נאספו נושאים");
  assert.equal(gaps[0].count, 3, "🔴 הנושא השכיח אינו ראשון — הדוח אינו מדרג לפי מה שדחוף לתקן");
  assert.ok(gaps[0].example.includes("תינוק"), "יש דוגמה אמיתית לשאלה, לא רק נושא מנורמל");
});

test("🔴 בידוד: הדוח של מלון אחד אינו כולל שאלות של מלון אחר", async () => {
  ins.recordKnowledgeGap({ hotelId: "ins_hotel_b", question: "יש מגרש טניס?", lang: "he" });
  const a = await ins.knowledgeGaps({ hotelId: HID, days: 30 });
  const b = await ins.knowledgeGaps({ hotelId: "ins_hotel_b", days: 30 });

  assert.ok(!a.some(g => g.example.includes("טניס")),
    "🔴 שאלה של מלון אחר דלפה לדוח — זו דליפת מידע עסקי בין לקוחות");
  assert.ok(b.some(g => g.example.includes("טניס")));
});

test("נושא שסומן כטופל יורד מהדוח", async () => {
  ins.recordKnowledgeGap({ hotelId: "ins_resolve", question: "יש שירות כביסה?", lang: "he" });
  const before = await ins.knowledgeGaps({ hotelId: "ins_resolve", days: 30 });
  assert.equal(before.length, 1);

  await ins.resolveGap(before[0].topic, "ins_resolve");
  const after = await ins.knowledgeGaps({ hotelId: "ins_resolve", days: 30 });
  assert.equal(after.length, 0, "🔴 נושא שכבר תוקן ממשיך להופיע — הדוח מאבד ערך");
});

// ════════════════════════════════════════════════════════
//  מדד הבריאות
// ════════════════════════════════════════════════════════
test("מדד ההעברות לאדם מחושב כאחוז, לא כמספר גולמי", async () => {
  for (let i = 0; i < 5; i++) state.patchSession(`whatsapp:+97256222000${i}`, { lang: "he" }, "ins_health");
  ins.recordKnowledgeGap({ hotelId: "ins_health", question: "שאלה שלא ידענו", phone: "whatsapp:+972562220001" });

  const h = await ins.handoffRate({ hotelId: "ins_health", days: 30 });
  assert.ok(h.conversations >= 5);
  assert.equal(h.neededHuman, 1);
  assert.ok(h.handoffPct > 0 && h.handoffPct <= 100,
    `🔴 אחוז לא הגיוני: ${h.handoffPct} — זה המספר שמוכיח ערך ללקוח`);
});

test("אפס שיחות אינו מחזיר חלוקה באפס", async () => {
  const h = await ins.handoffRate({ hotelId: "ins_empty_hotel", days: 30 });
  assert.equal(h.handoffPct, 0);
  assert.ok(Number.isFinite(h.handoffPct), "🔴 NaN בדוח");
});

// ════════════════════════════════════════════════════════
//  בקשות שלא טופלו
// ════════════════════════════════════════════════════════
test("אירוע חירום שלא אושר מופיע כדורש טיפול", async () => {
  const inc = state.logIncident({
    hotelId: "ins_open", phone: "whatsapp:+972563330001", roomNumber: "77",
    guestName: "אורח", kind: "injury", description: "[injury] נפילה",
  });
  void inc;
  const o = await ins.openIssues({ hotelId: "ins_open", days: 7 });
  assert.ok(o.unacknowledged >= 1, "🔴 אירוע פתוח לא מופיע — זה הדבר היחיד שמצדיק טלפון עכשיו");
  assert.ok(o.needsAttention.length >= 1);
  assert.equal(o.needsAttention[0].room, "77");
});

test("אירוע שאושר אינו נספר כלא-מטופל", async () => {
  const esc = await import("./escalation.js");
  const inc = state.logIncident({
    hotelId: "ins_ack", phone: "whatsapp:+972563330002", roomNumber: "88",
    kind: "medical", description: "[medical] כאבים",
  });
  await esc.acknowledgeIncident(inc.id, { actor: "ביטחון" });

  const o = await ins.openIssues({ hotelId: "ins_ack", days: 7 });
  assert.equal(o.unacknowledged, 0, "🔴 אירוע מאושר נספר כלא-מטופל — הדוח יצעק לשווא");
});

// ════════════════════════════════════════════════════════
//  ערך: שביעות רצון + הכנסה
// ════════════════════════════════════════════════════════
test("דוח הערך מפריד בין הכנסה כוללת לבין מה שהבוט מכר", async () => {
  const checkin = await import("./checkin.js");
  const phone = "whatsapp:+972564440001";
  const { reservationId } = await tenant.runInTenant(HID, () => checkin.startCheckin(
    phone, { guestName: "בודק", guestNameHe: "בודק", guestNameEn: "Tester" },
    "RES-INS-1", { stay: { checkIn: "2026-01-01", checkOut: "2026-01-03", nights: 2 } },
  ));
  await tenant.runInTenant(HID, () => checkin.completeCheckin(reservationId, "301"));
  tenant.runInTenant(HID, () => checkin.addFolioItem(reservationId, "SPA", "עיסוי", 45000));

  const v = await ins.satisfactionAndRevenue({ hotelId: HID, days: 3650 });
  assert.ok(v.stays >= 1);
  assert.ok(v.upsellIls >= 450,
    `🔴 מכירה נוספת לא נספרה (${v.upsellIls}) — זה הטיעון שמצדיק את המערכת`);
  assert.ok(Number.isFinite(v.revenueIls));
});

test("סיכום מחזיר את כל ארבעת הדוחות בקריאה אחת", async () => {
  const s = await ins.insightsSummary({ hotelId: HID, days: 30 });
  for (const k of ["gaps", "health", "issues", "value"]) {
    assert.ok(s[k] !== undefined, `🔴 חסר דוח: ${k}`);
  }
  assert.equal(s.hotelId, HID);
});
