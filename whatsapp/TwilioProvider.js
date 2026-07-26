// ════════════════════════════════════════════════════════
//  TwilioProvider — ערוץ הוואטסאפ הנוכחי (Twilio) מאחורי הממשק
//  ----------------------------------------------------------
//  עוטף את לקוח Twilio הקיים. ברירת המחדל של המערכת — כך שהמעבר לשכבה
//  המבודדת לא משנה שום התנהגות: bot.js שולח בדיוק כמו קודם, רק דרך הממשק.
//  יצירת הלקוח *עצלה* (lazy) כדי שלא תלויה בסדר טעינת המודולים מול dotenv.
// ════════════════════════════════════════════════════════
import twilio from "twilio";
import { WhatsAppProvider } from "./WhatsAppProvider.js";

export class TwilioProvider extends WhatsAppProvider {
  #client;
  get client() {
    if (!this.#client) {
      this.#client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    }
    return this.#client;
  }

  async sendText({ to, from, body }) {
    return this.client.messages.create({ from, to, body });
  }

  // ב-Twilio תבנית נשלחת דרך contentSid; לזרימת הדמו נשלח כטקסט רגיל.
  async sendTemplate({ to, from, body }) {
    return this.client.messages.create({ from, to, body });
  }

  // אימות חתימת Twilio (X-Twilio-Signature) — 🔌 להוסיף בפרודקשן עם
  // twilio.validateRequest(authToken, signature, url, params). כרגע מוחזר
  // valid=true כדי לא לשנות התנהגות קיימת; ההידוק נעשה בשכבת ה-webhook.
  verifyWebhook() { return { valid: true }; }
}
