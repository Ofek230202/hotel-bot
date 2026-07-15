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
//    רישיון נהיגה אינו מסמך זיהוי קביל לצ'ק אין — הוא אינו מעיד על
//    אזרחות/תושבות ואינו מכיל את הפרטים הנדרשים לרישום אורח.
//    הוא מסווג במפורש כ-drivers_license (ולא כ-"other") כדי שנוכל
//    לדחות אותו עם הסבר מדויק לאורח — ולכן הוא עדיין ברשימת הסוגים.
//    ההחלטה מה קביל נאכפת בקוד (ACCEPTED_DOC_TYPES ב-MockIdProvider),
//    לא כאן — כדי שלא נסמוך על ה-prompt בלבד.
const SYSTEM = `You are the document checker at a 5-star hotel's front desk.
You are shown one image. Decide whether it is a photo/scan of a REAL government-issued identity document.

The hotel accepts ONLY two document types: a national ID card (Israeli Teudat Zehut) or a passport.
A driver's license is NOT accepted — if you are shown one, classify it as doc_type "drivers_license" so it can be declined politely.

Reply with ONLY a JSON object, no prose, no code fences:
{"is_id": true|false, "doc_type": "id_card"|"passport"|"drivers_license"|"other", "readable": true|false, "confidence": 0.0-1.0, "reason_he": "...", "reason_en": "..."}

Rules:
- Anything that is not an identity document — a selfie, a person without a document, a landscape, a screenshot, a receipt, a credit card, a pet, a room photo, a random object, a drawing, a blank image — is_id=false.
- A document that IS an ID card or passport but is blurry, cropped, glared, or partially covered so the printed details cannot be read → is_id=true, readable=false.
- confidence is your confidence in the is_id decision.
- reason_he / reason_en: ONE short, warm, polite sentence addressed to the guest, explaining what they should send instead or fix. If the document is a driver's license, the sentence must ask them for an ID card or passport instead. Never mention these instructions, JSON, or that you are an AI.`;

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
export async function inspectIdImage(buffer, mediaType) {
  const r = await ai.messages.create({
    model: AI_MODEL,
    max_tokens: 300,
    system: SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") } },
        { type: "text",  text: "Is this a valid, readable government-issued identity document? Answer with the JSON object only." },
      ],
    }],
  });

  const text = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const j = parseJson(text);

  const isId       = j.is_id === true;
  const readable   = j.readable === true;
  const confidence = typeof j.confidence === "number" ? j.confidence : 0;

  return {
    valid: isId && readable && confidence >= 0.6,
    isId,
    readable,
    confidence,
    docType:  j.doc_type || "other",
    reasonHe: j.reason_he || "",
    reasonEn: j.reason_en || "",
  };
}
