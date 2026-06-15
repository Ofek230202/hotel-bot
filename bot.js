// ════════════════════════════════════════════════════════
//  BOT BRAIN v3 — AI concierge + Check-in/out + Stripe
// ════════════════════════════════════════════════════════
import Anthropic from "@anthropic-ai/sdk";
import twilio    from "twilio";
import dotenv    from "dotenv";
import { hotelConfig }                                          from "./config.js";
import { getSession, pushHistory, patchSession, logAlert, stats, sessions } from "./state.js";
import { detectLang }                                           from "./i18n.js";
import { startCheckin, processCheckout, getActiveReservation }  from "./checkin.js";

dotenv.config();

const ai   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const tw   = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_WHATSAPP_NUMBER;

// ── Send WhatsApp ─────────────────────────────────────
export async function wa(to, body) {
  await tw.messages.create({ from: FROM, to, body });
  console.log(`📤 → ${to.slice(-8)}: ${body.slice(0, 60)}…`);
}

// ── Notify internal staff ─────────────────────────────
export async function notifyStaff({ dept, roomNumber, guestName, message, priority = "normal" }) {
  const numberMap = {
    housekeeping: hotelConfig.housekeeping_number,
    reception:    hotelConfig.reception_number,
    maintenance:  hotelConfig.maintenance_number,
    concierge:    hotelConfig.concierge_number,
  };
  const to = numberMap[dept];
  if (!to) return;

  const emoji = { housekeeping: "🧹", reception: "🏨", maintenance: "🔧", concierge: "⭐" }[dept] || "🔔";
  const urgency = priority === "high" ? "🚨 *URGENT* 🚨\n" : "";
  const body =
    `${urgency}${emoji} *${dept.toUpperCase()} ALERT*\n\n` +
    `👤 Guest: ${guestName || "Unknown"}\n` +
    `🚪 Room: ${roomNumber || "—"}\n` +
    `📝 Request: ${message}\n` +
    `⏰ ${new Date().toLocaleString("he-IL")}`;

  try { await wa(to, body); } catch (e) { console.error("Staff notify failed:", e.message); }
  logAlert({ dept, roomNumber, guestName, message, priority });
  stats.serviceRequests++;
}

// ── Detect check-in intent ────────────────────────────
function isCheckinIntent(text) {
  const triggers = [
    "צ'ק אין", "צ'ק-אין", "checkin", "check in", "check-in",
    "לעשות צ'ק", "להתחיל שהייה", "הגעתי", "אני בבית המלון",
    "רוצה להתחיל", "want to check in", "arrived", "i'm here"
  ];
  return triggers.some(t => text.toLowerCase().includes(t.toLowerCase()));
}

// ── Detect check-out intent ───────────────────────────
function isCheckoutIntent(text) {
  const triggers = [
    "צ'ק אאוט", "צ'ק-אאוט", "checkout", "check out", "check-out",
    "לעזוב", "אני עוזב", "אני יוצא", "leaving", "checking out",
    "want to leave", "want to check out", "i'm leaving"
  ];
  return triggers.some(t => text.toLowerCase().includes(t.toLowerCase()));
}

// ── Build system prompt ───────────────────────────────
function systemPrompt(session, lang) {
  const cfg = hotelConfig;
  const L   = lang === "he" ? "he" : "en";

  const servicesBlock = Object.entries(cfg.services).map(([key, val]) => {
    const v = val[L] || val.en;
    return `- ${key}: ${Object.values(v).join(" | ")}`;
  }).join("\n");

  const faqBlock = cfg.faq.map(f => {
    const v = f[L] || f.en;
    return `Q: ${v.q}\nA: ${v.a}`;
  }).join("\n\n");

  const parkingVal = cfg.parking[L] || cfg.parking.en;

  const instructions = lang === "he" ? `
אתה הקונסיירז' הדיגיטלי של ${cfg.name_he}, מלון יוקרה 5 כוכבים.
ענה תמיד בעברית. טון: חם, מקצועי, תמציתי. משפטים קצרים.
אל תשתמש ב-HTML. השתמש ב-*bold* לדגש. אימוג'י — במידה בלבד.
אל תמציא מידע שאינו בהגדרות. לבקשות מחוץ לתחום — הפנה לקבלה (שלוחה 0).
צ'ק אין וצ'ק אאוט מטופלים אוטומטית — אל תנסה לטפל בהם בעצמך.
` : `
You are the digital concierge of ${cfg.name}, a 5-star luxury hotel.
Always respond in English. Tone: warm, professional, concise.
No HTML. Use *bold* for emphasis. Emojis — sparingly.
Never invent information. For out-of-scope — direct to reception (Ext. 0).
Check-in and check-out are handled automatically — do not process them yourself.
`;

  return `${instructions}

══ HOTEL INFO ══
WiFi: ${cfg.wifi.name} / ${cfg.wifi.password}
Check-in: ${cfg.checkin_time} | Check-out: ${cfg.checkout_time}

══ SERVICES ══
${servicesBlock}

══ PARKING ══
${parkingVal.type} — ${parkingVal.price}. ${parkingVal.note}

══ FAQ ══
${faqBlock}

══ CURRENT GUEST ══
Name: ${session.guestName || "—"}
Room: ${session.roomNumber || "—"}
Stage: ${session.stage}
Language: ${lang}

══ ACTION COMMANDS ══
[HK:<description>]           → housekeeping request
[HK_URGENT:<description>]    → urgent housekeeping
[MAINTENANCE:<description>]  → broken AC, TV, plumbing
[CONCIERGE:<description>]    → restaurant booking, taxi
[RECEPTION:<description>]    → escalate to human agent

Write guest message first, then tag on a new line. Tag is stripped before sending.`;
}

// ── Parse & execute action tags ───────────────────────
async function runActions(raw, session, phone) {
  const tagRe = /\[(HK|HK_URGENT|MAINTENANCE|CONCIERGE|RECEPTION):([^\]]*)\]/g;
  let match;
  while ((match = tagRe.exec(raw)) !== null) {
    const [, type, payload] = match;
    const deptMap = {
      HK: "housekeeping", HK_URGENT: "housekeeping",
      MAINTENANCE: "maintenance", CONCIERGE: "concierge", RECEPTION: "reception"
    };
    await notifyStaff({
      dept: deptMap[type],
      roomNumber: session.roomNumber,
      guestName: session.guestName,
      message: payload,
      priority: type === "HK_URGENT" || type === "RECEPTION" ? "high" : "normal",
    });
  }
  return raw.replace(tagRe, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Check-in conversation flow ────────────────────────
async function handleCheckinFlow(phone, text, session, lang) {
  const stage = session.checkinStage || "ask_name";

  if (stage === "ask_name") {
    patchSession(phone, { checkinStage: "ask_reservation" });
    const msg = lang === "he"
      ? "מעולה! 🌟 בואו נתחיל את הצ'ק אין שלך.\n\nמה *שמך המלא*?"
      : "Great! 🌟 Let's start your check-in.\n\nWhat is your *full name*?";
    await wa(phone, msg);
    return;
  }

  if (stage === "ask_reservation") {
    patchSession(phone, { checkinStage: "send_payment", pendingName: text });
    const msg = lang === "he"
      ? `תודה, *${text}*! 😊\n\nמה *מספר ההזמנה* שלך?`
      : `Thank you, *${text}*! 😊\n\nWhat is your *reservation number*?`;
    await wa(phone, msg);
    return;
  }

  if (stage === "send_payment") {
    const guestName = session.pendingName || session.guestName || "אורח";
    const reservationId = text;

    patchSession(phone, {
      guestName,
      reservationId: text,
      checkinStage: "awaiting_payment",
      stage: "checkin_pending",
    });

    try {
      const { paymentUrl } = await startCheckin(phone, guestName, reservationId);

      const msg = lang === "he"
        ? `✅ *הזמנה ${reservationId} אותרה!*\n\n` +
          `שלב אחרון — *פיקדון שהייה* של ₪500.\n\n` +
          `🔒 הפיקדון מאובטח ויוחזר *אוטומטית* לכרטיסך בצ'ק אאוט תקין.\n\n` +
          `לחץ כאן לתשלום מאובטח:\n👉 ${paymentUrl}`
        : `✅ *Reservation ${reservationId} found!*\n\n` +
          `Last step — a £500 *security deposit*.\n\n` +
          `🔒 Fully secured and *automatically refunded* at check-out.\n\n` +
          `Tap to pay securely:\n👉 ${paymentUrl}`;

      await wa(phone, msg);
    } catch (e) {
      console.error("Checkin error:", e.message);
      const errMsg = lang === "he"
        ? "מצטערים, אירעה שגיאה. אנא פנה לקבלה בשלוחה 0."
        : "Sorry, an error occurred. Please contact reception at Ext. 0.";
      await wa(phone, errMsg);
    }
    return;
  }

  // Awaiting payment — remind
  if (stage === "awaiting_payment") {
    const msg = lang === "he"
      ? "⏳ ממתינים לאישור התשלום שלך.\n\nאם נתקלת בבעיה — פנה לקבלה בשלוחה 0."
      : "⏳ Waiting for your payment confirmation.\n\nIf you need help, contact reception at Ext. 0.";
    await wa(phone, msg);
  }
}

// ── Check-out conversation flow ───────────────────────
async function handleCheckoutFlow(phone, session, lang) {
  try {
    const res = await processCheckout(phone, null);
    patchSession(phone, {
      stage: "checked_out",
      checkinStage: null,
      checkOutAt: new Date().toISOString(),
    });
    stats.checkOuts++;
  } catch (e) {
    console.error("Checkout error:", e.message);
    const msg = lang === "he"
      ? "לא מצאתי הזמנה פעילה. אנא פנה לקבלה בשלוחה 0."
      : "No active reservation found. Please contact reception at Ext. 0.";
    await wa(phone, msg);
  }
}

// ── Main entry point ───────────────────────────────────
export async function handleIncoming(phone, text) {
  const session = getSession(phone);
  const lang = session.lang || detectLang(text);
  if (!session.lang) patchSession(phone, { lang });

  // First contact — welcome message
  if (session.messageCount === 1) {
    patchSession(phone, { stage: "active" });
    const welcome = hotelConfig.welcome[lang] || hotelConfig.welcome.en;
    await wa(phone, welcome);
    pushHistory(phone, "assistant", welcome);
    return;
  }

  // Check-in intent
  if (isCheckinIntent(text) && session.stage !== "checked_in") {
    patchSession(phone, { checkinStage: "ask_reservation" });
    await handleCheckinFlow(phone, text, session, lang);
    return;
  }

  // Check-in conversation flow
  if (session.checkinStage && session.checkinStage !== "awaiting_payment") {
    await handleCheckinFlow(phone, text, session, lang);
    return;
  }

  // Check-out intent
  if (isCheckoutIntent(text) && session.stage === "checked_in") {
    await handleCheckoutFlow(phone, session, lang);
    return;
  }

  // Regular AI conversation
  pushHistory(phone, "user", text);

  let raw;
  try {
    const res = await ai.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 600,
      system:     systemPrompt(sessions[phone] || session, lang),
      messages:   (sessions[phone] || session).history,
    });
    raw = res.content[0].text;
  } catch (err) {
    console.error("Claude error:", err.message);
    raw = lang === "he"
      ? "מצטערים, אירעה שגיאה זמנית. אנא פנה לקבלה בשלוחה 0."
      : "We're sorry, a temporary error occurred. Please contact reception at Ext. 0.";
  }

  const reply = await runActions(raw, sessions[phone] || session, phone);
  await wa(phone, reply);
  pushHistory(phone, "assistant", reply);
}
