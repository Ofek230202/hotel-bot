// ════════════════════════════════════════════════════════
//  OptimaPmsProvider — 🔌 Optima / Silverbyte (מוביל השוק בישראל)
//  ----------------------------------------------------------
//  🔴 ממצא מחקר קריטי: Optima של Silverbyte (נרכשה ע"י Priority Software)
//     היא ה-PMS הדומיננטי בישראל — ~80–90% מהמלונות (דן, פתאל/לאונרדו,
//     ישרוטל, אורכיד, פרימה, NYX). היא מנצחת דווקא כי היא מתמחה בעברית/RTL
//     ובמס הישראלי (חשבונית-קבלה, מע"מ 0% לתייר) — בדיוק מה שספקים זרים
//     לא מתאימים. לכן חיבור אמיתי בישראל = Optima *ראשון*.
//
//  ⚠️ הממשק: XML/API דרך צוות Optima/Priority (לא self-serve — נדרש הסכם
//     שותפות). לכן זה scaffold: השיטות זורקות PmsNotConnectedError בבירור
//     עד לחיבור אמיתי, וכל אחת מתעדת מה לממש. ההחלפה במקום אחד: pms/index.js.
//
//  יכולות: Optima מספקת קריאת הזמנה/folio, צ'ק אין/אאוט, וסטטוס חדר.
//  post folio מצד ג' *עשוי להיות מוגבל* — לכן folio.post לא מוצהר כברירת
//  מחדל; הקוד העסקי מדרדר בחן (חיוב → התראה לצוות) כשהיכולת חסרה.
// ════════════════════════════════════════════════════════
import { PmsProvider } from "./PmsProvider.js";
import { PmsNotConnectedError } from "./ApaleoPmsProvider.js";

export class OptimaPmsProvider extends PmsProvider {
  // credentials: { endpoint, apiUser, apiPassword, hotelCode, apiBase? }
  constructor(creds = {}) {
    super();
    this.endpoint    = creds.endpoint    || null;
    this.apiUser     = creds.apiUser     || null;
    this.apiPassword = creds.apiPassword || null;
    this.hotelCode   = creds.hotelCode   || null;
  }
  isConfigured() { return !!(this.endpoint && this.apiUser && this.apiPassword && this.hotelCode); }

  // יכולות שמרניות: קריאה + צ'ק אין/אאוט + סטטוס חדר. folio.post מודגש
  // *לא* — עד שיאושר מול Optima שצד ג' רשאי לרשום חיובים.
  capabilities = new Set([
    "reservation.read", "reservation.search", "checkin", "checkout",
    "folio.read", "housekeeping.read", "profile.read",
  ]);

  // 🔌 GET הזמנה לפי מספר אישור — קריאת XML ל-endpoint של Optima עם
  //    hotelCode + אישורי הזדהות; נרמל לאובייקט Reservation הקנוני שלנו.
  async getReservation()     { throw new PmsNotConnectedError("optima.getReservation"); }
  async searchReservations() { throw new PmsNotConnectedError("optima.searchReservations"); }
  async updateReservation()  { throw new PmsNotConnectedError("optima.updateReservation"); }
  async assignRoom()         { throw new PmsNotConnectedError("optima.assignRoom"); }
  async checkIn()            { throw new PmsNotConnectedError("optima.checkIn"); }
  async checkOut()           { throw new PmsNotConnectedError("optima.checkOut"); }
  async getFolio()           { throw new PmsNotConnectedError("optima.getFolio"); }
  async postCharge()         { throw new PmsNotConnectedError("optima.postCharge"); }
  async postPayment()        { throw new PmsNotConnectedError("optima.postPayment"); }
  async getRoomStatus()      { throw new PmsNotConnectedError("optima.getRoomStatus"); }
  async setRoomStatus()      { throw new PmsNotConnectedError("optima.setRoomStatus"); }
  async getGuestProfile()    { throw new PmsNotConnectedError("optima.getGuestProfile"); }
  async upsertGuestProfile() { throw new PmsNotConnectedError("optima.upsertGuestProfile"); }
  async getAvailability()    { throw new PmsNotConnectedError("optima.getAvailability"); }
  verifyWebhook()            { throw new PmsNotConnectedError("optima.verifyWebhook"); }
}
