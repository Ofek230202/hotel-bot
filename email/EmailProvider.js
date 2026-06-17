// ════════════════════════════════════════════════════════
//  EmailProvider — ממשק אחיד לכל ספק מייל
//  ----------------------------------------------------------
//  כל ספק (MockEmailProvider עכשיו, ספק אמיתי בעתיד) יורש
//  מהמחלקה הזו וממלא את הפונקציה. הקוד העסקי (bot.js) מדבר
//  אך ורק עם הממשק הזה — לעולם לא עם ספק מייל ספציפי.
// ════════════════════════════════════════════════════════

export class EmailProvider {
  /**
   * שולח מייל למחלקה / נמען.
   * @param {object} params - { to, subject, body, dept, priority, meta }
   * @returns {Promise<{ success: boolean, to: string, messageId: string, status: string }>}
   */
  async send(_params) {
    throw new Error("send not implemented");
  }
}
