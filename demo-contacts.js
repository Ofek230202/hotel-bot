// ════════════════════════════════════════════════════════
//  DEMO-CONTACTS — פרטי הקשר של הבעלים, למלון ההדגמה בלבד
//  ----------------------------------------------------------
//  🔴 הפרטים כאן הם של **אופק (בעל המוצר)**, והם כאן למטרה אחת בלבד:
//     שבהדגמה מול לקוח, כשהבוט מנתב בקשה למשק בית / אחזקה / קבלה, היא
//     תגיע **לטלפון ולמייל שלו** — כדי שאפשר יהיה להראות ללקוח בזמן אמת
//     שההתראה באמת יוצאת, ולא רק "נשלחה" למספר דמה שאינו קיים.
//
//  ⚠️⚠️ **למה זה לא יושב ב-DEFAULTS, ולעולם לא יישב שם:**
//     `DEFAULTS` ב-config.js הוא שכבת הבסיס של **כל** המלונות. כל שדה
//     שמלון לא הגדיר נשאר של DEFAULTS — זו בדיוק מחלקת התקלות שתועדה
//     ב-§9.1 ("ירושה שקטה מ-DEFAULTS"), שבה בקשת אחזקה של אורח במלון א'
//     נשלחה לאחזקה של מלון ב'. אם המספר האישי היה ב-DEFAULTS, אז מלון
//     לקוח אמיתי שישכח להגדיר ולו מחלקה אחת היה שולח את הבקשות של
//     האורחים שלו **לטלפון הפרטי של אופק** — בשקט, בלי שאיש ישים לב.
//
//     לכן: overlay מפורש שנכתב **רק** למלון הדגמה מוכר, דרך
//     `applyDemoContacts(hotelId)`, ועם רשימת היתר קשיחה. מלון שאינו
//     ברשימה — הפונקציה מסרבת ומחזירה `{ ok:false }`. כך אפשר להריץ
//     מלונות אמיתיים במקביל להדגמה, על אותו שרת, בלי סיכון של דליפה.
//
//  להסרה לפני מסירה ללקוח: להפסיק לקרוא ל-`applyDemoContacts` (או
//  להגדיר `DEMO_CONTACTS=off`). הקונפיג של מלון אמיתי גובר ממילא.
// ════════════════════════════════════════════════════════
import { DEPARTMENTS, updateConfigFor, configFor } from "./config.js";

// פרטי הבעלים. מספר בפורמט בינלאומי — 0507070870 → +972507070870.
export const DEMO_OWNER = Object.freeze({
  name:     "אופק (בעל המוצר)",
  phone:    "+972507070870",
  whatsapp: "whatsapp:+972507070870",
  email:    "of230202@gmail.com",
});

// 🔒 רשימת היתר. **רק** מלונות הדגמה. מלון לקוח לעולם לא ייכנס לכאן —
//    וזו ההגנה היחידה שעומדת בין הטלפון הפרטי לבין אורחים אמיתיים.
export const DEMO_HOTEL_IDS = Object.freeze(["kempinski", "lala"]);

// כיבוי מפורש בלי שינוי קוד: DEMO_CONTACTS=off
function enabled() {
  return String(process.env.DEMO_CONTACTS || "").toLowerCase() !== "off";
}

/**
 * מפנה את כל 6 המחלקות של מלון ההדגמה לטלפון ולמייל של הבעלים.
 * מסרב לכל מלון שאינו ברשימת ההיתר.
 *
 * מחזיר { ok, hotelId, reason?, applied? }.
 */
export function applyDemoContacts(hotelId) {
  const id = String(hotelId || "").trim().toLowerCase();

  if (!enabled()) return { ok: false, reason: "disabled", hotelId: id };

  if (!DEMO_HOTEL_IDS.includes(id)) {
    // לא אזהרה שקטה: מי שקרא לזה על מלון אמיתי צריך לדעת מיד.
    console.error(
      `🔴 applyDemoContacts("${id}") נדחתה — אינו מלון הדגמה.\n` +
      `   פרטי הקשר האישיים מוגדרים אך ורק ל: ${DEMO_HOTEL_IDS.join(", ")}.\n` +
      `   מלון לקוח חייב אנשי קשר משלו (POST /api/config).`
    );
    return { ok: false, reason: "not_a_demo_hotel", hotelId: id };
  }

  const patch = {};
  for (const dept of DEPARTMENTS) {
    patch[`${dept}_number`] = DEMO_OWNER.whatsapp;
    patch[`${dept}_email`]  = DEMO_OWNER.email;
  }
  // מנהל תורן — מסלול הסלמת החירום. גם הוא לבעלים, אחרת הדגמת החירום
  // מסלימה למספר שאינו קיים וסולם ההסלמה נראה שבור.
  patch.duty_manager_number = DEMO_OWNER.whatsapp;

  updateConfigFor(id, patch);
  return { ok: true, hotelId: id, applied: DEPARTMENTS.length, owner: DEMO_OWNER.email };
}

/**
 * האם מלון מסוים מוגדר כרגע עם פרטי ההדגמה האישיים.
 * משמש לאזהרת העלייה — כדי שלא נשכח שזה פעיל.
 */
export function usingDemoContacts(hotelId) {
  const cfg = configFor(hotelId);
  return DEPARTMENTS.some(d => cfg[`${d}_email`] === DEMO_OWNER.email);
}

/**
 * אזהרה בעליית השרת. מטרה אחת: שאף אחד לא יגלה בטעות, חודשיים מהיום,
 * שהתראות של מלון כלשהו הולכות לטלפון פרטי.
 */
export function warnIfDemoContacts(hotelIds = []) {
  const hits = hotelIds.filter(id => { try { return usingDemoContacts(id); } catch { return false; } });
  if (!hits.length) return { ok: true, hotels: [] };
  console.warn(
    `\n🎬 פרטי הדגמה פעילים: התראות הצוות של ${hits.join(", ")} נשלחות ל-${DEMO_OWNER.email}\n` +
    `   ולטלפון ${DEMO_OWNER.phone} (${DEMO_OWNER.name}) — לצורכי הדגמה בלבד.\n` +
    `   ⚠️ מלון לקוח אמיתי חייב אנשי קשר משלו. לכיבוי: DEMO_CONTACTS=off\n`
  );
  return { ok: false, hotels: hits };
}
