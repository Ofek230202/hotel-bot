// Language detection \u2014 majority of *letters*, ignoring digits/punctuation/emoji.
// \u05D7\u05E9\u05D5\u05D1: \u05D4\u05D5\u05D3\u05E2\u05D4 \u05D1\u05D0\u05E0\u05D2\u05DC\u05D9\u05EA \u05D8\u05D4\u05D5\u05E8\u05D4 ("I wanna check in") \u05DC\u05D0 \u05DE\u05DB\u05D9\u05DC\u05D4 \u05EA\u05D5\u05D5\u05D9\u05DD \u05E2\u05D1\u05E8\u05D9\u05D9\u05DD \u05DB\u05DC\u05DC \u2192
// \u05DE\u05D6\u05D5\u05D4\u05D4 \u05DB\u05D0\u05E0\u05D2\u05DC\u05D9\u05EA \u05DE\u05D9\u05D3. \u05D1\u05D4\u05D5\u05D3\u05E2\u05D4 \u05DE\u05E2\u05D5\u05E8\u05D1\u05EA \u05DE\u05E0\u05E6\u05D7 \u05D4\u05DB\u05D9\u05D5\u05D5\u05DF \u05E2\u05DD \u05D9\u05D5\u05EA\u05E8 \u05D0\u05D5\u05EA\u05D9\u05D5\u05EA. \u05D0\u05D9\u05DF \u05D1\u05E8\u05D9\u05E8\u05EA
// \u05DE\u05D7\u05D3\u05DC \u05E9\u05E7\u05D8\u05D4 \u05DC\u05E2\u05D1\u05E8\u05D9\u05EA \u2014 \u05D1\u05DC\u05D9 \u05D0\u05D5\u05EA \u05E2\u05D1\u05E8\u05D9\u05EA \u05DE\u05D5\u05D1\u05D4\u05E7\u05EA, \u05D4\u05EA\u05E9\u05D5\u05D1\u05D4 \u05D0\u05E0\u05D2\u05DC\u05D9\u05EA.
export function detectLang(text) {
  if (!text) return "en";
  const hebrew = (text.match(/[\u0590-\u05FF]/g) || []).length;
  const latin  = (text.match(/[A-Za-z]/g) || []).length;
  if (hebrew === 0 && latin === 0) return "en"; // \u05E8\u05E7 \u05DE\u05E1\u05E4\u05E8\u05D9\u05DD/\u05D0\u05D9\u05DE\u05D5\u05D2'\u05D9 \u2014 \u05D1\u05E8\u05D9\u05E8\u05EA \u05DE\u05D7\u05D3\u05DC \u05D0\u05E0\u05D2\u05DC\u05D9\u05EA
  return hebrew >= latin ? "he" : "en";
}

// \u05DB\u05DE\u05D5 detectLang, \u05D0\u05DA \u05DE\u05D7\u05D6\u05D9\u05E8 null \u05DB\u05E9\u05D0\u05D9\u05DF *\u05E9\u05D5\u05DD* \u05D0\u05D5\u05EA (\u05E8\u05E7 \u05DE\u05E1\u05E4\u05E8\u05D9\u05DD/\u05D0\u05D9\u05DE\u05D5\u05D2'\u05D9/\u05E1\u05D9\u05DE\u05E0\u05D9\u05DD)
// \u2014 \u05DB\u05DC\u05D5\u05DE\u05E8 "\u05D0\u05D9\u05DF \u05D0\u05D5\u05EA \u05E9\u05E4\u05D4 \u05D1\u05D4\u05D5\u05D3\u05E2\u05D4". \u05DE\u05E9\u05DE\u05E9 \u05DB\u05D3\u05D9 \u05DC\u05E2\u05D3\u05DB\u05DF \u05D0\u05EA \u05E9\u05E4\u05EA \u05D4\u05E9\u05D9\u05D7\u05D4 \u05D3\u05D9\u05E0\u05DE\u05D9\u05EA \u05DC\u05E4\u05D9 \u05DB\u05DC
// \u05D4\u05D5\u05D3\u05E2\u05D4 (Bug 1) \u05D1\u05DC\u05D9 \u05DC\u05D4\u05D7\u05DC\u05D9\u05E3 \u05E9\u05E4\u05D4 \u05E2\u05DC \u05E1\u05DE\u05DA \u05E7\u05DC\u05D8 \u05E0\u05EA\u05D5\u05E0\u05D9\u05DD \u05DB\u05DE\u05D5 \u05DE\u05E1\u05E4\u05E8 \u05D4\u05D6\u05DE\u05E0\u05D4 \u05D0\u05D5 "12345".
export function detectLangSignal(text) {
  if (!text) return null;
  const hebrew = (text.match(/[\u0590-\u05FF]/g) || []).length;
  const latin  = (text.match(/[A-Za-z]/g) || []).length;
  if (hebrew === 0 && latin === 0) return null; // \u05D0\u05D9\u05DF \u05D0\u05D5\u05EA \u05E9\u05E4\u05D4 \u2014 \u05D0\u05D9\u05DF \u05E1\u05D9\u05D2\u05E0\u05DC
  return hebrew >= latin ? "he" : "en";
}

// ════════════════════════════════════════════════════════
//  בקשת מעבר שפה — "אתה יכול לדבר איתי בעברית?"
//  ----------------------------------------------------------
//  כשאורח מבקש לעבור לשפה — עוברים מיד, בלי תירוצים ובלי
//  לשאול שוב. הזיהוי עובד בשתי השפות ובכל ניסוח — גם "in Hebrew",
//  גם "יותר נוח לי בעברית", גם "can you speak Hebrew".
//
//  דורשים הקשר של *בקשה* (פועל/העדפה) ליד שם השפה, כדי ששאלה
//  כמו "Do you have a newspaper in Hebrew?" לא תחליף את שפת השיחה.
// ════════════════════════════════════════════════════════

// פועלים/ביטויים שמסמנים בקשה לעבור שפה (עברית / אנגלית)
const HE_REQUEST_VERB = "(?:תדבר|תדברי|לדבר|דבר|דברי|מדבר|תכתוב|כתוב|לכתוב|תענה|לענות|תשיב|להשיב|תגיב|נוח|נוחה|קל|עדיף|מעדיף|מעדיפה|אפשר|רוצה|תוכל|תוכלי|יכול|יכולה|תעבור|לעבור|עבור|נמשיך|להמשיך|מבקש|מבקשת|בבקשה|איתי)";
// שים לב למה *אין* כאן: "have" / "do you" ("Do you have a newspaper in Hebrew?"
// אינו בקשה להחליף שפה) ו-"say" ("how do you say X in Hebrew" זו בקשת תרגום).
const EN_REQUEST_VERB = "(?:speak|talk|write|reply|respond|answer|continue|switch|converse|chat|communicate|prefer|use|change|swap)";

const LANG_REQUEST_PATTERNS = [
  // ── בקשה לעברית ──
  { lang: "he", re: new RegExp(`(?:יותר\\s+)?${HE_REQUEST_VERB}[^.?!\\n]{0,40}(?:בעברית|לעברית|עברית)`) },
  { lang: "he", re: /(?:בעברית|לעברית|עברית)[^.?!\n]{0,25}(?:בבקשה|במקום|please)/ },
  { lang: "he", re: /^\s*(?:בעברית|עברית)\s*[.!?]?\s*$/ },
  { lang: "he", re: new RegExp(`\\b${EN_REQUEST_VERB}\\b[^.?!\\n]{0,40}\\bhebrew\\b`, "i") },
  { lang: "he", re: /\bhebrew\b[^.?!\n]{0,20}\b(?:please|instead)\b/i },
  { lang: "he", re: /^\s*hebrew\s*[.!?]?\s*$/i },
  // ── בקשה לאנגלית ──
  { lang: "en", re: new RegExp(`(?:יותר\\s+)?${HE_REQUEST_VERB}[^.?!\\n]{0,40}(?:באנגלית|לאנגלית|אנגלית)`) },
  { lang: "en", re: /(?:באנגלית|לאנגלית|אנגלית)[^.?!\n]{0,25}(?:בבקשה|במקום|please)/ },
  { lang: "en", re: /^\s*(?:באנגלית|אנגלית)\s*[.!?]?\s*$/ },
  { lang: "en", re: new RegExp(`\\b${EN_REQUEST_VERB}\\b[^.?!\\n]{0,40}\\benglish\\b`, "i") },
  { lang: "en", re: /\benglish\b[^.?!\n]{0,20}\b(?:please|instead)\b/i },
  { lang: "en", re: /^\s*english\s*[.!?]?\s*$/i },
];

// מחזיר "he" | "en" אם האורח ביקש מפורשות לעבור לשפה, אחרת null.
export function detectLanguageRequest(text) {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  for (const { lang, re } of LANG_REQUEST_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(t)) return lang;
  }
  return null;
}

// שאריות חסרות-משמעות שנותרות אחרי שמסירים את בקשת השפה — כינויי גוף,
// נימוסים ומילות פנייה ("אתה", "יותר", "לי", "please"). מוסר *רק* בתוך
// stripLanguageRequest, כך שהודעות רגילות לא נפגעות.
const LEFTOVER_FILLER = /(?:^|\s)(?:יותר|לי|לך|לנו|אתה|את|אתם|אתן|אני|בבקשה|תודה|אוקיי|אוקי|בסדר|אנא|היי|שלום|please|thanks|thank|you|can|could|would|will|hey|hi|hello|ok|okay|sorry)(?=\s|$)/gi;

// מסיר את בקשת השפה מהטקסט ומחזיר את השארית — כך ש-"10\nיותר נוח לי
// בעברית" משאיר "10", ואפשר גם להחליף שפה וגם להתקדם באותה הודעה (Bug #5).
// שארית בלי שום אות/ספרה (למשל "?" בודד) נחשבת ריקה — כלומר "בקשת שפה
// טהורה", שעליה עונים ישירות בלי לערב את ה-AI.
export function stripLanguageRequest(text) {
  let out = String(text ?? "");
  for (const { re } of LANG_REQUEST_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags.includes("i") ? "gi" : "g"), " ");
  }
  out = out.replace(LEFTOVER_FILLER, " ").replace(/\s+/g, " ").trim();
  if (!/[0-9A-Za-z֐-׿]/.test(out)) return ""; // רק סימני פיסוק — אין תוכן
  return out;
}

export function t(obj, lang) {
  // obj can be { en: "...", he: "..." } or a plain string
  if (typeof obj === "string") return obj;
  return obj?.[lang] ?? obj?.en ?? "";
}
