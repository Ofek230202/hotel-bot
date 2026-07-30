// ════════════════════════════════════════════════════════
//  VOICE — תקן הניסוח, כקוד שאפשר לאכוף
//  ----------------------------------------------------------
//  `KEMPINSKI_STANDARD.md` מגדיר את התקן ברמת ה**יכולות** ("טון חם,
//  מקצועי, אלגנטי"). זה נכון — ובלתי אכיף. משפט כזה לא עוצר אף הודעה
//  גרועה, כי אין לו הגדרה שאפשר להריץ.
//
//  כאן התקן הופך לכללים בדוקים. לא כדי "לתפוס שגיאות כתיב", אלא כי
//  ההבדל בין קבלה של מלון חמישה כוכבים לבין בוט הוא בדיוק הפרטים
//  שאיש לא בודק: שלוש נקודות במקום שלוש-נקודות, סימן קריאה מיותר,
//  אמוג׳י אחד יותר מדי, "אולי" במקום תשובה.
//
//  ── שלוש חומרות ─────────────────────────────────────────
//   error  — לא יוצא לאורח. שובר את התקן.
//   warn   — כמעט תמיד שגוי, אך יש חריגים לגיטימיים.
//   info   — לתשומת לב בסקירה ידנית.
//
//  ⚠️ הכללים חלים על **הודעות לאורח**. התראות צוות הן מסמך תפעולי —
//     שם צפיפות מידע חשובה יותר מאלגנטיות, ולכן נבדקות בנפרד ובקלילות.
// ════════════════════════════════════════════════════════

const HEB = /[֐-׿]/;

// אמוג׳י — טווחים עיקריים. משמש לספירה, לא לאימות.
// ⚠️ המחלקה **אינה** כוללת את Variation Selector-16 (U+FE0F) כתו עצמאי.
//    בגרסה הראשונה הוא נכלל בטעות, ולכן "⚠️" (שני קודפוינטים) נספר
//    כשני אמוג׳י — ו-"📝 ⚠️" נראה כשלושה ברצף. המבקר דיווח הפרה שלא
//    קיימת. כאן ה-VS16 הוא **סיומת אופציונלית** של התו שלפניו.
const EMOJI_CORE = "[⌚-⌛⏩-⏺◽-◾☀-➿⬀-⯿\\u{1F000}-\\u{1FAFF}]";
const EMOJI = new RegExp(`${EMOJI_CORE}\\uFE0F?`, "gu");

// ביטויים שקונסיירז' של מלון יוקרה לא אומר, ולמה.
//
// 🔴 **בלי `\b` סביב עברית.** `\b` מבוסס על `\w` שהוא ASCII בלבד, ולכן
//    `/\bאני בוט\b/` פשוט **לא מתאים לעולם**. זו בדיוק המלכודת שכבר
//    תועדה בפרויקט (§7.2.2 — "בערב" לא זוהה מאותה סיבה), וחזרתי עליה
//    כאן. הכללים נראו עובדים עד שנבדקו — וזה הדבר המסוכן במבקר סגנון:
//    הוא מדווח "נקי" ואי אפשר להבחין בין "אין הפרות" ל"לא בדקתי".
const FORBIDDEN = [
  [/אני בוט|אני רובוט|בינה מלאכותית|\bAI\b(?!\s*concierge)/i,
   "מציג את עצמו כבוט — פוגע בחוויה. הוא הקונסיירז' של המלון"],
  [/אין לי מידע|לא יודע|איני יודע|אין לי גישה למידע/,
   "\"אני לא יודע\" בלי המשך אינה תשובה. הניסוח הנכון: אבדוק ואחזור אליך"],
  [/תקלה טכנית|שגיאת מערכת|\bError\b|\bexception\b/i,
   "שפה טכנית דולפת לאורח"],
  [/אולי.*אולי|נראה לי ש|אני חושב ש|כנראה ש/,
   "היסוס כפול. קונסיירז' מוסר עובדה, או אומר שיבדוק"],
  [/מצטער.*מצטער|סליחה.*סליחה/,
   "התנצלות כפולה באותה הודעה — נשמע מתגונן"],
  [/בבקשה בבקשה|תודה תודה/, "כפילות מנומסת"],
];

// ── הכללים ──────────────────────────────────────────────
// כל כלל: id, חומרה, בדיקה (מחזירה true כשיש הפרה), הסבר.
export const VOICE_RULES = [
  // ── מכניקה שמסגירה "נכתב במהירות" ──
  { id: "double-space", severity: "error",
    test: t => /\S {2,}\S/.test(t),
    why: "רווח כפול בתוך משפט" },

  { id: "trailing-space", severity: "warn",
    test: t => /[ \t]+$/m.test(t),
    why: "רווח בסוף שורה" },

  { id: "three-dots", severity: "error",
    test: t => /\.\.\./.test(t),
    why: "שלוש נקודות רגילות — יש להשתמש ב-… (תו יחיד)" },

  { id: "double-punct", severity: "error",
    test: t => /[!?]{2,}/.test(t),
    why: "סימני פיסוק כפולים (!! או ??) — צועק, לא מארח" },

  { id: "space-before-punct", severity: "error",
    test: t => /\s+[,.!?:;](\s|$)/.test(t),
    why: "רווח לפני סימן פיסוק" },

  { id: "blank-lines", severity: "error",
    test: t => /\n{3,}/.test(t),
    why: "שלוש שורות ריקות ברצף" },

  // ── סימנים של טקסט שנכתב למסך אחר ──
  { id: "markdown-leak", severity: "error",
    test: t => /\*\*|^#{1,6}\s|^\s*[-_*]{3,}\s*$|\|\s*:?-{3,}/m.test(t),
    why: "תחביר markdown שוואטסאפ לא מרנדר" },

  { id: "placeholder", severity: "error",
    test: t => /\{(hotel|deposit|checkout_time|name|room|guest)\}/.test(t),
    why: "placeholder שלא הוחלף" },

  { id: "code-value", severity: "error",
    test: t => /\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]/.test(t),
    why: "ערך מהקוד דלף לאורח" },

  { id: "internal-tag", severity: "error",
    test: t => /\[(HK|HK_URGENT|MAINTENANCE|ROOMSERVICE|CONCIERGE|RECEPTION|SECURITY|EMERGENCY|CHECKIN|CHECKOUT)\b/.test(t),
    why: "תג פנימי דלף לאורח" },

  // ── טון ──
  { id: "exclamations", severity: "warn",
    test: t => (t.match(/!/g) || []).length > 2,
    why: "יותר משני סימני קריאה בהודעה — נשמח נלהב מדי, לא מארח" },

  // אמוג׳י ב**תחילת שורה** הוא תווית שדה ("🚪 חדר:", "📅 הגעה:") וזו
  // תבנית לגיטימית ואף קריאה. מה שמוזיל הוא אמוג׳י **בתוך** משפט.
  { id: "emoji-density", severity: "warn",
    test: (t) => {
      const inline = t.split("\n")
        .map(l => l.replace(new RegExp(`^\\s*(?:${EMOJI.source})\\s*`, "u"), ""))
        .join("\n");
      return (inline.match(EMOJI) || []).length > 4;
    },
    why: "יותר מארבעה אמוג׳י בתוך משפטים (לא כתוויות שדה) — קריא כזול" },

  // ⚠️ נכשל בעבר על "🚨 *דחוף* 🚨\n🏨 *RECEPTION*": הסרת **כל** הרווחים
  //    הצמידה אמוג׳י משורות שונות. הבדיקה חייבת להיות בתוך שורה אחת
  //    ועל צמידות אמיתית, אחרת המבקר מדווח שקר — ומבקר ששקרן פעם אחת
  //    מפסיקים להקשיב לו.
  { id: "emoji-run", severity: "error",
    test: t => t.split("\n").some(line =>
      new RegExp(`(?:${EMOJI.source}\\s?){3,}`, "u").test(line.replace(/[^\S\n]{2,}/g, " "))),
    why: "שלושה אמוג׳י ברצף באותה שורה" },

  // רשימת פעלים סגורה פספסה נטיות ("להקליד/י", "מוזמנת/ים"). החתימה
  // האמיתית של הצורה הזו היא **מילה עברית + לוכסן + אות עברית בודדת**.
  { id: "slash-gender", severity: "error",
    test: t => /[֐-׿]{2,}\/[יאתםן](?![֐-׿])/.test(t),
    why: "צורת לוכסן (הקלד/י) — לנסח ניטרלית" },

  // ⚠️ מזהי הזמנה ("RES-VOICE-1"), קודים ומספרי אישור אינם צעקה. הכלל
  //    חל רק על **מילה אלפבתית טהורה** שאינה חלק ממזהה עם ספרות/מקפים.
  { id: "all-caps", severity: "warn",
    test: (t) => {
      const cleaned = t
        .replace(/\b[A-Z0-9]*\d[A-Z0-9-]*\b/g, " ")          // מזהים עם ספרות
        .replace(/\b[A-Z]+(?:-[A-Z]+)+\b/g, " ")              // מזהים מקופים
        .replace(/\b(WIFI|WI-FI|VAT|ID|PDF|SMS|OK|VIP|USD|ILS|EUR|GBP|PMS)\b/g, " ");
      return /\b[A-Z]{5,}\b/.test(cleaned);
    },
    why: "מילים באותיות גדולות באנגלית — נקרא כצעקה" },

  // ── עברית תקנית ──
  // ⚠️ גרשיים בראשי תיבות ("בע\"מ", "ת\"ז", "ע.מ") הם כתיב תקני ולא
  //    ציטוט. הכלל חל רק על **ציטוט של ביטוי** (יש רווח בין המרכאות).
  { id: "hebrew-quotes", severity: "info",
    test: t => HEB.test(t) && /"[^"\n]*\s[^"\n]*"/.test(t),
    why: "ציטוט במרכאות ישרות בעברית — לשקול ״ ״" },

  { id: "ana-vs-na", severity: "info",
    test: t => /\bאנא\b/.test(t),
    why: "\"אנא\" — במלון מנוסח לרוב \"נא\" או משפט ישיר" },

  // ── מהות ──
  { id: "forbidden-phrase", severity: "error",
    test: t => FORBIDDEN.some(([re]) => re.test(t)),
    detail: t => FORBIDDEN.find(([re]) => re.test(t))?.[1],
    why: "ביטוי שאינו עומד בתקן" },

  { id: "empty", severity: "error",
    test: t => !String(t).trim(),
    why: "הודעה ריקה" },

  { id: "too-long", severity: "warn",
    test: t => t.length > 1500,
    why: "מעל מגבלת וואטסאפ (1600) — תפוצל, אך עדיף לקצר" },
];

/**
 * בודק טקסט אחד. מחזיר רשימת הפרות.
 * `staff:true` מרכך — התראת צוות היא מסמך תפעולי ולא חוויית אורח.
 */
export function auditText(text, { staff = false, id = "" } = {}) {
  const t = String(text ?? "");
  const skipForStaff = new Set(["emoji-density", "exclamations", "all-caps", "ana-vs-na", "hebrew-quotes", "too-long", "internal-tag"]);
  const out = [];
  for (const rule of VOICE_RULES) {
    if (staff && skipForStaff.has(rule.id)) continue;
    let hit = false;
    try { hit = rule.test(t); } catch { hit = false; }
    if (!hit) continue;
    out.push({
      id, rule: rule.id, severity: rule.severity,
      why: rule.detail?.(t) || rule.why,
      sample: excerpt(t, rule),
    });
  }
  return out;
}

// קטע קצר סביב ההפרה — כדי שהדיווח יהיה שמיש ולא "יש בעיה איפשהו".
function excerpt(t, rule) {
  const flat = t.replace(/\n/g, " ⏎ ");
  if (rule.id === "double-space") {
    const m = flat.match(/\S {2,}\S/);
    return m ? `…${m[0]}…` : flat.slice(0, 90);
  }
  return flat.slice(0, 110);
}

/** בודק אוסף הודעות ומחזיר סיכום. */
export function auditAll(messages = []) {
  const violations = [];
  for (const m of messages) {
    violations.push(...auditText(m.body ?? m.text ?? m, { staff: !!m.staff, id: m.id || m.to || "" }));
  }
  const bySeverity = { error: 0, warn: 0, info: 0 };
  const byRule = {};
  for (const v of violations) {
    bySeverity[v.severity]++;
    byRule[v.rule] = (byRule[v.rule] || 0) + 1;
  }
  return { violations, bySeverity, byRule, clean: bySeverity.error === 0 };
}
