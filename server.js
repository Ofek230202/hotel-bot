// ════════════════════════════════════════════════════════
//  SERVER v4 — With session reset endpoint
// ════════════════════════════════════════════════════════
import express   from "express";
import dotenv    from "dotenv";
import { handleIncoming, wa, notifyStaff } from "./bot.js";
import { allSessions, sessions, staffAlerts, incidents, stats } from "./state.js";
import { hotelConfig, updateConfig } from "./config.js";
import { reservations, addFolioItem, getFolioTotal, formatFolio, FOLIO_CATEGORIES, autoChargeOnNoShow, findNoShowReservations } from "./checkin.js";
import checkinRouter from "./checkin-routes.js";

dotenv.config();
const app  = express();
const PORT = process.env.PORT || 3000;
const PASS = process.env.DASHBOARD_PASSWORD || "hotel2024";

app.use("/payments/webhook", express.raw({ type: "application/json" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function auth(req, res, next) {
  const token = req.headers["x-dashboard-token"] || req.query.token;
  if (token === PASS) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// ── WhatsApp Webhook ──────────────────────────────────
app.post("/webhook", async (req, res) => {
  const from = req.body.From;
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
  console.log(`📩 [${from.slice(-8)}] ${body || `<media:${media?.contentType || "?"}>`}`);
  handleIncoming(from, body, media).catch(console.error);
  res.type("text/xml").send("<Response></Response>");
});

// ── Check-in routes ───────────────────────────────────
app.use(checkinRouter);

// ── RESET SESSION — לאיפוס סשן ────────────────────────
app.get("/reset/:phone", auth, (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const full = phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`;
  if (sessions[full]) {
    delete sessions[full];
    console.log(`🔄 Session reset: ${full}`);
    res.json({ ok: true, message: `Session reset for ${full}` });
  } else {
    res.json({ ok: true, message: "No session found — already clean" });
  }
});

// ── RESET ALL SESSIONS ────────────────────────────────
app.get("/reset-all", auth, (req, res) => {
  const count = Object.keys(sessions).length;
  Object.keys(sessions).forEach(k => delete sessions[k]);
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

app.get("/api/sessions", auth, (req, res) => res.json(allSessions()));

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

app.get("/api/alerts", auth, (req, res) => res.json(staffAlerts));
app.get("/api/incidents", auth, (req, res) => res.json(incidents));
app.get("/api/config", auth, (req, res) => res.json(hotelConfig));
app.post("/api/config", auth, (req, res) => { updateConfig(req.body); res.json({ ok: true }); });
app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.use(express.static("dashboard/public"));

app.listen(PORT, () => {
  console.log(`\n🏨  Hotel Concierge Bot v4 — :${PORT}`);
  console.log(`📊  Dashboard → http://localhost:${PORT}`);
  console.log(`🔄  Reset session: /reset/+972XXXXXXXXX?token=${PASS}`);
  console.log(`🔄  Reset all: /reset-all?token=${PASS}\n`);
});
