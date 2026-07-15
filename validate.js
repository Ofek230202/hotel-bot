// ════════════════════════════════════════════════════════
//  VALIDATE — הגנת קלט + חיטוי פלט (5 כוכבים: אף פעם לא נשבר)
//  ----------------------------------------------------------
//  שני תפקידים:
//  1. אימות קלט האורח בכל שלב של הצ'ק אין (שם / מספר הזמנה).
//     אף פעם לא "בולעים" קלט לא תקין — מבקשים שוב בנימוס, בלי
//     לאבד את השלב.
//  2. חיטוי כל הודעה יוצאת מתגים פנימיים ([CHECKIN], [HK:...] וכו').
//     תג פנימי לעולם לא אמור להגיע לאורח — זו רשת הביטחון האחרונה,
//     גם אם הקוד שמעליה פספס.
// ════════════════════════════════════════════════════════

// ── 1. חיטוי פלט — תגים פנימיים ────────────────────────
// כל תג בצורה [TAG] או [TAG:payload] באותיות גדולות הוא *פנימי* לפי
// הגדרה — אף הודעה לאורח לא אמורה להכיל כזה. מסננים גנרית (ולא רק
// רשימה סגורה) כדי שגם תג עתידי/מומצא ע"י ה-AI לא ידלוף.
const INTERNAL_TAG_RE = /\[[A-Z][A-Z0-9_]{1,24}(?::[^\]\n]{0,500})?\]/g;

export function hasInternalTag(text) {
  INTERNAL_TAG_RE.lastIndex = 0;
  return INTERNAL_TAG_RE.test(String(text ?? ""));
}

export function stripInternalTags(text) {
  return String(text ?? "")
    .replace(INTERNAL_TAG_RE, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── 2. אימות קלט ───────────────────────────────────────

// טווח האותיות העבריות (U+0590–U+05FF) + לטיניות.
const LETTER = /[A-Za-z֐-׿]/;

// ── מילים שמסגירות *פקודה*, לא שם ──────────────────────
// שורש התקלה "I want to check in, please enter your reservation number":
// "I want to check in" הוא 5 מילים בלי ספרות — כלומר עבר את בדיקת השם
// ונשמר כשמו של האורח, ומשם הודבק לתוך ההודעה הבאה. אף שם אמיתי לא
// מכיל את המילים האלה, ולכן דוחים אותן מפורשות ומבקשים שם שוב.
const COMMAND_TOKENS = new Set([
  // אנגלית
  "check", "checkin", "checkout", "chek", "chekin", "checking", "in", "out",
  "want", "wanna", "please", "reservation", "booking", "confirm", "cancel",
  "hello", "hey", "arrived", "room", "help",
  // עברית
  "צק", "צכ", "תק", "צאק", "אין", "אאוט", "צקאין", "צקאאוט",
  "הגעתי", "רוצה", "להתחיל", "בבקשה", "שלום", "היי", "אהלן",
  "הזמנה", "ההזמנה", "מאשר", "מאשרת", "ביטול", "לעשות", "עזרה",
]);

// שם מלא: טקסט הגיוני — אותיות, לפחות שתי מילים, בלי ספרות/סימנים מוזרים,
// ובלי מילות פקודה. מחזיר { ok, value } או { ok:false, reason }.
export function validateFullName(raw) {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();

  if (!text) return { ok: false, reason: "empty" };
  if (text.length > 60) return { ok: false, reason: "too_long" };
  if (/\d/.test(text)) return { ok: false, reason: "has_digits" };
  if (/[?!@#$%^&*_=+<>{}[\]\\/|~`]/.test(text)) return { ok: false, reason: "not_a_name" };

  const letters = (text.match(/[A-Za-z֐-׿]/g) || []).length;
  if (letters < 2) return { ok: false, reason: "no_letters" };
  // רוב התווים חייבים להיות אותיות — "אאא ... ." אינו שם
  if (letters / text.length < 0.6) return { ok: false, reason: "not_a_name" };

  const words = text.split(" ").filter(w => LETTER.test(w));
  if (words.length < 2) return { ok: false, reason: "single_word" };
  if (words.length > 5) return { ok: false, reason: "too_many_words" };

  // מילת פקודה אחת מספיקה כדי לפסול — זו בקשה, לא שם.
  if (words.some(w => COMMAND_TOKENS.has(w.toLowerCase()))) {
    return { ok: false, reason: "command_phrase" };
  }

  return { ok: true, value: text };
}

// מילות מילוי מותרות סביב מספר ההזמנה ("מספר ההזמנה שלי הוא 1234").
const RESERVATION_FILLER = new Set([
  "מספר", "מס", "המספר", "הזמנה", "ההזמנה", "שלי", "הוא", "היא", "זה", "זהו",
  "קוד", "אישור", "הזמנת", "רזרבציה",
  "number", "num", "no", "reservation", "booking", "confirmation", "code",
  "ref", "my", "is", "it", "its", "the", "id",
]);

// מספר הזמנה: ספרות בלבד (עד 12). מקבלים גם "#1234" או "מספר ההזמנה שלי 1234",
// אבל *לא* טקסט חופשי כמו "10 יותר נוח לי בעברית" — שם נבקש שוב.
export function validateReservationNumber(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: "empty" };

  const tokens = text.split(/[^0-9A-Za-z֐-׿]+/).filter(Boolean);
  const digitTokens = tokens.filter(tk => /^\d+$/.test(tk));
  const wordTokens  = tokens.filter(tk => !/^\d+$/.test(tk));

  if (digitTokens.length === 0) return { ok: false, reason: "not_numeric" };
  if (digitTokens.length > 1)   return { ok: false, reason: "ambiguous" };

  // כל מה שאינו הספרות חייב להיות מילת מילוי מוכרת — אחרת זה טקסט חופשי.
  if (wordTokens.some(tk => !RESERVATION_FILLER.has(tk.toLowerCase()))) {
    return { ok: false, reason: "extra_text" };
  }

  const value = digitTokens[0];
  if (value.length > 12) return { ok: false, reason: "too_long" };

  return { ok: true, value };
}

// ── תאריכי שהייה ───────────────────────────────────────
// מקבל ניסוח חופשי של אורח ומחזיר { checkIn, checkOut, nights } מנורמל.
// נתמך: "20/07/2026 - 23/07/2026", "20.7 עד 23.7", "20/07/2026, 3 לילות",
// "היום, 2 לילות", "tomorrow until 23/07", "20-07-2026 to 23-07-2026".
// אין ניחושים: קלט לא חד-משמעי נדחה עם סיבה, והשלב פשוט נשאל שוב.
const MAX_NIGHTS = 60;
const DAY_MS = 86_400_000;

// "היום" של המלון — לפי שעון ישראל, לא לפי UTC (ב-01:00 בלילה
// התאריך ב-UTC עדיין אתמול, וזה היה פוסל הגעה של היום).
function israelToday(now) {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  return new Date(`${ymd}T00:00:00Z`);
}

// כל חשבון התאריכים נעשה ב-UTC-חצות — בלי שעות, בלי אזורי זמן, בלי DST.
function buildDate(day, month, year) {
  const d = new Date(Date.UTC(year, month - 1, day));
  // דוחה תאריכים שאינם קיימים (31/02 → 03/03 אצל JS)
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d;
}
const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);
const asYmd   = (d) => d.toISOString().slice(0, 10);

// איתור תאריכים בטקסט, בשני מעברים כדי לא לבלוע מפריד טווח:
//  1. תאריך מלא עם שנה. ה-backreference (\2) מחייב *אותו מפריד* בשני
//     המקומות — בלעדיו "20.7-23.7" נקרא כ-"20.7.23" (שנת 2023!) והמפריד
//     של הטווח נבלע לתוך התאריך הראשון.
//  2. על מה שנשאר: יום/חודש בלי שנה, עם . או / בלבד ("-" שמור לטווח).
function findDateTokens(text) {
  const found = [];
  const full = /(\d{1,2})([./-])(\d{1,2})\2(\d{2,4})/g;
  let m;
  while ((m = full.exec(text)) !== null) {
    found.push({ index: m.index, day: +m[1], month: +m[3], year: +m[4], len: m[0].length });
  }
  let masked = text;
  for (const f of found) {
    masked = masked.slice(0, f.index) + "#".repeat(f.len) + masked.slice(f.index + f.len);
  }
  const short = /(\d{1,2})[./](\d{1,2})/g;
  while ((m = short.exec(masked)) !== null) {
    found.push({ index: m.index, day: +m[1], month: +m[2], year: null, len: m[0].length });
  }
  return found.sort((a, b) => a.index - b.index);
}

// שנה חסרה → משלימים בהיגיון של קבלה:
//  - הגעה: השנה הנוכחית, אלא אם התאריך כבר עמוק בעבר → השנה הבאה.
//  - עזיבה: שנת ההגעה, אלא אם יוצא לפני/בדיוק בהגעה → שנה אחריה
//    (מטפל בשהייה שחוצה 31/12).
function resolveToken(tok, ref, kind) {
  if (tok.year != null) return buildDate(tok.day, tok.month, tok.year < 100 ? 2000 + tok.year : tok.year);
  const base = ref.getUTCFullYear();
  const d = buildDate(tok.day, tok.month, base);
  if (!d) return null;
  const rolls = kind === "arrival"
    ? d.getTime() < ref.getTime() - 60 * DAY_MS
    : d.getTime() <= ref.getTime();
  return rolls ? buildDate(tok.day, tok.month, base + 1) : d;
}

export function validateStayDates(raw, now = new Date()) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > 120) return { ok: false, reason: "unclear" };

  const today = israelToday(now);

  const nightsM = text.match(/(\d{1,3})\s*(?:לילות|לילה|nights?)/i);
  // "לילה אחד" / "one night" — נפוץ בדיבור, ואין בו ספרה.
  const nights  = nightsM ? +nightsM[1]
                : /לילה\s+אחד/.test(text) || /\bone\s+night\b/i.test(text) ? 1
                : null;

  // ⚠️ \b לא עובד על עברית: הוא מוגדר לפי [A-Za-z0-9_], ואות עברית היא
  // "לא-מילה" — כך ש-/\bהיום\b/ לעולם לא מתאים בתחילת מחרוזת. לכן גבולות
  // מפורשים לעברית, ו-\b רק לאנגלית. התחילית האופציונלית מכסה צורות
  // כמו "מהיום" / "למחר" שנדבקות למילה בעברית.
  const heWord = (w) => new RegExp(`(?:^|[\\s,])[מבלו]?${w}(?=$|[\\s,.!?])`).test(text);
  const rel = heWord("היום") || /\btoday\b/i.test(text) ? 0
            : heWord("מחר") || /\btomorrow\b/i.test(text) ? 1
            : null;

  const toks = findDateTokens(text);
  let checkIn = null, checkOut = null;

  if (rel !== null) {
    checkIn = addDays(today, rel);
    if (toks.length >= 1)   checkOut = resolveToken(toks[0], checkIn, "departure");
    else if (nights != null) checkOut = addDays(checkIn, nights);
    else return { ok: false, reason: "one_date" };
  } else if (toks.length >= 2) {
    checkIn  = resolveToken(toks[0], today, "arrival");
    if (!checkIn) return { ok: false, reason: "bad_date" };
    checkOut = resolveToken(toks[1], checkIn, "departure");
  } else if (toks.length === 1) {
    if (nights == null) return { ok: false, reason: "one_date" };
    checkIn = resolveToken(toks[0], today, "arrival");
    if (!checkIn) return { ok: false, reason: "bad_date" };
    checkOut = addDays(checkIn, nights);
  } else {
    return { ok: false, reason: nights != null ? "no_arrival" : "no_dates" };
  }

  if (!checkIn || !checkOut) return { ok: false, reason: "bad_date" };

  const n = Math.round((checkOut.getTime() - checkIn.getTime()) / DAY_MS);
  if (n < 1)          return { ok: false, reason: "not_after" };
  if (n > MAX_NIGHTS) return { ok: false, reason: "too_long" };
  // הגעה בעבר — מלבד אתמול, שנשאר קביל (אורח שמאחר בלילה).
  if (checkIn.getTime() < today.getTime() - DAY_MS) return { ok: false, reason: "past" };

  return { ok: true, value: { checkIn: asYmd(checkIn), checkOut: asYmd(checkOut), nights: n } };
}

// ── אישור תנאי שהייה ───────────────────────────────────
// דורש נוסח *מפורש*. "כן"/"ok" אינם אישור משפטי לתנאים — מבקשים
// מהאורח לכתוב "אני מאשר" / "I confirm", וזה מה שנשמר על ההזמנה.
const TERMS_CONFIRM = new Set([
  "אני מאשר", "אני מאשרת", "אני מאשר/ת", "מאשר", "מאשרת", "מאשר/ת",
  "אני מסכים", "אני מסכימה", "מסכים", "מסכימה",
  "i confirm", "confirm", "confirmed", "i agree", "agree", "agreed",
]);
const TERMS_VAGUE    = new Set(["כן", "אוקיי", "אוקי", "בסדר", "סבבה", "yes", "yep", "yeah", "ok", "okay", "sure", "y", "👍"]);
const TERMS_DECLINED = new Set(["לא", "לא מאשר", "לא מאשרת", "לא מסכים", "לא מסכימה", "ביטול", "בטל", "no", "nope", "cancel", "i decline", "decline", "disagree"]);

export function validateTermsConfirmation(raw) {
  const t = String(raw ?? "")
    .replace(/['’‘`״׳.!,]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!t) return { ok: false, reason: "empty" };
  if (TERMS_CONFIRM.has(t))  return { ok: true, value: true };
  if (TERMS_DECLINED.has(t)) return { ok: false, reason: "declined" };
  if (TERMS_VAGUE.has(t))    return { ok: false, reason: "not_explicit" };
  return { ok: false, reason: "unclear" };
}

// סוגי תמונה שספק ה-AI (Claude vision) יודע לקרוא.
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"]);

// תעודת זהות: חייבת להיות תמונה (ובפורמט נתמך). הבדיקה שהתמונה באמת
// *נראית* כמו תעודה מתבצעת בשכבת idverify (Claude vision).
export function validateIdMedia(media) {
  if (!media || !media.url) return { ok: false, reason: "no_media" };
  const type = String(media.contentType || "").toLowerCase().split(";")[0].trim();
  if (!type.startsWith("image/")) return { ok: false, reason: "not_an_image" };
  if (!SUPPORTED_IMAGE_TYPES.has(type)) return { ok: false, reason: "unsupported_image" };
  return { ok: true, value: type === "image/jpg" ? "image/jpeg" : type };
}
