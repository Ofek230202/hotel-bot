// ════════════════════════════════════════════════════════
//  HttpEmailProvider — שליחת מייל אמיתית דרך HTTP API
//  ----------------------------------------------------------
//  🔴 מוכן לפרודקשן: שולח מייל *אמיתי* למחלקות (משק בית/אחזקה/קבלה…)
//     דרך ה-REST API של Resend או SendGrid — בלי תלות npm חדשה (fetch
//     מובנה ב-Node). מופעל ברגע שמזינים מפתח:
//        EMAIL_PROVIDER=resend|sendgrid
//        EMAIL_API_KEY=...          (מפתח ה-API)
//        EMAIL_FROM="StayBot <alerts@yourhotel.com>"
//     בלי מפתח — index.js נופל אוטומטית ל-Mock (עם אזהרה בעלייה).
//
//  ⚠️ לעולם לא זורק בזרימה הרגילה: שליחת מייל שנכשלת לא מפילה ניתוב
//     מחלקה או הסלמת חירום — מחזירה { success:false } ונרשמת ללוג.
//     (ההתראה עדיין יוצאת בוואטסאפ, ולכן המחלקה מקבלת אותה בכל מקרה.)
//
//  💡 אותה שכבה מתאימה לכל ספק: SMTP (nodemailer), Mailgun, Postmark —
//     מוסיפים ענף ל-send() או מחליפים ב-index.js. נקודת החלפה אחת.
// ════════════════════════════════════════════════════════
import { v4 as uuidv4 } from "uuid";
import { EmailProvider } from "./EmailProvider.js";

// timeout קשיח לשליחת המייל — שירות איטי לא יתקע ניתוב מחלקה.
async function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("email timeout")), ms)),
  ]);
}

export class HttpEmailProvider extends EmailProvider {
  // config: { provider: "resend"|"sendgrid", apiKey, from }
  constructor({ provider = "resend", apiKey = null, from = null } = {}) {
    super();
    this.provider = String(provider).toLowerCase();
    this.apiKey   = apiKey;
    this.from     = from || "StayBot <onboarding@resend.dev>";
  }

  isConfigured() { return !!this.apiKey; }

  async send({ to, subject, body, dept, priority } = {}) {
    if (!to) return { success: false, to: null, messageId: null, status: "no_recipient" };
    if (!this.isConfigured()) {
      return { success: false, to, messageId: null, status: "not_configured" };
    }
    // גוף המייל: טקסט פשוט (ההתראות שלנו הן טקסט וואטסאפ-נקי) + HTML קליל.
    const text = String(body || "");
    const html = `<pre style="font-family:system-ui,Arial,sans-serif;font-size:14px;white-space:pre-wrap">${
      text.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))
    }</pre>`;

    try {
      if (this.provider === "sendgrid") {
        await withTimeout(this.#sendGrid({ to, subject, text, html }), 12_000);
      } else {
        await withTimeout(this.#resend({ to, subject, text, html }), 12_000);
      }
      return { success: true, to, messageId: `http_email_${uuidv4()}`, status: "sent" };
    } catch (e) {
      // לא מפיל — ההתראה כבר יצאה בוואטסאפ. רק רושם.
      console.error(`📧 שליחת מייל ל-${to} (${dept || "—"}) נכשלה: ${e?.message || e}`);
      return { success: false, to, messageId: null, status: "error", error: e?.message };
    }
  }

  // ── Resend (https://resend.com) ──────────────────────
  async #resend({ to, subject, text, html }) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [to], subject: subject || "StayBot", text, html }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  // ── SendGrid (https://sendgrid.com) ──────────────────
  async #sendGrid({ to, subject, text, html }) {
    // from של SendGrid חייב להיות אימייל בלבד (בלי "Name <...>").
    const fromEmail = (this.from.match(/<([^>]+)>/)?.[1] || this.from).trim();
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromEmail },
        subject: subject || "StayBot",
        content: [{ type: "text/plain", value: text }, { type: "text/html", value: html }],
      }),
    });
    if (!res.ok) throw new Error(`SendGrid ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}
