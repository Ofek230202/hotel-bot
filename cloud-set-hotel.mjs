// ════════════════════════════════════════════════════════
//  CLOUD-SET-HOTEL — מעביר שרת בענן למלון הדגמה, **מיד**
//  ----------------------------------------------------------
//  שני מסלולים להגדיר את מלון ההדגמה בענן, והם משלימים:
//
//   1. `DEMO_HOTEL` (משתנה סביבה) — **מתמיד**. נקרא בכל עלייה, ולכן שורד
//      כל redeploy. זו הדרך הנכונה לטווח ארוך.
//   2. הכלי הזה — **מיידי**. דוחף את קונפיג המלון ואת מיפוי המספר ישירות
//      דרך `POST /api/hotels`, בלי redeploy ובלי לגעת ב-Railway.
//      ⚠️ יושב בבסיס הנתונים, ולכן על Railway (מערכת קבצים בת-חלוף) הוא
//      **ייעלם ב-redeploy הבא** — אלא אם גם `DEMO_HOTEL` מוגדר.
//
//  כלומר: הכלי הזה מציל הדגמה עכשיו; `DEMO_HOTEL` דואג שזה יחזיק.
//
//  שימוש:
//     node cloud-set-hotel.mjs <url> lala
//     node cloud-set-hotel.mjs <url> kempinski --token=SECRET
// ════════════════════════════════════════════════════════
import dotenv from "dotenv";
dotenv.config();

const C = { dim: "\x1b[2m", b: "\x1b[1m", r: "\x1b[0m", gr: "\x1b[32m", re: "\x1b[31m", ye: "\x1b[33m" };

const args  = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith("--")).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true];
}));
const positional = args.filter(a => !a.startsWith("--"));
const baseRaw = positional[0];
const want    = (positional[1] || "").toLowerCase();

if (!baseRaw || !want) {
  console.error(
    `\n${C.re}שימוש:${C.r} node cloud-set-hotel.mjs <url> <lala|kempinski> [--token=...] [--number=whatsapp:+1...]\n`
  );
  process.exit(1);
}

const base   = baseRaw.replace(/\/+$/, "");
const token  = flags.token  || process.env.DASHBOARD_PASSWORD || "";
const number = flags.number || process.env.TWILIO_WHATSAPP_NUMBER || "";

if (!number) {
  console.error(`\n${C.re}חסר מספר וואטסאפ — להגדיר TWILIO_WHATSAPP_NUMBER או --number=${C.r}\n`);
  process.exit(1);
}

const { SAMPLE_HOTELS } = await import("./sample-hotels.mjs");
const { DEFAULT_HOTEL_ID } = await import("./db.js");

const entry = SAMPLE_HOTELS.find(h => h.hotelId === want);
const isDefault = want === DEFAULT_HOTEL_ID;
if (!entry && !isDefault) {
  console.error(
    `\n${C.re}מלון לא מוכר: "${want}".${C.r}\n   אפשרויות: ${SAMPLE_HOTELS.map(h => h.hotelId).join(", ")}\n`
  );
  process.exit(1);
}

console.log(`\n${C.ye}${C.b}${"═".repeat(66)}\n  ☁️  מעביר את הענן ל-"${want}"\n${"═".repeat(66)}${C.r}`);
console.log(`${C.dim}   ${base}\n   מספר: ${number}${C.r}\n`);

// מלון ברירת המחדל אינו זקוק לקונפיג (הוא בקוד) — רק למיפוי המספר.
const body = {
  hotelId: want,
  number,
  fromNumber: number,
  ...(entry?.config && !isDefault ? { config: entry.config } : {}),
};

let res, data;
try {
  res = await fetch(`${base}/api/hotels?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
} catch (e) {
  console.error(`${C.re}   ❌ הקריאה נכשלה: ${e.message}${C.r}\n`);
  process.exit(1);
}

if (res.status === 401) {
  console.error(`${C.re}   ❌ הטוקן נדחה (401) — הסיסמה בענן שונה. להריץ עם --token=<DASHBOARD_PASSWORD של Railway>${C.r}\n`);
  process.exit(1);
}
if (res.status === 404) {
  console.error(`${C.re}   ❌ 404 — הענן מריץ קוד ישן שאין בו /api/hotels. לפרוס מחדש.${C.r}\n`);
  process.exit(1);
}
if (!res.ok || !data?.ok) {
  console.error(`${C.re}   ❌ נכשל (${res.status}): ${JSON.stringify(data).slice(0, 300)}${C.r}\n`);
  process.exit(1);
}

console.log(`${C.gr}   ✅ הקונפיג והמיפוי נכתבו בענן${C.r}`);
if (data.missingContacts?.length) {
  console.log(`${C.ye}   ⚠️ חסרים אנשי קשר: ${data.missingContacts.join(", ")}${C.r}`);
}
if (data.sharedWithDefault?.length) {
  console.log(`${C.ye}   ⚠️ שדות משותפים עם מלון ברירת המחדל: ${data.sharedWithDefault.join(", ")}${C.r}`);
}

// אימות מיידי — שואלים את הענן למי הוא מנתב עכשיו.
const q = `${base}/api/tenant/resolve?to=${encodeURIComponent(number)}&token=${encodeURIComponent(token)}`;
const vr = await fetch(q).then(r => r.json()).catch(() => null);
if (vr?.hotelId === want) {
  console.log(
    `\n${C.gr}${C.b}   ✅ הענן עונה עכשיו כ"${vr.hotelName}".${C.r}\n` +
    `${C.dim}      כניסה לחדר: ${vr.keyDelivery === "door_code" ? "קוד לדלת" : "כרטיס בקבלה"} · עוסק: ${vr.businessId}${C.r}`
  );
} else {
  console.log(`\n${C.re}   ❌ הענן עדיין מנתב ל-"${vr?.hotelId}" — לבדוק ידנית.${C.r}`);
  process.exit(1);
}

// 🔴 שלושה מצבים שונים לגמרי, ואסור לבלבל ביניהם. הגרסה הראשונה אמרה
//    "ההגדרה תשרוד redeploy" גם כש-DEMO_HOTEL הצביע על מלון **אחר** —
//    כלומר הבטיחה יציבות בדיוק במצב שבו השינוי ייהרס.
if (!vr.demoHotel) {
  console.log(
    `\n${C.ye}   ⚠️ DEMO_HOTEL אינו מוגדר בענן — השינוי הזה **זמני**.${C.r}\n` +
    `${C.dim}      הוא יושב בבסיס הנתונים, ועל Railway מערכת הקבצים בת-חלוף,\n` +
    `      ולכן הוא יימחק ב-redeploy הבא.\n` +
    `      כדי שיחזיק: Railway → Variables → DEMO_HOTEL = ${want}${C.r}\n`
  );
} else if (String(vr.demoHotel).toLowerCase() !== want) {
  console.log(
    `\n${C.re}${C.b}   ⚠️ שימי לב: DEMO_HOTEL בענן הוא "${vr.demoHotel}" — ולא "${want}".${C.r}\n` +
    `${C.re}      הענן עונה עכשיו כ-"${want}", אבל ב-redeploy הבא הוא **יחזור ל-"${vr.demoHotel}"**.${C.r}\n` +
    `${C.dim}      כדי שהשינוי יחזיק: Railway → Variables → DEMO_HOTEL = ${want}${C.r}\n`
  );
} else {
  console.log(`\n${C.gr}   ✅ DEMO_HOTEL=${vr.demoHotel} תואם — ההגדרה תשרוד redeploy.${C.r}\n`);
}
