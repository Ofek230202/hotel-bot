// ════════════════════════════════════════════════════════
//  DEMO-SWITCH — מפנה את מספר הוואטסאפ היחיד למלון אחד, בבטחה
//  ----------------------------------------------------------
//  הבעיה: יש מספר Twilio **אחד**, ומחר מדגימים את LALA ומחרתיים את
//  קמפינסקי. אותו מספר צריך "להיות" מלון אחר בכל יום, בלי שום פרט
//  שנשאר מהמלון הקודם.
//
//  איך זה עובד: המערכת כבר מזהה מלון לפי המספר שאליו האורח כתב
//  (`hotel_numbers`: number → hotel_id). ההחלפה היא **שורה אחת ב-DB**.
//  הכלי הזה עושה את זה, ובנוסף דואג לשלושת הדברים שקל לשכוח ושבלעדיהם
//  ההדגמה נראית שבורה:
//
//   1. **הקונפיג של המלון קיים ב-DB.** LALA מוגדרת בקוד (sample-hotels)
//      אבל לא בהכרח נכתבה לבסיס הנתונים. בלי זה המספר מצביע על "lala"
//      והמערכת נופלת לברירת המחדל — כלומר עונה כקמפינסקי.
//   2. **אין מספר יתום שמצביע על אותו מלון.** המספר ה*יוצא* נבחר לפי
//      המלון; אם נשארה שורה של מספר דמו, התשובות היו יוצאות ממספר שלא
//      קיים ב-Twilio.
//   3. **הסשן הישן נמחק.** סשן קודם של אותו טלפון באותו מלון היה מדלג
//      על הודעת הפתיחה ואולי נתקע באמצע צ'ק אין ישן.
//
//  ובסוף — ריענון השרת הרץ (בלי restart) והדפסת "כרטיס הדגמה" שאומר
//  בדיוק מה האורח יראה.
//
//  שימוש:
//     npm run demo:lala         → המספר עונה כ-LALA
//     npm run demo:kempinski    → המספר עונה כקמפינסקי
//     npm run demo:status       → מי פעיל עכשיו
//
//  דגלים: --number=+972... (אם אין TWILIO_WHATSAPP_NUMBER)
//         --keep-sessions (לא למחוק סשנים)   --fresh (למחוק גם הזמנות)
// ════════════════════════════════════════════════════════
import dotenv from "dotenv";
dotenv.config();

const C = {
  dim: "\x1b[2m", b: "\x1b[1m", r: "\x1b[0m", cy: "\x1b[36m", ye: "\x1b[33m",
  gr: "\x1b[32m", ma: "\x1b[35m", re: "\x1b[31m",
};

const argv  = process.argv.slice(2);
const flags = Object.fromEntries(argv.filter(a => a.startsWith("--")).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));
const command = (argv.find(a => !a.startsWith("--")) || "status").toLowerCase();

const { db, DEFAULT_HOTEL_ID } = await import("./db.js");
const config = await import("./config.js");
const tenant = await import("./tenant.js");
const state  = await import("./state.js");
const { SAMPLE_HOTELS } = await import("./sample-hotels.mjs");

// ── המלונות שאפשר להדגים ────────────────────────────────
// כל ערך: מאיפה הקונפיג מגיע (null = מלון ברירת המחדל שבקוד).
const DEMO_HOTELS = {
  lala: {
    id: "lala",
    label: "LALA Boutique · לאלה בוטיק",
    config: SAMPLE_HOTELS.find(h => h.hotelId === "lala")?.config || null,
  },
  kempinski: {
    id: DEFAULT_HOTEL_ID,
    label: "The David Kempinski · מלון דוד קמפינסקי",
    config: null,   // מלון ברירת המחדל — הקונפיג בקוד (DEFAULTS)
  },
};

function line(char = "─", n = 66) { return char.repeat(n); }
function title(t) { console.log(`\n${C.ye}${C.b}${line("═")}\n  ${t}\n${line("═")}${C.r}`); }

// ── המספר שאליו האורחים כותבים ──────────────────────────
function resolveNumber() {
  const raw = flags.number || process.env.TWILIO_WHATSAPP_NUMBER;
  const n = tenant.normalizeNumber(raw);
  if (!n) {
    console.error(
      `\n${C.re}${C.b}🔴 לא נמצא מספר וואטסאפ.${C.r}\n` +
      `   הגדירי ב-.env את TWILIO_WHATSAPP_NUMBER=whatsapp:+972...\n` +
      `   או הריצי עם: node demo-switch.mjs ${command} --number=+972...\n`
    );
    process.exit(1);
  }
  return n;
}

// ── מצב נוכחי ───────────────────────────────────────────
function currentMapping() {
  try {
    return db.prepare(`SELECT number, hotel_id, from_number, updated_at FROM hotel_numbers`).all();
  } catch { return []; }
}

function showStatus() {
  title("📍 מצב נוכחי — למי המספר עונה");
  const rows = currentMapping();
  const envNum = tenant.normalizeNumber(process.env.TWILIO_WHATSAPP_NUMBER);

  if (!rows.length) {
    console.log(
      `${C.ye}   אין שום מיפוי ב-DB.${C.r}\n` +
      `   ${C.dim}המשמעות: כל הודעה נופלת למלון ברירת המחדל — "${DEFAULT_HOTEL_ID}".${C.r}\n` +
      `   ${C.dim}כלומר גם אם תכתבי "LALA" — הבוט יענה כקמפינסקי.${C.r}\n\n` +
      `   ${C.b}להדגמת LALA מחר הריצי:${C.r}  npm run demo:lala\n`
    );
    return null;
  }

  for (const r of rows) {
    const isEnv = envNum && tenant.normalizeNumber(r.number) === envNum;
    const cfg = config.configFor(r.hotel_id);
    console.log(
      `   ${isEnv ? C.gr + "▶" : C.dim + " "} ${r.number}${C.r} → ${C.b}${cfg.name_he || cfg.name}${C.r} ` +
      `${C.dim}(${r.hotel_id})${C.r}${isEnv ? `  ${C.gr}← המספר שלך${C.r}` : ""}`
    );
  }
  const mine = rows.find(r => envNum && tenant.normalizeNumber(r.number) === envNum);
  if (!mine && envNum) {
    console.log(`\n${C.ye}   ⚠️ המספר שב-.env (${envNum}) אינו ממופה — הודעות אליו ילכו ל-"${DEFAULT_HOTEL_ID}".${C.r}`);
  }
  console.log("");
  return mine?.hotel_id || null;
}

// ── כרטיס הדגמה: מה האורח יראה ──────────────────────────
function demoCard(hotelId, number) {
  const cfg   = config.configFor(hotelId);
  const model = config.hotelModel(hotelId);
  const he    = (v) => v || "—";

  title(`🎬 כרטיס הדגמה — ${cfg.name_he || cfg.name}`);
  console.log(`   ${C.b}המספר שאליו כותבים:${C.r} ${number}`);
  console.log(`   ${C.b}המלון:${C.r} ${he(cfg.name_he)} / ${he(cfg.name)}   ${C.dim}(hotel_id: ${hotelId})${C.r}`);
  console.log(`   ${C.b}כתובת:${C.r} ${he(cfg.location?.address_he)}`);
  console.log(`   ${C.b}מיקום הקונסיירז':${C.r} ${cfg.location?.lat}, ${cfg.location?.lng} ${C.dim}(רדיוס ${cfg.location?.search_radius_m || 4000} מ׳)${C.r}`);
  console.log(`   ${C.b}סוג מלון:${C.r} ${model.isBoutique ? "בוטיק" : "מלון מלא"} · ` +
              `כניסה לחדר: ${C.b}${model.keyDelivery === "door_code" ? "קוד לדלת" : "כרטיס בקבלה"}${C.r} · ` +
              `קבלה 24/7: ${model.staffed24_7 ? "כן" : "לא"} · צוות ביטחון במקום: ${model.onSiteSecurity ? "כן" : "לא"}`);
  console.log(`   ${C.b}פיקדון:${C.r} ₪${(cfg.deposit_amount / 100).toFixed(0)} · ` +
              `${C.b}מע"מ:${C.r} ${Math.round((cfg.vat_rate || 0) * 100)}% (תייר חוץ: ${cfg.tourist_zero_vat ? "0%" : "רגיל"})`);
  console.log(`   ${C.b}עוסק לחשבונית:${C.r} ${he(cfg.business?.legal_name)} · ${he(cfg.business?.business_id)}`);
  console.log(`   ${C.b}WiFi:${C.r} ${he(cfg.wifi?.name)} / ${he(cfg.wifi?.password)}`);

  const services = Object.keys(cfg.services || {}).filter(k => cfg.services[k]);
  console.log(`   ${C.b}שירותים:${C.r} ${services.join(", ") || "—"}`);
  const rests = Object.keys(cfg.restaurants || {});
  console.log(`   ${C.b}מסעדות המלון:${C.r} ${rests.length ? rests.join(", ") : "אין"}`);

  console.log(`\n   ${C.b}מחלקות — לאן ילכו הבקשות בהדגמה:${C.r}`);
  for (const d of config.DEPARTMENTS) {
    const { whatsapp, email } = config.departmentContacts(d, hotelId);
    console.log(`     ${(config.DEPARTMENT_LABELS_HE[d] || d).padEnd(14)} 📱 ${String(whatsapp || "❌ חסר").replace(/^whatsapp:/, "").padEnd(16)} 📧 ${email || "❌ חסר"}`);
  }

  console.log(`\n   ${C.b}הודעת הפתיחה שהאורח יקבל:${C.r}`);
  console.log(config.welcomeFor(hotelId, "he").split("\n").map(l => `     ${C.dim}│${C.r} ${l}`).join("\n"));
}

// ── אזהרות לפני הדגמה ───────────────────────────────────
function warnings(hotelId) {
  const cfg = config.configFor(hotelId);
  const out = [];

  // אנשי קשר לדוגמה — ההתראות ילכו למספרים שלא קיימים.
  const demoContacts = config.DEPARTMENTS.filter(d => {
    const { email } = config.departmentContacts(d, hotelId);
    return /-demo\.co\.il$|\.test$|example\./i.test(String(email || ""));
  });
  if (demoContacts.length) {
    out.push(
      `אנשי הקשר של ${demoContacts.length} מחלקות הם *לדוגמה* (${config.departmentContacts(demoContacts[0], hotelId).email}).\n` +
      `      ההתראות יישלחו למספרים/מיילים שאינם אמיתיים. זה תקין להדגמה, אבל אם רוצים\n` +
      `      שהצוות באמת יקבל — יש להחליף אותם לפני.`
    );
  }

  // בידוד מול מלון ברירת המחדל.
  const iso = config.checkTenantIsolation(hotelId);
  if (!iso.skipped && !iso.ok) {
    out.push(`המלון חולק שדות עם "${DEFAULT_HOTEL_ID}": ${iso.shared.join(", ")}`);
  }

  // שלמות אנשי קשר.
  const contacts = config.checkDepartmentContacts(hotelId);
  if (!contacts.ok) out.push(`חסרים אנשי קשר: ${contacts.missing.join(", ")}`);

  if (out.length) {
    console.log(`\n${C.ye}${C.b}   ⚠️ לתשומת לבך:${C.r}`);
    for (const w of out) console.log(`${C.ye}    • ${w}${C.r}`);
  }
  return out.length === 0;
}

// ── ריענון השרת הרץ (אם הוא למעלה) ──────────────────────
async function pingServer() {
  const port = process.env.PORT || 3000;
  const pass = process.env.DASHBOARD_PASSWORD || "hotel2024";
  const url  = `http://localhost:${port}/api/tenant/reload?token=${encodeURIComponent(pass)}`;
  try {
    const ctl = AbortController ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(url, { method: "POST", signal: ctl?.signal });
    if (timer) clearTimeout(timer);
    if (res.ok) return { ok: true };
    return { ok: false, reason: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, reason: e?.name === "AbortError" ? "timeout" : "לא רץ" };
  }
}

// ── ההחלפה עצמה ─────────────────────────────────────────
async function switchTo(key) {
  const target = DEMO_HOTELS[key];
  if (!target) {
    console.error(`\n${C.re}מלון לא מוכר: "${key}". אפשרויות: ${Object.keys(DEMO_HOTELS).join(" | ")}${C.r}\n`);
    process.exit(1);
  }
  const number = resolveNumber();

  title(`🔀 מחליף את ${number} → ${target.label}`);

  // 1. הקונפיג של המלון קיים ב-DB (למלון שאינו ברירת המחדל).
  if (target.config) {
    config.updateConfigFor(target.id, target.config);
    console.log(`   ✅ הקונפיג של "${target.id}" נכתב ל-DB`);
  } else {
    console.log(`   ✅ "${target.id}" הוא מלון ברירת המחדל — הקונפיג מגיע מהקוד`);
  }

  // 2. המספר מצביע על המלון הזה, ו**רק** עליו.
  //    מוחקים כל שורה אחרת: מספר יתום שמצביע על אותו מלון היה נבחר
  //    כמספר היוצא, והתשובות היו יוצאות ממספר שלא קיים ב-Twilio.
  const before = currentMapping();
  const stale  = before.filter(r => tenant.normalizeNumber(r.number) !== number);
  if (stale.length) {
    for (const r of stale) db.prepare(`DELETE FROM hotel_numbers WHERE number = ?`).run(r.number);
    console.log(`   🧹 נמחקו ${stale.length} מיפויי מספרים ישנים (${stale.map(r => r.number).join(", ")})`);
  }
  tenant.registerHotelNumber(number, target.id, number);
  console.log(`   ✅ ${number} → "${target.id}" (גם המספר היוצא)`);

  // 3. סשנים ישנים — אחרת הפתיחה לא תופיע והשיחה תמשיך מאמצע.
  if (!flags["keep-sessions"]) {
    const removed = clearSessionsOf(target.id);
    console.log(`   ✅ נמחקו ${removed} סשנים של "${target.id}" — ההדגמה מתחילה נקייה`);
  } else {
    console.log(`   ${C.dim}⏭️  סשנים נשמרו (--keep-sessions)${C.r}`);
  }

  // 4. הזמנות ישנות (רק עם --fresh).
  if (flags.fresh) {
    const n = clearReservationsOf(target.id);
    console.log(`   ✅ נמחקו ${n} הזמנות ישנות של "${target.id}" (--fresh)`);
  }

  // 5. ריענון השרת הרץ בלי restart.
  const ping = await pingServer();
  console.log(ping.ok
    ? `   ✅ השרת הרץ רוענן — ההחלפה כבר בתוקף`
    : `   ${C.dim}ℹ️  השרת לא נענה (${ping.reason}) — אם הוא רץ, הפעילי אותו מחדש כדי שיקלוט את השינוי${C.r}`);

  demoCard(target.id, number);
  const clean = warnings(target.id);

  console.log(
    `\n${C.gr}${C.b}   ✅ מוכן. כתבי עכשיו ל-${number} — הבוט יענה כ"${config.configFor(target.id).name_he}".${C.r}` +
    (clean ? "" : `\n${C.dim}   (האזהרות למעלה אינן חוסמות את ההדגמה.)${C.r}`) +
    `\n${C.dim}   להחלפה חזרה: npm run demo:${key === "lala" ? "kempinski" : "lala"}${C.r}\n`
  );
}

// מחיקת סשנים של מלון מסוים — מהזיכרון ומה-DB.
function clearSessionsOf(hotelId) {
  let n = 0;
  for (const s of state.allSessions(hotelId)) {
    state.deleteSession(s.phone, hotelId);
    n++;
  }
  try {
    const r = db.prepare(`DELETE FROM sessions WHERE hotel_id = ?`).run(hotelId);
    n = Math.max(n, r.changes || 0);
  } catch { /* ignore */ }
  return n;
}

function clearReservationsOf(hotelId) {
  try {
    const r = db.prepare(`DELETE FROM reservations WHERE hotel_id = ?`).run(hotelId);
    return r.changes || 0;
  } catch { return 0; }
}

// ── ניתוב הפקודה ────────────────────────────────────────
switch (command) {
  case "lala":
  case "kempinski":
    await switchTo(command);
    break;
  case "status":
    showStatus();
    break;
  default:
    console.log(
      `\n${C.b}שימוש:${C.r}\n` +
      `   npm run demo:lala        → המספר עונה כמלון LALA\n` +
      `   npm run demo:kempinski   → המספר עונה כמלון קמפינסקי\n` +
      `   npm run demo:status      → מי פעיל עכשיו\n`
    );
}
process.exit(0);
