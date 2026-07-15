// ════════════════════════════════════════════════════════
//  MockIdProvider — אימות מסמך זיהוי (בדיקה אמיתית) + אחסון דמו
//  ----------------------------------------------------------
//  שני חלקים:
//  1. אימות — *אמיתי*, לא מדומה: התמונה מועברת ל-Claude vision
//     שבודק אם זו באמת תעודת זהות/דרכון קריאים. תמונה אקראית
//     נדחית. אף פעם לא מאשרים "אומת" למשהו שאינו תעודה.
//  2. אחסון — *דמו בלבד*: התמונה נשמרת מקומית בתיקייה id-documents/
//     בדיסק, לא מוצפנת.
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

const STORE_DIR = path.resolve("id-documents");
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

// ── מדיניות: אילו מסמכים קבילים לצ'ק אין ───────────────
// אכיפה *בקוד*, לא רק ב-prompt. בלי הרשימה הזו כל מסמך ממשלתי היה
// עובר — כולל רישיון נהיגה, שהוא באמת תעודה ממשלתית ולכן ה-AI מחזיר
// עליו is_id=true. במלון מקבלים תעודת זהות או דרכון בלבד.
const ACCEPTED_DOC_TYPES = new Set(["id_card", "passport"]);

// הסבר לאורח כשהמסמך אמיתי אך אינו קביל — מנוסח כאן ולא ע"י ה-AI,
// כדי שהניסוח יהיה עקבי ולא ישתנה בין קריאה לקריאה.
const NOT_ACCEPTED_REASON = {
  drivers_license: {
    he: "רישיון נהיגה אינו קביל לצ'ק אין — אשמח לצילום של *תעודת זהות* או *דרכון*.",
    en: "A driver's license can't be accepted for check-in — please send a photo of your *ID card* or *passport*.",
  },
  other: {
    he: "המסמך אינו קביל לצ'ק אין — אשמח לצילום של *תעודת זהות* או *דרכון*.",
    en: "That document can't be accepted for check-in — please send a photo of your *ID card* or *passport*.",
  },
};

// README שמסביר לכל מי שנתקל בתיקייה למה היא כאן ומה אסור לעשות איתה.
const README = `⚠️ מסמכי זיהוי של אורחים — אחסון דמו בלבד
================================================
התיקייה הזו נוצרת אוטומטית ע"י idverify/MockIdProvider.js ומכילה
צילומי תעודות זהות/דרכונים של אורחים (PII רגיש).

זהו אחסון *דמו*: מקומי, לא מוצפן, בלי בקרת גישה ובלי מדיניות מחיקה.

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
      check = await inspectIdImage(media.buffer, EXT[mediaType] ? mediaType : "image/jpeg");
    } catch (e) {
      // תקלה טכנית — לא מאשרים ולא דוחים. הצ'ק אין ממשיך, והקבלה
      // (אדם) תשלים את הבדיקה. לעולם לא אומרים "אומת" בלי שנבדק.
      console.error(`🪪 [ID] בדיקת ה-AI נכשלה: ${e.message}`);
      const storedPath = await this.#store(media.buffer, mediaType, { reservationId, phone, guestName, verified: false });
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
      const why = NOT_ACCEPTED_REASON[check.docType] || NOT_ACCEPTED_REASON.other;
      console.log(`🪪 [ID] נדחה — סוג מסמך לא קביל (${check.docType}) — לא נשמר.`);
      return {
        success: false, documentId: null, documentType: check.docType,
        status: "rejected", storedPath: null,
        isId: check.isId, readable: check.readable, confidence: check.confidence,
        reasonHe: why.he, reasonEn: why.en,
      };
    }

    // ── 4. אומת — שומרים (דמו: מקומי, לא מוצפן) ──────────
    const storedPath = await this.#store(media.buffer, mediaType, { reservationId, phone, guestName, verified: true });
    console.log(`🪪 [ID] אומת (${check.docType}, conf=${check.confidence}) → נשמר: ${storedPath || "—"}`);

    return {
      success: true, documentId, documentType: check.docType,
      status: "verified", storedPath,
      confidence: check.confidence, reasonHe: "", reasonEn: "",
    };
  }

  // שמירת התמונה + metadata לצדה. ⚠️ דמו בלבד — ראה README בראש הקובץ.
  async #store(buffer, mediaType, meta) {
    try {
      await ensureStore();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const base  = `${stamp}__${safe(meta.reservationId || meta.phone)}__${safe(meta.guestName)}`;
      const file  = path.join(STORE_DIR, `${base}.${EXT[mediaType] || "jpg"}`);
      await fs.writeFile(file, buffer);
      await fs.writeFile(path.join(STORE_DIR, `${base}.json`), JSON.stringify({
        ...meta,
        mediaType,
        bytes: buffer.length,
        storedAt: new Date().toISOString(),
        note: "DEMO STORAGE — unencrypted local disk. Production: encrypted secure storage (see idverify/index.js).",
      }, null, 2), "utf8");
      return file;
    } catch (e) {
      // כישלון שמירה לא מפיל את הצ'ק אין — מדווח ללוג וממשיך.
      console.error(`🪪 [ID] שמירת המסמך נכשלה: ${e.message}`);
      return null;
    }
  }
}
