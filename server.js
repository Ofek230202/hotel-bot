// ════════════════════════════════════════════════════════
//  SERVER v4 — With session reset endpoint
// ════════════════════════════════════════════════════════
import express   from "express";
import dotenv    from "dotenv";
import { handleIncoming, wa, notifyStaff } from "./bot.js";
import { allSessions, sessions, staffAlerts, incidents, stats } from "./state.js";
import { hotelConfig, updateConfig } from "./config.js";
import { reservations } from "./checkin.js";
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
  const body = req.body.Body?.trim();
  if (!from || !body) return res.sendStatus(200);
  console.log(`📩 [${from.slice(-8)}] ${body}`);
  handleIncoming(from, body).catch(console.error);
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
