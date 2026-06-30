// ════════════════════════════════════════════════════════
//  IdProvider — ממשק אחיד לכל ספק אימות מסמך זיהוי
//  ----------------------------------------------------------
//  כל ספק (MockIdProvider עכשיו, ספק אחסון מאובטח בעתיד) יורש
//  מהמחלקה הזו וממלא את הפונקציה. הקוד העסקי (bot.js / checkin)
//  מדבר אך ורק עם הממשק הזה — לעולם לא עם ספק אחסון ספציפי.
//
//  בדיוק כמו שכבת התשלום (payments/) — נקודת החלפה אחת:
//  מעבר לאחסון מאובטח אמיתי בעתיד = החלפת שורה אחת ב-index.js.
// ════════════════════════════════════════════════════════

export class IdProvider {
  /**
   * קולט תמונה של מסמך זיהוי (ת"ז / דרכון) ומאמת אותה.
   * בפרודקשן: יעלה את הקובץ לאחסון מאובטח, מוצפן ותואם חוק הגנת
   * הפרטיות, ויריץ בדיקת אותנטיות. ב-Mock: רק מאשר קבלה בלי לשמור.
   *
   * @param {object} params - { reservationId, phone, guestName,
   *                            mediaUrl, contentType, documentType }
   * @returns {Promise<{ success: boolean, documentId: string|null,
   *                     documentType: string, status: string }>}
   */
  async verifyDocument(_params) {
    throw new Error("verifyDocument not implemented");
  }
}
