// ════════════════════════════════════════════════════════
//  מחיקת מסמך הזיהוי גם מהשרתים של Twilio
//  ----------------------------------------------------------
//  🔴 **הפער שנמצא (05.08.2026), והוא הפער החמור ביותר בנושא הפרטיות:**
//     המערכת הכריזה verify-then-discard ואמרה לאורח במפורש *"מוחקים את
//     התמונה — היא אינה נשמרת"*. מקומית זה היה נכון לחלוטין.
//
//     אבל התמונה לא הגיעה אלינו מהאוויר: וואטסאפ העלה אותה ל-**Twilio**,
//     ו-Twilio שומרת מדיה עד שמוחקים אותה במפורש דרך ה-API. כלומר צילום
//     תעודת הזהות של האורח נשאר על שרתי Twilio (ארה"ב) — ואנחנו הצהרנו
//     בפניו שלא. הצהרת פרטיות שגויה גרועה מהיעדר הצהרה.
//
//     `git grep deleteMedia` החזיר **אפס תוצאות**: שום קוד לא מחק שם כלום.
// ════════════════════════════════════════════════════════
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH             = freshTestDbPath("idpurge");
process.env.ID_ENCRYPTION_KEY   = "0".repeat(64);
process.env.TWILIO_ACCOUNT_SID  = "ACtest0000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN   = "testtoken";

const { parseTwilioMediaUrl, deleteTwilioMedia } = await import("./idverify/twilio-media.js");

const REAL_URL =
  "https://api.twilio.com/2010-04-01/Accounts/ACtest0000000000000000000000000000" +
  "/Messages/MM1234567890abcdef/Media/ME0987654321fedcba";

// ── פענוח הכתובת ───────────────────────────────────────
test("פענוח: כתובת מדיה אמיתית של Twilio מפוענחת לשלושת המזהים", () => {
  const ids = parseTwilioMediaUrl(REAL_URL);
  assert.ok(ids, "כתובת Twilio תקינה לא פוענחה");
  assert.equal(ids.accountSid, "ACtest0000000000000000000000000000");
  assert.equal(ids.messageSid, "MM1234567890abcdef");
  assert.equal(ids.mediaSid,   "ME0987654321fedcba");
});

test("פענוח: כתובת שאינה של Twilio מוחזרת כ-null (מוק/בדיקה)", () => {
  for (const u of ["https://example.com/photo.jpg", "file:///tmp/x.png", "", null, undefined]) {
    assert.equal(parseTwilioMediaUrl(u), null, `זוהתה בטעות ככתובת Twilio: ${u}`);
  }
});

// ── המחיקה עצמה ────────────────────────────────────────
test("🔴 מחיקה: נשלחת בקשת DELETE אמיתית לנתיב הנכון, עם הזדהות", async () => {
  const calls = [];
  const r = await deleteTwilioMedia(REAL_URL, {
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { status: 204 }; },
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1, "🔴 לא נשלחה בקשת מחיקה כלל — זה בדיוק הבאג");
  assert.equal(calls[0].opts.method, "DELETE");
  assert.match(calls[0].url, /\/Messages\/MM1234567890abcdef\/Media\/ME0987654321fedcba/);
  assert.match(calls[0].opts.headers.Authorization, /^Basic /, "חייבת הזדהות");
});

test("מחיקה: 404 נחשב הצלחה — הפעולה אידמפוטנטית", async () => {
  const r = await deleteTwilioMedia(REAL_URL, { fetchImpl: async () => ({ status: 404 }) });
  assert.equal(r.ok, true, "מדיה שכבר נמחקה אינה כישלון");
});

test("מחיקה: כתובת שאינה של Twilio — אין מה למחוק, ואין קריאת רשת", async () => {
  let called = false;
  const r = await deleteTwilioMedia("https://example.com/x.jpg", {
    fetchImpl: async () => { called = true; return { status: 204 }; },
  });
  assert.equal(r.ok, true);
  assert.equal(called, false, "נשלחה קריאת רשת מיותרת");
  assert.equal(r.reason, "not_twilio_media");
});

// ── כישלון חייב להיות רועש, לא שקט ─────────────────────
test("🔴 כישלון מחיקה מדווח — PII ששרד אסור שיהיה שקט", async () => {
  const r = await deleteTwilioMedia(REAL_URL, { fetchImpl: async () => ({ status: 500 }) });
  assert.equal(r.ok, false, "כישלון סומן כהצלחה");
  assert.equal(r.reason, "http_500");
});

test("כישלון רשת אינו זורק — צ'ק אין לא נשבר בגלל מחיקה", async () => {
  const r = await deleteTwilioMedia(REAL_URL, {
    fetchImpl: async () => { throw new Error("network down"); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "network");
});

test("חסרים credentials → מדווח, ולא מתחזה להצלחה", async () => {
  const r = await deleteTwilioMedia(REAL_URL, { accountSid: null, authToken: null });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_credentials");
});

// ── המסלול המלא ────────────────────────────────────────
test("🔴 verify-then-discard מוחק גם אצל הספק — לא רק אצלנו", async () => {
  const deleted = [];
  mock.module("./idverify/vision.js", {
    namedExports: {
      fetchMedia: async () => ({ buffer: Buffer.from("fake-image-bytes"), contentType: "image/jpeg" }),
      inspectIdImage: async () => ({
        valid: true, isId: true, readable: true, confidence: 0.95,
        docType: "id_card", fields: { full_name: "Test Guest", document_number: "123456789" },
        reasonHe: "", reasonEn: "",
      }),
    },
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts?.method === "DELETE") { deleted.push(url); return { status: 204 }; }
    return origFetch(url, opts);
  };
  try {
    const { MockIdProvider } = await import("./idverify/MockIdProvider.js");
    const res = await new MockIdProvider().verifyDocument({
      reservationId: "res-purge-1", phone: "+972500000001",
      guestName: "Test Guest", mediaUrl: REAL_URL, contentType: "image/jpeg",
    });
    assert.equal(res.success, true, "האימות עצמו נכשל");
    assert.equal(res.discarded, true, "ברירת המחדל היא verify-then-discard");
    assert.equal(res.storedPath, null, "התמונה נשמרה מקומית למרות discard");
    // 🔴 הלב: העותק אצל Twilio נמחק גם הוא.
    assert.equal(deleted.length, 1,
      "🔴 העותק של מסמך הזיהוי נשאר אצל Twilio — בניגוד להצהרה שנמסרה לאורח");
    assert.match(deleted[0], /\/Media\/ME0987654321fedcba/);
  } finally {
    globalThis.fetch = origFetch;
  }
});
