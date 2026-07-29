// ════════════════════════════════════════════════════════
//  CLOUD-CHECK — על איזה מלון השרת **בענן** מוגדר?
//  ----------------------------------------------------------
//  `demo-switch.mjs` משנה את בסיס הנתונים של המחשב המקומי בלבד. השרת
//  בענן (Railway/Render) הוא מכונה אחרת — ולכן חייבת להיות דרך לשאול
//  *אותו*, מרחוק, למי הוא עונה. זה מה שהכלי הזה עושה.
//
//  שימוש:
//     node cloud-check.mjs https://my-app.up.railway.app
//     npm run cloud:check -- https://my-app.up.railway.app
//
//  הטוקן נלקח מ-DASHBOARD_PASSWORD (מ-.env או מהסביבה). אם הסיסמה בענן
//  שונה מזו שבמחשב — יש להעביר אותה במפורש:
//     node cloud-check.mjs <url> --token=SECRET
//
//  מה שנבדק: /health, /ready, ולמי הענן מנתב את מספר הוואטסאפ.
// ════════════════════════════════════════════════════════
import dotenv from "dotenv";
dotenv.config();

const C = { dim: "\x1b[2m", b: "\x1b[1m", r: "\x1b[0m", gr: "\x1b[32m", re: "\x1b[31m", ye: "\x1b[33m" };

const args  = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith("--")).map(a => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true];
}));
const baseRaw = args.find(a => !a.startsWith("--"));

if (!baseRaw) {
  console.error(
    `\n${C.re}${C.b}חסרה כתובת הענן.${C.r}\n` +
    `   שימוש:  node cloud-check.mjs https://<האפליקציה>.up.railway.app\n\n` +
    `   ${C.dim}איפה למצוא אותה: Railway → הפרויקט → השירות → Settings → Domains.${C.r}\n`
  );
  process.exit(1);
}
const base   = baseRaw.replace(/\/+$/, "");
const token  = flags.token || process.env.DASHBOARD_PASSWORD || "";
const number = flags.number || process.env.TWILIO_WHATSAPP_NUMBER || "whatsapp:+14155238886";

async function get(path, { timeout = 12000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(`${base}${path}`, { signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* לא JSON */ }
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, error: e?.name === "AbortError" ? "timeout" : (e?.message || String(e)) };
  } finally { clearTimeout(t); }
}

console.log(`\n${C.ye}${C.b}${"═".repeat(66)}\n  ☁️  בדיקת השרת בענן\n${"═".repeat(66)}${C.r}`);
console.log(`${C.dim}   כתובת: ${base}${C.r}`);
console.log(`${C.dim}   מספר נבדק: ${number}${C.r}\n`);

// 1. האם הענן חי בכלל?
const health = await get("/health");
if (health.status !== 200) {
  console.error(
    `${C.re}   ❌ הענן לא עונה (/health → ${health.status || health.error}).${C.r}\n` +
    `      ${C.dim}לבדוק: הכתובת נכונה? השירות למעלה ב-Railway? יש דומיין ציבורי?${C.r}\n`
  );
  process.exit(1);
}
console.log(`${C.gr}   ✅ הענן חי${C.r} ${C.dim}(uptime ${Math.round(health.json?.uptime || 0)} שניות)${C.r}`);

const ready = await get("/ready");
console.log(ready.json?.status === "ready"
  ? `${C.gr}   ✅ מוכן לקבל תעבורה${C.r}`
  : `${C.ye}   ⚠️ /ready → ${ready.json?.status || ready.status}${C.r}`);

// 2. למי הענן מנתב את המספר?
const q = `/api/tenant/resolve?to=${encodeURIComponent(number)}&token=${encodeURIComponent(token)}`;
const r = await get(q);

if (r.status === 401) {
  console.error(
    `\n${C.re}   ❌ הטוקן נדחה (401).${C.r}\n` +
    `      ${C.dim}הסיסמה בענן שונה מזו שבמחשב. להריץ עם: --token=<DASHBOARD_PASSWORD של Railway>${C.r}\n`
  );
  process.exit(1);
}
if (r.status === 404) {
  console.error(
    `\n${C.re}   ❌ הענן לא מכיר את /api/tenant/resolve (404).${C.r}\n` +
    `      ${C.dim}כלומר הוא מריץ גרסת קוד ישנה. יש לדחוף/לפרוס מחדש (Deploy) ואז לבדוק שוב.${C.r}\n`
  );
  process.exit(1);
}
if (r.status !== 200 || !r.json) {
  console.error(`\n${C.re}   ❌ תשובה לא צפויה (${r.status}): ${String(r.text || r.error).slice(0, 200)}${C.r}\n`);
  process.exit(1);
}

const d = r.json;
console.log(`\n   ${C.b}הענן מנתב את המספר ל:${C.r}`);
console.log(`     מלון        : ${C.b}${d.hotelName}${C.r} ${C.dim}(${d.hotelId})${C.r}`);
console.log(`     כתובת       : ${d.address}`);
console.log(`     כניסה לחדר  : ${d.keyDelivery === "door_code" ? "קוד לדלת" : "כרטיס בקבלה"}`);
console.log(`     עוסק        : ${d.businessId}`);
console.log(`     עונה מהמספר : ${d.replyFrom}`);

const expect = (flags.expect || "").toLowerCase();
let bad = false;

if (expect) {
  const ok = d.hotelId === expect;
  console.log(`\n   ${ok ? C.gr + "✅" : C.re + "❌"} מצופה "${expect}" — בפועל "${d.hotelId}"${C.r}`);
  bad = !ok;
}

if (d.replyFrom && number) {
  const norm = (s) => String(s).replace(/^whatsapp:/, "").replace(/[^\d+]/g, "");
  if (norm(d.replyFrom) !== norm(number)) {
    console.log(`\n${C.re}   ❌ הענן היה עונה מהמספר ${d.replyFrom} ולא מ-${number} — ספק הוואטסאפ ידחה.${C.r}`);
    bad = true;
  }
}

if (!expect && !bad) {
  console.log(
    `\n${C.dim}   כדי לאמת מול ציפייה: node cloud-check.mjs ${base} --expect=lala${C.r}`
  );
}

console.log(
  bad
    ? `\n${C.re}${C.b}   ❌ הענן אינו במצב הנדרש — ראו למעלה.${C.r}\n`
    : `\n${C.gr}${C.b}   ✅ הענן עונה כ"${d.hotelName}".${C.r}\n`
);
process.exit(bad ? 1 : 0);
