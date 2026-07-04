// ════════════════════════════════════════════════════════
//  CHECKIN v4 — Full billing, deposit capture, checkout
// ════════════════════════════════════════════════════════
import { v4 as uuidv4 } from "uuid";
import { wa, notifyStaff } from "./bot.js";
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

// ── ניסוח הפיקדון — מקור אמת אחד ─────────────────────
// כל ההודעות (צ'ק אין, צ'ק אאוט, עמוד התשלום, דף האישור) שואבות מכאן
// כדי שהניסוח יהיה זהה בכל מקום ולא ייווצר drift. ברור ופשוט לאורח.
export function depositExplainer(lang = "he") {
  return lang === "he"
    ? "🔒 הפיקדון (₪500) מוקפא בכרטיסך להבטחת השהייה.\n" +
      "בצ'ק אאוט:\n" +
      "- אם אין חיובים — כל הפיקדון משתחרר.\n" +
      "- אם יש חיובים — הם ינוכו מהפיקדון, והיתרה שנשארת משתחררת.\n" +
      "- אם החיובים גדולים מהפיקדון — ההפרש יחויב מאותו כרטיס אשראי שהזנת בפיקדון."
    : "🔒 The ₪500 deposit is held on your card to secure your stay.\n" +
      "At check-out:\n" +
      "- If there are no charges — the full deposit is released.\n" +
      "- If there are charges — they are deducted from the deposit, and the remainder is released.\n" +
      "- If charges exceed the deposit — the difference is charged to the same card you used for the deposit.";
}

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
  // מספר הלילות — דמו: ברירת מחדל. בפרודקשן יישלף מה-PMS לפי ההזמנה.
  // נחוץ כדי שהקבלה תתקף את כרטיס החדר לכל משך השהייה (ולא ליום אחד).
  const NIGHTS  = 3;

  reservations[id] = {
    id, phone, guestName, reservationId,
    roomNumber: null,
    stage: "pending_payment",
    deposit: DEPOSIT,
    nights: NIGHTS,
    checkoutDate: null, // יחושב בצ'ק אין (completeCheckin) לפי תאריך הכניסה + לילות
    currency: PAYMENT_CURRENCY,
    folio: [],
    paymentId: null,
    paymentUrl: null,
    createdAt: new Date().toISOString(),
    paidAt: null, checkedInAt: null, checkedOutAt: null,
    refunded: false, captured: false, capturedAmount: 0,
    balanceAmount: 0, balancePaymentUrl: null,
    // חיוב ההפרש כשהחיובים עולים על הפיקדון (מקרה C):
    overageCharged: false,      // האם ההפרש מעל הפיקדון חויב
    overageAmount: 0,           // סכום ההפרש שחויב (באגורות)
    overageChargedTo: null,     // "deposit_card" (ברירת מחדל) | "alternate_card"
    altCardUrl: null,           // קישור לתשלום ההפרש בכרטיס אחר
    noShow: false,              // חויב אוטומטית עקב אי-ביצוע צ'ק אאוט (בריחה)
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

  // ── חישוב תאריך צ'ק אאוט לפי תאריך הכניסה + מספר הלילות ──
  // משמש את הקבלה כדי לתקף את כרטיס החדר לכל משך השהייה.
  const nights      = res.nights || 1;
  const coDate      = new Date(res.checkedInAt);
  coDate.setDate(coDate.getDate() + nights);
  res.checkoutDate  = coDate.toISOString();
  const checkoutStr = coDate.toLocaleDateString("he-IL", {
    weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Jerusalem",
  });

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
      `🔑 *כרטיס לחדר ימתין לך מוכן בקבלה* — גש לאסוף אותו, הוא מתוקף לכל משך השהייה\n` +
      `${depositExplainer("he")}\n` +
      `📶 WiFi: Kempinski_Guest | Welcome2024\n\n` +
      `🍳 ארוחת בוקר: 07:00–11:00\n` +
      `🏊 בריכה: 07:00–22:00 | גג קומה 12\n` +
      `🛎️ שירות לחדר: 24/7 | שלוחה 0\n\n` +
      `לכל בקשה — אני כאן! 😊`
    : `✅ *Check-in confirmed!*\n\n` +
      `Welcome, *${res.guestName}*! 🌟\n\n` +
      `🚪 *Room:* ${res.roomNumber}\n` +
      `🔑 *Your room key is ready and waiting at reception* — please pick it up; it's valid for your entire stay\n` +
      `${depositExplainer("en")}\n` +
      `📶 WiFi: Kempinski_Guest | Welcome2024\n\n` +
      `🍳 Breakfast: 07:00–11:00\n` +
      `🏊 Pool: 07:00–22:00 | Rooftop, Level 12\n` +
      `🛎️ Room service: 24/7 | Ext. 0\n\n` +
      `I'm here for anything you need! 😊`
  );

  // ── התראה לקבלה: להכין כרטיס לחדר מוכן לאיסוף ──────────
  // נשלחת גם בוואטסאפ וגם במייל (דרך notifyStaff). כוללת את כל הפרטים
  // הדרושים להכנת הכרטיס מראש, ומדגישה לתקף את הכרטיס לכל משך השהייה.
  await notifyStaff({
    dept: "reception",
    roomNumber: res.roomNumber,
    guestName: res.guestName,
    message:
      `🔑 *להכין כרטיס לחדר מוכן לאיסוף בקבלה*\n` +
      `✅ צ'ק אין דיגיטלי הושלם | פיקדון ₪500 מאושר\n` +
      `🌙 לילות: ${nights}\n` +
      `📅 צ'ק אאוט: ${checkoutStr}\n` +
      `⏳ *תקף את הכרטיס לכל משך השהייה* (עד ${checkoutStr}) — לא ליום אחד`,
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
        `━━━━━━━━━━━━━━━━━━━━\n✅ אין חיובים\n` +
        `━━━━━━━━━━━━━━━━━━━━\n💚 אין מה לנכות — הפיקדון (₪500) משתחרר במלואו`
      : `📋 *Bill Summary — Room ${res.roomNumber}*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n✅ No charges\n` +
        `━━━━━━━━━━━━━━━━━━━━\n💚 Nothing to deduct — the ₪500 deposit is released in full`;
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
      ? `📋 *סיכום חשבון — חדר ${res.roomNumber}*\n━━━━━━━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━━━━━━━\nסה"כ חיובים:  ₪${totalStr}\nפיקדון:       ₪${depositStr}\n━━━━━━━━━━━━━━━━━━━━\n💳 ינוכה מהפיקדון: ₪${totalStr}\n💚 יתרת הפיקדון שתשתחרר: ₪${refund}`
      : `📋 *Bill — Room ${res.roomNumber}*\n━━━━━━━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━━━━━━━\nTotal charges:  ₪${totalStr}\nDeposit:        ₪${depositStr}\n━━━━━━━━━━━━━━━━━━━━\n💳 Deducted from deposit: ₪${totalStr}\n💚 Remaining deposit released: ₪${refund}`;
  } else {
    const balance = ((total - deposit)/100).toFixed(2);
    return lang === "he"
      ? `📋 *סיכום חשבון — חדר ${res.roomNumber}*\n━━━━━━━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━━━━━━━\nסה"כ חיובים:  ₪${totalStr}\nפיקדון:       ₪${depositStr}\n━━━━━━━━━━━━━━━━━━━━\n💳 הפיקדון (₪${depositStr}) ינוכה במלואו\n🔴 *ההפרש מעל הפיקדון: ₪${balance}* — יחויב מהכרטיס`
      : `📋 *Bill — Room ${res.roomNumber}*\n━━━━━━━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━━━━━━━\nTotal charges:  ₪${totalStr}\nDeposit:        ₪${depositStr}\n━━━━━━━━━━━━━━━━━━━━\n💳 The deposit (₪${depositStr}) is deducted in full\n🔴 *Amount over the deposit: ₪${balance}* — charged to the card`;
  }
}

// ── מנוע סליקת החשבון — משותף לצ'ק אאוט ולחיוב no-show ──
// מבצע את פעולות התשלום בפועל מול שכבת התשלום המבודדת (payments), לפי
// היחס בין סך החיובים לפיקדון, ומעדכן את שדות ההזמנה. אינו שולח הודעות
// לאורח — האחריות לכך על הקורא (processCheckout / autoChargeOnNoShow).
// מחזיר: { total, deposit, captured, overage, released }
async function settleFolio(res, { overageDescription } = {}) {
  const total   = getFolioTotal(res.id);
  const deposit = res.deposit;

  // A: אין חיובים → ביטול ההרשאה, שום חיוב.
  if (total === 0) {
    try { await payments.cancel({ paymentId: res.paymentId }); }
    catch (e) { console.error("Cancel error:", e.message); }
    res.refunded = true;
    return { total, deposit, captured: 0, overage: 0, released: deposit };
  }

  // B: חיובים ≤ פיקדון → לוכדים בדיוק את סכום החיובים; היתרה משתחררת.
  if (total <= deposit) {
    try {
      const cap = await payments.capture({ paymentId: res.paymentId, amount: total });
      res.captured = true; res.capturedAmount = cap.capturedAmount;
    } catch (e) { console.error("Capture error:", e.message); }
    return { total, deposit, captured: total, overage: 0, released: deposit - total };
  }

  // C: חיובים > פיקדון → לוכדים את מלוא הפיקדון, ואת ההפרש מחייבים
  //    *מאותו כרטיס* של הפיקדון (ברירת מחדל). האורח יוכל לאחר מכן לבחור
  //    להחליף לכרטיס אחר דרך הקישור (ראה processCheckout).
  try {
    const cap = await payments.capture({ paymentId: res.paymentId, amount: deposit });
    res.captured = true; res.capturedAmount = cap.capturedAmount;
  } catch (e) { console.error("Capture error:", e.message); }

  const overage = total - deposit;
  try {
    const extra = await payments.chargeSameCard({
      paymentId: res.paymentId,
      amount: overage,
      currency: res.currency || PAYMENT_CURRENCY,
      description: overageDescription || `הפרש מעל פיקדון — חדר ${res.roomNumber}`,
    });
    res.overageCharged = true;
    res.overageAmount  = extra.chargedAmount;
  } catch (e) { console.error("Overage charge error:", e.message); }
  res.overageChargedTo = "deposit_card";
  return { total, deposit, captured: deposit, overage, released: 0 };
}

// ── Process check-out ─────────────────────────────────
export async function processCheckout(phone, reservationId, lang = "he") {
  const res = reservationId
    ? reservations[reservationId]
    : Object.values(reservations).find(r => r.phone === phone && r.stage === "checked_in");

  if (!res) throw new Error("No active reservation found");

  const he = lang === "he";
  const s  = await settleFolio(res, {
    overageDescription: he
      ? `יתרה מעל פיקדון — חדר ${res.roomNumber} · ${res.guestName}`
      : `Amount over deposit — Room ${res.roomNumber} · ${res.guestName}`,
  });

  res.stage        = "checked_out";
  res.checkedOutAt = new Date().toISOString();
  stats.checkOuts++;

  // ── A: No charges → deposit released in full ──────
  if (s.total === 0) {
    await wa(res.phone, he
      ? `🚪 *צ'ק אאוט הושלם!*\n\n` +
        `תודה, *${res.guestName}*! שמחנו לארח אותך 🌟\n\n` +
        `✅ אין חיובים\n` +
        `💚 *הפיקדון (₪500) שוחרר במלואו* — לא בוצע חיוב\n\n` +
        `נשמח לראותך שוב! ⭐`
      : `🚪 *Check-out complete!*\n\n` +
        `Thank you, *${res.guestName}*! It was a pleasure hosting you 🌟\n\n` +
        `✅ No charges\n` +
        `💚 *Your ₪500 deposit was released in full* — nothing was charged\n\n` +
        `We hope to see you again! ⭐`
    );
  }

  // ── B: Charges ≤ deposit → deducted, remainder released ──
  else if (s.overage === 0) {
    const charged = (s.total/100).toFixed(2);
    const refund  = (s.released/100).toFixed(2);

    await wa(res.phone, he
      ? `🚪 *צ'ק אאוט הושלם!*\n\n` +
        `תודה, *${res.guestName}*! 🌟\n\n` +
        formatFolio(res, lang) + "\n\n" +
        `💳 *נוכה מהפיקדון: ₪${charged}*\n` +
        `💚 *יתרת הפיקדון שתשתחרר: ₪${refund}* (תוך 3-5 ימי עסקים)\n\n` +
        `נשמח לראותך שוב! ⭐`
      : `🚪 *Check-out complete!*\n\n` +
        `Thank you, *${res.guestName}*! 🌟\n\n` +
        formatFolio(res, lang) + "\n\n" +
        `💳 *Deducted from your deposit: ₪${charged}*\n` +
        `💚 *Remaining deposit released: ₪${refund}* (within 3-5 business days)\n\n` +
        `We hope to see you again! ⭐`
    );
  }

  // ── C: Charges > deposit → deposit captured + overage charged to same card ──
  else {
    const totalStr   = (s.total/100).toFixed(2);
    const balanceStr = (s.overage/100).toFixed(2);

    // אפשרות לאורח לשלם את ההפרש בכרטיס *אחר* במקום כרטיס הפיקדון.
    // הקישור מוביל לעמוד תשלום שבו הוא מזין כרטיס חדש; אם ישלם שם — ההפרש
    // "יעבור" לכרטיס האחר (ראה /checkout/balance/pay). בינתיים, כברירת מחדל,
    // ההפרש כבר חויב מכרטיס הפיקדון (settleFolio) כדי להגן על המלון.
    const altPayment = await payments.createBalancePayment({
      reservationId: res.id,
      amount: s.overage,
      currency: PAYMENT_CURRENCY,
      description: he
        ? `יתרה מעל פיקדון — חדר ${res.roomNumber} · ${res.guestName}`
        : `Amount over deposit — Room ${res.roomNumber} · ${res.guestName}`,
      paymentPageUrl: `${baseUrl()}/checkout/balance/pay?rid=${res.id}`,
      successUrl: `${baseUrl()}/checkout/paid?rid=${res.id}`,
      cancelUrl:  `${baseUrl()}/checkout/skip?rid=${res.id}`,
    });

    res.balanceAmount = s.overage;
    res.altCardUrl    = altPayment.redirectUrl;

    await wa(res.phone, he
      ? `🚪 *צ'ק אאוט הושלם — חדר ${res.roomNumber}*\n\n` +
        `תודה, *${res.guestName}*! 🌟\n\n` +
        formatFolio(res, lang) + "\n\n" +
        `💳 *הפיקדון (₪500) נוכה במלואו.*\n` +
        `❗ החיובים (₪${totalStr}) עלו על הפיקדון.\n` +
        `✅ *ההפרש (₪${balanceStr}) חויב מכרטיס האשראי שהזנת בצ'ק אין.*\n\n` +
        `מעדיף לשלם את ההפרש בכרטיס אחר? אפשר להחליף כאן:\n👉 ${res.altCardUrl}\n\n` +
        `_לשאלות: קבלה שלוחה 0_`
      : `🚪 *Check-out complete — Room ${res.roomNumber}*\n\n` +
        `Thank you, *${res.guestName}*! 🌟\n\n` +
        formatFolio(res, lang) + "\n\n" +
        `💳 *The ₪500 deposit was deducted in full.*\n` +
        `❗ Charges (₪${totalStr}) exceeded the deposit.\n` +
        `✅ *The difference (₪${balanceStr}) was charged to the card you entered at check-in.*\n\n` +
        `Prefer to pay the difference with a different card? You can switch here:\n👉 ${res.altCardUrl}\n\n` +
        `_Questions? Reception, Ext. 0_`
    );

    await logAlert({
      dept: "reception", roomNumber: res.roomNumber, guestName: res.guestName,
      message: `⚠️ חיובים ₪${totalStr} מעל פיקדון | הפרש ₪${balanceStr} חויב מכרטיס הפיקדון | הוצעה החלפת כרטיס`,
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

// ── מעבר לכרטיס אחר לתשלום ההפרש ──────────────────────
// נקרא כשהאורח בוחר לשלם את ההפרש (מעל הפיקדון) בכרטיס שונה מזה של
// הפיקדון, דרך עמוד /checkout/balance/pay. ב-Mock: מסמנים שההפרש עבר
// לכרטיס האחר ומודיעים לאורח. בפרודקשן (CardCom): מבטלים את חיוב ההפרש
// מכרטיס הפיקדון ומחייבים את הכרטיס החדש — הכל דרך אותה שכבת payments.
export async function switchOverageToAlternateCard(reservationId, lang = "he") {
  const res = reservations[reservationId];
  if (!res) throw new Error("Reservation not found");
  if (!res.overageAmount) return res; // אין הפרש — אין מה להחליף

  res.overageChargedTo = "alternate_card";
  const he = lang === "he";
  const balanceStr = (res.overageAmount/100).toFixed(2);

  await wa(res.phone, he
    ? `✅ *עודכן!*\n\nההפרש (₪${balanceStr}) חויב מהכרטיס החדש שהזנת, ולא מכרטיס הפיקדון.\n\nתודה! ⭐`
    : `✅ *Updated!*\n\nThe difference (₪${balanceStr}) was charged to the new card you entered, not to the deposit card.\n\nThank you! ⭐`
  );

  await logAlert({
    dept: "reception", roomNumber: res.roomNumber, guestName: res.guestName,
    message: `🔁 חדר ${res.roomNumber}: הפרש ₪${balanceStr} הועבר לכרטיס אחר (לבקשת האורח)`,
    priority: "normal",
  });
  return res;
}

// ── No-show / אורח שעזב בלי לשלם — חיוב פיקדון אוטומטי ──
// אם אורח הגיע לתאריך הצ'ק אאוט אך לא ביצע צ'ק אאוט ולא שילם, המלון מחייב
// אוטומטית את הפיקדון (ואם יש חוב מעל הפיקדון — גם את ההפרש מאותו כרטיס),
// כדי להגן מפני "בריחה". משתמש באותה סליקה (settleFolio) של הצ'ק אאוט הרגיל.
//
// ⚠️ דמו: כאן מפעילים ידנית (endpoint /api/no-show, או findNoShowReservations
// בלולאה). בפרודקשן זה ייקרא אוטומטית ע"י cron/מנוע זמן שירוץ בשעת הצ'ק אאוט
// לכל הזמנה שעברה את checkoutDate ועדיין במצב checked_in.
export async function autoChargeOnNoShow(reservationId, lang = "he") {
  const res = reservations[reservationId];
  if (!res) throw new Error("Reservation not found");
  if (res.stage !== "checked_in") {
    // כבר עשה צ'ק אאוט / כבר טופל — לא מחייבים פעמיים.
    return { alreadyHandled: true, reservation: res };
  }

  const he = lang === "he";
  const s  = await settleFolio(res, {
    overageDescription: he
      ? `חיוב אוטומטי (no-show) — חדר ${res.roomNumber} · ${res.guestName}`
      : `Auto-charge (no-show) — Room ${res.roomNumber} · ${res.guestName}`,
  });

  res.stage        = "checked_out";
  res.noShow       = true;
  res.checkedOutAt = new Date().toISOString();
  stats.checkOuts++;

  const totalStr = (s.total/100).toFixed(2);

  // הודעה לאורח — לפי מצב החיוב
  if (s.total === 0) {
    // אין חיובים כלל — משחררים את הפיקדון גם ב-no-show (אין מה לגבות).
    await wa(res.phone, he
      ? `🚪 *הצ'ק אאוט בוצע אוטומטית — חדר ${res.roomNumber}*\n\n` +
        `לא ביצעת צ'ק אאוט עד שעת הסיום, אז סגרנו את השהייה עבורך.\n` +
        `✅ אין חיובים — *הפיקדון (₪500) שוחרר במלואו*.\n\nתודה! ⭐`
      : `🚪 *Check-out was completed automatically — Room ${res.roomNumber}*\n\n` +
        `You didn't check out by the deadline, so we closed the stay for you.\n` +
        `✅ No charges — *the ₪500 deposit was released in full*.\n\nThank you! ⭐`
    );
  } else if (s.overage === 0) {
    const refund = (s.released/100).toFixed(2);
    await wa(res.phone, he
      ? `🚪 *הצ'ק אאוט בוצע אוטומטית — חדר ${res.roomNumber}*\n\n` +
        `לא ביצעת צ'ק אאוט עד שעת הסיום, אז סגרנו את השהייה עבורך.\n\n` +
        formatFolio(res, lang) + "\n\n" +
        `💳 *נוכה מהפיקדון: ₪${totalStr}*\n` +
        `💚 *יתרת הפיקדון שתשתחרר: ₪${refund}*\n\n` +
        `לשאלות: קבלה שלוחה 0`
      : `🚪 *Check-out was completed automatically — Room ${res.roomNumber}*\n\n` +
        `You didn't check out by the deadline, so we closed the stay for you.\n\n` +
        formatFolio(res, lang) + "\n\n" +
        `💳 *Deducted from your deposit: ₪${totalStr}*\n` +
        `💚 *Remaining deposit released: ₪${refund}*\n\n` +
        `Questions? Reception, Ext. 0`
    );
  } else {
    const balanceStr = (s.overage/100).toFixed(2);
    await wa(res.phone, he
      ? `🚪 *הצ'ק אאוט בוצע אוטומטית — חדר ${res.roomNumber}*\n\n` +
        `לא ביצעת צ'ק אאוט עד שעת הסיום, אז סגרנו את השהייה עבורך.\n\n` +
        formatFolio(res, lang) + "\n\n" +
        `💳 *הפיקדון (₪500) נוכה במלואו.*\n` +
        `✅ *ההפרש (₪${balanceStr}) חויב מכרטיס האשראי שהזנת בצ'ק אין.*\n\n` +
        `לשאלות: קבלה שלוחה 0`
      : `🚪 *Check-out was completed automatically — Room ${res.roomNumber}*\n\n` +
        `You didn't check out by the deadline, so we closed the stay for you.\n\n` +
        formatFolio(res, lang) + "\n\n" +
        `💳 *The ₪500 deposit was deducted in full.*\n` +
        `✅ *The difference (₪${balanceStr}) was charged to the card you entered at check-in.*\n\n` +
        `Questions? Reception, Ext. 0`
    );
  }

  await logAlert({
    dept: "reception", roomNumber: res.roomNumber, guestName: res.guestName,
    message: `🏃 *NO-SHOW* חדר ${res.roomNumber} · ${res.guestName} — לא בוצע צ'ק אאוט; חויב אוטומטית ₪${totalStr}`,
    priority: "high",
  });
  await logAlert({
    dept: "housekeeping", roomNumber: res.roomNumber, guestName: res.guestName,
    message: `🧹 חדר ${res.roomNumber} פנוי (no-show) — ניקיון מלא נדרש`,
    priority: "normal",
  });

  // ── קישור session ↔ reservation ──────────────────────
  patchSession(res.phone, { stage: "checked_out", checkinStage: null, checkoutStage: null });

  return { alreadyHandled: false, settlement: s, reservation: res };
}

// ── מאתר הזמנות no-show — עברו את תאריך הצ'ק אאוט ועדיין checked_in ──
// בפרודקשן: cron יריץ את זה מדי כמה דקות ויקרא ל-autoChargeOnNoShow לכל אחת.
export function findNoShowReservations(now = new Date()) {
  return Object.values(reservations).filter(r =>
    r.stage === "checked_in" && r.checkoutDate && new Date(r.checkoutDate) <= now
  );
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
