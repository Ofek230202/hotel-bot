// ════════════════════════════════════════════════════════
//  WhatsAppProvider — ממשק אחיד לשליחת וואטסאפ (Part ט')
//  ----------------------------------------------------------
//  מבודד את *ערוץ התחבורה* בדיוק כמו payments/ ו-invoices/: כל שאר
//  הקוד (bot.js → wa) מדבר עם הממשק הזה בלבד, ולא יודע אם מאחוריו
//  Twilio או Meta WhatsApp Cloud API. מעבר מ-Twilio ל-Meta (או חיבור
//  מספר משלו לכל מלון) = החלפה במקום אחד: whatsapp/index.js.
//
//  הפרדת האחריות: הכנת ההודעה (ניקוי תגים, פיצול לאורך, גיבוי) נשארת
//  ב-wa(); כאן רק *השליחה בפועל* של מקטע מוכן.
// ════════════════════════════════════════════════════════

export class WhatsAppProvider {
  /** שולח הודעת טקסט חופשית (בתוך חלון 24 השעות של שירות לקוחות). */
  async sendText(_params) { throw new Error("sendText not implemented"); }

  /** שולח הודעת תבנית מאושרת (מחוץ לחלון 24 השעות — Meta templates). */
  async sendTemplate(_params) { throw new Error("sendTemplate not implemented"); }

  /** מאמת webhook נכנס ומחזיר { valid, ... }. */
  verifyWebhook(_params) { throw new Error("verifyWebhook not implemented"); }
}
