// ════════════════════════════════════════════════════════
//  SERVER v3 — WhatsApp webhook + Dashboard + Checkin
// ════════════════════════════════════════════════════════
import express   from "express";
import dotenv    from "dotenv";
import { handleIncoming, wa, notifyStaff } from "./bot.js";
import { allSessions, sessions, staffAlerts, stats, patchSession } from "./state.js";
import { hotelConfig, updateConfig } from "./config.js";
import { reservations } from "./checkin.js";
import checkinRouter from "./checkin-routes.js";

dotenv.config();
const app  = express();
const PORT = process.env.PORT || 3000;
const PASS = process.env.DASHBOARD_PASSWORD || "hotel2024";

// Raw body for Stripe webhook (must come before express.json)
app.use("/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Simple auth middleware ────────────────────────────
function auth(req, res, next) {
  const token = req.headers["x-dashboard-token"] || req.query.token;
  if (token === PASS) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// ── WhatsApp Webhook ──────────────────────────────────
app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim();
  if (!from || !body) return res.sendStatus(200);
  console.log(`📩 [${from.slice(-8)}] ${body}`);
  handleIncoming(from, body).catch(console.error);
  res.type("text/xml").send("<Response></Response>");
});

// ── Check-in routes ───────────────────────────────────
app.use(checkinRouter);

// ── API: stats ────────────────────────────────────────
app.get("/api/stats", auth, (req, res) => {
  res.json({
    ...stats,
    activeSessions: Object.keys(sessions).length,
    checkedIn: allSessions().filter(s => s.stage === "checked_in").length,
    activeReservations: Object.values(reservations).filter(r => r.stage === "checked_in").length,
  });
});

// ── API: sessions ─────────────────────────────────────
app.get("/api/sessions", auth, (req, res) => res.json(allSessions()));

// ── API: reservations ─────────────────────────────────
app.get("/api/reservations", auth, (req, res) => {
  res.json(Object.values(reservations).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  ));
});

// ── API: send manual message ──────────────────────────
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

// ── API: staff alert ──────────────────────────────────
app.post("/api/alert", auth, async (req, res) => {
  const { dept, roomNumber, guestName, message, priority } = req.body;
  try {
    await notifyStaff({ dept, roomNumber, guestName, message, priority });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: alerts log ───────────────────────────────────
app.get("/api/alerts", auth, (req, res) => res.json(staffAlerts));

// ── API: hotel config ─────────────────────────────────
app.get("/api/config", auth, (req, res) => res.json(hotelConfig));
app.post("/api/config", auth, (req, res) => {
  updateConfig(req.body);
  res.json({ ok: true });
});

// ── Health check ──────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// ── Dashboard static ──────────────────────────────────
app.use(express.static("dashboard/public"));

app.listen(PORT, () => {
  console.log(`\n🏨  Hotel Concierge Bot v3 — :${PORT}`);
  console.log(`📊  Dashboard → http://localhost:${PORT}`);
  console.log(`💳  Stripe check-in enabled`);
  console.log(`🔑  Password: ${PASS}\n`);
});
