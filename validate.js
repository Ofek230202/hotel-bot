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
//
// ⚠️ ה-payload מורשה להכיל שורות חדשות (`[^\]]` ולא `[^\]\n]`). ה-AI
// כותב לפעמים תג רב-שורתי, וגרסה שדרשה שורה אחת פשוט לא התאימה לו —
// כלומר התג *לא* סונן ונשלח לאורח כטקסט.
const INTERNAL_TAG_RE = /\[[A-Z][A-Z0-9_]{1,24}(?::[^\]]{0,600})?\]/g;

// ── תג *קטוע* בסוף הטקסט ───────────────────────────────
// זה שורש הדליפה שנצפתה: האורח קיבל "[CONCIERGE:restaurant|".
// ה-AI נעצר באמצע כתיבת התג (max_tokens), ולכן לא נכתב "]" סוגר —
// והרגקס שלמעלה, שדורש סוגר, לא התאים לו כלל. תג בלי סוגר בסוף
// המחרוזת הוא *תמיד* תג קטוע: אין שום סיבה לגיטימית שתשובה לאורח
// תסתיים בסוגר מרובע פתוח.
const TRUNCATED_TAG_RE = /\[[A-Z0-9_]{0,25}(?::[^\]]{0,600})?$/;

export function hasInternalTag(text) {
  const s = String(text ?? "");
  INTERNAL_TAG_RE.lastIndex = 0;
  return INTERNAL_TAG_RE.test(s) || TRUNCATED_TAG_RE.test(s);
}

export function stripInternalTags(text) {
  return String(text ?? "")
    .replace(INTERNAL_TAG_RE, " ")
    .replace(TRUNCATED_TAG_RE, " ")
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

// מספר הזמנה: קוד **אלפאנומרי**, לא ספרות בלבד.
//
// 🔴 למה זה שונה ממה שהיה: הגרסה הקודמת קיבלה ספרות בלבד, ולכן דחתה
// "RES12345" — בדיוק הפורמט של אישורי הזמנה אמיתיים (Kempinski, Booking,
// Expedia כולם מנפיקים קוד עם אותיות). אורח שהקליד את הקוד שבאישור
// שלו קיבל "מספר ההזמנה מורכב מספרות בלבד" שוב ושוב, בלי שום דרך
// להתקדם — הצ'ק אין נתקע לצמיתות.
//
// הכלל עכשיו: אסימון אחד שמכיל *לפחות ספרה אחת*, מאותיות לטיניות/ספרות
// (ומקפים פנימיים — "BK-8842-QT"), באורך 3–16. מילות מילוי מוכרות סביבו
// מותרות ("מספר ההזמנה שלי הוא 1234"), וכל שאר הטקסט החופשי עדיין נדחה,
// כך ש-"10 יותר נוח לי בעברית" או "4 לילות 19.7" לא נבלעים כמספר הזמנה.
const RESERVATION_CODE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/;

export function validateReservationNumber(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: "empty" };

  // מפרידים על רווחים/פיסוק, אבל **לא** על מקף — הוא חלק לגיטימי מהקוד.
  const tokens = text.split(/[^0-9A-Za-z֐-׿-]+/).filter(t => t.replace(/-/g, ""));

  const codeTokens = [];
  const wordTokens = [];
  for (const tk of tokens) {
    // אסימון קוד = אותיות לטיניות/ספרות (+מקפים) עם לפחות ספרה אחת.
    if (/\d/.test(tk) && RESERVATION_CODE.test(tk)) codeTokens.push(tk);
    else wordTokens.push(tk);
  }

  if (codeTokens.length === 0) {
    // אין שום ספרה בטקסט → לא נראה כמו קוד הזמנה בכלל.
    return { ok: false, reason: /\d/.test(text) ? "extra_text" : "not_numeric" };
  }
  if (codeTokens.length > 1) return { ok: false, reason: "ambiguous" };

  // כל מה שאינו הקוד חייב להיות מילת מילוי מוכרת — אחרת זה טקסט חופשי.
  if (wordTokens.some(tk => !RESERVATION_FILLER.has(tk.replace(/-/g, "").toLowerCase()))) {
    return { ok: false, reason: "extra_text" };
  }

  // אין מינימום אורך: מלונות מנפיקים גם קודים קצרים, ובדמו משתמשים
  // במספרים כמו "10". הסינון של טקסט חופשי נעשה כבר על ידי wordTokens.
  const value = codeTokens[0].toUpperCase();
  if (value.length > 16) return { ok: false, reason: "too_long" };

  return { ok: true, value };
}

// ── תאריכי שהייה ───────────────────────────────────────
// מקבל ניסוח חופשי של אורח ומחזיר { checkIn, checkOut, nights } מנורמל.
//
// 🔴 הבאג הקריטי שהקוד הזה מתקן:
// "4 לילות עד ה-21/7" נקרא בעבר כ*הגעה* ב-21/7 ועזיבה ב-25/7 — כי כל
// תאריך ראשון בטקסט נחשב אוטומטית להגעה. המשמעות האמיתית הפוכה בדיוק:
// 21/7 הוא יום ה*עזיבה*, וההגעה היא ארבעה לילות לפניו — 17/7.
// תאריך שגוי כאן = כרטיס חדר מתוקף לימים הלא נכונים, חיוב על תקופה
// שגויה, ואורח שעומד מול דלת נעולה. זה חייב להיות נכון.
//
// לכן הפרסור מבוסס *תפקיד* ולא *מיקום*: המילה שלפני התאריך ("עד",
// "until", "מ-", "from") היא שקובעת אם הוא הגעה או עזיבה. רק כשאין שום
// סימן — נופלים למיקום (ראשון = הגעה, שני = עזיבה), כי זו אכן המשמעות
// של "20/7 - 23/7". קלט שלא ניתן להכריע בו נדחה עם סיבה, ונשאל שוב.
//
// נתמך: "20/07/2026 - 23/07/2026", "20.7 עד 23.7", "מ-20/7 ל-23/7",
// "20/07/2026, 3 לילות", "4 לילות עד ה-21/7", "3 nights until 21/7",
// "היום, 2 לילות", "tomorrow until 23/07", "20-07-2026 to 23-07-2026".
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

// ── תפקיד התאריך נקבע לפי המילה שלפניו ─────────────────
// "עד ה-21/7" → עזיבה. "מ-20/7" → הגעה. זה כל ההבדל בין שהייה נכונה
// לשהייה הפוכה, ולכן זו רשימה מפורשת ולא ניחוש.
const ARRIVAL_MARKERS = new Set([
  // עברית
  "מ", "מה", "מיום", "מתאריך", "מהתאריך", "החל", "הגעה", "הגעתי",
  "מגיע", "מגיעה", "מגיעים", "נכנס", "נכנסת", "נכנסים", "כניסה",
  // אנגלית
  "from", "since", "starting", "start", "arriving", "arrive", "arrival",
  "checkin", "in",
]);
const DEPARTURE_MARKERS = new Set([
  // עברית
  "עד", "ועד", "ל", "לה", "ליום", "לתאריך", "עזיבה", "יציאה",
  "עוזב", "עוזבת", "עוזבים", "יוצא", "יוצאת", "יוצאים", "אאוט", "מפנה",
  // אנגלית
  "until", "till", "to", "thru", "through", "by",
  "departure", "departing", "depart", "leaving", "leave", "checkout", "out",
]);

// מילים "שקופות" שאינן מסגירות תפקיד — נזרקות מסוף החלון כדי שנגיע
// למילה שכן מסגירה. בלעדיהן "עד יום 21/7" היה נראה חסר סימן ("יום"),
// ונקרא בטעות כהגעה.
const NEUTRAL_WORDS = new Set([
  "ה", "ב", "בה", "יום", "ביום", "תאריך", "בתאריך", "התאריך", "בערך", "בסביבות",
  "the", "on", "at", "of", "day", "date", "around", "about",
]);

// המילה המשמעותית האחרונה שלפני התאריך. הספרות עצמן אינן אותיות ולכן
// נופלות מהפיצול — כך שגם ב-"מ-20/7 ל-23/7" המילה שלפני התאריך השני
// היא "ל" ולא "20/7". החלון מוגבל ל-40 תווים: מילה רחוקה יותר אינה
// מתארת את התאריך הזה, ואסור לה להשפיע עליו.
function markerBefore(prefix) {
  const words = String(prefix).slice(-40).split(/[^A-Za-z֐-׿]+/).filter(Boolean);
  while (words.length && NEUTRAL_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
  const last = (words[words.length - 1] || "").toLowerCase();
  if (ARRIVAL_MARKERS.has(last))   return "arrival";
  if (DEPARTURE_MARKERS.has(last)) return "departure";
  return null;
}

// "היום" / "מחר" / today / tomorrow — עם המיקום שלהם, כדי שגם להם
// ייקבע תפקיד לפי מה שכתוב לפניהם ("עד מחר" = עזיבה).
// ⚠️ \b לא עובד על עברית: הוא מוגדר לפי [A-Za-z0-9_], ואות עברית היא
// "לא-מילה" — כך ש-/\bהיום\b/ לעולם לא מתאים בתחילת מחרוזת. לכן גבולות
// מפורשים לעברית, ו-\b רק לאנגלית. התחילית האופציונלית מכסה צורות
// כמו "מהיום" / "למחר" שנדבקות למילה בעברית.
function findRelToken(text) {
  const he = /(?:^|[\s,])[מבלו]?(היום|מחר)(?=$|[\s,.!?])/.exec(text);
  if (he) return { index: he.index, days: he[1] === "היום" ? 0 : 1 };
  const en = /\b(today|tomorrow)\b/i.exec(text);
  if (en) return { index: en.index, days: en[1].toLowerCase() === "today" ? 0 : 1 };
  return null;
}

export function validateStayDates(raw, now = new Date()) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > 120) return { ok: false, reason: "unclear" };

  const today = israelToday(now);
  const toks  = findDateTokens(text);

  // ממסכים את התאריכים לפני חיפוש "לילות"/"היום" — אחרת הספרות שבתוך
  // התאריך נשאבות לחיפושים האחרים: "21/7 לילה" היה נקרא כ-"7 לילות".
  let masked = text;
  for (const t of toks) {
    masked = masked.slice(0, t.index) + "#".repeat(t.len) + masked.slice(t.index + t.len);
  }

  const nightsM = masked.match(/(\d{1,3})\s*(?:לילות|לילה|nights?)/i);
  // "לילה אחד" / "one night" — נפוץ בדיבור, ואין בו ספרה.
  const nights  = nightsM ? +nightsM[1]
                : /לילה\s+אחד/.test(masked) || /\bone\s+night\b/i.test(masked) ? 1
                : null;
  if (nights !== null && nights < 1)          return { ok: false, reason: "not_after" };
  if (nights !== null && nights > MAX_NIGHTS) return { ok: false, reason: "too_long" };

  // ── איסוף ההתייחסויות ליום, כל אחת עם התפקיד שלה ─────
  const refs = toks.map(t => ({
    index: t.index, tok: t, rel: null, role: markerBefore(text.slice(0, t.index)),
  }));
  const rt = findRelToken(masked);
  if (rt) refs.push({ index: rt.index, tok: null, rel: rt.days, role: markerBefore(text.slice(0, rt.index)) });
  refs.sort((a, b) => a.index - b.index);

  // תאריך יחסי נקבע מייד; תאריך מספרי צריך השלמת שנה, ולכן תלוי בתפקיד
  // ובנקודת הייחוס.
  const resolve = (ref, base, kind) =>
    ref.rel !== null ? addDays(today, ref.rel) : resolveToken(ref.tok, base, kind);

  if (refs.length === 0) return { ok: false, reason: nights != null ? "no_arrival" : "no_dates" };
  if (refs.length > 2)   return { ok: false, reason: "ambiguous" };

  let checkIn = null, checkOut = null;

  if (refs.length === 1) {
    const r = refs[0];
    if (nights == null) return { ok: false, reason: "one_date" };

    if (r.role === "departure") {
      // ⭐ התיקון: "4 לילות עד ה-21/7" — התאריך הוא העזיבה, וההגעה
      //    מחושבת אחורה ממנו. נקודת הייחוס להשלמת שנה היא אתמול, כדי
      //    שעזיבה *היום* לא "תתגלגל" לשנה הבאה.
      checkOut = resolve(r, addDays(today, -1), "departure");
      if (!checkOut) return { ok: false, reason: "bad_date" };
      checkIn  = addDays(checkOut, -nights);
    } else {
      checkIn = resolve(r, today, "arrival");
      if (!checkIn) return { ok: false, reason: "bad_date" };
      checkOut = addDays(checkIn, nights);
    }
  } else {
    const [a, b] = refs;
    // שני תאריכים שסומנו באותו תפקיד ("מ-20/7 מ-23/7") אינם ניתנים
    // להכרעה — ומוטב לשאול שוב מאשר לנחש.
    if (a.role && a.role === b.role) return { ok: false, reason: "ambiguous" };

    // סימן גובר על מיקום; בהיעדר סימן — ראשון הגעה, שני עזיבה.
    const flipped = a.role === "departure" || b.role === "arrival";
    const arrRef  = flipped ? b : a;
    const depRef  = flipped ? a : b;

    checkIn = resolve(arrRef, today, "arrival");
    if (!checkIn) return { ok: false, reason: "bad_date" };
    checkOut = resolve(depRef, checkIn, "departure");
  }

  if (!checkIn || !checkOut) return { ok: false, reason: "bad_date" };

  const n = Math.round((checkOut.getTime() - checkIn.getTime()) / DAY_MS);
  if (n < 1)          return { ok: false, reason: "not_after" };
  if (n > MAX_NIGHTS) return { ok: false, reason: "too_long" };
  // הגעה בעבר — מלבד אתמול, שנשאר קביל (אורח שמאחר בלילה).
  if (checkIn.getTime() < today.getTime() - DAY_MS) return { ok: false, reason: "past" };
  // מספר לילות שנמסר במפורש וסותר את התאריכים ("20/7 - 23/7, 5 לילות")
  // הוא סתירה אמיתית בקלט. לא בוחרים צד — שואלים.
  if (nights != null && nights !== n) return { ok: false, reason: "conflict" };

  return { ok: true, value: { checkIn: asYmd(checkIn), checkOut: asYmd(checkOut), nights: n } };
}

// ── אישור תנאי שהייה ───────────────────────────────────
// דורש נוסח *מפורש*. "כן"/"ok" אינם אישור משפטי לתנאים — מבקשים
// מהאורח לכתוב "אני מאשר" / "I confirm", וזה מה שנשמר על ההזמנה.
const TERMS_VAGUE   = new Set(["כן", "אוקיי", "אוקי", "בסדר", "סבבה", "yes", "yep", "yeah", "ok", "okay", "sure", "y", "👍"]);
const TERMS_DECLINED = new Set(["לא", "לא מאשר", "לא מאשרת", "לא מסכים", "לא מסכימה", "ביטול", "בטל", "no", "nope", "cancel", "i decline", "decline", "disagree"]);

// מילות אישור מפורשות, כמילה בודדת בתוך המשפט.
const TERMS_CONFIRM_WORDS = ["מאשר", "מאשרת", "מאשרים", "מסכים", "מסכימה", "מסכימים",
  "confirm", "confirmed", "agree", "agreed", "accept", "accepted"];
// שלילה שהופכת את המשמעות — נבדקת *לפני* מילות האישור, אחרת
// "אני לא מאשר" היה נקרא כאישור (הוא מכיל "מאשר").
const TERMS_NEGATION = /(^|\s)(לא|איני|אינני|no|not|dont|don t|do not|doesnt|wont|will not|refuse|decline|declined|disagree|cancel)(\s|$)/;

export function validateTermsConfirmation(raw) {
  const t = String(raw ?? "")
    .replace(/['’‘`״׳.!,?]/g, "")
    .replace(/[/\-–—]/g, " ")   // "מאשר/ת" → "מאשר ת"
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!t) return { ok: false, reason: "empty" };

  // 🔴 אישור הוא *משפט*, לא מחרוזת מדויקת. הבדיקה הקודמת דרשה התאמה
  // מלאה לרשימה סגורה, ולכן "אני מאשר את התנאים" — הניסוח הכי טבעי
  // שאורח כותב — נדחה, והצ'ק אין נתקע בדיוק לפני הפיקדון.
  const words = t.split(" ");
  const hasConfirmWord = words.some(w => TERMS_CONFIRM_WORDS.includes(w));

  // שלילה גוברת תמיד על מילת אישור באותו משפט.
  if (TERMS_NEGATION.test(` ${t} `)) return { ok: false, reason: "declined" };
  if (TERMS_DECLINED.has(t))         return { ok: false, reason: "declined" };
  if (hasConfirmWord)                return { ok: true, value: true };
  if (TERMS_VAGUE.has(t))            return { ok: false, reason: "not_explicit" };
  return { ok: false, reason: "unclear" };
}

// ── פרטי צ'ק אין נוספים (אורחים / ETA / רכב / בקשות) ──
// כל השדות *אופציונליים* — האורח יכול לדלג. מטרת השלב: לאסוף בעדינות
// את מה שמלון אמיתי מבקש, בלי לחסום את הצ'ק אין אם משהו חסר. הפרסור
// best-effort: מחלץ מה שאפשר מהודעה חופשית אחת, והשאר → בקשות מיוחדות.

// מילים שמשמעותן "אין לי מה להוסיף / דלג".
const SKIP_WORDS = new Set([
  "דלג", "דלגו", "דלוג", "לדלג", "אין", "איןלי", "לא", "לאצריך", "אחר כך", "בהמשך",
  "skip", "none", "no", "nothing", "later", "n/a", "na", "-", "–", "—", "pass",
]);

export function isSkipWord(raw) {
  const t = String(raw ?? "").replace(/['’‘`״׳.!,?]/g, "").replace(/\s+/g, "").trim().toLowerCase();
  if (!t) return true;
  return SKIP_WORDS.has(t);
}

// שעת הגעה משוערת — מזהה "15:00", "15.00", "3pm", "3 pm", "בסביבות 20:00".
// מחזיר מחרוזת מנורמלת ("15:00" / "3pm") או null.
function extractEta(text) {
  const m24 = text.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  if (m24) return `${m24[1].padStart(2, "0")}:${m24[2]}`;
  const m12 = text.match(/\b(1[0-2]|0?[1-9])\s*([ap])\.?\s*m\.?\b/i);
  if (m12) return `${m12[1]}${m12[2].toLowerCase()}m`;
  return null;
}

// מספר רכב ישראלי — 7–8 ספרות, לרוב עם מקפים (12-345-67 / 123-45-678),
// או ספרות ברצף ליד מילת רכב. מחזיר את המחרוזת כפי שנמסרה, או null.
function extractVehicle(text) {
  const dashed = text.match(/\b\d{2,3}-\d{2,3}-\d{2,3}\b/);
  if (dashed) return dashed[0];
  // רצף 7–8 ספרות רק אם יש הקשר של רכב/חניה — כדי לא לתפוס מספר הזמנה/טלפון.
  if (/\b(רכב|מכונית|רישוי|חניה|חנייה|car|vehicle|plate|licen[cs]e\s*plate|parking)\b/i.test(text)) {
    const run = text.match(/\b(\d[\d-]{5,9}\d)\b/);
    if (run) return run[1];
  }
  return null;
}

// מספר אורחים — "2 אורחים", "שני אנשים", "for 3", "we are 4", או מספר בודד קטן.
function extractGuests(text) {
  const near = text.match(/(\d{1,2})\s*(?:אורחים|אורח|אנשים|נפשות|מבוגרים|סועדים|guests?|people|persons?|adults?|pax)/i);
  if (near) { const n = +near[1]; if (n >= 1 && n <= 20) return n; }
  const phrase = text.match(/(?:אנחנו|נהיה|נהייה|נגיע|נהיו|party of|table of|we\s*(?:are|'?re)|for)\s*(\d{1,2})\b/i);
  if (phrase) { const n = +phrase[1]; if (n >= 1 && n <= 20) return n; }
  const words = { "אחד": 1, "אחת": 1, "יחיד": 1, "שניים": 2, "שני": 2, "שתיים": 2, "זוג": 2,
                  "שלושה": 3, "שלוש": 3, "ארבעה": 4, "ארבע": 4, "חמישה": 5, "חמש": 5,
                  "one": 1, "single": 1, "two": 2, "couple": 2, "three": 3, "four": 4, "five": 5 };
  for (const [w, n] of Object.entries(words)) {
    if (new RegExp(`(?:^|[^A-Za-z֐-׿])${w}(?:[^A-Za-z֐-׿]|$)`, "i").test(text)) return n;
  }
  return null;
}

// מילות מילוי/מפתח שאינן "בקשה מיוחדת" — מסוננות מהשארית כדי שהבקשה
// שתישאר תהיה נקייה ("קומה גבוהה", לא "אנחנו זוג מגיעים … קומה גבוהה").
const DETAILS_FILLER = new Set([
  // הקשר רכב / הגעה
  "רכב", "מכונית", "רישוי", "חניה", "חנייה", "car", "vehicle", "plate", "parking", "eta",
  "הגעה", "נגיע", "נגיעה", "מגיעים", "מגיע", "מגיעה", "arriving", "arrive", "arrival",
  "בסביבות", "בערך", "בשעה", "בשעות", "around", "about", "at",
  // אורחים / מספרים במילים
  "אורחים", "אורח", "אנשים", "נפשות", "מבוגרים", "סועדים", "אנחנו", "we", "are", "re",
  "people", "persons", "person", "adults", "adult", "pax", "guest", "guests", "for",
  "זוג", "שניים", "שתיים", "שני", "יחיד", "אחד", "אחת", "שלושה", "שלוש",
  "ארבעה", "ארבע", "חמישה", "חמש", "couple", "single", "two", "three", "four", "five",
]);

// מפרק הודעת פרטים חופשית לשדות. שום שדה אינו חובה. skipped=true אם
// האורח ביקש לדלג / ההודעה ריקה. requests = מה שנשאר אחרי חילוץ השדות
// המזוהים (אם נותר טקסט משמעותי) — למשל "קומה גבוהה, מיטה זוגית".
export function parseCheckinDetails(raw) {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (isSkipWord(text)) return { guests: null, eta: null, vehicle: null, requests: null, skipped: true };

  const eta     = extractEta(text);
  const vehicle = extractVehicle(text);
  const guests  = extractGuests(text);

  // ── מה שנשאר אחרי חילוץ השדות = הבקשה המיוחדת ──────────
  // ⚠️ \b לא עובד על עברית (מוגדר ל-[A-Za-z0-9_]) — ולכן לא מסתמכים
  //    עליו למחיקת מילים. במקום זה מפצלים לטוקנים ומסננים מילות מילוי,
  //    בצורה שעובדת גם בעברית וגם באנגלית.
  let rest = text;
  for (const hit of [eta, vehicle]) if (hit) rest = rest.split(hit).join(" ");

  const tokens = rest.split(/[\s,.;·|/()-]+/).filter(Boolean);
  const kept = tokens.filter((tk) => {
    const t = tk.toLowerCase();
    if (tk.length <= 1) return false;             // תו בודד (מ"ב-14:30" נשאר "ב")
    if (DETAILS_FILLER.has(t)) return false;      // מילת מילוי/מפתח
    if (/^\d+$/.test(t)) return false;            // מספר בודד (אורחים/שאריות)
    if ((tk.match(/[A-Za-z֐-׿]/g) || []).length === 0) return false; // בלי אותיות
    return true;
  });
  const joined  = kept.join(" ").trim();
  const letters = (joined.match(/[A-Za-z֐-׿]/g) || []).length;
  const requests = letters >= 2 ? joined : null;

  return { guests, eta, vehicle, requests, skipped: false };
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
