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
import { LruCache } from "../store/LruCache.js";
import { paymentVendor, vendorReadiness, PAYMENT_VENDOR_IDS, canChargeLive } from "./vendors.js";

export { PAYMENT_VENDORS, PAYMENT_VENDOR_IDS, paymentVendor, vendorReadiness, canChargeLive, PAY_CAPS } from "./vendors.js";

// מטבע המערכת — שקלים (ILS). סכומים נשמרים באגורות (50000 = ₪500).
export const PAYMENT_CURRENCY = "ils";

// ה-Mock הגלובלי — ברירת המחדל ותאימות לאחור.
export const payments = new MockProvider();

// ── בחירת ספק פר-מלון ──────────────────────────────────
// cache לפי ספק+מלון: אותו מלון מקבל את אותה מופע ספק (חשוב ל-CardCom
// שמחזיק credentials). מלון בלי הגדרה → Mock.
// 🔴 חסום, לא Map פתוח. זה cache **פר-מלון**: עם מיליון מלונות Map
//    ללא גבול היה מחזיק מופע ספק לכל מלון שאי פעם נגעו בו, לנצח — בדיוק
//    התקרה שהוסרה מהסשנים וההזמנות, שנשארה כאן. מופע ספק הוא חסר-מצב
//    (credentials בלבד), ולכן פינוי בטוח לחלוטין: הוא פשוט נבנה מחדש.
const providerCache = new LruCache({ max: Number(process.env.PROVIDER_CACHE_MAX) || 5_000 });

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
      provider = payments;
      break;
    default: {
      // ── ספק מוכר שאין לו עדיין מימוש מאומת ──────────────
      // 🔴 **כאן עובר הקו האדום של השכבה הזו.** ספק שהמפרט שלו הוא שלד
      //    (`verified:false` ב-vendors.js) לעולם **אינו** מחייב כרטיס של
      //    אורח: נתיב מנוחש שמצליח חלקית גרוע פי כמה מנתיב שנכשל —
      //    הוא יוצר "תשלום שהצליח" מדומה, והאורח מקבל חדר בלי פיקדון.
      //    לכן נופלים ל-Mock, ואומרים **בדיוק** מה חסר כדי לחבר באמת.
      const v = paymentVendor(name);
      if (v) {
        const readiness = vendorReadiness(name, credentials);
        console.warn(
          `\n💳 מלון "${hotelId}" מוגדר לספק סליקה "${v.labelHe}" (${v.id}).\n` +
          `   ⚠️ אין עדיין מימוש **מאומת** לספק הזה — רץ על Mock (בלי חיוב אמיתי).\n` +
          `   מה נדרש כדי לחבר: ${(v.credentialFields || []).map(fld => fld.labelHe).join(" · ")}\n` +
          `   איך משיגים: ${v.accessHe || "—"}\n` +
          (readiness.missing.length
            ? `   חסר כרגע: ${readiness.missing.map(m => m.labelHe).join(", ")}\n`
            : `   ✅ כל ה-credentials כבר קיימים — נדרש רק לאמת את הנתיבים מול מסמך הספק.\n`) +
          (v.warnHe ? `   🔴 ${v.warnHe}\n` : "")
        );
      } else {
        console.warn(`⚠️ מלון "${hotelId}": ספק סליקה לא מוכר "${name}" — נופלים ל-Mock. ` +
                     `ספקים מוכרים: ${PAYMENT_VENDOR_IDS.join(", ")}`);
      }
      provider = payments;
    }
  }
  providerCache.set(key, provider);
  return provider;
}

/**
 * מצב החיבור של ספק הסליקה של מלון — לדשבורד ול-onboarding.
 * עונה על השאלה המעשית: "מה עוד צריך כדי שהמלון הזה יסלוק באמת?"
 */
export function paymentReadiness(hotelId) {
  let name = "mock", credentials = {};
  try {
    const cfg = configFor(hotelId);
    name = String(cfg.payment_provider || "mock").toLowerCase();
    credentials = cfg.payment_credentials || {};
  } catch { /* קונפיג לא זמין */ }

  if (name === "mock") {
    return { hotelId, provider: "mock", live: false, ready: true,
             noteHe: "מצב הדגמה — הפיקדון מאושר בלי חיוב אמיתי." };
  }
  const r = vendorReadiness(name, credentials);
  if (!r.vendor) {
    return { hotelId, provider: name, live: false, ready: false,
             noteHe: `ספק לא מוכר. ספקים נתמכים: ${PAYMENT_VENDOR_IDS.join(", ")}` };
  }
  const live = r.canChargeLive && r.ok;
  return {
    hotelId, provider: r.vendor, labelHe: r.labelHe,
    live, ready: r.ok, verified: r.verified,
    missing: r.missing, accessHe: r.accessHe, warnHe: r.warnHe,
    noteHe: live
      ? "מחובר לסליקה אמיתית."
      : r.verified
        ? "הספק נתמך — חסרים פרטי התחברות."
        : "הספק מוכר, אך המימוש טרם אומת מול תיעוד הספק — רץ על Mock.",
  };
}

// ניקוי ה-cache (למשל אחרי עדכון credentials של מלון דרך ה-API).
export function clearPaymentsCache(hotelId = null) {
  if (!hotelId) return providerCache.clear();
  for (const key of providerCache.keys()) {
    if (key.endsWith(`:${hotelId}`)) providerCache.delete(key);
  }
}
