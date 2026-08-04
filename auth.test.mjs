// ════════════════════════════════════════════════════════
//  AUTH — תפקידים והרשאות
//  ----------------------------------------------------------
//  🔴 מה שהיה: **סיסמה אחת** לכל המערכת. מי שיש לו אותה רואה שיחות של
//     אורחים, מסמכי זהות מוצפנים וחשבוניות, ויכול לחייב כרטיסים. מספיק
//     שעובד אחד עוזב כדי שהסיסמה תהיה בחוץ.
//
//  הבדיקה החשובה כאן היא **השלילית**: שאיש משק בית *אינו* יכול להגיע
//  למסמכי זהות. הרשאה שנבדקת רק בכיוון החיובי אינה נבדקת.
// ════════════════════════════════════════════════════════
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

const auth = await import("./auth.js");
const { CAP } = auth;

const TOKENS = "manager:mgr-tok:מיכל,reception:rec-tok:קבלה,housekeeping:hk-tok:משק בית,accounting:acc-tok:הנהח,viewer:view-tok:בעלים";

// ════════════════════════════════════════════════════════
//  זיהוי
// ════════════════════════════════════════════════════════
test("טוקן מזוהה לתפקיד ולשם", () => {
  auth.reloadTokens(TOKENS);
  const a = auth.identify("mgr-tok", { adminPassword: null });
  assert.equal(a.role, "manager");
  assert.equal(a.name, "מיכל", "🔴 השם נדרש כדי לתעד מי ביצע פעולה");
});

test("טוקן לא מוכר אינו מזוהה", () => {
  auth.reloadTokens(TOKENS);
  assert.equal(auth.identify("nope", { adminPassword: null }), null);
  assert.equal(auth.identify("", { adminPassword: null }), null);
  assert.equal(auth.identify(null, { adminPassword: null }), null);
});

test("🔴 תאימות לאחור: בלי STAFF_TOKENS הסיסמה הישנה עובדת כ-admin", () => {
  auth.reloadTokens("");
  assert.equal(auth.tokensConfigured(), false);
  const a = auth.identify("old-password", { adminPassword: "old-password" });
  assert.equal(a.role, "admin", "🔴 פריסה קיימת נשברה — זה בלתי מתקבל על הדעת");
  assert.ok(auth.can(a, CAP.VIEW_ID_DOCS));
});

test("סיסמת ה-admin נשארת תקפה גם כשיש תפקידים — כדי לא להינעל בחוץ", () => {
  auth.reloadTokens(TOKENS);
  const a = auth.identify("root-pw", { adminPassword: "root-pw" });
  assert.equal(a.role, "admin");
});

test("תפקיד לא מוכר ב-STAFF_TOKENS מתעלם ואינו מקנה גישה", () => {
  auth.reloadTokens("wizard:magic:קוסם,reception:rec2:קבלה");
  assert.equal(auth.identify("magic", { adminPassword: null }), null,
    "🔴 תפקיד שלא קיים העניק גישה");
  assert.ok(auth.identify("rec2", { adminPassword: null }));
});

// ════════════════════════════════════════════════════════
//  הרשאות — ובעיקר מה **אסור**
// ════════════════════════════════════════════════════════
test("🔴 משק בית רואה בקשות — ולא מסמכי זהות, לא חשבוניות, לא שיחות", () => {
  auth.reloadTokens(TOKENS);
  const hk = auth.identify("hk-tok", { adminPassword: null });

  assert.ok(auth.can(hk, CAP.VIEW_ALERTS), "כן — זה כל תפקידו");
  for (const forbidden of [CAP.VIEW_ID_DOCS, CAP.VIEW_BILLING, CAP.CHARGE,
                           CAP.VIEW_CONVERSATIONS, CAP.EDIT_CONFIG, CAP.ADMIN]) {
    assert.equal(auth.can(hk, forbidden), false,
      `🔴 משק בית קיבל גישה ל-${forbidden} — הרשאה מינימלית הופרה`);
  }
});

test("🔴 הנהלת חשבונות רואה כסף — ואינה קוראת שיחות של אורחים", () => {
  auth.reloadTokens(TOKENS);
  const acc = auth.identify("acc-tok", { adminPassword: null });
  assert.ok(auth.can(acc, CAP.VIEW_BILLING));
  assert.equal(auth.can(acc, CAP.VIEW_CONVERSATIONS), false,
    "🔴 הנהלת חשבונות קוראת שיחות פרטיות של אורחים");
  assert.equal(auth.can(acc, CAP.VIEW_ID_DOCS), false);
});

test("קבלה מנהלת שיחות — ואינה נוגעת בכספים", () => {
  auth.reloadTokens(TOKENS);
  const rec = auth.identify("rec-tok", { adminPassword: null });
  assert.ok(auth.can(rec, CAP.VIEW_CONVERSATIONS) && auth.can(rec, CAP.REPLY_GUEST));
  assert.equal(auth.can(rec, CAP.CHARGE), false, "🔴 קבלה יכולה לחייב כרטיס");
  assert.equal(auth.can(rec, CAP.VIEW_ID_DOCS), false);
});

test("רק מנהל ומעלה ניגשים למסמכי זהות", () => {
  auth.reloadTokens(TOKENS);
  const allowed = ["mgr-tok"];
  const denied  = ["rec-tok", "hk-tok", "acc-tok", "view-tok"];
  for (const t of allowed) assert.ok(auth.can(auth.identify(t, { adminPassword: null }), CAP.VIEW_ID_DOCS), t);
  for (const t of denied) {
    assert.equal(auth.can(auth.identify(t, { adminPassword: null }), CAP.VIEW_ID_DOCS), false,
      `🔴 ${t} הגיע ל-PII רגיש`);
  }
});

test("admin עוקף הכול — זו כל הנקודה בתפקיד", () => {
  auth.reloadTokens("admin:root:מנהל מערכת");
  const a = auth.identify("root", { adminPassword: null });
  for (const cap of Object.values(CAP)) assert.ok(auth.can(a, cap), cap);
});

// ════════════════════════════════════════════════════════
//  אכיפה בשרת — לא רק בממשק
// ════════════════════════════════════════════════════════
async function withServer(cap, fn) {
  const app = express();
  app.get("/guarded", auth.requireCap(cap), (req, res) => res.json({ ok: true, by: req.actor.name }));
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)); });
  try { return await fn(`http://127.0.0.1:${s.address().port}/guarded`); }
  finally { s.closeAllConnections?.(); await new Promise(r => s.close(r)); }
}
const get = (url, token) => fetch(url, token ? { headers: { "x-dashboard-token": token } } : undefined);

test("🔴 401 = לא זוהית · 403 = זוהית ואינך מורשה", async () => {
  auth.reloadTokens(TOKENS);
  process.env.DASHBOARD_PASSWORD = "";
  await withServer(CAP.VIEW_ID_DOCS, async (url) => {
    assert.equal((await get(url)).status, 401, "בלי טוקן — 401");
    assert.equal((await get(url, "bad")).status, 401, "טוקן שגוי — 401");
    // 🔴 ההבחנה אינה קוסמטית: 401 גורם לאיש צוות לנסות להתחבר שוב ושוב;
    //    403 אומר לו לפנות למנהל.
    assert.equal((await get(url, "hk-tok")).status, 403, "🔴 מזוהה אך לא מורשה חייב 403");
    assert.equal((await get(url, "mgr-tok")).status, 200);
  });
});

test("ההאנדלר יודע מי ביצע — לתיעוד", async () => {
  auth.reloadTokens(TOKENS);
  await withServer(CAP.VIEW_ALERTS, async (url) => {
    const r = await get(url, "hk-tok");
    assert.deepEqual(await r.json(), { ok: true, by: "משק בית" },
      "🔴 בלי שם המבצע אין שרשרת אחריות");
  });
});

test("תשובת 403 אומרת מה חסר — כדי שאפשר יהיה לתקן", async () => {
  auth.reloadTokens(TOKENS);
  process.env.DASHBOARD_PASSWORD = "";
  await withServer(CAP.CHARGE, async (url) => {
    const body = await (await get(url, "rec-tok")).json();
    assert.equal(body.need, CAP.CHARGE);
    assert.equal(body.role, "reception");
  });
});

test("שלמות: לכל תפקיד יכולות מוגדרות, ואף אחת אינה מומצאת", () => {
  const all = new Set(Object.values(CAP));
  for (const [role, caps] of Object.entries(auth.ROLES)) {
    assert.ok(Array.isArray(caps) && caps.length, `${role}: אין יכולות`);
    for (const c of caps) assert.ok(all.has(c), `${role}: יכולת לא מוכרת "${c}"`);
  }
});
