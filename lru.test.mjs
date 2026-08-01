// ════════════════════════════════════════════════════════
//  LruCache — הרכיב שמסיר את תקרת הזיכרון
//  ----------------------------------------------------------
//  נבדק לבד לפני שהוא נוגע בסשנים או בהזמנות: אם הפינוי שגוי, אורח
//  יאבד את ההיסטוריה שלו באמצע שיחה. השעון מוזרק כדי לבדוק תפוגה
//  דטרמיניסטית, בלי המתנות.
// ════════════════════════════════════════════════════════
import { test } from "node:test";
import assert from "node:assert/strict";

const { LruCache } = await import("./store/LruCache.js");

const clock = (start = 1000) => {
  let t = start;
  const fn = () => t;
  fn.advance = (ms) => { t += ms; };
  return fn;
};

test("בסיס: set/get/has/delete/size", () => {
  const c = new LruCache({ max: 10 });
  assert.equal(c.get("a"), undefined);
  c.set("a", 1);
  assert.equal(c.get("a"), 1);
  assert.equal(c.has("a"), true);
  assert.equal(c.size, 1);
  assert.equal(c.delete("a"), true);
  assert.equal(c.delete("a"), false, "מחיקה חוזרת אינה מצליחה");
  assert.equal(c.has("a"), false);
});

test("פינוי: חורגים מהמקסימום → הפחות-שומש לאחרונה יוצא", () => {
  const evicted = [];
  const c = new LruCache({ max: 3, onEvict: (k, v, r) => evicted.push([k, r]) });
  c.set("a", 1); c.set("b", 2); c.set("c", 3);
  c.get("a");                 // a הפך לאחרון שנגענו בו
  c.set("d", 4);              // חריגה → b (הישן ביותר) יוצא

  assert.equal(c.size, 3);
  assert.equal(c.has("b"), false, "🔴 פונה הפריט הלא נכון");
  assert.equal(c.get("a"), 1, "פריט שנגענו בו נשאר");
  assert.equal(c.get("c"), 3);
  assert.equal(c.get("d"), 4);
  assert.deepEqual(evicted, [["b", "evict"]]);
});

test("פינוי: גישה מרעננת את המקום בתור", () => {
  const c = new LruCache({ max: 2 });
  c.set("x", 1); c.set("y", 2);
  c.get("x");           // x נעשה טרי
  c.set("z", 3);        // y יוצא
  assert.equal(c.has("x"), true);
  assert.equal(c.has("y"), false);
});

test("פינוי: set חוזר לאותו מפתח אינו מנפח את ה-cache", () => {
  const c = new LruCache({ max: 2 });
  c.set("a", 1); c.set("a", 2); c.set("a", 3);
  assert.equal(c.size, 1);
  assert.equal(c.get("a"), 3);
});

test("תפוגה: פריט שלא נגעו בו פג, וגישה מחדשת אותו", () => {
  const now = clock();
  const c = new LruCache({ max: 10, ttlMs: 1000, now });
  c.set("a", 1);
  now.advance(600);
  assert.equal(c.get("a"), 1, "עדיין בתוקף");
  now.advance(600);             // 600 מאז הגישה האחרונה → עדיין בתוקף
  assert.equal(c.get("a"), 1, "גישה מרעננת את הזמן");
  now.advance(1500);
  assert.equal(c.get("a"), undefined, "🔴 פריט פג עדיין מוחזר");
  assert.equal(c.stats.expirations, 1);
});

test("תפוגה: ttlMs=0 פירושו ללא תפוגה", () => {
  const now = clock();
  const c = new LruCache({ max: 10, ttlMs: 0, now });
  c.set("a", 1);
  now.advance(10_000_000);
  assert.equal(c.get("a"), 1);
});

test("sweep מנקה פגי-תוקף ומחזיר כמה", () => {
  const now = clock();
  const c = new LruCache({ max: 10, ttlMs: 100, now });
  c.set("a", 1); c.set("b", 2);
  now.advance(200);
  c.set("c", 3);
  assert.equal(c.sweep(), 2);
  assert.equal(c.size, 1);
  assert.equal(c.get("c"), 3);
});

test("values מחזיר חיים בלבד", () => {
  const now = clock();
  const c = new LruCache({ max: 10, ttlMs: 100, now });
  c.set("a", 1); c.set("b", 2);
  now.advance(200);
  c.set("c", 3);
  assert.deepEqual(c.values(), [3]);
});

test("סטטיסטיקה: פגיעות, החטאות ואחוז", () => {
  const c = new LruCache({ max: 2 });
  c.set("a", 1);
  c.get("a"); c.get("a"); c.get("nope");
  const i = c.info();
  assert.equal(i.hits, 2);
  assert.equal(i.misses, 1);
  assert.equal(i.hitRate, 67);
  assert.equal(i.max, 2);
});

test("hook של פינוי לא מפיל את ה-cache", () => {
  const c = new LruCache({ max: 1, onEvict: () => { throw new Error("boom"); } });
  c.set("a", 1);
  assert.doesNotThrow(() => c.set("b", 2), "🔴 שגיאה ב-hook הפילה את ה-cache");
  assert.equal(c.has("b"), true);
});

test("עומס: מיליון הכנסות — הזיכרון נשאר חסום", () => {
  // 🔴 זו כל הנקודה: בלי חסם, מיליון מלונות × אורחים = קריסה.
  const c = new LruCache({ max: 1000 });
  for (let i = 0; i < 1_000_000; i++) c.set(`k${i}`, i);
  assert.equal(c.size, 1000, `🔴 ה-cache גדל ל-${c.size}`);
  assert.equal(c.get("k999999"), 999_999, "האחרונים נשמרו");
  assert.equal(c.get("k0"), undefined, "הישנים פונו");
  assert.ok(c.stats.evictions > 900_000);
});

test("max=1 עובד (מקרה קצה)", () => {
  const c = new LruCache({ max: 1 });
  c.set("a", 1); c.set("b", 2);
  assert.equal(c.size, 1);
  assert.equal(c.has("a"), false);
  assert.equal(c.get("b"), 2);
});
