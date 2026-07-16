// ════════════════════════════════════════════════════════
//  ConciergeProvider — ממשק אחיד לביצוע בקשות קונסיירז'
//  ----------------------------------------------------------
//  כל ספק (MockConciergeProvider עכשיו, ספקים אמיתיים בעתיד)
//  יורש מהמחלקה הזו וממלא את הפונקציה. הקוד העסקי (bot.js) מדבר
//  אך ורק עם הממשק הזה — לעולם לא עם ספק/API ספציפי.
//
//  אותו כלל שחל על התשלומים חל גם כאן: מעבר לשירות אמיתי נוגע
//  במקום אחד בלבד — concierge/index.js.
// ════════════════════════════════════════════════════════

// סוגי הבקשות שהקונסיירז' יודע לקבל. הסוג נגזר מהתג שה-AI מחזיר
// ומהתיאור שלו, והוא זה שיקבע בעתיד לאיזה ספק הבקשה נשלחת.
export const REQUEST_TYPES = Object.freeze({
  TAXI:       "taxi",         // → עתידי: API של גט/יאנגו, או מוקד ההסעות של המלון
  RESTAURANT: "restaurant",   // → עתידי: Tabit / OpenTable / טלפון למסעדה
  SPA:        "spa",          // → עתידי: מערכת הזמנות הספא (לרוב חלק מה-PMS)
  TOUR:       "tour",         // → עתידי: ספק הסיורים החיצוני של המלון
  TRANSFER:   "transfer",     // → עתידי: חברת ההסעות (נתב"ג וכו')
  RENTAL:     "rental",       // → עתידי: השכרת רכב/ציוד
  GIFT:       "gift",         // → עתידי: פרחים/עוגה — ספק חיצוני או המטבח
  OTHER:      "other",        // כל בקשה מיוחדת אחרת → הקונסיירז' האנושי
});

export class ConciergeProvider {
  /**
   * מגיש בקשת קונסיירז' לביצוע.
   * @param {object} params - { type, details, guestName, roomNumber, phone, lang }
   * @returns {Promise<{ success: boolean, reference: string, status: string, provider: string }>}
   *   status: "received"  — הבקשה נקלטה וממתינה לטיפול אנושי (המצב במוק)
   *           "confirmed" — הבקשה אושרה מול הספק בפועל (עתידי)
   *           "failed"    — לא ניתן היה להגיש
   */
  async submitRequest(_params) {
    throw new Error("submitRequest not implemented");
  }
}
