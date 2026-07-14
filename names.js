// ════════════════════════════════════════════════════════
//  NAMES — שם אורח דו-לשוני (עברית + אנגלית), בלי ערבוב שפות
//  ----------------------------------------------------------
//  עיקרון (מלון 5 כוכבים): שיחה בעברית → השם בעברית; שיחה באנגלית →
//  השם באנגלית. לעולם לא "תודה, Ofek" בתוך שיחה עברית.
//
//  בזמן הצ'ק אין שומרים את השם בשתי הצורות (guestNameHe / guestNameEn).
//  אם האורח הזין רק צורה אחת — ה-AI מתעתק (transliteration) לצורה השנייה
//  לפי הצליל. מציגים תמיד לפי שפת השיחה דרך nameFor().
// ════════════════════════════════════════════════════════
import Anthropic from "@anthropic-ai/sdk";
import dotenv    from "dotenv";
import { detectLangSignal } from "./i18n.js";

dotenv.config();

const ai = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: 2,
  timeout: 15_000,
});

// תעתוק שם לשפת היעד (עברית/אנגלית) — פלט: השם המתועתק בלבד.
async function transliterate(name, toLang) {
  const targetName = toLang === "he" ? "Hebrew" : "English (Latin letters)";
  const r = await ai.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 60,
    system:
      `You transliterate a person's full name into ${targetName}. ` +
      `Output ONLY the transliterated name — no quotes, no punctuation, no explanation, no extra words. ` +
      `Preserve the name faithfully by sound and use natural, common spelling in the target script. ` +
      `If the name is already written in ${targetName}, return it unchanged.`,
    messages: [{ role: "user", content: name }],
  });
  const out = (r.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("")
    .trim()
    .replace(/^["'“”׳״]+|["'“”׳״]+$/g, ""); // ניקוי מרכאות אם נכנסו
  return out || name;
}

// מקבל את השם הגולמי שהאורח הקליד ומחזיר את שתי הצורות: { he, en }.
// אם התעתוק נכשל (אין מפתח / שגיאת רשת) — נופל בחזרה לשם המקורי בשתי
// השפות, כדי שהצ'ק אין ימשיך לעבוד (עדיף שם לא-מתועתק על קריסה).
export async function resolveNameForms(rawName) {
  const name = (rawName || "").trim();
  if (!name) return { he: "", en: "" };

  const src = detectLangSignal(name); // "he" | "en" | null
  if (!src) return { he: name, en: name }; // בלי אותיות (למשל מספרים) — משאירים כמו שהוא

  const target = src === "he" ? "en" : "he";
  let other;
  try {
    other = await transliterate(name, target);
  } catch (e) {
    console.error("Name transliteration failed:", e?.message || e);
    other = name; // fallback — עדיף שם מקורי בשתי הצורות מאשר להיתקע
  }
  return src === "he" ? { he: name, en: other } : { he: other, en: name };
}

// בוחר את צורת השם המתא. holder = session או reservation (יש בהם
// guestNameHe / guestNameEn ו/או guestName ישן). לעולם לא מחזיר את הצורה
// בשפה הלא-נכונה אם קיימת הצורה הנכונה.
export function nameFor(holder, lang) {
  if (!holder) return "";
  const he = holder.guestNameHe;
  const en = holder.guestNameEn;
  const legacy = holder.guestName || "";
  return lang === "he"
    ? (he || legacy || en || "")
    : (en || legacy || he || "");
}
