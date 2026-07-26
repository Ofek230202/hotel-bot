// ════════════════════════════════════════════════════════
//  MockInvoiceProvider — הפקת חשבונית מס-קבלה (דמו, Part ה')
//  ----------------------------------------------------------
//  מפיק מסמך *מובנה ומלא* עם כל שדות החובה החוקיים בישראל, מקצה מספר
//  סידורי רץ (מ-db.js), ומחשב מע"מ נכון (18% לתושב / 0% לתייר חוץ).
//  ⚠️ דמו: המסמך מוצג לאורח כ-HTML (checkin-routes) וכסיכום בוואטסאפ,
//     אך אינו מוגש עדיין לרשות המסים (SHAAM) ואינו מספר הקצאה אמיתי.
//     החלפה לספק אמיתי (Green Invoice / iCount / EZcount / CardCom) =
//     שינוי במקום אחד: invoices/index.js. הספק האמיתי גם ידאג ל-PDF
//     ולמספר ההקצאה כשנדרש.
//
//  💡 המחירים בישראל *כוללים מע"מ* (מחיר לצרכן). לכן מפרידים את המע"מ
//     *אחורה* מהסכום הכולל: net = total / 1.18, vat = total − net.
// ════════════════════════════════════════════════════════
import { InvoiceProvider } from "./InvoiceProvider.js";
import { nextInvoiceSeq } from "../db.js";

export class MockInvoiceProvider extends InvoiceProvider {
  async issueInvoice({
    reservation: res,
    cfg = {},
    lang = "he",
    isTourist = false,
    paidMethod = "card",
    lines = [],
    baseUrl = "",
  } = {}) {
    const he = lang === "he";

    // ── מע"מ ────────────────────────────────────────────
    // תייר חוץ → 0% (מלונאות לתייר, בכפוף לדרכון + תשלום במט"ח).
    // תושב → שיעור המע"מ של המלון (ברירת מחדל 18% — ישראל 2026).
    const vatRate   = isTourist ? 0 : (cfg.vat_rate ?? 0.18);
    const zeroRated = isTourist || vatRate === 0;

    const totalInclVat = lines.reduce((s, l) => s + (l.amountInclVat || 0), 0);
    const net = zeroRated ? totalInclVat : Math.round(totalInclVat / (1 + vatRate));
    const vat = totalInclVat - net;

    // ── מספר סידורי רץ, פר-מלון ─────────────────────────
    const hotelId = res.hotelId || "kempinski";
    const seq     = nextInvoiceSeq(hotelId);
    const year    = new Date().getFullYear();
    const number  = `${year}-${String(seq).padStart(5, "0")}`;

    const biz = cfg.business || {};
    const invoice = {
      number,
      type:     he ? "חשבונית מס-קבלה" : "Tax Invoice-Receipt",
      original: true,                 // סימון "מקור" (חובה על העותק המקורי)
      issuedAt: new Date().toISOString(),
      lang,
      currency: "ILS",
      // מספר הקצאה (SHAAM) — נדרש רק ל-B2B מעל סף. לאורח יחיד: null.
      // 🔌 ספק אמיתי ימלא אותו כאן לפני ההנפקה כשנדרש.
      allocationNumber: null,

      seller: {
        name:         he ? (biz.legal_name || cfg.name_he || cfg.name) : (biz.legal_name_en || cfg.name),
        businessId:   biz.business_id   || null,   // עוסק מורשה / ח.פ.
        businessType: biz.business_type || null,
        address:      he ? (biz.address || "") : (biz.address_en || biz.address || ""),
        phone:        biz.phone || null,
        email:        biz.email || null,
      },
      customer: {
        name: he ? (res.guestNameHe || res.guestName) : (res.guestNameEn || res.guestName || res.guestNameHe),
        room: res.roomNumber || null,
      },

      lines,                          // [{ description, amountInclVat }]
      totalInclVat,
      net,
      vat,
      vatRate,
      zeroRated,
      paidMethod,                     // "card" | "cash" — לשורת הקבלה
    };
    invoice.url = baseUrl ? `${baseUrl}/invoice/${res.id}` : null;
    return invoice;
  }
}
