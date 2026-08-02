// ════════════════════════════════════════════════════════
//  STRESS — עומס קיצוני: מיליון הודעות, מאות מלונות
//  ----------------------------------------------------------
//  ── מה כאן אמיתי ומה מדומה — לקרוא לפני שמאמינים למספרים ──
//
//  ✅ **אמיתי לגמרי:** כל שאר המערכת. פתרון הטננט מהמספר הנכנס, הנעילה
//     per-guest, קריאה/כתיבה של הסשן, מסד הנתונים, ה-cache והפינוי,
//     בידוד המלונות, ניתוב המחלקות, ומגבלות הזיכרון. אלה בדיוק המסלולים
//     שנשברים תחת עומס, וכאן הם רצים באמת, מיליון פעם.
//
//  🔬 **מדומה: קריאת ה-AI בלבד.** מיליון קריאות אמיתיות ל-Anthropic הן
//     בלתי אפשריות (עלות, מכסה, שעות), ולא היו בודקות את *הקוד שלנו*
//     אלא את השרת של Anthropic. במקומן יש מודל מזויף **דטרמיניסטי**
//     שמחזיר תשובה הנושאת את החתימה של אותו אורח ואותו נושא — וזה מה
//     שמאפשר לוודא שכל אורח קיבל את **התשובה שלו** ולא של מישהו אחר.
//     איכות הניסוח נבדקת בנפרד מול Claude אמיתי (`npm run voice`,
//     `npm run preflight`), ושם היא נבדקת לעומק.
//
//  🔬 **מדומה: שליחת הוואטסאפ.** אין שליחה לרשת; ההודעות נלכדות ונבדקות.
//
//  ── מה נבדק ─────────────────────────────────────────────
//   A. מיליון הודעות · מאות מלונות · כל אורח בנושא אחר.
//      אין קריסה · כל אורח קיבל את תשובתו שלו · אפס ערבוב בין אורחים ·
//      אפס דליפה בין מלונות · הזיכרון נשאר חסום.
//   B. מעבר עברית↔אנגלית תחת עומס — השפה נקבעת נכון ולא מתערבבת.
//   C. עומס מסד נתונים — קריאות/כתיבות בנפח, כולל אחרי פינוי cache.
//
//  הרצה:  node --experimental-test-module-mocks stress.mjs [messages] [hotels]
//         ברירת מחדל: 1,000,000 הודעות ב-200 מלונות.
//         להרצה מהירה:  node ... stress.mjs 50000 50
// ════════════════════════════════════════════════════════
import { mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TOTAL  = Number(process.argv[2]) || 1_000_000;
const HOTELS = Number(process.argv[3]) || 200;

process.env.DB_PATH                = path.join(os.tmpdir(), `hotel-stress-${process.pid}.db`);
process.env.TWILIO_ACCOUNT_SID     = "ACstress";
process.env.TWILIO_AUTH_TOKEN      = "stress";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+15550000000";
process.env.ANTHROPIC_API_KEY      = "sk-stress";
process.env.BASE_URL               = "https://stress.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);
process.env.GUEST_BURST            = "10000000";   // בלימת הקצב אינה הנושא כאן
// cache קטן במכוון ביחס לנפח — כך הפינוי קורה **בוודאות** והבדיקה
// מוכיחה שהמערכת עובדת גם אחרי שהזיכרון התמלא והתרוקן.
process.env.SESSION_CACHE_MAX      = "20000";
process.env.CONFIG_CACHE_MAX       = "500";
process.env.PROVIDER_CACHE_MAX     = "500";

const C = { dim: "\x1b[2m", b: "\x1b[1m", r: "\x1b[0m", gr: "\x1b[32m", ye: "\x1b[33m", re: "\x1b[31m", cy: "\x1b[36m" };

// ── השתקת הלוג התפעולי ──────────────────────────────────
// 🔴 בלי זה אנחנו מודדים את stdout ולא את המערכת: `wa()` מדפיס שורה לכל
//    הודעה יוצאת, כלומר מיליון שורות (מאות MB) שנכתבות לצינור — וזה הפך
//    להיות **צוואר הבקבוק היחיד** (נמדד: 105 הודעות/שנייה עם לוג).
//    שגיאות ואזהרות נשארות, כי הן בדיוק מה שהבדיקה מחפשת.
const realLog = console.log;
const quiet   = () => { console.log = () => {}; };
const loud    = () => { console.log = realLog; };
let  warnCount = 0, errCount = 0;
const realWarn = console.warn, realErr = console.error;
console.warn  = (...a) => { warnCount++; if (warnCount <= 5) realWarn(...a); };
console.error = (...a) => { errCount++;  if (errCount  <= 5) realErr(...a);  };

// ── מודל מזויף דטרמיניסטי ───────────────────────────────
// מחזיר תשובה שנושאת את **חתימת האורח והנושא**. אם אורח יקבל תשובה של
// אורח אחר — החתימה לא תתאים, וזה בדיוק מה שנתפס.
let aiCalls = 0;
mock.module("@anthropic-ai/sdk", {
  exports: { default: class FakeAnthropic {
    constructor() {
      this.messages = {
        create: async ({ messages, system }) => {
          aiCalls++;
          const last = [...(messages || [])].reverse()
            .find(m => m.role === "user" && typeof m.content === "string");
          const body = String(last?.content || "");
          const sig  = (body.match(/#([A-Z0-9]+)#/) || [])[1] || "NONE";
          // 🔴 השפה נקבעת מ-**ה-system prompt**, בדיוק כמו שהמודל האמיתי
          //    עושה — ולא מניחוש לפי תווי הטקסט של האורח.
          //    למה זה חשוב: `stripLanguageRequest` מסיר את בקשת המעבר
          //    מההודעה, כך ש"דבר איתי בעברית בבקשה" מגיע למודל כמחרוזת
          //    בלי אף אות עברית. מודל מזויף שמנחש לפי התווים היה עונה
          //    אנגלית ומדווח על "באג" שאינו קיים במוצר.
          const he = !/CONVERSATION LANGUAGE: \*English\*/.test(String(system || ""));
          return {
            content: [{
              type: "text",
              text: he
                ? `בשמחה. סימוכין #${sig}# — אשמח לעזור בכל דבר נוסף.`
                : `Certainly. Reference #${sig}# — I'm glad to help with anything else.`,
            }],
            stop_reason: "end_turn",
          };
        },
      };
    }
  } },
});

// ── לוכדים את ההודעות היוצאות בנקודת השליחה עצמה ────────
// זו הנקודה הנכונה: כל מה שלפניה (ניסוח, בחירת שפה, בחירת המספר היוצא)
// רץ באמת. שומרים רק חתימה ושפה, ולא את הטקסט המלא — מיליון מחרוזות היו
// מפוצצות את זיכרון **הבדיקה**, ואז היינו מודדים את הבדיקה ולא את המוצר.
const replies = new Map();   // phone → { sig, lang, from }
let sent = 0, empty = 0;

mock.module("twilio", {
  exports: {
    default: () => ({
      messages: {
        create: async ({ to, body, from }) => {
          if (!body || !String(body).trim()) { empty++; return { sid: "SM" }; }
          sent++;
          const sig = (String(body).match(/#([A-Z0-9]+)#/) || [])[1] || null;
          const he  = /[֐-׿]/.test(String(body));
          if (sig) replies.set(to, { sig, lang: he ? "he" : "en", from });
          return { sid: "SM" };
        },
      },
    }),
  },
});

const { email } = await import("./email/index.js");
email.send = async () => ({ success: true });

const bot     = await import("./bot.js");
const tenant  = await import("./tenant.js");
const state   = await import("./state.js");
const config  = await import("./config.js");

// ── הקמת המלונות ────────────────────────────────────────
function hotelId(i) { return `stress_h${i}`; }
function hotelNumber(i) { return `+1555${String(1_000_000 + i).slice(-7)}`; }

console.log(`\n${C.ye}${C.b}${"═".repeat(66)}\n  🔥 בדיקת עומס קיצונית — ${TOTAL.toLocaleString()} הודעות · ${HOTELS} מלונות\n${"═".repeat(66)}${C.r}`);
console.log(`${C.dim}   ✅ אמיתי: טננט · נעילות · סשנים · DB · cache · בידוד`);
console.log(`   🔬 מדומה: קריאת ה-AI ושליחת הוואטסאפ בלבד${C.r}\n`);

process.stdout.write(`${C.dim}   מקים ${HOTELS} מלונות…${C.r}`);
for (let i = 0; i < HOTELS; i++) {
  const id = hotelId(i);
  config.updateConfigFor(id, {
    name: `Stress Hotel ${i}`, name_he: `מלון עומס ${i}`,
    hotel_type: i % 2 ? "boutique" : "full_service",
    location: { lat: 32 + i / 1000, lng: 34 + i / 1000, city: `City${i}`, timezone: "Asia/Jerusalem" },
    reception_number: `+972500${String(100000 + i).slice(-6)}`,
    reception_email: `reception@h${i}.test`,
    security_number: `+972501${String(100000 + i).slice(-6)}`,
    security_email: `security@h${i}.test`,
    housekeeping_number: `+972502${String(100000 + i).slice(-6)}`,
    housekeeping_email: `hk@h${i}.test`,
    maintenance_number: `+972503${String(100000 + i).slice(-6)}`,
    maintenance_email: `mt@h${i}.test`,
    concierge_number: `+972504${String(100000 + i).slice(-6)}`,
    concierge_email: `cx@h${i}.test`,
    room_service_number: `+972505${String(100000 + i).slice(-6)}`,
    room_service_email: `rs@h${i}.test`,
    business: { name: `Stress ${i} Ltd`, id: `51${String(4000000 + i).slice(-7)}` },
  });
  tenant.registerHotelNumber(hotelNumber(i), id);
}
tenant.reloadHotelNumbers();
console.log(` ${C.gr}✓${C.r}`);

// ── נושאים — כל אורח שואל משהו אחר ──────────────────────
const TOPICS_HE = [
  "מה שעות הבריכה", "אפשר מגבות נוספות", "המזגן לא עובד", "אשמח להמליץ על מסעדה",
  "מה סיסמת הוויפיי", "אפשר להזמין מונית", "מתי הצ'ק אאוט", "יש חדר כושר",
  "אפשר ארוחת בוקר בחדר", "איפה החניה", "אפשר לאחר את העזיבה", "יש שירות כביסה",
];
const TOPICS_EN = [
  "what are the pool hours", "may I have extra towels", "the air conditioning is not working",
  "can you recommend a restaurant", "what is the wifi password", "can I book a taxi",
  "when is check-out", "is there a gym", "can I have breakfast in the room",
  "where is the parking", "may I have a late check-out", "is there a laundry service",
];

const sigOf = i => i.toString(36).toUpperCase();

// ── מונה תוצאות ─────────────────────────────────────────
const bad = {
  crashed: 0, noReply: 0, wrongSig: 0, wrongHotel: 0, wrongLang: 0,
};
const samples = [];

function record(phone, expectSig, expectFrom, expectLang) {
  const got = replies.get(phone);
  if (!got) { bad.noReply++; if (samples.length < 5) samples.push(`אין תשובה: ${phone}`); return; }
  // 🔴 הבדיקה המרכזית: החתימה בתשובה היא של **האורח הזה**. חתימה זרה
  //    פירושה שתשובה של אורח אחד הגיעה לאורח אחר — הכשל הגרוע ביותר
  //    שיכול לקרות תחת עומס.
  if (got.sig !== expectSig) {
    bad.wrongSig++;
    if (samples.length < 5) samples.push(`חתימה זרה: ${phone} ציפה ${expectSig} קיבל ${got.sig}`);
    return;
  }
  // התשובה יצאה מהמספר של המלון שאליו האורח כתב.
  if (expectFrom && got.from && !String(got.from).includes(expectFrom.replace("+", ""))) {
    bad.wrongHotel++;
    if (samples.length < 5) samples.push(`מספר יוצא שגוי: ${got.from} במקום ${expectFrom}`);
    return;
  }
  if (expectLang && got.lang !== expectLang) {
    bad.wrongLang++;
    if (samples.length < 5) samples.push(`שפה: ${phone} ציפה ${expectLang} קיבל ${got.lang}`);
  }
}

// ── מריץ בגלים, עם תקרת מקביליות ────────────────────────
// אין יצירת מיליון promises בבת אחת: זו הייתה קריסת זיכרון של הבדיקה,
// לא של המוצר. גל בגודל קבוע, כמו תעבורה אמיתית.
const WAVE = 2_000;

async function runWave(from, to) {
  const jobs = [];
  for (let i = from; i < to; i++) {
    const h      = i % HOTELS;
    const hid    = hotelId(h);
    const phone  = `whatsapp:+9727${String(1_000_000 + i).slice(-7)}`;
    const heb    = i % 2 === 0;
    const topic  = heb ? TOPICS_HE[i % TOPICS_HE.length] : TOPICS_EN[i % TOPICS_EN.length];
    const sig    = sigOf(i);
    const text   = `${topic} #${sig}#`;

    void hid;
    jobs.push(
      bot.handleIncoming(phone, text, null, { to: `whatsapp:${hotelNumber(h)}` })
        .then(() => record(phone, sig, hotelNumber(h), heb ? "he" : "en"))
        .catch(e => {
          bad.crashed++;
          if (samples.length < 5) samples.push(`קריסה: ${e?.message || e}`);
        })
    );
  }
  await Promise.all(jobs);
}

// ── ריצה ────────────────────────────────────────────────
const t0 = Date.now();
let done = 0;
const bar = () => {
  const pct = Math.round((done / TOTAL) * 100);
  const rate = Math.round(done / Math.max(0.001, (Date.now() - t0) / 1000));
  const mem = Math.round(process.memoryUsage().heapUsed / 1048576);
  process.stdout.write(`\r${C.dim}   ${String(pct).padStart(3)}% · ${done.toLocaleString()}/${TOTAL.toLocaleString()} · ${rate.toLocaleString()}/שנייה · זיכרון ${mem}MB · cache ${state.sessionCache.size.toLocaleString()}   ${C.r}`);
};

quiet();
for (let start = 0; start < TOTAL; start += WAVE) {
  await runWave(start, Math.min(start + WAVE, TOTAL));
  done = Math.min(start + WAVE, TOTAL);
  if (done % (WAVE * 10) === 0 || done === TOTAL) { loud(); bar(); quiet(); }
  // משחררים את הלולאה כדי שה-GC יספיק לעבוד — אחרת מדדנו את הבדיקה.
  // `replies` מתרוקן אחרי שכל גל כבר אומת (record רץ בתוך runWave).
  if (done % (WAVE * 25) === 0) { replies.clear(); await new Promise(r => setImmediate(r)); }
}
loud();
bar();
const secs = (Date.now() - t0) / 1000;

console.log(`\n`);
console.log(`${C.b}── תוצאות ──${C.r}`);
console.log(`   הודעות שעובדו : ${C.b}${TOTAL.toLocaleString()}${C.r} ב-${secs.toFixed(1)} שניות (${Math.round(TOTAL / secs).toLocaleString()}/שנייה)`);
console.log(`   קריאות למודל  : ${aiCalls.toLocaleString()}`);
console.log(`   זיכרון בשיא   : ${Math.round(process.memoryUsage().heapUsed / 1048576)}MB · cache סשנים ${state.sessionCache.size.toLocaleString()}`);

let failures = 0;
const check = (ok, good, badMsg) => {
  console.log(ok ? `   ${C.gr}✅ ${good}${C.r}` : `   ${C.re}❌ ${badMsg}${C.r}`);
  if (!ok) failures++;
};

check(bad.crashed === 0,    "אף הודעה לא הפילה את התהליך", `${bad.crashed} קריסות`);
// 🔴 הבדיקה הזו נשכחה בגרסה הראשונה של הכלי: `noReply` נספר אך לא נבדק,
//    והכלי הכריז "אפס כשלים" בזמן ששני אורחים לא קיבלו תשובה כלל.
//    כלי בדיקה ששותק על כשל גרוע מכלי שלא קיים.
check(bad.noReply === 0,    "כל אורח קיבל תשובה", `${bad.noReply} אורחים לא קיבלו תשובה`);
check(bad.wrongSig === 0,   "אף אורח לא קיבל תשובה של אורח אחר", `${bad.wrongSig} תשובות התחלפו בין אורחים`);
check(bad.wrongHotel === 0, "אף תשובה לא יצאה מהמלון הלא נכון", `${bad.wrongHotel} תשובות מהמלון הלא נכון`);
check(empty === 0,          "לא נשלחה אף הודעה ריקה", `${empty} הודעות ריקות`);
check(state.sessionCache.size <= Number(process.env.SESSION_CACHE_MAX),
  `הזיכרון נשאר חסום (${state.sessionCache.size.toLocaleString()} ≤ ${Number(process.env.SESSION_CACHE_MAX).toLocaleString()})`,
  `ה-cache חרג: ${state.sessionCache.size}`);
check(bad.wrongLang === 0,
  "כל אורח נענה בשפה שבה כתב",
  `${bad.wrongLang} תשובות בשפה הלא נכונה`);

// ════════════════════════════════════════════════════════
//  B. מעבר עברית↔אנגלית — באמצע שיחה, תחת עומס
// ════════════════════════════════════════════════════════
// 🔴 זה לא "עוד בדיקת שפה": מעבר שפה הוא **מצב על הסשן**, ולכן הוא
//    בדיוק סוג הדבר שנשבר כשהרבה אורחים רצים במקביל — או שדולף בין
//    אורחים. כאן כל אורח מחליף שפה פעמיים, וכולם בו-זמנית.
console.log(`\n${C.b}── מעבר שפה תחת עומס ──${C.r}`);
const LANG_GUESTS = Math.min(4_000, Math.max(500, Math.floor(TOTAL / 50)));
const langBad = { wrong: 0, missing: 0 };

quiet();
{
  const jobs = [];
  for (let i = 0; i < LANG_GUESTS; i++) {
    const h     = i % HOTELS;
    const phone = `whatsapp:+9728${String(1_000_000 + i).slice(-7)}`;
    const to    = `whatsapp:${hotelNumber(h)}`;
    const startHe = i % 2 === 0;

    jobs.push((async () => {
      // 1) פתיחה בשפה א'
      const s1 = `L${i.toString(36).toUpperCase()}A`;
      await bot.handleIncoming(phone, startHe ? `מה שעות הבריכה #${s1}#` : `what are the pool hours #${s1}#`, null, { to });
      const r1 = replies.get(phone);
      if (!r1) { langBad.missing++; return; }
      if (r1.lang !== (startHe ? "he" : "en")) { langBad.wrong++; return; }

      // 2) בקשת מעבר מפורשת לשפה ב'
      const s2 = `L${i.toString(36).toUpperCase()}B`;
      await bot.handleIncoming(phone, startHe ? `speak english please #${s2}#` : `דבר איתי בעברית בבקשה #${s2}#`, null, { to });
      const r2 = replies.get(phone);
      if (!r2) { langBad.missing++; return; }
      if (r2.lang !== (startHe ? "en" : "he")) { langBad.wrong++; return; }

      // 3) הודעה נוספת — השפה החדשה **נשמרת** ולא חוזרת אחורה
      const s3 = `L${i.toString(36).toUpperCase()}C`;
      await bot.handleIncoming(phone, startHe ? `is there a gym #${s3}#` : `יש חדר כושר #${s3}#`, null, { to });
      const r3 = replies.get(phone);
      if (!r3) { langBad.missing++; return; }
      if (r3.lang !== (startHe ? "en" : "he")) { langBad.wrong++; }
    })().catch(() => { langBad.missing++; }));
  }
  await Promise.all(jobs);
}
loud();

console.log(`   אורחים שהחליפו שפה : ${C.b}${LANG_GUESTS.toLocaleString()}${C.r} ${C.dim}(3 הודעות כל אחד)${C.r}`);
check(langBad.wrong === 0,
  "מעבר עברית↔אנגלית נשמר נכון בכל האורחים",
  `${langBad.wrong} אורחים קיבלו את השפה הלא נכונה אחרי מעבר`);
check(langBad.missing === 0,
  "אף אורח לא נשאר בלי תשובה במהלך מעבר השפה",
  `${langBad.missing} תשובות חסרות`);

// ── עומס מסד הנתונים ────────────────────────────────────
console.log(`\n${C.b}── מסד הנתונים ──${C.r}`);
const dbT0 = Date.now();
const total = await state.sessionCountAsync();
const dbMs  = Date.now() - dbT0;
console.log(`   סשנים ב-DB    : ${C.b}${total.toLocaleString()}${C.r} ${C.dim}(ספירה ב-${dbMs}ms)${C.r}`);
check(total >= TOTAL * 0.99,
  `כל הסשנים נשמרו (${total.toLocaleString()})`,
  `נשמרו ${total.toLocaleString()} מתוך ${TOTAL.toLocaleString()} — יש אובדן כתיבה`);

// קריאה אקראית של סשנים שכבר פונו מה-cache — הוכחה ל-read-through
const probeIdx = [1, 7, 999, 50_000, Math.floor(TOTAL / 2), TOTAL - 1].filter(i => i < TOTAL);
let recovered = 0;
for (const i of probeIdx) {
  const phone = `whatsapp:+9727${String(1_000_000 + i).slice(-7)}`;
  const s = await state.ensureSessionLoaded(phone, hotelId(i % HOTELS));
  if (s && s.history?.length) recovered++;
}
check(recovered === probeIdx.length,
  `סשנים שפונו נטענו מחדש מה-DB (${recovered}/${probeIdx.length})`,
  `רק ${recovered}/${probeIdx.length} סשנים שוחזרו — אובדן מידע אחרי פינוי`);

// בידוד: אותו טלפון בשני מלונות
const dual = "whatsapp:+972799999999";
state.patchSession(dual, { guestName: "בבית א" }, hotelId(0));
state.patchSession(dual, { guestName: "בבית ב" }, hotelId(1));
check(state.getSession(dual, hotelId(0)).guestName === "בבית א" &&
      state.getSession(dual, hotelId(1)).guestName === "בבית ב",
  "אותו טלפון בשני מלונות נשאר מופרד", "דליפה בין מלונות");

if (samples.length) {
  console.log(`\n${C.dim}   דוגמאות לכשלים:${C.r}`);
  for (const s of samples) console.log(`${C.dim}     • ${s}${C.r}`);
}

console.log(
  failures === 0
    ? `\n${C.gr}${C.b}   ✅ עמד בעומס — ${TOTAL.toLocaleString()} הודעות, אפס כשלים.${C.r}\n`
    : `\n${C.re}${C.b}   ❌ ${failures} כשלים תחת עומס.${C.r}\n`
);

try { fs.unlinkSync(process.env.DB_PATH); } catch {}
try { fs.unlinkSync(process.env.DB_PATH + "-wal"); } catch {}
try { fs.unlinkSync(process.env.DB_PATH + "-shm"); } catch {}
process.exitCode = failures === 0 ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 250).unref();
