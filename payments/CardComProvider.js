// ════════════════════════════════════════════════════════
//  CardComProvider — 🔌 נקודת חיבור לסליקה אמיתית (Part ג')
//  ----------------------------------------------------------
//  זהו ה-*scaffold* לחיבור חברת סליקה ישראלית אמיתית (CardCom),
//  ממומש מאחורי אותו ממשק בדיוק כמו MockProvider — ולכן החלפה מ-Mock
//  לספק אמיתי היא שינוי של *שורה אחת* בקונפיג המלון:
//      payment_provider: "cardcom"
//  וללא נגיעה בשום קוד עסקי (checkin.js / checkin-routes.js).
//
//  ⚠️ סטטוס: השיטות כאן זורקות `PaymentNotConnectedError` בכוונה, כדי
//     ששום מלון לא ידמיין שהסליקה עובדת עד שהחיבור האמיתי הושלם. כל
//     שיטה מתעדת *בדיוק* איזו קריאת CardCom צריך לבצע במקומה. כשמחברים
//     מלון אמיתי — ממלאים את גוף השיטות (fetch ל-API של CardCom) ומוחקים
//     את ה-throw. זה כל מה שנדרש.
//
//  ── מה CardCom נותן (למפתח שיחבר) ──────────────────────
//  CardCom הוא ספק סליקה ישראלי (עוסק/חברה בישראל). המודל:
//   • *Terminal* (מספר טרמינל) + *API Name* + *API Password* — שלושת
//     פרטי ההזדהות. מגיעים מחשבון הסוחר של המלון. נשמרים ב-
//     config.payment_credentials של אותו מלון (ולא בקוד!).
//   • *LowProfile* — עמוד סליקה מתארח (hosted) של CardCom. יוצרים אותו
//     בקריאת API, מקבלים URL, ושולחים אליו את האורח. כך פרטי הכרטיס
//     *לעולם לא עוברים דרך השרת שלנו* — זו הדרך הנכונה ל-PCI.
//   • *J2 vs J5* — J5 = הרשאה בלבד (hold, לפיקדון); J4 = חיוב מלא.
//     capture של J5 קיים בהמשך = "השלמת עסקה".
//
//  API base (ייצור): https://secure.cardcom.solutions/api/v11/
//  תיעוד: https://kb.cardcom.solutions/  (LowProfile / Transactions / Refund)
//
//  💡 אותה נקודת חיבור מתאימה לכל ספק אחר (Tranzila / PayPlus / Isracard /
//     Meshulam): מחליפים את גוף המחלקה, הממשק והקוד העסקי לא משתנים.
// ════════════════════════════════════════════════════════
import { PaymentProvider } from "./PaymentProvider.js";

export class PaymentNotConnectedError extends Error {
  constructor(op) {
    super(
      `CardCom "${op}" not connected yet — this is a wiring scaffold. ` +
      `Fill in the real CardCom API call in payments/CardComProvider.js (${op}) ` +
      `and set the hotel's payment_credentials, then remove this throw.`
    );
    this.name = "PaymentNotConnectedError";
    this.op   = op;
    this.notConnected = true;
  }
}

export class CardComProvider extends PaymentProvider {
  // credentials: { terminalNumber, apiName, apiPassword, apiBase? }
  // מגיע מ-config.payment_credentials של המלון (per-hotel). לעולם לא בקוד.
  constructor(credentials = {}) {
    super();
    this.terminalNumber = credentials.terminalNumber || null;
    this.apiName        = credentials.apiName        || null;
    this.apiPassword    = credentials.apiPassword    || null; // ⚠️ סוד — רק מ-env/DB מוצפן
    this.apiBase        = credentials.apiBase        || "https://secure.cardcom.solutions/api/v11";
  }

  // האם הספק מוגדר מלא (יש טרמינל + שם + סיסמה)? הקורא יכול לבדוק לפני
  // שהוא בוחר בו, וליפול חזרה ל-Mock אם המלון עדיין לא סיים onboarding.
  isConfigured() {
    return !!(this.terminalNumber && this.apiName && this.apiPassword);
  }

  // ── הרשאת פיקדון (J5 hold) ────────────────────────────
  // 🔌 כאן: POST {apiBase}/LowProfile/Create עם:
  //    TerminalNumber, ApiName, Operation:"ChargeOnly"/"CreateTokenOnly",
  //    Amount, ISOCoinId (ILS=1), SuccessRedirectUrl, FailedRedirectUrl,
  //    WebHookUrl (=successUrl/cancelUrl/paymentPageUrl שמגיעים כאן),
  //    ואת J-Type המתאים ל-hold (הרשאה בלי חיוב). מחזיר { LowProfileId, Url }.
  //    return { paymentId: LowProfileId, redirectUrl: Url, status: "authorized" }
  async authorizeDeposit(_params) {
    throw new PaymentNotConnectedError("authorizeDeposit");
  }

  // ── לכידת סכום מתוך ההרשאה (השלמת J5) ─────────────────
  // 🔌 כאן: POST {apiBase}/Transactions/Charge (או CompleteTransaction) עם
  //    ה-token/transactionId מההרשאה + Amount ללכידה (≤ הפיקדון).
  async capture(_params) {
    throw new PaymentNotConnectedError("capture");
  }

  // ── ביטול הרשאה (release hold) ────────────────────────
  // 🔌 כאן: POST {apiBase}/Transactions/CancelAuthorization לביטול ה-hold.
  async cancel(_params) {
    throw new PaymentNotConnectedError("cancel");
  }

  // ── חיוב נוסף מאותו כרטיס (מעל הפיקדון) ────────────────
  // 🔌 כאן: חיוב חוזר לפי ה-token שנשמר בהרשאה —
  //    POST {apiBase}/Transactions/Charge עם Token + Amount (ההפרש).
  async chargeSameCard(_params) {
    throw new PaymentNotConnectedError("chargeSameCard");
  }

  // ── תשלום יתרה בכרטיס אחר (LowProfile חדש) ─────────────
  // 🔌 כאן: LowProfile/Create חדש לסכום ההפרש; מחזיר Url להזנת כרטיס חדש.
  async createBalancePayment(_params) {
    throw new PaymentNotConnectedError("createBalancePayment");
  }

  // ── אימות webhook נכנס מ-CardCom ──────────────────────
  // 🔌 כאן: CardCom שולח עדכון עסקה. מאמתים לפי ה-terminal/token/חתימה
  //    (או שאילתת LowProfile/GetLpResult מול ה-API) ומחזירים את האירוע.
  //    אין לסמוך על גוף ה-webhook בלי אימות צד-שרת.
  verifyWebhook(_params) {
    throw new PaymentNotConnectedError("verifyWebhook");
  }
}
