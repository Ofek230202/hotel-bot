// ════════════════════════════════════════════════════════
//  OPTIMA PMS — בדיקות לאדפטר, לנרמול ולשכבת ה-HTTP
//  ----------------------------------------------------------
//  ה-fetch מוזרק, ולכן כל מסלול נבדק דטרמיניסטית ובלי רשת — כולל
//  המסלולים שאי אפשר להפעיל בכוונה מול ספק אמיתי (401, 429, 5xx).
//
//  הדגש: **הקוד העסקי מקבל תמיד מבנה קנוני**. אם ספק ישנה שם שדה או
//  יעטוף אחרת — הבדיקות כאן ייכשלו כאן, ולא אצל אורח באמצע צ'ק אאוט.
// ════════════════════════════════════════════════════════
import { test } from "node:test";
import assert from "node:assert/strict";

const { OptimaPmsProvider, OptimaNotConfiguredError, xmlToObject, objectToXml, firstRecord, recordList } =
  await import("./pms/OptimaPmsProvider.js");
const { PmsHttpError, PMS_ERROR, redactHeaders } = await import("./pms/http.js");
const { toMinorUnits, toStayDate, nightsBetween, toReservationStatus, toRoomStatus, RESERVATION_STATUS, ROOM_STATUS } =
  await import("./pms/normalize.js");

const CREDS = {
  baseUrl: "https://optima.example.com",
  apiUser: "u", apiPassword: "p", hotelCode: "H1",
};

// fetch מזויף: מחזיר תשובה מוכנה, ומתעד את מה שנשלח.
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
//  נרמול — הבסיס של הכל
// ════════════════════════════════════════════════════════
test("נרמול: כסף תמיד באגורות, ו'אין נתון' אינו אפס", () => {
  assert.equal(toMinorUnits(123.45), 12345);
  assert.equal(toMinorUnits("1,234.56"), 123456);
  assert.equal(toMinorUnits("₪500"), 50000);
  assert.equal(toMinorUnits(5000, { alreadyMinor: true }), 5000);
  // 🔴 הבחנה קריטית: null אינו 0. חשבון "לא ידוע" שמוצג כ-0 הוא שקר לאורח.
  assert.equal(toMinorUnits(null), null);
  assert.equal(toMinorUnits(""), null);
  assert.equal(toMinorUnits("לא מספר"), null);
  assert.equal(toMinorUnits(0), 0, "אפס אמיתי כן נשמר");
});

test("נרמול: תאריכי שהייה בכל פורמט — ולעולם לא תאריך מומצא", () => {
  assert.equal(toStayDate("2026-08-01"), "2026-08-01");
  assert.equal(toStayDate("2026-08-01T14:00:00Z"), "2026-08-01");
  assert.equal(toStayDate("20260801"), "2026-08-01");
  assert.equal(toStayDate("01/08/2026"), "2026-08-01", "פורמט ישראלי DD/MM/YYYY");
  assert.equal(toStayDate("1.8.2026"), "2026-08-01");
  assert.equal(toStayDate(null), null);
  assert.equal(toStayDate("שטויות"), null, "לא ניתן לפרסר → null, לא ניחוש");
  assert.equal(nightsBetween("2026-08-01", "2026-08-04"), 3);
  assert.equal(nightsBetween("2026-08-04", "2026-08-01"), null, "טווח הפוך → null");
});

test("נרמול: סטטוסים של ספקים שונים מתמפים לאוצר מילים אחד", () => {
  for (const s of ["DUE_IN", "Confirmed", "Reserved", "הזמנה מאושרת"]) {
    assert.equal(toReservationStatus(s), RESERVATION_STATUS.CONFIRMED, s);
  }
  for (const s of ["IN_HOUSE", "CheckedIn", "Arrived", "שוהה"]) {
    assert.equal(toReservationStatus(s), RESERVATION_STATUS.IN_HOUSE, s);
  }
  assert.equal(toReservationStatus("CHECKED_OUT"), RESERVATION_STATUS.CHECKED_OUT);
  assert.equal(toReservationStatus("Cancelled"), RESERVATION_STATUS.CANCELLED);
  assert.equal(toReservationStatus("NO_SHOW"), RESERVATION_STATUS.NO_SHOW);
  assert.equal(toReservationStatus("???"), RESERVATION_STATUS.UNKNOWN);

  assert.equal(toRoomStatus("Dirty"), ROOM_STATUS.DIRTY);
  assert.equal(toRoomStatus("VACANT_READY"), ROOM_STATUS.CLEAN);
  assert.equal(toRoomStatus("OOO"), ROOM_STATUS.OUT_OF_ORDER);
});

// ════════════════════════════════════════════════════════
//  הגדרה ואבטחה
// ════════════════════════════════════════════════════════
test("אופטימה: בלי credentials לא מתחזה לעובד — נכשל בבירור", async () => {
  const p = new OptimaPmsProvider({});
  assert.equal(p.isConfigured(), false);
  await assert.rejects(() => p.getReservation("ABC"), OptimaNotConfiguredError);
});

test("אופטימה: isConfigured לפי שיטת ההזדהות", () => {
  assert.equal(new OptimaPmsProvider(CREDS).isConfigured(), true);
  assert.equal(new OptimaPmsProvider({ ...CREDS, apiPassword: null }).isConfigured(), false);
  // bearer דורש מפתח, לא שם משתמש
  assert.equal(new OptimaPmsProvider({ baseUrl: "x", hotelCode: "H", auth: "bearer", apiKey: "k" }).isConfigured(), true);
  assert.equal(new OptimaPmsProvider({ baseUrl: "x", hotelCode: "H", auth: "bearer" }).isConfigured(), false);
});

test("אופטימה: describe() לא חושף שום סוד", () => {
  // ⚠️ סודות ייחודיים בכוונה: סיסמה כמו "p" מופיעה במקרה בכל URL
  //    ("optima"), והבדיקה הייתה נכשלת סתם ומסתירה את מה שבאמת נבדק.
  const SECRET_KEY  = "sk-optima-KEY-9f3a";
  const SECRET_PASS = "P@ssw0rd-9f3a-unique";
  const d = new OptimaPmsProvider({ ...CREDS, apiPassword: SECRET_PASS, apiKey: SECRET_KEY }).describe();
  const json = JSON.stringify(d);
  assert.ok(!json.includes(SECRET_KEY),  "🔴 מפתח דלף מ-describe");
  assert.ok(!json.includes(SECRET_PASS), "🔴 סיסמה דלפה מ-describe");
  assert.equal(d.credentialsPresent.apiPassword, true, "אבל כן מדווח שהסיסמה קיימת");
  assert.ok(d.sampleUrls.getReservation.includes("hotelCode=H1"));
});

test("אופטימה: גם ב-auth=query המפתח לא דולף מ-describe", () => {
  const KEY = "qk-UNIQUE-7c21";
  const d = new OptimaPmsProvider({ ...CREDS, auth: "query", apiKey: KEY }).describe();
  assert.ok(!JSON.stringify(d).includes(KEY),
    "🔴 ב-auth=query המפתח נכנס ל-URL — ולכן חייב להיות מוסתר ב-describe");
});

test("אבטחה: redactHeaders מסתיר Authorization ומשאיר את השם", () => {
  const r = redactHeaders({ authorization: "Basic abc123", accept: "application/json" });
  assert.equal(r.authorization, "«redacted»");
  assert.equal(r.accept, "application/json");
});

// ════════════════════════════════════════════════════════
//  קריאת הזמנה — הזרימה המרכזית
// ════════════════════════════════════════════════════════
test("אופטימה: הזמנה מנורמלת — כסף באגורות, תאריכים תקניים, סטטוס קנוני", async () => {
  const fetchImpl = stubFetch({
    body: {
      Reservation: {
        ReservationID: 7788, ConfirmationNo: "OPT-991", Status: "DUE_IN",
        FirstName: "דנה", LastName: "כהן", Phone: "+972500000101",
        RoomNo: "12", ArrivalDate: "01/08/2026", DepartureDate: "04/08/2026",
        Adults: 2, TotalPrice: "1,450.50", Currency: "ILS",
      },
    },
  });
  const p = new OptimaPmsProvider({ ...CREDS, fetchImpl });
  const r = await p.getReservation("OPT-991");

  assert.equal(r.confirmationNumber, "OPT-991");
  assert.equal(r.status, RESERVATION_STATUS.CONFIRMED);
  assert.equal(r.guestName, "דנה כהן", "שם מורכב משם פרטי + משפחה");
  assert.equal(r.roomNumber, "12");
  assert.equal(r.checkIn, "2026-08-01");
  assert.equal(r.checkOut, "2026-08-04");
  assert.equal(r.nights, 3, "לילות מחושבים כשלא נמסרו");
  assert.equal(r.rateAmount, 145050, "₪1,450.50 → אגורות");
  assert.equal(r.hotelCode, "H1");
  assert.equal(r.source, "pms");

  // הקריאה נשאה hotelCode והזדהות
  const call = fetchImpl.calls[0];
  assert.ok(call.url.includes("hotelCode=H1"));
  assert.match(call.headers.authorization, /^Basic /);
});

test("אופטימה: שם שדה חלופי עדיין ממופה (עמידות בין התקנות)", async () => {
  const fetchImpl = stubFetch({
    body: { data: { id: 1, reservationNumber: "X9", status: "IN_HOUSE", guest: { fullName: "John Miller", phone: "+1555" }, room: "512", checkInDate: "2026-08-02", checkOutDate: "2026-08-03" } },
  });
  const r = await new OptimaPmsProvider({ ...CREDS, fetchImpl }).getReservation("X9");
  assert.equal(r.confirmationNumber, "X9");
  assert.equal(r.guestName, "John Miller");
  assert.equal(r.roomNumber, "512");
  assert.equal(r.status, RESERVATION_STATUS.IN_HOUSE);
  assert.equal(r.nights, 1);
});

test("אופטימה: הזמנה שלא קיימת → null, לא שגיאה", async () => {
  const p = new OptimaPmsProvider({ ...CREDS, fetchImpl: stubFetch({ status: 404, body: "not found" }) });
  assert.equal(await p.getReservation("NOPE"), null);
});

test("אופטימה: מספר אישור עם תווים מיוחדים מקודד ולא שובר את הכתובת", async () => {
  const fetchImpl = stubFetch({ body: { id: 1 } });
  await new OptimaPmsProvider({ ...CREDS, fetchImpl }).getReservation("AB/12 34");
  assert.ok(!fetchImpl.calls[0].url.includes("AB/12 34"));
  assert.ok(fetchImpl.calls[0].url.includes("AB%2F12%2034"));
});

// ════════════════════════════════════════════════════════
//  שגיאות — ההבחנה בין קבוע לחולף
// ════════════════════════════════════════════════════════
test("אופטימה: 401 הוא תקלה קבועה — לא מנסים שוב", async () => {
  const fetchImpl = stubFetch({ status: 401, body: "bad credentials" });
  const p = new OptimaPmsProvider({ ...CREDS, fetchImpl });
  await assert.rejects(() => p.getReservation("A"), (e) => {
    assert.ok(e instanceof PmsHttpError);
    assert.equal(e.kind, PMS_ERROR.AUTH);
    assert.equal(e.retryable, false);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1, "🔴 ניסיון חוזר על מפתח שגוי רק מחמיר");
});

test("אופטימה: 500 הוא תקלה חולפת — מנסים שוב ומצליחים", async () => {
  const fetchImpl = stubFetch([
    { status: 500, body: "boom" },
    { status: 200, body: { id: 5, ConfirmationNo: "R5" } },
  ]);
  const r = await new OptimaPmsProvider({ ...CREDS, fetchImpl, attempts: 3 }).getReservation("R5");
  assert.equal(r.confirmationNumber, "R5");
  assert.equal(fetchImpl.calls.length, 2, "ניסיון שני הצליח");
});

test("אופטימה: 429 מסווג כחולף", async () => {
  const fetchImpl = stubFetch({ status: 429, body: "slow down" });
  await assert.rejects(
    () => new OptimaPmsProvider({ ...CREDS, fetchImpl, attempts: 2 }).getReservation("A"),
    (e) => e.kind === PMS_ERROR.RATE_LIMIT && e.retryable === true,
  );
});

// ════════════════════════════════════════════════════════
//  Folio — כולל שומר הסף על רישום חיוב
// ════════════════════════════════════════════════════════
test("אופטימה: folio מנורמל ומאזן מחושב", async () => {
  const fetchImpl = stubFetch({
    body: { Transactions: [
      { Description: "מיני בר", Amount: "95.00", TransactionDate: "2026-08-02", DepartmentCode: "MINIBAR" },
      { Description: "ספא",     Amount: "350.00", TransactionDate: "2026-08-03" },
    ] },
  });
  const f = await new OptimaPmsProvider({ ...CREDS, fetchImpl }).getFolio("R1");
  assert.equal(f.lines.length, 2);
  assert.equal(f.lines[0].amount, 9500);
  assert.equal(f.lines[0].category, "MINIBAR");
  assert.equal(f.lines[1].date, "2026-08-03");
  assert.equal(f.balance, 44500, "מאזן מחושב מהשורות כשלא נמסר");
  assert.equal(f.currency, "ILS");
});

test("אופטימה: רישום חיוב חסום כברירת מחדל, ונפתח רק באישור מפורש", async () => {
  const off = new OptimaPmsProvider({ ...CREDS, fetchImpl: stubFetch({ body: {} }) });
  assert.equal(off.supports("folio.post"), false, "כברירת מחדל אסור — עד אישור אופטימה");
  await assert.rejects(() => off.postCharge("R1", { amount: 5000 }), /not enabled/);

  const fetchImpl = stubFetch({ body: { ok: true } });
  const on = new OptimaPmsProvider({ ...CREDS, canPostFolio: true, fetchImpl });
  assert.equal(on.supports("folio.post"), true);
  await on.postCharge("R1", { description: "פסטה", amount: 11100, category: "ROOMSERVICE" });
  const sent = JSON.parse(fetchImpl.calls[0].body);
  assert.equal(sent.amount, 111, "🔴 אגורות → יחידות בשליחה לספק");
  assert.equal(sent.description, "פסטה");
});

// ════════════════════════════════════════════════════════
//  משק בית
// ════════════════════════════════════════════════════════
test("אופטימה: סטטוס חדר מתמפה לאוצר המילים הקנוני", async () => {
  const p = new OptimaPmsProvider({ ...CREDS, fetchImpl: stubFetch({ body: { HousekeepingStatus: "Dirty" } }) });
  const s = await p.getRoomStatus("12");
  assert.equal(s.status, ROOM_STATUS.DIRTY);
  assert.equal(s.room, "12");
});

// ════════════════════════════════════════════════════════
//  XML — המסלול של התקנות ותיקות
// ════════════════════════════════════════════════════════
test("אופטימה: מסלול XML מחזיר את אותו מבנה קנוני כמו JSON", async () => {
  const xml = `<?xml version="1.0"?><Response><Reservation>
    <ConfirmationNo>XML-1</ConfirmationNo><Status>Confirmed</Status>
    <FirstName>ישראל</FirstName><LastName>ישראלי</LastName>
    <RoomNo>304</RoomNo><ArrivalDate>2026-09-01</ArrivalDate>
    <DepartureDate>2026-09-03</DepartureDate><TotalPrice>880.00</TotalPrice>
  </Reservation></Response>`;
  const fetchImpl = stubFetch({ body: xml });
  const p = new OptimaPmsProvider({ ...CREDS, protocol: "xml", fetchImpl });
  const r = await p.getReservation("XML-1");

  assert.equal(r.confirmationNumber, "XML-1");
  assert.equal(r.guestName, "ישראל ישראלי");
  assert.equal(r.roomNumber, "304");
  assert.equal(r.nights, 2);
  assert.equal(r.rateAmount, 88000);
  assert.equal(fetchImpl.calls[0].headers.accept, "application/xml");
});

test("XML: המרה הלוך ושוב, כולל תווים שדורשים escaping", () => {
  const xml = objectToXml({ name: "R&D <test>", nested: { a: "1" } }, "Req");
  assert.ok(xml.includes("&amp;") && xml.includes("&lt;"), "תווים מיוחדים מוברחים");
  // objectToXml כבר עוטף ב-<Req>, ו-xmlToObject מסיר **שכבת שורש אחת**
  // (בכוונה — הסרה רקורסיבית הייתה בולעת רשומה אמיתית בעלת שדה יחיד).
  const back = xmlToObject(xml);
  assert.equal(back.name, "R&D <test>");
  assert.equal(back.nested.a, "1");
});

test("XML: מוסרת שכבת שורש אחת בלבד, ולא בולעת רשומה", () => {
  // <Response><Reservation>…</Reservation></Response> → הרשומה עצמה.
  const r = xmlToObject(`<Response><Reservation><ConfirmationNo>A1</ConfirmationNo></Reservation></Response>`);
  assert.equal(r.Reservation.ConfirmationNo, "A1");
  // רשומה עם שדה יחיד לא נבלעת לכדי מחרוזת.
  const single = xmlToObject(`<Reservation><ConfirmationNo>B2</ConfirmationNo></Reservation>`);
  assert.equal(single.ConfirmationNo, "B2");
});

test("XML: תגיות חוזרות הופכות למערך", () => {
  const o = xmlToObject(`<Res><Line>a</Line><Line>b</Line></Res>`);
  assert.deepEqual(o.Line, ["a", "b"]);
});

// ════════════════════════════════════════════════════════
//  עטיפות תשובה שונות
// ════════════════════════════════════════════════════════
test("מבנה: רשומה מחולצת מכל עטיפה נפוצה", () => {
  assert.deepEqual(firstRecord([{ a: 1 }, { a: 2 }]), { a: 1 });
  assert.deepEqual(firstRecord({ data: { a: 1 } }), { a: 1 });
  assert.deepEqual(firstRecord({ Reservations: [{ a: 3 }] }), { a: 3 });
  assert.deepEqual(firstRecord({ a: 9 }), { a: 9 });
  assert.equal(firstRecord(null), null);
  assert.equal(recordList({ data: [{ a: 1 }, { a: 2 }] }).length, 2);
  assert.equal(recordList(null).length, 0);
});

// ════════════════════════════════════════════════════════
//  רב-מלונות — הדרישה שאסור לשבור
// ════════════════════════════════════════════════════════
test("רב-מלונות: כל מלון עם ה-credentials שלו, בלי דליפה", async () => {
  const fa = stubFetch({ body: { ConfirmationNo: "A1" } });
  const fb = stubFetch({ body: { ConfirmationNo: "B1" } });
  const a = new OptimaPmsProvider({ baseUrl: "https://a.example", apiUser: "ua", apiPassword: "pa", hotelCode: "HOTEL_A", fetchImpl: fa });
  const b = new OptimaPmsProvider({ baseUrl: "https://b.example", apiUser: "ub", apiPassword: "pb", hotelCode: "HOTEL_B", fetchImpl: fb });

  await Promise.all([a.getReservation("A1"), b.getReservation("B1")]);

  assert.ok(fa.calls[0].url.startsWith("https://a.example"));
  assert.ok(fa.calls[0].url.includes("hotelCode=HOTEL_A"));
  assert.ok(fb.calls[0].url.startsWith("https://b.example"));
  assert.ok(fb.calls[0].url.includes("hotelCode=HOTEL_B"));
  assert.notEqual(fa.calls[0].headers.authorization, fb.calls[0].headers.authorization,
    "🔴 שני המלונות שלחו את אותה הזדהות");
});

test("רב-מלונות: pmsFor מחזיר ספק לפי הקונפיג של כל מלון", async () => {
  const { pmsFor, clearPmsCache } = await import("./pms/index.js");
  const { updateConfigFor } = await import("./config.js");

  updateConfigFor("pmstest-optima", {
    pms_provider: "optima",
    pms_credentials: { baseUrl: "https://o.example", apiUser: "u", apiPassword: "p", hotelCode: "HC1" },
  });
  updateConfigFor("pmstest-none", { pms_provider: "mock" });
  clearPmsCache();

  const withPms = pmsFor("pmstest-optima");
  assert.equal(withPms.constructor.name, "OptimaPmsProvider");
  assert.equal(withPms.hotelCode, "HC1");
  assert.equal(pmsFor("pmstest-none").isMock, true);

  // מלון שסימן optima בלי credentials → נופל ל-Mock, לא מפיל צ'ק אין.
  updateConfigFor("pmstest-partial", { pms_provider: "optima", pms_credentials: { baseUrl: "https://x" } });
  clearPmsCache();
  assert.equal(pmsFor("pmstest-partial").isMock, true, "נפילה בטוחה ל-Mock");
});
