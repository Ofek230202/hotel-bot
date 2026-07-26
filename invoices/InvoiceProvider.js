// ════════════════════════════════════════════════════════
//  InvoiceProvider — ממשק אחיד להפקת חשבוניות (Part ה')
//  ----------------------------------------------------------
//  מבודד בדיוק כמו payments/ ו-idverify/: הקוד העסקי (checkin.js)
//  מדבר רק עם הממשק הזה, ולעולם לא עם ספק חשבוניות ספציפי. החלפה
//  מ-Mock לספק ישראלי אמיתי (Green Invoice / iCount / EZcount / CardCom)
//  נעשית במקום אחד: invoices/index.js.
//
//  ── רקע חוקי (ישראל 2026) ──────────────────────────────
//  המסמך שמלון מנפיק בצ'ק אאוט, כשהאורח משלם במקום, הוא **חשבונית
//  מס-קבלה** (Tax Invoice-Receipt) — מסמך המס + הקבלה במאוחד.
//  שדות חובה: "חשבונית מס-קבלה", שם+כתובת+מספר עוסק של המלון, מספר
//  סידורי רץ, תאריך, שם הלקוח, פירוט, סכום לפני מע"מ, שיעור מע"מ וסכומו
//  בנפרד, סה"כ כולל מע"מ, סימון "מקור". מע"מ 2026 = 18%; מלונאות לתייר
//  חוץ (דרכון + תשלום במט"ח) = 0%. מספר הקצאה (SHAAM) נדרש רק ל-B2B
//  מעל סף — מחוץ להיקף לאורח יחיד; מיוצג כשדה אופציונלי.
// ════════════════════════════════════════════════════════

export class InvoiceProvider {
  /**
   * מפיק חשבונית מס-קבלה לשהייה שהסתיימה.
   * @param {object} params
   *   reservation — ההזמנה (כולל folio, deposit, שם, חדר, תאריכים)
   *   cfg         — קונפיג המלון (business, vat_rate, שם)
   *   lang        — שפת המסמך ("he" | "en")
   *   isTourist   — תייר חוץ (0% מע"מ) או תושב (18%)
   *   paidMethod  — "card" | "cash" — לשורת אמצעי התשלום בקבלה
   * @returns {Promise<Invoice>} מסמך מובנה:
   *   { number, type, issuedAt, allocationNumber, currency,
   *     seller, customer, lines:[{description, amountInclVat}],
   *     totalInclVat, net, vat, vatRate, zeroRated, paidMethod, url }
   */
  async issueInvoice(_params) {
    throw new Error("issueInvoice not implemented");
  }
}
