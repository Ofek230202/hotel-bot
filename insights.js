// ════════════════════════════════════════════════════════
//  INSIGHTS — ארבעה דוחות, ולא עשרה
//  ----------------------------------------------------------
//  ── למה דווקא אלה ───────────────────────────────────────
//  רשימת הדוחות המקורית הייתה של מנהל מלון שרוצה לנהל את המלון שלו:
//  תקלות בכל חדר, ביקורות גוגל, פניות לחודש. אלה כלי תפעול של מלון —
//  לא של **המוצר**. כאן נבנים רק הדוחות שמשפרים את הבוט עצמו:
//
//   1. **מה הבוט לא ידע** ⭐ — הדוח החשוב ביותר. כל שאלה שנגמרה ב"אבדוק
//      ואחזור" היא פער תוכן שאפשר לסגור. זו רשימת המשימות לשיפור,
//      והערך שלה **מצטבר**: ככל שיותר מלונות, המוצר נעשה חכם יותר.
//   2. **אחוז ההעברות לאדם** — מדד הבריאות. יורד = הבוט משתפר. זה
//      המספר שמוכיח ערך ללקוח, ולא "כמה הודעות טיפלנו".
//   3. **בקשות שלא טופלו** — בטיחות תפעולית. הרחבה טבעית של סולם
//      ההסלמה שכבר קיים.
//   4. **שביעות רצון והכנסה** — המשוב כבר נאסף בצ'ק אאוט, וההכנסה היא
//      הטיעון המכירתי: לא "כמה הזמנות ספא" אלא "כמה הבוט הכניס".
//
//  ── כלל אחד שחוזר בכל דוח ───────────────────────────────
//  🔴 כל שאילתה מסוננת ב-`hotel_id`. דוח שמערבב מלונות אינו רק שגוי —
//     הוא **דליפת מידע עסקי בין לקוחות**.
// ════════════════════════════════════════════════════════
import { prepare, queryAllAsync } from "./store/Repo.js";
import { DEFAULT_HOTEL_ID } from "./db.js";

// ── טבלת הפערים: כל שאלה שהבוט לא ידע לענות עליה ────────
const createGaps = prepare(`
  CREATE TABLE IF NOT EXISTS knowledge_gaps (
    id         TEXT PRIMARY KEY,
    hotel_id   TEXT NOT NULL,
    question   TEXT NOT NULL,
    normalized TEXT NOT NULL,
    lang       TEXT,
    phone      TEXT,
    at         TEXT NOT NULL,
    resolved   INTEGER NOT NULL DEFAULT 0
  )
`);
try { createGaps.run(); } catch { /* קיימת */ }
try { prepare(`CREATE INDEX IF NOT EXISTS idx_gaps_hotel ON knowledge_gaps (hotel_id, at DESC)`).run(); } catch {}
try { prepare(`CREATE INDEX IF NOT EXISTS idx_gaps_norm ON knowledge_gaps (hotel_id, normalized)`).run(); } catch {}

const insertGap = prepare(
  `INSERT INTO knowledge_gaps (id, hotel_id, question, normalized, lang, phone, at) VALUES (?, ?, ?, ?, ?, ?, ?)`
);

const STOP_HE = ["האם", "יש", "אפשר", "אני", "אנחנו", "שלכם", "שלי", "את", "של", "לי", "עם", "על", "מה", "כמה", "איפה", "מתי", "איך", "בבקשה", "תודה", "שלום", "היי", "לכם", "לנו", "אתם", "צריך", "רוצה", "אפשרי"];
const STOP_EN = ["is", "are", "the", "a", "an", "do", "does", "you", "your", "i", "we", "my", "can", "could", "please", "thanks", "hello", "hi", "there", "have", "has", "what", "when", "where", "how", "much", "many", "any", "get", "would", "like", "need"];

/**
 * מנרמל שאלה לצורך **קיבוץ לנושא**.
 *
 * 🔴 למה לא רק רשימת מילות-עצירה: רשימה מתוחזקת ביד תמיד תפספס מילה
 *    ("לכם" פספסה), וכל פספוס **מפצל נושא לשניים** — הדוח חוזר להיות
 *    רשימת משפטים במקום תובנה. לכן שתי שכבות: מילות עצירה למה שנפוץ,
 *    ואז **שתי המילים הארוכות ביותר** בלבד. מילות תפקוד קצרות נושרות
 *    מעצמן, בלי שצריך להכיר אותן מראש.
 *
 * ⚠️ ההיוריסטיקה גסה בכוונה: היא עלולה למזג שני נושאים שחולקים שתי
 *    מילים ארוכות. זה מקובל — הדוח מציג **נושא**, ולצדו נשמרת דוגמה
 *    לשאלה האמיתית, כך ששום ניואנס לא הולך לאיבוד.
 */
export function normalizeQuestion(text) {
  const words = String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(w => w && w.length >= 3 && !STOP_HE.includes(w) && !STOP_EN.includes(w));

  if (!words.length) return "";
  // המילים הארוכות ביותר הן נושא השאלה; הקצרות הן דקדוק.
  const distinct = [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 2);
  return distinct.sort().join(" ");        // סדר אלפביתי — סדר המילים במשפט אינו משנה
}

/**
 * רושם שאלה שהבוט לא ידע לענות עליה.
 * נקרא כשהבוט מסלים ל-RECEPTION בגלל חוסר ידע — לא על כל הסלמה.
 */
export function recordKnowledgeGap({ hotelId = DEFAULT_HOTEL_ID, question, lang = null, phone = null } = {}) {
  const q = String(question || "").trim();
  if (!q || q.length < 3) return null;
  const normalized = normalizeQuestion(q);
  if (!normalized) return null;
  try {
    insertGap.run(
      `gap_${Date.now().toString(36)}_${Math.floor(performance.now() * 1000) % 1e6}`,
      hotelId, q.slice(0, 500), normalized, lang, phone, new Date().toISOString(),
    );
  } catch (e) { console.error("רישום פער ידע נכשל:", e?.message || e); }
  return normalized;
}

const scope = (hotelId, since) => ({
  where: hotelId ? `hotel_id = ? AND at >= ?` : `at >= ?`,
  args:  hotelId ? [hotelId, since] : [since],
});

const sinceIso = days => new Date(Date.now() - days * 86_400_000).toISOString();

// ════════════════════════════════════════════════════════
//  1. מה הבוט לא ידע ⭐
// ════════════════════════════════════════════════════════
/**
 * הנושאים שהבוט לא ידע לענות עליהם, לפי תדירות.
 * זו רשימת המשימות: כל שורה כאן היא שדה קונפיג שכדאי להוסיף.
 */
export async function knowledgeGaps({ hotelId = null, days = 30, limit = 25 } = {}) {
  const s = scope(hotelId, sinceIso(days));
  const rows = await queryAllAsync(
    `SELECT normalized, COUNT(*) AS n, MAX(at) AS last_at,
            MIN(question) AS example, MAX(lang) AS lang
       FROM knowledge_gaps
      WHERE ${s.where} AND resolved = 0
      GROUP BY normalized
      ORDER BY n DESC, last_at DESC
      LIMIT ?`, [...s.args, limit],
  );
  return rows.map(r => ({
    topic: r.normalized, count: Number(r.n),
    example: r.example, lang: r.lang, lastAt: r.last_at,
  }));
}

/** מסמן נושא כטופל (הקונפיג עודכן) — כדי שלא יופיע שוב בדוח. */
export async function resolveGap(normalized, hotelId = null) {
  const sql = hotelId
    ? `UPDATE knowledge_gaps SET resolved = 1 WHERE normalized = ? AND hotel_id = ?`
    : `UPDATE knowledge_gaps SET resolved = 1 WHERE normalized = ?`;
  await prepare(sql).runAsync(...(hotelId ? [normalized, hotelId] : [normalized]));
  return { resolved: normalized };
}

// ════════════════════════════════════════════════════════
//  2. מדד הבריאות — כמה שיחות הגיעו לאדם
// ════════════════════════════════════════════════════════
/**
 * 🔴 זה **המספר שמוכיח ערך**, ולכן הוא מוגדר בזהירות: אחוז השיחות
 *    שהצריכו אדם מתוך כלל השיחות. יורד לאורך זמן = הבוט משתפר.
 *    "כמה הודעות טיפלנו" אינו מדד — הוא מספר שגדל מעצמו.
 */
export async function handoffRate({ hotelId = null, days = 30 } = {}) {
  const since = sinceIso(days);
  const sessWhere = hotelId ? `hotel_id = ? AND last_active_at >= ?` : `last_active_at >= ?`;
  const sessArgs  = hotelId ? [hotelId, since] : [since];

  const [{ n: total } = { n: 0 }] = await queryAllAsync(
    `SELECT COUNT(*) AS n FROM sessions WHERE ${sessWhere}`, sessArgs);

  const s = scope(hotelId, since);
  const [{ n: escalated } = { n: 0 }] = await queryAllAsync(
    `SELECT COUNT(DISTINCT phone) AS n FROM knowledge_gaps WHERE ${s.where}`, s.args);

  const alertWhere = hotelId ? `hotel_id = ? AND at >= ?` : `at >= ?`;
  const [{ n: alerts } = { n: 0 }] = await queryAllAsync(
    `SELECT COUNT(*) AS n FROM alerts WHERE ${alertWhere}`, hotelId ? [hotelId, since] : [since]);

  const t = Number(total) || 0;
  const e = Number(escalated) || 0;
  return {
    days, conversations: t, neededHuman: e, staffAlerts: Number(alerts) || 0,
    // אחוז — הכיוון חשוב יותר מהערך המוחלט.
    handoffPct: t ? Math.round((e / t) * 1000) / 10 : 0,
  };
}

// ════════════════════════════════════════════════════════
//  3. בקשות שלא טופלו — בטיחות תפעולית
// ════════════════════════════════════════════════════════
/**
 * אירועי חירום שלא אושרו, והסלמות שמוצה בהן הסולם.
 * 🔴 אירוע פתוח שאיש לא אישר הוא הדבר היחיד ברשימה הזו שמצדיק
 *    התקשרות לאדם עכשיו.
 */
export async function openIssues({ hotelId = null, days = 7 } = {}) {
  const since = sinceIso(days);
  const where = hotelId ? `hotel_id = ? AND at >= ?` : `at >= ?`;
  const args  = hotelId ? [hotelId, since] : [since];

  const rows = await queryAllAsync(
    `SELECT data FROM incidents WHERE ${where} ORDER BY at DESC LIMIT 500`, args);

  const incidents = rows.map(r => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
  const unacked   = incidents.filter(i => i.status === "open" && !i.ackAt);
  const exhausted = incidents.filter(i => i.escalationExhausted && !i.ackAt);
  const openNoRes = incidents.filter(i => i.status === "open" && i.ackAt);

  return {
    days,
    total: incidents.length,
    unacknowledged: unacked.length,
    escalationExhausted: exhausted.length,
    acknowledgedNotClosed: openNoRes.length,
    // רק מה שדורש פעולה עכשיו — לא רשימה שצריך לסנן.
    needsAttention: [...exhausted, ...unacked].slice(0, 20).map(i => ({
      id: i.id, at: i.at, room: i.roomNumber || null, guest: i.guestName || null,
      kind: i.kind || null, description: String(i.description || "").slice(0, 160),
      escalationLevel: i.escalationLevel ?? 0,
    })),
  };
}

// ════════════════════════════════════════════════════════
//  4. שביעות רצון + הכנסה שהבוט ייצר
// ════════════════════════════════════════════════════════
/**
 * 🔴 ההכנסה אינה "כמה הזמנות ספא" אלא **כמה כסף נכנס דרך הבוט** —
 *    זה הטיעון שמצדיק את המערכת מול המלון הבא.
 */
export async function satisfactionAndRevenue({ hotelId = null, days = 30 } = {}) {
  const since = sinceIso(days);
  const where = hotelId ? `hotel_id = ? AND checkout_date >= ?` : `checkout_date >= ?`;
  const args  = hotelId ? [hotelId, since] : [since];

  const rows = await queryAllAsync(
    `SELECT data FROM reservations WHERE ${where} LIMIT 2000`, args);
  const res = rows.map(r => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);

  const rated = res.filter(r => typeof r.feedbackRating === "number");
  const avg   = rated.length
    ? Math.round((rated.reduce((a, r) => a + r.feedbackRating, 0) / rated.length) * 10) / 10
    : null;

  // הכנסה: כל מה שנגבה בפועל — פיקדון שנלכד + הפרשים.
  const capturedCents = res.reduce((a, r) => a + (r.capturedAmount || 0) + (r.overageAmount || 0), 0);
  // חיובים שאינם לינה — כלומר מה שהבוט **מכר** (ספא, שירות חדרים, וכו').
  const extrasCents = res.reduce((a, r) =>
    a + (r.folio || []).filter(i => i.category !== "ROOM").reduce((b, i) => b + (i.amount || 0), 0), 0);

  return {
    days,
    stays: res.length,
    rated: rated.length,
    averageRating: avg,
    lowRatings: rated.filter(r => r.feedbackRating <= 3).length,
    revenueIls: Math.round(capturedCents / 100),
    upsellIls:  Math.round(extrasCents / 100),
  };
}

/** כל ארבעת הדוחות בקריאה אחת — זה מה שהמסך מבקש. */
export async function insightsSummary({ hotelId = null, days = 30 } = {}) {
  const [gaps, health, issues, value] = await Promise.all([
    knowledgeGaps({ hotelId, days, limit: 10 }),
    handoffRate({ hotelId, days }),
    openIssues({ hotelId, days: Math.min(days, 7) }),
    satisfactionAndRevenue({ hotelId, days }),
  ]);
  return { hotelId: hotelId || "all", days, gaps, health, issues, value };
}
