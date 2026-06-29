// ════════════════════════════════════════════════════════
//  CHECKIN ROUTES — payment webhook + success/cancel pages
// ════════════════════════════════════════════════════════
import express from "express";
import { reservations, completeCheckin, processCheckout } from "./checkin.js";
import { wa } from "./bot.js";
import { payments } from "./payments/index.js";
import { sessions } from "./state.js";

const router = express.Router();

// ── Demo payment page (GET) ───────────────────────────
// עמוד תשלום דמו — מציג את סכום הפיקדון וטופס כרטיס אשראי בסטנדרט
// ישראלי. ⚠️ דמו בלבד: שום סליקה אמיתית לא מתבצעת, ושום פרט כרטיס/ת.ז
// לא נשמר בשום מקום. שכבת התשלום המבודדת (Mock) נשארת כפי שהיא.
router.get("/checkin/pay", (req, res) => {
  const { rid } = req.query;
  const reservation = reservations[rid];

  if (!reservation) {
    return res.send(successPage("שגיאה", "לא נמצאה הזמנה. פנה לקבלה.", false));
  }

  // אם כבר בוצע צ'ק אין להזמנה הזו — לא מציגים שוב טופס תשלום, מנתבים לאישור.
  if (reservation.confirmationSent) {
    return res.redirect(`/checkin/success?rid=${rid}`);
  }

  const lang = sessions[reservation.phone]?.lang === "en" ? "en" : "he";
  res.send(paymentPage(rid, reservation, lang));
});

// ── Demo payment submit (POST) ────────────────────────
// מקבל את "התשלום", מתעלם לחלוטין מפרטי הכרטיס/ת.ז (לא נשמרים),
// ומנתב לדף האישור הקיים שמשלים את הצ'ק אין. אין כאן שום חיוב אמיתי.
router.post("/checkin/pay", express.urlencoded({ extended: false }), (req, res) => {
  const rid = req.body?.rid || req.query?.rid;
  const reservation = reservations[rid];

  if (!reservation) {
    return res.send(successPage("שגיאה", "לא נמצאה הזמנה. פנה לקבלה.", false));
  }

  // ⚠️ פרטי הכרטיס/ת.ז ב-req.body נזרקים כאן ולא נשמרים בשום מקום — דמו בלבד.
  res.redirect(`/checkin/success?rid=${rid}`);
});

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

// ── Payment Webhook ───────────────────────────────────
router.post("/payments/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["x-payment-signature"];
    let event;

    try {
      const result = payments.verifyWebhook({ rawBody: req.body, signature });
      if (!result.valid) throw new Error("Invalid signature");
      event = result.event;
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

  <p class="deposit-note">🔒 הפיקדון בסך ₪500 מוקפא בכרטיסך להבטחת השהייה. בצ'ק אאוט ינוכו ממנו חיובים אם יהיו, והיתרה תוחזר לכרטיסך תוך 3-5 ימי עסקים.</p>
  ` : ''}

  <a href="https://wa.me/14155238886" class="back-btn">💬 חזור לצ'אט</a>
</div>
</body>
</html>`;
}

// ── Demo payment page HTML (bilingual) ────────────────
function paymentPage(rid, reservation, lang = "he") {
  const he = lang === "he";
  const amount = ((reservation.deposit || 50000) / 100).toFixed(0); // ₪500
  const T = he
    ? {
        title: "תשלום פיקדון — Kempinski Hotel",
        hotel: "✦ Kempinski Hotel",
        heading: "פיקדון שהייה",
        sub: "תשלום מאובטח",
        depositLabel: "סכום הפיקדון",
        holdNote:
          "🔒 הפיקדון אינו חיוב — הוא מוקפא בכרטיסך להבטחת השהייה. בצ'ק אאוט ינוכו ממנו חיובים אם יהיו, והיתרה תוחזר אליך במלואה.",
        cardName: "שם בעל הכרטיס",
        cardNamePh: "כפי שמופיע על הכרטיס",
        cardNumber: "מספר כרטיס",
        expiry: "תוקף",
        cvv: "CVV",
        idNumber: "תעודת זהות של בעל הכרטיס",
        idPh: "9 ספרות",
        pay: `שלם ₪${amount}`,
        processing: "מעבד תשלום…",
        secure: "🔒 תשלום מוצפן ומאובטח",
        invalid: "נא למלא את כל השדות כנדרש",
      }
    : {
        title: "Deposit Payment — Kempinski Hotel",
        hotel: "✦ Kempinski Hotel",
        heading: "Security Deposit",
        sub: "Secure payment",
        depositLabel: "Deposit amount",
        holdNote:
          "🔒 The deposit is not a charge — it is held on your card to secure your stay. At check-out any charges are deducted from it, and the balance is refunded to you in full.",
        cardName: "Cardholder name",
        cardNamePh: "As shown on the card",
        cardNumber: "Card number",
        expiry: "Expiry",
        cvv: "CVV",
        idNumber: "Cardholder ID number",
        idPh: "9 digits",
        pay: `Pay ₪${amount}`,
        processing: "Processing payment…",
        secure: "🔒 Encrypted & secure payment",
        invalid: "Please fill in all fields correctly",
      };

  return `<!DOCTYPE html>
<html lang="${he ? "he" : "en"}" dir="${he ? "rtl" : "ltr"}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${T.title}</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;600;700&family=Playfair+Display:wght@400;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Heebo',sans-serif;background:#0D1117;color:#FAFAF8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#1A2238;border:1px solid rgba(201,168,76,0.2);border-radius:24px;padding:40px 32px;max-width:440px;width:100%}
.hotel{font-family:'Playfair Display',serif;font-size:13px;color:#C9A84C;letter-spacing:2px;text-transform:uppercase;text-align:center;margin-bottom:20px}
h1{font-family:'Playfair Display',serif;font-size:26px;text-align:center;margin-bottom:4px}
.sub{text-align:center;font-size:13px;color:rgba(250,250,248,0.45);margin-bottom:24px}
.amount-box{background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.25);border-radius:16px;padding:20px;text-align:center;margin-bottom:20px}
.amount-label{font-size:13px;color:rgba(250,250,248,0.55);margin-bottom:6px}
.amount-val{font-family:'Playfair Display',serif;font-size:40px;font-weight:700;color:#E8C96D}
.field{margin-bottom:16px}
label{display:block;font-size:13px;color:rgba(250,250,248,0.6);margin-bottom:7px}
input{width:100%;background:#0D1117;border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:13px 14px;color:#FAFAF8;font-size:15px;font-family:'Heebo',sans-serif;direction:ltr;text-align:${he ? "right" : "left"}}
input:focus{outline:none;border-color:#C9A84C;box-shadow:0 0 0 3px rgba(201,168,76,0.12)}
input::placeholder{color:rgba(250,250,248,0.25)}
.row{display:flex;gap:12px}
.row .field{flex:1}
.card-number{letter-spacing:1px}
.pay-btn{width:100%;background:linear-gradient(135deg,#C9A84C,#E8C96D);border:none;border-radius:50px;padding:16px;color:#0D1117;font-size:16px;font-weight:700;font-family:'Heebo',sans-serif;cursor:pointer;margin-top:8px;transition:opacity .2s}
.pay-btn:disabled{opacity:0.6;cursor:not-allowed}
.hold-note{font-size:12px;color:rgba(250,250,248,0.4);line-height:1.6;margin:16px 0 4px;text-align:center}
.secure{text-align:center;font-size:12px;color:rgba(34,197,94,0.8);margin-top:16px}
.err{color:#EF6B6B;font-size:13px;text-align:center;margin-top:12px;min-height:18px}
.cards{display:flex;gap:8px;justify-content:center;margin-bottom:20px;font-size:22px;opacity:0.85}
</style>
</head>
<body>
<div class="card">
  <div class="hotel">${T.hotel}</div>
  <h1>${T.heading}</h1>
  <div class="sub">${T.sub}</div>

  <div class="amount-box">
    <div class="amount-label">${T.depositLabel}</div>
    <div class="amount-val">₪${amount}</div>
  </div>

  <div class="cards">💳 🇮🇱</div>

  <form id="payForm" method="POST" action="/checkin/pay" autocomplete="off" novalidate>
    <input type="hidden" name="rid" value="${rid}">

    <div class="field">
      <label>${T.cardName}</label>
      <input type="text" id="holder" placeholder="${T.cardNamePh}" required>
    </div>

    <div class="field">
      <label>${T.cardNumber}</label>
      <input type="text" id="cardnum" class="card-number" inputmode="numeric" placeholder="0000 0000 0000 0000" maxlength="19" required>
    </div>

    <div class="row">
      <div class="field">
        <label>${T.expiry}</label>
        <input type="text" id="expiry" inputmode="numeric" placeholder="MM/YY" maxlength="5" required>
      </div>
      <div class="field">
        <label>${T.cvv}</label>
        <input type="text" id="cvv" inputmode="numeric" placeholder="•••" maxlength="4" required>
      </div>
    </div>

    <div class="field">
      <label>${T.idNumber}</label>
      <input type="text" id="idnum" inputmode="numeric" placeholder="${T.idPh}" maxlength="9" required>
    </div>

    <div class="err" id="err"></div>

    <button type="submit" class="pay-btn" id="payBtn">${T.pay}</button>
    <p class="hold-note">${T.holdNote}</p>
    <p class="secure">${T.secure}</p>
  </form>
</div>

<script>
  // ⚠️ דמו בלבד — שום פרט לא נשלח לסליקה ולא נשמר; רק עיצוב/אימות בצד הלקוח.
  var INVALID = ${JSON.stringify(T.invalid)};
  var PROCESSING = ${JSON.stringify(T.processing)};
  var cardnum = document.getElementById('cardnum');
  var expiry  = document.getElementById('expiry');
  var cvv     = document.getElementById('cvv');
  var idnum   = document.getElementById('idnum');

  cardnum.addEventListener('input', function(){
    var v = this.value.replace(/\\D/g,'').slice(0,16);
    this.value = v.replace(/(.{4})/g,'$1 ').trim();
  });
  expiry.addEventListener('input', function(){
    var v = this.value.replace(/\\D/g,'').slice(0,4);
    if (v.length >= 3) v = v.slice(0,2) + '/' + v.slice(2);
    this.value = v;
  });
  cvv.addEventListener('input', function(){ this.value = this.value.replace(/\\D/g,'').slice(0,4); });
  idnum.addEventListener('input', function(){ this.value = this.value.replace(/\\D/g,'').slice(0,9); });

  document.getElementById('payForm').addEventListener('submit', function(e){
    var err = document.getElementById('err');
    var holder = document.getElementById('holder').value.trim();
    var digits = cardnum.value.replace(/\\s/g,'');
    var ok = holder.length >= 2 && digits.length >= 13 && /^\\d{2}\\/\\d{2}$/.test(expiry.value)
             && cvv.value.length >= 3 && idnum.value.length === 9;
    if (!ok) { e.preventDefault(); err.textContent = INVALID; return; }
    err.textContent = '';
    var btn = document.getElementById('payBtn');
    btn.disabled = true;
    btn.textContent = PROCESSING;
    // ה-submit ממשיך כרגיל ל-POST /checkin/pay (דמו — בלי חיוב אמיתי).
  });
</script>
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
