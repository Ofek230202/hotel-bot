// ════════════════════════════════════════════════════════
//  נקודת החיבור היחידה ל-PMS (Part ט')
//  ----------------------------------------------------------
//  כאן — ורק כאן — בוחרים איזו מערכת PMS פעילה, לכל מלון בנפרד.
//  ברירת המחדל "mock" (המאגר המובנה מקור האמת — אפס שינוי התנהגות).
//  מלון עם PMS אמיתי מגדיר pms_provider (apaleo/mews/opera/…) + credentials,
//  וההחלפה כאן — בלי לגעת ב-checkin.js.
//
//  💡 החיבור *מוכן*: הנקודות שבהן checkin.js יקרא ל-PMS מסומנות בקוד
//     (שליפת הזמנה, הקצאת חדר "304", רישום folio, סטטוס חדר בצ'ק אאוט).
//     כשמפעילים ספק אמיתי — ממלאים את גוף השיטות בספק, והלוגיקה זהה.
// ════════════════════════════════════════════════════════
import { MockPmsProvider } from "./MockPmsProvider.js";
import { OptimaPmsProvider } from "./OptimaPmsProvider.js";
import { RestPmsProvider } from "./RestPmsProvider.js";
import { vendorSpec, missingCredentials, VENDOR_IDS } from "./vendors.js";
import { configFor } from "../config.js";
import { LruCache } from "../store/LruCache.js";

export { VENDOR_IDS, vendorSpec, missingCredentials };

export const pms = new MockPmsProvider(); // ברירת מחדל + תאימות לאחור

// 🔴 חסום, לא Map פתוח. זה cache **פר-מלון**: עם מיליון מלונות Map
//    ללא גבול היה מחזיק מופע ספק לכל מלון שאי פעם נגעו בו, לנצח — בדיוק
//    התקרה שהוסרה מהסשנים וההזמנות, שנשארה כאן. מופע ספק הוא חסר-מצב
//    (credentials בלבד), ולכן פינוי בטוח לחלוטין: הוא פשוט נבנה מחדש.
const cache = new LruCache({ max: Number(process.env.PROVIDER_CACHE_MAX) || 5_000 });

export function pmsFor(hotelId) {
  let name = "mock", creds = {};
  try {
    const cfg = configFor(hotelId);
    name  = String(cfg.pms_provider || "mock").toLowerCase();
    creds = cfg.pms_credentials || {};
  } catch { /* קונפיג לא זמין → Mock */ }

  const key = `${name}:${hotelId || "default"}`;
  if (cache.has(key)) return cache.get(key);

  // ── בחירת הספק ──────────────────────────────────────
  // 🔴 נפילה בטוחה: מלון שסימן ספק אך חסרים לו פרטים **לא מפיל צ'ק אין**.
  //    הוא נופל ל-Mock עם אזהרה **שמפרטת בדיוק מה חסר** — אחרת מגלים את
  //    זה רק כשאורח באמצע צ'ק אין, ובלי לדעת למה.
  const safe = (make, label) => {
    try {
      const p = make();
      if (!p.isConfigured?.()) {
        const miss = missingCredentials(label, creds).missing.map(m => m.labelHe || m.key);
        console.warn(
          `⚠️ מלון "${hotelId}" ביקש PMS "${label}" אך החיבור אינו שלם — נופלים ל-Mock (המאגר המובנה).` +
          (miss.length ? ` חסר: ${miss.join(", ")}.` : "") + ` ראה PMS_GUIDE.md.`
        );
        return pms;
      }
      return p;
    } catch (e) {
      console.error(`🚨 בניית ספק ה-PMS "${label}" למלון "${hotelId}" נכשלה — נופלים ל-Mock: ${e?.message || e}`);
      return pms;
    }
  };

  let provider;
  if (name === "mock" || !name) {
    provider = pms;
  } else {
    const spec = vendorSpec(name);
    if (!spec) {
      console.warn(`⚠️ מלון "${hotelId}" ביקש PMS לא מוכר: "${name}". ספקים נתמכים: ${VENDOR_IDS.join(", ")}. נופלים ל-Mock.`);
      provider = pms;
    } else if (spec.dedicated === "OptimaPmsProvider") {
      // אופטימה מקבלת מחלקה ייעודית: XML, כללי folio משלה, ומיפוי ישראלי.
      provider = safe(() => new OptimaPmsProvider(creds), spec.id);
    } else {
      // כל השאר — מנוע גנרי שמריץ את המפרט מ-vendors.js.
      provider = safe(() => new RestPmsProvider(spec.id, creds), spec.id);
    }
  }
  cache.set(key, provider);
  return provider;
}

// ── מוכנות החיבור של מלון ─────────────────────────────
// לדשבורד/אונבורדינג: מה מוגדר, מה חסר, ומה הספק יודע לעשות.
// לעולם לא מחזיר סודות.
export function pmsReadiness(hotelId) {
  let name = "mock", creds = {};
  try {
    const cfg = configFor(hotelId);
    name  = String(cfg.pms_provider || "mock").toLowerCase();
    creds = cfg.pms_credentials || {};
  } catch { /* ignore */ }

  if (name === "mock") {
    return { hotelId, vendor: "mock", ready: true, mock: true, missing: [],
             note: "המאגר המובנה הוא מקור האמת (תקין לפיילוט/הדגמה)" };
  }
  const spec = vendorSpec(name);
  if (!spec) return { hotelId, vendor: name, ready: false, unknownVendor: true, missing: [], supported: VENDOR_IDS };

  const miss = missingCredentials(spec.id, creds);
  const p = pmsFor(hotelId);
  return {
    hotelId, vendor: spec.id, label: spec.label, labelHe: spec.labelHe,
    ready: !p.isMock && !!p.isConfigured?.(),
    missing: miss.missing,
    capabilities: p.isMock ? [] : [...(p.capabilities || [])].sort(),
    docsUrl: spec.docsUrl || null,
    guideRef: spec.guideRef || "PMS_GUIDE.md",
  };
}

export function clearPmsCache() { cache.clear(); }

// בדיקת בריאות בעליית השרת — מדפיסה איזה PMS פעיל לכל מלון. מלון על Mock
// = המאגר המובנה מקור האמת (תקין לדמו/פיילוט). לעולם לא זורק.
export function pmsHealth(hotelId) {
  try {
    const p = pmsFor(hotelId);
    const provider = p.isMock ? "mock (built-in store)" : p.constructor.name;
    return { hotelId, provider, connected: !p.isMock };
  } catch (e) {
    return { hotelId, provider: "unknown", connected: false, error: e?.message };
  }
}
