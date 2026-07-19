// ════════════════════════════════════════════════════════
//  EMERGENCY — שכבת חירום דטרמיניסטית (לא תלויה ב-AI)
//  ----------------------------------------------------------
//  🔴 חוק ברזל של בטיחות: בחירום אסור *לעולם* להסתמך על ה-AI.
//  ה-AI עלול להיות למטה (רשת/429/timeout), התשובה עלולה להיקטע
//  (max_tokens), והאורח עלול להיות באמצע צ'ק אין — ואז ההודעה שלו
//  בכלל לא מגיעה ל-AI. בכל אחד מהמקרים האלה, אורח שכתב "יש פצוע"
//  היה מקבל שתיקה. שתיקה בחירום = סכנת חיים.
//
//  לכן זיהוי החירום נעשה *כאן*, בקוד, לפני כל דבר אחר: לפני מכונת
//  הצ'ק אין, לפני הצ'ק אאוט, ולפני קריאת ה-AI. אם מזהים חירום —
//  שולחים לאורח מיד הנחיה קבועה (101/102/100), מסלימים לצוות
//  הביטחון (אדם), ומתעדים את האירוע. שום מסלול שלא עובר דרך כאן.
//
//  התג [EMERGENCY:...] של ה-AI נשאר כרשת ביטחון *משנית* לניסוחים
//  עדינים שהמילון כאן לא תפס — אבל הוא כבר לא קו ההגנה היחיד.
// ════════════════════════════════════════════════════════

// גבול "מילה" שעובד גם בעברית (‎\b של JS מוגדר רק ל-[A-Za-z0-9_], ולכן
// לא תופס גבול של מילה עברית). כל תו שאינו אות לטינית/עברית/ספרה = גבול.
const HB = "א-ת";
const B  = `(?:^|[^A-Za-z${HB}0-9])`; // גבול שמאלי
const E  = `(?:$|[^A-Za-z${HB}0-9])`; // גבול ימני

// שתי רמות התאמה, כדי לאזן בין "לא לפספס חירום" ל"לא להיבהל לחינם":
//
// 1. groupStrict — גבולות נוקשים, *בלי* תחיליות. לשמות קצרים/דו-משמעיים
//    (אש, גז, עשן, דם): כאן דווקא *לא* רוצים תחילית, אחרת "מעשן" (אדם
//    שמעשן) נתפס כ"עשן", ו"מאשר" כ"אש". הגבול הנוקשה מונע את זה.
//
// 2. groupPrefixed — מאפשר תחילית עברית של עד שתי אותיות (ו/ה/ב/כ/ל/מ/ש).
//    לשמות ארוכים וייחודיים (פצוע, שריפה, התעלף): כאן חובה לאפשר תחילית,
//    אחרת "שהתעלף"/"בשריפה"/"והפצוע" מתפספסים. אין סיכון ל-false positive
//    כי המילים ארוכות ומובחנות. באנגלית התחילית תמיד 0 (אין אות עברית).
function groupStrict(words) {
  return new RegExp(`${B}(?:${words.join("|")})${E}`, "i");
}
function groupPrefixed(words) {
  return new RegExp(`${B}[והבכלמש]{0,2}(?:${words.join("|")})${E}`, "i");
}

// ── רפואי / פציעה → 101 (מד"א) ─────────────────────────
const MEDICAL_STRICT = groupStrict(["דם"]);
const MEDICAL = groupPrefixed([
  // עברית
  "פצוע", "פצועה", "פצועים", "נפצע", "נפצעה", "נפצעו", "פציעה", "פצע",
  // גוף ראשון/שני — "נפצעתי", "נפצעת" (המקרה שהלקוח ציין במפורש)
  "נפצעתי", "נפצעת", "נחתכתי", "נכוויתי", "נכווית",
  "דימום", "מדמם", "מדממת", "מכה רצינית", "חבלה", "נחבלתי",
  "לא נושם", "לא נושמת", "לא מגיב", "לא מגיבה", "לא בהכרה", "בלי הכרה",
  "מחוסר הכרה", "מחוסרת הכרה", "איבד הכרה", "איבדה הכרה",
  "התעלף", "התעלפה", "עילפון", "מעולף",
  "התקף לב", "התקף", "שבץ", "אירוע מוחי", "פרכוס", "פרכוסים", "עוויתות",
  "נחנק", "נחנקת", "חנק", "נחנקים",
  "טובע", "טובעת", "טובעים", "טביעה",
  "קוצר נשימה", "כאב בחזה", "כאבים בחזה", "לחץ בחזה",
  "אלרגיה", "תגובה אלרגית", "אנפילקטי", "אנפילקסיס",
  "נפל מהמדרגות", "נפלה", "שבר יד", "שבר רגל", "שברתי", "שבר ברגל",
  "אמבולנס", "מדא", 'מד"א', "עזרה רפואית", "חירום רפואי", "הרעלה",
  // English
  "injured", "injury", "bleeding", "bleed", "not breathing",
  "can't breathe", "cant breathe", "unconscious", "unresponsive",
  "passed out", "collapsed", "collapse", "heart attack", "stroke",
  "seizure", "choking", "choke", "drowning", "drown", "anaphyla\\w*",
  "allergic reaction", "chest pain", "ambulance", "overdose", "medical emergency",
]);

// ── אש / גז / עשן → 102 (כבאות) ────────────────────────
const FIRE_STRICT = groupStrict(["אש", "גז", "עשן"]);
const FIRE = groupPrefixed([
  // עברית
  "שריפה", "שריפות", "להבות", "להבה", "בוער", "בוערת", "בוערים",
  "ריח גז", "דליפת גז", "דליפה של גז", "פיצוץ", "התפוצצות",
  // English
  "fire", "burning", "flames", "on fire", "smoke", "gas smell",
  "smell of gas", "smell gas", "gas leak", "explosion",
]);

// ── סכנה / ביטחון / אלימות → 100 (משטרה) ───────────────
const SECURITY_STRICT = groupStrict(["ירי", "יריה", "יריות"]);
const SECURITY = groupPrefixed([
  // עברית
  "סכנה", "מסוכן", "בסכנה", "תקיפה", "תוקף", "מתקיף", "תקפו", "הותקפתי",
  "אלימות", "אלים", "אלימה", "פורץ", "פריצה", "פרצו", "שוד", "נשדד", "שדדו",
  "איום", "מאיים", "איימו", "אונס", "אנס", "דקירה", "דקר", "נדקר",
  "אקדח", "משטרה בבקשה",
  // English
  "emergency", "danger", "dangerous", "attacked", "assault", "intruder",
  "break-in", "breaking in", "robbery", "robbed", "police", "gun",
  "weapon", "threatened", "stabbed", "shooting",
]);

// ── סדר עדיפויות: אש/גז (פינוי) → רפואי → ביטחון ───────
// אם ההודעה נופלת לכמה קטגוריות, בוחרים את המסוכנת ביותר להנחיה
// המובילה — אבל ההודעה לאורח מציגה תמיד את *כל* שלושת המספרים.
export function detectEmergency(text) {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  if (FIRE.test(t)     || FIRE_STRICT.test(t))     return { kind: "fire" };
  if (MEDICAL.test(t)  || MEDICAL_STRICT.test(t))  return { kind: "medical" };
  if (SECURITY.test(t) || SECURITY_STRICT.test(t)) return { kind: "security" };
  return null;
}

// שם הקטגוריה בעברית — להתראת הצוות.
export function emergencyKindHe(kind) {
  return { fire: "אש / גז", medical: "רפואי / פציעה", security: "ביטחון / סכנה" }[kind] || "חירום";
}

// ההנחיה שהאורח מקבל *מיד* — קבועה, ברורה, ובשפת השיחה. שלושה חלקים:
// (1) המספר הרלוונטי למצב, בולט; (2) כל שלושת מספרי החירום תמיד;
// (3) הבהרה שאיננו נותנים הנחיות רפואיות + שהביטחון הוזעק.
export function emergencyGuestMessage(kind, lang = "he") {
  const he = lang !== "en";

  const leadHe = {
    fire:     `🔥 חשוב מאוד — התקשרו *עכשיו ל-102 (כבאות והצלה)*, צאו מהחדר מיד והתרחקו למקום פתוח ובטוח.`,
    medical:  `🚑 חשוב מאוד — התקשרו *עכשיו ל-101 (מד"א)*.`,
    security: `🚓 חשוב מאוד — התקשרו *עכשיו ל-100 (משטרה)*.`,
  }[kind];

  const leadEn = {
    fire:     `🔥 This is important — call *102 (Fire & Rescue) now*, leave the room immediately and move to an open, safe place.`,
    medical:  `🚑 This is important — call *101 (Magen David Adom) now*.`,
    security: `🚓 This is important — call *100 (Police) now*.`,
  }[kind];

  if (he) {
    return (
      `🚨 *זיהיתי מצב חירום — אני כאן איתכם.*\n\n` +
      `${leadHe}\n\n` +
      `מספרי החירום בישראל:\n` +
      `🚑 מד"א — *101* (רפואי / פציעה)\n` +
      `🚒 כבאות — *102* (אש / גז / עשן)\n` +
      `🚓 משטרה — *100*\n\n` +
      `הזעקתי *ברגע זה* את צוות הביטחון של המלון, והם בדרך אליכם.\n\n` +
      `⚠️ איני מוסמך לתת הנחיות רפואיות או עזרה ראשונה — פעלו אך ורק לפי ההנחיות של מוקד החירום.\n` +
      `אני נשאר איתכם כאן — עדכנו אותי בכל שינוי.`
    );
  }

  return (
    `🚨 *I've recognised this is an emergency — I'm right here with you.*\n\n` +
    `${leadEn}\n\n` +
    `Emergency numbers in Israel:\n` +
    `🚑 Magen David Adom — *101* (medical / injury)\n` +
    `🚒 Fire & Rescue — *102* (fire / gas / smoke)\n` +
    `🚓 Police — *100*\n\n` +
    `I've alerted the hotel's security team *right now*, and they are on their way to you.\n\n` +
    `⚠️ I'm not qualified to give medical or first-aid instructions — please follow the emergency dispatcher's guidance only.\n` +
    `I'm staying with you here — tell me if anything changes.`
  );
}

// מספר החירום המרכזי לפי סוג — לשורת ההתראה לצוות.
export function emergencyDial(kind) {
  return { fire: "102 (כבאות)", medical: '101 (מד"א)', security: "100 (משטרה)" }[kind] || "101";
}
