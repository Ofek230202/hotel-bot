// ════════════════════════════════════════════════════════
//  PAYMENT VENDORS — רישום חברות הסליקה שמלונות בישראל עובדים איתן
//  ----------------------------------------------------------
//  אותו רעיון בדיוק כמו `pms/vendors.js`, ומאותה סיבה: שמונה מחלקות
//  כמעט-זהות הן שמונה מקומות לתקן כשמשהו משתנה, ושמונה הזדמנויות לשכוח
//  אחד. כאן כל ספק הוא **מפרט (spec)**, ו-`RestPaymentProvider` הגנרי
//  מריץ אותו. הוספת חברת סליקה = אובייקט בקובץ הזה.
//
//  ── מה השכבה הזו באמת פותרת ────────────────────────────
//  השאלה הראשונה שמלון שואל היא "עם מי אתם עובדים?", והתשובה חייבת
//  להיות "עם מי שאתם כבר עובדים". מלון לא מחליף חברת סליקה בשביל בוט.
//  לכן המטרה כאן אינה לממש שמונה אינטגרציות מלאות מראש — אלא ש**ביום
//  שהמלון יגיד "אנחנו עם טרנזילה"**, החיבור יהיה שינוי קונפיג ולא פרויקט.
//
//  ── ⚠️ אמינות: מה מסומן `verified` ומה לא ──────────────
//  🔴 **הכלל שנשמר כאן בקפדנות: לא ממציאים endpoints ומתייגים אותם
//     כעובדה.** זו אותה משמעת שכבר נכתבה ב-`pms/vendors.js`, והיא
//     חשובה כאן פי כמה — כי כאן מדובר בכסף.
//
//   • `verified: true`  — המבנה אומת מול תיעוד הספק, ויש מימוש בפועל.
//                          כרגע: **CardCom בלבד** (`CardComProvider`).
//   • `verified: false` — הספק **קיים ונפוץ**, והמפרט כאן הוא שלד
//                          עבודה: נתיבים גנריים סבירים + רשימת מה
//                          לבקש מהמלון. **כל** שדה ניתן לדריסה דרך
//                          `payment_credentials`, ולכן ברגע שמגיע
//                          המסמך מהספק — ההפעלה היא קונפיג, בלי קוד.
//
//  🔴 **ולעולם לא מחייבים בפועל דרך ספק שאינו `verified`.** ספק לא
//     מאומת נופל ל-Mock עם אזהרה רועשת (ראה `paymentsFor`). חיוב אמיתי
//     דרך נתיב מנוחש הוא בדיוק הדבר שאסור שיקרה עם כרטיס של אורח.
//
//  ── J5 — המונח שכל שכבת הפיקדון עומדת עליו ─────────────
//  ✅ **המפרט הלאומי של שב"א (Ashrait) נוקב במלונות במפורש** כמקרה
//     השימוש של J5:
//       *"(J5) בקשה לאישור ללא עסקה — אופציה זו נועדה לעסקים כגון:
//        חברות להשכרת רכב, **בתי מלון** וכד'… העסקה תבוצע בשלב מאוחר
//        יותר כאשר ידוע סכום העסקה המדויק (בעסקת השלמה)."*
//     כלומר `authorizeDeposit` → `capture` אינו דפוס שהמצאנו — הוא
//     הדפוס המאושר ברמת המתג הלאומי.
//
//  🔴 **תיקון מינוח: "J4" אינו קיים בשכבת הפרוטוקול.** ערכי `parameterJ`
//     של שב"א הם 2, 5, 6, 49 — וחיוב רגיל נשלח **בלי פרמטר J כלל**.
//     "J4" הוא אוצר מילים של *שערי הסליקה* ל"התנהגות ברירת המחדל".
//     לא לבקש מספק "תמיכה ב-J4"; לבקש **לכידה (capture) של J5**.
//
//  🔴 **וזו הנקודה שתיראה כבאג ב-2 בלילה בהדגמה:** J5 אינו דגל בקוד
//     אלא **הרשאה מול חברות האשראי** — *"עבודה כזאת מתאפשרת רק לאחר
//     קבלת אישורים מחברות האשראי"*. טרמינל שאינו מאושר מחזיר שגיאה
//     **349** ("אין הרשאה מתאימה… J5") או **044**. זו בעיה של חשבון
//     הסוחר, לא של הקוד — ולכן `j5Approved` הוא שדה onboarding מפורש
//     (ראה `vendorReadiness`), ולא הנחה שקטה.
//
//  ⚠️ **אין להניח זהות בין קודי J בין שערים שונים.** Ashrait ו-CreditGuard
//     מתארים J2 כמקומי בלבד; אצל ספקים אחרים ההתנהגות שונה. לאמת פר-ספק.
// ════════════════════════════════════════════════════════

// קיצור ליצירת שדה credential (מה בדיוק לבקש מהמלון).
const f = (key, labelHe, { required = true, secret = false, example = "", helpHe = "" } = {}) =>
  ({ key, labelHe, required, secret, example, helpHe });

// יכולות אפשריות של ספק סליקה.
export const PAY_CAPS = Object.freeze({
  AUTHORIZE:   "authorize",       // J5 — הקפאת פיקדון בלי חיוב
  CAPTURE:     "capture",         // לכידת הקפאה קיימת
  CANCEL:      "cancel",          // ביטול הקפאה
  CHARGE:      "charge",          // חיוב ישיר (J4)
  TOKENIZE:    "tokenize",        // שמירת אמצעי תשלום לחיוב חוזר
  CHARGE_TOKEN:"charge_token",    // חיוב לפי טוקן שמור (ההפרש בצ'ק אאוט)
  REFUND:      "refund",          // זיכוי
  HOSTED_PAGE: "hosted_page",     // עמוד סליקה מתארח — פרטי הכרטיס לא עוברים אצלנו
  WEBHOOK:     "webhook",         // callback אסינכרוני
  INVOICE:     "invoice",         // הפקת חשבונית מס דרך אותו ספק
});

const C = PAY_CAPS;

// סט יכולות אופייני לחברת סליקה ישראלית מלאה.
const ISRAELI_FULL = [C.AUTHORIZE, C.CAPTURE, C.CANCEL, C.CHARGE, C.TOKENIZE,
                      C.CHARGE_TOKEN, C.REFUND, C.HOSTED_PAGE, C.WEBHOOK];

export const PAYMENT_VENDORS = Object.freeze({

  // ══ ישראל — הנפוצות במלונאות ═════════════════════════

  cardcom: {
    id: "cardcom", label: "CardCom", labelHe: "קארדקום",
    region: "ישראל",
    marketHe: "מהנפוצות בישראל, כולל מלונאות. API מתועד וברור, עמוד סליקה מתארח (LowProfile), " +
              "ואינטגרציה מובנית להפקת חשבונית מס — מה שהופך אותה לבחירה נוחה למלון קטן־בינוני.",
    docsUrl: "https://secure.cardcom.solutions/Api/v11/Docs",
    // 🔴 הספק היחיד עם מימוש אמיתי ומאומת מול התיעוד.
    verified: true,
    dedicated: "CardComProvider",
    capabilities: [...ISRAELI_FULL, C.INVOICE],
    credentialFields: [
      f("terminalNumber", "מספר טרמינל", { example: "1000" }),
      f("apiName", "שם משתמש API (ApiName)"),
      f("apiPassword", "סיסמת API", { required: false, secret: true, helpHe: "נדרשת לזיכויים ולהפקת מסמכים" }),
      f("operation", "סוג פעולה", { required: false, example: "ChargeAndCreateToken",
        helpHe: "ל**פיקדון** אמיתי בהקפאה יש להגדיר SuspendedDeal מול קארדקום" }),
    ],
    accessHe: "המלון פותח פנייה לקארדקום ומבקש **הרשאות API v11** לטרמינל שלו. " +
              "מקבלים TerminalNumber + ApiName (וסיסמת API לזיכויים).",
    warnHe: "🔴 קארדקום מחזירה **HTTP 200 גם על כשל** — ההבחנה היא ResponseCode ≠ 0. " +
            "בנוסף, אימות webhook חייב להיות שאילתה חוזרת (GetLpResult) ולא אמון בגוף ה-POST.",
  },

  tranzila: {
    id: "tranzila", label: "Tranzila", labelHe: "טרנזילה",
    region: "ישראל",
    marketHe: "מהוותיקות והנפוצות בישראל, עם נוכחות משמעותית בעסקים גדולים ובמלונאות. " +
              "תומכת בעמוד סליקה מתארח (iframe) ובטוקניזציה.",
    docsUrl: "https://docs.tranzila.com/",
    verified: false,
    capabilities: ISRAELI_FULL,
    // נתיבים גנריים סבירים — **נדרסים** ע"י המסמך שהמלון יקבל.
    baseUrl: "https://secure5.tranzila.com",
    auth: { style: "form_terminal" },   // terminal (supplier) + סיסמה/טוקן בגוף הבקשה
    paths: {
      charge:      "/cgi-bin/tranzila71u.cgi",
      hostedPage:  "/{supplier}/iframenew.php",
      refund:      "/cgi-bin/tranzila71u.cgi",
    },
    credentialFields: [
      f("supplier", "שם מסוף (supplier / terminal)", { example: "myhotel" }),
      f("password", "סיסמת מסוף / TranzilaPW", { secret: true }),
      f("terminalPassword", "סיסמת טרמינל לזיכויים", { required: false, secret: true }),
    ],
    accessHe: "המלון פונה לטרנזילה ומבקש פרטי **מסוף (supplier)** והרשאות API, " +
              "כולל הרשאה ל**עסקת J5** (הקפאה) אם רוצים פיקדון אמיתי.",
    warnHe: "⚠️ הנתיבים והפרמטרים כאן הם שלד ולא אומתו מול התיעוד. " +
            "לפני חיוב אמיתי — לאמת מול המסמך שהמלון מקבל, ולעדכן דרך payment_credentials.",
  },

  pelecard: {
    id: "pelecard", label: "Pelecard", labelHe: "פלאקארד",
    region: "ישראל",
    marketHe: "חברת סליקה ישראלית ותיקה, נפוצה ברשתות ובעסקים גדולים — כולל מלונות. " +
              "מציעה עמוד סליקה מתארח ו-API לחיוב/זיכוי.",
    docsUrl: "https://developer.pelecard.biz/",
    verified: false,
    capabilities: ISRAELI_FULL,
    baseUrl: "https://gateway21.pelecard.biz",
    auth: { style: "json_terminal" },   // terminal + user + password ב-JSON
    paths: {
      hostedPage: "/services/quickAdmin",
      charge:     "/services/DebitRegularType",
      authorize:  "/services/AuthorizeCreditCard",
      capture:    "/services/ConfirmDebit",
      refund:     "/services/RefundByPelecardTransactionId",
    },
    credentialFields: [
      f("terminalNumber", "מספר טרמינל"),
      f("user", "שם משתמש API"),
      f("password", "סיסמה", { secret: true }),
      f("shopNumber", "מספר חנות", { required: false, example: "001" }),
    ],
    accessHe: "המלון מבקש מפלאקארד **הרשאות API** ומספר טרמינל, ולציין במפורש " +
              "שנדרשת **הקפאה (J5)** לפיקדון ביטחון.",
    warnHe: "⚠️ הנתיבים כאן הם שלד ולא אומתו מול התיעוד.",
  },

  yaad: {
    id: "yaad", label: "Yaad Sarig", labelHe: "יעד שריג",
    region: "ישראל",
    marketHe: "חברת סליקה ישראלית ותיקה, נפוצה בעסקים קטנים־בינוניים ובבתי מלון קטנים ובוטיק.",
    docsUrl: "https://www.yaad.net/",
    verified: false,
    capabilities: [C.CHARGE, C.TOKENIZE, C.CHARGE_TOKEN, C.REFUND, C.HOSTED_PAGE, C.WEBHOOK],
    baseUrl: "https://icom.yaad.net",
    auth: { style: "query_masof" },     // Masof (מסוף) + PassP בפרמטרים
    paths: {
      hostedPage: "/p/",
      charge:     "/p/",
      refund:     "/p/",
    },
    credentialFields: [
      f("masof", "מספר מסוף (Masof)", { example: "0010131918" }),
      f("passP", "סיסמת API (PassP)", { secret: true }),
      f("apiKey", "מפתח API", { required: false, secret: true }),
    ],
    accessHe: "המלון מקבל מיעד **מספר מסוף (Masof)** וסיסמת API.",
    warnHe: "⚠️ שלד לא מאומת. יש לוודא מול יעד האם הטרמינל תומך ב**הקפאה** — " +
            "אם לא, פיקדון יתבצע כחיוב מלא + זיכוי, וזו חוויה שונה לחלוטין לאורח.",
  },

  payplus: {
    id: "payplus", label: "PayPlus", labelHe: "פייפלוס",
    region: "ישראל",
    marketHe: "ספק ישראלי מודרני יחסית, API בסגנון REST/JSON וחוויית מפתחים טובה. " +
              "פופולרי בעסקים דיגיטליים ובמלונות קטנים.",
    docsUrl: "https://restapidev.payplus.co.il/",
    verified: false,
    capabilities: ISRAELI_FULL,
    baseUrl: "https://restapi.payplus.co.il/api/v1.0",
    auth: { style: "api_key_header" },
    paths: {
      hostedPage: "/PaymentPages/generateLink",
      charge:     "/Transactions/Charge",
      authorize:  "/Transactions/Approval",
      capture:    "/Transactions/Capture",
      refund:      "/Transactions/RefundByTransactionUID",
      chargeToken: "/Transactions/ChargeByToken",
    },
    credentialFields: [
      f("apiKey", "API Key", { secret: true }),
      f("secretKey", "Secret Key", { secret: true }),
      f("pageUid", "מזהה עמוד תשלום (Payment Page UID)", { required: false }),
    ],
    accessHe: "המלון נרשם ב-PayPlus ומקבל **API Key + Secret Key** מאזור המפתחים.",
    warnHe: "⚠️ שלד לא מאומת מול התיעוד.",
  },

  meshulam: {
    id: "meshulam", label: "Meshulam / Grow", labelHe: "משולם (Grow)",
    region: "ישראל",
    marketHe: "פלטפורמת תשלומים ישראלית (כיום תחת המותג Grow), נפוצה בעסקים קטנים " +
              "ובאתרי מסחר. פחות נפוצה במלונות גדולים.",
    docsUrl: "https://grow.business/",
    verified: false,
    capabilities: [C.CHARGE, C.TOKENIZE, C.CHARGE_TOKEN, C.REFUND, C.HOSTED_PAGE, C.WEBHOOK],
    baseUrl: "https://sandbox.meshulam.co.il/api/light/server/1.0",
    auth: { style: "form_user_key" },
    paths: {
      hostedPage: "/createPaymentProcess",
      charge:     "/createPaymentProcess",
      refund:     "/refundTransaction",
    },
    credentialFields: [
      f("userId", "מזהה משתמש (userId)"),
      f("apiKey", "מפתח API (pageCode / apiKey)", { secret: true }),
    ],
    accessHe: "נרשמים ב-Grow/משולם ומקבלים userId + מפתח API מאזור הניהול.",
    warnHe: "⚠️ שלד לא מאומת. תמיכה בהקפאה (J5) אינה מובטחת — יש לוודא מול הספק.",
  },

  hyp: {
    id: "hyp", label: "HYP / CreditGuard", labelHe: "היפ (קרדיטגארד)",
    region: "ישראל",
    marketHe: "CreditGuard, בבעלות Max מ-2020. **מחזור החיים המתועד ביותר של הקפאה** " +
              "מכל השערים שנבדקו — כולל פרימיטיב שחרור. זמין ב-Optima דרך Channel.",
    docsUrl: "https://www.creditguard.co.il/",
    verified: false,
    capabilities: ISRAELI_FULL,
    auth: { style: "xml_terminal" },
    // 🔴 המפרט של CreditGuard הוא ה-artifact הראשוני הטוב ביותר שנמצא:
    //    יש בו enum שמסומן במפורש "J Code" —
    //      Verify=J5 (הקפאה) · AutoComm=J4 (לכידה) · AutoCommRelease=J109
    //      (שחרור) · Token=J102. התיעוד קובע: "in a two-phase sale, J5
    //      followed by J4". J109 הוא התשובה החלקית היחידה שנמצאה לשאלת
    //      השחרור — אך הוא מתועד לשחרור J9, לא במפורש ל-J5. לאמת מול הספק.
    paths: { charge: "/xpo/Relay", hostedPage: "/xpo/Relay" },
    credentialFields: [
      f("terminalNumber", "מספר טרמינל"),
      f("mid", "מספר סוחר (MID)"),
      f("username", "שם משתמש"),
      f("password", "סיסמה", { secret: true }),
    ],
    accessHe: "דרך HYP/Max — המלון מבקש הרשאות ל-EMV XML API ומספר טרמינל.",
    warnHe: "⚠️ שלד לא מאומת. **לשאול במפורש** האם `AutoCommRelease` (J109) " +
            "משחרר גם הקפאת J5 — זו השאלה הפתוחה החשובה ביותר בכל השכבה.",
  },

  payme: {
    id: "payme", label: "PayMe", labelHe: "פיימי",
    region: "ישראל",
    marketHe: "ספק ישראלי, מופיע ברשימת האינטגרציות של Optima — ולכן רלוונטי " +
              "למלון שכבר עובד עם אופטימה.",
    docsUrl: "https://www.payme.io/",
    verified: false,
    capabilities: [C.CHARGE, C.TOKENIZE, C.CHARGE_TOKEN, C.REFUND, C.HOSTED_PAGE, C.WEBHOOK],
    credentialFields: [
      f("sellerKey", "Seller Key", { secret: true }),
      f("apiKey", "API Key", { required: false, secret: true }),
    ],
    accessHe: "נרשמים ב-PayMe ומקבלים Seller Key מאזור הניהול.",
    warnHe: "⚠️ שלד לא מאומת, ולא נבדק לעומק. תמיכה ב-J5 לא אומתה.",
  },

  // ══ בינלאומי — רשתות ומלונות עם חברת אם בחו"ל ═════════

  stripe: {
    id: "stripe", label: "Stripe", labelHe: "סטרייפ",
    region: "בינלאומי",
    marketHe: "ספק בינלאומי מוביל. רלוונטי בעיקר לרשתות בינלאומיות עם ישות משפטית בחו\"ל. " +
              "תומך היטב ב-authorize/capture ובטוקניזציה.",
    docsUrl: "https://docs.stripe.com/api",
    verified: false,
    capabilities: [...ISRAELI_FULL],
    baseUrl: "https://api.stripe.com/v1",
    auth: { style: "bearer" },
    paths: {
      authorize: "/payment_intents",
      capture:   "/payment_intents/{id}/capture",
      cancel:    "/payment_intents/{id}/cancel",
      charge:    "/payment_intents",
      refund:    "/refunds",
    },
    credentialFields: [
      f("secretKey", "Secret Key", { secret: true, example: "sk_live_…" }),
      f("webhookSecret", "Webhook Signing Secret", { required: false, secret: true }),
    ],
    accessHe: "חשבון Stripe של הישות המשפטית שמפעילה את המלון.",
    // ⚠️ זו הסיבה ש-Stripe הוסר מהפרויקט מלכתחילה (§5).
    warnHe: "🔴 **זמינות בישראל מוגבלת** — זו הסיבה שהפרויקט עבר לסליקה ישראלית מלכתחילה. " +
            "רלוונטי רק לישות משפטית בחו\"ל. יש לאמת זמינות לפני הבטחה למלון.",
  },

  adyen: {
    id: "adyen", label: "Adyen", labelHe: "איידיאן",
    region: "בינלאומי",
    marketHe: "ספק ארגוני בינלאומי, נפוץ ברשתות מלונות גדולות (בעיקר בינלאומיות).",
    docsUrl: "https://docs.adyen.com/api-explorer/",
    verified: false,
    capabilities: ISRAELI_FULL,
    baseUrl: "https://checkout-test.adyen.com/v71",
    auth: { style: "api_key_header" },
    paths: {
      authorize: "/payments",
      capture:   "/payments/{id}/captures",
      cancel:    "/payments/{id}/cancels",
      refund:    "/payments/{id}/refunds",
    },
    credentialFields: [
      f("apiKey", "API Key", { secret: true }),
      f("merchantAccount", "Merchant Account"),
    ],
    accessHe: "דרך מנהל החשבון של הרשת ב-Adyen.",
    warnHe: "⚠️ שלד לא מאומת. onboarding ארגוני ארוך.",
  },
});

/** רשימת המזהים של כל הספקים. */
export const PAYMENT_VENDOR_IDS = Object.freeze(Object.keys(PAYMENT_VENDORS));

/** ספק לפי מזהה (case-insensitive). */
export function paymentVendor(id) {
  return PAYMENT_VENDORS[String(id || "").toLowerCase().trim()] || null;
}

/**
 * האם מותר לחייב **באמת** דרך הספק הזה.
 * 🔴 רק ספק `verified` עם מימוש ייעודי. ספק שלד — לעולם לא נוגע בכרטיס
 *    של אורח: הוא נופל ל-Mock עם אזהרה. ראה paymentsFor ב-index.js.
 */
export function canChargeLive(id) {
  const v = paymentVendor(id);
  return !!(v && v.verified && v.dedicated);
}

/**
 * מה בדיוק לבקש מהמלון כדי לחבר את הספק — לשימוש ב-onboarding ובדשבורד.
 */
export function vendorReadiness(id, credentials = {}) {
  const v = paymentVendor(id);
  if (!v) return { ok: false, reason: "unknown_vendor", vendor: null };
  const missing = (v.credentialFields || [])
    .filter(fld => fld.required && !credentials[fld.key])
    .map(fld => ({ key: fld.key, labelHe: fld.labelHe, example: fld.example }));

  // ── הרשאת J5 — התנאי המוקדם שאינו קוד ─────────────────
  // 🔴 טרמינל שלא אושר להקפאה מחזיר שגיאה 349/044 ברגע הראשון של הפיקדון.
  //    זה ייראה כבאג בהדגמה, ויתברר כבעיה של חשבון הסוחר. לכן זה נשאל
  //    **מראש** ומופיע בצ'קליסט לצד פרטי העוסק — ולא מתגלה בשטח.
  const supportsHold = (v.capabilities || []).includes(C.AUTHORIZE);
  const j5 = credentials.j5Approved;
  const holdWarnings = [];
  if (supportsHold && j5 === undefined) {
    holdWarnings.push(
      "❓ לא ידוע אם הטרמינל של המלון **מאושר ל-J5 (הקפאה)**. זו הרשאה מול " +
      "חברות האשראי, לא הגדרה אצלנו — בלעדיה הפיקדון יחזיר שגיאה 349/044. " +
      "יש לשאול את המלון: \"האם הטרמינל מאושר לעסקת J5 / אישור ללא עסקה?\""
    );
  }
  if (j5 === false) {
    holdWarnings.push(
      "⚠️ הטרמינל **אינו מאושר ל-J5** — הפיקדון יתבצע כחיוב מלא + זיכוי. " +
      "ההסבר לאורח משתנה בהתאם אוטומטית (ראה depositExplainer)."
    );
  }

  return {
    ok: missing.length === 0,
    vendor: v.id, labelHe: v.labelHe,
    verified: !!v.verified,
    canChargeLive: canChargeLive(id),
    missing,
    supportsHold,
    j5Approved: j5 ?? null,
    holdWarnings,
    // 🔴 משך ההקפאה **אינו קבוע של השער** — הוא נסגר פר-סוחר מול הרוכש
    //    ותלוי MCC (מלונות: 7011). לכן קונפיג, ולא מספר בקוד.
    holdDurationDays: credentials.holdDurationDays ?? null,
    accessHe: v.accessHe,
    warnHe: v.warnHe || null,
    // שלוש השאלות שחייבים לשאול כל ספק לפני חתימה — הלוגיקה של
    // settleFolio (שלושת המקרים) תלויה בשלושתן.
    askVendorHe: [
      "כיצד משחררים הקפאת J5 שלא נלכדה, שלושה ימים אחרי?",
      "מהו משך ההקפאה המרבי עבור MCC 7011 (בתי מלון)?",
      "האם נתמכת לכידה חלקית (partial capture)?",
    ],
  };
}
