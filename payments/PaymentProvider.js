// ════════════════════════════════════════════════════════
//  PaymentProvider — ממשק אחיד לכל ספק תשלום
//  ----------------------------------------------------------
//  כל ספק (MockProvider עכשיו, CardComProvider בעתיד) יורש
//  מהמחלקה הזו וממלא את הפונקציות. הקוד העסקי (checkin.js)
//  מדבר אך ורק עם הממשק הזה — לעולם לא עם ספק תשלום ספציפי.
// ════════════════════════════════════════════════════════

export class PaymentProvider {
  /**
   * יוצר הרשאת פיקדון (pre-authorization) — "תופס" סכום בלי לחייב בפועל.
   * @param {object} params - { reservationId, amount, currency, guestName,
   *                            phone, description, successUrl, cancelUrl }
   * @returns {Promise<{ paymentId: string, redirectUrl: string|null, status: string }>}
   */
  async authorizeDeposit(_params) {
    throw new Error("authorizeDeposit not implemented");
  }

  /**
   * מחייב סכום מתוך הרשאה קיימת (סכום ≤ הפיקדון).
   * @param {object} params - { paymentId, amount }
   * @returns {Promise<{ success: boolean, capturedAmount: number, status: string }>}
   */
  async capture(_params) {
    throw new Error("capture not implemented");
  }

  /**
   * מבטל הרשאה — האורח לא מחויב בכלום.
   * @param {object} params - { paymentId }
   * @returns {Promise<{ success: boolean, status: string }>}
   */
  async cancel(_params) {
    throw new Error("cancel not implemented");
  }

  /**
   * יוצר תשלום חדש ליתרה (כשהחיובים עולים על הפיקדון).
   * @param {object} params - { reservationId, amount, currency, description,
   *                            successUrl, cancelUrl }
   * @returns {Promise<{ paymentId: string, redirectUrl: string|null, status: string }>}
   */
  async createBalancePayment(_params) {
    throw new Error("createBalancePayment not implemented");
  }

  /**
   * מאמת webhook נכנס מהספק ומחזיר את האירוע המפוענח.
   * @param {object} params - { rawBody, signature }
   * @returns {{ valid: boolean, event: object }}
   */
  verifyWebhook(_params) {
    throw new Error("verifyWebhook not implemented");
  }
}
