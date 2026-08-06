// ════════════════════════════════════════════════════════
//  פרטי ההדגמה האישיים — ומה שמונע מהם לדלוף למלון אמיתי
//  ----------------------------------------------------------
//  אנשי הקשר של מלון ההדגמה מופנים לטלפון ולמייל של הבעלים, כדי
//  שבהדגמה מול לקוח אפשר יהיה להראות שההתראה באמת יוצאת.
//
//  🔴 **הבדיקה החשובה כאן היא השלילית.** אם הפרטים האישיים היו יושבים
//     ב-`DEFAULTS`, מלון לקוח אמיתי שישכח להגדיר מחלקה אחת היה שולח את
//     הבקשות של האורחים שלו לטלפון פרטי — בשקט, בדיוק כמו מחלקת
//     "הירושה השקטה מ-DEFAULTS" שתועדה ב-§9.1. לכן יש רשימת היתר,
//     ויש כאן בדיקה שהיא באמת נאכפת.
// ════════════════════════════════════════════════════════
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH = freshTestDbPath("democontacts");

const { applyDemoContacts, usingDemoContacts, DEMO_OWNER, DEMO_HOTEL_IDS } = await import("./demo-contacts.js");
const { configFor, updateConfigFor, DEPARTMENTS, departmentContacts, checkTenantIsolation } = await import("./config.js");

// ── מה שאמור לקרות ─────────────────────────────────────
test("הדגמה: כל 6 המחלגות של מלון ההדגמה מופנות לבעלים", () => {
  const r = applyDemoContacts("kempinski");
  assert.equal(r.ok, true);
  for (const dept of DEPARTMENTS) {
    const { whatsapp, email } = departmentContacts(dept, "kempinski");
    assert.equal(email, DEMO_OWNER.email, `${dept}_email לא הופנה`);
    assert.equal(whatsapp, DEMO_OWNER.whatsapp, `${dept}_number לא הופנה`);
  }
});

test("הדגמה: מנהל תורן מופנה גם הוא — אחרת הסלמת החירום מדגימה כישלון", () => {
  applyDemoContacts("kempinski");
  assert.equal(configFor("kempinski").duty_manager_number, DEMO_OWNER.whatsapp);
});

test("המספר בפורמט בינלאומי תקין (0507070870 → +972507070870)", () => {
  assert.equal(DEMO_OWNER.phone, "+972507070870");
  assert.match(DEMO_OWNER.whatsapp, /^whatsapp:\+972507070870$/);
  assert.match(DEMO_OWNER.email, /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i);
});

// ── 🔴 הבדיקות שמונעות דליפה ────────────────────────────
test("🔴 מלון שאינו הדגמה נדחה — הפרטים האישיים לא נכתבים אליו", () => {
  const r = applyDemoContacts("real-client-hotel");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_a_demo_hotel");
  for (const dept of DEPARTMENTS) {
    const { whatsapp, email } = departmentContacts(dept, "real-client-hotel");
    assert.notEqual(email, DEMO_OWNER.email, `🔴 ${dept}_email של מלון אמיתי מצביע על הבעלים`);
    assert.notEqual(whatsapp, DEMO_OWNER.whatsapp, `🔴 ${dept}_number של מלון אמיתי מצביע על הבעלים`);
  }
});

test("🔴 הפרטים האישיים אינם ב-DEFAULTS — מלון חדש לא יורש אותם בשקט", () => {
  // מלון חדש לגמרי, בלי אף הגדרה: מקבל את DEFAULTS. אסור שיקבל את הבעלים.
  const cfg = configFor("brand-new-hotel-never-configured");
  for (const dept of DEPARTMENTS) {
    assert.notEqual(cfg[`${dept}_email`], DEMO_OWNER.email,
      `🔴 DEFAULTS מכיל את המייל האישי — כל מלון לא-מוגדר ידלוף אליו`);
    assert.notEqual(cfg[`${dept}_number`], DEMO_OWNER.whatsapp,
      `🔴 DEFAULTS מכיל את הטלפון האישי`);
  }
  assert.notEqual(cfg.duty_manager_number, DEMO_OWNER.whatsapp);
});

test("🔴 מלון אמיתי במקביל להדגמה — אנשי הקשר שלו נשארים שלו", () => {
  applyDemoContacts("kempinski");        // ההדגמה פעילה
  updateConfigFor("client-hotel", {      // ומלון לקוח רץ במקביל
    name: "Client Hotel",
    reception_number: "whatsapp:+972500000001",
    reception_email:  "reception@client.co.il",
  });
  const { whatsapp, email } = departmentContacts("reception", "client-hotel");
  assert.equal(email, "reception@client.co.il");
  assert.equal(whatsapp, "whatsapp:+972500000001");
  // וההדגמה לא נפגעה
  assert.equal(departmentContacts("reception", "kempinski").email, DEMO_OWNER.email);
});

test("כיבוי מפורש: DEMO_CONTACTS=off אינו כותב כלום", () => {
  const prev = process.env.DEMO_CONTACTS;
  process.env.DEMO_CONTACTS = "off";
  try {
    const r = applyDemoContacts("lala");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "disabled");
  } finally {
    if (prev === undefined) delete process.env.DEMO_CONTACTS; else process.env.DEMO_CONTACTS = prev;
  }
});

test("usingDemoContacts מזהה נכון מי פעיל ומי לא", () => {
  applyDemoContacts("kempinski");
  assert.equal(usingDemoContacts("kempinski"), true);
  assert.equal(usingDemoContacts("client-hotel"), false);
});

test("רשימת ההיתר מכילה מלונות הדגמה בלבד", () => {
  assert.ok(DEMO_HOTEL_IDS.length > 0);
  for (const id of DEMO_HOTEL_IDS) {
    assert.match(id, /^(kempinski|lala)$/, `"${id}" ברשימת ההיתר — ודאו שהוא מלון הדגמה`);
  }
});
