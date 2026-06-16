// ════════════════════════════════════════════════════════
//  BOT BRAIN v6 — Production Ready
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

export async function wa(to, body) {
  await tw.messages.create({ from: FROM, to, body });
  console.log(`📤 → ${to.slice(-8)}: ${body.slice(0, 60)}…`);
}

function israelTime() {
  const now = new Date();
  const time = now.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" });
  const date = now.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Jerusalem" });
  return { time, date, full: `${date}, ${time}` };
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
  const urgency = priority === "high" ? "🚨 *דחוף* 🚨\n" : "";
  const { full } = israelTime();
  const body = `${urgency}${emoji} *${dept.toUpperCase()}*\n\n👤 אורח: ${guestName || "—"}\n🚪 חדר: ${roomNumber || "—"}\n📝 ${message}\n⏰ ${full}`;
  try { await wa(to, body); } catch (e) { console.error("Staff notify failed:", e.message); }
  logAlert({ dept, roomNumber, guestName, message, priority });
  stats.serviceRequests++;
}

function isCheckinIntent(text) {
  const t = text.replace(/['''`״׳]/g, "").toLowerCase().trim();
  return [
    "צק אין", "check in", "checkin", "check-in",
    "הגעתי", "אני פה", "רוצה להתחיל", "want to check", "checking in",
    "לצק אין", "לעשות צק"
  ].some(x => t.includes(x.replace(/[''']/g, "").toLowerCase()));
}

function isCheckoutIntent(text) {
  const t = text.replace(/['''`״׳]/g, "").toLowerCase().trim();
  return [
    "צק אאוט", "check out", "checkout", "check-out",
    "אני עוזב", "אני יוצא", "leaving", "checking out", "לצאת", "לעזוב"
  ].some(x => t.includes(x.replace(/[''']/g, "").toLowerCase()));
}

function buildPrompt(session, lang) {
  const cfg = hotelConfig;
  const L = lang === "he" ? "he" : "en";
  const { full: nowFull } = israelTime();

  const svcs = Object.entries(cfg.services).map(([k, v]) => {
    const s = v[L] || v.en;
    return `- ${k}: ${Object.values(s).join(" | ")}`;
  }).join("\n");

  const faqs = cfg.faq.map(f => {
    const v = f[L] || f.en;
    return `ש: ${v.q}\nת: ${v.a}`;
  }).join("\n\n");

  const park = cfg.parking[L] || cfg.parking.en;

  if (lang === "he") {
    return `אתה הקונסיירז׳ הדיגיטלי של ${cfg.name_he}, מלון יוקרה 5 כוכבים.
ענה תמיד בעברית תקינה, חמה ואלגנטית. משפטים קצרים וברורים.
השעה הנוכחית בישראל: ${nowFull}

כללים:
- אסור לטפל בצ׳ק אין או צ׳ק אאוט — המערכת מטפלת בזה אוטומטית
- אל תמציא מידע שאינו כתוב כאן
- לבקשות מחוץ לתחום — הפנה לקבלה בשלוחה 0
- השתמש ב-*bold* לדגש, אימוג׳י במידה

מידע המלון:
WiFi: רשת ${cfg.wifi.name} | סיסמה: ${cfg.wifi.password}
צ׳ק אין: ${cfg.checkin_time} | צ׳ק אאוט: ${cfg.checkout_time}
צ׳ק אין מוקדם: ${cfg.early_checkin ? "זמין בתיאום" : "לא זמין"}
צ׳ק אאוט מאוחר: ${cfg.late_checkout ? "זמין בתיאום" : "לא זמין"}

שירותים:
${svcs}

חניה: ${park.type} — ${park.price}. ${park.note}

שאלות נפוצות:
${faqs}

פרטי האורח:
שם: ${session.guestName || "—"} | חדר: ${session.roomNumber || "—"} | מצב: ${session.stage || "—"}

פקודות פנימיות (הוסף בסוף תגובתך בשורה נפרדת, האורח לא יראה אותן):
[HK:<תיאור>] — בקשת ניקיון
[HK_URGENT:<תיאור>] — ניקיון דחוף
[MAINTENANCE:<תיאור>] — תקלה טכנית
[CONCIERGE:<תיאור>] — הזמנת שולחן / מונית / בקשה מיוחדת
[RECEPTION:<תיאור>] — העברה לנציג אנושי`;
  }

  return `You are the digital concierge of ${cfg.name}, a 5-star luxury hotel.
Always respond in elegant, warm English. Short, clear sentences.
Current time in Israel: ${nowFull}

Rules:
- Never handle check-in or check-out yourself — the system does this automatically
- Never invent information not listed here
- For out-of-scope requests, direct to reception at Ext. 0
- Use *bold* for emphasis, emojis sparingly

Hotel Information:
WiFi: Network ${cfg.wifi.name} | Password: ${cfg.wifi.password}
Check-in: ${cfg.checkin_time} | Check-out: ${cfg.checkout_time}
Early check-in: ${cfg.early_checkin ? "Available upon request" : "Not available"}
Late check-out: ${cfg.late_checkout ? "Available upon request" : "Not available"}

Services:
${svcs}

Parking: ${park.type} — ${park.price}. ${park.note}

FAQ:
${faqs}

Guest:
Name: ${session.guestName || "—"} | Room: ${session.roomNumber || "—"}

Internal commands (add at end of reply on a new line, guest never sees these):
[HK:<description>] — housekeeping request
[HK_URGENT:<description>] — urgent housekeeping
[MAINTENANCE:<description>] — technical issue
[CONCIERGE:<description>] — restaurant/taxi/special request
[RECEPTION:<description>] — escalate to human agent`;
}

async function runActions(raw, session, phone) {
  const re = /\[(HK|HK_URGENT|MAINTENANCE|CONCIERGE|RECEPTION):([^\]]*)\]/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const [, type, payload] = m;
    const dept = {
      HK: "housekeeping", HK_URGENT: "housekeeping",
      MAINTENANCE: "maintenance", CONCIERGE: "concierge", RECEPTION: "reception"
    }[type];
    await notifyStaff({
      dept,
      roomNumber: session.roomNumber,
      guestName: session.guestName,
      message: payload,
      priority: type.includes("URGENT") || type === "RECEPTION" ? "high" : "normal"
    });
  }
  return raw.replace(re, "").replace(/\n{3,}/g, "\n\n").trim();
}

async function handleCheckin(phone, text, lang) {
  const session = getSession(phone);
  const stage = session.checkinStage;

  if (!stage || stage === "start") {
    patchSession(phone, { checkinStage: "waiting_name" });
    await wa(phone, lang === "he"
      ? `ברוך הבא! 🌟 נשמח לעשות עבורך צ׳ק אין דיגיטלי.\n\nאנא הקלד את *שמך המלא*:`
      : `Welcome! 🌟 Let's get you checked in.\n\nPlease enter your *full name*:`);
    return;
  }

  if (stage === "waiting_name") {
    patchSession(phone, { checkinStage: "waiting_reservation", pendingName: text });
    await wa(phone, lang === "he"
      ? `תודה, *${text}*! 😊\n\nאנא הקלד את *מספר ההזמנה* שלך:`
      : `Thank you, *${text}*! 😊\n\nPlease enter your *reservation number*:`);
    return;
  }

  if (stage === "waiting_reservation") {
    const s = getSession(phone);
    const guestName = s.pendingName || "אורח";
    patchSession(phone, { checkinStage: "waiting_payment", guestName });
    try {
      const { paymentUrl } = await startCheckin(phone, guestName, text);
      await wa(phone, lang === "he"
        ? `✅ *הזמנה מספר ${text} אותרה בהצלחה!*\n\nשלב אחרון — *פיקדון שהייה* בסך ₪500.\n\n🔒 הפיקדון מאובטח לחלוטין ויוחזר אוטומטית לכרטיסך עם הצ׳ק אאוט.\n\nלחץ על הקישור לתשלום מאובטח:\n👉 ${paymentUrl}`
        : `✅ *Reservation ${text} confirmed!*\n\nOne last step — a *₪500 security deposit*.\n\n🔒 Fully secured and automatically refunded at check-out.\n\nTap to pay securely:\n👉 ${paymentUrl}`);
    } catch (e) {
      console.error("Checkin error:", e.message);
      await wa(phone, lang === "he"
        ? "מצטערים, אירעה שגיאה. אנא פנה לקבלה בשלוחה 0."
        : "Sorry, an error occurred. Please contact reception at Ext. 0.");
      patchSession(phone, { checkinStage: null });
    }
    return;
  }

  if (stage === "waiting_payment") {
    await wa(phone, lang === "he"
      ? "⏳ ממתינים לאישור התשלום שלך.\n\nאם נתקלת בבעיה, פנה לקבלה בשלוחה 0."
      : "⏳ Waiting for your payment confirmation.\n\nFor assistance, contact reception at Ext. 0.");
  }
}

async function handleCheckout(phone, session, lang) {
  try {
    await processCheckout(phone, null);
    patchSession(phone, { stage: "checked_out", checkinStage: null });
    stats.checkOuts++;
  } catch (e) {
    console.error("Checkout error:", e.message);
    await wa(phone, lang === "he"
      ? "לא מצאתי הזמנה פעילה על שמך. אנא פנה לקבלה בשלוחה 0."
      : "No active reservation found. Please contact reception at Ext. 0.");
  }
}

export async function handleIncoming(phone, text) {
  const session = getSession(phone);
  const lang = session.lang || detectLang(text);
  if (!session.lang) patchSession(phone, { lang });

  if (session.messageCount === 1) {
    patchSession(phone, { stage: "active" });
    const welcome = hotelConfig.welcome[lang] || hotelConfig.welcome.en;
    await wa(phone, welcome);
    pushHistory(phone, "assistant", welcome);
    return;
  }

  if (isCheckinIntent(text) && !session.checkinStage && session.stage !== "checked_in") {
    patchSession(phone, { checkinStage: "start" });
    await handleCheckin(phone, text, lang);
    return;
  }

  if (session.checkinStage && session.checkinStage !== "waiting_payment") {
    await handleCheckin(phone, text, lang);
    return;
  }

  if (isCheckoutIntent(text) && session.stage === "checked_in") {
    await handleCheckout(phone, session, lang);
    return;
  }

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
    raw = lang === "he"
      ? "מצטערים, אירעה שגיאה זמנית. אנא פנה לקבלה בשלוחה 0."
      : "Sorry, a temporary error occurred. Please contact reception at Ext. 0.";
  }
  const reply = await runActions(raw, sessions[phone] || session, phone);
  await wa(phone, reply);
  pushHistory(phone, "assistant", reply);
}
