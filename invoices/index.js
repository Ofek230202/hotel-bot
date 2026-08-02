// ════════════════════════════════════════════════════════
//  נקודת החיבור היחידה לספק החשבוניות (Part ה')
//  ----------------------------------------------------------
//  כאן — ורק כאן — בוחרים איזה ספק חשבוניות פעיל, לכל מלון בנפרד.
//  ברירת המחדל "mock" (מסמך מובנה מלא, בלי הגשה לרשות המסים). מלון
//  עם ספק אמיתי (Green Invoice / iCount / EZcount / CardCom) מגדיר
//  invoice_provider בקונפיג שלו, וההחלפה מתבצעת כאן — בלי נגיעה בקוד
//  העסקי (checkin.js מדבר רק עם invoicesFor(hotelId).issueInvoice).
//
//  💡 אותו scaffold כמו payments/: interface + Mock + נקודת החלפה אחת.
//     ספק אמיתי מוסיף מחלקה כמו ה-CardComProvider, מיישם issueInvoice
//     (קריאת API + מספר הקצאה SHAAM + PDF), ומוסיף case ל-switch כאן.
// ════════════════════════════════════════════════════════
import { MockInvoiceProvider } from "./MockInvoiceProvider.js";
import { configFor } from "../config.js";
import { LruCache } from "../store/LruCache.js";

// ה-Mock הגלובלי — ברירת מחדל ותאימות לאחור.
export const invoices = new MockInvoiceProvider();

// 🔴 חסום, לא Map פתוח. זה cache **פר-מלון**: עם מיליון מלונות Map
//    ללא גבול היה מחזיק מופע ספק לכל מלון שאי פעם נגעו בו, לנצח — בדיוק
//    התקרה שהוסרה מהסשנים וההזמנות, שנשארה כאן. מופע ספק הוא חסר-מצב
//    (credentials בלבד), ולכן פינוי בטוח לחלוטין: הוא פשוט נבנה מחדש.
const providerCache = new LruCache({ max: Number(process.env.PROVIDER_CACHE_MAX) || 5_000 });

export function invoicesFor(hotelId) {
  let name = "mock";
  try {
    name = String(configFor(hotelId).invoice_provider || "mock").toLowerCase();
  } catch { /* קונפיג לא זמין → Mock */ }

  const key = `${name}:${hotelId || "default"}`;
  if (providerCache.has(key)) return providerCache.get(key);

  let provider;
  switch (name) {
    // case "greeninvoice": provider = new GreenInvoiceProvider(...); break;
    // case "icount":       provider = new ICountProvider(...);       break;
    case "mock":
    default:
      provider = invoices;
  }
  providerCache.set(key, provider);
  return provider;
}

export function clearInvoicesCache() { providerCache.clear(); }
