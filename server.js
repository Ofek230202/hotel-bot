// ════════════════════════════════════════════════════════
//  SERVER v4 — With session reset endpoint
// ════════════════════════════════════════════════════════
import express   from "express";
import dotenv    from "dotenv";
import { handleIncoming, wa, notifyStaff } from "./bot.js";
import { allSessions, sessions, staffAlerts, incidents, stats, deleteSession, clearAllSessions, sessionByRoom, peekSession } from "./state.js";
import { fromNumberFor, resolveHotelId, normalizeNumber } from "./tenant.js";
import { hotelConfig, updateConfig, resetConfig, checkDepartmentContacts, checkTenantIsolation, reportTenantIsolation, clearConfigCache, printRoutingTable, routingTable, DEPARTMENTS } from "./config.js";
import { reservations, addFolioItem, getFolioTotal, formatFolio, FOLIO_CATEGORIES, autoChargeOnNoShow, findNoShowReservations } from "./checkin.js";
import checkinRouter from "./checkin-routes.js";
import { smokePlaces } from "./places/index.js";
import { listIdDocuments, retrieveIdDocument, accessLogFor, purgeExpiredIdDocuments, RETENTION_DAYS } from "./idverify/index.js";
import { DEFAULT_HOTEL_ID } from "./tenant.js";
import { verifyMetaChallenge } from "./whatsapp/index.js";
import { pmsHealth } from "./pms/index.js";
import { emailIsLive } from "./email/index.js";
import { updateConfigFor, configFor, hotelModel } from "./config.js";
import { registerHotelNumber, reloadHotelNumbers } from "./tenant.js";
import { bootstrapDemoHotel } from "./demo-bootstrap.js";
import { timingSafeEqual } from "node:crypto";
import twilio from "twilio";
import { db } from "./db.js";

// בדיקת DB זולה ל-/ready — משפט מוכן מראש (לא בונים אותו בכל בקשה).
const dbCheck = db.prepare("SELECT 1");
let shuttingDown = false;

dotenv.config();

// ── רשת ביטחון אחרונה ברמת התהליך (Bug #1: שקט מוחלט) ──
// דחיית promise שלא נתפסה או חריגה לא-מטופלת יכולות להפיל את כל התהליך —
// ואז *כל* האורחים מקבלים שתיקה עד ריסטארט. תופסים אותן, רושמים ללוג,
// וממשיכים לרוץ. עדיף בוט חי שפספס הודעה אחת מאשר בוט מת לכולם.
process.on("unhandledRejection", (reason) => {
  console.error("🚨 unhandledRejection (נתפס — התהליך ממשיך):", reason?.stack || reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("🚨 uncaughtException (נתפס — התהליך ממשיך):", err?.stack || err?.message || err);
});

const app  = express();
const PORT = process.env.PORT || 3000;
const PASS = process.env.DASHBOARD_PASSWORD || "hotel2024";

app.use("/payments/webhook", express.raw({ type: "application/json" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// השוואת token בזמן-קבוע (Part ב') — מונעת timing attack שמדליף את הסיסמה
// תו-תו. עדיף header על query (query נשמר בלוגים/היסטוריית דפדפן).
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
function auth(req, res, next) {
  const token = req.headers["x-dashboard-token"] || req.query.token;
  if (safeEqual(token, PASS)) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// מסתיר סודות (credentials) מכל תגובת קונפיג — שלא ידלפו דרך ה-API (Part ב').
function redactConfig(cfg) {
  const clone = structuredClone(cfg);
  for (const k of ["payment_credentials", "whatsapp_credentials", "pms_credentials"]) {
    if (clone[k]) clone[k] = "[REDACTED]";
  }
  return clone;
}

// ── מניעת עיבוד כפול של הודעה נכנסת (idempotency) — Part 16/17 ──
// 🔴 קריטי ל-zero-downtime ולעומס: טוויליו/Meta *שולחים שוב* webhook אם לא
//    קיבלו 200 מהר (retry). בלי הגנה, אותה הודעה תעובד פעמיים → תשובה כפולה,
//    הזמנה כפולה, אולי חיוב כפול. כל הודעה נושאת מזהה ייחודי (MessageSid
//    בטוויליו / id ב-Meta). מסמנים אותו כ"נראה" ומדלגים על כפילות.
//    ⚠️ בזיכרון = תהליך בודד. לריבוי תהליכים המפתח עובר ל-Redis SET NX
//    (ראה SCALING.md) — נקודת ההחלפה מרוכזת כאן.
const _seenMessages = new Map(); // sid → timestamp
const SEEN_TTL_MS = 10 * 60_000; // 10 דקות מספיקות לחלון ה-retry של טוויליו
function alreadyProcessed(sid) {
  if (!sid) return false;                 // בלי מזהה — לא חוסמים (עדיף לעבד)
  const now = Date.now();
  if (_seenMessages.has(sid)) return true;
  _seenMessages.set(sid, now);
  // ניקוי עצל של מזהים ישנים — מונע גדילת זיכרון על uptime ארוך.
  if (_seenMessages.size > 5000) {
    for (const [k, t] of _seenMessages) if (now - t > SEEN_TTL_MS) _seenMessages.delete(k);
  }
  return false;
}

// ── WhatsApp Webhook ──────────────────────────────────
app.post("/webhook", async (req, res) => {
  // ── אימות חתימת Twilio (Part ב') — opt-in דרך env ──────
  // מונע זיוף webhooks (POST מזויף כאילו מטוויליו, שיכול להזריק "הודעות
  // אורח" ולהפעיל התראות/חיובים). כבוי כברירת מחדל כדי לא לשבור הרצה
  // מקומית/דמו; בפרודקשן מפעילים VALIDATE_TWILIO=true (דורש BASE_URL נכון).
  if (process.env.VALIDATE_TWILIO === "true") {
    const signature = req.headers["x-twilio-signature"];
    const url = (process.env.BASE_URL || "") + req.originalUrl;
    const valid = twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body || {});
    if (!valid) {
      console.warn(`🚫 Twilio webhook signature invalid — rejected (${String(req.body?.From || "").slice(-8)})`);
      return res.status(403).send("invalid signature");
    }
  }
  const from = req.body.From;
  const to   = req.body.To;           // ← המספר של המלון: ממנו נגזר hotelId (multi-tenant)
  const body = req.body.Body?.trim() || "";

  // ── מדיה נכנסת (תמונה וכו') מטוויליו ─────────────────
  // אורח ששולח תמונה (למשל צילום ת"ז/דרכון בצ'ק אין) — טוויליו
  // מצרף NumMedia + MediaUrl0/MediaContentType0. מעבירים את הפרטים
  // ל-handleIncoming; ⚠️ אנחנו לא מורידים ולא שומרים את התמונה כאן.
  const numMedia = parseInt(req.body.NumMedia || "0", 10);
  const media = numMedia > 0
    ? { url: req.body.MediaUrl0, contentType: req.body.MediaContentType0 || "" }
    : null;

  // הודעה ריקה לגמרי (בלי טקסט ובלי מדיה) — מתעלמים.
  if (!from || (!body && !media)) return res.sendStatus(200);

  // ── דדופ: retry של אותה הודעה לא יעובד פעמיים (Part 16/17) ──
  // מאשרים 200 מיד גם לכפילות, כדי שטוויליו יפסיק לנסות שוב.
  if (alreadyProcessed(req.body.MessageSid || req.body.SmsMessageSid)) {
    console.log(`↩️ הודעה כפולה (retry) — דילוג: ${String(req.body.MessageSid || "").slice(-10)}`);
    return res.type("text/xml").send("<Response></Response>");
  }
  console.log(`📩 [${from.slice(-8)} → ${String(to || "").slice(-8)}] ${body || `<media:${media?.contentType || "?"}>`}`);
  // meta.to מזהה את המלון. handleIncoming עוטף הכול ב-runInTenant + נעילה
  // per-guest, כך שהודעות מקבילות של מלונות/אורחים שונים לא מתערבבות.
  handleIncoming(from, body, media, { to }).catch(console.error);
  res.type("text/xml").send("<Response></Response>");
});

// ── Meta WhatsApp Cloud API webhook (Part ט') — נקודת חיבור ──
// כשמלון עובר מ-Twilio ל-Meta, ההודעות הנכנסות מגיעות לכאן (לא ל-/webhook
// של טוויליו). מוכן מראש:
//   GET  — handshake אימות (Meta שולח hub.challenge; מחזירים אם ה-verify
//          token תואם ל-WA_VERIFY_TOKEN).
//   POST — הודעות נכנסות. מאמת חתימת X-Hub-Signature-256 (HMAC) לפני עיבוד,
//          מחלץ את ההודעה ומעביר ל-handleIncoming עם המספר של המלון (To).
// ⚠️ צריך express.raw כדי לאמת HMAC על הגוף הגולמי — לכן mount ייעודי.
app.get("/webhook/meta", (req, res) => {
  const challenge = verifyMetaChallenge(req.query, process.env.WA_VERIFY_TOKEN || "");
  if (challenge) return res.status(200).send(challenge);
  res.sendStatus(403);
});
app.post("/webhook/meta", express.raw({ type: "*/*" }), (req, res) => {
  // 🔌 החיבור המלא: לפרש את req.body (JSON גולמי), לאמת HMAC דרך
  //    verifyIncomingWebhook(hotelId, { rawBody: req.body, signature }),
  //    לחלץ entry[].changes[].value.messages[] ולהעביר כל הודעה ל-
  //    handleIncoming(from, text, media, { to: phoneNumberId→hotelId }).
  //    כרגע: מאשרים קבלה (200) כדי ש-Meta לא ינסה שוב, בלי לעבד — מוכן לחיבור.
  res.sendStatus(200);
});

// ── Check-in routes ───────────────────────────────────
app.use(checkinRouter);

// ── RESET SESSION — לאיפוס סשן ────────────────────────
app.get("/reset/:phone", auth, (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const full = phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`;
  if (deleteSession(full)) {
    console.log(`🔄 Session reset: ${full}`);
    res.json({ ok: true, message: `Session reset for ${full}` });
  } else {
    res.json({ ok: true, message: "No session found — already clean" });
  }
});

// ── RESET ALL SESSIONS ────────────────────────────────
app.get("/reset-all", auth, (req, res) => {
  const count = clearAllSessions();
  console.log(`🔄 All ${count} sessions reset`);
  res.json({ ok: true, message: `Reset ${count} sessions` });
});

// ── API: stats ────────────────────────────────────────
app.get("/api/stats", auth, (req, res) => {
  res.json({
    ...stats,
    activeSessions: Object.keys(sessions).length,
    checkedIn: allSessions().filter(s => s.stage === "checked_in").length,
    activeReservations: Object.values(reservations).filter(r => r.stage === "checked_in").length,
  });
});

app.get("/api/sessions", auth, (req, res) => res.json(allSessions(req.query.hotelId || null)));

// ── מנהל/קבלה: כניסה לשיחה של חדר מסוים (Part ו') ──────
// מנהל המלון נכנס לשיחה עם חדר דרך המספר של המלון: החדר → הטלפון של
// האורח → היסטוריית השיחה המלאה + המספר של המלון שממנו לענות. הקבלה
// יודעת בדיוק לאיזה מספר לפנות (guest phone) ומאיזה מספר לשלוח (fromNumber).
//   GET /api/conversation?room=512[&hotelId=...]   — לפי חדר
//   GET /api/conversation?phone=+9725...[&hotelId=] — לפי טלפון
app.get("/api/conversation", auth, (req, res) => {
  const hotelId = req.query.hotelId || DEFAULT_HOTEL_ID;
  let s = null;
  if (req.query.room) {
    s = sessionByRoom(req.query.room, req.query.hotelId || null);
  } else if (req.query.phone) {
    const full = String(req.query.phone).startsWith("whatsapp:") ? req.query.phone : `whatsapp:${req.query.phone}`;
    s = peekSession(full, hotelId);
  } else {
    return res.status(400).json({ error: "room or phone query param required" });
  }
  if (!s) return res.status(404).json({ error: "no conversation found for that room/phone" });
  res.json({
    hotelId:       s.hotelId,
    room:          s.roomNumber,
    guestPhone:    s.phone,                 // המספר לפנות אל האורח
    hotelNumber:   fromNumberFor(s.hotelId), // המספר של המלון שממנו לענות
    guestName:     s.guestName,
    stage:         s.stage,
    lastActiveAt:  s.lastActiveAt,
    reservationId: s.reservationId,
    messageCount:  s.messageCount,
    history:       s.history || [],         // כל השיחה, לצפייה
  });
});

app.post("/api/send", auth, async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: "to + message required" });
  try {
    await wa(to, message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/alert", auth, async (req, res) => {
  const { dept, roomNumber, guestName, message, priority } = req.body;
  try {
    await notifyStaff({ dept, roomNumber, guestName, message, priority });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DEMO: add a charge to a room's folio ──────────────
// POST /api/charge  { room | reservationId, amount (₪), category?, description? }
// משמש לבדיקת הצ'ק אאוט — מוסיף חיוב לחשבון של חדר פעיל.
app.post("/api/charge", auth, (req, res) => {
  const { room, roomNumber, reservationId, amount, category, description } = req.body;
  const targetRoom = String(room ?? roomNumber ?? "");

  const reservation = reservationId
    ? reservations[reservationId]
    : Object.values(reservations).find(
        r => r.roomNumber === targetRoom && r.stage === "checked_in"
      );

  if (!reservation) {
    return res.status(404).json({ error: "No active (checked-in) reservation for that room/id" });
  }

  const shekels = Number(amount);
  if (!Number.isFinite(shekels) || shekels <= 0) {
    return res.status(400).json({ error: "amount (in ₪, positive number) required" });
  }

  const cat = category && FOLIO_CATEGORIES[category] ? category : "OTHER";
  addFolioItem(reservation.id, cat, description || FOLIO_CATEGORIES[cat][ "he" ], Math.round(shekels * 100));

  res.json({
    ok: true,
    reservationId: reservation.id,
    room: reservation.roomNumber,
    added: { category: cat, description: description || FOLIO_CATEGORIES[cat].he, amount: shekels },
    folioTotal: getFolioTotal(reservation.id) / 100,
  });
});

// ── DEMO: view a room's folio (for verifying charges) ─
app.get("/api/folio/:room", auth, (req, res) => {
  const reservation = Object.values(reservations).find(
    r => r.roomNumber === String(req.params.room) && r.stage === "checked_in"
  );
  if (!reservation) return res.status(404).json({ error: "No active reservation for that room" });
  res.json({
    reservationId: reservation.id,
    room: reservation.roomNumber,
    guestName: reservation.guestName,
    deposit: reservation.deposit / 100,
    folio: reservation.folio.map(i => ({ ...i, amount: i.amount / 100 })),
    total: getFolioTotal(reservation.id) / 100,
    preview: formatFolio(reservation, "he"),
  });
});

// ── DEMO: no-show auto-charge ─────────────────────────
// אורח שהגיע לתאריך הצ'ק אאוט אך לא ביצע צ'ק אאוט ולא שילם — המלון מחייב
// אוטומטית את הפיקדון (ואת ההפרש מעליו, אם יש). זה מגן מפני "בריחה".
//
// בפרודקשן: cron/מנוע-זמן ירוץ מחזורית, יקרא ל-findNoShowReservations לפי
// תאריך הצ'ק אאוט מה-PMS, ויפעיל autoChargeOnNoShow על כל אחת — ללא התערבות.
// בדמו: מפעילים ידנית כאן.
//
//   POST /api/no-show { room | reservationId }  → מחייב הזמנה ספציפית.
//   POST /api/no-show { all: true }             → סורק ומחייב את כל מי
//                                                 שעבר את תאריך הצ'ק אאוט.
app.post("/api/no-show", auth, async (req, res) => {
  const { room, roomNumber, reservationId, all } = req.body;

  // מצב "all" — סימולציית ה-cron: מוצא את כל ה-no-shows ומחייב אותם.
  if (all) {
    const due = findNoShowReservations();
    const results = [];
    for (const r of due) {
      try {
        const out = await autoChargeOnNoShow(r.id);
        results.push({ reservationId: r.id, room: r.roomNumber, charged: !out.alreadyHandled });
      } catch (e) {
        results.push({ reservationId: r.id, room: r.roomNumber, error: e.message });
      }
    }
    return res.json({ ok: true, scanned: due.length, results });
  }

  // מצב יחיד — לפי reservationId או חדר פעיל.
  const targetRoom = String(room ?? roomNumber ?? "");
  const reservation = reservationId
    ? reservations[reservationId]
    : Object.values(reservations).find(
        r => r.roomNumber === targetRoom && r.stage === "checked_in"
      );

  if (!reservation) {
    return res.status(404).json({ error: "No active (checked-in) reservation for that room/id" });
  }

  try {
    const out = await autoChargeOnNoShow(reservation.id);
    res.json({
      ok: true,
      alreadyHandled: out.alreadyHandled || false,
      reservationId: reservation.id,
      room: reservation.roomNumber,
      noShow: reservation.noShow,
      capturedAmount: reservation.capturedAmount / 100,
      overageAmount: (reservation.overageAmount || 0) / 100,
      folioTotal: getFolioTotal(reservation.id) / 100,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// טבלת הניתוב — לאיזה מספר וואטסאפ ולאיזה מייל הולך כל סוג בקשה.
app.get("/api/routing", auth, (req, res) => res.json(routingTable()));

app.get("/api/alerts", auth, (req, res) => res.json(staffAlerts));
app.get("/api/incidents", auth, (req, res) => res.json(incidents));
app.get("/api/config", auth, (req, res) => res.json(redactConfig(hotelConfig)));

// עדכון קונפיג — מיזוג *עמוק* ונשמר ל-DB (שורד ריסטארט).
// שולחים רק את מה שמשנים: {"services":{"spa":{"he":{"hours":"10:00–22:00"}}}}
// משנה את שעות הספא בעברית בלבד ומשאיר את כל השאר. מערך (למשל רשימת
// הטיפולים) מוחלף כמכלול — מי שמעדכן רשימה שולח אותה במלואה.
app.post("/api/config", auth, (req, res) => {
  try {
    res.json({ ok: true, config: redactConfig(updateConfig(req.body)) });
  } catch (e) {
    console.error("Config update failed:", e?.message || e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── מי עונה למספר הזה? (קריאה בלבד) ────────────────────
// בדיקה של שנייה לפני הדגמה: מחזירה למי *השרת הרץ* מנתב את המספר
// **מהזיכרון שלו** — לא מה שכתוב ב-DB. זו ההבחנה שחשובה: אחרי החלפת
// מלון, ה-DB מתעדכן מיד אך התהליך הרץ מחזיק cache. הנקודה הזו מוכיחה
// שהריענון באמת נקלט, בלי לשלוח שום הודעה לאורח.
// שימוש: GET /api/tenant/resolve?to=whatsapp:+1415...&token=...
app.get("/api/tenant/resolve", auth, (req, res) => {
  const to = req.query.to || process.env.TWILIO_WHATSAPP_NUMBER || "";
  const hotelId = resolveHotelId(to);
  const cfg = configFor(hotelId);
  const model = hotelModel(hotelId);
  res.json({
    ok: true,
    asked: to,
    normalized: normalizeNumber(to),
    hotelId,
    hotelName:   cfg.name_he || cfg.name,
    hotelNameEn: cfg.name,
    address:     cfg.location?.address_he,
    coords:      { lat: cfg.location?.lat, lng: cfg.location?.lng },
    keyDelivery: model.keyDelivery,
    businessId:  cfg.business?.business_id,
    replyFrom:   fromNumberFor(hotelId),
  });
});

// ── ריענון מיפוי המלונות והקונפיג בלי restart ──────────
// כלי החלפת המלון להדגמה (demo-switch.mjs) רץ בתהליך *נפרד* ומשנה את
// ה-DB. השרת הרץ מחזיק את המיפוי ואת הקונפיג ב-cache בזיכרון, ולכן לא
// היה רואה את השינוי עד restart — מלכודת קלאסית של "החלפתי ולא קרה כלום".
// הקריאה הזו מרעננת את שניהם מיידית.
app.post("/api/tenant/reload", auth, (req, res) => {
  try {
    const map = reloadHotelNumbers();
    clearConfigCache();
    const rows = [...map.entries()].map(([number, v]) => ({ number, hotelId: v.hotelId, fromNumber: v.fromNumber }));
    console.log(`🔄 מיפוי המלונות רוענן: ${rows.map(r => `${r.number}→${r.hotelId}`).join(", ") || "(ריק)"}`);
    res.json({ ok: true, numbers: rows });
  } catch (e) {
    console.error("Tenant reload failed:", e?.message || e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── חיבור מלון חדש בקריאה אחת (onboarding) — מוכנות לפרודקשן ──
// כל מה שצריך כדי לחבר מלון אמיתי: hotelId, מספר ה-WhatsApp שלו (To של
// Twilio → hotelId), וקונפיג (שם, מחלקות, שירותים…). עושה גם registerHotelNumber
// וגם updateConfigFor, ומחזיר בדיקת שלמות אנשי קשר. מלון חדש = קריאה אחת,
// בלי שינוי קוד. body: { hotelId, number, fromNumber?, config }
app.post("/api/hotels", auth, (req, res) => {
  const { hotelId, number, fromNumber, config } = req.body || {};
  if (!hotelId) return res.status(400).json({ ok: false, error: "hotelId required" });
  try {
    // 1. מיפוי המספר הנכנס למלון (אם ניתן) — כך הודעות מהמספר הזה מנותבות אליו.
    let mapped = null;
    if (number) mapped = registerHotelNumber(number, hotelId, fromNumber || null);
    // 2. קונפיג המלון (שם, מחלקות, שירותים, סוג מלון, ספקים…).
    if (config && typeof config === "object") updateConfigFor(hotelId, config);
    // 3. בדיקת שלמות: אילו אנשי קשר של מחלקות עדיין חסרים (התראות שיֵעלמו).
    const contacts = checkDepartmentContacts(hotelId);
    // 4. בדיקת בידוד: אילו שדות המלון החדש עדיין *יורש* ממלון ברירת המחדל.
    //    שדה כזה אינו חסר ולכן אינו נתפס למעלה — אבל הוא שולח את ההתראות
    //    ואת חשבונית המס של המלון החדש ליעדים של מלון אחר.
    const isolation = checkTenantIsolation(hotelId);
    if (!isolation.ok) reportTenantIsolation(hotelId);
    res.json({
      ok: true,
      hotelId,
      number: mapped?.number || null,
      contactsComplete: contacts.ok,
      missingContacts: contacts.missing,
      isolated: isolation.ok,
      sharedWithDefault: isolation.shared,
      config: redactConfig(configFor(hotelId)),
    });
  } catch (e) {
    console.error("Hotel onboarding failed:", e?.message || e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// איפוס הקונפיג לברירות המחדל שבקוד (מוחק את כל ה-overrides).
app.post("/api/config/reset", auth, (req, res) => {
  try {
    res.json({ ok: true, config: redactConfig(resetConfig()) });
  } catch (e) {
    console.error("Config reset failed:", e?.message || e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
// ════════════════════════════════════════════════════════
//  מסמכי זיהוי — גישה מבוקרת + מתועדת לקבלה (Part 3)
//  ----------------------------------------------------------
//  זו הדרך היחידה שהקבלה מקבלת תעודות זהות: מאחורי אימות (token),
//  מבודד לפי מלון (hotelId), וכל פתיחה נרשמת ב-audit log. לעולם לא
//  נחשפת התמונה בלי הרשאה ובלי תיעוד. ⚠️ אחסון דמו — בפרודקשן זה
//  יוחלף ב-vault/PMS (idverify/index.js), אבל הממשק והאבטחה זהים.
// ════════════════════════════════════════════════════════

// רשימת מסמכים (מטא-דטא בלבד — לעולם לא התמונה).
app.get("/api/id-documents", auth, (req, res) => {
  const hotelId = req.query.hotelId || DEFAULT_HOTEL_ID;
  res.json(listIdDocuments({ hotelId, reservationId: req.query.reservationId || null }));
});

// שליפת התמונה עצמה — מפוענחת לפי דרישה, מבודדת למלון, ומתועדת.
// דורש purpose (למה ניגשים) — נרשם ב-audit. actor = מזהה המשתמש/קבלה.
app.get("/api/id-document/:id/image", auth, async (req, res) => {
  const hotelId = req.query.hotelId || DEFAULT_HOTEL_ID;
  const out = await retrieveIdDocument(req.params.id, {
    hotelId,
    actor:   req.query.actor || req.headers["x-actor"] || "dashboard",
    purpose: req.query.purpose || "reception check-in review",
    ip:      req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
  });
  if (out.notFound) return res.status(404).json({ error: "not found" });
  if (out.denied)   return res.status(403).json({ error: "cross-tenant access denied (logged)" });
  if (out.deleted)  return res.status(410).json({ error: "document purged (retention)" });
  if (out.noImage)  return res.status(410).json({ error: "verify-then-discard: no image retained; verification is recorded", meta: out.meta });
  if (out.error || !out.buffer) return res.status(500).json({ error: "could not read document" });
  res.set("Content-Type", "image/jpeg");
  res.set("Cache-Control", "no-store"); // PII — לא נשמר במטמון הדפדפן
  res.send(out.buffer);
});

// יומן הגישות של מסמך (audit trail).
app.get("/api/id-document/:id/access-log", auth, (req, res) => {
  res.json(accessLogFor(req.params.id));
});

// הרצת מדיניות המחיקה (retention). נועד ל-cron; מפעילים גם ידנית.
app.post("/api/id-documents/purge", auth, async (req, res) => {
  try {
    res.json({ ok: true, retentionDays: RETENTION_DAYS, ...(await purgeExpiredIdDocuments()) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── רשומת אישור תנאי השהייה (Part ח') — ראיה בת-אכיפה ──
// משחזר בדיוק *מה* האורח אישר: איזה נוסח (version + hash של הטקסט),
// הנוסח המילולי שכתב ("אני מאשר"), השפה שהוצגה, ומתי. זו הראיה שהופכת
// אישור בוואטסאפ לבר-אכיפה — מענה ל"מה בדיוק אישרתי?" ולבירור משפטי.
app.get("/api/terms-acceptance/:rid", auth, (req, res) => {
  const r = reservations[req.params.rid];
  if (!r) return res.status(404).json({ error: "reservation not found" });
  res.json({
    reservationId:  r.id,
    hotelId:        r.hotelId,
    guestName:      r.guestName,
    phone:          r.phone,
    room:           r.roomNumber,
    termsVersion:   r.termsVersion,
    termsHash:      r.termsHash,          // SHA-256 של נוסח התנאים המדויק
    acceptanceText: r.termsAcceptanceText, // הנוסח המילולי שהאורח כתב
    language:       r.termsLang,           // השפה שהוצגה ואושרה
    acceptedAt:     r.termsAcceptedAt,
  });
});

// ── Health & readiness (Part 15/17 — zero-downtime deploys) ──
// ה-load balancer מפנה תעבורה רק לתהליך שעונה 200 כאן. liveness = "חי";
// readiness = "מוכן לקבל תעבורה" (DB נגיש). כך אפשר להחליף עותקים אחד-אחד
// בלי downtime: העותק החדש מקבל תעבורה רק כשהוא באמת מוכן.
app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.get("/ready", (req, res) => {
  try {
    dbCheck.get(); // בדיקת DB זולה — אם ה-DB לא נגיש, לא מוכנים לתעבורה.
    res.json({ status: "ready", draining: shuttingDown });
  } catch (e) {
    res.status(503).json({ status: "not_ready", error: e?.message });
  }
});
app.use(express.static("dashboard/public"));

// ── מלון ההדגמה מ-DEMO_HOTEL (קריטי לפריסה בענן) ────────
// חייב לרוץ **לפני** ה-listen: כך המיפוי קיים עוד לפני שההודעה הראשונה
// מגיעה, וגם הלוג שמודפס בעלייה משקף את המצב הנכון.
// בענן זו הדרך היחידה שמחזיקה — מערכת הקבצים שם בת-חלוף, ולכן ההגדרה
// נגזרת ממשתנה סביבה ולא מבסיס הנתונים. ראה demo-bootstrap.js.
await bootstrapDemoHotel().catch(e => console.error("⚠️ bootstrapDemoHotel נכשל:", e?.message || e));

const server = app.listen(PORT, () => {
  console.log(`\n🏨  Hotel Concierge Bot v4 — :${PORT}`);
  console.log(`📊  Dashboard → http://localhost:${PORT}`);
  console.log(`🔄  Reset session: /reset/+972XXXXXXXXX?token=${PASS}`);
  console.log(`🔄  Reset all: /reset-all?token=${PASS}\n`);

  // חיפוש אמיתי אחד מול Google, כדי שמפתח פסול יתגלה *עכשיו* ולא באמצע
  // הדגמה מול לקוח. לא ממתינים לו — השרת כבר מקבל בקשות; הכשל מטופל
  // בתוך smokePlaces ולעולם לא מפיל את התהליך.
  smokePlaces(hotelConfig.location).catch(() => {});

  // איזה PMS פעיל (Part ט'). Mock = המאגר המובנה הוא מקור האמת — תקין
  // לפיילוט/דמו. מלון עם PMS אמיתי יראה כאן את שם הספק ו"מחובר".
  const ph = pmsHealth(DEFAULT_HOTEL_ID);
  console.log(`🏨  PMS: ${ph.provider}${ph.connected ? " (מחובר)" : " — המאגר המובנה מקור האמת"}`);

  // ── אזהרות אבטחה בעלייה (Part ב') ────────────────────
  if (PASS === "hotel2024") {
    console.warn(`⚠️  אבטחה: DASHBOARD_PASSWORD בברירת מחדל ("hotel2024") — הגדירו סיסמה חזקה ב-env לפני פרודקשן.`);
  }
  if (process.env.VALIDATE_TWILIO !== "true") {
    console.warn(`⚠️  אבטחה: אימות חתימת Twilio כבוי — בפרודקשן הגדירו VALIDATE_TWILIO=true (עם BASE_URL ציבורי) כדי לחסום webhooks מזויפים.`);
  }
  // מוכנות מייל: מלון אמיתי חייב מיילים אמיתיים למחלקות (חצי מהניתוב).
  if (emailIsLive) {
    console.log(`✅  מייל: ספק אמיתי פעיל (${process.env.EMAIL_PROVIDER || "resend"}) — התראות מחלקה יישלחו במייל.`);
  } else {
    console.warn(`⚠️  מייל: MOCK בלבד (לא נשלח מייל אמיתי). למלון אמיתי הגדירו EMAIL_API_KEY + EMAIL_PROVIDER + EMAIL_FROM. (וואטסאפ עדיין נשלח.)`);
  }

  // ── מדיניות שמירה (retention) של מסמכי זיהוי ──────────
  // מוחק אוטומטית מסמכים שעבר זמנם (ברירת מחדל 30 יום). רץ בעלייה
  // ואז כל 6 שעות. unref כדי שלא יעכב יציאה תקינה של התהליך.
  purgeExpiredIdDocuments().catch(() => {});
  setInterval(() => purgeExpiredIdDocuments().catch(() => {}), 6 * 3600_000).unref();

  // ── מי עונה לכל מספר — הדבר הראשון שרוצים לראות בעלייה ──
  // 🔴 קודם הודפסה כאן טבלת הניתוב של *מלון ברירת המחדל* בלבד. כשהמספר
  //    היחיד מופנה למלון אחר (הדגמת LALA), הלוג הכריז בגדול "מלון kempinski"
  //    בזמן שהבוט עונה בפועל כ-LALA — בדיוק ההפך ממה שהלוג אמור לעשות רגע
  //    לפני הדגמה. לכן מדפיסים תחילה את המיפוי בפועל, ואז את טבלת הניתוב
  //    של כל מלון שיש לו מספר — כלומר של המלונות שבאמת מקבלים הודעות.
  let mappedHotels = [];
  try {
    const rows = db.prepare(`SELECT number, hotel_id FROM hotel_numbers ORDER BY number`).all();
    if (rows.length) {
      console.log(`\n📞 מספרים פעילים — מי עונה למי:`);
      for (const r of rows) {
        const cfg = configFor(r.hotel_id);
        const model = hotelModel(r.hotel_id);
        console.log(
          `   ${r.number}  →  ${cfg.name_he || cfg.name} (${r.hotel_id})` +
          `  ·  ${model.isBoutique ? "בוטיק" : "מלון מלא"}` +
          `  ·  ${model.keyDelivery === "door_code" ? "קוד לדלת" : "כרטיס בקבלה"}`
        );
      }
      mappedHotels = [...new Set(rows.map(r => r.hotel_id))];
    } else {
      console.warn(
        `\n⚠️  אין מיפוי מספרים ב-hotel_numbers — כל הודעה תנותב למלון ברירת המחדל ("${DEFAULT_HOTEL_ID}").`
      );
    }
  } catch (e) {
    console.warn("⚠️ קריאת מיפוי המספרים נכשלה:", e?.message || e);
  }

  // מחלקה בלי מספר/מייל = בקשות אורחים שנעלמות בשקט. מדווחים בעלייה.
  // טבלת הניתוב המלאה — כדי שלפני הדגמה רואים בעין אחת לאן כל בקשה הולכת,
  // ובאיזה ערוץ. מודפסת תמיד, גם (ובמיוחד) כשחסר איש קשר.
  if (mappedHotels.length) {
    for (const hid of mappedHotels) printRoutingTable(hid);
  } else {
    printRoutingTable();
  }

  // בודקים את המלונות ש*באמת* מקבלים הודעות (לפי המיפוי), ולא רק את
  // ברירת המחדל — אחרת "כל אנשי הקשר מוגדרים" מתייחס למלון שאף אחד לא
  // כותב אליו, בזמן שלמלון הפעיל חסר איש קשר.
  for (const hid of (mappedHotels.length ? mappedHotels : [DEFAULT_HOTEL_ID])) {
    const contacts = checkDepartmentContacts(hid);
    const label = configFor(hid).name_he || hid;
    if (contacts.ok) {
      console.log(`✅  ${label}: אנשי קשר של כל ${DEPARTMENTS.length} המחלקות מוגדרים (וואטסאפ + מייל)`);
    } else {
      console.error(
        `\n🚨 חסרים אנשי קשר של מחלקות במלון "${contacts.hotelId}":\n` +
        contacts.missing.map(k => `   • ${k}`).join("\n") +
        `\n   בקשה שתנותב למחלקה כזו לא תגיע לאיש. יש להשלים בקונפיג של המלון.\n`
      );
    }
  }

  // ── בידוד בין מלונות — כל מלון רשום, לא רק ברירת המחדל ──
  // מלון שיורש שדות מ-DEFAULTS נראה תקין לגמרי (שום דבר לא "חסר"), אבל
  // ההתראות והחשבוניות שלו מגיעות ליעדים של מלון ברירת המחדל. בודקים
  // בעלייה כדי שזה יתגלה לפני הדגמה, לא אחריה.
  try {
    const hotelIds = [...new Set(
      db.prepare(`SELECT DISTINCT hotel_id FROM hotel_numbers`).all().map(r => r.hotel_id)
    )].filter(h => h && h !== DEFAULT_HOTEL_ID);
    let allIsolated = true;
    for (const hid of hotelIds) if (!reportTenantIsolation(hid)) allIsolated = false;
    if (hotelIds.length && allIsolated) {
      console.log(`✅  בידוד בין מלונות תקין (${hotelIds.length} מלונות נוספים — אין שדות משותפים עם "${DEFAULT_HOTEL_ID}")`);
    }
  } catch (e) {
    console.warn("⚠️ בדיקת בידוד המלונות נכשלה:", e?.message || e);
  }
});

// ── כיבוי חינני (graceful shutdown) — Part 15/17 ───────
// 🔴 zero-downtime: ה-orchestrator שולח SIGTERM לפני שהוא מכבה עותק. אנחנו
//    (1) מסמנים draining כדי ש-/ready יחזיר "מתרוקן" וה-LB יפסיק לשלוח
//    תעבורה חדשה; (2) מפסיקים לקבל חיבורים חדשים; (3) נותנים לבקשות/קריאות
//    AI שכבר רצות לסיים; (4) סוגרים את ה-DB. עותק חדש כבר מקבל את התעבורה,
//    כך שאף אורח לא מרגיש. חלון חסד ארוך מהקריאה האיטית ביותר ל-Claude.
let shutdownStarted = false;
function gracefulShutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  shuttingDown = true; // /ready מדווח draining → ה-LB מסיט תעבורה מהעותק הזה
  console.log(`\n🛑 ${signal} — כיבוי חינני: מפסיקים לקבל חדשים, מסיימים מה שרץ…`);
  const force = setTimeout(() => {
    console.error("⏱️ חלון החסד הסתיים — יציאה כפויה.");
    process.exit(0);
  }, Number(process.env.SHUTDOWN_GRACE_MS) || 25_000);
  force.unref();
  server.close(() => {
    try { db.close(); } catch { /* כבר סגור */ }
    console.log("✅ כל הבקשות הסתיימו וה-DB נסגר — יציאה נקייה.");
    clearTimeout(force);
    process.exit(0);
  });
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
