// ════════════════════════════════════════════════════════
//  CloudApiProvider — 🔌 Meta WhatsApp Business Cloud API (Part ט')
//  ----------------------------------------------------------
//  מחליף את Twilio בחיבור ישיר ל-WhatsApp של Meta. מיושם *באמת* (fetch),
//  לא רק stub: ברגע שמזינים phoneNumberId + token של המלון — השליחה
//  עובדת. בלי credentials השיטות זורקות שגיאה ברורה (ולא מדמות הצלחה).
//
//  ── מה צריך כל מלון (onboarding מהיר) ─────────────────
//  1. Meta Business Account + אפליקציית Business + WhatsApp Business Account.
//  2. רישום ואימות מספר הטלפון (SMS/voice OTP) + אישור שם תצוגה.
//  3. System User token ארוך-חיים עם ההרשאות whatsapp_business_messaging
//     ו-whatsapp_business_management.
//  4. אימות עסקי (Business Verification) כדי לצאת לפרודקשן.
//  לריבוי מלונות: Embedded Signup + Tech Provider — כל מלון מחבר את ה-WABA
//  והמספר שלו בזרימה עצמית, ואנחנו מקבלים token מוגבל ל-WABA שלו. שמור
//  { hotelId, wabaId, phoneNumberId, token } לצד registerHotelNumber().
//
//  ⚠️ חלון 24 השעות: בתוך 24ש' מהודעת האורח מותר טקסט חופשי (sendText).
//     מחוץ לחלון — רק תבנית מאושרת (sendTemplate), קטגוריית Utility.
//
//  Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
// ════════════════════════════════════════════════════════
import { createHmac, timingSafeEqual } from "node:crypto";
import { WhatsAppProvider } from "./WhatsAppProvider.js";

// מנרמל מספר לוואטסאפ: ספרות בלבד עם קידומת מדינה, בלי "whatsapp:" / "+".
function toWaNumber(raw) {
  return String(raw || "").replace(/^whatsapp:/i, "").replace(/[^\d]/g, "");
}

export class CloudApiProvider extends WhatsAppProvider {
  // creds: { phoneNumberId, token, appSecret, apiVersion }
  constructor(creds = {}) {
    super();
    this.phoneNumberId = creds.phoneNumberId || null;
    this.token         = creds.token         || null;  // System User token (ארוך-חיים)
    this.appSecret     = creds.appSecret     || null;  // לאימות HMAC של webhook
    this.apiVersion    = creds.apiVersion    || "v21.0";
  }

  isConfigured() { return !!(this.phoneNumberId && this.token); }

  #endpoint() {
    return `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
  }

  async #post(payload) {
    if (!this.isConfigured()) {
      throw new Error("WhatsApp Cloud API not configured — set phoneNumberId + token for this hotel.");
    }
    const res = await fetch(this.#endpoint(), {
      method:  "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    });
    if (!res.ok) {
      throw new Error(`WhatsApp Cloud API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return res.json();
  }

  // הודעת טקסט חופשית (בתוך חלון 24 השעות).
  async sendText({ to, body }) {
    return this.#post({ to: toWaNumber(to), type: "text", text: { preview_url: false, body } });
  }

  // הודעת תבנית מאושרת (מחוץ לחלון 24 השעות). variables → components.
  async sendTemplate({ to, template, language = "he", variables = [] }) {
    const components = variables.length
      ? [{ type: "body", parameters: variables.map(v => ({ type: "text", text: String(v) })) }]
      : [];
    return this.#post({
      to: toWaNumber(to), type: "template",
      template: { name: template, language: { code: language }, components },
    });
  }

  // אימות X-Hub-Signature-256 (HMAC-SHA256 של גוף הבקשה עם app secret).
  // בלי אימות זה — כל אחד יכול לזייף webhook נכנס. מחזיר { valid }.
  verifyWebhook({ rawBody, signature }) {
    if (!this.appSecret) return { valid: false, reason: "no app secret configured" };
    if (!signature)      return { valid: false, reason: "missing signature" };
    const expected = "sha256=" + createHmac("sha256", this.appSecret)
      .update(rawBody instanceof Buffer ? rawBody : Buffer.from(String(rawBody), "utf8"))
      .digest("hex");
    try {
      const a = Buffer.from(signature);
      const b = Buffer.from(expected);
      return { valid: a.length === b.length && timingSafeEqual(a, b) };
    } catch {
      return { valid: false, reason: "signature comparison failed" };
    }
  }
}

// ── GET webhook verify handshake (Meta) ────────────────
// כשמגדירים webhook ב-Meta הוא שולח GET עם hub.challenge; מחזירים אותו
// רק אם ה-verify_token תואם. מחזיר את ה-challenge או null.
export function verifyMetaChallenge(query = {}, verifyToken) {
  if (query["hub.mode"] === "subscribe" && query["hub.verify_token"] === verifyToken) {
    return query["hub.challenge"];
  }
  return null;
}
