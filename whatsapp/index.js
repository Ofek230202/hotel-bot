// ════════════════════════════════════════════════════════
//  נקודת החיבור היחידה לערוץ הוואטסאפ (Part ט')
//  ----------------------------------------------------------
//  כאן — ורק כאן — בוחרים איזה ערוץ וואטסאפ פעיל, לכל מלון בנפרד.
//  ברירת המחדל "twilio" (הערוץ הקיים — אפס שינוי התנהגות). מלון שעבר
//  ל-Meta WhatsApp Cloud API מגדיר whatsapp_provider="cloud" + credentials,
//  וההחלפה מתבצעת כאן בלי לגעת ב-bot.js. wa() שולח דרך whatsappFor(hotelId).
// ════════════════════════════════════════════════════════
import { TwilioProvider } from "./TwilioProvider.js";
import { CloudApiProvider, verifyMetaChallenge } from "./CloudApiProvider.js";
import { configFor } from "../config.js";
import { LruCache } from "../store/LruCache.js";

export { verifyMetaChallenge };

// ברירת המחדל הגלובלית — Twilio (תאימות לאחור מלאה).
export const whatsapp = new TwilioProvider();

// 🔴 חסום, לא Map פתוח. זה cache **פר-מלון**: עם מיליון מלונות Map
//    ללא גבול היה מחזיק מופע ספק לכל מלון שאי פעם נגעו בו, לנצח — בדיוק
//    התקרה שהוסרה מהסשנים וההזמנות, שנשארה כאן. מופע ספק הוא חסר-מצב
//    (credentials בלבד), ולכן פינוי בטוח לחלוטין: הוא פשוט נבנה מחדש.
const cache = new LruCache({ max: Number(process.env.PROVIDER_CACHE_MAX) || 5_000 });

export function whatsappFor(hotelId) {
  let name = "twilio", creds = {};
  try {
    const cfg = configFor(hotelId);
    name  = String(cfg.whatsapp_provider || process.env.WA_PROVIDER || "twilio").toLowerCase();
    creds = cfg.whatsapp_credentials || {};
  } catch { /* קונפיג לא זמין → Twilio */ }

  const key = `${name}:${hotelId || "default"}`;
  if (cache.has(key)) return cache.get(key);

  let provider;
  switch (name) {
    case "cloud":
    case "meta": {
      const cloud = new CloudApiProvider({
        phoneNumberId: creds.phoneNumberId || process.env.WA_PHONE_NUMBER_ID,
        token:         creds.token         || process.env.WA_SYSTEM_USER_TOKEN,
        appSecret:     creds.appSecret     || process.env.WA_APP_SECRET,
        apiVersion:    creds.apiVersion    || process.env.WA_API_VERSION,
      });
      // נפילה בטוחה ל-Twilio אם המלון עדיין לא סיים onboarding מול Meta.
      if (cloud.isConfigured()) { provider = cloud; }
      else {
        console.warn(`⚠️ מלון "${hotelId}" ביקש WhatsApp Cloud API אך חסרים credentials — נופלים ל-Twilio.`);
        provider = whatsapp;
      }
      break;
    }
    case "twilio":
    default:
      provider = whatsapp;
  }
  cache.set(key, provider);
  return provider;
}

export function clearWhatsAppCache() { cache.clear(); }

// אימות webhook נכנס לפי הערוץ של המלון (Meta: HMAC; Twilio: חתימה).
export function verifyIncomingWebhook(hotelId, params) {
  return whatsappFor(hotelId).verifyWebhook(params);
}
