// ════════════════════════════════════════════════════════
//  BOT BRAIN v6 — Production Ready
// ════════════════════════════════════════════════════════
import Anthropic from "@anthropic-ai/sdk";
import twilio    from "twilio";
import dotenv    from "dotenv";
import { hotelConfig }                                    from "./config.js";
import { getSession, recordActivity, pushHistory, patchSession, logAlert, logIncident, stats, sessions } from "./state.js";
import { detectLang }                                     from "./i18n.js";
import { startCheckin, processCheckout, getActiveReservation, formatFolio, depositExplainer } from "./checkin.js";
import { email }                                          from "./email/index.js";
import { idVerify }                                       from "./idverify/index.js";

dotenv.config();

const AI_MODEL = "claude-sonnet-4-6";
const ai   = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // הגנה מפני "Premature close" ותקלות רשת חולפות מול api.anthropic.com בענן:
  // ה-SDK מנסה שוב לבד על שגיאות רשת/429/5xx, עם timeout סביר לכל ניסיון.
  maxRetries: 3,
  timeout: 30_000, // 30s לכל ניסיון (max_tokens קטן, אין streaming)
});

// קריאה ל-AI עם retry ברמת האפליקציה + לוג ברור של השגיאה המדויקת.
// חשוב: "Premature close" נזרק בזמן קריאת גוף התשובה — אחרי שה-headers כבר
// הגיעו — ולכן ה-retry הפנימי של ה-SDK לא תמיד תופס אותו. עוטפים בעצמנו.
async function createMessageWithRetry(params, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await ai.messages.create(params);
    } catch (e) {
      lastErr = e;
      const status = e?.status;
      const kind   = e?.name || e?.constructor?.name || "Error";
      console.error(`AI attempt ${i}/${attempts} failed [${kind}${status ? " " + status : ""}]: ${e?.message || e}${e?.cause ? ` | cause: ${e.cause?.message || e.cause}` : ""}`);
      // שגיאות לקוח קבועות (400/401/403/404) — אין טעם לנסות שוב.
      if (status && status >= 400 && status < 500 && status !== 429) break;
      if (i < attempts) await new Promise(r => setTimeout(r, 400 * 2 ** (i - 1)));
    }
  }
  throw lastErr;
}
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
    security:     hotelConfig.security_number,
  };
  const emailMap = {
    housekeeping: hotelConfig.housekeeping_email,
    reception:    hotelConfig.reception_email,
    maintenance:  hotelConfig.maintenance_email,
    concierge:    hotelConfig.concierge_email,
    security:     hotelConfig.security_email,
  };
  const emoji = { housekeeping: "🧹", reception: "🏨", maintenance: "🔧", concierge: "⭐", security: "🚨" }[dept] || "🔔";
  const urgency = priority === "high" ? "🚨 *דחוף* 🚨\n" : "";
  const { full } = israelTime();
  const body = `${urgency}${emoji} *${dept.toUpperCase()}*\n\n👤 אורח: ${guestName || "—"}\n🚪 חדר: ${roomNumber || "—"}\n📝 ${message}\n⏰ ${full}`;

  // ── ערוץ 1: וואטסאפ ──────────────────────────────────
  const to = numberMap[dept];
  if (to) {
    try { await wa(to, body); } catch (e) { console.error("Staff notify (WhatsApp) failed:", e.message); }
  }

  // ── ערוץ 2: מייל (דרך שכבת המייל המבודדת) ────────────
  const toEmail = emailMap[dept];
  if (toEmail) {
    const subject = `${priority === "high" ? "🚨 דחוף — " : ""}${dept.toUpperCase()} | חדר ${roomNumber || "—"} | ${guestName || "—"}`;
    try {
      await email.send({ to: toEmail, subject, body, dept, priority, meta: { roomNumber, guestName, message } });
    } catch (e) { console.error("Staff notify (email) failed:", e.message); }
  }

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

// האם ההודעה היא ברכה/פתיחה כללית בלבד (בלי בקשה ממשית)?
// משמש כדי להחליט אם לשלוח את הודעת הפתיחה/תפריט בהודעה הראשונה.
// אם נשאר תוכן ממשי אחרי ניקוי הברכות — זו אינה הודעה כללית, ומטפלים בה מיד.
function isGenericGreeting(text) {
  let t = (text || "").replace(/['''`״׳.,!?\-—…😊🙂👋🙏🌟]/g, " ").toLowerCase();
  const greetings = [
    "שלום רב", "שלום לך", "שלום", "היי", "הייי", "הי", "אהלן", "הלו", "מה נשמע",
    "מה קורה", "מה המצב", "מה שלומך", "בוקר טוב", "ערב טוב", "צהריים טובים",
    "לילה טוב", "good morning", "good evening", "good afternoon", "good night",
    "hello", "hellow", "hey there", "heya", "hey", "hi there", "hii", "hi",
    "hallo", "yo", "whats up", "how are you",
  ];
  for (const g of greetings) {
    t = t.replace(new RegExp(g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  }
  t = t.replace(/\s+/g, " ").trim();
  return t.length <= 2; // לא נשאר תוכן ממשי → ברכה כללית בלבד
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

🚨 חירום — עדיפות עליונה, לפני כל דבר אחר:
אם האורח מתאר פציעה, מצב רפואי, אש, ריח/דליפת גז, או סכנה מיידית — זהה זאת מיד (לפי המשמעות, לא לפי מילה מסוימת):
1. הגב מיד ובקצרה. אל תשאל שאלות מיותרות ואל תנהל סמול-טוק.
2. מקרה רפואי / פציעה → הנחה את האורח להתקשר *מיד ל-101 (מד"א)*.
   אש / גז → הנחה אותו *מיד ל-102 (כבאות)*, לצאת מהחדר ולהתרחק למקום בטוח.
3. הבהר לאורח: *"צוות הביטחון של המלון קיבל התראה ומטפל בכך כעת."* אל תבטיח שאדם מסוים בדרך ואל תנקוב בשם.
4. ⛔ אסור לך בשום אופן לתת הנחיות רפואיות, עזרה ראשונה או טיפול מכל סוג — לרבות אם לזוז או לא לזוז, ללחוץ על פצע, לתת תרופה, להזיז פצוע וכד'. אמור במפורש שאינך מוסמך לתת הנחיות רפואיות, ושיש לפעול אך ורק לפי הנחיות מוקד 101.
5. הוסף תמיד בסוף תגובתך את התג [EMERGENCY:<סוג + תיאור קצר>] — כדי שצוות הביטחון יקבל התראה דחופה (וואטסאפ + מייל) ויטופל על ידי אדם.
לעולם אל תסתמך על עצמך בלבד באירוע חירום — חובה להסלים דרך התג [EMERGENCY:...].

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
[RECEPTION:<תיאור>] — העברה לנציג אנושי
[EMERGENCY:<סוג + תיאור>] — חירום (פציעה / רפואי / אש / גז / סכנה) — הסלמה דחופה לביטחון`;
  }

  return `You are the digital concierge of ${cfg.name}, a 5-star luxury hotel.
Always respond in elegant, warm English. Short, clear sentences.
Current time in Israel: ${nowFull}

🚨 EMERGENCY — highest priority, before anything else:
If the guest describes an injury, a medical event, fire, a gas smell/leak, or immediate danger — recognize it instantly (by meaning, not by a specific keyword):
1. Respond immediately and briefly. Do not ask unnecessary questions or make small talk.
2. Medical / injury → instruct the guest to *call 101 (Magen David Adom) now*.
   Fire / gas → instruct them to *call 102 (Fire & Rescue) now*, leave the room and move to a safe place.
3. Tell the guest clearly: *"The hotel's security team has been alerted and is handling this now."* Do not promise that a specific person is on the way or name anyone.
4. ⛔ You must NEVER give medical, first-aid, or treatment instructions of any kind — including whether to move or stay still, applying pressure to a wound, giving medication, moving an injured person, etc. State explicitly that you are not qualified to give medical guidance, and that they must follow the instructions of the 101 dispatcher only.
5. Always append the tag [EMERGENCY:<type + short description>] at the end — so security is alerted urgently (WhatsApp + email) and a human handles it.
Never rely on yourself alone in an emergency — you MUST escalate via the [EMERGENCY:...] tag.

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
[RECEPTION:<description>] — escalate to human agent
[EMERGENCY:<type + description>] — emergency (injury/medical/fire/gas/danger) — urgent escalation to security`;
}

async function runActions(raw, session, phone) {
  const re = /\[(HK|HK_URGENT|MAINTENANCE|CONCIERGE|RECEPTION|EMERGENCY):([^\]]*)\]/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const [, type, payload] = m;
    const dept = {
      HK: "housekeeping", HK_URGENT: "housekeeping",
      MAINTENANCE: "maintenance", CONCIERGE: "concierge", RECEPTION: "reception",
      EMERGENCY: "security",
    }[type];
    const priority = type.includes("URGENT") || type === "RECEPTION" || type === "EMERGENCY"
      ? "high" : "normal";

    // ── חירום: תיעוד מובנה של האירוע לפני ההסלמה ────────
    if (type === "EMERGENCY") {
      logIncident({
        phone,
        roomNumber: session.roomNumber,
        guestName:  session.guestName,
        description: payload.trim(),
        channel: "whatsapp",
      });
    }

    await notifyStaff({
      dept,
      roomNumber: session.roomNumber,
      guestName: session.guestName,
      message: payload,
      priority,
    });
  }
  return raw.replace(re, "").replace(/\n{3,}/g, "\n\n").trim();
}

async function handleCheckin(phone, text, lang, media = null) {
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
    // שומרים את מספר ההזמנה ועוברים לשלב אימות הזהות (צילום ת"ז/דרכון),
    // בדיוק כמו צ'ק אין במלון אמיתי — לפני שלב הפיקדון.
    patchSession(phone, { checkinStage: "waiting_id", pendingReservation: text });
    await wa(phone, lang === "he"
      ? `✅ *הזמנה מספר ${text} אותרה!*\n\nכמו בכל מלון, נדרש *אימות זהות* לצ'ק אין.\n\n🪪 אנא צלם/י ושלח/י כאן *כתמונה* את תעודת הזהות או הדרכון שלך.\n\n🔐 התמונה משמשת לאימות בלבד ואינה נשמרת.`
      : `✅ *Reservation ${text} found!*\n\nLike any hotel, we need to *verify your identity* to check in.\n\n🪪 Please take a photo of your *ID card or passport* and send it here *as an image*.\n\n🔐 The photo is used for verification only and is not stored.`);
    return;
  }

  // ── שלב אימות זהות: קליטת תמונת ת"ז/דרכון דרך שכבת idverify המבודדת ──
  // המודול מאשר קבלה ואימות בלי לשמור את התמונה (Mock). בעתיד יוחלף
  // בספק אחסון מאובטח אמיתי — במקום אחד בלבד (idverify/index.js).
  if (stage === "waiting_id") {
    const isImage = media && (media.contentType || "").startsWith("image/");
    if (!isImage) {
      // לא הגיעה תמונה (טקסט / סוג קובץ אחר) — מבקשים שוב בלי לאבד את השלב.
      await wa(phone, lang === "he"
        ? `🪪 לא קיבלתי תמונה. כדי להמשיך, אנא צלם/י ושלח/י *תמונה* של תעודת הזהות או הדרכון.\n\n🔐 לאימות בלבד — לא נשמרת.`
        : `🪪 I didn't receive a photo. To continue, please send a *photo* of your ID card or passport.\n\n🔐 For verification only — it is not stored.`);
      return;
    }

    const s = getSession(phone);
    const guestName         = s.pendingName || "אורח";
    const reservationNumber = s.pendingReservation || "";
    patchSession(phone, { checkinStage: "waiting_payment", guestName });
    try {
      // אימות המסמך עובר דרך שכבת idverify המבודדת (Mock) — מאשר קבלה
      // בלי לשמור/להוריד את התמונה. mediaUrl מועבר אך אינו נשמר בשום מקום.
      await idVerify.verifyDocument({
        reservationId: reservationNumber,
        phone,
        guestName,
        mediaUrl: media.url,
        contentType: media.contentType,
        documentType: "id_or_passport",
      });

      const { paymentUrl } = await startCheckin(phone, guestName, reservationNumber);
      await wa(phone, lang === "he"
        ? `✅ *תעודת הזהות אומתה בהצלחה!* 🪪\n\nשלב אחרון — *פיקדון שהייה*.\n\n${depositExplainer("he")}\n\nלחץ על הקישור להקפאת הפיקדון:\n👉 ${paymentUrl}`
        : `✅ *Your ID was verified successfully!* 🪪\n\nOne last step — a *security deposit*.\n\n${depositExplainer("en")}\n\nTap the link to place the deposit hold:\n👉 ${paymentUrl}`);
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

function isAffirmative(text) {
  const t = text.replace(/['''`״׳.!]/g, "").toLowerCase().trim();
  return ["כן", "yes", "yep", "yeah", "yup", "אישור", "מאשר", "מאשרת", "אוקיי", "אוקי",
          "בסדר", "סבבה", "ok", "okay", "confirm", "y", "כן בבקשה", "מאשר/ת"].includes(t);
}

function isNegative(text) {
  const t = text.replace(/['''`״׳.!]/g, "").toLowerCase().trim();
  return ["לא", "no", "nope", "ביטול", "בטל", "בטלי", "cancel", "n", "עוד לא", "לא עכשיו"].includes(t);
}

// שלב 1 — מציג לאורח את כל החיובים ומבקש אישור
async function startCheckout(phone, lang) {
  const res = getActiveReservation(phone);
  if (!res) {
    await wa(phone, lang === "he"
      ? "לא מצאתי הזמנה פעילה על שמך. אנא פנה לקבלה בשלוחה 0."
      : "No active reservation found. Please contact reception at Ext. 0.");
    return;
  }
  patchSession(phone, { checkoutStage: "awaiting_confirmation" });
  const bill = formatFolio(res, lang);
  const header = lang === "he"
    ? `🚪 *בקשת צ'ק אאוט*\n\nלהלן סיכום מלא של החיובים שלך:\n\n`
    : `🚪 *Check-out request*\n\nHere is a full summary of your charges:\n\n`;
  const footer = lang === "he"
    ? `\n\nלאישור הצ'ק אאוט (כולל חיוב מהפיקדון במידת הצורך), השב *כן*.\nלביטול, השב *לא*.`
    : `\n\nReply *yes* to confirm check-out (deposit will be charged if needed).\nReply *no* to cancel.`;
  await wa(phone, header + bill + footer);
}

// שלב 2 — מבצע בפועל: מחייב מהפיקדון לפי שלושת המקרים
async function confirmCheckout(phone, session, lang) {
  try {
    await processCheckout(phone, session.reservationId || null, lang);
    patchSession(phone, { stage: "checked_out", checkinStage: null, checkoutStage: null });
  } catch (e) {
    console.error("Checkout error:", e.message);
    patchSession(phone, { checkoutStage: null });
    await wa(phone, lang === "he"
      ? "לא מצאתי הזמנה פעילה על שמך. אנא פנה לקבלה בשלוחה 0."
      : "No active reservation found. Please contact reception at Ext. 0.");
  }
}

export async function handleIncoming(phone, text, media = null) {
  const session = getSession(phone);
  recordActivity(phone); // רישום ההודעה הנכנסת (messageCount/פעילות) — פעם אחת בלבד (Bug #2)
  const lang = session.lang || detectLang(text);
  if (!session.lang) patchSession(phone, { lang });

  // הודעה ראשונה: שולחים תפריט/פתיחה רק אם זו ברכה כללית בלבד ("שלום"/"היי").
  // אם יש בהודעה הראשונה כוונה ברורה (צ'ק אין/אאוט, בקשת מחלקה, שאלה) —
  // ממשיכים מיד לטיפול בה למטה, בלי לשלוח תפריט מקדים.
  if (session.messageCount === 1) {
    patchSession(phone, { stage: "active" });
    if (isGenericGreeting(text)) {
      const welcome = hotelConfig.welcome[lang] || hotelConfig.welcome.en;
      await wa(phone, welcome);
      pushHistory(phone, "assistant", welcome);
      return;
    }
  }

  if (isCheckinIntent(text) && !session.checkinStage && session.stage !== "checked_in") {
    patchSession(phone, { checkinStage: "start" });
    await handleCheckin(phone, text, lang, media);
    return;
  }

  if (session.checkinStage && session.checkinStage !== "waiting_payment") {
    await handleCheckin(phone, text, lang, media);
    return;
  }

  // אורח שנמצא באמצע אישור צ'ק אאוט — מטפלים בתשובה כן/לא
  if (session.checkoutStage === "awaiting_confirmation") {
    if (isNegative(text)) {
      patchSession(phone, { checkoutStage: null });
      await wa(phone, lang === "he"
        ? "הצ'ק אאוט בוטל. אנחנו כאן אם תצטרך משהו נוסף 😊"
        : "Check-out cancelled. We're here if you need anything else 😊");
    } else if (isAffirmative(text)) {
      await confirmCheckout(phone, session, lang);
    } else {
      await wa(phone, lang === "he"
        ? "לאישור הצ'ק אאוט השב *כן*, או *לא* לביטול."
        : "Reply *yes* to confirm check-out, or *no* to cancel.");
    }
    return;
  }

  if (isCheckoutIntent(text) && (session.stage === "checked_in" || getActiveReservation(phone))) {
    await startCheckout(phone, lang);
    return;
  }

  pushHistory(phone, "user", text);
  let raw;
  try {
    const r = await createMessageWithRetry({
      model: AI_MODEL,
      max_tokens: 500,
      system: buildPrompt(sessions[phone] || session, lang),
      messages: (sessions[phone] || session).history,
    });
    // חילוץ עמיד של הטקסט — מתעלמים מבלוקים שאינם טקסט (thinking וכו').
    raw = (r.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();
    if (!raw) throw new Error("empty AI response");
  } catch (e) {
    console.error("AI error (all retries failed):", e?.message || e);
    raw = lang === "he"
      ? "מצטערים, אירעה שגיאה זמנית. אנא נסה שוב בעוד רגע, או פנה לקבלה בשלוחה 0."
      : "Sorry, a temporary error occurred. Please try again in a moment, or contact reception at Ext. 0.";
  }
  const reply = await runActions(raw, sessions[phone] || session, phone);
  await wa(phone, reply);
  pushHistory(phone, "assistant", reply);
}
