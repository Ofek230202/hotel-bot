// ════════════════════════════════════════════════════════
//  MockPmsProvider — ברירת המחדל: המאגר המובנה הוא מקור האמת
//  ----------------------------------------------------------
//  כל עוד אין PMS אמיתי מחובר, ה-Mock מסמן "אין מערכת חיצונית" — ולכן
//  הקוד הקיים (checkin.js) ממשיך להיות מקור האמת בדיוק כמו היום, בלי
//  שום שינוי התנהגות. השיטות מחזירות ערכי דמו סבירים (או null) במקום
//  לזרוק, כדי שקוד שכבר קורא ל-PMS דרך הממשק לא ייפול.
//
//  זו בדיוק הסיבה שהחיבור "מוכן": כשמלון יחבר PMS אמיתי (pms_provider=
//  "apaleo" וכו'), checkin.js יתחיל לשלוף הזמנה אמיתית, להקצות חדר
//  אמיתי ולרשום folio ל-PMS — בלי לשכתב את הלוגיקה, רק להפעיל את הספק.
// ════════════════════════════════════════════════════════
import { PmsProvider } from "./PmsProvider.js";

export class MockPmsProvider extends PmsProvider {
  isMock = true;

  // אין רשומה חיצונית — הקורא נשען על המאגר המובנה (checkin.js).
  async getReservation()     { return null; }
  async searchReservations() { return []; }
  async updateReservation()  { return null; }

  // אין הקצאה חיצונית — הקורא משאיר את ברירת המחדל שלו (למשל "304" בדמו).
  async assignRoom()         { return { roomNumber: null }; }
  async checkIn()            { return { ok: true, mock: true }; }
  async checkOut()           { return { ok: true, mock: true }; }

  // ה-folio המובנה (checkin.js) הוא מקור האמת בדמו.
  async getFolio()           { return { lines: [], balance: 0, currency: "ILS", mock: true }; }
  async postCharge()         { return { ok: true, mock: true }; }
  async postPayment()        { return { ok: true, mock: true }; }

  // בדמו החדר תמיד "נקי" — הסטטוס האמיתי מגיע מ-PMS כשמחובר.
  async getRoomStatus()      { return { status: "clean", mock: true }; }
  async setRoomStatus()      { return { ok: true, mock: true }; }

  async getGuestProfile()    { return null; }
  async upsertGuestProfile() { return { ok: true, mock: true }; }
  async getAvailability()    { return []; }

  verifyWebhook()            { return { valid: true, mock: true }; }
}
