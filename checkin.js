// ════════════════════════════════════════════════════════
//  CHECKIN v4 — Full billing, deposit capture, checkout
// ════════════════════════════════════════════════════════
import { v4 as uuidv4 } from "uuid";
import { wa } from "./bot.js";
import { logAlert, stats, patchSession, sessions } from "./state.js";
import { payments, PAYMENT_CURRENCY } from "./payments/index.js";

// נקרא תמיד בזמן-קריאה (lazy), אחרי ש-dotenv.config() כבר רץ.
// אם נשמר כקבוע בראש הקובץ הוא נתפס כ-undefined בגלל סדר טעינת המודולים
// (checkin.js מיובא לפני ש-dotenv.config() רץ ב-bot.js/server.js) — מה שגרם
// לקישורי תשלום מסוג "undefined/checkin/success...".
function baseUrl() {
  return process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
}

export const reservations = {};

export const FOLIO_CATEGORIES = {
  MINIBAR:      { he: "מיני בר",       en: "Mini Bar",     icon: "🍾" },
  RESTAURANT:   { he: "מסעדה",         en: "Restaurant",   icon: "🍽️" },
  ROOM_SERVICE: { he: "שירות לחדר",    en: "Room Service", icon: "🛎️" },
  SPA:          { he: "ספא",           en: "Spa",          icon: "🧖" },
  PARKING:      { he: "חניה",          en: "Parking",      icon: "🅿️" },
  LAUNDRY:      { he: "כביסה",         en: "Laundry",      icon: "👕" },
  OTHER:        { he: "שונות",         en: "Other",        icon: "📋" },
};

// ── Start check-in ────────────────────────────────────
export async function startCheckin(phone, guestName, reservationId) {
  const id      = uuidv4();
  const DEPOSIT = 50000; // ₪500 באגורות (lowest currency unit)

  reservations[id] = {
    id, phone, guestName, reservationId,
    roomNumber: null,
    stage: "pending_payment",
    deposit: DEPOSIT,
    currency: PAYMENT_CURRENCY,
    folio: [],
    paymentId: null,
    paymentUrl: null,
    createdAt: new Date().toISOString(),
    paidAt: null, checkedInAt: null, checkedOutAt: null,
    refunded: false, captured: false, capturedAmount: 0,
    balanceAmount: 0, balancePaymentUrl: null,
    confirmationSent: false, // הגנת idempotency — אישור צ'ק אין יישלח פעם אחת בלבד
  };

  const auth = await payments.authorizeDeposit({
    reservationId: id,
    amount: DEPOSIT,
    currency: PAYMENT_CURRENCY,
    guestName,
    phone,
    description: "פיקדון שהייה — Kempinski Hotel",
    // עמוד התשלום (אצל ספק אמיתי — דף הסליקה המתארח שלו; אצל ה-Mock —
    // דף תשלום הדמו הפנימי שלנו). לשם נשלח האורח כדי "לשלם".
    paymentPageUrl: `${baseUrl()}/checkin/pay?rid=${id}`,
    successUrl: `${baseUrl()}/checkin/success?rid=${id}`,
    cancelUrl:  `${baseUrl()}/checkin/cancel?rid=${id}`,
  });

  reservations[id].paymentId  = auth.paymentId;
  reservations[id].paymentUrl = auth.redirectUrl;
  return { reservationId: id, paymentUrl: auth.redirectUrl };
}

// ── Complete check-in ─────────────────────────────────
export async function completeCheckin(reservationId, roomNumber) {
  const res = reservations[reservationId];
  if (!res) throw new Error("Reservation not found");

  // ── הגנת idempotency (Bug #2) ─────────────────────────
  // דף האישור (GET /checkin/success) עלול להיטען כמה פעמים — preview
  // crawlers של וואטסאפ, prefetch, רענון של האורח — וכל טעינה קראה
  // ל-completeCheckin ושלחה שוב הודעת "צ'ק אין אושר" (נצפו 4 כפילויות).
  // אם כבר נשלח אישור להזמנה הזו — לא שולחים שוב, פשוט מחזירים אותה.
  if (res.confirmationSent) return res;
  res.confirmationSent = true; // מסומן סינכרונית, לפני ה-await, כדי שטעינות
                               // מקבילות לא יעקפו את ההגנה.

  // הפיקדון כבר אושר בשלב startCheckin (paymentId שמור) — אין צורך
  // לשלוף שום דבר מהספק כאן.
  res.roomNumber  = roomNumber || "304";
  res.stage       = "checked_in";
  res.checkedInAt = new Date().toISOString();
  res.paidAt      = new Date().toISOString();
  stats.checkIns++;

  // ── קישור session ↔ reservation (Bug #3) ─────────────
  // מסמן את ה-session כ-checked_in ושומר reservationId + roomNumber,
  // כדי שזרימת הצ'ק אאוט תהיה נגישה דרך הצ'אט.
  patchSession(res.phone, {
    stage:         "checked_in",
    reservationId: res.id,
    roomNumber:    res.roomNumber,
    guestName:     res.guestName,
    checkinStage:  null,
    checkInAt:     res.checkedInAt,
  });

  const he = (sessions[res.phone]?.lang || "he") === "he";
  await wa(res.phone, he
    ? `✅ *צ'ק אין אושר!*\n\n` +
      `ברוכים הבאים, *${res.guestName}*! 🌟\n\n` +
      `🚪 *חדר:* ${res.roomNumber}\n` +
      `🔒 *פיקדון ₪500* — מוקפא להבטחת השהייה. בצ'ק אאוט ינוכו ממנו חיובים אם יהיו, והיתרה תוחזר לכרטיסך\n` +
      `📶 WiFi: Kempinski_Guest | Welcome2024\n\n` +
      `🍳 ארוחת בוקר: 07:00–11:00\n` +
      `🏊 בריכה: 07:00–22:00 | גג קומה 12\n` +
      `🛎️ שירות לחדר: 24/7 | שלוחה 0\n\n` +
      `לכל בקשה — אני כאן! 😊`
    : `✅ *Check-in confirmed!*\n\n` +
      `Welcome, *${res.guestName}*! 🌟\n\n` +
      `🚪 *Room:* ${res.roomNumber}\n` +
      `🔒 *₪500 deposit* — held to secure your stay. At check-out any charges are deducted from it and the balance is refunded to your card\n` +
      `📶 WiFi: Kempinski_Guest | Welcome2024\n\n` +
      `🍳 Breakfast: 07:00–11:00\n` +
      `🏊 Pool: 07:00–22:00 | Rooftop, Level 12\n` +
      `🛎️ Room service: 24/7 | Ext. 0\n\n` +
      `I'm here for anything you need! 😊`
  );

  await logAlert({
    dept: "reception", roomNumber: res.roomNumber, guestName: res.guestName,
    message: `✅ צ'ק אין דיגיטלי | פיקדון ₪500 מאושר | חדר ${res.roomNumber}`,
    priority: "normal",
  });

  return res;
}

// ── Add item to folio ─────────────────────────────────
export function addFolioItem(reservationId, category, description, amountCents) {
  const res = reservations[reservationId];
  if (!res) throw new Error("Reservation not found");
  res.folio.push({ id: uuidv4(), category, description, amount: amountCents, addedAt: new Date().toISOString() });
  return res;
}

export function getFolioTotal(reservationId) {
  const res = reservations[reservationId];
  if (!res) return 0;
  return res.folio.reduce((sum, item) => sum + item.amount, 0);
}

// ── Format bill for WhatsApp ──────────────────────────
export function formatFolio(res, lang = "he") {
  const total   = getFolioTotal(res.id);
  const deposit = res.deposit;

  if (res.folio.length === 0) {
    return lang === "he"
      ? `📋 *סיכום חשבון — חדר ${res.roomNumber}*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n✅ אין חיובים נוספים\n` +
        `━━━━━━━━━━━━━━━━━━━━\n💳 פיקדון ₪500 יוחזר לכרטיסך`
      : `📋 *Bill Summary — Room ${res.roomNumber}*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n✅ No additional charges\n` +
        `━━━━━━━━━━━━━━━━━━━━\n💳 ₪500 deposit will be refunded`;
  }

  const lines = res.folio.map(item => {
    const cat  = FOLIO_CATEGORIES[item.category] || FOLIO_CATEGORIES.OTHER;
    const name = lang === "he" ? cat.he : cat.en;
    return `${cat.icon} ${item.description || name}    ₪${(item.amount/100).toFixed(2)}`;
  }).join("\n");

  const totalStr   = (total/100).toFixed(2);
  const depositStr = (deposit/100).toFixed(2);

  if (total <= deposit) {
    const refund = ((deposit - total)/100).toFixed(2);
    return lang === "he"
      ? `📋 *סיכום חשבון — חדר ${res.roomNumber}*\n━━━━━━━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━━━━━━━\nסה"כ:      ₪${totalStr}\nפיקדון:    ₪${depositStr}\n━━━━━━━━━━━━━━━━━━━━\n💚 יחזור לכרטיסך: ₪${refund}`
      : `📋 *Bill — Room ${res.roomNumber}*\n━━━━━━━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━━━━━━━\nTotal:    ₪${totalStr}\nDeposit:  ₪${depositStr}\n━━━━━━━━━━━━━━━━━━━━\n💚 Refund: ₪${refund}`;
  } else {
    const balance = ((total - deposit)/100).toFixed(2);
    return lang === "he"
      ? `📋 *סיכום חשבון — חדר ${res.roomNumber}*\n━━━━━━━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━━━━━━━\nסה"כ:         ₪${totalStr}\nפיקדון:       ₪${depositStr}\n━━━━━━━━━━━━━━━━━━━━\n🔴 *יתרה לתשלום: ₪${balance}*`
      : `📋 *Bill — Room ${res.roomNumber}*\n━━━━━━━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━━━━━━━\nTotal:    ₪${totalStr}\nDeposit:  ₪${depositStr}\n━━━━━━━━━━━━━━━━━━━━\n🔴 *Balance due: ₪${balance}*`;
  }
}

// ── Process check-out ─────────────────────────────────
export async function processCheckout(phone, reservationId, lang = "he") {
  const res = reservationId
    ? reservations[reservationId]
    : Object.values(reservations).find(r => r.phone === phone && r.stage === "checked_in");

  if (!res) throw new Error("No active reservation found");

  const he      = lang === "he";
  const total   = getFolioTotal(res.id);
  const deposit = res.deposit;

  res.stage        = "checked_out";
  res.checkedOutAt = new Date().toISOString();
  stats.checkOuts++;

  // ── A: No charges → cancel authorization ──────────
  if (total === 0) {
    try { await payments.cancel({ paymentId: res.paymentId }); } catch(e) {}
    res.refunded = true;

    await wa(res.phone, he
      ? `🚪 *צ'ק אאוט הושלם!*\n\n` +
        `תודה, *${res.guestName}*! שמחנו לארח אותך 🌟\n\n` +
        `✅ אין חיובים נוספים\n` +
        `💳 *הפיקדון בסך ₪500 שוחרר במלואו* — לא בוצע חיוב\n\n` +
        `נשמח לראותך שוב! ⭐`
      : `🚪 *Check-out complete!*\n\n` +
        `Thank you, *${res.guestName}*! It was a pleasure hosting you 🌟\n\n` +
        `✅ No additional charges\n` +
        `💳 *Your ₪500 deposit was released in full* — nothing was charged\n\n` +
        `We hope to see you again! ⭐`
    );
  }

  // ── B: Charges ≤ deposit → capture exact amount ───
  else if (total <= deposit) {
    try {
      const cap = await payments.capture({ paymentId: res.paymentId, amount: total });
      res.captured = true;
      res.capturedAmount = cap.capturedAmount;
    } catch(e) { console.error("Capture error:", e.message); }

    const charged = (total/100).toFixed(2);
    const refund  = ((deposit-total)/100).toFixed(2);

    await wa(res.phone, he
      ? `🚪 *צ'ק אאוט הושלם!*\n\n` +
        `תודה, *${res.guestName}*! 🌟\n\n` +
        formatFolio(res, lang) + "\n\n" +
        `💳 *נוכה מהפיקדון: ₪${charged}*\n` +
        `💚 *יתרת הפיקדון שתוחזר לכרטיסך: ₪${refund}*\n` +
        `⏱ תוך 3-5 ימי עסקים\n\n` +
        `נשמח לראותך שוב! ⭐`
      : `🚪 *Check-out complete!*\n\n` +
        `Thank you, *${res.guestName}*! 🌟\n\n` +
        formatFolio(res, lang) + "\n\n" +
        `💳 *Deducted from your deposit: ₪${charged}*\n` +
        `💚 *Remaining deposit refunded to your card: ₪${refund}*\n` +
        `⏱ Within 3-5 business days\n\n` +
        `We hope to see you again! ⭐`
    );
  }

  // ── C: Charges > deposit → capture all + send balance link ──
  else {
    const balance    = total - deposit;
    const balanceStr = (balance/100).toFixed(2);

    // Capture full deposit automatically — no guest action needed
    try {
      const cap = await payments.capture({ paymentId: res.paymentId, amount: deposit });
      res.captured = true;
      res.capturedAmount = cap.capturedAmount;
    } catch(e) { console.error("Capture error:", e.message); }

    // Create payment link for remaining balance
    const balPayment = await payments.createBalancePayment({
      reservationId: res.id,
      amount: balance,
      currency: PAYMENT_CURRENCY,
      description: he
        ? `יתרת חשבון — חדר ${res.roomNumber} · ${res.guestName}`
        : `Balance due — Room ${res.roomNumber} · ${res.guestName}`,
      successUrl: `${baseUrl()}/checkout/paid?rid=${res.id}`,
      cancelUrl:  `${baseUrl()}/checkout/skip?rid=${res.id}`,
    });

    res.balanceAmount     = balance;
    res.balancePaymentUrl = balPayment.redirectUrl;

    await wa(res.phone, he
      ? `🚪 *סיכום לצ'ק אאוט — חדר ${res.roomNumber}*\n\n` +
        formatFolio(res, lang) + "\n\n" +
        `💳 *הפיקדון בסך ₪500 נוכה במלואו*\n` +
        `🔴 *יתרה לתשלום: ₪${balanceStr}*\n\n` +
        `לתשלום היתרה:\n👉 ${res.balancePaymentUrl}\n\n` +
        `_לשאלות: קבלה שלוחה 0_`
      : `🚪 *Check-out summary — Room ${res.roomNumber}*\n\n` +
        formatFolio(res, lang) + "\n\n" +
        `💳 *Your ₪500 deposit was deducted in full*\n` +
        `🔴 *Balance due: ₪${balanceStr}*\n\n` +
        `To pay the balance:\n👉 ${res.balancePaymentUrl}\n\n` +
        `_Questions? Reception, Ext. 0_`
    );

    await logAlert({
      dept: "reception", roomNumber: res.roomNumber, guestName: res.guestName,
      message: `⚠️ יתרה ₪${balanceStr} | פיקדון נוכה במלואו | נשלח קישור`,
      priority: "high",
    });
  }

  // Notify housekeeping
  await logAlert({
    dept: "housekeeping", roomNumber: res.roomNumber, guestName: res.guestName,
    message: `🧹 חדר ${res.roomNumber} פנוי — ניקיון מלא נדרש`,
    priority: "normal",
  });

  return res;
}

export function getActiveReservation(phone) {
  return Object.values(reservations).find(r => r.phone === phone && r.stage === "checked_in");
}

// ── Demo helper — adds sample charges for presentation ─
export function addDemoCharges(reservationId) {
  addFolioItem(reservationId, "RESTAURANT",   "ארוחת בוקר × 2",     18000);
  addFolioItem(reservationId, "MINIBAR",      "מיני בר",              9500);
  addFolioItem(reservationId, "SPA",          "עיסוי שוודי 60 דק",  35000);
}
