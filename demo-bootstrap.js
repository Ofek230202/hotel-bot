// ════════════════════════════════════════════════════════
//  DEMO-BOOTSTRAP — קובע את מלון ההדגמה מ**משתנה סביבה**, בעלייה
//  ----------------------------------------------------------
//  הבעיה שזה פותר, והיא שקטה ומסוכנת:
//
//  `demo-switch.mjs` כותב לבסיס הנתונים של **המחשב שמריץ אותו**. שרת
//  בענן (Railway/Render) הוא מכונה אחרת עם בסיס נתונים אחר — ולכן החלפה
//  מקומית **אינה משנה כלום בענן**. בענן אין שורה ב-`hotel_numbers`, ולכן
//  `resolveHotelId` נופל ל-`DEFAULT_HOTEL_ID` ("kempinski"), וגם אין שורת
//  קונפיג ל-LALA — כך שאפילו מיפוי ידני לא היה מספיק.
//
//  ובעיה שנייה: על Railway מערכת הקבצים היא **בת-חלוף** (אין volume
//  מחובר כברירת מחדל). כלומר גם אם נזריק את ההגדרה דרך ה-API, כל redeploy
//  ימחק אותה. לכן ההגדרה חייבת להיגזר ממשהו שמתמיד — **משתנה סביבה**.
//
//  הפתרון: `DEMO_HOTEL=lala` (או `kempinski`). בכל עלייה של השרת:
//    1. נכתב הקונפיג המלא של אותו מלון (מ-`sample-hotels.mjs`) ל-DB.
//    2. `TWILIO_WHATSAPP_NUMBER` ממופה לאותו מלון, ו**רק** אליו.
//  אידמפוטנטי לחלוטין: אותה עלייה שוב = אותה תוצאה. שינוי המלון בענן =
//  שינוי משתנה סביבה אחד + redeploy.
//
//  ⚠️ רץ **רק** כש-`DEMO_HOTEL` מוגדר במפורש. בפריסה אמיתית (מלון לקוח
//     שהוגדר דרך `POST /api/hotels`) לא מגדירים אותו, ואז המודול הזה
//     אינו נוגע בכלום — כדי שלא ידרוס הגדרות אמיתיות בכל restart.
// ════════════════════════════════════════════════════════
import { db, DEFAULT_HOTEL_ID } from "./db.js";
import { prepare } from "./store/Repo.js";
import { updateConfigFor, configFor } from "./config.js";
import { registerHotelNumber, normalizeNumber } from "./tenant.js";

const allNumbersStmt   = prepare(`SELECT number FROM hotel_numbers`);
const deleteNumberStmt = prepare(`DELETE FROM hotel_numbers WHERE number = ?`);

// טוען את מלוני הדוגמה. `sample-hotels.mjs` הוא קוד ולא נטען לבד בשום
// מקום בשרת — כאן הנקודה היחידה שבה השרת נעזר בו, ובמכוון: זה מה שמאפשר
// להעמיד מלון הדגמה בענן בלי בסיס נתונים מוכן מראש.
async function sampleHotels() {
  try {
    const m = await import("./sample-hotels.mjs");
    return m.SAMPLE_HOTELS || [];
  } catch (e) {
    console.error("⚠️ טעינת sample-hotels נכשלה:", e?.message || e);
    return [];
  }
}

export async function bootstrapDemoHotel() {
  const want = String(process.env.DEMO_HOTEL || "").trim().toLowerCase();
  if (!want) return { skipped: true, reason: "no_DEMO_HOTEL" };

  const number = normalizeNumber(process.env.TWILIO_WHATSAPP_NUMBER);
  if (!number) {
    console.error(
      `\n🔴 DEMO_HOTEL=${want} מוגדר, אבל אין TWILIO_WHATSAPP_NUMBER.\n` +
      `   בלי מספר אין למה למפות את המלון — הבוט יענה כמלון ברירת המחדל ("${DEFAULT_HOTEL_ID}").\n`
    );
    return { ok: false, reason: "no_number" };
  }

  const hotels = await sampleHotels();
  const match  = hotels.find(h => h.hotelId === want);

  // מלון ברירת המחדל אינו זקוק לשורת קונפיג (הקונפיג בקוד), אבל כן
  // זקוק למיפוי המספר — אחרת נשארת שורה של מלון אחר.
  const isDefault = want === DEFAULT_HOTEL_ID;
  if (!match && !isDefault) {
    console.error(
      `\n🔴 DEMO_HOTEL="${want}" אינו מלון מוכר.\n` +
      `   אפשרויות: ${hotels.map(h => h.hotelId).join(", ")}\n` +
      `   הבוט יענה כמלון ברירת המחדל ("${DEFAULT_HOTEL_ID}").\n`
    );
    return { ok: false, reason: "unknown_hotel", want };
  }

  // 1. קונפיג המלון ל-DB (למלון שאינו ברירת המחדל).
  if (match?.config && !isDefault) {
    updateConfigFor(want, match.config);
  }

  // 2. המספר מצביע על המלון הזה — ורק עליו. שורה יתומה של מספר אחר
  //    שמצביע על אותו מלון הייתה נבחרת כמספר ה*יוצא* (`fromNumberFor`),
  //    והתשובות היו יוצאות ממספר שאינו קיים אצל ספק הוואטסאפ.
  try {
    for (const row of allNumbersStmt.all()) {
      if (normalizeNumber(row.number) !== number) {
        deleteNumberStmt.run(row.number);
      }
    }
  } catch (e) {
    console.warn("⚠️ ניקוי מיפויי מספרים נכשל:", e?.message || e);
  }
  registerHotelNumber(number, want, number);

  const cfg = configFor(want);
  console.log(
    `\n🎬 DEMO_HOTEL=${want} — מלון ההדגמה הוגדר בעלייה:\n` +
    `   ${number}  →  ${cfg.name_he || cfg.name} (${want})\n`
  );
  return { ok: true, hotelId: want, number, name: cfg.name_he || cfg.name };
}
