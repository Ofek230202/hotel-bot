// ════════════════════════════════════════════════════════
//  SETTLEMENT — הגנת חיוב כפול, כשהסליקה רצה פעמיים במקביל
//  ----------------------------------------------------------
//  🔴 הבאג שזה סוגר: `settleFolio` מגן על כל פעולת תשלום בדגל
//     (`captured` / `overageCharged`), אבל הדגל נקבע רק **אחרי** ה-await
//     שמחזיר מספק הסליקה. שתי ריצות **במקביל** רואות שתיהן `false`,
//     שתיהן קוראות ל-capture — והאורח מחויב פעמיים.
//
//     זה לא תיאורטי: צ'ק אאוט בצ'אט רץ תחת נעילת האורח, אבל
//     `autoChargeOnNoShow` מופעל מ-cron **מחוץ** לנעילה הזו. אורח שכותב
//     "צ'ק אאוט" בדיוק כשה-cron מחייב אותו על no-show — זו ההצטלבות.
//
//  הבדיקות כאן מריצות את שני המסלולים **בו-זמנית** עם ספק תשלום שסופר
//  קריאות, ומוודאות שספק הסליקה נקרא **פעם אחת בדיוק**.
// ════════════════════════════════════════════════════════
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH = freshTestDbPath("settlement");
process.env.TWILIO_ACCOUNT_SID     = "ACtest";
process.env.TWILIO_AUTH_TOKEN      = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.ANTHROPIC_API_KEY      = "sk-test";
process.env.BASE_URL               = "http://test.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);

mock.module("twilio", {
  exports: { default: () => ({ messages: { create: async () => ({ sid: "SMtest" }) } }) },
});
const { email } = await import("./email/index.js");
email.send = async () => ({ success: true });

const checkin  = await import("./checkin.js");
const tenant   = await import("./tenant.js");
const payments = await import("./payments/index.js");

const HID = tenant.DEFAULT_HOTEL_ID;

// ── ספק תשלום שסופר קריאות ומדמה השהיית רשת ─────────────
// ההשהיה חיונית: בלעדיה שתי הקריאות לא באמת חופפות, והבדיקה הייתה
// עוברת גם על הקוד השבור.
const counts = { capture: 0, chargeSameCard: 0, cancel: 0 };
const slow = (ms = 25) => new Promise(r => setTimeout(r, ms));

function installCountingProvider() {
  counts.capture = counts.chargeSameCard = counts.cancel = 0;
  const p = payments.payments;                       // ה-MockProvider המשותף
  p.capture = async ({ amount }) => {
    counts.capture++; await slow();
    return { ok: true, success: true, capturedAmount: amount };
  };
  p.chargeSameCard = async ({ amount }) => {
    counts.chargeSameCard++; await slow();
    return { ok: true, success: true, chargedAmount: amount };
  };
  p.cancel = async () => { counts.cancel++; await slow(); return { ok: true, success: true }; };
}

async function newStay(phone, chargesCents) {
  const { reservationId } = await tenant.runInTenant(HID, () => checkin.startCheckin(
    phone, { guestName: "בודק", guestNameHe: "בודק", guestNameEn: "Tester" },
    `RES-SET-${phone.slice(-5)}`,
    { stay: { checkIn: "2099-12-01", checkOut: "2099-12-03", nights: 2 } },
  ));
  await tenant.runInTenant(HID, () => checkin.completeCheckin(reservationId, "700"));
  if (chargesCents > 0) {
    tenant.runInTenant(HID, () => checkin.addFolioItem(reservationId, "OTHER", "חיוב בדיקה", chargesCents));
  }
  return reservationId;
}

// ════════════════════════════════════════════════════════
//  ההצטלבות האמיתית: צ'ק אאוט בצ'אט + no-show מה-cron
// ════════════════════════════════════════════════════════
test("🔴 צ'ק אאוט ו-no-show בו-זמנית — הפיקדון נלכד פעם אחת בלבד", async () => {
  installCountingProvider();
  const phone = "whatsapp:+972501230001";
  const rid   = await newStay(phone, 20_000);        // ₪200, מתחת לפיקדון

  await Promise.all([
    tenant.runInTenant(HID, () => checkin.processCheckout(phone, rid, "he")).catch(() => {}),
    tenant.runInTenant(HID, () => checkin.autoChargeOnNoShow(rid, "he")).catch(() => {}),
  ]);

  assert.equal(counts.capture, 1,
    `🔴 הפיקדון נלכד ${counts.capture} פעמים — האורח חויב פעמיים`);

  const res = await checkin.ensureReservationLoaded(rid);
  assert.equal(res.captured, true);
  assert.equal(res.capturedAmount, 20_000, "נלכד בדיוק סכום החיובים");
});

test("🔴 חיובים מעל הפיקדון — ההפרש מחויב פעם אחת בלבד", async () => {
  installCountingProvider();
  const phone = "whatsapp:+972501230002";
  const rid   = await newStay(phone, 90_000);        // ₪900 — מעל פיקדון ₪500

  await Promise.all([
    tenant.runInTenant(HID, () => checkin.processCheckout(phone, rid, "he")).catch(() => {}),
    tenant.runInTenant(HID, () => checkin.autoChargeOnNoShow(rid, "he")).catch(() => {}),
  ]);

  assert.equal(counts.capture, 1, `🔴 לכידה כפולה (${counts.capture})`);
  assert.equal(counts.chargeSameCard, 1,
    `🔴 ההפרש חויב ${counts.chargeSameCard} פעמים — חיוב כפול אמיתי בכרטיס האורח`);
});

test("🔴 אין חיובים — ההרשאה מבוטלת פעם אחת בלבד", async () => {
  installCountingProvider();
  const phone = "whatsapp:+972501230003";
  const rid   = await newStay(phone, 0);

  await Promise.all([
    tenant.runInTenant(HID, () => checkin.processCheckout(phone, rid, "he")).catch(() => {}),
    tenant.runInTenant(HID, () => checkin.autoChargeOnNoShow(rid, "he")).catch(() => {}),
  ]);
  assert.equal(counts.cancel, 1, `🔴 ביטול כפול (${counts.cancel})`);
});

test("חמש סליקות מקבילות על אותה הזמנה — עדיין חיוב אחד", async () => {
  installCountingProvider();
  const phone = "whatsapp:+972501230004";
  const rid   = await newStay(phone, 30_000);

  await Promise.all(Array.from({ length: 5 }, () =>
    tenant.runInTenant(HID, () => checkin.autoChargeOnNoShow(rid, "he")).catch(() => {})));

  assert.equal(counts.capture, 1, `🔴 ${counts.capture} לכידות מתוך 5 ריצות מקבילות`);
});

// ════════════════════════════════════════════════════════
//  רישום כספי אמיתי — לא "חויב" כשלא חויב
// ════════════════════════════════════════════════════════
test("🔴 חיוב הפרש שנכשל אינו נרשם כאילו הצליח", async () => {
  installCountingProvider();
  payments.payments.chargeSameCard = async () => {
    counts.chargeSameCard++;
    throw new Error("card declined");
  };

  const phone = "whatsapp:+972501230005";
  const rid   = await newStay(phone, 90_000);
  await tenant.runInTenant(HID, () => checkin.autoChargeOnNoShow(rid, "he")).catch(() => {});

  const res = await checkin.ensureReservationLoaded(rid);
  assert.equal(res.overageCharged, undefined === res.overageCharged ? undefined : false,
    "הדגל נשאר כבוי — אפשר לנסות שוב");
  assert.notEqual(res.overageChargedTo, "deposit_card",
    "🔴 הרשומה הצהירה 'ההפרש חויב מכרטיס הפיקדון' בזמן שהחיוב נדחה");
});

// ════════════════════════════════════════════════════════
//  קשיחות קלט — הודעה ענקית מבחוץ
// ════════════════════════════════════════════════════════
test("🔴 הודעה ענקית נחתכת בכניסה ולא מתנפחת בסשן ובעלות ה-AI", async () => {
  const bot = await import("./bot.js");
  const state = await import("./state.js");
  const phone = "whatsapp:+972501239999";

  // `/webhook` פתוח, ואימות חתימת Twilio כבוי כברירת מחדל — כלומר אפשר
  // לשלוח "הודעה" בגודל שרירותי מבחוץ. בלי חסם היא נכנסת להיסטוריה,
  // נשמרת ל-DB, ונשלחת ל-Claude על חשבון המלון.
  const huge = "א".repeat(50_000);
  await bot.handleIncoming(phone, huge, null, {}).catch(() => {});

  const s = state.peekSession(phone, HID);
  assert.ok(s, "הסשן נוצר");
  const longest = Math.max(0, ...(s.history || []).map(h => String(h.content || "").length));
  assert.ok(longest <= bot.MAX_INBOUND_CHARS,
    `🔴 להיסטוריה נכנסה הודעה באורך ${longest} (מותר ${bot.MAX_INBOUND_CHARS})`);
});

// ════════════════════════════════════════════════════════
//  fail-closed — מסלול כסף לא רץ בלי נעילה
// ════════════════════════════════════════════════════════
test("🔴 בלי נעילה מבוזרת — לא מסלקים בכלל, במקום לסלוק פעמיים", async () => {
  const storeMod = await import("./store/index.js");

  installCountingProvider();
  const phone = "whatsapp:+972501231111";
  const rid   = await newStay(phone, 40_000);

  // store שמתנהג כמו Redis אך **לעולם לא נותן נעילה** (עומס/תקלה).
  // זה בדיוק המצב שבו fail-open היה מחזיר את החיוב הכפול.
  const prev = storeMod.setStore({
    kind: "redis",
    setIfAbsent: async () => false,          // אף פעם לא נתפסת
    deleteIfEquals: async () => false,
    increment: async () => 1,
    get: async () => null, set: async () => {}, del: async () => {},
  });

  try {
    let threw = false;
    await tenant.runInTenant(HID, () => checkin.autoChargeOnNoShow(rid, "he"))
      .catch(e => { threw = e?.name === "LockUnavailableError" || /נעילה/.test(e?.message || ""); });

    assert.ok(threw, "🔴 הסליקה רצה בלי נעילה — זה בדיוק החיוב הכפול");
    assert.equal(counts.capture, 0, "🔴 חויב כסף בלי נעילה בלעדית");

    const res = await checkin.ensureReservationLoaded(rid);
    assert.notEqual(res.captured, true, "ההזמנה לא סומנה כמסולקת — ניסיון חוזר יעבוד");
  } finally {
    storeMod.setStore(prev);
  }
});

test("אחרי שהנעילה שוב זמינה — הסליקה מתבצעת כרגיל", async () => {
  installCountingProvider();
  const phone = "whatsapp:+972501232222";
  const rid   = await newStay(phone, 40_000);
  await tenant.runInTenant(HID, () => checkin.autoChargeOnNoShow(rid, "he"));
  assert.equal(counts.capture, 1, "🔴 המסלול התקין נשבר");
});
