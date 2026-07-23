// ════════════════════════════════════════════════════════
//  SCALE — עומס, מקביליות ובידוד בין מלונות (multi-tenant)
//  ----------------------------------------------------------
//  מוכיח שלוש דרישות ליבה של "100 מלונות × 1000 אורחים":
//   1. פרימיטיבים של מקביליות (concurrency.js) עובדים כמובטח.
//   2. שכבת ה-tenant מבודדת מלונות זה מזה (tenant.js / state.js).
//   3. מקצה לקצה: מאות הודעות במקביל, מלונות שונים בו-זמנית, הודעות
//      מהירות ברצף — בלי קריסה, בלי בלבול בין אורחים, בלי אובדן בקשה,
//      ובלי שבקשה של מלון א' תגיע למלון ב'.
//
//  הרצה: node --experimental-test-module-mocks --test scale.test.mjs
// ════════════════════════════════════════════════════════
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

// DB זמני — לא נוגעים ב-hotel.db האמיתי.
process.env.DB_PATH                = path.join(os.tmpdir(), `hotel-scale-${process.pid}.db`);
process.env.TWILIO_ACCOUNT_SID     = "ACtest";
process.env.TWILIO_AUTH_TOKEN      = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+10000000000";
process.env.ANTHROPIC_API_KEY      = "sk-test";
process.env.BASE_URL               = "http://test.local";
process.env.ID_ENCRYPTION_KEY      = "0".repeat(64);

// ── mocks (זהים בעקרון ל-e2e) ──────────────────────────
const sent = [];               // { to, from, body }
let aiReply = "שלום!";
let aiDelay = 0;               // השהיה מלאכותית לקריאת AI (לבדיקת סמפור)
let aiConcurrentNow = 0, aiConcurrentMax = 0;

mock.module("twilio", {
  exports: {
    default: () => ({
      messages: {
        create: async ({ to, from, body }) => {
          if (!body) throw new Error("Twilio: body is required");
          sent.push({ to, from, body });
          return { sid: "SMtest" };
        },
      },
    }),
  },
});

mock.module("@anthropic-ai/sdk", {
  exports: {
    default: class Anthropic {
      messages = {
        create: async () => {
          aiConcurrentNow++;
          aiConcurrentMax = Math.max(aiConcurrentMax, aiConcurrentNow);
          if (aiDelay) await new Promise(r => setTimeout(r, aiDelay));
          aiConcurrentNow--;
          return { content: [{ type: "text", text: aiReply }] };
        },
      };
    },
  },
});

mock.module("./places/index.js", {
  exports: {
    places: { searchNearby: async () => ({ ok: true, provider: "mock", results: [] }) },
    placesLive: false,
    PLACE_CATEGORIES: Object.freeze({ restaurant: "restaurant" }),
  },
});

const emails = [];             // כל מייל שנשלח למחלקה — { to, dept, subject }
mock.module("./email/index.js", {
  exports: { email: { send: async (m) => { emails.push(m); return { success: true, messageId: "mock" }; } } },
});

mock.module("./idverify/index.js", {
  exports: { idVerify: { verifyDocument: async () => ({ success: true, status: "verified", documentType: "id_card" }) } },
});

let bot, tenant, state, config, concurrency;
before(async () => {
  concurrency = await import("./concurrency.js");
  tenant      = await import("./tenant.js");
  state       = await import("./state.js");
  config      = await import("./config.js");
  bot         = await import("./bot.js");

  // ── שני מלונות עם אנשי קשר שונים לגמרי ─────────────────
  const HOTEL_A_NUM = "+15550000001";     // מלון ברירת המחדל (kempinski)
  const HOTEL_B_NUM = "+15550000002";     // מלון שני
  tenant.registerHotelNumber(HOTEL_A_NUM, tenant.DEFAULT_HOTEL_ID, HOTEL_A_NUM);
  tenant.registerHotelNumber(HOTEL_B_NUM, "hotelb", HOTEL_B_NUM);

  config.updateConfigFor("hotelb", {
    name: "Hotel B", name_he: "מלון ב",
    reception_email:    "reception@hotelb.test",   reception_number:    "+15559990000",
    housekeeping_email: "hk@hotelb.test",          housekeeping_number: "+15559990001",
  });
  globalThis.__HOTEL_A_NUM = HOTEL_A_NUM;
  globalThis.__HOTEL_B_NUM = HOTEL_B_NUM;
});

beforeEach(() => {
  sent.length = 0; emails.length = 0; aiReply = "שלום!";
  aiDelay = 0; aiConcurrentNow = 0; aiConcurrentMax = 0;
});

let seq = 0;
const freshPhone = () => `whatsapp:+972501${String(++seq).padStart(6, "0")}`;

// ══════════════════════════════════════════════════════════
//  1. concurrency.js — פרימיטיבים
// ══════════════════════════════════════════════════════════
test("withLock: פעולות על אותו מפתח מבוצעות בזו אחר זו (בלי דריסה)", async () => {
  const { withLock } = concurrency;
  let shared = 0;
  const order = [];
  // כל משימה קוראת, ממתינה (חלון לדריסה), ואז כותבת. בלי נעילה — כולן
  // קוראות 0 וכותבות 1. עם נעילה — 0→1→2→3→4→5.
  const tasks = [];
  for (let i = 0; i < 5; i++) {
    tasks.push(withLock("same", async () => {
      const cur = shared;
      await new Promise(r => setTimeout(r, 5));
      shared = cur + 1;
      order.push(i);
    }));
  }
  await Promise.all(tasks);
  assert.equal(shared, 5, "כל 5 העדכונים נספרו — אין דריסה");
  assert.deepEqual(order, [0, 1, 2, 3, 4], "בוצעו לפי הסדר שהוגשו (FIFO)");
});

test("withLock: מפתחות שונים רצים במקביל", async () => {
  const { withLock } = concurrency;
  let active = 0, maxActive = 0;
  const task = (k) => withLock(k, async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 10));
    active--;
  });
  await Promise.all([task("a"), task("b"), task("c")]);
  assert.equal(maxActive, 3, "שלושה מפתחות שונים רצו במקביל");
});

test("withLock: שגיאה במשימה לא שוברת את התור של אותו מפתח", async () => {
  const { withLock } = concurrency;
  await assert.rejects(withLock("k", async () => { throw new Error("boom"); }));
  // המשימה הבאה על אותו מפתח עדיין רצה.
  const out = await withLock("k", async () => "ok");
  assert.equal(out, "ok");
});

test("createSemaphore: לא חורג מהתקרה", async () => {
  const { createSemaphore } = concurrency;
  const sem = createSemaphore(3);
  let now = 0, max = 0;
  const tasks = Array.from({ length: 20 }, () => sem(async () => {
    now++; max = Math.max(max, now);
    await new Promise(r => setTimeout(r, 5));
    now--;
  }));
  await Promise.all(tasks);
  assert.ok(max <= 3, `לכל היותר 3 במקביל (נמדד ${max})`);
});

test("retryWithBackoff: מנסה שוב ומצליח; מכבד shouldRetry", async () => {
  const { retryWithBackoff } = concurrency;
  let n = 0;
  const out = await retryWithBackoff(async () => { n++; if (n < 3) throw new Error("x"); return "done"; }, { baseMs: 1 });
  assert.equal(out, "done"); assert.equal(n, 3);

  let m = 0;
  await assert.rejects(retryWithBackoff(async () => { m++; throw new Error("permanent"); },
    { baseMs: 1, shouldRetry: () => false }));
  assert.equal(m, 1, "shouldRetry=false → ניסיון אחד בלבד");
});

test("withTimeout: דוחה פעולה איטית, מחזיר מהירה", async () => {
  const { withTimeout } = concurrency;
  assert.equal(await withTimeout(async () => "fast", 50), "fast");
  await assert.rejects(withTimeout(() => new Promise(r => setTimeout(r, 100)), 20), /timed out/);
});

test("createRateLimiter: דלי אסימונים דטרמיניסטי", () => {
  const { createRateLimiter } = concurrency;
  const allow = createRateLimiter({ capacity: 3, refillPerSec: 1 });
  const t0 = 1_000_000;
  assert.ok(allow("g", t0));       // 3→2
  assert.ok(allow("g", t0));       // 2→1
  assert.ok(allow("g", t0));       // 1→0
  assert.ok(!allow("g", t0));      // 0 → נחסם
  assert.ok(allow("g", t0 + 1000)); // אחרי שנייה התמלא אסימון אחד
  assert.ok(allow("other", t0));   // מפתח אחר — דלי נפרד
});

// ══════════════════════════════════════════════════════════
//  2. tenant.js — זהות המלון
// ══════════════════════════════════════════════════════════
test("normalizeNumber: צורות שונות → אותו E.164", () => {
  const { normalizeNumber } = tenant;
  assert.equal(normalizeNumber("whatsapp:+972-50-123-4567"), "+972501234567");
  assert.equal(normalizeNumber("972501234567"), "+972501234567");
  assert.equal(normalizeNumber("+972501234567"), "+972501234567");
});

test("resolveHotelId: מספר ממופה → המלון שלו; לא ממופה → ברירת מחדל", () => {
  assert.equal(tenant.resolveHotelId(globalThis.__HOTEL_A_NUM), tenant.DEFAULT_HOTEL_ID);
  assert.equal(tenant.resolveHotelId(globalThis.__HOTEL_B_NUM), "hotelb");
  assert.equal(tenant.resolveHotelId("+19998887777"), tenant.DEFAULT_HOTEL_ID);
});

test("runInTenant: currentHotelId מבודד בין הקשרים מקבילים", async () => {
  const { runInTenant, currentHotelId } = tenant;
  const results = await Promise.all([
    runInTenant("h1", async () => { await new Promise(r => setTimeout(r, 10)); return currentHotelId(); }),
    runInTenant("h2", async () => { await new Promise(r => setTimeout(r, 5));  return currentHotelId(); }),
    runInTenant("h3", async () => currentHotelId()),
  ]);
  assert.deepEqual(results, ["h1", "h2", "h3"]);
  assert.equal(currentHotelId(), tenant.DEFAULT_HOTEL_ID, "מחוץ להקשר — ברירת מחדל");
});

// ══════════════════════════════════════════════════════════
//  3. state — בידוד סשנים בין מלונות
// ══════════════════════════════════════════════════════════
test("getSession: אותו טלפון בשני מלונות = שני סשנים נפרדים", () => {
  const phone = freshPhone();
  const a = state.getSession(phone, "kempinski");
  const b = state.getSession(phone, "hotelb");
  assert.notEqual(a.id, b.id, "מזהי סשן שונים");
  state.patchSession(phone, { roomNumber: "A-100" }, "kempinski");
  state.patchSession(phone, { roomNumber: "B-200" }, "hotelb");
  assert.equal(state.peekSession(phone, "kempinski").roomNumber, "A-100");
  assert.equal(state.peekSession(phone, "hotelb").roomNumber, "B-200", "אין דליפה בין מלונות");
});

// ══════════════════════════════════════════════════════════
//  4. מקצה לקצה — בידוד + עומס דרך handleIncoming
// ══════════════════════════════════════════════════════════
test("בידוד: בקשה למלון א' מגיעה רק למחלקות של מלון א'", async () => {
  aiReply = "[RECEPTION: בקשה כללית של האורח] בשמחה, אעביר לקבלה.";
  const gA = freshPhone(), gB = freshPhone();
  await Promise.all([
    bot.handleIncoming(gA, "אני צריך עזרה כללית", null, { to: globalThis.__HOTEL_A_NUM }),
    bot.handleIncoming(gB, "אני צריך עזרה כללית", null, { to: globalThis.__HOTEL_B_NUM }),
  ]);
  const toAddrs = emails.map(e => e.to);
  assert.ok(toAddrs.includes("reception@hotelb.test"), "מלון ב' קיבל את הבקשה של האורח שלו");
  assert.ok(toAddrs.some(a => /kempinski/.test(a)), "מלון א' קיבל את הבקשה של האורח שלו");
  // ההוכחה לבידוד: המייל של מלון ב' לא הכיל שום כתובת של מלון א' ולהיפך.
  const bEmails = emails.filter(e => e.to === "reception@hotelb.test");
  assert.ok(bEmails.length >= 1 && bEmails.every(e => e.to === "reception@hotelb.test"));
  assert.ok(!toAddrs.includes("reception@hotelb.test") ||
            !emails.some(e => e.to === "reception@hotelb.test" && /kempinski/.test(JSON.stringify(e))));
});

test("בידוד: אותו מספר טלפון פונה לשני מלונות → שני סשנים, כל אחד עם המלון שלו", async () => {
  const phone = freshPhone();
  await bot.handleIncoming(phone, "שלום", null, { to: globalThis.__HOTEL_A_NUM });
  await bot.handleIncoming(phone, "שלום", null, { to: globalThis.__HOTEL_B_NUM });
  const sA = state.peekSession(phone, "kempinski");
  const sB = state.peekSession(phone, "hotelb");
  assert.ok(sA && sB, "שני סשנים נוצרו");
  assert.equal(sA.hotelId, "kempinski");
  assert.equal(sB.hotelId, "hotelb");
  assert.notEqual(sA.id, sB.id);
});

test("סריאליזציה: שתי הודעות מהירות של אותו אורח לא נאבדות ולא נדרסות", async () => {
  const phone = freshPhone();
  // שתי הודעות במקביל (בלי await ביניהן) — withLock מסדר אותן בזו אחר זו.
  await Promise.all([
    bot.handleIncoming(phone, "הודעה ראשונה", null, { to: globalThis.__HOTEL_A_NUM }),
    bot.handleIncoming(phone, "הודעה שנייה",  null, { to: globalThis.__HOTEL_A_NUM }),
  ]);
  const s = state.peekSession(phone, "kempinski");
  const userMsgs = s.history.filter(h => h.role === "user").map(h => h.content);
  assert.ok(userMsgs.includes("הודעה ראשונה") && userMsgs.includes("הודעה שנייה"),
    `שתי ההודעות נשמרו בהיסטוריה: ${JSON.stringify(userMsgs)}`);
  // messageCount נספר פעמיים בדיוק — אין race על המונה.
  assert.equal(s.messageCount, 2, "המונה עלה פעמיים בדיוק (בלי דריסה)");
});

test("עומס: 300 הודעות במקביל, שני מלונות — בלי קריסה, בלי אובדן, בלי בלבול", async () => {
  aiReply = "איך אוכל לעזור?";
  const N = 300;
  const jobs = [];
  const guestsA = [], guestsB = [];
  for (let i = 0; i < N; i++) {
    const phone = freshPhone();
    const toB = i % 2 === 0;
    (toB ? guestsB : guestsA).push(phone);
    jobs.push(bot.handleIncoming(phone, `שאלה מספר ${i}`, null,
      { to: toB ? globalThis.__HOTEL_B_NUM : globalThis.__HOTEL_A_NUM }));
  }
  // אף קריאה לא אמורה לזרוק (handleIncoming תופס הכול בפנים).
  await assert.doesNotReject(Promise.all(jobs));

  // כל אורח קיבל תשובה, וכל סשן משויך למלון הנכון.
  for (const p of guestsA) {
    assert.equal(state.peekSession(p, "kempinski")?.hotelId, "kempinski");
    assert.equal(state.peekSession(p, "hotelb"), undefined, "אורח של א' לא נוצר תחת ב'");
  }
  for (const p of guestsB) {
    assert.equal(state.peekSession(p, "hotelb")?.hotelId, "hotelb");
    assert.equal(state.peekSession(p, "kempinski"), undefined, "אורח של ב' לא נוצר תחת א'");
  }
  // כל הודעה יצאה מהמספר של המלון הנכון (בידוד גם בערוץ היוצא).
  const bad = sent.filter(m => {
    const toB = guestsB.includes(m.to);
    const toA = guestsA.includes(m.to);
    if (toB) return !String(m.from).includes(globalThis.__HOTEL_B_NUM.replace("+", ""));
    if (toA) return !String(m.from).includes(globalThis.__HOTEL_A_NUM.replace("+", ""));
    return false;
  });
  assert.equal(bad.length, 0, "כל תשובה יצאה מהמספר של המלון הנכון");
  assert.ok(sent.length >= N, `נשלחו לפחות ${N} תשובות (בפועל ${sent.length})`);
});

test("עומס: הסמפור מגביל את מספר קריאות ה-AI המקביליות", async () => {
  aiReply = "תשובה";
  aiDelay = 15; // מאריך כל קריאה כדי שהמקביליות תיראה
  const jobs = [];
  for (let i = 0; i < 80; i++) {
    jobs.push(bot.handleIncoming(freshPhone(), `שאלה ${i}`, null, { to: globalThis.__HOTEL_A_NUM }));
  }
  await Promise.all(jobs);
  // ברירת המחדל של AI_MAX_CONCURRENCY היא 24.
  assert.ok(aiConcurrentMax <= 24, `קריאות AI מקביליות ≤ 24 (נמדד ${aiConcurrentMax})`);
  assert.ok(aiConcurrentMax > 1, "בכל זאת רצו כמה במקביל (לא סריאלי לגמרי)");
});
