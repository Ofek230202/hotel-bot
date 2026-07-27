// ════════════════════════════════════════════════════════
//  PmsProvider — ממשק אחיד למערכת ניהול המלון (PMS) — Part ט'
//  ----------------------------------------------------------
//  ── מה זה PMS ומה החיבור נותן (בעברית פשוטה) ──────────
//  PMS (Property Management System) הוא "מוח התפעול" של המלון — מסד
//  הנתונים הרשמי שמנהל: הזמנות, הקצאת חדרים, סטטוס חדר (נקי/מלוכלך/
//  נבדק), חשבון האורח (folio), צ'ק אין/אאוט, תעריפים וזמינות, ופרופילי
//  אורחים. היום הבוט "מזייף" חלק מזה עם checkin.js (חדר "304" קשיח,
//  מספרי הזמנה שלא נבדקים מול מערכת אמיתית). כשמחברים PMS אמיתי:
//   • ההזמנה נשלפת אמיתית לפי מספר אישור (במקום לקבל כל מספר).
//   • החדר מוקצה אוטומטית מה-PMS (במקום "304").
//   • חיובי שירות החדרים/מיניבר נרשמים ל-folio ב-PMS (מקור אמת אחד).
//   • סטטוס החדר בצ'ק אאוט מתעדכן ל"מלוכלך" למשק הבית אוטומטית.
//  מבחינת האורח כלום לא משתנה — מבחינת המלון, הכל מסתנכרן אוטומטית.
//
//  ── ספקים ותקנים ──────────────────────────────────────
//  Oracle OPERA/OHIP (רשתות יוקרה — קמפינסקי), Mews, Apaleo, Cloudbeds
//  (REST מודרני); התקנים HTNG/OpenTravel הם מודל ההודעות. כולם מאחורי
//  הממשק הזה — הקוד העסקי מקבל תמיד *מבנה מנורמל* משלנו (Reservation/
//  Folio), לעולם לא JSON של ספק. ההחלפה במקום אחד: pms/index.js.
// ════════════════════════════════════════════════════════

export class PmsProvider {
  // ── יכולות (capability flags) — קריטי לגמישות מול כל PMS ──
  // 🔴 ממצא מחקר: מערכות PMS שונות תומכות בפעולות שונות. Optima (מוביל
  //    השוק בישראל, XML) ו-OPERA legacy לרוב *לא* מאפשרות לצד ג' לרשום
  //    folio; ותיקות עושות רק חיפוש לפי מספר אישור מדויק. לכן כל אדפטר
  //    מצהיר מה הוא תומך, והקוד העסקי *מדרדר בחן*: אין post folio → החיוב
  //    מנותב לצוות במקום ליפול. `supports(cap)` הוא נקודת ההחלטה.
  //
  //    יכולות אפשריות: "reservation.read" "reservation.search"
  //    "checkin" "checkout" "room.assign" "folio.read" "folio.post"
  //    "folio.payment" "housekeeping.read" "housekeeping.write"
  //    "profile.read" "profile.write" "webhooks".
  //    ברירת מחדל: כלום נתמך (אדפטר בטוח) — כל אדפטר מרחיב.
  capabilities = new Set();
  supports(cap) { return this.capabilities.has(cap); }

  // ── הזמנות ────────────────────────────────────────────
  // שליפת הזמנה לפי מספר אישור / טלפון / שם+תאריך. מחזיר Reservation מנורמל.
  async getReservation(_query)      { throw new Error("getReservation not implemented"); }
  async searchReservations(_query)  { throw new Error("searchReservations not implemented"); }
  async updateReservation(_id, _p)  { throw new Error("updateReservation not implemented"); }

  // ── צ'ק אין / אאוט + הקצאת חדר ────────────────────────
  async assignRoom(_id, _opts)      { throw new Error("assignRoom not implemented"); }
  async checkIn(_id)                { throw new Error("checkIn not implemented"); }
  async checkOut(_id)               { throw new Error("checkOut not implemented"); }

  // ── Folio / חיוב ──────────────────────────────────────
  async getFolio(_id)               { throw new Error("getFolio not implemented"); }
  async postCharge(_id, _charge)    { throw new Error("postCharge not implemented"); }
  async postPayment(_id, _payment)  { throw new Error("postPayment not implemented"); }

  // ── משק בית (סטטוס חדר) ───────────────────────────────
  async getRoomStatus(_room)        { throw new Error("getRoomStatus not implemented"); }
  async setRoomStatus(_room, _st)   { throw new Error("setRoomStatus not implemented"); }

  // ── פרופיל אורח + זמינות ──────────────────────────────
  async getGuestProfile(_id)        { throw new Error("getGuestProfile not implemented"); }
  async upsertGuestProfile(_p)      { throw new Error("upsertGuestProfile not implemented"); }
  async getAvailability(_query)     { throw new Error("getAvailability not implemented"); }

  // webhook לעדכוני הזמנה מה-PMS (הארכת שהייה, חיוב שהוזן בקבלה).
  verifyWebhook(_req)               { throw new Error("verifyWebhook not implemented"); }
}
