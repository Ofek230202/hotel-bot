// ════════════════════════════════════════════════════════
//  STORE — מצב משותף, נעילה מבוזרת והגבלת קצב משותפת
//  ----------------------------------------------------------
//  ה-fake כאן מממש את **אותן פקודות Redis** שהקוד באמת שולח (SET NX PX,
//  GET, DEL, EVAL עם הסקריפט של השחרור, INCRBY, PEXPIRE). לכן הבדיקות
//  בודקות את המסלול האמיתי ולא גרסה מפושטת שלו — כולל התנהגות התפוגה,
//  שהיא בדיוק מה שקשה לתפוס בפרודקשן.
// ════════════════════════════════════════════════════════
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { MemoryStore, RedisStore, createStore, setStore, storeKind, isDistributed } = await import("./store/index.js");
const { withGuestLock, acquireLock, releaseLock, checkSharedRate } = await import("./store/lock.js");

// ── Fake Redis — שרת אחד, כמה "תהליכים" מתחברים אליו ────
// שעון מדומה, כדי לבדוק תפוגה בלי להמתין באמת.
class FakeRedis {
  constructor(shared = { data: new Map(), now: Date.now() }) { this.s = shared; }
  get now() { return this.s.now; }
  advance(ms) { this.s.now += ms; }
  #alive(rec) { return rec && (rec.px == null || rec.px > this.now); }
  #read(k) { const r = this.s.data.get(k); if (!this.#alive(r)) { this.s.data.delete(k); return null; } return r; }

  async set(key, value, opts = {}) {
    const rec = this.#read(key);
    if (opts.NX && rec) return null;                 // Redis מחזיר null כשה-NX נכשל
    this.s.data.set(key, { v: String(value), px: opts.PX ? this.now + opts.PX : null });
    return "OK";
  }
  async get(key) { return this.#read(key)?.v ?? null; }
  async del(key) { return this.s.data.delete(key) ? 1 : 0; }
  async eval(script, { keys = [], arguments: args = [] } = {}) {
    // הסקריפט היחיד שהקוד שולח: compare-and-delete.
    const rec = this.#read(keys[0]);
    if (rec && rec.v === args[0]) { this.s.data.delete(keys[0]); return 1; }
    return 0;
  }
  async incrBy(key, by) {
    const rec = this.#read(key);
    const v = (rec ? Number(rec.v) : 0) + by;
    this.s.data.set(key, { v: String(v), px: rec?.px ?? null });
    return v;
  }
  async pExpire(key, ms) { const r = this.#read(key); if (!r) return 0; r.px = this.now + ms; return 1; }
  async pTTL(key) { const r = this.#read(key); return r ? (r.px == null ? -1 : r.px - this.now) : -2; }
  async ping() { return "PONG"; }
  async quit() { return "OK"; }
}

let saved;
beforeEach(() => { if (saved !== undefined) setStore(saved); });

// ════════════════════════════════════════════════════════
//  ברירת מחדל — התנהגות זהה להיום
// ════════════════════════════════════════════════════════
test("ברירת מחדל: בלי REDIS_URL עובדים בזיכרון, בלי תלות חיצונית", () => {
  const s = createStore({ redisUrl: null });
  assert.equal(s.kind, "memory");
  assert.ok(s instanceof MemoryStore);
});

test("ברירת מחדל: הנעילה עובדת בדיוק כמו היום (סריאליזציה per-key)", async () => {
  saved = setStore(new MemoryStore());
  assert.equal(isDistributed(), false);

  const order = [];
  const slow = (tag, ms) => async () => { order.push(`${tag}:start`); await new Promise(r => setTimeout(r, ms)); order.push(`${tag}:end`); };
  await Promise.all([
    withGuestLock("guest-1", slow("a", 30)),
    withGuestLock("guest-1", slow("b", 1)),
  ]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"], "🔴 שתי הודעות של אותו אורח רצו במקביל");
});

test("ברירת מחדל: אורחים שונים רצים במקביל ולא חוסמים זה את זה", async () => {
  saved = setStore(new MemoryStore());
  const order = [];
  await Promise.all([
    withGuestLock("g1", async () => { await new Promise(r => setTimeout(r, 25)); order.push("g1"); }),
    withGuestLock("g2", async () => { order.push("g2"); }),
  ]);
  assert.deepEqual(order, ["g2", "g1"], "אורח מהיר לא המתין לאיטי");
});

// ════════════════════════════════════════════════════════
//  MemoryStore — הסמנטיקה הבסיסית
// ════════════════════════════════════════════════════════
test("MemoryStore: setIfAbsent, deleteIfEquals ותפוגה", async () => {
  const s = new MemoryStore();
  assert.equal(await s.setIfAbsent("k", "t1", { ttlMs: 50 }), true);
  assert.equal(await s.setIfAbsent("k", "t2", { ttlMs: 50 }), false, "מפתח תפוס");

  assert.equal(await s.deleteIfEquals("k", "wrong"), false, "🔴 שחרור נעילה של אחר");
  assert.equal(await s.deleteIfEquals("k", "t1"), true);
  assert.equal(await s.setIfAbsent("k", "t3", { ttlMs: 20 }), true, "אחרי שחרור אפשר לתפוס");

  await new Promise(r => setTimeout(r, 40));
  assert.equal(await s.setIfAbsent("k", "t4", { ttlMs: 20 }), true, "נעילה שפגה משוחררת מעצמה");
});

test("MemoryStore: increment עם חלון זמן", async () => {
  const s = new MemoryStore();
  assert.equal(await s.increment("c", { ttlMs: 30 }), 1);
  assert.equal(await s.increment("c", { ttlMs: 30 }), 2);
  await new Promise(r => setTimeout(r, 45));
  assert.equal(await s.increment("c", { ttlMs: 30 }), 1, "החלון התאפס");
});

// ════════════════════════════════════════════════════════
//  RedisStore — מול fake שמדבר את פקודות Redis האמיתיות
// ════════════════════════════════════════════════════════
test("RedisStore: דורש לקוח מוזרק ולא ממציא חיבור", () => {
  assert.throws(() => new RedisStore({}), /injected client/);
});

test("RedisStore: נעילה בלעדית — רק אחד תופס", async () => {
  const shared = { data: new Map(), now: Date.now() };
  const s = new RedisStore({ client: new FakeRedis(shared) });
  assert.equal(await s.setIfAbsent("lock:x", "A", { ttlMs: 5000 }), true);
  assert.equal(await s.setIfAbsent("lock:x", "B", { ttlMs: 5000 }), false);
  assert.equal(await s.get("lock:x"), "A");
});

// 🔴 באג אמיתי שנתפס כאן: זיהוי הדיאלקט היה ניחוש, ומול לקוח תקין הוא
//    נכשל — הפרמטרים נשלחו בסגנון הלא נכון, `NX` נבלע, ו**כל נעילה
//    "הצליחה"**. ההגנה כולה הייתה מדומה בזמן שהכול נראה עובד.
class FakeIoRedis extends FakeRedis {
  defineCommand() {}   // הסימן הייחודי ל-ioredis
  // ioredis: set(key, val, "PX", ms, "NX")
  async set(key, value, ...args) {
    const nx = args.includes("NX");
    const pxIdx = args.indexOf("PX");
    const px = pxIdx >= 0 ? Number(args[pxIdx + 1]) : null;
    return super.set(key, value, { NX: nx, PX: px });
  }
  // ioredis: eval(script, numKeys, ...keys, ...args)
  async eval(script, numKeys, key, arg) { return super.eval(script, { keys: [key], arguments: [arg] }); }
  async incrby(key, by) { return super.incrBy(key, by); }
  async pexpire(key, ms) { return super.pExpire(key, ms); }
  async pttl(key) { return super.pTTL(key); }
}

test("RedisStore: מזהה ioredis ושומר על אותה סמנטיקה בדיוק", async () => {
  const shared = { data: new Map(), now: Date.now() };
  const s = new RedisStore({ client: new FakeIoRedis(shared) });
  assert.equal(s.dialect, "ioredis");
  assert.equal(await s.setIfAbsent("lock:io", "A", { ttlMs: 5000 }), true);
  assert.equal(await s.setIfAbsent("lock:io", "B", { ttlMs: 5000 }), false,
    "🔴 NX נבלע — כל נעילה 'מצליחה' וההגנה מדומה");
  assert.equal(await s.deleteIfEquals("lock:io", "B"), false);
  assert.equal(await s.deleteIfEquals("lock:io", "A"), true);
  assert.equal(await s.increment("rate:io", { ttlMs: 1000 }), 1);
});

test("RedisStore: node-redis מזוהה כברירת מחדל", () => {
  assert.equal(new RedisStore({ client: new FakeRedis() }).dialect, "node-redis");
});

test("RedisStore: שחרור מותנה — לא משחררים נעילה של אחר", async () => {
  const s = new RedisStore({ client: new FakeRedis() });
  await s.setIfAbsent("lock:y", "OWNER", { ttlMs: 5000 });
  assert.equal(await s.deleteIfEquals("lock:y", "SOMEONE_ELSE"), false,
    "🔴 תהליך שיחרר נעילה שאינה שלו — התקלה הקלאסית של נעילות מבוזרות");
  assert.equal(await s.deleteIfEquals("lock:y", "OWNER"), true);
});

test("RedisStore: נעילה פגה מעצמה — תהליך שקרס לא נועל לנצח", async () => {
  const shared = { data: new Map(), now: Date.now() };
  const client = new FakeRedis(shared);
  const s = new RedisStore({ client });
  await s.setIfAbsent("lock:z", "DEAD_PROCESS", { ttlMs: 1000 });
  assert.equal(await s.setIfAbsent("lock:z", "NEW", { ttlMs: 1000 }), false);
  client.advance(1500);
  assert.equal(await s.setIfAbsent("lock:z", "NEW", { ttlMs: 1000 }), true, "🔴 האורח היה ננעל לנצח");
});

test("RedisStore: increment קובע TTL רק בפעם הראשונה", async () => {
  const shared = { data: new Map(), now: Date.now() };
  const client = new FakeRedis(shared);
  const s = new RedisStore({ client });
  assert.equal(await s.increment("rate:a", { ttlMs: 1000 }), 1);
  client.advance(600);
  assert.equal(await s.increment("rate:a", { ttlMs: 1000 }), 2);
  client.advance(500);   // סה"כ 1100ms מההגדלה הראשונה
  assert.equal(await s.increment("rate:a", { ttlMs: 1000 }), 1,
    "🔴 החלון התארך ולא התאפס — הגבלת קצב שלא משחררת לעולם");
});

// ════════════════════════════════════════════════════════
//  התרחיש שבגללו כל זה קיים: שני תהליכים
// ════════════════════════════════════════════════════════
test("שני תהליכים: אותו אורח לא מעובד פעמיים במקביל", async () => {
  // שרת Redis אחד, שני "תהליכים" — כל אחד עם ה-store שלו.
  const shared = { data: new Map(), now: Date.now() };
  const storeA = new RedisStore({ client: new FakeRedis(shared) });
  const storeB = new RedisStore({ client: new FakeRedis(shared) });

  let active = 0, maxActive = 0;
  const work = async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 30));
    active--;
  };

  // כל "תהליך" מריץ עם ה-store שלו — בדיוק כמו שני עותקים ב-Railway.
  const run = async (s) => {
    const prev = setStore(s);
    try { return await withGuestLock("kempinski +972500000001", work, { waitMs: 3000 }); }
    finally { setStore(prev); }
  };

  saved = setStore(storeA);
  await Promise.all([run(storeA), run(storeB)]);
  assert.equal(maxActive, 1, `🔴 האורח עובד בשני תהליכים במקביל (maxActive=${maxActive}) — צ'ק אין נדרס או הזמנה כפולה`);
});

test("שני תהליכים: הגבלת קצב משותפת — לא פי מספר התהליכים", async () => {
  const shared = { data: new Map(), now: Date.now() };
  const a = new RedisStore({ client: new FakeRedis(shared) });
  const b = new RedisStore({ client: new FakeRedis(shared) });

  const hit = async (s) => { const prev = setStore(s); try { return await checkSharedRate("guest-x", { limit: 3, windowMs: 60_000 }); } finally { setStore(prev); } };

  saved = setStore(a);
  assert.equal((await hit(a)).allowed, true);   // 1
  assert.equal((await hit(b)).allowed, true);   // 2 — תהליך אחר, אותו מונה
  assert.equal((await hit(a)).allowed, true);   // 3
  const fourth = await hit(b);
  assert.equal(fourth.allowed, false, "🔴 המונה אינו משותף — כל תהליך סופר לעצמו");
  assert.equal(fourth.count, 4);
});

// ════════════════════════════════════════════════════════
//  עמידות — תקלה ב-store לא משביתה את המלון
// ════════════════════════════════════════════════════════
test("עמידות: Redis שנפל לא חוסם אורחים (fail-open)", async () => {
  const broken = {
    kind: "redis",
    async setIfAbsent() { throw new Error("ECONNREFUSED"); },
    async deleteIfEquals() { throw new Error("ECONNREFUSED"); },
    async increment() { throw new Error("ECONNREFUSED"); },
    async get() { throw new Error("ECONNREFUSED"); },
  };
  saved = setStore(broken);

  let ran = false;
  await withGuestLock("g", async () => { ran = true; });
  assert.equal(ran, true, "🔴 תקלת Redis השאירה אורח בלי מענה");

  const r = await checkSharedRate("g", { limit: 1 });
  assert.equal(r.allowed, true, "בתקלה לא חוסמים");
  assert.equal(r.degraded, true, "אבל מסמנים שהמצב מדורדר");
});

test("עמידות: נעילה תפוסה לאורך זמן — ממשיכים במקום להשאיר אורח תקוע", async () => {
  const shared = { data: new Map(), now: Date.now() };
  const s = new RedisStore({ client: new FakeRedis(shared) });
  saved = setStore(s);
  // תהליך אחר מחזיק את הנעילה
  await s.setIfAbsent("lock:stuck", "OTHER", { ttlMs: 60_000 });

  let ran = false;
  await withGuestLock("stuck", async () => { ran = true; }, { waitMs: 120 });
  assert.equal(ran, true, "אחרי המתנה סבירה ממשיכים — אורח לא נשאר בלי תשובה");
});

test("acquire/release ידניים מחזירים טוקן ומשחררים אותו", async () => {
  saved = setStore(new MemoryStore());
  const t = await acquireLock("manual", { ttlMs: 1000, waitMs: 100 });
  assert.ok(t, "התקבל טוקן");
  assert.equal(await releaseLock("manual", t), true);
  assert.equal(await releaseLock("manual", t), false, "שחרור כפול אינו מצליח פעמיים");
});

test("storeKind מדווח נכון", () => {
  saved = setStore(new MemoryStore());
  assert.equal(storeKind(), "memory");
  setStore(new RedisStore({ client: new FakeRedis() }));
  assert.equal(storeKind(), "redis");
  assert.equal(isDistributed(), true);
});
