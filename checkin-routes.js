// ════════════════════════════════════════════════════════
//  CHECKIN ROUTES — Stripe webhook + success/cancel pages
// ════════════════════════════════════════════════════════
import express from "express";
import Stripe from "stripe";
import { reservations, completeCheckin, processCheckout } from "./checkin.js";
import { wa } from "./bot.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

// ── Success page (after guest pays) ──────────────────
router.get("/checkin/success", async (req, res) => {
  const { rid } = req.query;
  const reservation = reservations[rid];

  if (!reservation) {
    return res.send(successPage("שגיאה", "לא נמצאה הזמנה. פנה לקבלה.", false));
  }

  // Auto-assign room (in production: pull from PMS)
  const roomNumber = reservation.roomNumber || "304";

  try {
    await completeCheckin(rid, roomNumber);
  } catch (e) {
    console.error("Check-in completion error:", e.message);
  }

  res.send(successPage(
    reservation.guestName,
    roomNumber,
    true
  ));
});

// ── Cancel page ───────────────────────────────────────
router.get("/checkin/cancel", (req, res) => {
  res.send(cancelPage());
});

// ── Stripe Webhook ────────────────────────────────────
router.post("/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const rid = session.metadata?.reservation_id;
      const phone = session.metadata?.phone;

      if (rid && reservations[rid]) {
        reservations[rid].paidAt = new Date().toISOString();
        console.log(`✅ Payment received for reservation ${rid}`);
      }
    }

    res.json({ received: true });
  }
);

// ── HTML Pages ────────────────────────────────────────
function successPage(guestName, roomNumber, success) {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>צ'ק אין — Kempinski Hotel</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;600;700&family=Playfair+Display:wght@400;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Heebo',sans-serif;background:#0D1117;color:#FAFAF8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#1A2238;border:1px solid rgba(201,168,76,0.2);border-radius:24px;padding:48px 40px;max-width:440px;width:100%;text-align:center}
.icon{font-size:64px;margin-bottom:24px}
.hotel{font-family:'Playfair Display',serif;font-size:14px;color:#C9A84C;letter-spacing:2px;text-transform:uppercase;margin-bottom:16px}
h1{font-family:'Playfair Display',serif;font-size:28px;margin-bottom:8px}
.welcome{font-size:16px;color:rgba(250,250,248,0.6);margin-bottom:32px}
.info-box{background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.2);border-radius:16px;padding:24px;margin-bottom:24px;text-align:right}
.info-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:14px}
.info-row:last-child{border-bottom:none}
.info-label{color:rgba(250,250,248,0.5)}
.info-val{font-weight:600;color:#E8C96D}
.deposit-note{font-size:12px;color:rgba(250,250,248,0.4);margin-top:16px;line-height:1.6}
.wifi-box{background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:12px;padding:16px;margin-bottom:24px}
.wifi-title{font-size:12px;color:#22C55E;font-weight:600;margin-bottom:8px;letter-spacing:0.5px}
.wifi-info{font-size:13px;color:rgba(250,250,248,0.7)}
.back-btn{display:inline-block;background:rgba(201,168,76,0.1);border:1px solid rgba(201,168,76,0.3);color:#E8C96D;padding:12px 24px;border-radius:50px;font-size:14px;font-family:'Heebo',sans-serif;text-decoration:none;margin-top:8px}
</style>
</head>
<body>
<div class="card">
  <div class="icon">${success ? '✅' : '❌'}</div>
  <div class="hotel">✦ Kempinski Hotel</div>
  <h1>${success ? `ברוכים הבאים,<br>${guestName}!` : guestName}</h1>
  <p class="welcome">${success ? 'הצ\'ק אין הושלם בהצלחה' : roomNumber}</p>

  ${success ? `
  <div class="info-box">
    <div class="info-row">
      <span class="info-label">חדר</span>
      <span class="info-val">🚪 ${roomNumber}</span>
    </div>
    <div class="info-row">
      <span class="info-label">צ'ק אאוט</span>
      <span class="info-val">12:00</span>
    </div>
    <div class="info-row">
      <span class="info-label">פיקדון</span>
      <span class="info-val">₪500 ✓</span>
    </div>
    <div class="info-row">
      <span class="info-label">ארוחת בוקר</span>
      <span class="info-val">07:00–11:00</span>
    </div>
    <div class="info-row">
      <span class="info-label">בריכה</span>
      <span class="info-val">07:00–22:00 | גג</span>
    </div>
  </div>

  <div class="wifi-box">
    <div class="wifi-title">📶 WiFi</div>
    <div class="wifi-info">Kempinski_Guest<br>סיסמה: Welcome2024</div>
  </div>

  <p class="deposit-note">💳 הפיקדון של ₪500 יוחזר אוטומטית לכרטיסך תוך 3-5 ימי עסקים לאחר הצ'ק אאוט.</p>
  ` : ''}

  <a href="https://wa.me/14155238886" class="back-btn">💬 חזור לצ'אט</a>
</div>
</body>
</html>`;
}

function cancelPage() {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>צ'ק אין בוטל</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;600&family=Playfair+Display:wght@700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Heebo',sans-serif;background:#0D1117;color:#FAFAF8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#1A2238;border:1px solid rgba(239,68,68,0.2);border-radius:24px;padding:48px 40px;max-width:400px;width:100%;text-align:center}
.icon{font-size:64px;margin-bottom:24px}
h1{font-family:'Playfair Display',serif;font-size:28px;margin-bottom:12px}
p{color:rgba(250,250,248,0.6);font-size:15px;line-height:1.7;margin-bottom:32px}
.btn{display:inline-block;background:rgba(201,168,76,0.1);border:1px solid rgba(201,168,76,0.3);color:#E8C96D;padding:12px 24px;border-radius:50px;font-size:14px;text-decoration:none}
</style>
</head>
<body>
<div class="card">
  <div class="icon">↩️</div>
  <h1>התשלום בוטל</h1>
  <p>לא בוצע חיוב.<br>חזור לוואטסאפ כדי לנסות שוב או לפנות לקבלה.</p>
  <a href="https://wa.me/14155238886" class="btn">💬 חזור לצ'אט</a>
</div>
</body>
</html>`;
}

export default router;
