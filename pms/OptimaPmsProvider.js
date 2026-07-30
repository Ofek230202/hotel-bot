// ════════════════════════════════════════════════════════
//  OptimaPmsProvider — Optima / Silverbyte (מוביל השוק בישראל)
//  ----------------------------------------------------------
//  ── מה מאומת (ראה OPTIMA_PMS.md למקורות) ──────────────
//  Optima מפותחת ע"י Silverbyte (נוסדה 1992, נשר), ש**נרכשה ע"י Priority
//  Software ביוני 2022** תמורת ₪120M. ~1,000 מלונות בעולם, **500+ בישראל**
//  (דן, פתאל/לאונרדו, ישרוטל, אורכיד, פרימה, NYX) — 85–90% מהשוק המקומי.
//  היא מנצחת דווקא בזכות התאמה לישראל: עברית/RTL ו**המס הישראלי** (חשבונית
//  מס-קבלה, מע"מ 18%, פטור 0% לתייר חוץ) — מה שספקים זרים לא עושים כראוי.
//
//  ── מה *לא* ידוע, ולמה זה מעצב את הקוד ────────────────
//  🔴 לאופטימה **אין פורטל מפתחים ציבורי ואין הרשמה עצמית**. הגישה מסחרית,
//     דרך המלון ובאישורו. לכן **מבנה ה-API המדויק מגיע רק עם המסמך שלהם**.
//
//  היה קל (ומפתה) להמציא כאן endpoints ולקרוא לזה "מימוש". זה היה מתפוצץ
//  ביום החיבור. במקום זה הקובץ הזה בנוי כך ש**כל מה שתלוי-ספק הוא קונפיג**:
//
//    • `protocol` — "rest" (JSON) או "xml". שניהם HTTP אמיתי, לא דמה.
//    • `paths`    — נתיב לכל פעולה. ברירות מחדל סבירות, **ניתנות לדריסה**.
//    • `fieldMap` — שמות השדות בתשובה. כל שדה מקבל **רשימת מועמדים**,
//                   ולכן שינוי שם שדה בין התקנות אינו שובר כלום.
//    • `auth`     — "basic" | "bearer" | "query".
//
//  כשיגיע המסמך: ממלאים קונפיג, לא כותבים קוד. אם משהו בכל זאת לא תואם —
//  משנים מיפוי אחד, לא לוגיקה עסקית.
//
//  ── רב-מלונות ─────────────────────────────────────────
//  מופע נפרד לכל מלון דרך `pmsFor(hotelId)`, עם ה-credentials של אותו מלון.
//  מלון א' על אופטימה ומלון ב' על Mews — באותו תהליך, בלי התנגשות.
// ════════════════════════════════════════════════════════
import { PmsProvider } from "./PmsProvider.js";
import { pmsFetch, PmsHttpError, PMS_ERROR, redactUrlSecrets } from "./http.js";
import {
  makeReservation, makeFolio, pick, toMinorUnits, toStayDate, ROOM_STATUS, toRoomStatus,
} from "./normalize.js";

// נזרקת כשמלון סומן "optima" אך אין credentials — כדי שהכשל יהיה ברור
// ולא ייראה כמו "ההזמנה לא נמצאה".
export class OptimaNotConfiguredError extends Error {
  constructor(op) {
    super(`Optima PMS is not configured (${op}). Set pms_credentials {baseUrl, apiUser, apiPassword, hotelCode} for this hotel — see OPTIMA_PMS.md §6.`);
    this.name = "OptimaNotConfiguredError";
    this.op = op;
    this.notConnected = true;
  }
}

// ברירות מחדל לנתיבים. ⚠️ **לאישור מול מסמך אופטימה** — כל אחד נדרס
// דרך `pms_credentials.paths`, ולכן אי-התאמה היא שינוי קונפיג ולא קוד.
const DEFAULT_PATHS = Object.freeze({
  getReservation:    "/api/reservations/{confirmationNumber}",
  searchReservations:"/api/reservations",
  updateReservation: "/api/reservations/{id}",
  assignRoom:        "/api/reservations/{id}/room",
  checkIn:           "/api/reservations/{id}/checkin",
  checkOut:          "/api/reservations/{id}/checkout",
  getFolio:          "/api/reservations/{id}/folio",
  postCharge:        "/api/reservations/{id}/folio/charges",
  postPayment:       "/api/reservations/{id}/folio/payments",
  getRoomStatus:     "/api/rooms/{room}",
  setRoomStatus:     "/api/rooms/{room}/status",
  getGuestProfile:   "/api/profiles/{id}",
  getAvailability:   "/api/availability",
});

// מיפוי שדות ברירת מחדל — כל שדה עם **מועמדים**, כי שמות משתנים בין
// התקנות וגרסאות. `pick` לוקח את הראשון שקיים.
const DEFAULT_FIELD_MAP = Object.freeze({
  id:                 ["id", "ReservationID", "reservationId", "ResID"],
  confirmationNumber: ["confirmationNumber", "ConfirmationNo", "confirmation", "ResNo", "reservationNumber"],
  status:             ["status", "Status", "ReservationStatus", "resStatus"],
  guestFirstName:     ["guest.firstName", "FirstName", "firstName", "GuestFirstName"],
  guestLastName:      ["guest.lastName", "LastName", "lastName", "GuestLastName"],
  guestName:          ["guest.fullName", "GuestName", "guestName", "fullName", "Name"],
  phone:              ["guest.phone", "Phone", "phone", "MobilePhone", "mobile"],
  email:              ["guest.email", "Email", "email"],
  nationality:        ["guest.nationality", "Nationality", "nationality", "Country"],
  roomNumber:         ["roomNumber", "RoomNo", "room", "Room", "unit"],
  roomType:           ["roomType", "RoomType", "categoryCode", "RoomCategory"],
  checkIn:            ["checkIn", "ArrivalDate", "arrival", "FromDate", "checkInDate"],
  checkOut:           ["checkOut", "DepartureDate", "departure", "ToDate", "checkOutDate"],
  adults:             ["adults", "Adults", "NumAdults", "paxAdults"],
  children:           ["children", "Children", "NumChildren", "paxChildren"],
  rateAmount:         ["rateAmount", "TotalPrice", "totalAmount", "Rate", "price"],
  currency:           ["currency", "Currency", "CurrencyCode"],
  balance:            ["balance", "Balance", "OpenBalance"],
  notes:              ["notes", "Remarks", "comment", "Comments"],
  // folio
  folioLines:         ["lines", "Transactions", "charges", "Charges", "items"],
  lineDescription:    ["description", "Description", "TransactionName", "name"],
  lineAmount:         ["amount", "Amount", "Total", "price"],
  lineDate:           ["date", "Date", "TransactionDate", "postingDate"],
  lineCategory:       ["category", "Category", "DepartmentCode", "type"],
  // room status
  roomStatusValue:    ["status", "Status", "HousekeepingStatus", "roomStatus"],
});

export class OptimaPmsProvider extends PmsProvider {
  /**
   * credentials (פר-מלון, מ-config.pms_credentials):
   *   baseUrl      — כתובת ה-API שאופטימה נתנו (חובה)
   *   apiUser      — שם משתמש (חובה ל-auth="basic")
   *   apiPassword  — סיסמה   (חובה ל-auth="basic")
   *   apiKey       — טוקן    (חלופה, ל-auth="bearer"/"query")
   *   hotelCode    — קוד המלון במערכת (חובה)
   *   protocol     — "rest" (ברירת מחדל) | "xml"
   *   auth         — "basic" (ברירת מחדל) | "bearer" | "query"
   *   paths        — דריסת נתיבים
   *   fieldMap     — דריסת שמות שדות
   *   canPostFolio — true רק אם אופטימה אישרו רישום חיוב לצד שלישי
   *   timeoutMs / attempts
   */
  constructor(creds = {}) {
    super();
    this.baseUrl     = (creds.baseUrl || creds.endpoint || "").replace(/\/+$/, "") || null;
    this.apiUser     = creds.apiUser     || null;
    this.apiPassword = creds.apiPassword || null;
    this.apiKey      = creds.apiKey      || null;
    this.hotelCode   = creds.hotelCode   || null;
    this.protocol    = String(creds.protocol || "rest").toLowerCase();
    this.auth        = String(creds.auth || (creds.apiKey ? "bearer" : "basic")).toLowerCase();
    this.paths       = { ...DEFAULT_PATHS, ...(creds.paths || {}) };
    this.fieldMap    = { ...DEFAULT_FIELD_MAP, ...(creds.fieldMap || {}) };
    this.timeoutMs   = Number(creds.timeoutMs) || 12_000;
    this.attempts    = Number(creds.attempts)  || 3;
    this.fetchImpl   = creds.fetchImpl || globalThis.fetch;

    // 🔴 folio.post אינו מובן מאליו: לאופטימה (כמו ל-OPERA legacy) יש
    //    לעיתים הגבלה על רישום חיובים מצד שלישי. לכן היכולת **מושבתת
    //    כברירת מחדל** ונדלקת רק כשהמלון/אופטימה אישרו במפורש. הקוד
    //    העסקי בודק `supports("folio.post")` ומדרדר בחן.
    const caps = [
      "reservation.read", "reservation.search", "checkin", "checkout",
      "room.assign", "folio.read", "housekeeping.read", "housekeeping.write",
      "profile.read",
    ];
    if (creds.canPostFolio) caps.push("folio.post", "folio.payment");
    this.capabilities = new Set(caps);
  }

  isConfigured() {
    if (!this.baseUrl || !this.hotelCode) return false;
    if (this.auth === "basic")  return !!(this.apiUser && this.apiPassword);
    return !!this.apiKey;
  }

  // ── בנייה של בקשה ─────────────────────────────────────
  #requireConfigured(op) { if (!this.isConfigured()) throw new OptimaNotConfiguredError(op); }

  #headers() {
    const h = { accept: this.protocol === "xml" ? "application/xml" : "application/json" };
    if (this.auth === "basic") {
      h.authorization = "Basic " + Buffer.from(`${this.apiUser}:${this.apiPassword}`).toString("base64");
    } else if (this.auth === "bearer") {
      h.authorization = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  // בונה URL: מחליף {placeholders}, מוסיף hotelCode, ומוסיף מפתח ב-query
  // אם זו שיטת ההזדהות. קידוד תמיד — מספר אישור עם רווח/סלאש לא ישבור.
  #url(pathKey, params = {}, query = {}) {
    const tpl = this.paths[pathKey] || pathKey;
    const path = tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(params[k] ?? "")));
    const q = new URLSearchParams();
    q.set("hotelCode", this.hotelCode);
    for (const [k, v] of Object.entries(query)) if (v != null && v !== "") q.set(k, String(v));
    if (this.auth === "query" && this.apiKey) q.set("apiKey", this.apiKey);
    return `${this.baseUrl}${path}?${q.toString()}`;
  }

  async #call(op, pathKey, { params = {}, query = {}, method = "GET", payload = null } = {}) {
    this.#requireConfigured(op);
    const headers = this.#headers();
    let body = null;
    if (payload != null) {
      if (this.protocol === "xml") {
        headers["content-type"] = "application/xml";
        body = typeof payload === "string" ? payload : objectToXml(payload);
      } else {
        headers["content-type"] = "application/json";
        body = JSON.stringify(payload);
      }
    }
    const { data } = await pmsFetch(this.#url(pathKey, params, query), {
      method, headers, body,
      timeoutMs: this.timeoutMs, attempts: this.attempts,
      provider: "optima", op,
      expect: this.protocol === "xml" ? "xml" : "json",
      fetchImpl: this.fetchImpl,
    });
    return this.protocol === "xml" ? xmlToObject(data) : data;
  }

  // ── מיפוי לתשובה קנונית ───────────────────────────────
  #toReservation(node) {
    if (!node || typeof node !== "object") return null;
    const f = this.fieldMap;
    const currency = pick(node, f.currency) || "ILS";
    return makeReservation({
      id:                 pick(node, f.id),
      confirmationNumber: pick(node, f.confirmationNumber),
      status:             pick(node, f.status),
      guestName:          pick(node, f.guestName),
      guestFirstName:     pick(node, f.guestFirstName),
      guestLastName:      pick(node, f.guestLastName),
      phone:              pick(node, f.phone),
      email:              pick(node, f.email),
      nationality:        pick(node, f.nationality),
      roomNumber:         pick(node, f.roomNumber),
      roomType:           pick(node, f.roomType),
      checkIn:            pick(node, f.checkIn),
      checkOut:           pick(node, f.checkOut),
      adults:             pick(node, f.adults),
      children:           pick(node, f.children),
      rateAmount:         toMinorUnits(pick(node, f.rateAmount)),
      balance:            toMinorUnits(pick(node, f.balance)),
      currency,
      notes:              pick(node, f.notes),
      hotelCode:          this.hotelCode,
      raw:                node,
    });
  }

  // ── הזמנות ────────────────────────────────────────────
  // 404 אינו תקלה אלא תשובה לגיטימית ("אין הזמנה כזו") → null, לא throw.
  async getReservation(query = {}) {
    const conf = typeof query === "string" ? query : (query.confirmationNumber || query.id);
    if (!conf) return null;
    try {
      const data = await this.#call("getReservation", "getReservation", { params: { confirmationNumber: conf, id: conf } });
      const node = firstRecord(data);
      return this.#toReservation(node);
    } catch (e) {
      if (e instanceof PmsHttpError && e.kind === PMS_ERROR.NOT_FOUND) return null;
      throw e;
    }
  }

  async searchReservations(query = {}) {
    const data = await this.#call("searchReservations", "searchReservations", {
      query: {
        phone: query.phone, lastName: query.lastName, email: query.email,
        arrivalDate: toStayDate(query.checkIn), departureDate: toStayDate(query.checkOut),
      },
    });
    return recordList(data).map(n => this.#toReservation(n)).filter(Boolean);
  }

  async updateReservation(id, patch = {}) {
    const data = await this.#call("updateReservation", "updateReservation", { params: { id }, method: "PATCH", payload: patch });
    return this.#toReservation(firstRecord(data));
  }

  // ── צ'ק אין / אאוט / הקצאת חדר ────────────────────────
  async assignRoom(id, opts = {}) {
    const data = await this.#call("assignRoom", "assignRoom", {
      params: { id }, method: "POST",
      payload: { roomNumber: opts.roomNumber ?? null, roomType: opts.roomType ?? null },
    });
    const node = firstRecord(data);
    return { roomNumber: pick(node, this.fieldMap.roomNumber) ?? opts.roomNumber ?? null, raw: node };
  }

  async checkIn(id)  { const d = await this.#call("checkIn",  "checkIn",  { params: { id }, method: "POST" }); return { ok: true, raw: firstRecord(d) }; }
  async checkOut(id) { const d = await this.#call("checkOut", "checkOut", { params: { id }, method: "POST" }); return { ok: true, raw: firstRecord(d) }; }

  // ── Folio ─────────────────────────────────────────────
  async getFolio(id) {
    const data = await this.#call("getFolio", "getFolio", { params: { id } });
    const node = firstRecord(data) || {};
    const f = this.fieldMap;
    const rawLines = pick(node, f.folioLines) || [];
    const lines = (Array.isArray(rawLines) ? rawLines : [rawLines]).map(l => ({
      description: pick(l, f.lineDescription),
      amount:      toMinorUnits(pick(l, f.lineAmount)),
      date:        pick(l, f.lineDate),
      category:    pick(l, f.lineCategory),
    }));
    return makeFolio({
      id,
      lines,
      balance: toMinorUnits(pick(node, f.balance)),
      currency: pick(node, f.currency) || "ILS",
      raw: node,
    });
  }

  // 🔴 שומר סף: אם היכולת לא אושרה, נכשלים **מיד ובבירור** במקום לשלוח
  //    בקשה שתיפול אצל אופטימה. הקורא (checkin.js) בודק `supports` ומנתב
  //    את החיוב לצוות — האורח לא מרגיש כלום.
  async postCharge(id, charge = {}) {
    if (!this.supports("folio.post")) {
      throw new PmsHttpError(PMS_ERROR.BAD_REQUEST, "folio.post not enabled for this hotel (set canPostFolio after Optima approves it)", { provider: "optima", op: "postCharge" });
    }
    const d = await this.#call("postCharge", "postCharge", {
      params: { id }, method: "POST",
      payload: {
        description: charge.description ?? null,
        amount: charge.amount != null ? charge.amount / 100 : null, // אגורות → יחידות
        currency: charge.currency || "ILS",
        category: charge.category ?? null,
      },
    });
    return { ok: true, raw: firstRecord(d) };
  }

  async postPayment(id, payment = {}) {
    if (!this.supports("folio.payment")) {
      throw new PmsHttpError(PMS_ERROR.BAD_REQUEST, "folio.payment not enabled for this hotel", { provider: "optima", op: "postPayment" });
    }
    const d = await this.#call("postPayment", "postPayment", {
      params: { id }, method: "POST",
      payload: { amount: payment.amount != null ? payment.amount / 100 : null, method: payment.method || "card" },
    });
    return { ok: true, raw: firstRecord(d) };
  }

  // ── משק בית ───────────────────────────────────────────
  async getRoomStatus(room) {
    const data = await this.#call("getRoomStatus", "getRoomStatus", { params: { room } });
    const node = firstRecord(data);
    return { room: String(room), status: toRoomStatus(pick(node, this.fieldMap.roomStatusValue)), raw: node };
  }

  async setRoomStatus(room, status) {
    const d = await this.#call("setRoomStatus", "setRoomStatus", {
      params: { room }, method: "POST", payload: { status: String(status || ROOM_STATUS.DIRTY) },
    });
    return { ok: true, raw: firstRecord(d) };
  }

  // ── פרופיל / זמינות ───────────────────────────────────
  async getGuestProfile(id) {
    const data = await this.#call("getGuestProfile", "getGuestProfile", { params: { id } });
    const node = firstRecord(data);
    if (!node) return null;
    const f = this.fieldMap;
    return {
      id: String(id),
      name:  pick(node, f.guestName) || [pick(node, f.guestFirstName), pick(node, f.guestLastName)].filter(Boolean).join(" ") || null,
      phone: pick(node, f.phone), email: pick(node, f.email),
      nationality: pick(node, f.nationality), raw: node,
    };
  }

  async upsertGuestProfile() {
    throw new PmsHttpError(PMS_ERROR.BAD_REQUEST, "profile.write not supported for Optima yet — confirm with the vendor", { provider: "optima", op: "upsertGuestProfile" });
  }

  async getAvailability(query = {}) {
    const data = await this.#call("getAvailability", "getAvailability", {
      query: { from: toStayDate(query.from), to: toStayDate(query.to) },
    });
    return recordList(data);
  }

  verifyWebhook() {
    // אופטימה לא מתעדת webhooks ציבוריים. עד לאישור — לא מתיימרים לאמת.
    throw new PmsHttpError(PMS_ERROR.BAD_REQUEST, "webhooks not confirmed for Optima", { provider: "optima", op: "verifyWebhook" });
  }

  // ── describe() — מה בדיוק ייצא לרשת ───────────────────
  // לשיחה עם אופטימה ולאבחון: מדפיס את הכתובות המדויקות ואת שיטת ההזדהות,
  // **בלי שום סוד**. זה מה שמאפשר לשאול אותם "זה הנתיב הנכון?" לפני חיבור.
  describe() {
    return {
      provider: "optima",
      configured: this.isConfigured(),
      baseUrl: this.baseUrl,
      hotelCode: this.hotelCode,
      protocol: this.protocol,
      auth: this.auth,
      credentialsPresent: {
        apiUser: !!this.apiUser, apiPassword: !!this.apiPassword, apiKey: !!this.apiKey,
      },
      capabilities: [...this.capabilities].sort(),
      // 🔴 ב-auth="query" המפתח נכנס ל-URL עצמו, ולכן דוגמת URL "תמימה"
      //    הייתה מדליפה אותו לכל מקום שאליו מדביקים את הפלט (מייל לספק,
      //    לוג, טיקט תמיכה). מסננים תמיד — לא רק כשנוח.
      sampleUrls: this.isConfigured() ? {
        getReservation: redactUrlSecrets(this.#url("getReservation", { confirmationNumber: "ABC123", id: "ABC123" })),
        getFolio:       redactUrlSecrets(this.#url("getFolio", { id: "ABC123" })),
        checkIn:        redactUrlSecrets(this.#url("checkIn", { id: "ABC123" })),
      } : null,
    };
  }
}

// ── עזרי מבנה תשובה ─────────────────────────────────────
// ספקים עוטפים רשומות בצורות שונות: מערך, {data:[…]}, {Reservations:{…}}.
// שתי הפונקציות האלה מוציאות רשומה/רשימה בלי להניח מבנה אחד.
export function firstRecord(data) {
  if (data == null) return null;
  if (Array.isArray(data)) return data[0] ?? null;
  if (typeof data !== "object") return null;
  for (const key of ["data", "result", "Result", "Reservation", "Reservations", "items", "records"]) {
    if (data[key] != null) {
      const v = data[key];
      return Array.isArray(v) ? (v[0] ?? null) : v;
    }
  }
  return data;
}

export function recordList(data) {
  if (data == null) return [];
  if (Array.isArray(data)) return data;
  if (typeof data !== "object") return [];
  for (const key of ["data", "result", "Result", "Reservations", "items", "records"]) {
    const v = data[key];
    if (Array.isArray(v)) return v;
    if (v != null && typeof v === "object") return [v];
  }
  return [data];
}

// ── XML מינימלי ─────────────────────────────────────────
// אופטימה ותיקה עובדת ב-XML. אין תלות חיצונית (הפרויקט מחזיק 5 תלויות
// בלבד), ולכן ממיר קטן ומכוון-מטרה: מספיק למבנה שטוח/מקונן של רשומות.
// ⚠️ אינו XML parser כללי; אם אופטימה יחזירו מבנה מורכב — כאן מחליפים
//    לספרייה ייעודית, במקום אחד.
export function objectToXml(obj, root = "Request") {
  const esc = (s) => String(s).replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
  const body = Object.entries(obj || {})
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => (v && typeof v === "object" ? objectToXml(v, k) : `<${k}>${esc(v)}</${k}>`))
    .join("");
  return `<${root}>${body}</${root}>`;
}

export function xmlToObject(xml) {
  if (typeof xml !== "string") return xml;
  const strip = xml.replace(/<\?xml[^>]*\?>/g, "").trim();
  const parse = (s) => {
    const out = {};
    const re = /<([\w:.-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>|<([\w:.-]+)(?:\s[^>]*)?\/>/g;
    let m, found = false;
    while ((m = re.exec(s)) !== null) {
      found = true;
      const tag = (m[1] || m[3]).replace(/^.*:/, "");
      const inner = m[2] ?? "";
      const value = /<[\w:.-]+/.test(inner) ? parse(inner) : decodeEntities(inner.trim());
      if (out[tag] === undefined) out[tag] = value;
      else if (Array.isArray(out[tag])) out[tag].push(value);
      else out[tag] = [out[tag], value];
    }
    return found ? out : decodeEntities(s.trim());
  };
  const parsed = parse(strip);
  // מסירים עטיפת שורש יחידה (<Response>…</Response>) כדי שהמיפוי יראה
  // את הרשומה עצמה ולא את המעטפת.
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed);
    if (keys.length === 1 && parsed[keys[0]] && typeof parsed[keys[0]] === "object") return parsed[keys[0]];
  }
  return parsed;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
