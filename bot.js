// ════════════════════════════════════════════════════════
//  BOT BRAIN  — AI concierge logic
// ════════════════════════════════════════════════════════
import Anthropic from "@anthropic-ai/sdk";
import twilio    from "twilio";
import dotenv    from "dotenv";
import { hotelConfig }                                    from "./config.js";
import { getSession, pushHistory, patchSession, logAlert, stats, sessions } from "./state.js";
import { detectLang }                                     from "./i18n.js";

dotenv.config();

const ai      = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const tw      = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM    = process.env.TWILIO_WHATSAPP_NUMBER;

// ── Send WhatsApp ─────────────────────────────────────
async function wa(to, body) {
  await tw.messages.create({ from: FROM, to, body });
  console.log(`📤 → ${to.slice(-8)}: ${body.slice(0, 70)}…`);
}

// ── Notify internal staff ─────────────────────────────
async function notifyStaff({ dept, roomNumber, guestName, message, priority = "normal" }) {
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
  const body = `${urgency}${emoji} *${dept.toUpperCase()} ALERT*\n\n` +
    `👤 Guest: ${guestName || "Unknown"}\n` +
    `🚪 Room: ${roomNumber || "—"}\n` +
    `📝 Request: ${message}\n` +
    `⏰ ${new Date().toLocaleString("he-IL")}`;

  try { await wa(to, body); } catch (e) { console.error("Staff notify failed:", e.message); }

  logAlert({ dept, roomNumber, guestName, message, priority });
  stats.serviceRequests++;
  console.log(`🔔 Staff alert → ${dept}`);
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
` : `
You are the digital concierge of ${cfg.name}, a 5-star luxury hotel.
Always respond in English. Tone: warm, professional, concise. Short sentences.
No HTML. Use *bold* for emphasis. Emojis — sparingly.
Never invent information not in the config. For out-of-scope requests, direct to reception (Ext. 0).
`;

  return `${instructions}

══ HOTEL INFO ══
WiFi: ${cfg.wifi.name} / ${cfg.wifi.password}
Check-in: ${cfg.checkin_time}  |  Check-out: ${cfg.checkout_time}

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
When you detect these intents, append the matching tag on its own line:
[HK:<short description>]           → housekeeping request
[HK_URGENT:<description>]         → urgent housekeeping (spill, emergency)
[MAINTENANCE:<description>]       → broken AC, TV, plumbing etc.
[CHECKIN:<FullName>:<RoomNumber>] → guest completing check-in
[CHECKOUT:<FullName>:<RoomNumber>]→ guest checking out
[CONCIERGE:<description>]         → restaurant booking, taxi, special requests
[RECEPTION:<description>]         → escalate to human agent

Always write your guest-facing message first, then the tag on a separate line.
The tag is stripped before sending — the guest never sees it.`;
}

// ── Parse & execute action tags ───────────────────────
async function runActions(raw, session, phone) {
  const tagRe = /\[(HK|HK_URGENT|MAINTENANCE|CHECKIN|CHECKOUT|CONCIERGE|RECEPTION):([^\]]*)\]/g;
  let match;
  while ((match = tagRe.exec(raw)) !== null) {
    const [, type, payload] = match;
    const parts = payload.split(":");

    switch (type) {
      case "HK":
        await notifyStaff({ dept: "housekeeping", roomNumber: session.roomNumber,
          guestName: session.guestName, message: payload });
        break;

      case "HK_URGENT":
        await notifyStaff({ dept: "housekeeping", roomNumber: session.roomNumber,
          guestName: session.guestName, message: payload, priority: "high" });
        break;

      case "MAINTENANCE":
        await notifyStaff({ dept: "maintenance", roomNumber: session.roomNumber,
          guestName: session.guestName, message: payload });
        break;

      case "CHECKIN": {
        const name = parts[0]?.trim() || session.guestName || "Guest";
        const room = parts[1]?.trim() || "—";
        patchSession(phone, { guestName: name, roomNumber: room,
          stage: "checked_in", checkInAt: new Date().toISOString() });
        await notifyStaff({ dept: "reception", roomNumber: room,
          guestName: name, message: `Digital check-in completed via WhatsApp` });
        stats.checkIns++;
        break;
      }

      case "CHECKOUT":
        patchSession(phone, { stage: "checked_out", checkOutAt: new Date().toISOString() });
        await notifyStaff({ dept: "reception", roomNumber: session.roomNumber,
          guestName: session.guestName, message: `Digital check-out via WhatsApp` });
        stats.checkOuts++;
        break;

      case "CONCIERGE":
        await notifyStaff({ dept: "concierge", roomNumber: session.roomNumber,
          guestName: session.guestName, message: payload });
        break;

      case "RECEPTION":
        await notifyStaff({ dept: "reception", roomNumber: session.roomNumber,
          guestName: session.guestName, message: payload, priority: "high" });
        break;
    }
  }
  // strip all tags from guest-facing text
  return raw.replace(tagRe, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Main entry point ───────────────────────────────────
export async function handleIncoming(phone, text) {
  const session = getSession(phone);

  // First contact — detect language & send welcome
  if (session.messageCount === 1) {
    const lang = detectLang(text);
    patchSession(phone, { lang, stage: "active" });
    const welcome = hotelConfig.welcome[lang] || hotelConfig.welcome.en;
    await wa(phone, welcome);
    pushHistory(phone, "assistant", welcome);
    return;
  }

  // Detect / update language
  const lang = session.lang || detectLang(text);
  if (!session.lang) patchSession(phone, { lang });

  // Add to history
  pushHistory(phone, "user", text);

  // Call Claude
  let raw;
  try {
    const res = await ai.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 600,
      system:     systemPrompt(session, lang),
      messages:   session.history,
    });
    raw = res.content[0].text;
  } catch (err) {
    console.error("Claude error:", err.message);
    raw = lang === "he"
      ? "מצטערים, אירעה שגיאה זמנית. אנא פנה לקבלה בשלוחה 0."
      : "We're sorry, a temporary error occurred. Please contact reception at Ext. 0.";
  }

  // Run any embedded actions
  const reply = await runActions(raw, sessions[phone] || session, phone);

  // Send to guest & log
  await wa(phone, reply);
  pushHistory(phone, "assistant", reply);
}

// Export for manual sends from dashboard
export { wa, notifyStaff };
