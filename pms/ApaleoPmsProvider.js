// ════════════════════════════════════════════════════════
//  ApaleoPmsProvider — 🔌 חיבור אמיתי ל-PMS (scaffold, Part ט')
//  ----------------------------------------------------------
//  Apaleo נבחר כיעד הראשון: REST מודרני, OAuth2 עם scopes, webhooks,
//  וחשבון מפתחים בהרשמה עצמית (ה-onboarding הקל ביותר). אותו scaffold
//  מתאים גם ל-Mews / Cloudbeds / Opera-OHIP — מחליפים את גוף השיטות,
//  הממשק והקוד העסקי לא משתנים.
//
//  ⚠️ סטטוס: השיטות זורקות PmsNotConnectedError בכוונה — כל שיטה מתעדת
//     איזו קריאת Apaleo לבצע במקומה. חיבור אמיתי = מילוי הגוף (fetch +
//     OAuth token) והסרת ה-throw.
//
//  Auth: OAuth2 client credentials → Bearer token; scopes כמו
//        'reservations.read', 'folios.read', 'folios.manage'.
//  Base: https://api.apaleo.com/  ·  Docs: https://apaleo.dev/
// ════════════════════════════════════════════════════════
import { PmsProvider } from "./PmsProvider.js";

export class PmsNotConnectedError extends Error {
  constructor(op) {
    super(`PMS "${op}" not connected — wiring scaffold. Fill in the Apaleo REST call in pms/ApaleoPmsProvider.js (${op}), set pms_credentials, then remove this throw.`);
    this.name = "PmsNotConnectedError";
    this.op = op;
    this.notConnected = true;
  }
}

export class ApaleoPmsProvider extends PmsProvider {
  // credentials: { clientId, clientSecret, propertyId, apiBase? }
  constructor(creds = {}) {
    super();
    this.clientId     = creds.clientId     || null;
    this.clientSecret = creds.clientSecret || null;
    this.propertyId   = creds.propertyId   || null;
    this.apiBase      = creds.apiBase      || "https://api.apaleo.com";
  }
  // Apaleo (REST מודרני) תומך בכל הפעולות — כולל post folio ו-webhooks.
  capabilities = new Set([
    "reservation.read", "reservation.search", "checkin", "checkout", "room.assign",
    "folio.read", "folio.post", "folio.payment", "housekeeping.read", "housekeeping.write",
    "profile.read", "profile.write", "webhooks",
  ]);
  isConfigured() { return !!(this.clientId && this.clientSecret && this.propertyId); }

  // 🔌 GET /booking/v1/reservations?bookingId=... או חיפוש לפי מספר אישור.
  async getReservation()     { throw new PmsNotConnectedError("getReservation"); }
  async searchReservations() { throw new PmsNotConnectedError("searchReservations"); }
  async updateReservation()  { throw new PmsNotConnectedError("updateReservation"); }
  // 🔌 PATCH reservation → unit assignment; POST check-in action.
  async assignRoom()         { throw new PmsNotConnectedError("assignRoom"); }
  async checkIn()            { throw new PmsNotConnectedError("checkIn"); }
  async checkOut()           { throw new PmsNotConnectedError("checkOut"); }
  // 🔌 GET /finance/v1/folios/{id} ; POST charges.
  async getFolio()           { throw new PmsNotConnectedError("getFolio"); }
  async postCharge()         { throw new PmsNotConnectedError("postCharge"); }
  async postPayment()        { throw new PmsNotConnectedError("postPayment"); }
  // 🔌 GET/PUT /inventory/v1/units/{id} maintenance/housekeeping status.
  async getRoomStatus()      { throw new PmsNotConnectedError("getRoomStatus"); }
  async setRoomStatus()      { throw new PmsNotConnectedError("setRoomStatus"); }
  async getGuestProfile()    { throw new PmsNotConnectedError("getGuestProfile"); }
  async upsertGuestProfile() { throw new PmsNotConnectedError("upsertGuestProfile"); }
  // 🔌 GET /availability/v1/... (רק אם מוסיפים הזמנה אמיתית, לא רק פיקדון).
  async getAvailability()    { throw new PmsNotConnectedError("getAvailability"); }
  // 🔌 אימות webhook של Apaleo (חתימה/סוד משותף) לעדכוני הזמנה/folio.
  verifyWebhook()            { throw new PmsNotConnectedError("verifyWebhook"); }
}
