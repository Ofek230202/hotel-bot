// ════════════════════════════════════════════════════════
//  RedisStore — אותה סמנטיקה, משותפת לכל התהליכים והמכונות
//  ----------------------------------------------------------
//  הלקוח **מוזרק** (`client`) ואינו נוצר כאן, משתי סיבות:
//   1. הפרויקט מחזיק 5 תלויות בלבד. הוספת דרייבר Redis כתלות קשיחה
//      תפגע בכל מי שלא צריך אותו.
//   2. זו הדרך היחידה לבדוק את המסלול הזה בלי שרת אמיתי — הבדיקות
//      מזריקות fake שמממש את אותן פקודות בדיוק.
//
//  תואם ל-API של `redis` (node-redis v4) ושל `ioredis` דרך שכבת התאמה
//  דקה ב-`#call`. חיבור אמיתי:
//      import { createClient } from "redis";
//      const client = createClient({ url: process.env.REDIS_URL });
//      await client.connect();
//      setStore(new RedisStore({ client }));
//
//  🔴 שחרור נעילה נעשה ב-Lua אטומי (compare-and-delete). GET ואז DEL
//     אינם אטומיים: בין השניים הנעילה יכולה לפוג ולהילקח ע"י תהליך אחר,
//     ואז היינו משחררים נעילה של מישהו אחר — התקלה הקלאסית של נעילות
//     מבוזרות, והיא נדירה מספיק כדי להתגלות רק בפרודקשן.
// ════════════════════════════════════════════════════════

const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export class RedisStore {
  kind = "redis";

  constructor({ client = null, url = null, dialect = null } = {}) {
    if (!client) {
      throw new Error(
        "RedisStore requires an injected client. Create one with the `redis` package and pass it: " +
        "new RedisStore({ client }). See STORE.md."
      );
    }
    this.client = client;
    this.url = url;
    // 🔴 זיהוי הדיאלקט חייב להיות ודאי ולא ניחוש. הגרסה הראשונה ניחשה
    //    לפי `client.set.length` ולפי קיום `options` — ושתי הבדיקות נכשלו
    //    מול לקוח תקין לחלוטין. התוצאה הייתה הרסנית ושקטה: הפרמטרים
    //    נשלחו בסגנון הלא נכון, `NX` נבלע, ו**כל נעילה "הצליחה"** — כלומר
    //    ההגנה כולה הייתה מדומה בזמן שהכול נראה עובד.
    //    כאן ההבחנה חד-משמעית: `defineCommand` קיים ב-ioredis בלבד.
    this.dialect = dialect || (typeof client.defineCommand === "function" ? "ioredis" : "node-redis");
  }

  async #set(key, value, mode) {
    const c = this.client;
    const io = this.dialect === "ioredis";
    let res;
    if (mode?.nx) {
      res = io ? await c.set(key, value, "PX", mode.ttlMs, "NX")
               : await c.set(key, value, { NX: true, PX: mode.ttlMs });
    } else if (mode?.ttlMs) {
      res = io ? await c.set(key, value, "PX", mode.ttlMs)
               : await c.set(key, value, { PX: mode.ttlMs });
    } else {
      res = await c.set(key, value);
    }
    // NX שנכשל מחזיר null (node-redis) או null/undefined (ioredis).
    return res === "OK" || res === true;
  }

  async get(key) {
    const v = await this.client.get(key);
    if (v === null || v === undefined) return null;
    // ערכים נשמרים כמחרוזת ב-Redis; מספרים מוחזרים כמספרים כדי
    // שההתנהגות תהיה זהה ל-MemoryStore.
    const n = Number(v);
    return v !== "" && Number.isFinite(n) && String(n) === String(v) ? n : v;
  }

  async set(key, value, { ttlMs = null } = {}) {
    return this.#set(key, String(value), ttlMs ? { ttlMs } : null);
  }

  async setIfAbsent(key, value, { ttlMs = 30_000 } = {}) {
    return this.#set(key, String(value), { nx: true, ttlMs });
  }

  async deleteIfEquals(key, value) {
    const res = this.dialect === "ioredis"
      ? await this.client.eval(RELEASE_LUA, 1, key, String(value))
      : await this.client.eval(RELEASE_LUA, { keys: [key], arguments: [String(value)] });
    return Number(res) === 1;
  }

  async delete(key) { return (await this.client.del(key)) > 0; }

  async increment(key, { ttlMs = 60_000, by = 1 } = {}) {
    const c = this.client;
    const v = this.dialect === "ioredis" ? await c.incrby(key, by) : await c.incrBy(key, by);
    // TTL נקבע רק בהגדלה הראשונה, אחרת החלון היה מתארך בכל פנייה ולא
    // היה מתאפס לעולם — הגבלת קצב שנועלת אורח לצמיתות.
    if (Number(v) === by) {
      if (this.dialect === "ioredis") await c.pexpire(key, ttlMs);
      else await c.pExpire(key, ttlMs);
    }
    return Number(v);
  }

  async ttl(key) {
    const c = this.client;
    return Number(this.dialect === "ioredis" ? await c.pttl(key) : await c.pTTL(key));
  }

  async ping() {
    try { const r = await this.client.ping(); return r === "PONG" || r === true; }
    catch { return false; }
  }

  async close() { try { await this.client.quit?.(); } catch { /* ignore */ } }
}
