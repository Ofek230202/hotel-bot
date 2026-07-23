// ════════════════════════════════════════════════════════
//  MockIdProvider — אימות מסמך זיהוי (בדיקה אמיתית) + אחסון דמו
//  ----------------------------------------------------------
//  שני חלקים:
//  1. אימות — *אמיתי*, לא מדומה: התמונה מועברת ל-Claude vision
//     שבודק אם זו באמת תעודת זהות/דרכון קריאים. תמונה אקראית
//     נדחית. אף פעם לא מאשרים "אומת" למשהו שאינו תעודה.
//  2. אחסון — *דמו בלבד*: התמונה נשמרת מקומית בתיקייה id-documents/
//     בדיסק, כעת *מוצפנת at-rest* (AES-256-GCM, קובץ .enc) דרך
//     idverify/crypto.js — כבר לא plaintext.
//
//  🔐 בפרודקשן — האחסון המקומי הזה חייב להתחלף באחסון מאובטח:
//     מוצפן במנוחה (at rest), הרשאות גישה מבוקרות, tokenization,
//     מדיניות שמירה/מחיקה (retention) ותאימות לחוק הגנת הפרטיות (PII).
//     ⚠️ אסור להריץ את השמירה המקומית הזו בפרודקשן עם אורחים אמיתיים.
//     ההחלפה נעשית במקום אחד בלבד (idverify/index.js) — בדיוק כמו
//     שכבת התשלום (payments/). שאר הקוד לא משתנה.
//
//  חשוב: verifyDocument לא זורק שגיאה בזרימה הרגילה. גם תקלת רשת/AI
//  מוחזרת כסטטוס ("manual_review") — כדי ששלב הזיהוי לא יפיל את
//  הצ'ק אין ולא יחזיר את האורח לתחילת התהליך.
// ════════════════════════════════════════════════════════
import fs   from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { IdProvider } from "./IdProvider.js";
import { fetchMedia, inspectIdImage } from "./vision.js";
import { encryptBuffer, isUsingDemoKey, ENC_ALGO } from "./crypto.js";
import { recordIdDocument } from "./registry.js";
import { resolveIdPolicy } from "./policy.js";
import { currentHotelId } from "../tenant.js";

const STORE_DIR = path.resolve("id-documents");
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

// ── מצב שמירה — verify-then-discard הוא ברירת המחדל התואמת-רגולציה ──
// כל רשויות הפרטיות (CNIL/AEPD/Garante/DPC + הרשות הישראלית) מתכנסות
// לאותה עמדה: *לאמת* את המסמך ולשמור רק את מה שנדרש — **לא לשמור את
// תמונת המסמך** אחרי האימות (AEPD קנסה מלון €30k על שמירת סריקה; ה-Garante
// מסמן איסוף ת"ז דרך WhatsApp כאסור). ראה SECURITY.md.
//
// ההכרעה *לכל מלון בנפרד* יושבת ב-idverify/policy.js (resolveIdPolicy):
//   • ברירת מחדל: verify-then-discard — מאמתים, מחלצים שדות, מוחקים תמונה.
//   • שמירה: רק אם למלון יש בסיס חוקי מתועד (id_policy.legal_basis) — אז
//     נשמר מוצפן עם retention ו-audit. בלי בסיס חוקי — לא נשמר.
// שים לב: *manual_review* (האימות האוטומטי נכשל) שומר את התמונה בכל מצב —
// כי אדם *חייב* לראות אותה; retention עדיין חל, והיא נמחקת אוטומטית.

// ── מדיניות: אילו מסמכים קבילים לצ'ק אין ───────────────
// אכיפה *בקוד*, לא רק ב-prompt. במלון מקבלים תעודת זהות או דרכון בלבד;
// כל סוג אחר נדחה — ראה הבדיקה למטה.
const ACCEPTED_DOC_TYPES = new Set(["id_card", "passport"]);

// הסבר אחיד לאורח כשהמסמך אינו קביל — מנוסח כאן ולא ע"י ה-AI, כדי
// שהניסוח יהיה עקבי. ⚠️ בכוונה גנרי לכל סוג: לא נוקבים בשם המסמך
// שנשלח (למשל רישיון נהיגה) — פשוט מבקשים את מה שכן מתקבל.
const NOT_ACCEPTED_REASON = {
  he: "המסמך אינו קביל לצ'ק אין — נדרשת *תעודת זהות* או *דרכון* בלבד. אשמח לצילום ברור של אחד מהם.",
  en: "That document can't be accepted for check-in — we require an *ID card* or a *passport* only. Please send a clear photo of one of them.",
};

// README שמסביר לכל מי שנתקל בתיקייה למה היא כאן ומה אסור לעשות איתה.
const README = `⚠️ מסמכי זיהוי של אורחים — אחסון דמו בלבד
================================================
התיקייה הזו נוצרת אוטומטית ע"י idverify/MockIdProvider.js ומכילה
צילומי תעודות זהות/דרכונים של אורחים (PII רגיש).

זהו אחסון *דמו*: מקומי, מוצפן at-rest (AES-256-GCM, קבצי .enc) אך
בלי בקרת גישה, בלי retention, ועם מפתח דמו אם לא הוגדר ID_ENCRYPTION_KEY.

🔐 בפרודקשן זה חייב לעבור לאחסון מאובטח ומוצפן (encrypted at rest,
   הרשאות מבוקרות, retention/מחיקה אוטומטית, תאימות לחוק הגנת הפרטיות).
   ההחלפה במקום אחד: idverify/index.js.

התיקייה ב-.gitignore — לעולם אל תעלה אותה ל-git.
`;

async function ensureStore() {
  await fs.mkdir(STORE_DIR, { recursive: true });
  const readmePath = path.join(STORE_DIR, "README.txt");
  try { await fs.access(readmePath); } catch { await fs.writeFile(readmePath, README, "utf8"); }
}

function safe(s) {
  return String(s || "").replace(/[^0-9A-Za-z]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "unknown";
}

export class MockIdProvider extends IdProvider {
  async verifyDocument({ reservationId, phone, guestName, mediaUrl, contentType, documentType } = {}) {
    const documentId = `id_${uuidv4()}`;
    const hotelId    = currentHotelId();
    const policy     = resolveIdPolicy(hotelId);   // discard-by-default, per-hotel

    // ── 1. הורדת התמונה ──────────────────────────────────
    let media;
    try {
      media = await fetchMedia(mediaUrl);
    } catch (e) {
      // לא הצלחנו למשוך את התמונה — התקלה אצלנו, לא אצל האורח. מבקשים
      // לשלוח שוב ("retry"), ולא מכריזים על אימות שלא קרה.
      console.error(`🪪 [ID] הורדת המסמך נכשלה: ${e.message}`);
      return {
        success: false, documentId: null, documentType: documentType || "id",
        status: "retry", storedPath: null,
        reasonHe: "לא הצלחתי לפתוח את התמונה. אפשר לשלוח אותה שוב?",
        reasonEn: "I couldn't open the image. Could you send it again?",
      };
    }

    const mediaType = (media.contentType || contentType || "image/jpeg").toLowerCase();

    // ── 2. בדיקה אמיתית: האם זו באמת תעודה? ─────────────
    let check;
    try {
      check = await inspectIdImage(media.buffer, EXT[mediaType] ? mediaType : "image/jpeg", { extractFields: policy.extractFields });
    } catch (e) {
      // תקלה טכנית — לא מאשרים ולא דוחים. הצ'ק אין ממשיך, והקבלה
      // (אדם) תשלים את הבדיקה. לעולם לא אומרים "אומת" בלי שנבדק.
      console.error(`🪪 [ID] בדיקת ה-AI נכשלה: ${e.message}`);
      const storedPath = await this.#store(media.buffer, mediaType, { reservationId, phone, guestName, verified: false });
      if (storedPath) recordIdDocument({
        id: documentId, hotelId, reservationId, phone, guestName,
        docType: documentType || "id", storedPath, encrypted: true, status: "manual_review",
        retentionDays: policy.retentionDays,
      });
      return {
        success: true, documentId, documentType: documentType || "id",
        status: "manual_review", storedPath,
        reasonHe: "", reasonEn: "",
      };
    }

    // ── 3. נדחה — לא תעודה / לא קריא ─────────────────────
    if (!check.valid) {
      console.log(`🪪 [ID] נדחה (isId=${check.isId}, readable=${check.readable}, conf=${check.confidence}) — לא נשמר.`);
      return {
        success: false, documentId: null, documentType: check.docType,
        status: "rejected", storedPath: null,
        isId: check.isId, readable: check.readable, confidence: check.confidence,
        reasonHe: check.reasonHe || "התמונה אינה נראית כמו תעודת זהות או דרכון.",
        reasonEn: check.reasonEn || "The image doesn't look like an ID card or passport.",
      };
    }

    // ── 3ב. תעודה אמיתית וקריאה — אך אינה קבילה במלון ────
    // רישיון נהיגה מגיע לכאן: is_id=true, readable=true. נדחה במפורש,
    // עם הסבר משלנו, ו*לא* נשמר — אין סיבה לאחסן מסמך שלא קיבלנו.
    if (!ACCEPTED_DOC_TYPES.has(check.docType)) {
      console.log(`🪪 [ID] נדחה — סוג מסמך לא קביל (${check.docType}) — לא נשמר.`);
      return {
        success: false, documentId: null, documentType: check.docType,
        status: "rejected", storedPath: null,
        isId: check.isId, readable: check.readable, confidence: check.confidence,
        reasonHe: NOT_ACCEPTED_REASON.he, reasonEn: NOT_ACCEPTED_REASON.en,
      };
    }

    // ── 4. אומת ──────────────────────────────────────────
    // verify-then-discard (ברירת המחדל): מחלצים רק את השדות הנדרשים, שומרים
    // אותם *במקום* התמונה, ומוחקים את התמונה. זו העמדה התואמת-רגולציה.
    // שמירת תמונה קורית רק אם policy.retainImage=true (בסיס חוקי מתועד).
    const discard   = !policy.retainImage;
    const fields    = check.fields || null;   // שדות מינימליים שחולצו מהמסמך
    let storedPath = null;
    if (!discard) {
      storedPath = await this.#store(media.buffer, mediaType, { reservationId, phone, guestName, verified: true, legalBasis: policy.legalBasis });
    }
    console.log(`🪪 [ID] אומת (${check.docType}, conf=${check.confidence}) → ${discard ? `התמונה לא נשמרה (verify-then-discard) — חולצו ${fields ? Object.keys(fields).length : 0} שדות` : `נשמר: ${storedPath || "—"}`}`);
    recordIdDocument({
      id: documentId, hotelId, reservationId, phone, guestName,
      docType: check.docType, storedPath, encrypted: !!storedPath,
      status: discard ? "verified_discarded" : "verified",
      fields, retentionDays: policy.retentionDays,
    });

    return {
      success: true, documentId, documentType: check.docType,
      status: "verified", storedPath, discarded: discard, fields,
      confidence: check.confidence, reasonHe: "", reasonEn: "",
    };
  }

  // שמירת התמונה + metadata לצדה.
  // 🔐 התמונה נשמרת *מוצפנת* (AES-256-GCM, קובץ .enc) — לא עוד plaintext
  //    על הדיסק. עדיין אחסון דמו מקומי (ראה README בראש הקובץ), אבל לפחות
  //    לא קריא למי שנתקל בקובץ. המפתח מגיע מ-idverify/crypto.js.
  //
  // 🏨 נקודת החיבור העתידית ל-PMS (אל תמחק): במלון אמיתי, במקום לשמור
  //    כאן, שולחים את מסמך הזיהוי ל-PMS/vault המאובטח של המלון דרך ספק
  //    אחסון חדש ב-idverify/index.js. שם הוא נשמר עם בקרת גישה, retention
  //    ותאימות לחוק. השורה למטה (fs.writeFile) היא בדיוק ה-hand-off שיוחלף.
  async #store(buffer, mediaType, meta) {
    try {
      await ensureStore();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const base  = `${stamp}__${safe(meta.reservationId || meta.phone)}__${safe(meta.guestName)}`;
      // סיומת .enc אחידה (בלי סיומת המדיה) כדי שקובץ ה-metadata (.json)
      // ליד ה-.enc יימצא ע"י אותה החלפה פשוטה: storedPath → .json.
      const encFile = path.join(STORE_DIR, `${base}.enc`);

      // 🔐 מצפינים לפני הכתיבה. (⏩ PMS hand-off point — ראה ההערה למעלה.)
      const encrypted = encryptBuffer(buffer);
      await fs.writeFile(encFile, encrypted);

      await fs.writeFile(path.join(STORE_DIR, `${base}.json`), JSON.stringify({
        ...meta,
        mediaType,
        bytes: buffer.length,
        encrypted: true,
        encryption: { algorithm: ENC_ALGO, format: "[IV 12B][authTag 16B][ciphertext]", demoKey: isUsingDemoKey() },
        storedAt: new Date().toISOString(),
        note: "DEMO STORAGE — encrypted at rest but on local disk. Production: send to the hotel's secure PMS/vault (see idverify/index.js).",
      }, null, 2), "utf8");
      return encFile;
    } catch (e) {
      // כישלון שמירה לא מפיל את הצ'ק אין — מדווח ללוג וממשיך.
      console.error(`🪪 [ID] שמירת המסמך נכשלה: ${e.message}`);
      return null;
    }
  }
}
