// ════════════════════════════════════════════════════════
//  CardComProvider — סליקה ישראלית אמיתית (CardCom API v11)
//  ----------------------------------------------------------
//  ── המודל של CardCom, בקצרה ────────────────────────────
//  • **הזדהות:** `TerminalNumber` + `ApiName` בכל בקשה. `ApiPassword`
//    נדרש רק לזיכויים ולהפקת מסמכים — ולכן הוא אופציונלי כאן.
//  • **LowProfile** — עמוד סליקה **מתארח** של CardCom. יוצרים אותו
//    בקריאת API, מקבלים `Url`, ושולחים אליו את האורח.
//    🔴 זו הנקודה הקריטית: פרטי הכרטיס **לעולם לא עוברים דרך השרת
//    שלנו**. זו הדרך היחידה שאינה גוררת אותנו לתחולת PCI-DSS מלאה.
//  • **תשובה:** `ResponseCode: 0` = הצלחה. כל ערך אחר הוא כשל, ו-
//    `Description` מסביר. אין קודי HTTP שגיאה — **200 עם ResponseCode
//    שאינו 0 הוא כשל**, וזו טעות קלאסית שגורמת ל"תשלום שהצליח" מדומה.
//
//  ── מה עדיין דורש אישור מול CardCom ────────────────────
//  ⚠️ הסמנטיקה המדויקת של **הקפאה** (hold/J5) מול חיוב מלא משתנה לפי
//     הגדרת הטרמינל. לכן `Operation` ושמות הנתיבים הם **קונפיג**, לא
//     קוד: ברירת מחדל `ChargeAndCreateToken` (מקבלים טוקן ללכידה
//     מאוחרת), וניתן לשנות ל-`SuspendedDeal` בלי לגעת בקוד.
//     אותה גישה כמו ב-`pms/` — לא ממציאים, מאפשרים להתאים.
//
//  📄 תיעוד: https://secure.cardcom.solutions/Api/v11/Docs
// ════════════════════════════════════════════════════════
import { PaymentProvider } from "./PaymentProvider.js";

export class PaymentNotConnectedError extends Error {
  constructor(op, detail = "") {
    super(
      `CardCom "${op}" is not configured${detail ? ` — ${detail}` : ""}. ` +
      `Set the hotel's payment_credentials { terminalNumber, apiName } — see CLAUDE.md §5.`
    );
    this.name = "PaymentNotConnectedError";
    this.op   = op;
    this.notConnected = true;
  }
}

/** כשל שהגיע מ-CardCom עצמו (ResponseCode ≠ 0, או תקלת רשת). */
export class CardComError extends Error {
  constructor(op, code, description, { retryable = false } = {}) {
    super(`CardCom ${op} failed (${code}): ${description}`);
    this.name = "CardComError";
    this.op = op;
    this.code = code;
    this.description = description;
    this.retryable = retryable;
  }
}

// שקלים → CardCom עובד ביחידות (₪), אנחנו באגורות. המרה במקום אחד.
const toUnits = (agorot) => Math.round(Number(agorot || 0)) / 100;

export class CardComProvider extends PaymentProvider {
  /**
   * credentials (פר-מלון, מ-config.payment_credentials — לעולם לא בקוד):
   *   terminalNumber, apiName          — חובה
   *   apiPassword                      — לזיכויים/מסמכים
   *   apiBase                          — ברירת מחדל: הייצור
   *   operation                        — ברירת מחדל ChargeAndCreateToken
   *   isoCoinId                        — 1 = ILS
   *   paths                            — דריסת נתיבים
   *   timeoutMs                        — ברירת מחדל 15ש'
   */
  constructor(credentials = {}) {
    super();
    this.terminalNumber = credentials.terminalNumber || null;
    this.apiName        = credentials.apiName        || null;
    this.apiPassword    = credentials.apiPassword    || null; // ⚠️ סוד
    this.apiBase        = (credentials.apiBase || "https://secure.cardcom.solutions/api/v11").replace(/\/+$/, "");
    this.operation      = credentials.operation || "ChargeAndCreateToken";
    this.isoCoinId      = credentials.isoCoinId ?? 1; // ILS
    this.timeoutMs      = Number(credentials.timeoutMs) || 15_000;
    this.fetchImpl      = credentials.fetchImpl || globalThis.fetch;
    this.paths = {
      createLowProfile: "/LowProfile/Create",
      getLowProfile:    "/LowProfile/GetLpResult",
      charge:           "/Transactions/Charge",
      cancel:           "/Transactions/CancelAuthorization",
      refund:           "/Transactions/RefundByTransactionId",
      ...(credentials.paths || {}),
    };
  }

  isConfigured() { return !!(this.terminalNumber && this.apiName); }

  #require(op) { if (!this.isConfigured()) throw new PaymentNotConnectedError(op); }

  #auth() {
    return { TerminalNumber: Number(this.terminalNumber), ApiName: this.apiName };
  }

  /**
   * קריאה ל-CardCom.
   * 🔴 `ResponseCode !== 0` הוא כשל **גם כשה-HTTP הוא 200**. בלי הבדיקה
   *    הזו "תשלום שנכשל" נראה כמו הצלחה, והאורח מקבל חדר בלי פיקדון.
   */
  async #call(op, pathKey, payload) {
    this.#require(op);
    const url = `${this.apiBase}${this.paths[pathKey] || pathKey}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res, data;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ...this.#auth(), ...payload }),
        signal: ctl.signal,
      });
    } catch (e) {
      throw new CardComError(op, "network", e?.name === "AbortError" ? "timeout" : (e?.message || "network error"), { retryable: true });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 500) throw new CardComError(op, res.status, "CardCom server error", { retryable: true });
    try { data = await res.json(); }
    catch { throw new CardComError(op, "parse", `invalid JSON (HTTP ${res.status})`); }

    const code = data?.ResponseCode;
    if (Number(code) !== 0) {
      throw new CardComError(op, code ?? res.status, data?.Description || "unknown error");
    }
    return data;
  }

  // ── הרשאת פיקדון ──────────────────────────────────────
  // יוצר עמוד סליקה מתארח. מחזיר את ה-URL שאליו שולחים את האורח.
  async authorizeDeposit({ amount, currency = "ILS", reservationId, successUrl, cancelUrl, webhookUrl, description } = {}) {
    const data = await this.#call("authorizeDeposit", "createLowProfile", {
      Amount: toUnits(amount),
      ISOCoinId: this.isoCoinId,
      Operation: this.operation,
      SuccessRedirectUrl: successUrl,
      FailedRedirectUrl: cancelUrl,
      WebHookUrl: webhookUrl,
      // ReturnValue חוזר אלינו ב-webhook ובתוצאה — כך מזהים את ההזמנה
      // בלי להסתמך על פרמטרים ב-URL שאפשר לזייף.
      ReturnValue: String(reservationId || ""),
      ProductName: description || undefined,
    });
    return {
      paymentId:   data.LowProfileId,
      redirectUrl: data.Url,
      status:      "pending",
      currency,
      raw:         data,
    };
  }

  // ── לכידה מתוך ההרשאה ─────────────────────────────────
  async capture({ paymentId, amount, token = null } = {}) {
    const data = await this.#call("capture", "charge", {
      Amount: toUnits(amount),
      ISOCoinId: this.isoCoinId,
      ...(token ? { Token: token } : { LowProfileId: paymentId }),
    });
    return { ok: true, capturedAmount: Math.round(Number(amount) || 0), transactionId: data.TranzactionId, raw: data };
  }

  // ── ביטול הרשאה ───────────────────────────────────────
  async cancel({ paymentId, transactionId = null } = {}) {
    const data = await this.#call("cancel", "cancel", {
      ...(transactionId ? { TranzactionId: transactionId } : { LowProfileId: paymentId }),
    });
    return { ok: true, raw: data };
  }

  // ── חיוב נוסף מאותו כרטיס ─────────────────────────────
  async chargeSameCard({ paymentId, amount, token = null, description } = {}) {
    const data = await this.#call("chargeSameCard", "charge", {
      Amount: toUnits(amount),
      ISOCoinId: this.isoCoinId,
      ProductName: description || undefined,
      ...(token ? { Token: token } : { LowProfileId: paymentId }),
    });
    return { ok: true, chargedAmount: Math.round(Number(amount) || 0), transactionId: data.TranzactionId, raw: data };
  }

  // ── תשלום יתרה בכרטיס אחר ─────────────────────────────
  async createBalancePayment({ amount, reservationId, successUrl, cancelUrl, webhookUrl, description } = {}) {
    const data = await this.#call("createBalancePayment", "createLowProfile", {
      Amount: toUnits(amount),
      ISOCoinId: this.isoCoinId,
      Operation: "ChargeOnly",   // יתרה = חיוב מלא, לא הקפאה
      SuccessRedirectUrl: successUrl,
      FailedRedirectUrl: cancelUrl,
      WebHookUrl: webhookUrl,
      ReturnValue: String(reservationId || ""),
      ProductName: description || undefined,
    });
    return { paymentId: data.LowProfileId, redirectUrl: data.Url, raw: data };
  }

  // ── אימות webhook ─────────────────────────────────────
  // 🔴 **לא סומכים על גוף ה-webhook.** כל אחד יכול לשלוח POST ולטעון
  //    שעסקה הצליחה. האימות היחיד שאפשר לסמוך עליו הוא שאילתה חוזרת
  //    ל-CardCom (`GetLpResult`) עם ה-LowProfileId — צד שרת מול צד שרת.
  //    לכן זו שיטה **אסינכרונית**, בשונה מ-Mock.
  async verifyWebhookAsync(body = {}) {
    const lowProfileId = body?.LowProfileId || body?.lowProfileId;
    if (!lowProfileId) return { valid: false, reason: "no LowProfileId in payload" };
    try {
      const data = await this.#call("verifyWebhook", "getLowProfile", { LowProfileId: lowProfileId });
      return {
        valid: true,
        event: {
          type: "checkout.session.completed",
          data: { object: { metadata: { reservation_id: data.ReturnValue }, payment_id: lowProfileId } },
        },
        raw: data,
      };
    } catch (e) {
      return { valid: false, reason: e?.message || "verification failed" };
    }
  }

  // הממשק הסינכרוני נשאר, אך מסרב במפורש — כדי שאיש לא "יאמת" webhook
  // של תשלום אמיתי בלי לפנות ל-CardCom.
  verifyWebhook() {
    throw new PaymentNotConnectedError(
      "verifyWebhook",
      "CardCom webhooks must be verified server-side; call verifyWebhookAsync()",
    );
  }
}
