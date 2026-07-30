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
// ⚠️ דגל (🇮🇱) הוא **זוג** Regional Indicators, ונספר כשני אמוג׳י — כך
//    "💳 🇮🇱" בעמוד הפיקדון נראה כשלושה ברצף. הזוג נתפס תחילה, כיחידה.
const FLAG = "[\\u{1F1E6}-\\u{1F1FF}]{2}";
// 🔴 טווח ה-Regional Indicators **מוחרג** מהטווח הכללי. בלי ההחרגה
//    האלטרנטיבה הקצרה עדיין תופסת כל חצי דגל בנפרד בעת backtracking,
//    ולכן "💳 🇮🇱" (שני אמוג׳י) נספר כשלושה — הכלל נראה מתוקן ולא היה.
const EMOJI_CORE = "[⌚-⌛⏩-⏺◽-◾☀-➿⬀-⯿\\u{1F000}-\\u{1F1E5}\\u{1F200}-\\u{1FAFF}]";
const EMOJI = new RegExp(`${FLAG}|${EMOJI_CORE}\\uFE0F?`, "gu");

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
  // ⚠️ העטיפה `(?:…)` סביב `EMOJI.source` הכרחית: המקור מכיל חלופה (`|`),
  //    ובלי סוגריים ה-`\s?` נצמד רק לחלופה האחרונה — והכלל התנהג אחרת
  //    לגמרי ממה שנראה בקוד.
  { id: "emoji-run", severity: "error",
    test: t => t.split("\n").some(line =>
      new RegExp(`(?:(?:${EMOJI.source})\\s?){3,}`, "u").test(line.replace(/[^\S\n]{2,}/g, " "))),
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
        // ORIGINAL הוא סימון חובה על חשבונית מס ("מקור") ולא צעקה.
        .replace(/\b(WIFI|WI-FI|VAT|ID|PDF|SMS|OK|VIP|USD|ILS|EUR|GBP|PMS|ORIGINAL)\b/g, " ");
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

// ════════════════════════════════════════════════════════
//  עמודי HTML — הפיקדון, האישור והחשבונית
//  ----------------------------------------------------------
//  אלה עמודים שהאורח פותח **בטלפון**, לרוב ברגע הרגיש ביותר (מסירת
//  פרטי כרטיס). הם חלק מהמותג בדיוק כמו הודעת הוואטסאפ, ולכן כפופים
//  לאותו תקן — ובנוסף לכללים שרלוונטיים רק לדף אינטרנט.
// ════════════════════════════════════════════════════════

// חילוץ הטקסט שהאורח **רואה**: בלי script/style, בלי תגיות, עם ישויות
// מפוענחות. בלי זה היינו בודקים CSS ומדווחים שטויות.
export function visibleText(html) {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[^\S\n]{2,}/g, " ")
    // ⚠️ החלפת תגיות ברווח מייצרת רווחים בקצות שורות ושורות ריקות.
    //    בלי הניקוי הזה המבקר מדווח "רווח בסוף שורה" על כל עמוד — תלונה
    //    על **שיטת החילוץ שלו**, לא על העמוד. רעש כזה מטביע ממצא אמיתי.
    .split("\n").map(l => l.trim()).filter((l, i, a) => l || (a[i - 1] || "").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const HTML_RULES = [
  { id: "html-no-lang", severity: "error",
    test: h => !/<html[^>]*\blang=/i.test(h),
    why: "חסר lang ב-<html> — קורא מסך וגוגל לא יודעים באיזו שפה מדובר" },

  { id: "html-no-dir", severity: "error",
    test: h => !/<html[^>]*\bdir=/i.test(h),
    why: "חסר dir — עמוד עברי חייב rtl, אחרת הפיסוק קופץ לצד הלא נכון" },

  { id: "html-dir-mismatch", severity: "error",
    test: h => /<html[^>]*lang="he"[^>]*dir="ltr"/i.test(h) || /<html[^>]*lang="en"[^>]*dir="rtl"/i.test(h),
    why: "אי-התאמה בין lang ל-dir" },

  { id: "html-no-viewport", severity: "error",
    test: h => !/name=["']viewport["']/i.test(h),
    why: "חסר viewport — האורח פותח בטלפון, והעמוד ייראה מוקטן" },

  { id: "html-no-charset", severity: "error",
    test: h => !/charset=/i.test(h),
    why: "חסר charset — עברית עלולה להישבר לג׳יבריש" },

  { id: "html-no-title", severity: "error",
    test: h => !/<title>\s*\S[\s\S]*?<\/title>/i.test(h),
    why: "חסרה כותרת <title> — זה מה שנראה בלשונית ובשיתוף" },

  { id: "html-empty-link", severity: "error",
    test: h => /<a\b[^>]*>\s*<\/a>/i.test(h),
    why: "קישור בלי טקסט" },

  { id: "html-dead-link", severity: "error",
    test: h => /<a\b[^>]*href=["'](?:#|)["']/i.test(h),
    why: "קישור ריק/מת — כפתור שלא מוביל לשום מקום" },

  // ⚠️ אין כאן כלל "מספר קשיח": ב-HTML **מרונדר** מספר הוא תוצאה תקינה,
  //    ולא ניתן להבחין מהפלט בין מספר שנגזר נכון לבין מספר שנכתב בקוד.
  //    זו הבחנה שנעשית מול **הציפייה** — `expectWhatsApp` למטה — ובנוסף
  //    יש בדיקה על קוד המקור עצמו (voice.test.mjs).

  { id: "html-input-no-label", severity: "warn",
    test: h => {
      const inputs = h.match(/<input\b[^>]*>/gi) || [];
      return inputs.some(i => !/type=["'](hidden|submit|button)["']/i.test(i)
        && !/aria-label=/i.test(i) && !/placeholder=/i.test(i) && !/\bid=/i.test(i));
    },
    why: "שדה קלט בלי תווית/placeholder — לא נגיש" },

  { id: "html-lang-mix", severity: "warn",
    test: (h) => {
      const lang = (h.match(/<html[^>]*lang="(\w\w)"/i) || [])[1];
      if (lang !== "en") return false;
      const text = visibleText(h);
      // מותרות מילים בודדות (שם מלון); בלוק עברי משמעותי בעמוד אנגלי — לא.
      return (text.match(/[֐-׿]/g) || []).length > 12;
    },
    why: "טקסט עברי משמעותי בעמוד באנגלית" },
];

/**
 * בודק עמוד HTML: גם כללי ה-HTML, וגם תקן הניסוח על הטקסט הנראה.
 */
export function auditHtml(html, { id = "", expectWhatsApp = null, expectHotelName = null } = {}) {
  const h = String(html ?? "");
  const out = [];

  // 🔴 בידוד מלונות בעמוד. שתי הבדיקות האלה תופסות בדיוק את הבאגים
  //    שהתגלו כאן: כפתור "חזרה לצ'אט" שהוביל לוואטסאפ של מלון אחר,
  //    ועמוד פיקדון שהיה ממותג בשם מלון אחר.
  if (expectWhatsApp) {
    const found = [...h.matchAll(/wa\.me\/(\d{6,})/g)].map(m => m[1]);
    const want = String(expectWhatsApp).replace(/\D/g, "");
    const wrong = found.filter(f => f !== want);
    if (wrong.length) {
      out.push({ id, rule: "html-wrong-whatsapp", severity: "error",
        why: `כפתור הצ'אט מוביל ל-${wrong.join(", ")} במקום ל-${want} — האורח נשלח למלון אחר`,
        sample: `[HTML] ${id}` });
    }
  }
  if (expectHotelName) {
    const text = visibleText(h);
    if (!text.includes(expectHotelName)) {
      out.push({ id, rule: "html-wrong-hotel", severity: "error",
        why: `שם המלון "${expectHotelName}" אינו מופיע בעמוד — ככל הנראה ממותג במלון אחר`,
        sample: `[HTML] ${id}: ${text.slice(0, 90)}` });
    }
  }

  for (const rule of HTML_RULES) {
    let hit = false;
    try { hit = rule.test(h); } catch { hit = false; }
    if (hit) out.push({ id, rule: rule.id, severity: rule.severity, why: rule.detail?.(h) || rule.why, sample: `[HTML] ${id}` });
  }
  // הטקסט הנראה כפוף לאותו תקן כמו הודעת וואטסאפ — פרט לכללים שאין
  // להם משמעות בדף (אורך, ופיסוק שנובע מפריסה).
  const skip = new Set(["too-long", "blank-lines", "markdown-leak"]);
  for (const v of auditText(visibleText(h), { id })) {
    if (!skip.has(v.rule)) out.push(v);
  }
  return out;
}

export { HTML_RULES };

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
