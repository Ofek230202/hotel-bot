// ════════════════════════════════════════════════════════
//  ID SECURITY — הצפנה, בקרת גישה, audit ו-retention (Part 3)
//  ----------------------------------------------------------
//  מוכיח את מודל האבטחה של מסמכי הזיהוי:
//   • התמונה נשמרת מוצפנת ומשוחזרת נכון (round-trip).
//   • רשימה מחזירה מטא-דטא בלבד — לעולם לא את התמונה.
//   • כל גישה נרשמת (audit) — create + view.
//   • מלון א' לא יכול לפתוח מסמך של מלון ב' (בידוד), והניסיון נרשם.
//   • retention: מסמך שפג תוקפו נמחק, וקריאה אחריו מחזירה "נמחק".
//
//  הרצה: node --test idsecurity.test.mjs
// ════════════════════════════════════════════════════════
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.DB_PATH           = path.join(os.tmpdir(), `hotel-idsec-${process.pid}.db`);
process.env.ID_ENCRYPTION_KEY = "0".repeat(64);

let reg, crypto, tmpDir;
before(async () => {
  reg    = await import("./idverify/registry.js");
  crypto = await import("./idverify/crypto.js");
  tmpDir = path.join(os.tmpdir(), `idsec-files-${process.pid}`);
  await fs.mkdir(tmpDir, { recursive: true });
});

// עוזר: יוצר קובץ מוצפן אמיתי ורושם אותו ל-registry. מחזיר { docId, path, plain }.
async function makeDoc({ hotelId, reservationId = "res1", purgeAfterMs = null } = {}) {
  const plain = Buffer.from(`ID-IMAGE-BYTES-${Math.round(performance.now())}-${reservationId}`);
  const enc   = crypto.encryptBuffer(plain);
  const p     = path.join(tmpDir, `${hotelId}-${reservationId}-${Math.round(performance.now())}.enc`);
  await fs.writeFile(p, enc);
  const docId = reg.recordIdDocument({
    hotelId, reservationId, phone: "whatsapp:+972500000001", guestName: "בדיקה",
    docType: "passport", storedPath: p, encrypted: true, status: "verified",
  });
  return { docId, path: p, plain };
}

test("הצפנה: round-trip — פענוח מחזיר בדיוק את המקור", async () => {
  const { docId, plain } = await makeDoc({ hotelId: "kempinski" });
  const out = await reg.retrieveIdDocument(docId, { hotelId: "kempinski", actor: "reception1", purpose: "check-in" });
  assert.ok(out.buffer, "התקבל buffer");
  assert.equal(out.buffer.toString(), plain.toString(), "הפענוח זהה למקור");
});

test("קובץ בדיסק מוצפן — לא קריא כטקסט גולמי", async () => {
  const { path: p, plain } = await makeDoc({ hotelId: "kempinski" });
  const onDisk = await fs.readFile(p);
  assert.notEqual(onDisk.toString("latin1"), plain.toString("latin1"), "הקובץ בדיסק אינו plaintext");
});

test("רשימה מחזירה מטא-דטא בלבד — בלי התמונה", async () => {
  await makeDoc({ hotelId: "kempinski", reservationId: "resL" });
  const rows = reg.listIdDocuments({ hotelId: "kempinski", reservationId: "resL" });
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.ok(!("buffer" in r) && !("data" in r), "אין תוכן תמונה ברשימה");
    assert.ok(r.doc_type && r.created_at && r.purge_after, "יש מטא-דטא ותאריך מחיקה");
  }
});

test("audit: כל גישה נרשמת (create + view)", async () => {
  const { docId } = await makeDoc({ hotelId: "kempinski" });
  await reg.retrieveIdDocument(docId, { hotelId: "kempinski", actor: "reception7", purpose: "ביקורת" });
  const log = reg.accessLogFor(docId);
  const actions = log.map(l => l.action);
  assert.ok(actions.includes("create"), "רישום יצירה");
  assert.ok(actions.includes("view"),   "רישום צפייה");
  assert.ok(log.some(l => l.actor === "reception7"), "מי ניגש נרשם");
});

test("בידוד: מלון א' לא יכול לפתוח מסמך של מלון ב' — והניסיון נרשם", async () => {
  const { docId } = await makeDoc({ hotelId: "hotelb", reservationId: "resB" });
  const out = await reg.retrieveIdDocument(docId, { hotelId: "kempinski", actor: "attacker", purpose: "x" });
  assert.ok(out.denied, "גישה חוצת-מלונות נחסמה");
  assert.ok(!out.buffer, "לא הוחזרה תמונה");
  const log = reg.accessLogFor(docId);
  assert.ok(log.some(l => l.action === "view_denied"), "ניסיון הגישה החסום נרשם ל-audit");
});

test("verify-then-discard: מסמך שאומת בלי תמונה — יש proof, אין תמונה להחזיר", async () => {
  // מדמה את המצב שהמלצת הרגולציה יוצרת: אימות נרשם, storedPath = null.
  const docId = reg.recordIdDocument({
    hotelId: "kempinski", reservationId: "resDiscard", phone: "whatsapp:+972500000009",
    guestName: "אורח", docType: "passport", storedPath: null, encrypted: false, status: "verified_discarded",
  });
  const out = await reg.retrieveIdDocument(docId, { hotelId: "kempinski", actor: "reception1", purpose: "review" });
  assert.ok(out.noImage, "אין תמונה שמורה");
  assert.ok(!out.buffer, "לא הוחזרה תמונה");
  assert.equal(out.meta.status, "verified_discarded", "אבל רישום האימות (proof) קיים");
  const log = reg.accessLogFor(docId);
  assert.ok(log.some(l => l.action === "view_no_image"), "הגישה נרשמה גם כשאין תמונה");
});

test("retention: מסמך שפג תוקפו נמחק — הקובץ נעלם והקריאה מחזירה 'נמחק'", async () => {
  const { docId, path: p } = await makeDoc({ hotelId: "kempinski", reservationId: "resExpire" });
  // דוחפים את purge_after לעבר ישירות (מדמה מסמך ישן).
  const { db } = await import("./db.js");
  db.prepare(`UPDATE id_documents SET purge_after = ? WHERE id = ?`)
    .run(new Date(Date.now() - 1000).toISOString(), docId);

  const result = await reg.purgeExpiredIdDocuments();
  assert.ok(result.purged >= 1, "לפחות מסמך אחד נמחק");

  await assert.rejects(fs.access(p), "הקובץ נמחק מהדיסק");
  const out = await reg.retrieveIdDocument(docId, { hotelId: "kempinski", actor: "reception1", purpose: "x" });
  assert.ok(out.deleted, "קריאה אחרי מחיקה מחזירה 'נמחק'");

  const log = reg.accessLogFor(docId);
  assert.ok(log.some(l => l.action === "purge"), "המחיקה נרשמה ל-audit");
});
