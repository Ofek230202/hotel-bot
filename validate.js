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

// שם מלא: טקסט הגיוני — אותיות, לפחות שתי מילים, בלי ספרות/סימנים מוזרים.
// מחזיר { ok, value } או { ok:false, reason }.
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
