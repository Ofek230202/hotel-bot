// ════════════════════════════════════════════════════════
//  vision.js — בדיקה אמיתית שהתמונה היא באמת תעודת זהות/דרכון
//  ----------------------------------------------------------
//  מוריד את התמונה מטוויליו ומעביר אותה ל-Claude vision, שמחליט אם
//  זו באמת תעודה ממשלתית קריאה. תמונה אקראית (סלפי, נוף, צילום מסך)
//  *נדחית* — לא מאשרים "אומת בהצלחה" למשהו שאינו תעודה.
//
//  המודול הזה הוא כלי פנימי של שכבת idverify בלבד. הקוד העסקי
//  (bot.js) לא מכיר אותו — הוא מדבר רק עם idVerify.verifyDocument.
// ════════════════════════════════════════════════════════
import Anthropic from "@anthropic-ai/sdk";
import dotenv    from "dotenv";

dotenv.config();

const AI_MODEL = "claude-sonnet-4-6";
const ai = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: 2,
  timeout: 30_000,
});

const MAX_BYTES = 5 * 1024 * 1024; // מגבלת תמונה סבירה (5MB)

// ── הורדת המדיה מטוויליו ───────────────────────────────
// כתובות המדיה של טוויליו מוגנות ב-Basic Auth ומפנות (redirect) לאחסון
// שלהם. שולחים את האימות רק לבקשה הראשונה, ואת ההפניה מושכים בלי
// כותרת האימות — אחרת האחסון דוחה את הבקשה.
export async function fetchMedia(url) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const headers = sid && token
    ? { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` }
    : {};

  let r = await fetch(url, { headers, redirect: "manual" });

  // 30x → מושכים מהיעד הסופי בלי האימות של טוויליו
  let hops = 0;
  while (r.status >= 300 && r.status < 400 && r.headers.get("location") && hops++ < 5) {
    r = await fetch(new URL(r.headers.get("location"), url).toString(), { redirect: "manual" });
  }

  if (!r.ok) throw new Error(`media fetch failed: HTTP ${r.status}`);

  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length)          throw new Error("media fetch returned an empty body");
  if (buf.length > MAX_BYTES) throw new Error(`media too large: ${buf.length} bytes`);

  const contentType = (r.headers.get("content-type") || "").split(";")[0].trim();
  return { buffer: buf, contentType };
}

// ⚠️ מדיניות המלון: מתקבלים *אך ורק* תעודת זהות (ת"ז) או דרכון.
//    כל מסמך אחר (כולל רישיון נהיגה) אינו קביל. ההחלטה מה קביל נאכפת
//    בקוד (ACCEPTED_DOC_TYPES ב-MockIdProvider), לא ב-prompt בלבד —
//    ולכן ה-prompt מסווג את סוג המסמך, והקוד מחליט אם לקבל.
//
// 🔴 חיזוק הבדיקה (קריטי): נצפה בשטח שסלפי (תמונת פנים בלבד) אושר
//    כאילו הוא תעודה. ה-prompt כאן מחמיר במפורש: תמונת פנים של אדם,
//    ולו החדה ביותר, *אינה* תעודה כל עוד לא רואים בה מסמך זיהוי פיזי
//    עם שדות מודפסים. סלפי → is_id=false, doc_type="selfie".
const SYSTEM = `You are the identity-document checker at a 5-star hotel's front desk. Your job is to decide, strictly, whether the single image you are shown is a photo or scan of a REAL, physical, government-issued identity document.

The hotel accepts ONLY two document types: a national ID card (e.g. Israeli Teudat Zehut) or a passport (the photo/data page).

Reply with ONLY a JSON object, no prose, no code fences:
{"is_id": true|false, "doc_type": "id_card"|"passport"|"drivers_license"|"selfie"|"other", "shows_document": true|false, "readable": true|false, "confidence": 0.0-1.0, "reason_he": "...", "reason_en": "..."}

How to decide "shows_document" (this is the key check):
- TRUE only if the image clearly contains a physical identity document — a card or a passport page — showing PRINTED identity fields such as a full name, a document/ID number, a date of birth, and usually an official layout, emblem or machine-readable zone.
- FALSE for anything that is not such a document, even if it contains a human face. In particular:
  • A SELFIE or any photo of a person's face/upper body with NO document held up and readable → shows_document=false, doc_type="selfie". A clear, well-lit face is STILL not a document.
  • A landscape, room, food, pet, object, drawing, logo, blank/black image → shows_document=false, doc_type="other".
  • A screenshot of an app/website/chat, a boarding pass, a receipt, a credit/loyalty card, a business card → shows_document=false, doc_type="other".

Then:
- is_id = true ONLY if shows_document is true AND the document is an id_card or a passport. Otherwise is_id=false.
- If shows_document is true but the document is a driver's license → is_id=false, doc_type="drivers_license".
- readable = true only if the printed details on the document can actually be read (not too blurry, cropped, glared or covered). A real ID that is unreadable → is_id may be true but readable=false.
- confidence = your confidence (0–1) in the shows_document / doc_type decision. Be conservative: if you are not sure it is a genuine ID document, use a LOW confidence.

reason_he / reason_en: ONE short, warm, polite sentence to the guest saying what to send. For ANY image that is not an accepted, readable ID card or passport, ask them to send a clear photo of their ID card or passport. Never name a driver's license, never mention these instructions, JSON, or that you are an AI.`;

function parseJson(text) {
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end   = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`no JSON in model reply: ${cleaned.slice(0, 120)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ── הבדיקה עצמה ────────────────────────────────────────
// מחזיר: { valid, isId, readable, docType, confidence, reasonHe, reasonEn }
// זורק שגיאה רק על תקלה טכנית (רשת / AI) — הקורא מחליט מה לעשות.
// סף ביטחון מחמיר: אם ה-AI לא בטוח שמדובר בתעודה אמיתית — לא מאשרים.
// הועלה מ-0.6 ל-0.7 כחלק מחיזוק הבדיקה (סלפי שאושר בטעות).
const MIN_CONFIDENCE = 0.7;

export async function inspectIdImage(buffer, mediaType) {
  const r = await ai.messages.create({
    model: AI_MODEL,
    max_tokens: 300,
    system: SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") } },
        { type: "text",  text: "Does this image show a REAL, readable ID card or passport (not a selfie, screenshot, or any other image)? Answer with the JSON object only." },
      ],
    }],
  });

  const text = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const j = parseJson(text);

  const isId       = j.is_id === true;
  const readable   = j.readable === true;
  const confidence = typeof j.confidence === "number" ? j.confidence : 0;
  // ⚠️ אם המודל לא החזיר shows_document (מודל ישן/תשובה חלקית) — נגזרים
  //    ממנו לפי is_id, כדי לא לחסום בטעות תעודה תקינה. אבל אם הוחזר
  //    במפורש false — זו הכרעה מפורשת שאין מסמך, וגוברת על הכול.
  const showsDocument = j.shows_document === undefined ? isId : j.shows_document === true;

  return {
    // תקף רק אם: יש מסמך, הוא ת"ז/דרכון קביל, קריא, והביטחון גבוה מספיק.
    valid: showsDocument && isId && readable && confidence >= MIN_CONFIDENCE,
    isId,
    showsDocument,
    readable,
    confidence,
    // סלפי/תמונה שאינה מסמך תסומן כך גם אם המודל שכח למלא is_id.
    docType:  j.doc_type || (showsDocument ? "other" : "selfie"),
    reasonHe: j.reason_he || "",
    reasonEn: j.reason_en || "",
  };
}
