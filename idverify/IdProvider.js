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
   * קולט תמונה של מסמך זיהוי (ת"ז / דרכון), מאמת שזו באמת תעודה,
   * ושומר אותה. בפרודקשן: אחסון מאובטח ומוצפן, תואם חוק הגנת הפרטיות.
   * ב-Mock: אימות אמיתי דרך Claude vision + שמירה מקומית לדמו.
   *
   * ⚠️ אסור לזרוק שגיאה בזרימה רגילה — תקלה טכנית מוחזרת כסטטוס
   *    "manual_review", כדי ששלב הזיהוי לא יפיל את הצ'ק אין.
   *
   * @param {object} params - { reservationId, phone, guestName,
   *                            mediaUrl, contentType, documentType }
   * @returns {Promise<{
   *   success: boolean,
   *   // verified      — אומת, אפשר להמשיך
   *   // rejected      — אינה תעודה / לא קריא → לבקש שוב מהאורח
   *   // retry         — תקלה טכנית אצלנו (לא הצלחנו למשוך את הקובץ) → לבקש שוב
   *   // manual_review — התקבל, אך הבדיקה האוטומטית לא זמינה → אדם ישלים
   *   status: "verified" | "rejected" | "retry" | "manual_review",
   *   documentId: string|null,
   *   documentType: string,
   *   storedPath: string|null,   // היכן נשמר המסמך (null אם לא נשמר)
   *   reasonHe: string,          // הסבר מנומס לאורח (ריק אם אין)
   *   reasonEn: string,
   * }>}
   */
  async verifyDocument(_params) {
    throw new Error("verifyDocument not implemented");
  }
}
