// ════════════════════════════════════════════════════════
//  CHECKIN ROUTES — payment webhook + success/cancel pages
// ════════════════════════════════════════════════════════
import express from "express";
import { reservations, completeCheckin, depositExplainer, switchOverageToAlternateCard, markPaid, formatStayShort, stayOf, shekels } from "./checkin.js";
import { payments } from "./payments/index.js";
import { sessions } from "./state.js";
import { nameFor } from "./names.js";
import { hotelConfig } from "./config.js";

const router = express.Router();

// ── שפת העמוד — מקור אמת אחד לכל דף HTML ───────────────
// אורח שעשה צ'ק אין באנגלית חייב לראות *כל* עמוד באנגלית, כולל דף
// האישור שאליו הוא נוחת אחרי התשלום (שהיה עד כה עברית קשיחה).
// סדר העדיפויות:
//   1. שפת השיחה בוואטסאפ — מה שהאורח בחר בפועל.
//   2. Accept-Language של הדפדפן — כשאין הזמנה/סשן (למשל דף שגיאה).
//   3. עברית — ברירת מחדל של מלון ישראלי.
function pageLang(req, reservation) {
  const sessionLang = reservation && sessions[reservation.phone]?.lang;
  if (sessionLang === "en" || sessionLang === "he") return sessionLang;

  const accept = String(req?.headers?.["accept-language"] || "").toLowerCase();
  if (!accept) return "he";
  return /\bhe\b|^he[-_]|,he[-_;]/.test(accept) ? "he" : "en";
}

// ── Demo payment page (GET) ───────────────────────────
// עמוד תשלום דמו — מציג את סכום הפיקדון וטופס כרטיס אשראי בסטנדרט
// ישראלי. ⚠️ דמו בלבד: שום סליקה אמיתית לא מתבצעת, ושום פרט כרטיס/ת.ז
// לא נשמר בשום מקום. שכבת התשלום המבודדת (Mock) נשארת כפי שהיא.
router.get("/checkin/pay", (req, res) => {
  const { rid } = req.query;
  const reservation = reservations[rid];

  if (!reservation) return res.send(errorPage("no_reservation", pageLang(req, null)));

  // אם כבר בוצע צ'ק אין להזמנה הזו — לא מציגים שוב טופס תשלום, מנתבים לאישור.
  if (reservation.confirmationSent) {
    return res.redirect(`/checkin/success?rid=${rid}`);
  }

  res.send(paymentPage(rid, reservation, pageLang(req, reservation)));
});

// ── Demo payment submit (POST) ────────────────────────
// מקבל את "התשלום", מתעלם לחלוטין מפרטי הכרטיס/ת.ז (לא נשמרים),
// ומנתב לדף האישור הקיים שמשלים את הצ'ק אין. אין כאן שום חיוב אמיתי.
router.post("/checkin/pay", express.urlencoded({ extended: false }), (req, res) => {
  const rid = req.body?.rid || req.query?.rid;
  const reservation = reservations[rid];

  if (!reservation) return res.send(errorPage("no_reservation", pageLang(req, null)));

  // ⚠️ פרטי הכרטיס/ת.ז ב-req.body נזרקים כאן ולא נשמרים בשום מקום — דמו בלבד.
  res.redirect(`/checkin/success?rid=${rid}`);
});

// ── Success page (after guest pays) ──────────────────
router.get("/checkin/success", async (req, res) => {
  const { rid } = req.query;
  const reservation = reservations[rid];

  if (!reservation) return res.send(errorPage("no_reservation", pageLang(req, null)));

  // שפת העמוד נקבעת *לפני* completeCheckin — כדי שהיא תשקף את שפת
  // השיחה של האורח ולא תושפע מעדכוני הסשן שקורים בתוך הצ'ק אין.
  const lang = pageLang(req, reservation);

  // Auto-assign room (in production: pull from PMS)
  const roomNumber = reservation.roomNumber || "304";

  try {
    await completeCheckin(rid, roomNumber);
  } catch (e) {
    console.error("Check-in completion error:", e.message);
  }

  res.send(successPage(reservation, roomNumber, lang));
});

// ── Cancel page ───────────────────────────────────────
router.get("/checkin/cancel", (req, res) => {
  const reservation = reservations[req.query?.rid];
  res.send(cancelPage(pageLang(req, reservation)));
});

// ── יתרה מעל הפיקדון — תשלום בכרטיס *אחר* ──────────────
// כשהחיובים עלו על הפיקדון, ההפרש כבר חויב אוטומטית מכרטיס הפיקדון
// (הגנה על המלון). כאן האורח יכול לבחור להעביר את ההפרש לכרטיס אחר.
// GET: מציג טופס להזנת כרטיס חדש.
router.get("/checkout/balance/pay", (req, res) => {
  const { rid } = req.query;
  const reservation = reservations[rid];
  if (!reservation || !reservation.balanceAmount) {
    return res.send(errorPage("no_balance", pageLang(req, reservation)));
  }
  res.send(balancePage(rid, reservation, pageLang(req, reservation)));
});

// POST: "מקבל" את הכרטיס האחר (דמו — פרטי הכרטיס לא נשמרים), ומעביר את
// חיוב ההפרש מכרטיס הפיקדון לכרטיס האחר דרך switchOverageToAlternateCard.
router.post("/checkout/balance/pay", express.urlencoded({ extended: false }), async (req, res) => {
  const rid = req.body?.rid || req.query?.rid;
  const reservation = reservations[rid];
  if (!reservation) return res.send(errorPage("no_reservation", pageLang(req, null)));

  const lang = pageLang(req, reservation);
  try { await switchOverageToAlternateCard(rid, lang); }
  catch (e) { console.error("Alt-card switch error:", e.message); }
  res.redirect(`/checkout/paid?rid=${rid}`);
});

// דף אישור לאחר העברת ההפרש לכרטיס אחר
router.get("/checkout/paid", (req, res) => {
  const { rid } = req.query;
  const reservation = reservations[rid];
  const amount = shekels(reservation?.balanceAmount || 0);
  res.send(balancePaidPage(amount, pageLang(req, reservation)));
});

// דף "נשאר בכרטיס הפיקדון" (האורח ביטל את החלפת הכרטיס)
router.get("/checkout/skip", (req, res) => {
  const reservation = reservations[req.query?.rid];
  res.send(balanceSkipPage(pageLang(req, reservation)));
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

      if (rid && markPaid(rid)) {
        console.log(`✅ Payment received for reservation ${rid}`);
      }
    }

    res.json({ received: true });
  }
);

// ── HTML Pages ────────────────────────────────────────
// כל עמוד מקבל `lang` ומרנדר את *עצמו* בשפה הזו — כולל dir/lang של
// ה-HTML, כותרת הדפדפן, וכל תווית. שום עמוד לא מניח עברית.

// עמוד האישור אחרי התשלום — הנקודה שבה אורח אנגלי נחת בעבר על עמוד
// עברי מלא. כל הנתונים נשאבים מההזמנה ומ-hotelConfig לפי השפה.
function successPage(reservation, roomNumber, lang = "he") {
  const he   = lang === "he";
  const cfg  = hotelConfig;
  const name = nameFor(reservation, lang); // שם בשפת העמוד — לא הצורה העברית הקבועה
  const svc  = (key) => cfg.services[key]?.[lang] || cfg.services[key]?.en || {};
  const bf   = svc("breakfast"), pool = svc("pool");
  const stay = formatStayShort(stayOf(reservation), lang);

  const T = he
    ? { title: "צ'ק אין הושלם", heading: `ברוכים הבאים,<br>${name}!`, sub: "הצ'ק אין הושלם בהצלחה",
        room: "חדר", stay: "שהייה", checkout: "צ'ק אאוט", deposit: "פיקדון",
        breakfast: "ארוחת בוקר", pool: "בריכה", wifiPass: "סיסמה", back: "💬 חזור לצ'אט" }
    : { title: "Check-in complete", heading: `Welcome,<br>${name}!`, sub: "Your check-in is complete",
        room: "Room", stay: "Stay", checkout: "Check-out", deposit: "Deposit",
        breakfast: "Breakfast", pool: "Pool", wifiPass: "Password", back: "💬 Back to chat" };

  const rows = [
    [T.room, `🚪 ${roomNumber}`],
    stay ? [T.stay, `📅 ${stay}`] : null,
    [T.checkout, cfg.checkout_time],
    [T.deposit, `${shekels(reservation.deposit)} ✓`],
    [T.breakfast, bf.hours],
    [T.pool, pool.hours],
  ].filter(Boolean);

  return shellPage({
    lang, title: T.title, icon: "✅",
    body: `
  <h1>${T.heading}</h1>
  <p class="welcome">${T.sub}</p>

  <div class="info-box">
    ${rows.map(([label, val]) => `<div class="info-row">
      <span class="info-label">${label}</span>
      <span class="info-val">${val}</span>
    </div>`).join("\n    ")}
  </div>

  <div class="wifi-box">
    <div class="wifi-title">📶 WiFi</div>
    <div class="wifi-info">${cfg.wifi.name}<br>${T.wifiPass}: ${cfg.wifi.password}</div>
  </div>

  <p class="deposit-note">${depositExplainer(lang).replace(/\n/g, "<br>")}</p>

  <a href="https://wa.me/14155238886" class="back-btn">${T.back}</a>`,
  });
}

// ── עמוד שגיאה — דו-לשוני ──────────────────────────────
const ERRORS = {
  no_reservation: {
    he: { title: "לא נמצאה הזמנה", body: "לא הצלחנו לאתר את ההזמנה. אנא פנה/י לקבלה ונשמח לסייע." },
    en: { title: "Reservation not found", body: "We couldn't locate this reservation. Please contact reception and we'll be glad to help." },
  },
  no_balance: {
    he: { title: "אין יתרה לתשלום", body: "לא נמצאה יתרה פתוחה. אנא פנה/י לקבלה לכל בירור." },
    en: { title: "No balance due", body: "No open balance was found. Please contact reception with any question." },
  },
};

function errorPage(kind, lang = "he") {
  const t = (ERRORS[kind] || ERRORS.no_reservation)[lang === "he" ? "he" : "en"];
  return shellPage({
    lang, title: t.title, icon: "❌", accent: "rgba(239,68,68,0.2)",
    body: `<h1>${t.title}</h1>
  <p class="welcome">${t.body}</p>
  <a href="https://wa.me/14155238886" class="back-btn">${lang === "he" ? "💬 חזור לצ'אט" : "💬 Back to chat"}</a>`,
  });
}

// ── שלד עמוד משותף ─────────────────────────────────────
// dir/lang/יישור נגזרים משפת העמוד — כדי שעמוד באנגלית לא ייצא RTL.
function shellPage({ lang, title, icon, body, accent = "rgba(201,168,76,0.2)" }) {
  const he = lang === "he";
  return `<!DOCTYPE html>
<html lang="${he ? "he" : "en"}" dir="${he ? "rtl" : "ltr"}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — ${hotelConfig.name}</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;600;700&family=Playfair+Display:wght@400;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Heebo',sans-serif;background:#0D1117;color:#FAFAF8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#1A2238;border:1px solid ${accent};border-radius:24px;padding:48px 40px;max-width:440px;width:100%;text-align:center}
.icon{font-size:64px;margin-bottom:24px}
.hotel{font-family:'Playfair Display',serif;font-size:14px;color:#C9A84C;letter-spacing:2px;text-transform:uppercase;margin-bottom:16px}
h1{font-family:'Playfair Display',serif;font-size:28px;margin-bottom:8px}
.welcome{font-size:16px;color:rgba(250,250,248,0.6);margin-bottom:32px;line-height:1.7}
.info-box{background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.2);border-radius:16px;padding:24px;margin-bottom:24px;text-align:${he ? "right" : "left"}}
.info-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:14px}
.info-row:last-child{border-bottom:none}
.info-label{color:rgba(250,250,248,0.5);white-space:nowrap}
.info-val{font-weight:600;color:#E8C96D;text-align:${he ? "left" : "right"}}
.deposit-note{font-size:12px;color:rgba(250,250,248,0.4);margin-top:16px;line-height:1.6;text-align:${he ? "right" : "left"}}
.wifi-box{background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:12px;padding:16px;margin-bottom:24px}
.wifi-title{font-size:12px;color:#22C55E;font-weight:600;margin-bottom:8px;letter-spacing:0.5px}
.wifi-info{font-size:13px;color:rgba(250,250,248,0.7)}
.back-btn{display:inline-block;background:rgba(201,168,76,0.1);border:1px solid rgba(201,168,76,0.3);color:#E8C96D;padding:12px 24px;border-radius:50px;font-size:14px;font-family:'Heebo',sans-serif;text-decoration:none;margin-top:8px}
</style>
</head>
<body>
<div class="card">
  <div class="icon">${icon}</div>
  <div class="hotel">✦ ${hotelConfig.name}</div>
  ${body}
</div>
</body>
</html>`;
}

// ── Demo payment page HTML (bilingual) ────────────────
function paymentPage(rid, reservation, lang = "he") {
  const he = lang === "he";
  const amount = ((reservation.deposit || 50000) / 100).toFixed(0); // ₪500
  const stay = formatStayShort(stayOf(reservation), lang);
  const T = he
    ? {
        title: `אישור פיקדון — ${hotelConfig.name}`,
        hotel: `✦ ${hotelConfig.name}`,
        heading: "אישור פיקדון שהייה",
        sub: stay || "הקפאת פיקדון מאובטחת",
        depositLabel: "סכום הפיקדון",
        holdNote: depositExplainer("he").replace(/\n/g, "<br>"),
        cardName: "שם בעל הכרטיס",
        cardNamePh: "כפי שמופיע על הכרטיס",
        cardNumber: "מספר כרטיס",
        expiry: "תוקף",
        cvv: "CVV",
        idNumber: "תעודת זהות של בעל הכרטיס",
        idPh: "9 ספרות",
        pay: `אשר פיקדון ₪${amount}`,
        processing: "מאשר פיקדון…",
        secure: "🔒 הקפאה מוצפנת ומאובטחת — לא מבוצע חיוב",
        invalid: "נא למלא את כל השדות כנדרש",
      }
    : {
        title: `Confirm Deposit — ${hotelConfig.name}`,
        hotel: `✦ ${hotelConfig.name}`,
        heading: "Confirm Security Deposit",
        sub: stay || "Secure deposit hold",
        depositLabel: "Deposit amount",
        holdNote: depositExplainer("en").replace(/\n/g, "<br>"),
        cardName: "Cardholder name",
        cardNamePh: "As shown on the card",
        cardNumber: "Card number",
        expiry: "Expiry",
        cvv: "CVV",
        idNumber: "Cardholder ID number",
        idPh: "9 digits",
        pay: `Confirm ₪${amount} deposit`,
        processing: "Confirming deposit…",
        secure: "🔒 Encrypted & secure hold — no charge is made",
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

// ── Balance-on-another-card page (bilingual) ──────────
// עמוד תשלום ההפרש (מעל הפיקדון) בכרטיס אחר. דמו בלבד — שום סליקה
// אמיתית ושום פרט כרטיס לא נשמר. מבנה זהה לעמוד הפיקדון.
function balancePage(rid, reservation, lang = "he") {
  const he = lang === "he";
  const amount = ((reservation.balanceAmount || 0) / 100).toFixed(0);
  const name = nameFor(reservation, lang); // שם בשפת העמוד — לא הצורה העברית
  const T = he
    ? {
        title: `תשלום יתרה בכרטיס אחר — ${hotelConfig.name}`,
        hotel: `✦ ${hotelConfig.name}`,
        heading: "תשלום יתרה בכרטיס אחר",
        sub: `חדר ${reservation.roomNumber} · ${name}`,
        amountLabel: "יתרה לתשלום (מעל הפיקדון)",
        note: "💡 ההפרש כבר חויב מכרטיס הפיקדון. בהזנת כרטיס כאן — ההפרש יועבר לכרטיס זה במקום.",
        cardName: "שם בעל הכרטיס", cardNamePh: "כפי שמופיע על הכרטיס",
        cardNumber: "מספר כרטיס", expiry: "תוקף", cvv: "CVV",
        pay: `שלם ₪${amount} בכרטיס זה`, processing: "מעבד…",
        secure: "🔒 מאובטח — דמו, לא מבוצע חיוב אמיתי", invalid: "נא למלא את כל השדות כנדרש",
      }
    : {
        title: `Pay balance with another card — ${hotelConfig.name}`,
        hotel: `✦ ${hotelConfig.name}`,
        heading: "Pay balance with another card",
        sub: `Room ${reservation.roomNumber} · ${name}`,
        amountLabel: "Balance due (over the deposit)",
        note: "💡 The difference was already charged to your deposit card. Entering a card here moves the charge to this card instead.",
        cardName: "Cardholder name", cardNamePh: "As shown on the card",
        cardNumber: "Card number", expiry: "Expiry", cvv: "CVV",
        pay: `Pay ₪${amount} with this card`, processing: "Processing…",
        secure: "🔒 Secure — demo, no real charge is made", invalid: "Please fill in all fields correctly",
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
h1{font-family:'Playfair Display',serif;font-size:24px;text-align:center;margin-bottom:4px}
.sub{text-align:center;font-size:13px;color:rgba(250,250,248,0.45);margin-bottom:24px}
.amount-box{background:rgba(239,107,107,0.08);border:1px solid rgba(239,107,107,0.25);border-radius:16px;padding:20px;text-align:center;margin-bottom:16px}
.amount-label{font-size:13px;color:rgba(250,250,248,0.55);margin-bottom:6px}
.amount-val{font-family:'Playfair Display',serif;font-size:40px;font-weight:700;color:#EF6B6B}
.note{font-size:12px;color:rgba(250,250,248,0.55);line-height:1.6;margin-bottom:20px;text-align:center}
.field{margin-bottom:16px}
label{display:block;font-size:13px;color:rgba(250,250,248,0.6);margin-bottom:7px}
input{width:100%;background:#0D1117;border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:13px 14px;color:#FAFAF8;font-size:15px;font-family:'Heebo',sans-serif;direction:ltr;text-align:${he ? "right" : "left"}}
input:focus{outline:none;border-color:#C9A84C;box-shadow:0 0 0 3px rgba(201,168,76,0.12)}
input::placeholder{color:rgba(250,250,248,0.25)}
.row{display:flex;gap:12px}
.row .field{flex:1}
.pay-btn{width:100%;background:linear-gradient(135deg,#C9A84C,#E8C96D);border:none;border-radius:50px;padding:16px;color:#0D1117;font-size:16px;font-weight:700;font-family:'Heebo',sans-serif;cursor:pointer;margin-top:8px}
.pay-btn:disabled{opacity:0.6;cursor:not-allowed}
.secure{text-align:center;font-size:12px;color:rgba(34,197,94,0.8);margin-top:16px}
.err{color:#EF6B6B;font-size:13px;text-align:center;margin-top:12px;min-height:18px}
</style>
</head>
<body>
<div class="card">
  <div class="hotel">${T.hotel}</div>
  <h1>${T.heading}</h1>
  <div class="sub">${T.sub}</div>

  <div class="amount-box">
    <div class="amount-label">${T.amountLabel}</div>
    <div class="amount-val">₪${amount}</div>
  </div>
  <p class="note">${T.note}</p>

  <form id="payForm" method="POST" action="/checkout/balance/pay" autocomplete="off" novalidate>
    <input type="hidden" name="rid" value="${rid}">
    <div class="field">
      <label>${T.cardName}</label>
      <input type="text" id="holder" placeholder="${T.cardNamePh}" required>
    </div>
    <div class="field">
      <label>${T.cardNumber}</label>
      <input type="text" id="cardnum" inputmode="numeric" placeholder="0000 0000 0000 0000" maxlength="19" required>
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
    <div class="err" id="err"></div>
    <button type="submit" class="pay-btn" id="payBtn">${T.pay}</button>
    <p class="secure">${T.secure}</p>
  </form>
</div>
<script>
  // ⚠️ דמו בלבד — שום פרט לא נשלח לסליקה ולא נשמר.
  var INVALID = ${JSON.stringify(T.invalid)};
  var PROCESSING = ${JSON.stringify(T.processing)};
  var cardnum = document.getElementById('cardnum');
  var expiry  = document.getElementById('expiry');
  var cvv     = document.getElementById('cvv');
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
  document.getElementById('payForm').addEventListener('submit', function(e){
    var err = document.getElementById('err');
    var holder = document.getElementById('holder').value.trim();
    var digits = cardnum.value.replace(/\\s/g,'');
    var ok = holder.length >= 2 && digits.length >= 13 && /^\\d{2}\\/\\d{2}$/.test(expiry.value) && cvv.value.length >= 3;
    if (!ok) { e.preventDefault(); err.textContent = INVALID; return; }
    err.textContent = '';
    var btn = document.getElementById('payBtn');
    btn.disabled = true; btn.textContent = PROCESSING;
  });
</script>
</body>
</html>`;
}

// דף אישור לאחר העברת ההפרש לכרטיס אחר
function balancePaidPage(amount, lang = "he") {
  const he = lang === "he";
  return shellPage({
    lang, icon: "✅",
    title: he ? "התשלום עודכן" : "Payment updated",
    body: `<h1>${he ? "התשלום עודכן" : "Payment updated"}</h1>
  <p class="welcome">${he
      ? `ההפרש (${amount}) חויב מהכרטיס החדש שהזנת, במקום מכרטיס הפיקדון.<br>תודה!`
      : `The difference (${amount}) was charged to the new card you entered, instead of your deposit card.<br>Thank you!`}</p>
  <a href="https://wa.me/14155238886" class="back-btn">${he ? "💬 חזור לצ'אט" : "💬 Back to chat"}</a>`,
  });
}

// דף לאחר ביטול החלפת הכרטיס (ההפרש נשאר על כרטיס הפיקדון)
function balanceSkipPage(lang = "he") {
  const he = lang === "he";
  return shellPage({
    lang, icon: "↩️",
    title: he ? "ללא שינוי" : "No change made",
    body: `<h1>${he ? "ללא שינוי" : "No change made"}</h1>
  <p class="welcome">${he
      ? "ההפרש נשאר מחויב מכרטיס הפיקדון שהזנת בצ'ק אין.<br>אפשר לפנות לקבלה בכל שאלה."
      : "The difference remains charged to the card you entered at check-in.<br>Reception is happy to help with any question."}</p>
  <a href="https://wa.me/14155238886" class="back-btn">${he ? "💬 חזור לצ'אט" : "💬 Back to chat"}</a>`,
  });
}

function cancelPage(lang = "he") {
  const he = lang === "he";
  return shellPage({
    lang, icon: "↩️", accent: "rgba(239,68,68,0.2)",
    title: he ? "אישור הפיקדון בוטל" : "Deposit cancelled",
    body: `<h1>${he ? "אישור הפיקדון בוטל" : "Deposit confirmation cancelled"}</h1>
  <p class="welcome">${he
      ? "לא בוצעה הקפאת פיקדון ולא בוצע חיוב.<br>חזור/חזרי לוואטסאפ כדי לנסות שוב, או פנה/פני לקבלה."
      : "No deposit hold was placed and nothing was charged.<br>Head back to WhatsApp to try again, or contact reception."}</p>
  <a href="https://wa.me/14155238886" class="back-btn">${he ? "💬 חזור לצ'אט" : "💬 Back to chat"}</a>`,
  });
}

export default router;
