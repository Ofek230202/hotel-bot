// ════════════════════════════════════════════════════════
//  PAYMENTS — שכבת הסליקה: Mock ו-CardCom האמיתי
//  ----------------------------------------------------------
//  ה-fetch מוזרק, ולכן כל מסלול נבדק בלי רשת — כולל מסלולי הכשל שאי
//  אפשר להפעיל בכוונה מול ספק אמיתי.
//
//  🔴 הבדיקה החשובה ביותר כאן: CardCom מחזירה **HTTP 200 גם על כשל**,
//     וההבחנה היא `ResponseCode`. בלי זה "תשלום שנכשל" נראה כהצלחה,
//     והאורח מקבל חדר בלי פיקדון.
// ════════════════════════════════════════════════════════
import { test } from "node:test";
import assert from "node:assert/strict";

const { CardComProvider, CardComError, PaymentNotConnectedError } = await import("./payments/CardComProvider.js");
const { MockProvider } = await import("./payments/MockProvider.js");
const { paymentsFor, clearPaymentsCache, PAYMENT_CURRENCY } = await import("./payments/index.js");

const CREDS = { terminalNumber: 1000, apiName: "TestApi" };

function stubFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const impl = async (url, opts = {}) => {
    calls.push({ url, ...opts, parsed: opts.body ? JSON.parse(opts.body) : null });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    if (r.throws) throw Object.assign(new Error(r.throws), { name: r.name || "Error" });
    return {
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? ""),
    };
  };
  impl.calls = calls;
  return impl;
}

const OK = (extra = {}) => ({ body: { ResponseCode: 0, Description: "Success", ...extra } });

// ════════════════════════════════════════════════════════
//  הגדרה
// ════════════════════════════════════════════════════════
test("CardCom: בלי credentials לא מתחזה לעובד", async () => {
  const p = new CardComProvider({});
  assert.equal(p.isConfigured(), false);
  await assert.rejects(() => p.authorizeDeposit({ amount: 50000 }), PaymentNotConnectedError);
});

test("CardCom: ApiPassword אינו חובה (נדרש רק לזיכויים ומסמכים)", () => {
  assert.equal(new CardComProvider(CREDS).isConfigured(), true);
  assert.equal(new CardComProvider({ terminalNumber: 1 }).isConfigured(), false, "בלי ApiName — לא מוגדר");
});

// ════════════════════════════════════════════════════════
//  הכשל שנראה כהצלחה
// ════════════════════════════════════════════════════════
test("CardCom: ResponseCode ≠ 0 הוא כשל — גם ב-HTTP 200", async () => {
  const fetchImpl = stubFetch({ status: 200, body: { ResponseCode: 57, Description: "Card declined" } });
  const p = new CardComProvider({ ...CREDS, fetchImpl });
  await assert.rejects(
    () => p.authorizeDeposit({ amount: 50000, successUrl: "s", cancelUrl: "c" }),
    (e) => {
      assert.ok(e instanceof CardComError);
      assert.equal(e.code, 57);
      assert.match(e.message, /Card declined/);
      return true;
    },
    "🔴 כשל סליקה נראה כהצלחה — אורח מקבל חדר בלי פיקדון",
  );
});

test("CardCom: תקלת רשת ו-5xx מסומנות כחולפות", async () => {
  const net = new CardComProvider({ ...CREDS, fetchImpl: stubFetch({ throws: "socket hang up" }) });
  await assert.rejects(() => net.authorizeDeposit({ amount: 100 }), (e) => e.retryable === true);

  const down = new CardComProvider({ ...CREDS, fetchImpl: stubFetch({ status: 503, body: {} }) });
  await assert.rejects(() => down.authorizeDeposit({ amount: 100 }), (e) => e.retryable === true);
});

test("CardCom: timeout נאכף ומסומן כחולף", async () => {
  const fetchImpl = stubFetch({ throws: "aborted", name: "AbortError" });
  const p = new CardComProvider({ ...CREDS, fetchImpl, timeoutMs: 10 });
  await assert.rejects(() => p.authorizeDeposit({ amount: 100 }), (e) => e.retryable === true && /timeout/.test(e.message));
});

// ════════════════════════════════════════════════════════
//  הרשאת פיקדון — עמוד מתארח
// ════════════════════════════════════════════════════════
test("CardCom: הרשאה מחזירה URL מתארח — הכרטיס לא עובר דרכנו", async () => {
  const fetchImpl = stubFetch(OK({ LowProfileId: "LP-123", Url: "https://secure.cardcom.solutions/pay/LP-123" }));
  const p = new CardComProvider({ ...CREDS, fetchImpl });
  const r = await p.authorizeDeposit({
    amount: 50000, reservationId: "RES-9", successUrl: "https://h/s", cancelUrl: "https://h/c", webhookUrl: "https://h/w",
  });

  assert.equal(r.paymentId, "LP-123");
  assert.equal(r.redirectUrl, "https://secure.cardcom.solutions/pay/LP-123");

  const sent = fetchImpl.calls[0].parsed;
  assert.equal(sent.Amount, 500, "🔴 אגורות → שקלים; 50000 אגורות הן ₪500 ולא ₪50,000");
  assert.equal(sent.TerminalNumber, 1000);
  assert.equal(sent.ApiName, "TestApi");
  assert.equal(sent.ISOCoinId, 1, "שקלים");
  assert.equal(sent.ReturnValue, "RES-9", "מזהה ההזמנה חוזר אלינו ולא נשען על URL שאפשר לזייף");
  assert.equal(sent.SuccessRedirectUrl, "https://h/s");
  assert.equal(sent.WebHookUrl, "https://h/w");
  assert.ok(!("ApiPassword" in sent), "סיסמת ה-API לא נשלחת בבקשה שאינה דורשת אותה");
});

test("CardCom: סוג הפעולה ניתן להתאמה בלי שינוי קוד", async () => {
  const fetchImpl = stubFetch(OK({ LowProfileId: "L", Url: "u" }));
  const p = new CardComProvider({ ...CREDS, operation: "SuspendedDeal", fetchImpl });
  await p.authorizeDeposit({ amount: 1000 });
  assert.equal(fetchImpl.calls[0].parsed.Operation, "SuspendedDeal");
});

// ════════════════════════════════════════════════════════
//  לכידה / ביטול / חיוב נוסף
// ════════════════════════════════════════════════════════
test("CardCom: לכידה מחייבת את הסכום הנכון ומחזירה מזהה עסקה", async () => {
  const fetchImpl = stubFetch(OK({ TranzactionId: 777 }));
  const p = new CardComProvider({ ...CREDS, fetchImpl });
  const r = await p.capture({ paymentId: "LP-1", amount: 12500, token: "TOK" });
  assert.equal(r.ok, true);
  assert.equal(r.capturedAmount, 12500, "מוחזר באגורות — כמו שאר המערכת");
  assert.equal(r.transactionId, 777);
  assert.equal(fetchImpl.calls[0].parsed.Amount, 125);
  assert.equal(fetchImpl.calls[0].parsed.Token, "TOK");
});

test("CardCom: ביטול הרשאה", async () => {
  const fetchImpl = stubFetch(OK());
  const p = new CardComProvider({ ...CREDS, fetchImpl });
  assert.equal((await p.cancel({ paymentId: "LP-2" })).ok, true);
  assert.match(fetchImpl.calls[0].url, /CancelAuthorization/);
});

test("CardCom: חיוב ההפרש מאותו כרטיס", async () => {
  const fetchImpl = stubFetch(OK({ TranzactionId: 9 }));
  const p = new CardComProvider({ ...CREDS, fetchImpl });
  const r = await p.chargeSameCard({ token: "TOK", amount: 12500, description: "הפרש מעל פיקדון" });
  assert.equal(r.chargedAmount, 12500);
  assert.equal(fetchImpl.calls[0].parsed.Amount, 125);
});

test("CardCom: תשלום יתרה הוא חיוב מלא ולא הקפאה", async () => {
  const fetchImpl = stubFetch(OK({ LowProfileId: "LP-B", Url: "u" }));
  const p = new CardComProvider({ ...CREDS, operation: "SuspendedDeal", fetchImpl });
  await p.createBalancePayment({ amount: 12500, reservationId: "R1", successUrl: "s", cancelUrl: "c" });
  assert.equal(fetchImpl.calls[0].parsed.Operation, "ChargeOnly",
    "יתרה שכבר נצברה נגבית, לא מוקפאת");
});

// ════════════════════════════════════════════════════════
//  Webhook — לא סומכים על גוף הבקשה
// ════════════════════════════════════════════════════════
test("CardCom: אימות webhook נעשה מול השרת ולא לפי הגוף", async () => {
  const fetchImpl = stubFetch(OK({ ReturnValue: "RES-42" }));
  const p = new CardComProvider({ ...CREDS, fetchImpl });

  const r = await p.verifyWebhookAsync({ LowProfileId: "LP-42" });
  assert.equal(r.valid, true);
  assert.equal(r.event.data.object.metadata.reservation_id, "RES-42");
  assert.match(fetchImpl.calls[0].url, /GetLpResult/, "🔴 חובה שאילתה חוזרת ל-CardCom");
});

test("CardCom: webhook בלי מזהה או שנדחה — לא תקף", async () => {
  const p = new CardComProvider({ ...CREDS, fetchImpl: stubFetch(OK()) });
  assert.equal((await p.verifyWebhookAsync({})).valid, false);

  const bad = new CardComProvider({ ...CREDS, fetchImpl: stubFetch({ body: { ResponseCode: 5, Description: "not found" } }) });
  assert.equal((await bad.verifyWebhookAsync({ LowProfileId: "X" })).valid, false);
});

test("CardCom: verifyWebhook הסינכרוני מסרב במפורש", () => {
  const p = new CardComProvider(CREDS);
  assert.throws(() => p.verifyWebhook({}), /verifyWebhookAsync/,
    "🔴 אסור ש'אימות' יחזיר true בלי לפנות ל-CardCom");
});

// ════════════════════════════════════════════════════════
//  Mock — ברירת המחדל להדגמות
// ════════════════════════════════════════════════════════
test("Mock: מאשר בלי לחייב, ומחזיר את אותו מבנה", async () => {
  const m = new MockProvider();
  const a = await m.authorizeDeposit({ amount: 50000, reservationId: "R1", successUrl: "s", cancelUrl: "c" });
  assert.ok(a.paymentId && a.redirectUrl);
  const c = await m.capture({ paymentId: a.paymentId, amount: 30000 });
  assert.equal(c.capturedAmount, 30000);
  assert.equal((await m.cancel({ paymentId: a.paymentId })).ok, true);
});

// ════════════════════════════════════════════════════════
//  בחירה פר-מלון
// ════════════════════════════════════════════════════════
test("רב-מלונות: כל מלון וספק הסליקה שלו", async () => {
  const { updateConfigFor } = await import("./config.js");
  updateConfigFor("pay-mock", { payment_provider: "mock" });
  updateConfigFor("pay-cc", {
    payment_provider: "cardcom",
    payment_credentials: { terminalNumber: 42, apiName: "HotelApi" },
  });
  updateConfigFor("pay-partial", { payment_provider: "cardcom", payment_credentials: { terminalNumber: 7 } });
  clearPaymentsCache();

  assert.equal(paymentsFor("pay-mock").constructor.name, "MockProvider");
  const cc = paymentsFor("pay-cc");
  assert.equal(cc.constructor.name, "CardComProvider");
  assert.equal(cc.terminalNumber, 42);
  // חסרים פרטים → נפילה בטוחה ל-Mock, לא שבירת צ'ק אין
  assert.equal(paymentsFor("pay-partial").constructor.name, "MockProvider");
  assert.equal(PAYMENT_CURRENCY, "ils");
});

test("רב-מלונות: שני מלונות על CardCom לא חולקים טרמינל", async () => {
  const { updateConfigFor } = await import("./config.js");
  updateConfigFor("cc-a", { payment_provider: "cardcom", payment_credentials: { terminalNumber: 111, apiName: "A" } });
  updateConfigFor("cc-b", { payment_provider: "cardcom", payment_credentials: { terminalNumber: 222, apiName: "B" } });
  clearPaymentsCache();
  assert.notEqual(paymentsFor("cc-a").terminalNumber, paymentsFor("cc-b").terminalNumber);
});
