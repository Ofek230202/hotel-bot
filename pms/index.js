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
import { ApaleoPmsProvider } from "./ApaleoPmsProvider.js";
import { OptimaPmsProvider } from "./OptimaPmsProvider.js";
import { configFor } from "../config.js";

export const pms = new MockPmsProvider(); // ברירת מחדל + תאימות לאחור

const cache = new Map();

export function pmsFor(hotelId) {
  let name = "mock", creds = {};
  try {
    const cfg = configFor(hotelId);
    name  = String(cfg.pms_provider || "mock").toLowerCase();
    creds = cfg.pms_credentials || {};
  } catch { /* קונפיג לא זמין → Mock */ }

  const key = `${name}:${hotelId || "default"}`;
  if (cache.has(key)) return cache.get(key);

  // בונה ספק, ואם חסרים credentials נופל בבטחה ל-Mock (המאגר המובנה).
  const build = (Provider, label) => {
    const p = new Provider(creds);
    if (!p.isConfigured?.()) {
      console.warn(`⚠️ מלון "${hotelId}" ביקש PMS ${label} בלי credentials — נופלים ל-Mock (המאגר המובנה).`);
      return pms;
    }
    return p;
  };

  let provider;
  switch (name) {
    // Optima/Silverbyte — מוביל השוק בישראל (~80–90%). היעד הראשון בישראל.
    case "optima":
    case "silverbyte": provider = build(OptimaPmsProvider, "optima"); break;
    // Apaleo — REST מודרני, ה-scaffold הפתוח לפיתוח מול חשבון dev.
    case "apaleo":     provider = build(ApaleoPmsProvider, "apaleo"); break;
    // case "mews":    provider = build(MewsPmsProvider, "mews"); break;
    // case "opera":   provider = build(OperaOhipProvider, "opera"); break;
    // case "cloudbeds": provider = build(CloudbedsPmsProvider, "cloudbeds"); break;
    case "mock":
    default:
      provider = pms;
  }
  cache.set(key, provider);
  return provider;
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
