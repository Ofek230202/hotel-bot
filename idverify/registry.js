// ════════════════════════════════════════════════════════
//  ID REGISTRY — רישום, retention, גישה מבוקרת + audit
//  ----------------------------------------------------------
//  התמונה עצמה מוצפנת בקובץ (.enc) או — בפרודקשן — נשלחת ל-vault/PMS.
//  המודול הזה מנהל את *הרישום* של כל מסמך ואת *מי ניגש אליו*, מה שנדרש
//  כדי לעמוד ב-GDPR ובחוק הגנת הפרטיות הישראלי (ראה SECURITY.md):
//
//   • recordIdDocument   — רושם מסמך + קובע תאריך מחיקה אוטומטי (retention).
//   • retrieveIdDocument — פענוח לפי דרישה, *עם בקרת גישה* (בידוד מלון)
//                          *ורישום גישה* (audit) — מי, מתי, למה, מאיזה IP.
//   • listIdDocuments    — מטא-דטא בלבד לקבלה (לעולם לא התמונה).
//   • purgeExpiredIdDocuments — מוחק מסמכים שעבר זמנם (retention job).
//
//  כל גישה נרשמת ב-id_access_log. גישה חוצת-מלונות נחסמת ונרשמת כניסיון.
// ════════════════════════════════════════════════════════
import fs from "node:fs/promises";
import { v4 as uuidv4 } from "uuid";
import { db, DEFAULT_HOTEL_ID } from "../db.js";
import { decryptBuffer } from "./crypto.js";

// כמה זמן נשמר מסמך זיהוי לפני מחיקה אוטומטית. ברירת מחדל: 30 יום.
// מינימיזציית נתונים (GDPR/חוק הגנת הפרטיות): לא שומרים מעבר לנדרש.
export const RETENTION_DAYS = Number(process.env.ID_RETENTION_DAYS) || 30;

const insertDocStmt = db.prepare(`
  INSERT INTO id_documents
    (id, hotel_id, reservation_id, phone, guest_name, doc_type, stored_path, encrypted, status, created_at, purge_after)
  VALUES (@id, @hotel_id, @reservation_id, @phone, @guest_name, @doc_type, @stored_path, @encrypted, @status, @created_at, @purge_after)
`);
const insertAccessStmt = db.prepare(`
  INSERT INTO id_access_log (id, hotel_id, document_id, actor, action, purpose, ip, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

// רישום כל גישה/פעולה על מסמך זיהוי — ליבת ה-audit trail.
export function logIdAccess({ hotelId, documentId, actor, action, purpose, ip } = {}) {
  try {
    insertAccessStmt.run(
      `acc_${uuidv4()}`, hotelId || DEFAULT_HOTEL_ID, documentId || null,
      actor || null, action || null, purpose || null, ip || null, new Date().toISOString(),
    );
  } catch (e) {
    console.error("🪪 [ID] רישום גישה נכשל:", e?.message || e);
  }
}

// רושם מסמך שנשמר, וקובע לו תאריך מחיקה. מחזיר את מזהה הרישום.
export function recordIdDocument({ id, hotelId, reservationId, phone, guestName, docType, storedPath, encrypted = true, status } = {}) {
  const docId = id || `iddoc_${uuidv4()}`;
  const now = new Date();
  const purgeAfter = new Date(now.getTime() + RETENTION_DAYS * 86400_000).toISOString();
  try {
    insertDocStmt.run({
      id: docId, hotel_id: hotelId || DEFAULT_HOTEL_ID, reservation_id: reservationId || null,
      phone: phone || null, guest_name: guestName || null, doc_type: docType || null,
      stored_path: storedPath || null, encrypted: encrypted ? 1 : 0, status: status || null,
      created_at: now.toISOString(), purge_after: purgeAfter,
    });
    logIdAccess({ hotelId, documentId: docId, actor: "system", action: "create", purpose: "check-in verification" });
  } catch (e) {
    console.error("🪪 [ID] רישום מסמך נכשל:", e?.message || e);
  }
  return docId;
}

// מטא-דטא בלבד — לקבלה. לעולם לא מחזיר את התמונה עצמה.
export function listIdDocuments({ hotelId = DEFAULT_HOTEL_ID, reservationId = null } = {}) {
  const cols = `id, hotel_id, reservation_id, phone, guest_name, doc_type, status, created_at, purge_after, deleted_at`;
  return reservationId
    ? db.prepare(`SELECT ${cols} FROM id_documents WHERE hotel_id = ? AND reservation_id = ? ORDER BY created_at DESC`).all(hotelId, reservationId)
    : db.prepare(`SELECT ${cols} FROM id_documents WHERE hotel_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 500`).all(hotelId);
}

// ── שליפה מבוקרת + מתועדת של התמונה ─────────────────────
// זו הדרך היחידה שהקבלה מקבלת גישה לתמונה: פענוח לפי דרישה, בידוד מלון,
// ורישום גישה. מחזיר { buffer, meta } בהצלחה, או אובייקט מצב אחרת.
export async function retrieveIdDocument(documentId, { hotelId, actor, purpose, ip } = {}) {
  const row = db.prepare(`SELECT * FROM id_documents WHERE id = ?`).get(documentId);
  if (!row) return { notFound: true };

  // בידוד מלון: מלון א' לא רשאי לפתוח מסמך של מלון ב'. ניסיון כזה נחסם *ונרשם*.
  if (hotelId && row.hotel_id !== hotelId) {
    logIdAccess({ hotelId, documentId, actor, action: "view_denied", purpose: "cross-tenant", ip });
    return { denied: true };
  }
  if (row.deleted_at) return { deleted: true };

  // verify-then-discard: המסמך אומת אך התמונה לא נשמרה (מדיניות תואמת-
  // רגולציה). יש רישום אימות (proof) — אבל אין תמונה להחזיר, וזה תקין.
  if (!row.stored_path) {
    logIdAccess({ hotelId: row.hotel_id, documentId, actor, action: "view_no_image", purpose, ip });
    return { noImage: true, meta: row };
  }

  let buffer;
  try {
    const blob = await fs.readFile(row.stored_path);
    buffer = row.encrypted ? decryptBuffer(blob) : blob;
  } catch (e) {
    console.error("🪪 [ID] פענוח/קריאה נכשלו:", e?.message || e);
    return { error: e.message };
  }
  logIdAccess({ hotelId: row.hotel_id, documentId, actor, action: "view", purpose, ip });
  return { buffer, meta: row };
}

// יומן הגישות של מסמך (לביקורת/חקירה).
export function accessLogFor(documentId) {
  return db.prepare(`SELECT actor, action, purpose, ip, at FROM id_access_log WHERE document_id = ? ORDER BY at DESC`).all(documentId);
}

// ── מחיקה אוטומטית (retention job) ──────────────────────
// מוחק את הקבצים (כולל ה-metadata לצדם), מסמן deleted_at, ומתעד. נועד
// לרוץ מחזורית (cron). לא זורק — מדלג על מסמך בעייתי וממשיך.
export async function purgeExpiredIdDocuments(now = new Date()) {
  const rows = db.prepare(
    `SELECT * FROM id_documents WHERE deleted_at IS NULL AND purge_after IS NOT NULL AND purge_after <= ?`
  ).all(now.toISOString());
  let purged = 0;
  for (const row of rows) {
    try {
      if (row.stored_path) {
        await fs.unlink(row.stored_path).catch(() => {});
        await fs.unlink(row.stored_path.replace(/\.enc$/, ".json")).catch(() => {});
      }
      db.prepare(`UPDATE id_documents SET deleted_at = ?, stored_path = NULL WHERE id = ?`).run(now.toISOString(), row.id);
      logIdAccess({ hotelId: row.hotel_id, documentId: row.id, actor: "system", action: "purge", purpose: "retention" });
      purged++;
    } catch (e) {
      console.error(`🪪 [ID] מחיקת retention נכשלה למסמך ${row.id}:`, e?.message || e);
    }
  }
  if (rows.length) console.log(`🗑️  ID retention: נמחקו ${purged}/${rows.length} מסמכי זיהוי שפג תוקפם.`);
  return { purged, scanned: rows.length };
}
