// ════════════════════════════════════════════════════════
//  נקודת החיבור היחידה לספק התשלום (single wiring point)
//  ----------------------------------------------------------
//  כאן — ורק כאן — בוחרים איזה ספק תשלום פעיל, לכל מלון בנפרד.
//  כל שאר הקוד מייבא מכאן ולא יודע מי הספק בפועל.
//
//  ── פר-מלון (Part ג') ──────────────────────────────────
//  כל מלון עובד עם חברת סליקה משלו. `paymentsFor(hotelId)` מחזיר את
//  הספק של אותו מלון לפי `config.payment_provider` שלו:
//     "mock"    → MockProvider (ברירת מחדל — דמו, בלי חיוב אמיתי)
//     "cardcom" → CardComProvider (סליקה ישראלית אמיתית — scaffold מסומן)
//  מלון מחליף לספק אמיתי בשינוי *שורת קונפיג אחת*, בלי נגיעה בקוד עסקי.
//
//  התאימות לאחור נשמרת: `payments` (ה-Mock הגלובלי) עדיין מיוצא, כך
//  שכל קוד/בדיקה שמייבא `{ payments }` ממשיך לעבוד בדיוק כמו קודם.
// ════════════════════════════════════════════════════════
import { MockProvider } from "./MockProvider.js";
import { CardComProvider } from "./CardComProvider.js";
import { configFor } from "../config.js";

// מטבע המערכת — שקלים (ILS). סכומים נשמרים באגורות (50000 = ₪500).
export const PAYMENT_CURRENCY = "ils";

// ה-Mock הגלובלי — ברירת המחדל ותאימות לאחור.
export const payments = new MockProvider();

// ── בחירת ספק פר-מלון ──────────────────────────────────
// cache לפי ספק+מלון: אותו מלון מקבל את אותה מופע ספק (חשוב ל-CardCom
// שמחזיק credentials). מלון בלי הגדרה → Mock.
const providerCache = new Map();

export function paymentsFor(hotelId) {
  let name = "mock";
  let credentials = {};
  try {
    const cfg = configFor(hotelId);
    name = String(cfg.payment_provider || "mock").toLowerCase();
    credentials = cfg.payment_credentials || {};
  } catch { /* קונפיג לא זמין → Mock */ }

  const key = `${name}:${hotelId || "default"}`;
  if (providerCache.has(key)) return providerCache.get(key);

  let provider;
  switch (name) {
    case "cardcom": {
      const cc = new CardComProvider(credentials);
      // בטיחות: מלון שסימן "cardcom" אך עדיין לא סיים onboarding (בלי
      // credentials) — נופל ל-Mock כדי לא לשבור צ'ק אין, עם אזהרה בקול.
      if (!cc.isConfigured()) {
        console.warn(`⚠️ מלון "${hotelId}" הגדיר payment_provider=cardcom אך חסרים payment_credentials — נופלים ל-Mock עד להשלמת החיבור.`);
        provider = payments;
      } else {
        provider = cc;
      }
      break;
    }
    case "mock":
    default:
      provider = payments;
  }
  providerCache.set(key, provider);
  return provider;
}

// ניקוי ה-cache (למשל אחרי עדכון credentials של מלון דרך ה-API).
export function clearPaymentsCache(hotelId = null) {
  if (!hotelId) return providerCache.clear();
  for (const key of providerCache.keys()) {
    if (key.endsWith(`:${hotelId}`)) providerCache.delete(key);
  }
}
