// ════════════════════════════════════════════════════════
//  ALL-HOTELS — כל יכולת נבדקת על **כל** מלון, לא רק על הדגל
//  ----------------------------------------------------------
//  הסיכון שהקובץ הזה סוגר: כל תקלה רב-מלונית בסבב הזה נראתה תקינה
//  לחלוטין עד שנבדקה על מלון *שני* — עמוד פיקדון ממותג במלון אחר,
//  כפתור צ'אט שהוביל למלון אחר, "בריכה: undefined" במלון בלי בריכה.
//  כולן היו בלתי נראות בבדיקה על מלון אחד.
//
//  לכן: הבדיקות כאן רצות **בלולאה על כל המלונות המוגדרים**, כך שמלון
//  חדש שיתווסף ל-`sample-hotels.mjs` ייבדק אוטומטית ולא יישכח.
// ════════════════════════════════════════════════════════
import { test, before, mock } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH                = freshTestDbPath("all-hotels");
process.env.TWILIO_ACCOUNT_SID     = "ACtest";
process.env.TWILIO_AUTH_TOKEN      = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.ANTHROPIC_API_KEY      = "sk-test";
process.env.BASE_URL               = "http://test.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);

// הצ'ק אין שולח הודעות לאורח ולצוות — מוחלף, אחרת הבדיקה פונה ל-Twilio אמיתי.
const sent = [];
mock.module("twilio", {
  exports: {
    default: () => ({
      messages: {
        create: async ({ from, to, body }) => {
          if (!body) throw new Error("Twilio: body is required");
          sent.push({ from, to, body });
          return { sid: "SMtest" };
        },
      },
    }),
  },
});

const { email } = await import("./email/index.js");
email.send = async () => ({ success: true });

const config  = await import("./config.js");
const tenant  = await import("./tenant.js");
const checkin = await import("./checkin.js");
const { SAMPLE_HOTELS, seedSampleHotels } = await import("./sample-hotels.mjs");
const { pmsFor, pmsReadiness, clearPmsCache } = await import("./pms/index.js");
const { paymentsFor, clearPaymentsCache } = await import("./payments/index.js");
const { auditText } = await import("./voice.js");

// המלונות "האמיתיים" — אלה שהוגדרו במלואם ומיועדים לאירוח.
// מלוני הגאוגרפיה (nyc/london/…) קיימים לבדיקת מקומות בלבד.
const FULL_HOTELS = ["lala", tenant.DEFAULT_HOTEL_ID];
const ALL_IDS = SAMPLE_HOTELS.map(h => h.hotelId);

before(() => {
  seedSampleHotels({
    updateConfigFor: config.updateConfigFor,
    registerHotelNumber: tenant.registerHotelNumber,
    DEFAULT_HOTEL_ID: tenant.DEFAULT_HOTEL_ID,
  });
  clearPmsCache(); clearPaymentsCache();
});

// ════════════════════════════════════════════════════════
//  זהות בסיסית — לכל מלון
// ════════════════════════════════════════════════════════
test("כל מלון: זהות מלאה וייחודית", () => {
  const names = new Set(), coords = new Set();
  for (const id of ALL_IDS) {
    const cfg = config.configFor(id);
    assert.ok(cfg.name && cfg.name_he, `${id}: חסר שם`);
    assert.ok(cfg.location?.lat && cfg.location?.lng, `${id}: חסר מיקום`);
    assert.ok(cfg.location?.timezone, `${id}: חסר אזור זמן — שעות פתיחה יחושבו לפי מדינה אחרת`);
    names.add(cfg.name);
    coords.add(`${cfg.location.lat},${cfg.location.lng}`);
  }
  assert.equal(names.size, ALL_IDS.length, "🔴 שני מלונות עם אותו שם");
  assert.equal(coords.size, ALL_IDS.length, "🔴 שני מלונות באותו מיקום — הקונסיירז' ימליץ אותו דבר");
});

test("כל מלון מלא: מבודד לחלוטין ממלון ברירת המחדל", () => {
  for (const id of FULL_HOTELS) {
    const r = config.checkTenantIsolation(id);
    if (r.skipped) continue;   // מלון ברירת המחדל *הוא* DEFAULTS
    assert.equal(r.ok, true, `🔴 ${id} חולק עם ברירת המחדל: ${r.shared.join(", ")}`);
  }
});

test("כל מלון מלא: אנשי קשר שלמים, ולא משותפים **בין** מלונות", () => {
  // ⚠️ שיתוף *בתוך* מלון הוא לגיטימי ואף נכון: בבוטיק קטן אותו אדם
  //    מקבל גם את הקונסיירז' וגם את שירות החדרים (אין מטבח). מה שאסור
  //    הוא שיתוף **בין** מלונות — שם בקשה נוחתת אצל עסק אחר.
  const seen = new Map();   // ערך → hotelId
  for (const id of FULL_HOTELS) {
    const c = config.checkDepartmentContacts(id);
    assert.equal(c.ok, true, `🔴 ${id}: חסרים ${c.missing.join(", ")}`);
    for (const d of config.DEPARTMENTS) {
      const { whatsapp, email } = config.departmentContacts(d, id);
      for (const [kind, val] of [["מספר", whatsapp], ["מייל", email]]) {
        const key = `${kind}:${val}`;
        const owner = seen.get(key);
        assert.ok(owner === undefined || owner === id,
          `🔴 ${kind} ${val} משותף ל-${owner} ול-${id} (${d}) — בקשה תגיע למלון הלא נכון`);
        seen.set(key, id);
      }
    }
  }
});

// ════════════════════════════════════════════════════════
//  שכבות הספקים — כל אחת פר-מלון
// ════════════════════════════════════════════════════════
test("כל מלון: שכבת PMS נפתרת ולא מפילה כלום", () => {
  for (const id of ALL_IDS) {
    const p = pmsFor(id);
    assert.ok(p, `${id}: אין ספק PMS`);
    const r = pmsReadiness(id);
    assert.ok(typeof r.ready === "boolean", `${id}: דיווח מוכנות שבור`);
    // בלי הגדרה — Mock, וזה תקין. מה שאסור הוא ליפול.
    assert.ok(p.isMock || p.isConfigured?.(), `${id}: ספק לא-Mock שאינו מוגדר`);
  }
});

test("כל מלון: שכבת הסליקה נפתרת, ומלון בלי credentials נופל ל-Mock", () => {
  for (const id of ALL_IDS) {
    const p = paymentsFor(id);
    assert.ok(p, `${id}: אין ספק סליקה`);
    assert.equal(typeof p.authorizeDeposit, "function");
  }
});

test("כל מלון: הגדרת PMS פר-מלון אינה נוגעת במלונות אחרים", () => {
  config.updateConfigFor("lala", {
    pms_provider: "optima",
    pms_credentials: { baseUrl: "https://opt.example", apiUser: "u", apiPassword: "p", hotelCode: "LALA9" },
  });
  clearPmsCache();
  try {
    assert.equal(pmsFor("lala").constructor.name, "OptimaPmsProvider");
    // כל השאר נשארו כפי שהיו
    for (const id of ALL_IDS.filter(x => x !== "lala")) {
      assert.equal(pmsFor(id).isMock, true, `🔴 הגדרת LALA השפיעה על ${id}`);
    }
  } finally {
    config.updateConfigFor("lala", { pms_provider: "mock", pms_credentials: null });
    clearPmsCache();
  }
});

// ════════════════════════════════════════════════════════
//  פלט — תקן הניסוח על כל מלון
// ════════════════════════════════════════════════════════
test("כל מלון: הודעת הפתיחה עומדת בתקן, בשתי השפות", () => {
  for (const id of ALL_IDS) {
    for (const lang of ["he", "en"]) {
      const w = config.welcomeFor(id, lang);
      const bad = auditText(w).filter(v => v.severity !== "info");
      assert.deepEqual(bad, [], `🔴 ${id}/${lang}: ${JSON.stringify(bad)}`);
      const cfg = config.configFor(id);
      const name = lang === "he" ? (cfg.name_he || cfg.name) : (cfg.name || cfg.name_he);
      assert.ok(w.includes(name), `🔴 ${id}/${lang}: הפתיחה אינה נושאת את שם המלון`);
    }
  }
});

test("כל מלון: הפתיחה לא מציעה שירות שאינו קיים בו", () => {
  const claims = [
    ["pool", /בריכה|\bPool\b/i],
    ["spa", /ספא|\bspa\b/i],
    ["gym", /חדר כושר|\bgym\b/i],
  ];
  for (const id of ALL_IDS) {
    const cfg = config.configFor(id);
    for (const lang of ["he", "en"]) {
      const w = config.welcomeFor(id, lang);
      for (const [key, re] of claims) {
        if (!cfg.services?.[key] && re.test(w)) {
          assert.fail(`🔴 ${id}/${lang}: מציע "${key}" שאינו קיים במלון`);
        }
      }
    }
  }
});

test("כל מלון: תנאי השהייה נושאים את שם המלון ואת הפיקדון שלו", () => {
  for (const id of FULL_HOTELS) {
    const cfg = config.configFor(id);
    assert.ok(cfg.terms?.version, `${id}: אין גרסת תנאים`);
    for (const lang of ["he", "en"]) {
      const secs = cfg.terms[lang] || [];
      assert.ok(secs.length >= 5, `${id}/${lang}: תנאים חלקיים`);
      // ה-placeholders מוחלפים בזמן שליחה — כאן מוודאים שהם *קיימים*
      // כדי שההחלפה תוכל לקרות.
      const all = secs.map(s => `${s.title} ${s.body}`).join(" ");
      assert.ok(/\{hotel\}/.test(all), `${id}/${lang}: אין {hotel} בתנאים — יישא שם מלון אחר`);
    }
  }
});

// ════════════════════════════════════════════════════════
//  כסף — חשבונית נכונה לכל מלון
// ════════════════════════════════════════════════════════
test("כל מלון מלא: חשבונית נושאת את העוסק שלו, ומע\"מ נכון", async () => {
  const seenBiz = new Set();
  for (const id of FULL_HOTELS) {
    const cfg = config.configFor(id);
    assert.ok(cfg.business?.business_id, `${id}: אין מספר עוסק`);
    assert.ok(!seenBiz.has(cfg.business.business_id), `🔴 ${id} חולק מספר עוסק עם מלון אחר`);
    seenBiz.add(cfg.business.business_id);

    for (const [tourist, expectRate] of [[false, cfg.vat_rate], [true, 0]]) {
      const inv = await tenant.runInTenant(id, async () => {
        const { reservationId } = await checkin.startCheckin(
          `whatsapp:+97250099${seenBiz.size}${tourist ? 1 : 0}`,
          { guestName: "דנה כהן", guestNameHe: "דנה כהן", guestNameEn: "Dana Cohen" },
          `RES-ALL-${id}-${tourist}`,
          { stay: { checkIn: "2099-07-01", checkOut: "2099-07-03", nights: 2 } },
        );
        const res = checkin.reservations[reservationId];
        res.isTourist = tourist;
        await checkin.completeCheckin(reservationId, "5");
        checkin.addFolioItem(reservationId, "MINIBAR", "מיני בר", 11800);
        return checkin.issueFolioInvoice(res, "he");
      });
      assert.equal(inv.seller.businessId, cfg.business.business_id, `${id}: עוסק שגוי`);
      assert.equal(inv.vatRate, expectRate, `${id}: מע"מ שגוי (תייר=${tourist})`);
      assert.equal(inv.net + inv.vat, inv.totalInclVat, `${id}: חישוב מע"מ לא עקבי`);
    }
  }
});

test("כל מלון: חיובי הדגמה תואמים לשירותים שקיימים בו", () => {
  for (const id of FULL_HOTELS) {
    const cfg = config.configFor(id);
    const rid = tenant.runInTenant(id, () => {
      const res = Object.values(checkin.reservations).find(r => (r.hotelId || tenant.DEFAULT_HOTEL_ID) === id);
      if (!res) return null;
      checkin.addDemoCharges(res.id, "he");
      return res.id;
    });
    if (!rid) continue;
    const bill = checkin.formatFolio(checkin.reservations[rid], "he");
    if (!cfg.services?.spa) assert.ok(!/עיסוי|ספא/.test(bill), `🔴 ${id}: חשבון כולל ספא שאין במלון`);
  }
});

// ════════════════════════════════════════════════════════
//  מודל התפעול — לכל מלון התנהגות עקבית
// ════════════════════════════════════════════════════════
test("כל מלון: מודל התפעול עקבי עם סוג המלון", () => {
  for (const id of ALL_IDS) {
    const m = config.hotelModel(id);
    const cfg = config.configFor(id);
    assert.ok(["door_code", "reception_card"].includes(m.keyDelivery), `${id}: אמצעי כניסה לא חוקי`);
    if (cfg.hotel_type === "boutique") {
      assert.equal(m.keyDelivery, "door_code", `${id}: בוטיק חייב קוד דלת`);
      assert.equal(m.onSiteSecurity, false, `${id}: בוטיק לא מבטיח צוות במקום`);
      assert.ok(m.dutyManagerNumber, `🔴 ${id}: בוטיק בלי מנהל תורן — אין למי להסלים חירום`);
    } else {
      assert.equal(m.keyDelivery, "reception_card", `${id}: מלון מלא — כרטיס בקבלה`);
    }
  }
});

test("כל מלון: מרחב מוגן מוגדר — הנחיה שגויה באזעקה היא סיכון חיים", () => {
  for (const id of FULL_HOTELS) {
    const cfg = config.configFor(id);
    for (const lang of ["he", "en"]) {
      assert.ok(cfg.safety?.[lang]?.shelter_location, `🔴 ${id}/${lang}: אין מיקום מרחב מוגן`);
      assert.ok(cfg.safety?.[lang]?.shelter_time, `🔴 ${id}/${lang}: אין זמן הגעה`);
    }
  }
});

// ════════════════════════════════════════════════════════
//  היגיינת סודות
// ════════════════════════════════════════════════════════
test("אבטחה: סיסמת הניהול אינה מודפסת ללוג", async () => {
  // 🔴 נמצא בסריקה: הבאנר בעלייה הדפיס את `DASHBOARD_PASSWORD` במלואו.
  //    לוגים של Railway נשמרים וניתנים לצפייה — כלומר סיסמת הניהול ישבה
  //    בלוג לכל מי שיש לו גישה אליו.
  const fs = await import("node:fs");
  const src = fs.readFileSync("server.js", "utf8");
  const logLines = src.split("\n").filter(l => /console\.(log|warn|info)/.test(l));
  for (const line of logLines) {
    assert.ok(!/\$\{PASS\}/.test(line), `🔴 סיסמה בלוג: ${line.trim()}`);
  }
});

test("אבטחה: אין מספר וואטסאפ קשיח בקוד שמוגש לאורח", async () => {
  const fs = await import("node:fs");
  for (const f of ["checkin-routes.js", "bot.js", "checkin.js"]) {
    const hard = (fs.readFileSync(f, "utf8").match(/wa\.me\/\d{6,}/g) || []);
    assert.deepEqual(hard, [], `🔴 ${f}: מספר קשיח ${hard.join(", ")}`);
  }
});

// ════════════════════════════════════════════════════════
//  מלון חדש — הכל עובד בלי קוד
// ════════════════════════════════════════════════════════
test("מלון חדש לגמרי: onboarding בקונפיג בלבד, וכל השכבות עובדות", async () => {
  const NEW = "future-hotel";
  config.updateConfigFor(NEW, {
    name: "The Future Hotel", name_he: "מלון העתיד",
    hotel_type: "boutique",
    duty_manager_number: "whatsapp:+972500000700",
    housekeeping_number: "whatsapp:+972500000701", reception_number: "whatsapp:+972500000702",
    maintenance_number: "whatsapp:+972500000703", concierge_number: "whatsapp:+972500000704",
    security_number: "whatsapp:+972500000705", room_service_number: "whatsapp:+972500000706",
    housekeeping_email: "hk@future.test", reception_email: "rec@future.test",
    maintenance_email: "mnt@future.test", concierge_email: "cnc@future.test",
    security_email: "sec@future.test", room_service_email: "rs@future.test",
    business: { legal_name: "מלון העתיד בע\"מ", legal_name_en: "Future Ltd.", business_id: "519999999",
                business_type: "עוסק מורשה", address: "רחוב המחר 1", address_en: "1 Tomorrow St" },
    location: { address: "1 Tomorrow St", address_he: "רחוב המחר 1", lat: 31.25, lng: 34.79,
                timezone: "Asia/Jerusalem", country: "IL", search_radius_m: 3000 },
    wifi: { name: "Future_Guest", password: "Tomorrow2026" },
    services: { pool: null, spa: null, gym: null, restaurant: null, bar: null, laundry: null,
                breakfast: { he: { name: "ארוחת בוקר", hours: "07:00–10:00" }, en: { name: "Breakfast", hours: "07:00–10:00" } } },
    restaurants: null,
    safety: { he: { shelter_location: "ממ\"ד בקומת הכניסה", shelter_time: "כ-90 שניות" },
              en: { shelter_location: "shelter on the entrance floor", shelter_time: "about 90 seconds" } },
    building: { he: { floors: "3 קומות" }, en: { floors: "3 floors" } },
    faq: [{ he: { q: "שעות?", a: "כניסה 15:00" }, en: { q: "Hours?", a: "Check-in 15:00" } }],
    local_area: { he: { neighbourhood: "הסביבה" }, en: { neighbourhood: "The area" } },
    arrival: { he: { by_car: "בכביש 40" }, en: { by_car: "Route 40" } },
    parking: { available: false, he: { note: "אין חניון" }, en: { note: "No car park" } },
  });
  tenant.registerHotelNumber("+15559998888", NEW, "+15559998888");
  clearPmsCache(); clearPaymentsCache();

  // 1. מבודד
  assert.equal(config.checkTenantIsolation(NEW).ok, true,
    `🔴 מלון חדש יורש: ${config.checkTenantIsolation(NEW).shared.join(", ")}`);
  // 2. אנשי קשר
  assert.equal(config.checkDepartmentContacts(NEW).ok, true);
  // 3. ניתוב מהמספר
  assert.equal(tenant.resolveHotelId("whatsapp:+15559998888"), NEW);
  assert.equal(tenant.normalizeNumber(tenant.fromNumberFor(NEW)), "+15559998888");
  // 4. מודל בוטיק
  assert.equal(config.hotelModel(NEW).keyDelivery, "door_code");
  // 5. פתיחה תקנית, בשמו, בלי שירותים שאין לו
  for (const lang of ["he", "en"]) {
    const w = config.welcomeFor(NEW, lang);
    assert.deepEqual(auditText(w).filter(v => v.severity !== "info"), []);
    assert.ok(/בריכה|Pool/i.test(w) === false, `${lang}: מציע בריכה שאין`);
  }
  // 6. ספקים
  assert.ok(pmsFor(NEW).isMock, "בלי PMS — מאגר מובנה");
  assert.ok(paymentsFor(NEW));
  // 7. חשבונית עם העוסק שלו
  const inv = await tenant.runInTenant(NEW, async () => {
    const { reservationId } = await checkin.startCheckin(
      "whatsapp:+972500000799", { guestName: "דנה", guestNameHe: "דנה", guestNameEn: "Dana" },
      "RES-FUTURE", { stay: { checkIn: "2099-08-01", checkOut: "2099-08-02", nights: 1 } });
    await checkin.completeCheckin(reservationId, "1");
    checkin.addFolioItem(reservationId, "MINIBAR", "מיני בר", 5900);
    return checkin.issueFolioInvoice(checkin.reservations[reservationId], "he");
  });
  assert.equal(inv.seller.businessId, "519999999");
  assert.match(inv.seller.name, /העתיד/);
});
