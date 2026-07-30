// ════════════════════════════════════════════════════════
//  PMS VENDORS — רישום הספקים והמנוע הגנרי
//  ----------------------------------------------------------
//  הבדיקות כאן שומרות על ההבטחה המרכזית: **הוספת ספק היא נתון ולא קוד**,
//  וכל הספקים מתנהגים אותו דבר מול הקוד העסקי — אותו מבנה קנוני, אותו
//  טיפול בשגיאות, אותה נפילה בחן.
// ════════════════════════════════════════════════════════
import { test } from "node:test";
import assert from "node:assert/strict";

const { PMS_VENDORS, VENDOR_IDS, vendorSpec, missingCredentials } = await import("./pms/vendors.js");
const { RestPmsProvider, PmsUnsupportedError, PmsNotConfiguredError } = await import("./pms/RestPmsProvider.js");
const { RESERVATION_STATUS, ROOM_STATUS } = await import("./pms/normalize.js");

function stubFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const impl = async (url, opts = {}) => {
    calls.push({ url, ...opts });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    const status = r.status ?? 200;
    return {
      status,
      json: async () => (typeof r.body === "string" ? JSON.parse(r.body) : r.body),
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? "")),
    };
  };
  impl.calls = calls;
  return impl;
}

// ════════════════════════════════════════════════════════
//  שלמות הרישום — כל ספק חייב להיות שמיש
// ════════════════════════════════════════════════════════
test("רישום: כל ספק מוגדר במלואו ואפשר להסביר אותו למלון", () => {
  assert.ok(VENDOR_IDS.length >= 12, `צפויים 12+ ספקים, יש ${VENDOR_IDS.length}`);
  for (const id of VENDOR_IDS) {
    const v = PMS_VENDORS[id];
    const spec = vendorSpec(id);
    assert.ok(v.label && v.labelHe, `${id}: חסר שם`);
    assert.ok(v.accessHe, `${id}: חסר הסבר איך משיגים גישה — בלעדיו אי אפשר לפנות למלון`);
    assert.ok(Array.isArray(spec.capabilities) && spec.capabilities.length, `${id}: חסרות יכולות`);
    assert.ok(spec.credentialFields?.length, `${id}: חסרים שדות credentials — אי אפשר לדעת מה לבקש`);
    for (const f of spec.credentialFields) {
      assert.ok(f.key && f.labelHe, `${id}: שדה בלי key/labelHe`);
    }
    // כל שדה סוד חייב להיות מסומן, אחרת הוא ידלוף לדוחות/מדריך.
    // ⚠️ שם שמסתיים ב-Url/Uri אינו סוד (`tokenUrl` היא כתובת, לא טוקן) —
    //    בלי החרגה זו הבדיקה "מגלה" סודות מדומים ומאבדת אמינות.
    for (const f of spec.credentialFields) {
      if (/(Url|Uri)$/i.test(f.key)) continue;
      if (/password|secret|token|apikey|key$/i.test(f.key)) {
        assert.equal(f.secret, true, `${id}.${f.key} נראה כמו סוד אך אינו מסומן secret`);
      }
    }
  }
});

test("רישום: כל ספק שאינו ייעודי נבנה בפועל ע\"י המנוע הגנרי", () => {
  for (const id of VENDOR_IDS) {
    const spec = vendorSpec(id);
    if (spec.dedicated) continue;
    const p = new RestPmsProvider(id, {});
    assert.equal(p.vendor, id);
    assert.equal(p.isConfigured(), false, `${id}: בלי credentials חייב להיות "לא מוגדר"`);
    const d = p.describe();
    assert.ok(d.missing.length > 0, `${id}: describe חייב לומר מה חסר`);
  }
});

test("רישום: כינויים מתמפים לספק הנכון", () => {
  assert.equal(vendorSpec("silverbyte").id, "optima");
  assert.equal(vendorSpec("oracle").id, "opera");
  assert.equal(vendorSpec("ohip").id, "opera");
  assert.equal(vendorSpec("MEWS").id, "mews", "לא תלוי רישיות");
  assert.equal(vendorSpec("nope"), null);
});

test("רישום: missingCredentials מפרט בדיוק מה לבקש מהמלון", () => {
  const m = missingCredentials("mews", { client: "StayBot" });
  assert.equal(m.ok, false);
  const keys = m.missing.map(x => x.key);
  assert.ok(keys.includes("clientToken") && keys.includes("accessToken"));
  assert.ok(!keys.includes("client"), "מה שכבר נמסר לא נדרש שוב");
  assert.ok(m.missing.every(x => x.labelHe), "לכל שדה חסר יש תיאור בעברית");

  assert.equal(missingCredentials("cloudbeds", { apiKey: "k", propertyId: "1" }).ok, true);
});

// ════════════════════════════════════════════════════════
//  הזדהות — כל סגנון נשלח נכון
// ════════════════════════════════════════════════════════
test("הזדהות: bearer שולח Authorization", async () => {
  const fetchImpl = stubFetch({ body: { id: 1, number: "C1" } });
  const p = new RestPmsProvider("cloudbeds", { apiKey: "KEY1", propertyId: "9", fetchImpl });
  await p.getReservation("C1");
  assert.equal(fetchImpl.calls[0].headers.authorization, "Bearer KEY1");
});

test("הזדהות: basic מקודד שם משתמש וסיסמה", async () => {
  const fetchImpl = stubFetch({ body: { id: 1 } });
  const p = new RestPmsProvider("clock", { baseUrl: "https://c.example", apiUser: "u", apiPassword: "p", propertyId: "1", fetchImpl });
  await p.getReservation("X").catch(() => {});
  const auth = fetchImpl.calls[0]?.headers?.authorization || "";
  assert.match(auth, /^Basic /);
  assert.equal(Buffer.from(auth.slice(6), "base64").toString(), "u:p");
});

test("הזדהות: oauth2 מביא טוקן, שומר אותו ב-cache, ולא מבקש שוב", async () => {
  const fetchImpl = stubFetch([
    { body: { access_token: "TOK", expires_in: 3600 } },
    { body: { id: 1, number: "R1" } },
    { body: { id: 2, number: "R2" } },
  ]);
  const p = new RestPmsProvider("apaleo", { clientId: "ci", clientSecret: "cs", propertyId: "MUC", fetchImpl });

  await p.getReservation("R1");
  await p.getReservation("R2");

  const tokenCalls = fetchImpl.calls.filter(c => String(c.url).includes("connect/token"));
  assert.equal(tokenCalls.length, 1, "🔴 טוקן הובא פעמיים — cache לא עובד");
  assert.equal(tokenCalls[0].method, "POST");
  assert.match(tokenCalls[0].body, /grant_type=client_credentials/);
  const apiCall = fetchImpl.calls.find(c => !String(c.url).includes("connect/token"));
  assert.equal(apiCall.headers.authorization, "Bearer TOK");
});

test("הזדהות: OHIP מוסיף את כותרת x-app-key הייחודית", async () => {
  const fetchImpl = stubFetch([
    { body: { access_token: "T", expires_in: 3600 } },
    { body: { id: 1 } },
  ]);
  const p = new RestPmsProvider("opera", {
    baseUrl: "https://ohip.example", tokenUrl: "https://ohip.example/oauth/v1/tokens",
    clientId: "ci", clientSecret: "cs", appKey: "APPKEY123", hotelId: "TLVKM", fetchImpl,
  });
  await p.getReservation("R1");
  const apiCall = fetchImpl.calls.find(c => !String(c.url).includes("tokens"));
  assert.equal(apiCall.headers["x-app-key"], "APPKEY123");
  assert.ok(apiCall.url.includes("TLVKM"), "מזהה המלון נכנס לנתיב");
});

test("הזדהות: Mews שולח טוקנים ב*גוף* הבקשה, לא בכותרת", async () => {
  const fetchImpl = stubFetch({ body: { Reservations: [{ Id: "m1", Number: "MW1", StartUtc: "2026-08-01T14:00:00Z", EndUtc: "2026-08-03T10:00:00Z" }] } });
  const p = new RestPmsProvider("mews", { clientToken: "CT", accessToken: "AT", client: "StayBot 1.0", fetchImpl });
  const r = await p.getReservation("MW1");

  const call = fetchImpl.calls[0];
  assert.equal(call.method, "POST", "Mews תמיד POST");
  assert.ok(!call.headers.authorization, "אין כותרת Authorization ב-Mews");
  const sent = JSON.parse(call.body);
  assert.equal(sent.ClientToken, "CT");
  assert.equal(sent.AccessToken, "AT");
  assert.equal(sent.Client, "StayBot 1.0");
  // ועדיין — מבנה קנוני החוצה
  assert.equal(r.confirmationNumber, "MW1");
  assert.equal(r.checkIn, "2026-08-01");
  assert.equal(r.nights, 2);
});

// ════════════════════════════════════════════════════════
//  התנהגות אחידה מול הקוד העסקי
// ════════════════════════════════════════════════════════
test("אחידות: ספקים שונים מחזירים בדיוק את אותו מבנה קנוני", async () => {
  const cloudbeds = new RestPmsProvider("cloudbeds", {
    apiKey: "k", propertyId: "1",
    fetchImpl: stubFetch({ body: { data: { reservationID: "CB1", number: "CB1", status: "checked_in", guest: { firstName: "Ann", lastName: "Lee" }, arrival: "2026-09-01", departure: "2026-09-03" } } }),
  });
  const apaleo = new RestPmsProvider("apaleo", {
    clientId: "a", clientSecret: "b", propertyId: "MUC",
    fetchImpl: stubFetch([
      { body: { access_token: "T", expires_in: 3600 } },
      { body: { id: "AP1", status: "InHouse", guest: { firstName: "Ann", lastName: "Lee" }, arrival: "2026-09-01", departure: "2026-09-03" } },
    ]),
  });

  const a = await cloudbeds.getReservation("CB1");
  const b = await apaleo.getReservation("AP1");

  for (const r of [a, b]) {
    assert.equal(r.guestName, "Ann Lee");
    assert.equal(r.checkIn, "2026-09-01");
    assert.equal(r.nights, 2);
    assert.equal(r.status, RESERVATION_STATUS.IN_HOUSE, "סטטוסים שונים → אותו ערך קנוני");
    assert.equal(r.source, "pms");
    assert.equal(typeof r.currency, "string");
  }
});

test("אחידות: 404 → null בכל ספק (הזמנה שלא קיימת אינה תקלה)", async () => {
  for (const [id, creds] of [
    ["cloudbeds", { apiKey: "k", propertyId: "1" }],
    ["protel", { baseUrl: "https://p.example", apiKey: "k", hotelId: "1" }],
  ]) {
    const p = new RestPmsProvider(id, { ...creds, fetchImpl: stubFetch({ status: 404, body: "no" }) });
    assert.equal(await p.getReservation("X"), null, `${id}: 404 חייב להחזיר null`);
  }
});

test("אחידות: 401 לא גורר ניסיונות חוזרים באף ספק", async () => {
  const fetchImpl = stubFetch({ status: 401, body: "bad" });
  const p = new RestPmsProvider("cloudbeds", { apiKey: "bad", propertyId: "1", fetchImpl, attempts: 3 });
  await assert.rejects(() => p.getReservation("X"), (e) => e.kind === "auth");
  assert.equal(fetchImpl.calls.length, 1);
});

// ════════════════════════════════════════════════════════
//  יכולות — נפילה בחן
// ════════════════════════════════════════════════════════
test("יכולות: פעולה שלא נתמכת נכשלת בבירור ולא בשקט", async () => {
  const p = new RestPmsProvider("guestline", { baseUrl: "https://g.example", apiUser: "u", apiPassword: "p", siteId: "1", fetchImpl: stubFetch({ body: {} }) });
  assert.equal(p.supports("folio.post"), false);
  await assert.rejects(() => p.postCharge("R1", { amount: 100 }), PmsUnsupportedError);
});

test("יכולות: מלון יכול לצמצם יכולת שהספק כן תומך בה", async () => {
  const full = new RestPmsProvider("apaleo", { clientId: "a", clientSecret: "b", propertyId: "M" });
  assert.equal(full.supports("folio.post"), true);
  // המלון לא אישר רישום חיוב — מכבים, והבוט ידרדר לצוות.
  const limited = new RestPmsProvider("apaleo", { clientId: "a", clientSecret: "b", propertyId: "M", disable: ["folio.post"] });
  assert.equal(limited.supports("folio.post"), false);
  assert.equal(limited.supports("reservation.read"), true, "שאר היכולות נשמרו");
});

test("יכולות: verifyWebhook לא מתיימר לאמת בלי מפרט חתימה", () => {
  const p = new RestPmsProvider("apaleo", { clientId: "a", clientSecret: "b", propertyId: "M" });
  assert.throws(() => p.verifyWebhook(), PmsUnsupportedError,
    "🔴 'אימות' שמחזיר תמיד true גרוע מאין אימות");
});

// ════════════════════════════════════════════════════════
//  אבטחה
// ════════════════════════════════════════════════════════
test("אבטחה: describe() אינו חושף סודות באף ספק", () => {
  const SECRET = "zz-SECRET-9137";
  for (const id of VENDOR_IDS) {
    const spec = vendorSpec(id);
    if (spec.dedicated) continue;
    const creds = { baseUrl: "https://x.example", fetchImpl: null };
    for (const f of spec.credentialFields) creds[f.key] = f.secret ? SECRET : "val";
    const d = new RestPmsProvider(id, creds).describe();
    assert.ok(!JSON.stringify(d).includes(SECRET), `🔴 ${id}: סוד דלף מ-describe`);
  }
});

test("אבטחה: ספק לא מוגדר נכשל לפני שהוא נוגע ברשת", async () => {
  let touched = false;
  const p = new RestPmsProvider("mews", { fetchImpl: async () => { touched = true; } });
  await assert.rejects(() => p.getReservation("X"), PmsNotConfiguredError);
  assert.equal(touched, false, "🔴 יצאה בקשה בלי credentials");
});

// ════════════════════════════════════════════════════════
//  רב-מלונות — הדרישה שאסור לשבור
// ════════════════════════════════════════════════════════
test("רב-מלונות: כל מלון על ספק אחר, באותו תהליך, בלי דליפה", async () => {
  const { pmsFor, clearPmsCache, pmsReadiness } = await import("./pms/index.js");
  const { updateConfigFor } = await import("./config.js");

  updateConfigFor("mt-lala", {
    pms_provider: "optima",
    pms_credentials: { baseUrl: "https://opt.example", apiUser: "u", apiPassword: "p", hotelCode: "LALA1" },
  });
  updateConfigFor("mt-kemp", {
    pms_provider: "opera",
    pms_credentials: { baseUrl: "https://ohip.example", tokenUrl: "https://ohip.example/t", clientId: "c", clientSecret: "s", appKey: "k", hotelId: "TLVKM" },
  });
  updateConfigFor("mt-third", { pms_provider: "mock" });
  clearPmsCache();

  const lala = pmsFor("mt-lala"), kemp = pmsFor("mt-kemp"), third = pmsFor("mt-third");
  assert.equal(lala.constructor.name, "OptimaPmsProvider");
  assert.equal(kemp.constructor.name, "RestPmsProvider");
  assert.equal(kemp.vendor, "opera");
  assert.equal(third.isMock, true);
  assert.equal(lala.hotelCode, "LALA1");
  assert.equal(kemp.creds.hotelId, "TLVKM");
  assert.notEqual(lala.baseUrl, kemp.baseUrl, "🔴 שני המלונות חולקים כתובת");

  // מוכנות מדווחת נכון לכל מלון בנפרד
  assert.equal(pmsReadiness("mt-lala").ready, true);
  assert.equal(pmsReadiness("mt-kemp").vendor, "opera");
  assert.equal(pmsReadiness("mt-third").mock, true);
});

test("רב-מלונות: ספק לא מוכר או חסר פרטים נופל ל-Mock ולא מפיל צ'ק אין", async () => {
  const { pmsFor, clearPmsCache, pmsReadiness } = await import("./pms/index.js");
  const { updateConfigFor } = await import("./config.js");

  updateConfigFor("mt-bogus", { pms_provider: "no-such-pms" });
  updateConfigFor("mt-partial", { pms_provider: "mews", pms_credentials: { client: "StayBot" } });
  clearPmsCache();

  assert.equal(pmsFor("mt-bogus").isMock, true, "ספק לא מוכר → Mock");
  assert.equal(pmsFor("mt-partial").isMock, true, "חסרים טוקנים → Mock");

  // והדיווח אומר בדיוק מה חסר, כדי שאפשר יהיה לבקש מהמלון.
  const r = pmsReadiness("mt-partial");
  assert.equal(r.ready, false);
  assert.ok(r.missing.map(m => m.key).includes("accessToken"));
  assert.equal(pmsReadiness("mt-bogus").unknownVendor, true);
});

// ════════════════════════════════════════════════════════
//  המדריך נגזר מהקוד
// ════════════════════════════════════════════════════════
test("מדריך: PMS_GUIDE.md מעודכן ביחס לרישום", async () => {
  const fs = await import("node:fs");
  assert.ok(fs.existsSync("PMS_GUIDE.md"), "המדריך חסר — הריצו node pms-guide.mjs");
  const md = fs.readFileSync("PMS_GUIDE.md", "utf8");
  for (const id of VENDOR_IDS) {
    assert.ok(md.includes(`\`${id}\``), `🔴 ${id} אינו מופיע במדריך — הריצו node pms-guide.mjs`);
    assert.ok(md.includes(PMS_VENDORS[id].labelHe), `🔴 השם העברי של ${id} חסר במדריך`);
  }
});
