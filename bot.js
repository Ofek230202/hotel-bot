// ════════════════════════════════════════════════════════
//  BOT BRAIN v5 — Clean & Fixed
// ════════════════════════════════════════════════════════
import Anthropic from "@anthropic-ai/sdk";
import twilio    from "twilio";
import dotenv    from "dotenv";
import { hotelConfig }                                    from "./config.js";
import { getSession, pushHistory, patchSession, logAlert, stats, sessions } from "./state.js";
import { detectLang }                                     from "./i18n.js";
import { startCheckin, processCheckout }                  from "./checkin.js";

dotenv.config();

const ai   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const tw   = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_WHATSAPP_NUMBER;

// ── Send WhatsApp ─────────────────────────────────────
export async function wa(to, body) {
  await tw.messages.create({ from: FROM, to, body });
  console.log(`📤 → ${to.slice(-8)}: ${body.slice(0, 60)}…`);
}

// ── Notify staff ──────────────────────────────────────
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
  const body = `${urgency}${emoji} *${dept.toUpperCase()}*\n\n👤 ${guestName || "—"}\n🚪 חדר ${roomNumber || "—"}\n📝 ${message}\n⏰ ${new Date().toLocaleString("he-IL")}`;
  try { await wa(to, body); } catch (e) { console.error("Staff notify failed:", e.message); }
  logAlert({ dept, roomNumber, guestName, message, priority });
  stats.serviceRequests++;
}

// ── Detect intents ────────────────────────────────────
function isCheckinIntent(text) {
  const t = text.replace(/['''`״]/g, "").toLowerCase();
  return ["צק אין","check in","checkin","הגעתי","אני פה","want to check","checking in"].some(x => t.includes(x));
}

function isCheckoutIntent(text) {
  const t = text.replace(/['''`״]/g, "").toLowerCase();
  return ["צק אאוט","check out","checkout","אני עוזב","leaving","checking out"].some(x => t.includes(x));
}

// ── System prompt ─────────────────────────────────────
function buildPrompt(session, lang) {
  const cfg = hotelConfig;
  const L = lang === "he" ? "he" : "en";
  const svcs = Object.entries(cfg.services).map(([k,v]) => `- ${k}: ${Object.values(v[L]||v.en).join(" | ")}`).join("\n");
  const faqs = cfg.faq.map(f => { const v=f[L]||f.en; return `Q: ${v.q}\nA: ${v.a}`; }).join("\n\n");
  const park = cfg.parking[L] || cfg.parking.en;

  return `אתה הקונסיירז' של ${cfg.name_he}, מלון 5 כוכבים. ענה בעברית, קצר וחם.
אסור לך לטפל בצ'ק אין/אאוט — המערכת מטפלת בזה.
לבקשות מחוץ לתחום — הפנה לקבלה שלוחה 0.

WiFi: ${cfg.wifi.name} | ${cfg.wifi.password}
צ'ק אין: ${cfg.checkin_time} | צ'ק אאוט: ${cfg.checkout_time}

שירותים:
${svcs}

חניה: ${park.type} — ${park.price}. ${park.note}

שאלות נפוצות:
${faqs}

אורח: ${session.guestName||"—"} | חדר: ${session.roomNumber||"—"}

פקודות (הוסף בסוף התשובה בשורה נפרדת):
[HK:<תיאור>] — ניקיון
[HK_URGENT:<תיאור>] — ניקיון דחוף
[MAINTENANCE:<תיאור>] — תחזוקה
[CONCIERGE:<תיאור>] — קונסיירז'
[RECEPTION:<תיאור>] — העברה לנציג`;
}

// ── Run action tags ───────────────────────────────────
async function runActions(raw, session, phone) {
  const re = /\[(HK|HK_URGENT|MAINTENANCE|CONCIERGE|RECEPTION):([^\]]*)\]/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const [,type,payload] = m;
    const dept = {HK:"housekeeping",HK_URGENT:"housekeeping",MAINTENANCE:"maintenance",CONCIERGE:"concierge",RECEPTION:"reception"}[type];
    await notifyStaff({ dept, roomNumber: session.roomNumber, guestName: session.guestName, message: payload, priority: type.includes("URGENT")||type==="RECEPTION"?"high":"normal" });
  }
  return raw.replace(re,"").replace(/\n{3,}/g,"\n\n").trim();
}

// ── Check-in flow ─────────────────────────────────────
async function handleCheckin(phone, text, lang) {
  const session = getSession(phone);
  const stage = session.checkinStage;

  // שלב 1 — שאל שם
  if (!stage || stage === "start") {
    patchSession(phone, { checkinStage: "waiting_name" });
    await wa(phone, lang === "he"
      ? "מעולה! 🌟 בואו נתחיל צ'ק אין.\n\nמה *שמך המלא*?"
      : "Great! Let's start check-in.\n\nWhat is your *full name*?");
    return;
  }

  // שלב 2 — קיבלנו שם, שאל הזמנה
  if (stage === "waiting_name") {
    patchSession(phone, { checkinStage: "waiting_reservation", pendingName: text });
    await wa(phone, lang === "he"
      ? `תודה *${text}*! 😊\n\nמה *מספר ההזמנה* שלך?`
      : `Thank you *${text}*! 😊\n\nWhat is your *reservation number*?`);
    return;
  }

  // שלב 3 — קיבלנו הזמנה, שלח תשלום
  if (stage === "waiting_reservation") {
    const s = getSession(phone);
    const guestName = s.pendingName || "אורח";
    patchSession(phone, { checkinStage: "waiting_payment", guestName });
    try {
      const { paymentUrl } = await startCheckin(phone, guestName, text);
      await wa(phone, lang === "he"
        ? `✅ *הזמנה ${text} אותרה!*\n\nשלב אחרון — פיקדון שהייה ₪500.\n🔒 יוחזר אוטומטית בצ'ק אאוט.\n\n👉 ${paymentUrl}`
        : `✅ *Reservation ${text} found!*\n\nLast step — £500 deposit.\n🔒 Auto-refunded at check-out.\n\n👉 ${paymentUrl}`);
    } catch (e) {
      console.error("Checkin error:", e.message);
      await wa(phone, "מצטערים, שגיאה. פנה לקבלה שלוחה 0.");
      patchSession(phone, { checkinStage: null });
    }
    return;
  }

  // שלב 4 — ממתין לתשלום
  if (stage === "waiting_payment") {
    await wa(phone, lang === "he"
      ? "⏳ ממתינים לאישור התשלום שלך.\nאם נתקלת בבעיה — קבלה שלוחה 0."
      : "⏳ Waiting for payment. Need help? Reception Ext. 0.");
  }
}

// ── Check-out flow ────────────────────────────────────
async function handleCheckout(phone, session, lang) {
  try {
    await processCheckout(phone, null);
    patchSession(phone, { stage: "checked_out", checkinStage: null });
    stats.checkOuts++;
  } catch (e) {
    console.error("Checkout error:", e.message);
    await wa(phone, lang === "he" ? "לא מצאתי הזמנה פעילה. פנה לקבלה שלוחה 0." : "No active reservation. Contact reception Ext. 0.");
  }
}

// ── MAIN ──────────────────────────────────────────────
export async function handleIncoming(phone, text) {
  const session = getSession(phone);
  const lang = session.lang || detectLang(text);
  if (!session.lang) patchSession(phone, { lang });

  // הודעה ראשונה — ברכה
  if (session.messageCount === 1) {
    patchSession(phone, { stage: "active" });
    const welcome = hotelConfig.welcome[lang] || hotelConfig.welcome.en;
    await wa(phone, welcome);
    pushHistory(phone, "assistant", welcome);
    return;
  }

  // צ'ק אין — זיהוי intent חדש
  if (isCheckinIntent(text) && !session.checkinStage && session.stage !== "checked_in") {
    patchSession(phone, { checkinStage: "start" });
    await handleCheckin(phone, text, lang);
    return;
  }

  // צ'ק אין — המשך שיחה
  if (session.checkinStage && session.checkinStage !== "waiting_payment") {
    await handleCheckin(phone, text, lang);
    return;
  }

  // צ'ק אאוט
  if (isCheckoutIntent(text) && session.stage === "checked_in") {
    await handleCheckout(phone, session, lang);
    return;
  }

  // AI רגיל
  pushHistory(phone, "user", text);
  let raw;
  try {
    const r = await ai.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: buildPrompt(sessions[phone] || session, lang),
      messages: (sessions[phone] || session).history,
    });
    raw = r.content[0].text;
  } catch (e) {
    console.error("AI error:", e.message);
    raw = lang === "he" ? "מצטערים, שגיאה זמנית. פנה לקבלה שלוחה 0." : "Temporary error. Contact reception Ext. 0.";
  }
  const reply = await runActions(raw, sessions[phone] || session, phone);
  await wa(phone, reply);
  pushHistory(phone, "assistant", reply);
}
