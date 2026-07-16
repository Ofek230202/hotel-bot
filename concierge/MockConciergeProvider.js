// ════════════════════════════════════════════════════════
//  MockConciergeProvider — ספק בקשות קונסיירז' מדומה
//  ----------------------------------------------------------
//  לא מזמין מונית, לא תופס שולחן ולא קונה עוגה. מקצה מספר אסמכתא,
//  רושם ללוג ומחזיר "התקבל" — הטיפול בפועל נעשה על ידי הקונסיירז'
//  האנושי, שמקבל את הבקשה בוואטסאפ ובמייל דרך notifyStaff.
//
//  ⚠️ זה בדיוק המצב שהמלון נמצא בו היום, ולכן זו לא הונאה כלפי
//  האורח: הבקשה *באמת* מועברת לאדם שיבצע אותה. הבוט חייב לומר
//  לאורח "העברתי לקונסיירז'" — לא "הזמנתי לך מונית".
//
//  ┌─────────────────────────────────────────────────────┐
//  │ 🔌 נקודת החיבור העתידית לשירות אמיתי                │
//  ├─────────────────────────────────────────────────────┤
//  │ כשיהיה ספק אמיתי, הוא ייכתב כאן לצד המוק כמחלקה     │
//  │ נוספת (GettProvider / TabitProvider / …) ויוחלף     │
//  │ בשורה אחת ב-concierge/index.js. החוזה לא משתנה:     │
//  │ submitRequest → { reference, status }.               │
//  │                                                      │
//  │ מה ישתנה אז: `status` יחזור "confirmed" עם אישור    │
//  │ אמיתי מהספק, ורק אז מותר לבוט לומר לאורח שההזמנה    │
//  │ *בוצעה*. עד אז — "הבקשה הועברה".                    │
//  └─────────────────────────────────────────────────────┘
// ════════════════════════════════════════════════════════
import { v4 as uuidv4 } from "uuid";
import { ConciergeProvider, REQUEST_TYPES } from "./ConciergeProvider.js";

const EMOJI = {
  [REQUEST_TYPES.TAXI]:       "🚕",
  [REQUEST_TYPES.RESTAURANT]: "🍽️",
  [REQUEST_TYPES.SPA]:        "💆",
  [REQUEST_TYPES.TOUR]:       "🗺️",
  [REQUEST_TYPES.TRANSFER]:   "✈️",
  [REQUEST_TYPES.RENTAL]:     "🚗",
  [REQUEST_TYPES.GIFT]:       "🎁",
  [REQUEST_TYPES.OTHER]:      "⭐",
};

export class MockConciergeProvider extends ConciergeProvider {
  async submitRequest({ type = REQUEST_TYPES.OTHER, details = "", guestName, roomNumber } = {}) {
    // אסמכתא קצרה שאפשר לומר בטלפון — לא UUID מלא. ה-UUID נשאר בפנים
    // כדי שהמזהה יישאר ייחודי גם כשיהיו הרבה בקשות בשנייה.
    const reference = `CNG-${uuidv4().replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    console.log(
      `${EMOJI[type] || "⭐"} [MOCK CONCIERGE] ${reference} | סוג: ${type} | ` +
      `אורח: ${guestName || "—"} | חדר: ${roomNumber || "—"}`
    );
    if (details) console.log(`   └─ ${String(details).replace(/\n/g, " ").slice(0, 200)}`);

    return {
      success:   true,
      reference,
      status:    "received", // המוק לעולם לא "confirmed" — אף אחד עדיין לא הזמין כלום
      provider:  "mock",
    };
  }
}
