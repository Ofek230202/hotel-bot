// ════════════════════════════════════════════════════════
//  MockProvider — ספק תשלום מדומה
//  ----------------------------------------------------------
//  מתנהג כאילו הפיקדון נלקח ומחזיר אישור הצלחה — בלי לחייב
//  באמת ובלי לקרוא לשום ספק חיצוני. נועד לפיתוח/הדגמה עד
//  שנחבר ספק ישראלי אמיתי (CardCom) דרך אותו ממשק.
//
//  חשוב: אף פונקציה כאן לא זורקת שגיאה בזרימה הרגילה — לכן
//  שלב התשלום לא ייכשל ולא יחזיר את האורח לתחילת הצ'ק אין.
// ════════════════════════════════════════════════════════
import { v4 as uuidv4 } from "uuid";
import { PaymentProvider } from "./PaymentProvider.js";

export class MockProvider extends PaymentProvider {
  // "הרשאת" פיקדון מצליחה תמיד. redirectUrl מצביע על דף
  // האישור הפנימי של המלון, כדי לשמר את חווית "קישור → אישור".
  async authorizeDeposit({ successUrl } = {}) {
    return {
      paymentId: `mock_auth_${uuidv4()}`,
      redirectUrl: successUrl || null,
      status: "authorized",
    };
  }

  // "חיוב" מצליח תמיד ומחזיר את הסכום שביקשנו לחייב.
  async capture({ amount } = {}) {
    return { success: true, capturedAmount: amount || 0, status: "captured" };
  }

  // "ביטול" הרשאה מצליח תמיד.
  async cancel() {
    return { success: true, status: "canceled" };
  }

  // יצירת תשלום ליתרה — מחזיר קישור לדף האישור הפנימי.
  async createBalancePayment({ successUrl } = {}) {
    return {
      paymentId: `mock_balance_${uuidv4()}`,
      redirectUrl: successUrl || null,
      status: "pending",
    };
  }

  // אין חתימה אמיתית לאמת ב-Mock — פשוט מפענחים את הגוף אם קיים.
  verifyWebhook({ rawBody } = {}) {
    try {
      const event = rawBody ? JSON.parse(rawBody.toString()) : {};
      return { valid: true, event };
    } catch {
      return { valid: true, event: {} };
    }
  }
}
