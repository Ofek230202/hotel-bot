// ════════════════════════════════════════════════════════
//  CHECKIN v4 — Full billing, deposit capture, checkout
// ════════════════════════════════════════════════════════
import Stripe from "stripe";
import { v4 as uuidv4 } from "uuid";
import { wa } from "./bot.js";
import { logAlert, stats } from "./state.js";

const stripe   = new Stripe(process.env.STRIPE_SECRET_KEY);
const BASE_URL = process.env.BASE_URL;

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
  const DEPOSIT = 50000; // 500 in lowest currency unit

  reservations[id] = {
    id, phone, guestName, reservationId,
    roomNumber: null,
    stage: "pending_payment",
    deposit: DEPOSIT,
    currency: "gbp",
    folio: [],
    paymentIntentId: null,
    checkoutSessionId: null,
    paymentUrl: null,
    createdAt: new Date().toISOString(),
    paidAt: null, checkedInAt: null, checkedOutAt: null,
    refunded: false, captured: false, capturedAmount: 0,
    balanceAmount: 0, balancePaymentUrl: null,
  };

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "payment",
    payment_intent_data: {
      capture_method: "manual",
      metadata: { reservation_id: id, guest_name: guestName, phone },
    },
    line_items: [{
      price_data: {
        currency: "gbp",
        product_data: {
          name: "פיקדון שהייה — Kempinski Hotel",
          description: "פיקדון בטחון. יטופל בהתאם לחיובים בצ'ק אאוט.",
        },
        unit_amount: DEPOSIT,
      },
      quantity: 1,
    }],
    success_url: `${BASE_URL}/checkin/success?rid=${id}`,
    cancel_url:  `${BASE_URL}/checkin/cancel?rid=${id}`,
    metadata: { reservation_id: id, phone },
    locale: "auto",
  });

  reservations[id].checkoutSessionId = session.id;
  reservations[id].paymentUrl = session.url;
  return { reservationId: id, paymentUrl: session.url };
}

// ── Complete check-in ─────────────────────────────────
export async function completeCheckin(reservationId, roomNumber) {
  const res = reservations[reservationId];
  if (!res) throw new Error("Reservation not found");

  const session = await stripe.checkout.sessions.retrieve(res.checkoutSessionId);
  res.paymentIntentId = session.payment_intent;
  res.roomNumber  = roomNumber || "304";
  res.stage       = "checked_in";
  res.checkedInAt = new Date().toISOString();
  res.paidAt      = new Date().toISOString();
  stats.checkIns++;

  await wa(res.phone,
    `✅ *צ'ק אין אושר!*\n\n` +
    `ברוכים הבאים, *${res.guestName}*! 🌟\n\n` +
    `🚪 *חדר:* ${res.roomNumber}\n` +
    `💳 *פיקדון ₪500* — יטופל בצ'ק אאוט\n` +
    `📶 WiFi: Kempinski_Guest | Welcome2024\n\n` +
    `🍳 ארוחת בוקר: 07:00–11:00\n` +
    `🏊 בריכה: 07:00–22:00 | גג קומה 12\n` +
    `🛎️ שירות לחדר: 24/7 | שלוחה 0\n\n` +
    `לכל בקשה — אני כאן! 😊`
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
        `━━━━━━━━━━━━━━━━━━━━\n💳 £500 deposit will be refunded`;
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
      : `📋 *Bill — Room ${res.roomNumber}*\n━━━━━━━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━━━━━━━\nTotal:    £${totalStr}\nDeposit:  £${depositStr}\n━━━━━━━━━━━━━━━━━━━━\n💚 Refund: £${refund}`;
  } else {
    const balance = ((total - deposit)/100).toFixed(2);
    return lang === "he"
      ? `📋 *סיכום חשבון — חדר ${res.roomNumber}*\n━━━━━━━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━━━━━━━\nסה"כ:         ₪${totalStr}\nפיקדון:       ₪${depositStr}\n━━━━━━━━━━━━━━━━━━━━\n🔴 *יתרה לתשלום: ₪${balance}*`
      : `📋 *Bill — Room ${res.roomNumber}*\n━━━━━━━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━━━━━━━\nTotal:    £${totalStr}\nDeposit:  £${depositStr}\n━━━━━━━━━━━━━━━━━━━━\n🔴 *Balance due: £${balance}*`;
  }
}

// ── Process check-out ─────────────────────────────────
export async function processCheckout(phone, reservationId) {
  const res = reservationId
    ? reservations[reservationId]
    : Object.values(reservations).find(r => r.phone === phone && r.stage === "checked_in");

  if (!res) throw new Error("No active reservation found");

  const total   = getFolioTotal(res.id);
  const deposit = res.deposit;
  const lang    = "he";

  res.stage        = "checked_out";
  res.checkedOutAt = new Date().toISOString();
  stats.checkOuts++;

  // ── A: No charges → cancel authorization ──────────
  if (total === 0) {
    try { await stripe.paymentIntents.cancel(res.paymentIntentId); } catch(e) {}
    res.refunded = true;

    await wa(res.phone,
      `🚪 *צ'ק אאוט הושלם!*\n\n` +
      `תודה, *${res.guestName}*! שמחנו לארח אותך 🌟\n\n` +
      `✅ אין חיובים נוספים\n` +
      `💳 *פיקדון ₪500 בוטל* — לא חויית דבר\n\n` +
      `נשמח לראותך שוב! ⭐`
    );
  }

  // ── B: Charges ≤ deposit → capture exact amount ───
  else if (total <= deposit) {
    try {
      await stripe.paymentIntents.capture(res.paymentIntentId, { amount_to_capture: total });
      res.captured = true;
      res.capturedAmount = total;
    } catch(e) { console.error("Capture error:", e.message); }

    const charged = (total/100).toFixed(2);
    const refund  = ((deposit-total)/100).toFixed(2);

    await wa(res.phone,
      `🚪 *צ'ק אאוט הושלם!*\n\n` +
      `תודה, *${res.guestName}*! 🌟\n\n` +
      formatFolio(res, lang) + "\n\n" +
      `💳 *חויב מהפיקדון: ₪${charged}*\n` +
      `💚 *יוחזר לכרטיסך: ₪${refund}*\n` +
      `⏱ תוך 3-5 ימי עסקים\n\n` +
      `נשמח לראותך שוב! ⭐`
    );
  }

  // ── C: Charges > deposit → capture all + send balance link ──
  else {
    const balance    = total - deposit;
    const balanceStr = (balance/100).toFixed(2);

    // Capture full deposit automatically — no guest action needed
    try {
      await stripe.paymentIntents.capture(res.paymentIntentId, { amount_to_capture: deposit });
      res.captured = true;
      res.capturedAmount = deposit;
    } catch(e) { console.error("Capture error:", e.message); }

    // Create payment link for remaining balance
    const balSession = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "gbp",
          product_data: { name: `יתרת חשבון — חדר ${res.roomNumber}`, description: `Kempinski Hotel · ${res.guestName}` },
          unit_amount: balance,
        },
        quantity: 1,
      }],
      success_url: `${BASE_URL}/checkout/paid?rid=${res.id}`,
      cancel_url:  `${BASE_URL}/checkout/skip?rid=${res.id}`,
      metadata: { reservation_id: res.id, type: "balance" },
    });

    res.balanceAmount     = balance;
    res.balancePaymentUrl = balSession.url;

    await wa(res.phone,
      `🚪 *סיכום לצ'ק אאוט — חדר ${res.roomNumber}*\n\n` +
      formatFolio(res, lang) + "\n\n" +
      `💳 *פיקדון ₪500 — חויב אוטומטית*\n` +
      `🔴 *יתרה לתשלום: ₪${balanceStr}*\n\n` +
      `לתשלום היתרה:\n👉 ${balSession.url}\n\n` +
      `_לשאלות: קבלה שלוחה 0_`
    );

    await logAlert({
      dept: "reception", roomNumber: res.roomNumber, guestName: res.guestName,
      message: `⚠️ יתרה ₪${balanceStr} | פיקדון חויב אוטומטית | נשלח קישור`,
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
