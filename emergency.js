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

// ════════════════════════════════════════════════════════
//  שתי דרגות — דיווח מול שאלה
//  ----------------------------------------------------------
//  נצפה בבדיקה: "Can I smoke on the balcony?" הפעיל פינוי שריפה,
//  "where is the nearest police station" הזעיק את הביטחון, ו-
//  "האם יש אש במטבח הפתוח?" שלח את האורח לצאת מהחדר. אורח ש*שואל*
//  שאלה תמימה אינו מדווח על חירום — וזאב שקורא לשווא גורם לצוות
//  להתעלם מהאמיתי.
//
//  לכן כל קטגוריה מפוצלת לשתיים:
//  • HARD — מילים שאין להן פירוש תמים ("שריפה", "נפצעתי", "unconscious",
//    "stabbed"). מפעילות חירום *תמיד*, גם בתוך שאלה — "Is there a fire?!"
//    חייב להפעיל.
//  • SOFT — מילים דו-משמעיות ("אש", "גז", "smoke", "police", "dangerous",
//    "emergency"). מפעילות רק כשההודעה אינה שאלה אינפורמטיבית.
//
//  ⚠️ כלל בטיחות: בספק — מפעילים. הסינון חל *רק* על הדרגה הרכה, ורק
//  כשההודעה מנוסחת במפורש כשאלה. דיווח ("there is smoke in the hallway")
//  לעולם אינו שאלה ולכן לעולם אינו מסונן.
// ════════════════════════════════════════════════════════
const INQUIRY_STARTER = /^\s*(?:can|could|may|might|should|would|will|is|are|am|do|does|did|where|what|when|how|which|why|who|any|האם|איפה|מתי|כמה|איך|אפשר|מה)\b/i;
const INQUIRY_INSIDE  = /(?:^|[^A-Za-zא-ת])(?:can|could|may|is|are|do|does|where|what|when|how|which|why|who|any|האם|איפה|מתי|כמה|איך|אפשר|מה|יש לכם|יש אצלכם)(?:$|[^A-Za-zא-ת])/i;

// האם ההודעה היא שאלה אינפורמטיבית (ולא דיווח)?
function isInquiry(t) {
  if (INQUIRY_STARTER.test(t)) return true;          // "Can I…" / "האם יש…"
  return t.includes("?") && INQUIRY_INSIDE.test(t);  // "…exit where?"
}

// ── רפואי / פציעה → 101 (מד"א) ─────────────────────────
const MEDICAL_STRICT = groupStrict(["דם"]);
// "יש לי אלרגיה לבוטנים" הוא מידע תזונתי ולא אנפילקסיס — ולכן "אלרגיה"
// לבדה אינה מפעילה חירום בשום דרגה. תגובה אלרגית *ממשית* נתפסת בדרגה
// הקשה ("תגובה אלרגית", "אנפילקטי", "allergic reaction"), וגם התסמינים
// שמלווים אותה ("לא נושם", "נחנק") — כך שאורח בסכנה עדיין מכוסה.
const MEDICAL_SOFT = groupPrefixed(["מכה", "חבלה", "הרעלה"]);
const MEDICAL = groupPrefixed([
  // עברית
  "פצוע", "פצועה", "פצועים", "נפצע", "נפצעה", "נפצעו", "פציעה", "פצע",
  // גוף ראשון/שני — "נפצעתי", "נפצעת" (המקרה שהלקוח ציין במפורש)
  "נפצעתי", "נפצעת", "נחתכתי", "נכוויתי", "נכווית",
  "דימום", "מדמם", "מדממת", "מכה רצינית", "חבלה", "נחבלתי",
  "לא נושם", "לא נושמת", "לא מגיב", "לא מגיבה", "לא בהכרה", "בלי הכרה",
  "מחוסר הכרה", "מחוסרת הכרה", "איבד הכרה", "איבדה הכרה",
  // גוף ראשון/שלישי מלא: ‎E חוסם סיומת, ולכן "התעלפתי" לא נתפס ע"י "התעלף".
  "התעלף", "התעלפה", "התעלפתי", "עילפון", "מעולף",
  "התמוטט", "התמוטטה", "התמוטטתי", "התמוטטו", "קרס", "קרסה",
  "התקף לב", "התקף", "שבץ", "אירוע מוחי", "פרכוס", "פרכוסים", "עוויתות",
  "נחנק", "נחנקת", "חנק", "נחנקים",
  "טובע", "טובעת", "טובעים", "טביעה",
  "קוצר נשימה", "כאב בחזה", "כאבים בחזה", "לחץ בחזה",
  "תגובה אלרגית", "אלרגית", "אנפילקטי", "אנפילקסיס",
  "נפל מהמדרגות", "נפלה", "שבר יד", "שבר רגל", "שברתי", "שבר ברגל",
  "אמבולנס", "מדא", 'מד"א', "עזרה רפואית", "חירום רפואי",
  // English
  "injured", "injury", "bleeding", "bleed", "not breathing",
  "can't breathe", "cant breathe", "unconscious", "unresponsive",
  "passed out", "collapsed", "collapse", "heart attack", "stroke",
  "seizure", "choking", "choke", "drowning", "drown", "anaphyla\\w*",
  "allergic reaction", "chest pain", "ambulance", "overdose", "medical emergency",
]);

// ── אש / גז / עשן → 102 (כבאות) ────────────────────────
// דרגה רכה: "אש"/"גז"/"עשן"/"smoke" — קיימות גם בשאלות תמימות
// ("מטבח על האש", "חדר מעשנים", "can I smoke").
const FIRE_STRICT = groupStrict(["אש", "גז", "עשן"]);
// "smoking" לא נכלל: הוא כמעט תמיד "smoking room/area" ולא דיווח על עשן.
const FIRE_SOFT   = groupPrefixed(["smoke", "burning"]);
const FIRE = groupPrefixed([
  // עברית
  "שריפה", "שריפות", "להבות", "להבה", "בוער", "בוערת", "בוערים",
  "ריח גז", "דליפת גז", "דליפה של גז", "פיצוץ", "התפוצצות",
  // English
  "fire", "flames", "on fire", "gas smell",
  "smell of gas", "smell gas", "gas leak", "explosion",
]);

// ── סכנה / ביטחון / אלימות → 100 (משטרה) ───────────────
const SECURITY_STRICT = groupStrict(["ירי", "יריה", "יריות"]);
// דרגה רכה: "משטרה"/"police"/"emergency"/"סכנה"/"dangerous"/"אקדח" —
// כולן מופיעות בשאלות תמימות ("איפה יציאת החירום?", "is the beach
// dangerous?", "where is the nearest police station").
const SECURITY_SOFT = groupPrefixed([
  "סכנה", "מסוכן", "בסכנה", "איום", "מאיים", "איימו", "אקדח", "משטרה",
  "emergency", "danger", "dangerous", "police", "gun", "weapon", "threatened",
  // צרחות / קריאות לעזרה מהחדר הסמוך — הביטחון בודק (לא לעמת) (Part 5)
  "צרחות", "צווחות", "צורח", "צורחת", "צעקות אימה", "מישהו צורח",
  "screaming", "screams", "cry for help", "cries for help",
]);

// ── אזעקת טילים → מרחב מוגן (פיקוד העורף) — Part 4 ──────
// 🔴 קטגוריה נפרדת: אזעקה אינה "פציעה" — התגובה הנכונה היא *מרחב מוגן*,
//    לא "התקשרו ל-101". מפעילה *תמיד* (זמן-קריטי, 90 שניות ברוב הארץ),
//    גם בתוך שאלה. מונחית ע"פ הנחיות פיקוד העורף שנבדקו. "אזעקת אש"
//    מסוננת דרך guard מול מילות אש (detectEmergency).
const ROCKET = groupPrefixed([
  // עברית
  "צבע אדום", "אזעקה", "אזעקות", "טיל", "טילים", "רקטה", "רקטות",
  "יירוט", "פיקוד העורף", "מרחב מוגן", "מקלט",
  // English + תעתיק לתייר
  "missile", "missiles", "rocket attack", "red alert", "air raid",
  "azaka", "azake", "azaa", "code red",
]);
const SECURITY = groupPrefixed([
  // עברית
  "תקיפה", "תוקף", "מתקיף", "תקפו", "הותקפתי",
  "אלימות", "אלים", "אלימה", "פורץ", "פריצה", "פרצו",
  "שוד", "נשדד", "נשדדתי", "נשדדנו", "שדדו", "שודדים",
  "אונס", "אנס", "דקירה", "דקר", "נדקר", "נדקרתי", "משטרה בבקשה",
  // English
  "attacked", "attacking", "assault", "intruder",
  "break-in", "breaking in", "broke into", "broke in",
  "robbery", "robbed", "stabbed", "shooting", "someone in my room",
]);

// ── סדר עדיפויות: אש/גז (פינוי) → רפואי → ביטחון ───────
// אם ההודעה נופלת לכמה קטגוריות, בוחרים את המסוכנת ביותר להנחיה
// המובילה — אבל ההודעה לאורח מציגה תמיד את *כל* שלושת המספרים.
export function detectEmergency(text) {
  const t = String(text ?? "");
  if (!t.trim()) return null;

  // דרגה קשה — מפעילה תמיד, גם בתוך שאלה ("Is there a fire?!").
  if (FIRE.test(t))     return { kind: "fire" };
  // אזעקת טילים — מפעילה תמיד (זמן-קריטי). guard: "אזעקת אש" → אש, לא טיל.
  if (ROCKET.test(t) && !FIRE_STRICT.test(t) && !/אזעקת\s*אש|fire\s*alarm/i.test(t)) return { kind: "rocket" };
  if (MEDICAL.test(t))  return { kind: "medical" };
  if (SECURITY.test(t)) return { kind: "security" };

  // דרגה רכה — מדלגים רק כשההודעה היא שאלה אינפורמטיבית מפורשת.
  if (isInquiry(t)) return null;

  if (FIRE_SOFT.test(t)     || FIRE_STRICT.test(t))     return { kind: "fire" };
  if (MEDICAL_SOFT.test(t)  || MEDICAL_STRICT.test(t))  return { kind: "medical" };
  if (SECURITY_SOFT.test(t) || SECURITY_STRICT.test(t)) return { kind: "security" };
  return null;
}

// שם הקטגוריה בעברית — להתראת הצוות.
export function emergencyKindHe(kind) {
  return { fire: "אש / גז", medical: "רפואי / פציעה", security: "ביטחון / סכנה", rocket: "אזעקת טילים" }[kind] || "חירום";
}

// ההנחיה שהאורח מקבל *מיד* — קבועה, ברורה, ובשפת השיחה. שלושה חלקים:
// (1) המספר הרלוונטי למצב, בולט; (2) כל שלושת מספרי החירום תמיד;
// (3) הבהרה שאיננו נותנים הנחיות רפואיות + שהביטחון הוזעק.
// locationKnown=false → מוסיפים בקשת מיקום. בלי מספר חדר צוות הביטחון
// לא יודע לאן לרוץ, וההבטחה "הם בדרך אליכם" הופכת לחסרת משמעות. הבקשה
// מגיעה *אחרי* מספרי החירום, כדי שלא תעכב את הפעולה החשובה באמת.
// onSiteTeam — האם יש צוות ביטחון/מנהל תורן *במקום* (מלון מלא) או לא
//   (מלון בוטיק לא-מאויש). זה משנה הבטחה קריטית לאורח: "הצוות בדרך אליכם"
//   נכון רק כשיש צוות במקום. במלון בלי צוות — אסור להבטיח מישהו בדרך;
//   מדגישים שהגורם המקצועי הוא שירותי החירום (101/102/100), ומעדכנים
//   מנהל תורן מרחוק. הבטחה שגויה בחירום גרועה משתיקה.
// ── הנחיית אזעקת טילים — מרחב מוגן (פיקוד העורף) — Part 4 ──
// 🔴 מצילת חיים. ההנחיה נבנית מהנתונים הרשמיים של פיקוד העורף:
//   • להיכנס למרחב מוגן ולהישאר 10 דקות.
//   • היררכיה: ממ"ד → ממ"ק בקומה → מקלט → חדר מדרגות פנימי → חדר פנימי
//     ללא חלונות, הרחק מזכוכית. לסגור דלת וחלונות.
//   • בלי מרחב מוגן — לשכב על הרצפה ולכסות את הראש.
//   • לא להשתמש במעלית.
// shelterLocation/shelterTime הם *פר-מלון* (config.safety.shelter_*),
// ובהיעדרם נופלים להיררכיה הגנרית. הרוב בישראל = כ-90 שניות.
function rocketGuestMessage(lang, { shelterLocation = null, shelterTime = null } = {}) {
  const he = lang !== "en";
  if (he) {
    const where = shelterLocation
      ? `📍 *המרחב המוגן הקרוב:* ${shelterLocation}`
      : `📍 *לאן ללכת (לפי הזמין):* ממ"ד בחדר, אם יש → המרחב המוגן/ממ"ק בקומה → מקלט → חדר מדרגות פנימי (הרחק מחלונות) → החדר הפנימי ביותר, הרחק מזכוכית.`;
    const time = shelterTime || "כ-90 שניות (ברוב הארץ)";
    return (
      `🚨 *אזעקה — יש להיכנס עכשיו למרחב מוגן.* אני איתך.\n\n` +
      `${where}\n` +
      `⏱️ יש לך *${time}* להגיע. *אל תשתמש במעלית* — במדרגות בלבד.\n\n` +
      `בפנים: סגור את הדלת ואת החלונות, התרחק מזכוכית.\n` +
      `אם אין מרחב מוגן בהישג יד — *שכב על הרצפה, פנים למטה, וכסה את הראש בידיים.*\n\n` +
      `⏳ *להישאר במרחב המוגן 10 דקות* מרגע האזעקה.\n` +
      `📞 מידע נוסף: פיקוד העורף *104* (או אפליקציית פיקוד העורף).\n` +
      `אני כאן — עדכן אותי כשאתה בטוח.`
    );
  }
  const where = shelterLocation
    ? `📍 *Nearest protected space:* ${shelterLocation}`
    : `📍 *Where to go (best available):* the safe room (Mamad) in your room if there is one → the floor's protected space (Mamak) → the shelter (Miklat) → an interior stairwell away from windows → the most interior room, away from glass.`;
  const time = shelterTime || "about 90 seconds (most of the country)";
  return (
    `🚨 *Rocket siren — go to a protected space NOW.* I'm with you.\n\n` +
    `${where}\n` +
    `⏱️ You have *${time}* to get there. *Do NOT use the lift* — take the stairs.\n\n` +
    `Inside: close the door and windows, stay away from glass.\n` +
    `If no protected space is reachable in time — *lie down on the ground, face down, and cover your head with your hands.*\n\n` +
    `⏳ *Stay in the protected space for 10 minutes* from the start of the siren.\n` +
    `📞 More info: Home Front Command *104* (or the Home Front Command app).\n` +
    `I'm here — tell me when you're safe.`
  );
}

export function emergencyGuestMessage(kind, lang = "he", { locationKnown = true, onSiteTeam = true, shelterLocation = null, shelterTime = null } = {}) {
  // אזעקת טילים — הנחיית מרחב מוגן ייעודית (לא "התקשרו ל-101").
  if (kind === "rocket") return rocketGuestMessage(lang, { shelterLocation, shelterTime });
  const he = lang !== "en";

  const askLocationHe = locationKnown ? "" :
    `\n📍 *איפה אתם נמצאים עכשיו?* מספר חדר, קומה או אזור במלון — כדי שהצוות יגיע ישירות אליכם.\n`;
  const askLocationEn = locationKnown ? "" :
    `\n📍 *Where are you right now?* Room number, floor, or area of the hotel — so the team can reach you directly.\n`;

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

  // שורת ההסלמה — נכונה לסוג המלון. מלון מלא: צוות במקום בדרך. בוטיק
  // לא-מאויש: מנהל תורן מרחוק עודכן, והדגש על שירותי החירום כגורם המטפל.
  const escalationHe = onSiteTeam
    ? `הזעקתי *ברגע זה* את צוות הביטחון של המלון, והם בדרך אליכם.`
    : `עדכנתי *ברגע זה* את המנהל התורן של המלון, שיצור קשר וייתן מענה. הגורם המקצועי שיטפל בכם הוא שירותי החירום — התקשרו אליהם *עכשיו*.`;
  const escalationEn = onSiteTeam
    ? `I've alerted the hotel's security team *right now*, and they are on their way to you.`
    : `I've notified the hotel's duty manager *right now*, who will be in touch. The professionals who will help you are the emergency services — please call them *now*.`;

  if (he) {
    return (
      `🚨 *זיהיתי מצב חירום — אני כאן איתכם.*\n\n` +
      `${leadHe}\n\n` +
      `מספרי החירום בישראל:\n` +
      `🚑 מד"א — *101* (רפואי / פציעה)\n` +
      `🚒 כבאות — *102* (אש / גז / עשן)\n` +
      `🚓 משטרה — *100*\n\n` +
      `${escalationHe}\n` +
      askLocationHe + `\n` +
      `⚠️ אין לי הסמכה לתת הנחיות רפואיות או עזרה ראשונה — פעלו אך ורק לפי ההנחיות של מוקד החירום.\n` +
      `אני כאן איתכם — עדכנו אותי בכל שינוי.`
    );
  }

  return (
    `🚨 *I've recognised this is an emergency — I'm right here with you.*\n\n` +
    `${leadEn}\n\n` +
    `Emergency numbers in Israel:\n` +
    `🚑 Magen David Adom — *101* (medical / injury)\n` +
    `🚒 Fire & Rescue — *102* (fire / gas / smoke)\n` +
    `🚓 Police — *100*\n\n` +
    `${escalationEn}\n` +
    askLocationEn + `\n` +
    `⚠️ I'm not qualified to give medical or first-aid instructions — please follow the emergency dispatcher's guidance only.\n` +
    `I'm staying with you here — tell me if anything changes.`
  );
}

// מספר החירום המרכזי לפי סוג — לשורת ההתראה לצוות.
export function emergencyDial(kind) {
  return { fire: "102 (כבאות)", medical: '101 (מד"א)', security: "100 (משטרה)", rocket: "104 (פיקוד העורף)" }[kind] || "101";
}
