// ════════════════════════════════════════════════════════
//  RestPmsProvider — מנוע גנרי שמריץ **מפרט ספק** (vendors.js)
//  ----------------------------------------------------------
//  כל ספקי ה-PMS עושים את אותם דברים: מזדהים, שולחים בקשה, מקבלים
//  רשומה, וממפים אותה. ההבדלים ביניהם — שיטת ההזדהות, הנתיבים ושמות
//  השדות — הם **נתונים**, לא לוגיקה. לכן יש מנוע אחד ומפרט לכל ספק.
//
//  היתרון האמיתי: תיקון באג בטיפול בשגיאות, ב-retry או במיפוי — מתקן
//  את **כל** הספקים בבת אחת. עם 12 מחלקות נפרדות זה 12 תיקונים, ואחד
//  מהם תמיד נשכח.
//
//  שיטות הזדהות נתמכות:
//    • "oauth2"      — client credentials → Bearer (עם cache לטוקן)
//    • "bearer"      — מפתח קבוע בכותרת Authorization
//    • "basic"       — שם משתמש + סיסמה
//    • "body_tokens" — טוקנים ב**גוף** הבקשה (Mews)
//  וכן `extraHeaders` לכותרות ייחודיות (למשל `x-app-key` של OHIP).
// ════════════════════════════════════════════════════════
import { PmsProvider } from "./PmsProvider.js";
import { pmsFetch, PmsHttpError, PMS_ERROR, redactUrlSecrets } from "./http.js";
import { makeReservation, makeFolio, pick, toMinorUnits, toStayDate, toRoomStatus, ROOM_STATUS } from "./normalize.js";
import { vendorSpec, missingCredentials } from "./vendors.js";
import { firstRecord, recordList } from "./OptimaPmsProvider.js";

export class PmsUnsupportedError extends Error {
  constructor(vendor, op) {
    super(`PMS "${vendor}" does not support "${op}" — check capabilities before calling (callers should degrade gracefully).`);
    this.name = "PmsUnsupportedError";
    this.op = op;
    this.unsupported = true;
  }
}

export class PmsNotConfiguredError extends Error {
  constructor(vendor, missing = []) {
    const list = missing.map(m => m.labelHe || m.key).join(", ");
    super(`PMS "${vendor}" is not configured — missing: ${list || "credentials"}. See PMS_GUIDE.md.`);
    this.name = "PmsNotConfiguredError";
    this.vendor = vendor;
    this.missing = missing;
    this.notConnected = true;
  }
}

export class RestPmsProvider extends PmsProvider {
  constructor(vendorId, creds = {}) {
    super();
    const spec = vendorSpec(vendorId);
    if (!spec) throw new Error(`Unknown PMS vendor "${vendorId}"`);
    this.spec   = spec;
    this.vendor = spec.id;
    this.creds  = creds;

    // baseUrl: מהקונפיג של המלון, ואם אין — ברירת המחדל של הספק.
    // sandbox נבחר במפורש, כדי שלא נגיע לפרודקשן של מלון בטעות.
    this.baseUrl = String(creds.baseUrl || (creds.sandbox && spec.sandboxUrl) || spec.baseUrl || "").replace(/\/+$/, "");
    this.paths     = { ...spec.paths, ...(creds.paths || {}) };
    this.fieldMap  = { ...spec.fieldMap, ...(creds.fieldMap || {}) };
    this.timeoutMs = Number(creds.timeoutMs) || 12_000;
    this.attempts  = Number(creds.attempts)  || 3;
    this.fetchImpl = creds.fetchImpl || globalThis.fetch;

    // יכולות: מהמפרט, אך המלון יכול לצמצם (`disable`) — למשל כשספק
    // תומך ברישום חיוב אבל המלון לא אישר אותו.
    const disabled = new Set(creds.disable || []);
    this.capabilities = new Set((spec.capabilities || []).filter(c => !disabled.has(c)));

    this._token = null;       // { value, expiresAt }
  }

  isConfigured() {
    if (!this.baseUrl) return false;
    return missingCredentials(this.vendor, this.creds).ok;
  }

  #requireConfigured() {
    const m = missingCredentials(this.vendor, this.creds);
    if (!this.baseUrl) m.missing.unshift({ key: "baseUrl", labelHe: "כתובת ה-API" });
    if (!m.ok || !this.baseUrl) throw new PmsNotConfiguredError(this.vendor, m.missing);
  }

  // ── הזדהות ────────────────────────────────────────────
  async #authHeaders() {
    const a = this.spec.auth || {};
    const h = { accept: "application/json" };

    // כותרות ייחודיות לספק (למשל x-app-key של OHIP) — הערך מגיע
    // מה-credentials של המלון, לפי המיפוי במפרט.
    for (const [header, credKey] of Object.entries(a.extraHeaders || {})) {
      const v = this.creds[credKey];
      if (v) h[header] = String(v);
    }

    if (a.style === "basic") {
      h.authorization = "Basic " + Buffer.from(`${this.creds.apiUser}:${this.creds.apiPassword}`).toString("base64");
    } else if (a.style === "bearer") {
      const key = this.creds.apiKey || this.creds.accessToken || this.creds.token;
      if (key) h.authorization = `Bearer ${key}`;
    } else if (a.style === "oauth2") {
      h.authorization = `Bearer ${await this.#oauthToken()}`;
    }
    // body_tokens — אין כותרת; הטוקנים מוזרקים לגוף ב-#call.
    return h;
  }

  // טוקן OAuth2 עם cache. מרווח ביטחון של 60 שניות מונע שימוש בטוקן
  // שפג בדיוק בזמן הבקשה — כשל שנראה אקראי ולכן קשה מאוד לאבחן.
  async #oauthToken() {
    const now = Date.now();
    if (this._token && this._token.expiresAt > now + 60_000) return this._token.value;

    const a = this.spec.auth || {};
    const tokenUrl = this.creds.tokenUrl || (a.tokenUrlFromCreds ? this.creds[a.tokenUrlFromCreds] : null) || a.tokenUrl;
    if (!tokenUrl) throw new PmsNotConfiguredError(this.vendor, [{ key: "tokenUrl", labelHe: "כתובת ה-OAuth" }]);

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.creds.clientId || "",
      client_secret: this.creds.clientSecret || "",
    });
    const scope = this.creds.scope || a.scopeDefault;
    if (scope) body.set("scope", scope);

    const { data } = await pmsFetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      timeoutMs: this.timeoutMs, attempts: 2,
      provider: this.vendor, op: "oauth", fetchImpl: this.fetchImpl,
    });
    const value = data?.access_token || data?.accessToken;
    if (!value) throw new PmsHttpError(PMS_ERROR.AUTH, "no access_token in OAuth response", { provider: this.vendor, op: "oauth" });
    const ttl = Number(data?.expires_in || 3600) * 1000;
    this._token = { value, expiresAt: Date.now() + ttl };
    return value;
  }

  // ── בניית בקשה ────────────────────────────────────────
  #url(op, params = {}, query = {}) {
    const tpl = this.paths[op];
    if (!tpl) throw new PmsUnsupportedError(this.vendor, op);
    const merged = { ...this.creds, ...params };  // מאפשר {hotelId} מה-credentials
    const path = tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(merged[k] ?? "")));
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v != null && v !== "") q.set(k, String(v));
    const qs = q.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  }

  async #call(op, { params = {}, query = {}, method, payload = null } = {}) {
    this.#requireConfigured();
    if (!this.paths[op]) throw new PmsUnsupportedError(this.vendor, op);

    const m = method || this.spec.defaultMethod || "GET";
    const headers = await this.#authHeaders();
    let body = null, sendPayload = payload;

    // Mews: הטוקנים נוסעים בגוף. כאן — ורק כאן — זה מטופל.
    if (this.spec.auth?.style === "body_tokens") {
      const tokens = {};
      for (const [field, credKey] of Object.entries(this.spec.auth.tokenFields || {})) {
        if (this.creds[credKey]) tokens[field] = this.creds[credKey];
      }
      sendPayload = { ...tokens, ...(payload || {}), ...(query || {}) };
    }

    if (sendPayload != null && m !== "GET") {
      headers["content-type"] = "application/json";
      body = JSON.stringify(sendPayload);
    }

    const url = this.#url(op, params, m === "GET" ? query : {});
    const { data } = await pmsFetch(url, {
      method: m, headers, body,
      timeoutMs: this.timeoutMs, attempts: this.attempts,
      provider: this.vendor, op, expect: "json", fetchImpl: this.fetchImpl,
    });
    return data;
  }

  // ── מיפוי לתשובה קנונית ───────────────────────────────
  #toReservation(node) {
    if (!node || typeof node !== "object") return null;
    const f = this.fieldMap;
    return makeReservation({
      id: pick(node, f.id), confirmationNumber: pick(node, f.confirmationNumber),
      status: pick(node, f.status),
      guestName: pick(node, f.guestName),
      guestFirstName: pick(node, f.guestFirstName), guestLastName: pick(node, f.guestLastName),
      phone: pick(node, f.phone), email: pick(node, f.email), nationality: pick(node, f.nationality),
      roomNumber: pick(node, f.roomNumber), roomType: pick(node, f.roomType),
      checkIn: pick(node, f.checkIn), checkOut: pick(node, f.checkOut),
      adults: pick(node, f.adults), children: pick(node, f.children),
      rateAmount: toMinorUnits(pick(node, f.rateAmount)),
      balance: toMinorUnits(pick(node, f.balance)),
      currency: pick(node, f.currency) || "ILS",
      notes: pick(node, f.notes),
      hotelCode: this.creds.hotelId || this.creds.propertyId || this.creds.hotelCode || null,
      raw: node,
    });
  }

  // ── פעולות ────────────────────────────────────────────
  async getReservation(query = {}) {
    const id = typeof query === "string" ? query : (query.id || query.confirmationNumber);
    if (!id) return null;
    try {
      const data = await this.#call("getReservation", {
        params: { id, confirmationNumber: id },
        query: { id, reservationId: id },
      });
      return this.#toReservation(firstRecord(data));
    } catch (e) {
      if (e instanceof PmsHttpError && e.kind === PMS_ERROR.NOT_FOUND) return null;
      throw e;
    }
  }

  async searchReservations(query = {}) {
    const data = await this.#call("searchReservations", {
      query: {
        phone: query.phone, lastName: query.lastName, email: query.email,
        from: toStayDate(query.checkIn), to: toStayDate(query.checkOut),
      },
    });
    return recordList(data).map(n => this.#toReservation(n)).filter(Boolean);
  }

  async updateReservation(id, patch = {}) {
    const data = await this.#call("updateReservation", { params: { id }, method: "PATCH", payload: patch });
    return this.#toReservation(firstRecord(data));
  }

  async assignRoom(id, opts = {}) {
    if (!this.supports("room.assign")) throw new PmsUnsupportedError(this.vendor, "room.assign");
    const data = await this.#call("assignRoom", { params: { id }, method: "POST", payload: { roomNumber: opts.roomNumber ?? null } });
    const node = firstRecord(data);
    return { roomNumber: pick(node, this.fieldMap.roomNumber) ?? opts.roomNumber ?? null, raw: node };
  }

  async checkIn(id)  { this.#need("checkin");  const d = await this.#call("checkIn",  { params: { id }, method: "POST" }); return { ok: true, raw: firstRecord(d) }; }
  async checkOut(id) { this.#need("checkout"); const d = await this.#call("checkOut", { params: { id }, method: "POST" }); return { ok: true, raw: firstRecord(d) }; }

  async getFolio(id) {
    this.#need("folio.read");
    const data = await this.#call("getFolio", { params: { id }, query: { reservationId: id } });
    const node = firstRecord(data) || {};
    const f = this.fieldMap;
    const raw = pick(node, f.folioLines) || (Array.isArray(data) ? data : []);
    const lines = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(l => ({
      description: pick(l, f.lineDescription),
      amount: toMinorUnits(pick(l, f.lineAmount)),
      date: pick(l, f.lineDate),
      category: pick(l, f.lineCategory),
    }));
    return makeFolio({ id, lines, balance: toMinorUnits(pick(node, f.balance)), currency: pick(node, f.currency) || "ILS", raw: node });
  }

  async postCharge(id, charge = {}) {
    this.#need("folio.post");
    const d = await this.#call("postCharge", {
      params: { id }, method: "POST",
      payload: {
        reservationId: id,
        description: charge.description ?? null,
        amount: charge.amount != null ? charge.amount / 100 : null,  // אגורות → יחידות
        currency: charge.currency || "ILS",
        category: charge.category ?? null,
      },
    });
    return { ok: true, raw: firstRecord(d) };
  }

  async postPayment(id, payment = {}) {
    this.#need("folio.payment");
    const d = await this.#call("postPayment", {
      params: { id }, method: "POST",
      payload: { reservationId: id, amount: payment.amount != null ? payment.amount / 100 : null, method: payment.method || "card" },
    });
    return { ok: true, raw: firstRecord(d) };
  }

  async getRoomStatus(room) {
    this.#need("housekeeping.read");
    const data = await this.#call("getRoomStatus", { params: { room }, query: { room } });
    const node = firstRecord(data);
    return { room: String(room), status: toRoomStatus(pick(node, this.fieldMap.roomStatusValue)), raw: node };
  }

  async setRoomStatus(room, status) {
    this.#need("housekeeping.write");
    const d = await this.#call("setRoomStatus", { params: { room }, method: "POST", payload: { status: String(status || ROOM_STATUS.DIRTY) } });
    return { ok: true, raw: firstRecord(d) };
  }

  async getGuestProfile(id) {
    this.#need("profile.read");
    const data = await this.#call("getGuestProfile", { params: { id } });
    const node = firstRecord(data);
    if (!node) return null;
    const f = this.fieldMap;
    return {
      id: String(id),
      name: pick(node, f.guestName) || [pick(node, f.guestFirstName), pick(node, f.guestLastName)].filter(Boolean).join(" ") || null,
      phone: pick(node, f.phone), email: pick(node, f.email), nationality: pick(node, f.nationality), raw: node,
    };
  }

  async upsertGuestProfile(profile = {}) {
    this.#need("profile.write");
    const d = await this.#call("upsertGuestProfile", { method: "POST", payload: profile });
    return { ok: true, raw: firstRecord(d) };
  }

  async getAvailability(query = {}) {
    const data = await this.#call("getAvailability", { query: { from: toStayDate(query.from), to: toStayDate(query.to) } });
    return recordList(data);
  }

  verifyWebhook() {
    if (!this.supports("webhooks")) throw new PmsUnsupportedError(this.vendor, "webhooks");
    // אימות חתימה הוא פר-ספק ומגיע עם המסמך שלו. עד אז לא מתיימרים לאמת —
    // "אימות" שמחזיר תמיד true גרוע מאין אימות, כי הוא יוצר ביטחון שווא.
    throw new PmsUnsupportedError(this.vendor, "verifyWebhook (signature spec required)");
  }

  #need(cap) { if (!this.supports(cap)) throw new PmsUnsupportedError(this.vendor, cap); }

  // תיאור לאבחון ולשיחה עם הספק — בלי שום סוד.
  describe() {
    const miss = missingCredentials(this.vendor, this.creds);
    return {
      provider: this.vendor,
      label: this.spec.label, labelHe: this.spec.labelHe,
      configured: this.isConfigured(),
      missing: miss.missing,
      baseUrl: this.baseUrl || null,
      authStyle: this.spec.auth?.style || null,
      capabilities: [...this.capabilities].sort(),
      operations: Object.keys(this.paths).sort(),
      docsUrl: this.spec.docsUrl || null,
      sampleUrl: (() => {
        try { return redactUrlSecrets(this.#url("getReservation", { id: "ABC123", confirmationNumber: "ABC123" })); }
        catch { return null; }
      })(),
    };
  }
}
