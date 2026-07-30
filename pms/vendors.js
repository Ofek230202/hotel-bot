// ════════════════════════════════════════════════════════
//  PMS VENDORS — רישום כל מערכות ניהול המלון
//  ----------------------------------------------------------
//  למה רישום ולא מחלקה לכל ספק: 12 מחלקות כמעט-זהות הן 12 מקומות לתקן
//  כשמשהו משתנה, ו-12 הזדמנויות לשכוח אחד. כאן כל ספק הוא **מפרט
//  (spec) בלבד**, ו-`RestPmsProvider` הגנרי מריץ אותו. הוספת ספק חדש =
//  הוספת אובייקט לקובץ הזה. בלי קוד חדש, בלי בדיקות חדשות למנוע.
//
//  כל מפרט נושא גם את **מה שצריך לבקש מהמלון** (`credentialFields`,
//  `accessHe`) — ולכן המדריך בעברית (`PMS_GUIDE.md`) **נוצר מהרישום הזה**
//  ואינו יכול להתיישן ביחס לקוד. מסמך שנכתב ביד תמיד מתנתק; מסמך שנגזר
//  מהמקור — לא.
//
//  ⚠️ מה שמסומן `verified: true` אומת מול תיעוד הספק (ראה `docsUrl`).
//     מה שמסומן `verified: false` — הפרטים המדויקים מגיעים עם המסמך של
//     הספק/המלון, ולכן הנתיבים והשדות **ניתנים לדריסה** דרך credentials.
//     לא ממציאים endpoints ומתייגים אותם כעובדה.
// ════════════════════════════════════════════════════════

// ── מיפוי שדות ברירת מחדל ───────────────────────────────
// כל שדה מקבל **רשימת מועמדים**: ספקים משנים שמות בין גרסאות והתקנות,
// ו-`pick` לוקח את הראשון שקיים. זה מה שמונע שבירה על שינוי שם שדה.
const BASE_FIELD_MAP = Object.freeze({
  id:                 ["id", "Id", "reservationId", "ReservationId", "uniqueId"],
  confirmationNumber: ["confirmationNumber", "ConfirmationNumber", "number", "Number", "bookingId", "reservationNumber", "code"],
  status:             ["status", "State", "ReservationStatus", "reservationStatus"],
  guestFirstName:     ["guest.firstName", "customer.firstName", "FirstName", "firstName", "givenName"],
  guestLastName:      ["guest.lastName", "customer.lastName", "LastName", "lastName", "surname"],
  guestName:          ["guest.fullName", "customer.fullName", "guestName", "GuestName", "name"],
  phone:              ["guest.phone", "customer.phone", "Phone", "phone", "mobile"],
  email:              ["guest.email", "customer.email", "Email", "email"],
  nationality:        ["guest.nationality", "customer.nationalityCode", "Nationality", "nationality"],
  roomNumber:         ["unit.name", "room.number", "roomNumber", "RoomNumber", "assignedUnit", "room"],
  roomType:           ["unitGroup.code", "roomType", "RoomType", "categoryId", "spaceCategoryId"],
  checkIn:            ["arrival", "Arrival", "checkIn", "StartUtc", "startUtc", "arrivalDate", "from"],
  checkOut:           ["departure", "Departure", "checkOut", "EndUtc", "endUtc", "departureDate", "to"],
  adults:             ["adults", "Adults", "adultCount", "personCounts.adults"],
  children:           ["children", "Children", "childrenCount"],
  rateAmount:         ["totalAmount.grossAmount", "totalGrossAmount", "TotalAmount", "totalAmount", "total", "price"],
  currency:           ["totalAmount.currency", "currency", "Currency", "currencyCode"],
  balance:            ["balance", "Balance", "outstandingBalance"],
  notes:              ["comment", "Notes", "notes", "remarks"],
  folioLines:         ["items", "Items", "lines", "charges", "Orders", "transactions"],
  lineDescription:    ["name", "Name", "description", "Description"],
  lineAmount:         ["amount.grossAmount", "grossAmount", "amount", "Amount", "total"],
  lineDate:           ["consumedUtc", "date", "Date", "postingDate", "created"],
  lineCategory:       ["type", "Type", "category", "serviceId"],
  roomStatusValue:    ["condition", "status", "Status", "housekeepingStatus", "state"],
});

// ── נתיבים גנריים ───────────────────────────────────────
// 🔴 ספק שאין לו נתיבים מתועדים היה חסר-תועלת לגמרי: כל פעולה הייתה
//    נופלת ב-"לא נתמך" עוד לפני שיצאה בקשה, וגם אחרי שהמלון היה מוסר
//    את הפרטים האמיתיים. לכן כל ספק מקבל סט נתיבים גנרי סביר, שנדרס
//    ע"י המפרט שלו ואחר כך ע"י ה-credentials של המלון.
//    כך "ספק לא מאומת" הוא **ניתן להפעלה מיידית** ברגע שמגיע המסמך —
//    בשינוי קונפיג, בלי נגיעה בקוד.
const GENERIC_PATHS = Object.freeze({
  getReservation:     "/reservations/{id}",
  searchReservations: "/reservations",
  updateReservation:  "/reservations/{id}",
  assignRoom:         "/reservations/{id}/room",
  checkIn:            "/reservations/{id}/checkin",
  checkOut:           "/reservations/{id}/checkout",
  getFolio:           "/reservations/{id}/folio",
  postCharge:         "/reservations/{id}/folio/charges",
  postPayment:        "/reservations/{id}/folio/payments",
  getRoomStatus:      "/rooms/{room}",
  setRoomStatus:      "/rooms/{room}/status",
  getGuestProfile:    "/profiles/{id}",
  getAvailability:    "/availability",
});

// קיצור ליצירת שדה credential (מה לבקש מהמלון).
const f = (key, labelHe, { required = true, secret = false, example = "", helpHe = "" } = {}) =>
  ({ key, labelHe, required, secret, example, helpHe });

// יכולות נפוצות
const READ_ONLY   = ["reservation.read", "reservation.search", "folio.read", "profile.read"];
const FULL_MODERN = [...READ_ONLY, "checkin", "checkout", "room.assign", "folio.post", "folio.payment",
                     "housekeeping.read", "housekeeping.write", "profile.write", "webhooks"];

export const PMS_VENDORS = Object.freeze({

  // ── ישראל ───────────────────────────────────────────────
  optima: {
    id: "optima", label: "Optima (Silverbyte / Priority)", labelHe: "אופטימה",
    vendorHe: "סילברבייט, בבעלות פריוריטי", region: "ישראל",
    marketHe: "מובילת השוק בישראל — 500+ מלונות, 85–90% מהשוק (דן, פתאל/לאונרדו, ישרוטל, אורכיד, פרימה, NYX)",
    docsUrl: "https://www.priority-software.com/hospitality-management/optima-pms/",
    // מטופל במחלקה ייעודית (XML + כללים משלה) ולא ב-RestPmsProvider.
    dedicated: "OptimaPmsProvider",
    verified: true,
    selfServe: false,
    capabilities: ["reservation.read", "reservation.search", "checkin", "checkout", "room.assign",
                   "folio.read", "housekeeping.read", "housekeeping.write", "profile.read"],
    credentialFields: [
      f("baseUrl", "כתובת ה-API", { example: "https://optima.hotel.co.il/api", helpHe: "חייבת להיות נגישה מהאינטרנט — לא שם שרת פנימי" }),
      f("apiUser", "שם משתמש"),
      f("apiPassword", "סיסמה", { secret: true }),
      f("hotelCode", "קוד המלון במערכת", { example: "H1" }),
      f("protocol", "סוג הממשק — rest או xml", { required: false, example: "rest" }),
    ],
    accessHe: "דרך **המלון**, לנציג אופטימה שלו. אין פורטל מפתחים ואין הרשמה עצמית. " +
              "לציין במפורש: ממשק **תפעולי** (PMS API) — *לא* GOC/Channel Manager.",
    warnHe: "אצל מלונות רבים אופטימה מותקנת על שרת **בתוך המלון** — נדרש פתיחת פורט/VPN. " +
            "זו סיבת העיכוב מס' 1 בישראל. רישום חיוב (folio.post) לצד שלישי לרוב מוגבל.",
    guideRef: "OPTIMA_PMS.md",
  },

  // ── ענן מודרני, onboarding קל ──────────────────────────
  apaleo: {
    id: "apaleo", label: "Apaleo", labelHe: "אפאלאו",
    vendorHe: "Apaleo GmbH (גרמניה)", region: "אירופה",
    marketHe: "PMS ענן API-first. חשבון מפתחים בהרשמה עצמית — ה-onboarding הקל ביותר, ולכן היעד הטוב ביותר לפיתוח ובדיקות",
    docsUrl: "https://apaleo.dev/",
    verified: true, selfServe: true,
    baseUrl: "https://api.apaleo.com",
    auth: { style: "oauth2", tokenUrl: "https://identity.apaleo.com/connect/token", scopeDefault: "reservations.read folios.read" },
    paths: {
      getReservation: "/booking/v1/reservations/{id}",
      searchReservations: "/booking/v1/reservations",
      getFolio: "/finance/v1/folios",
      postCharge: "/finance/v1/folios/{id}/charges",
      checkIn: "/booking/v1/reservation-actions/{id}/checkin",
      checkOut: "/booking/v1/reservation-actions/{id}/checkout",
      assignRoom: "/booking/v1/reservations/{id}",
      getRoomStatus: "/inventory/v1/units/{room}",
      setRoomStatus: "/inventory/v1/units/{room}/condition",
    },
    capabilities: FULL_MODERN,
    credentialFields: [
      f("clientId", "Client ID"),
      f("clientSecret", "Client Secret", { secret: true }),
      f("propertyId", "מזהה הנכס (Property ID)", { example: "MUC" }),
    ],
    accessHe: "**הרשמה עצמית** ב-apaleo.dev. יוצרים חשבון מפתחים, מקימים אפליקציה ומקבלים " +
              "Client ID + Secret. המלון מאשר את החיבור לנכס שלו.",
    warnHe: "נדרש scope מתאים לכל פעולה. חסר scope = 403 ולא הודעה ברורה.",
  },

  mews: {
    id: "mews", label: "Mews", labelHe: "מיוז",
    vendorHe: "Mews Systems (הולנד/צ׳כיה)", region: "אירופה · עולמי",
    marketHe: "PMS ענן מוביל, נפוץ במלונות בוטיק ורשתות מודרניות",
    docsUrl: "https://docs.mews.com/connector-api/getting-started",
    verified: true, selfServe: false,
    baseUrl: "https://api.mews.com",
    sandboxUrl: "https://api.mews-demo.com",
    // 🔴 Mews שונה מכולם: **כל** הקריאות הן POST, והטוקנים נשלחים
    //    ב**גוף** הבקשה ולא בכותרת. לכן style ייעודי.
    auth: { style: "body_tokens", tokenFields: { ClientToken: "clientToken", AccessToken: "accessToken", Client: "client" } },
    defaultMethod: "POST",
    paths: {
      getReservation: "/api/connector/v1/reservations/getAll",
      searchReservations: "/api/connector/v1/reservations/getAll",
      getFolio: "/api/connector/v1/orderItems/getAll",
      postCharge: "/api/connector/v1/orders/add",
      checkIn: "/api/connector/v1/reservations/start",
      checkOut: "/api/connector/v1/reservations/process",
      getRoomStatus: "/api/connector/v1/resources/getAll",
    },
    capabilities: [...READ_ONLY, "checkin", "checkout", "folio.post", "housekeeping.read", "webhooks"],
    credentialFields: [
      f("clientToken", "ClientToken — מזהה האפליקציה שלנו", { secret: true }),
      f("accessToken", "AccessToken — מזהה **הנכס** (המלון)", { secret: true, helpHe: "טוקן נפרד לכל מלון" }),
      f("client", "Client — שם האפליקציה", { example: "StayBot 1.0" }),
    ],
    accessHe: "פונים ל-Mews כשותף טכנולוגי. מקבלים **ClientToken** אחד לאפליקציה, " +
              "ו**AccessToken נפרד לכל מלון** שמאשר את החיבור. יש סביבת דמו לפיתוח.",
    warnHe: "נדרשת **הסמכה (certification)** של Mews לפני חיבור לסביבת הייצור. " +
            "AccessToken הוא פר-מלון — לא לבלבל עם ClientToken.",
  },

  cloudbeds: {
    id: "cloudbeds", label: "Cloudbeds", labelHe: "קלאודבדס",
    vendorHe: "Cloudbeds (ארה״ב)", region: "עולמי",
    marketHe: "נפוץ מאוד במלונות קטנים-בינוניים, הוסטלים ודירות נופש",
    docsUrl: "https://developers.cloudbeds.com/docs/authentication-1",
    verified: true, selfServe: true,
    baseUrl: "https://api.cloudbeds.com/api/v1.2",
    auth: { style: "bearer", tokenUrl: "https://hotels.cloudbeds.com/api/v1.1/access_token" },
    paths: {
      getReservation: "/getReservation",
      searchReservations: "/getReservations",
      getFolio: "/getReservationFolio",
      postCharge: "/postItem",
      getRoomStatus: "/getRooms",
      setRoomStatus: "/postRoomAssign",
    },
    capabilities: [...READ_ONLY, "checkin", "checkout", "folio.post", "housekeeping.read", "housekeeping.write", "webhooks"],
    credentialFields: [
      f("apiKey", "API Key", { secret: true, helpHe: "שיטת ההזדהות המומלצת של Cloudbeds" }),
      f("propertyId", "Property ID", { example: "123456" }),
    ],
    accessHe: "שתי דרכים: **API Key** (מומלץ) שהמלון מנפיק, או **OAuth 2.0** — שם צוות המלון " +
              "מאשר את האפליקציה דרך Cloudbeds Marketplace. לרשת מלונות אפשר טוקן לכל הנכסים.",
    warnHe: "ב-OAuth ה-redirect URI חייב להיות HTTPS. עדיף להנפיק משתמש ייעודי לאינטגרציה ולא " +
            "להשתמש במשתמש של עובד — עובד שעוזב שובר את החיבור.",
  },

  // ── רשתות גדולות / יוקרה ────────────────────────────────
  opera: {
    id: "opera", label: "Oracle OPERA Cloud (OHIP)", labelHe: "אופרה / אורקל",
    vendorHe: "Oracle Hospitality", region: "עולמי",
    marketHe: "תקן רשתות היוקרה הגדולות — קמפינסקי, הילטון, מריוט ואחרות. ה-PMS הנפוץ ביותר בעולם ברשתות גדולות",
    docsUrl: "https://docs.oracle.com/en/industries/hospitality/integration-platform/ohipu/",
    verified: true, selfServe: false,
    baseUrl: "https://<your-ohip-host>",
    // OAuth2 + כותרת x-app-key ייחודית ל-OHIP.
    auth: { style: "oauth2", tokenUrlFromCreds: "tokenUrl", extraHeaders: { "x-app-key": "appKey" } },
    paths: {
      getReservation: "/rsv/v1/hotels/{hotelId}/reservations/{id}",
      searchReservations: "/rsv/v1/hotels/{hotelId}/reservations",
      getFolio: "/csh/v1/hotels/{hotelId}/reservations/{id}/folios",
      postCharge: "/csh/v1/hotels/{hotelId}/reservations/{id}/charges",
      checkIn: "/rsv/v1/hotels/{hotelId}/reservations/{id}/checkIn",
      checkOut: "/rsv/v1/hotels/{hotelId}/reservations/{id}/checkOut",
      getRoomStatus: "/hsk/v1/hotels/{hotelId}/rooms/{room}",
      setRoomStatus: "/hsk/v1/hotels/{hotelId}/rooms/{room}/status",
    },
    capabilities: FULL_MODERN,
    credentialFields: [
      f("baseUrl", "כתובת ה-OHIP של הרשת", { example: "https://xxx.hospitality.oracleindustry.com" }),
      f("tokenUrl", "כתובת ה-OAuth של הרשת"),
      f("clientId", "Client ID"),
      f("clientSecret", "Client Secret", { secret: true }),
      f("appKey", "Application Key (x-app-key)", { secret: true }),
      f("hotelId", "מזהה המלון ב-OPERA", { example: "TLVKM" }),
      f("interfaceUser", "משתמש הממשק (Integration User)", { required: false }),
      f("interfacePassword", "סיסמת משתמש הממשק", { required: false, secret: true }),
    ],
    accessHe: "התהליך הכבד ביותר: נרשמים ל-OHIP דרך Oracle (Oracle Shop או הזמנה ידנית) → " +
              "מקבלים גישה ל-**Partner Developer Portal** → מבצעים onboarding **לכל מלון בנפרד** → " +
              "מקבלים Client ID, Client Secret ו-Application Key. בנוסף המלון יוצר **משתמש ממשק** ב-OPERA.",
    warnHe: "צפי זמן: שבועות עד חודשים, ולרוב בעלות. נדרש תיאום עם ה-IT של הרשת ולא רק עם המלון הבודד. " +
            "זה המסלול הרלוונטי לקמפינסקי אם הם על OPERA.",
  },

  fidelio: {
    id: "fidelio", label: "Fidelio / OPERA on-premise", labelHe: "פידליו",
    vendorHe: "Oracle (לשעבר MICROS-Fidelio)", region: "עולמי",
    marketHe: "הדור הוותיק של OPERA, מותקן בשרת בתוך המלון. עדיין נפוץ ברשתות ותיקות",
    docsUrl: "https://docs.oracle.com/en/industries/hospitality/",
    verified: false, selfServe: false,
    auth: { style: "basic" },
    capabilities: ["reservation.read", "reservation.search", "folio.read", "housekeeping.read"],
    credentialFields: [
      f("baseUrl", "כתובת שרת הממשק", { helpHe: "בדרך כלל שרת בתוך המלון — נדרש VPN/פתיחת פורט" }),
      f("apiUser", "שם משתמש"),
      f("apiPassword", "סיסמה", { secret: true }),
      f("hotelId", "מזהה המלון"),
    ],
    accessHe: "דרך המלון ו-Oracle. בגרסאות on-prem החיבור נעשה לרוב דרך **OXI / ממשק HTNG** " +
              "שמותקן אצל המלון, ולא דרך API ענן.",
    warnHe: "כמעט תמיד **לא נגיש מהאינטרנט**. נדרש VPN, ולעיתים רכיב ממשק בתשלום. " +
            "יכולות הכתיבה מוגבלות — לתכנן על קריאה בלבד.",
  },

  // ── אירופה / בריטניה ────────────────────────────────────
  protel: {
    id: "protel", label: "protel (protel Air / I/O)", labelHe: "פרוטל",
    vendorHe: "protel hotelsoftware GmbH (גרמניה, מקבוצת Planet)", region: "אירופה",
    marketHe: "נפוץ בגרמניה ובאירופה. פלטפורמת אינטגרציה protel.I/O מבוססת תקני HTNG/OTA",
    docsUrl: "https://hub.protel.io/",
    verified: true, selfServe: false,
    auth: { style: "bearer" },
    capabilities: [...READ_ONLY, "checkin", "checkout", "folio.post", "housekeeping.read"],
    credentialFields: [
      f("baseUrl", "כתובת ה-API"),
      f("apiKey", "מפתח / טוקן", { secret: true }),
      f("hotelId", "מזהה המלון"),
    ],
    accessHe: "נרשמים ב-**protel Marketplace** כשותף אינטגרציה, חותמים על NDA ומתארים את " +
              "המקרה העסקי. לאחר האישור נפתחת גישה לפורטל המפתחים ולסביבת sandbox.",
    warnHe: "פורטל סגור (partner-gated) — נדרש אישור מראש. הממשקים מבוססי HTNG/OTA עם תוספות משלהם.",
  },

  guestline: {
    id: "guestline", label: "Guestline", labelHe: "גסטליין",
    vendorHe: "Guestline Ltd (בריטניה)", region: "בריטניה",
    marketHe: "חזקה בבריטניה — מלונות עצמאיים, רשתות קטנות ודירות שירות",
    docsUrl: "https://www.guestline.com/",
    verified: false, selfServe: false,
    auth: { style: "basic" },
    capabilities: READ_ONLY,
    credentialFields: [
      f("baseUrl", "כתובת ה-API"),
      f("apiUser", "שם משתמש"), f("apiPassword", "סיסמה", { secret: true }),
      f("siteId", "מזהה האתר/המלון"),
    ],
    accessHe: "דרך המלון, בפנייה לצוות האינטגרציות של Guestline. הממשקים מבוססי תקני HTNG/OTA.",
    warnHe: "פרטי הממשק מגיעים עם המסמך שלהם — הנתיבים כאן ניתנים לדריסה דרך הקונפיג.",
  },

  roomraccoon: {
    id: "roomraccoon", label: "RoomRaccoon", labelHe: "רומרקון",
    vendorHe: "RoomRaccoon (הולנד)", region: "אירופה · עולמי",
    marketHe: "All-in-one למלונות קטנים ובוטיק — PMS + Channel Manager + מנוע הזמנות",
    docsUrl: "https://roomraccoon.com/",
    verified: false, selfServe: false,
    auth: { style: "bearer" },
    capabilities: [...READ_ONLY, "checkin", "checkout", "folio.post"],
    credentialFields: [
      f("baseUrl", "כתובת ה-API"),
      f("apiKey", "מפתח API", { secret: true }),
      f("propertyId", "מזהה הנכס"),
    ],
    accessHe: "המלון מבקש גישת API מ-RoomRaccoon עבור ספק חיצוני. יש תיעוד API זמין לשותפים.",
  },

  // ── נוספים נפוצים ───────────────────────────────────────
  stayntouch: {
    id: "stayntouch", label: "StayNTouch", labelHe: "סטיינטאץ׳",
    vendorHe: "StayNTouch (ארה״ב)", region: "צפון אמריקה",
    marketHe: "PMS ענן מוכוון מובייל, חזק בצ׳ק-אין עצמי",
    docsUrl: "https://www.stayntouch.com/", verified: false, selfServe: false,
    auth: { style: "bearer" },
    capabilities: [...READ_ONLY, "checkin", "checkout", "room.assign", "housekeeping.read"],
    credentialFields: [f("baseUrl", "כתובת ה-API"), f("apiKey", "מפתח API", { secret: true }), f("hotelId", "מזהה המלון")],
    accessHe: "דרך המלון, בבקשה לצוות האינטגרציות של StayNTouch.",
  },

  clock: {
    id: "clock", label: "Clock PMS+", labelHe: "קלוק",
    vendorHe: "Clock Software (בולגריה)", region: "אירופה",
    marketHe: "PMS ענן עם API פתוח יחסית",
    docsUrl: "https://clock-software.com/", verified: false, selfServe: false,
    auth: { style: "basic" },
    capabilities: [...READ_ONLY, "checkin", "checkout", "folio.post"],
    credentialFields: [f("baseUrl", "כתובת ה-API"), f("apiUser", "שם משתמש"), f("apiPassword", "סיסמה", { secret: true }), f("propertyId", "מזהה הנכס")],
    accessHe: "המלון מפעיל את ה-API בהגדרות המערכת ומנפיק פרטי גישה.",
  },

  hotelogix: {
    id: "hotelogix", label: "Hotelogix", labelHe: "הוטלוג׳יקס",
    vendorHe: "Hotelogix (הודו)", region: "אסיה · עולמי",
    marketHe: "PMS ענן למלונות קטנים ובינוניים",
    docsUrl: "https://www.hotelogix.com/", verified: false, selfServe: false,
    auth: { style: "bearer" },
    capabilities: READ_ONLY,
    credentialFields: [f("baseUrl", "כתובת ה-API"), f("apiKey", "מפתח API", { secret: true }), f("hotelId", "מזהה המלון")],
    accessHe: "דרך המלון, בבקשה לתמיכת Hotelogix.",
  },

  ezee: {
    id: "ezee", label: "eZee / Yanolja Cloud", labelHe: "איזי",
    vendorHe: "eZee Technosys (מקבוצת Yanolja)", region: "אסיה · עולמי",
    marketHe: "נפוץ באסיה ובשווקים מתפתחים",
    docsUrl: "https://www.ezeetechnosys.com/", verified: false, selfServe: false,
    auth: { style: "bearer" },
    capabilities: READ_ONLY,
    credentialFields: [f("baseUrl", "כתובת ה-API"), f("apiKey", "מפתח API", { secret: true }), f("hotelCode", "קוד המלון")],
    accessHe: "דרך המלון, בבקשה לתמיכת eZee.",
  },
});

export const VENDOR_IDS = Object.freeze(Object.keys(PMS_VENDORS));

// מפרט ספק, עם ברירות מחדל מלאות. מחזיר null לספק לא מוכר.
export function vendorSpec(id) {
  const key = String(id || "").toLowerCase();
  const alias = { silverbyte: "optima", oracle: "opera", ohip: "opera", "opera-cloud": "opera", micros: "fidelio" }[key] || key;
  const v = PMS_VENDORS[alias];
  if (!v) return null;
  return {
    ...v,
    id: alias,
    auth: v.auth || { style: "bearer" },
    // נתיבי הספק גוברים על הגנריים; ה-credentials של המלון יגברו על שניהם.
    paths: { ...GENERIC_PATHS, ...(v.paths || {}) },
    fieldMap: { ...BASE_FIELD_MAP, ...(v.fieldMap || {}) },
    capabilities: v.capabilities || READ_ONLY,
    defaultMethod: v.defaultMethod || "GET",
  };
}

// אילו שדות חסרים כדי שהספק יהיה מוכן — משמש גם לבדיקת קונפיג וגם
// למדריך בעברית ("מה עוד חסר לך מהמלון").
export function missingCredentials(vendorId, creds = {}) {
  const spec = vendorSpec(vendorId);
  if (!spec) return { ok: false, unknownVendor: true, missing: [] };
  const missing = (spec.credentialFields || [])
    .filter(fld => fld.required && !creds[fld.key])
    .map(fld => ({ key: fld.key, labelHe: fld.labelHe }));
  return { ok: missing.length === 0, unknownVendor: false, missing };
}

export { BASE_FIELD_MAP, GENERIC_PATHS };
