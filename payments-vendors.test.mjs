// ════════════════════════════════════════════════════════
//  רישום חברות הסליקה — ומה שמונע חיוב דרך נתיב מנוחש
//  ----------------------------------------------------------
//  המטרה של השכבה: ביום שמלון יגיד "אנחנו עובדים עם טרנזילה", החיבור
//  יהיה שינוי קונפיג ולא פרויקט. מלון לא מחליף חברת סליקה בשביל בוט.
//
//  🔴 **הבדיקה החשובה כאן היא זו שמונעת חיוב אמיתי דרך ספק שלא אומת.**
//     נתיב מנוחש שמצליח *חלקית* גרוע פי כמה מנתיב שנכשל: הוא יוצר
//     "תשלום שהצליח" מדומה, והאורח מקבל חדר בלי פיקדון. לכן ספק
//     `verified:false` תמיד נופל ל-Mock — בקול.
// ════════════════════════════════════════════════════════
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH = freshTestDbPath("payvendors");

const {
  PAYMENT_VENDORS, PAYMENT_VENDOR_IDS, paymentVendor,
  vendorReadiness, canChargeLive, paymentsFor, paymentReadiness, PAY_CAPS,
} = await import("./payments/index.js");
const { MockProvider } = await import("./payments/MockProvider.js");
const { CardComProvider } = await import("./payments/CardComProvider.js");
const { updateConfigFor } = await import("./config.js");
const { depositExplainer } = await import("./checkin.js");

// ── שלמות הרישום ───────────────────────────────────────
test("הרישום מכיל את חברות הסליקה הישראליות הנפוצות", () => {
  for (const id of ["cardcom", "tranzila", "pelecard", "yaad", "payplus", "meshulam"]) {
    assert.ok(PAYMENT_VENDORS[id], `חסר ספק ישראלי: ${id}`);
    assert.equal(PAYMENT_VENDORS[id].region, "ישראל");
  }
});

test("כל ספק נושא את מה שצריך לבקש מהמלון, ואיך משיגים את זה", () => {
  for (const id of PAYMENT_VENDOR_IDS) {
    const v = paymentVendor(id);
    assert.ok(v.labelHe, `${id}: אין שם בעברית`);
    assert.ok(v.docsUrl, `${id}: אין קישור לתיעוד`);
    assert.ok(v.accessHe && v.accessHe.length > 20, `${id}: אין הסבר איך משיגים גישה`);
    assert.ok(Array.isArray(v.capabilities) && v.capabilities.length, `${id}: אין יכולות`);
    assert.ok(Array.isArray(v.credentialFields) && v.credentialFields.length,
      `${id}: אין רשימת credentials — אי אפשר לבקש מהמלון מה שצריך`);
    for (const f of v.credentialFields) {
      assert.ok(f.key && f.labelHe, `${id}: שדה credential בלי key/labelHe`);
    }
  }
});

test("ספק לא מאומת מסומן במפורש ונושא אזהרה", () => {
  for (const id of PAYMENT_VENDOR_IDS) {
    const v = paymentVendor(id);
    if (!v.verified) {
      assert.ok(v.warnHe, `${id}: ספק לא מאומת חייב לשאת אזהרה מפורשת`);
      assert.match(v.warnHe, /⚠️|🔴/, `${id}: האזהרה חייבת להיות בולטת`);
    }
  }
});

// ── 🔴 הקו האדום ───────────────────────────────────────
test("🔴 רק ספק מאומת עם מימוש רשאי לחייב באמת", () => {
  const live = PAYMENT_VENDOR_IDS.filter(id => canChargeLive(id));
  assert.deepEqual(live, ["cardcom"],
    `🔴 ספק בלי מימוש מאומת סומן כמורשה לחייב: ${live.join(", ")}`);
});

test("🔴 מלון שהוגדר לספק לא מאומת נופל ל-Mock — לא מחייב דרך נתיב מנוחש", () => {
  for (const id of ["tranzila", "pelecard", "yaad", "payplus", "meshulam", "stripe", "adyen"]) {
    updateConfigFor(`hotel-${id}`, {
      payment_provider: id,
      payment_credentials: { supplier: "x", password: "y", apiKey: "z", terminalNumber: "1", user: "u", masof: "m", passP: "p", userId: "u", secretKey: "s", merchantAccount: "m" },
    });
    const p = paymentsFor(`hotel-${id}`);
    assert.ok(p instanceof MockProvider,
      `🔴 ${id}: מלון מחובר לספק שלא אומת — חיוב אמיתי דרך נתיב מנוחש`);
  }
});

test("קארדקום עם credentials מלאים — הספק האמיתי כן נבחר", () => {
  updateConfigFor("hotel-cc-live", {
    payment_provider: "cardcom",
    payment_credentials: { terminalNumber: "1000", apiName: "testapi" },
  });
  assert.ok(paymentsFor("hotel-cc-live") instanceof CardComProvider);
});

test("קארדקום בלי credentials — Mock עם אזהרה, כדי לא לשבור צ'ק אין", () => {
  updateConfigFor("hotel-cc-empty", { payment_provider: "cardcom", payment_credentials: {} });
  assert.ok(paymentsFor("hotel-cc-empty") instanceof MockProvider);
});

// ── readiness — מה עוד צריך ─────────────────────────────
test("readiness אומר בדיוק מה חסר, בשם שאפשר לבקש בו מהמלון", () => {
  const r = vendorReadiness("tranzila", {});
  assert.equal(r.ok, false);
  assert.ok(r.missing.length >= 2);
  for (const m of r.missing) assert.ok(m.labelHe, "שדה חסר בלי תווית בעברית");
  const full = vendorReadiness("tranzila", { supplier: "myhotel", password: "pw" });
  assert.equal(full.ok, true);
  // אבל עדיין לא מורשה לחייב — כי אינו מאומת.
  assert.equal(full.canChargeLive, false);
});

test("paymentReadiness מסביר למלון את מצבו בעברית", () => {
  updateConfigFor("hotel-ready-1", { payment_provider: "mock" });
  const mock = paymentReadiness("hotel-ready-1");
  assert.equal(mock.live, false);
  assert.match(mock.noteHe, /הדגמה/);

  updateConfigFor("hotel-ready-2", {
    payment_provider: "cardcom",
    payment_credentials: { terminalNumber: "1000", apiName: "api" },
  });
  const live = paymentReadiness("hotel-ready-2");
  assert.equal(live.live, true);
  assert.match(live.noteHe, /אמיתית/);

  updateConfigFor("hotel-ready-3", { payment_provider: "tranzila", payment_credentials: {} });
  const skel = paymentReadiness("hotel-ready-3");
  assert.equal(skel.live, false);
  assert.ok(skel.missing.length, "חייב לומר מה חסר");
});

test("ספק לא מוכר אינו מפיל — נופל ל-Mock ומדווח", () => {
  updateConfigFor("hotel-unknown-pay", { payment_provider: "totally-made-up" });
  assert.ok(paymentsFor("hotel-unknown-pay") instanceof MockProvider);
  assert.equal(paymentReadiness("hotel-unknown-pay").ready, false);
});

// ── 🔴 הבטחה לאורח חייבת להתאים ליכולת בפועל ────────────
test("🔴 ספק בלי הקפאה (J5) → ההסבר לאורח אומר 'נגבה ומזוכה', לא 'הקפאה בלבד'", () => {
  // ברירת המחדל (Mock/קארדקום) — הקפאה אמיתית.
  updateConfigFor("hotel-hold-yes", { payment_provider: "mock" });
  const held = depositExplainer("he", "hotel-hold-yes");
  assert.match(held, /מוקפא|הקפאה/, "ספק שתומך בהקפאה חייב לומר 'הקפאה'");

  // מלון שהצהיר שהטרמינל שלו אינו תומך בהקפאה.
  updateConfigFor("hotel-hold-no", {
    payment_provider: "cardcom",
    payment_credentials: { terminalNumber: "1", apiName: "a", supportsHold: false },
  });
  const charged = depositExplainer("he", "hotel-hold-no");
  assert.doesNotMatch(charged, /זו הקפאה בלבד, לא חיוב/,
    "🔴 הובטח לאורח 'הקפאה בלבד' בזמן שהכסף באמת יורד מהחשבון");
  assert.match(charged, /נגבה|מזוכה/, "חייב לומר את האמת: נגבה ומזוכה");

  // ובאנגלית
  const chargedEn = depositExplainer("en", "hotel-hold-no");
  assert.doesNotMatch(chargedEn, /a hold only, not a charge/i);
  assert.match(chargedEn, /refunded/i);
});

test("שלושת המקרים נשארים מוסברים בשתי הצורות ובשתי השפות", () => {
  for (const hotel of ["hotel-hold-yes", "hotel-hold-no"]) {
    for (const lang of ["he", "en"]) {
      const t = depositExplainer(lang, hotel);
      const lines = t.split("\n").filter(l => l.trim().startsWith("-"));
      assert.equal(lines.length, 3, `${hotel}/${lang}: חייבים להיות שלושת המקרים`);
    }
  }
});

test("יכולות מוגדרות מהמילון המשותף — בלי מחרוזות חופשיות", () => {
  const valid = new Set(Object.values(PAY_CAPS));
  for (const id of PAYMENT_VENDOR_IDS) {
    for (const cap of paymentVendor(id).capabilities) {
      assert.ok(valid.has(cap), `${id}: יכולת לא מוכרת "${cap}"`);
    }
  }
});

// ── J5 — ההרשאה שאינה קוד ──────────────────────────────
// 🔴 שב"א: "עבודה כזאת מתאפשרת רק לאחר קבלת אישורים מחברות האשראי".
//    טרמינל שלא אושר מחזיר שגיאה 349/044 בפיקדון הראשון — וזה ייראה
//    כבאג בהדגמה בזמן שזו בעיה של חשבון הסוחר. לכן זה נשאל מראש.
test("🔴 J5: ספק שתומך בהקפאה מתריע כשלא ידוע אם הטרמינל מאושר", () => {
  const r = vendorReadiness("pelecard", { terminalNumber: "1", user: "u", password: "p" });
  assert.equal(r.supportsHold, true);
  assert.equal(r.j5Approved, null, "לא נמסר — חייב להיות null ולא הנחה שקטה");
  assert.ok(r.holdWarnings.length > 0, "🔴 חוסר הרשאת J5 עבר בשקט");
  assert.match(r.holdWarnings.join(" "), /349|הרשאה/, "האזהרה חייבת לנקוב בשגיאה שתתקבל");
});

test("J5: מלון שהצהיר שאין אישור — מקבל אזהרה מפורשת", () => {
  const r = vendorReadiness("pelecard", { terminalNumber: "1", user: "u", password: "p", j5Approved: false });
  assert.equal(r.j5Approved, false);
  assert.match(r.holdWarnings.join(" "), /חיוב מלא \+ זיכוי/, "חייב להסביר מה יקרה בפועל");
});

test("J5: אישור מפורש → אין אזהרה", () => {
  const r = vendorReadiness("pelecard", { terminalNumber: "1", user: "u", password: "p", j5Approved: true });
  assert.equal(r.j5Approved, true);
  assert.equal(r.holdWarnings.length, 0);
});

test("j5Approved=false משנה את ההסבר לאורח — בלי צורך ב-supportsHold", () => {
  updateConfigFor("hotel-j5-no", {
    payment_provider: "cardcom",
    payment_credentials: { terminalNumber: "1", apiName: "a", j5Approved: false },
  });
  const t = depositExplainer("he", "hotel-j5-no");
  assert.doesNotMatch(t, /זו הקפאה בלבד, לא חיוב/,
    "🔴 הובטחה הקפאה בזמן שהטרמינל אינו מאושר לה");
  assert.match(t, /נגבה|מזוכה/);
});

test("שלוש השאלות לספק מלוות כל בדיקת מוכנות", () => {
  const r = vendorReadiness("tranzila", { supplier: "s", password: "p" });
  assert.equal(r.askVendorHe.length, 3);
  assert.match(r.askVendorHe.join(" "), /7011/, "חייב לשאול על משך ההקפאה ל-MCC של מלונות");
  assert.match(r.askVendorHe.join(" "), /לכידה חלקית|partial/i);
});

test("משך ההקפאה הוא קונפיג פר-מלון, לא קבוע בקוד", () => {
  const a = vendorReadiness("cardcom", { terminalNumber: "1", apiName: "a" });
  assert.equal(a.holdDurationDays, null, "בלי הגדרה — לא מניחים מספר");
  const b = vendorReadiness("cardcom", { terminalNumber: "1", apiName: "a", holdDurationDays: 30 });
  assert.equal(b.holdDurationDays, 30);
});

test("HYP ו-PayMe נוספו — שניהם רלוונטיים דרך Optima", () => {
  for (const id of ["hyp", "payme"]) {
    const v = paymentVendor(id);
    assert.ok(v, `חסר ספק: ${id}`);
    assert.equal(v.region, "ישראל");
    assert.ok(v.warnHe, "ספק שלד חייב אזהרה");
  }
});
