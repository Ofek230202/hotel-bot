// ════════════════════════════════════════════════════════
//  BOT BRAIN v4 — Fixed check-in detection
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

export async function wa(to, body) {
  await tw.messages.create({ from: FROM, to, body });
  console.log(`📤 → ${to.slice(-8)}: ${body.slice(0, 60)}…`);
}

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
  const body = `${urgency}${emoji} *${dept.toUpperCase()} ALERT*\n\n👤 Guest: ${guestName || "Unknown"}\n🚪 Room: ${roomNumber || "—"}\n📝 Request: ${message}\n⏰ ${new Date().toLocaleString("he-IL")}`;
  try { await wa(to, body); } catch (e) { console.error("Staff notify failed:", e.message); }
  logAlert({ dept, roomNumber, guestName, message, priority });
  stats.serviceRequests++;
}

// ── Intent detection — FIXED ──────────────────────────
function isCheckinIntent(text) {
  const t = text.toLowerCase().replace(/[`'''״]/g, "'");
  const triggers = [
    "צ'ק אין", "צק אין", "check in", "checkin", "check-in",
    "לעשות צ'ק", "רוצה לצ'ק", "רוצה צ'ק", "להתחיל", "הגעתי",
    "אני פה", "נכנסתי", "want to check", "arrived", "checking in"
  ];
  return triggers.some(trigger => t.includes(trigger.toLowerCase()));
}

function isCheckoutIntent(text) {
  const t = text.toLowerCase().replace(/[`'''״]/g, "'");
  const triggers = [
    "צ'ק אאוט", "צק אאוט", "check out", "checkout", "check-out",
    "לעזוב", "אני עוזב", "יוצא", "leaving", "checking out", "לצאת"
  ];
  return triggers.some(trigger => t.includes(trigger.toLowerCase()));
}

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
ענה תמיד בעברית. טון: חם, מקצועי, תמציתי.
אסור לך בשום פנים לטפל בצ'ק אין או צ'ק אאוט — אלה מטופלים אוטומטית על ידי המערכת.
לשאלות על שירותים ענה מהמידע שלמטה. לבקשות מחוץ לתחום — הפנה לקבלה בשלוחה 0.
` : `
You are the digital concierge of ${cfg.name}, a 5-star luxury hotel.
Respond in English. Warm, professional, concise.
NEVER handle check-in or check-out — the system handles these automatically.
Answer service questions from the info below. For other requests, direct to reception Ext. 0.
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

══ ACTIONS ══
[HK:<desc>] → housekeeping
[HK_URGENT:<desc>] → urgent housekeeping
[MAINTENANCE:<desc>] → maintenance
[CONCIERGE:<desc>] → concierge
[RECEPTION:<desc>] → escalate`;
}

async function runActions(raw, session, phone) {
  const tagRe = /\[(HK|HK_URGENT|MAINTENANCE|CONCIERGE|RECEPTION):([^\]]*)\]/g;
  let match;
  while ((match = tagRe.exec(raw)) !== null) {
    const [, type, payload] = match;
    const deptMap = { HK: "housekeeping", HK_URGENT: "housekeeping", MAINTENANCE: "maintenance", CONCIERGE: "concierge", RECEPTION: "reception" };
    await notifyStaff({ dept: deptMap[type], roomNumber: session.roomNumber, guestName: session.guestName, message: payload, priority: type === "HK_URGENT" || type === "RECEPTION" ? "high" : "normal" });
  }
  return raw.replace(tagRe, "").replace(/\n{3,}/g, "\n\n").trim();
}

async function handleCheckinFlow(phone, text, session, lang) {
  const stage = session.checkinStage || "ask_name";

  if (stage === "ask_name" || stage === "ask_reservation" && !session.pendingName) {
    patchSession(phone, { checkinStage: "ask_reservation" });
    const msg = lang === "he"
      ? "מעולה! 🌟 בואו נתחיל את הצ'ק אין.\n\nמה *שמך המלא*?"
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
    const guestName = session.pendingName || "אורח";
    const reservationId = text;
    patchSession(phone, { guestName, reservationId: text, checkinStage: "awaiting_payment", stage: "checkin_pending" });
    try {
      const { paymentUrl } = await startCheckin(phone, guestName, reservationId);
      const msg = lang === "he"
        ? `✅ *הזמנה ${reservationId} אותרה!*\n\nשלב אחרון — *פיקדון שהייה* של ₪500.\n\n🔒 הפיקדון מאובטח ויוחזר *אוטומטית* בצ'ק אאוט.\n\nלתשלום מאובטח:\n👉 ${paymentUrl}`
        : `✅ *Reservation ${reservationId} found!*\n\nLast step — £500 *security deposit*.\n\n🔒 Fully secured and *auto-refunded* at check-out.\n\nPay securely:\n👉 ${paymentUrl}`;
      await wa(phone, msg);
    } catch (e) {
      console.error("Checkin error:", e.message);
      await wa(phone, lang === "he" ? "מצטערים, שגיאה. פנה לקבלה בשלוחה 0." : "Sorry, an error occurred. Contact reception at Ext. 0.");
    }
    return;
  }

  if (stage === "awaiting_payment") {
    await wa(phone, lang === "he" ? "⏳ ממתינים לאישור התשלום שלך.\n\nאם נתקלת בבעיה — קבלה שלוחה 0." : "⏳ Waiting for payment confirmation.\n\nNeed help? Reception Ext. 0.");
  }
}

async function handleCheckoutFlow(phone, session, lang) {
  try {
    await processCheckout(phone, null);
    patchSession(phone, { stage: "checked_out", checkinStage: null, checkOutAt: new Date().toISOString() });
    stats.checkOuts++;
  } catch (e) {
    console.error("Checkout error:", e.message);
    await wa(phone, lang === "he" ? "לא מצאתי הזמנה פעילה. פנה לקבלה בשלוחה 0." : "No active reservation. Contact reception Ext. 0.");
  }
}

export async function handleIncoming(phone, text) {
  const session = getSession(phone);
  const lang = session.lang || detectLang(text);
  if (!session.lang) patchSession(phone, { lang });

  // First contact
  if (session.messageCount === 1) {
    patchSession(phone, { stage: "active" });
    const welcome = hotelConfig.welcome[lang] || hotelConfig.welcome.en;
    await wa(phone, welcome);
    pushHistory(phone, "assistant", welcome);
    return;
  }

  // CHECK-IN — always check BEFORE AI
  if (isCheckinIntent(text) && session.stage !== "checked_in") {
    patchSession(phone, { checkinStage: "ask_reservation" });
    await handleCheckinFlow(phone, text, { ...session, checkinStage: "ask_name" }, lang);
    return;
  }

  // CHECK-IN flow continuation
  if (session.checkinStage && session.checkinStage !== "awaiting_payment") {
    await handleCheckinFlow(phone, text, session, lang);
    return;
  }

  // CHECK-OUT — always check BEFORE AI
  if (isCheckoutIntent(text) && session.stage === "checked_in") {
    await handleCheckoutFlow(phone, session, lang);
    return;
  }

  // Regular AI
  pushHistory(phone, "user", text);
  let raw;
  try {
    const res = await ai.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      system: systemPrompt(sessions[phone] || session, lang),
      messages: (sessions[phone] || session).history,
    });
    raw = res.content[0].text;
  } catch (err) {
    console.error("Claude error:", err.message);
    raw = lang === "he" ? "מצטערים, שגיאה זמנית. פנה לקבלה בשלוחה 0." : "Temporary error. Please contact reception Ext. 0.";
  }
  const reply = await runActions(raw, sessions[phone] || session, phone);
  await wa(phone, reply);
  pushHistory(phone, "assistant", reply);
}
