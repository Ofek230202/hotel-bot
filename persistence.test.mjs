// ════════════════════════════════════════════════════════
//  PERSISTENCE — מסלול Postgres: תור הכתיבות, סדר, ומונה אטומי
//  ----------------------------------------------------------
//  אין שרת Postgres בסביבה הזו, ולכן הלקוח מזויף — אבל הוא מדבר את
//  אותו פרוטוקול בדיוק (`query(text, values)` → `{rows, rowCount}`),
//  כולל `$1` במקום `?` ו-`RETURNING`. מה שנבדק כאן הוא **הלוגיקה**:
//  סדר הכתיבות, אי-אובדן, התנהגות בשגיאה, והאטומיות של מונה החשבוניות.
//
//  ⚠️ מה שלא נבדק: החיבור עצמו והתאמת הסכימה למסד אמיתי. לכך נדרש
//     `psql -f store/pg-schema.sql` והרצה חוזרת. מתועד ב-STORE.md.
// ════════════════════════════════════════════════════════
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshTestDbPath } from "./test-dbpath.mjs";

process.env.DB_PATH = freshTestDbPath("persist");

const { PgDriver, WriteQueue } = await import("./store/PgDriver.js");
const { initPersistence, persistenceKind, flushPersistence, persistenceStats } = await import("./store/persistence.js");
const { setPgDriver, isPostgres, nextInvoiceSeqSafe } = await import("./db.js");

// ── לקוח pg מזויף ───────────────────────────────────────
class FakePg {
  constructor({ failOn = null, latency = 0 } = {}) {
    this.calls = [];
    this.tables = { invoice_counters: new Map() };
    this.failOn = failOn;
    this.latency = latency;
  }
  async query(text, values = []) {
    if (this.latency) await new Promise(r => setTimeout(r, this.latency));
    this.calls.push({ text, values });
    if (this.failOn && text.includes(this.failOn)) throw new Error("pg: syntax error");

    // מונה חשבוניות — מדמים את הסמנטיקה האמיתית, כולל RETURNING.
    if (/INSERT INTO invoice_counters/i.test(text)) {
      const key = `${values[0]}:${values[1]}`;
      if (!this.tables.invoice_counters.has(key)) this.tables.invoice_counters.set(key, 0);
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE invoice_counters[\s\S]*RETURNING seq/i.test(text)) {
      const key = `${values[0]}:${values[1]}`;
      const next = (this.tables.invoice_counters.get(key) || 0) + 1;
      this.tables.invoice_counters.set(key, next);
      return { rows: [{ seq: next }], rowCount: 1 };
    }
    if (/^SELECT 1/i.test(text.trim())) return { rows: [{ "?column?": 1 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }
  async end() { this.ended = true; }
}

// ════════════════════════════════════════════════════════
//  ברירת מחדל — שום דבר לא משתנה
// ════════════════════════════════════════════════════════
test("ברירת מחדל: בלי DATABASE_URL נשארים על SQLite", async () => {
  const s = await initPersistence({ url: null, client: null });
  assert.equal(s.kind, "sqlite");
  assert.equal(persistenceKind(), "sqlite");
  assert.equal(isPostgres(), false);
});

test("DATABASE_URL בלי לקוח — נכשל בקול ולא נופל בשקט ל-SQLite", async () => {
  // 🔴 נפילה שקטה כאן פירושה ענן שרץ על SQLite בזמן שכולם בטוחים
  //    שהוא על Postgres — והנתונים נעלמים בכל redeploy.
  await assert.rejects(
    () => initPersistence({ url: "postgres://x/y", client: null }),
    /לא הוזרק לקוח Postgres/,
  );
});

// ════════════════════════════════════════════════════════
//  המרת SQL
// ════════════════════════════════════════════════════════
test("SQL: ? מומר ל-$1,$2 לפי הסדר", () => {
  assert.equal(
    PgDriver.toPgSql("INSERT INTO t (a,b,c) VALUES (?,?,?)"),
    "INSERT INTO t (a,b,c) VALUES ($1,$2,$3)",
  );
  assert.equal(
    PgDriver.toPgSql("SELECT * FROM t WHERE hotel_id = ? AND phone = ?"),
    "SELECT * FROM t WHERE hotel_id = $1 AND phone = $2",
  );
  assert.equal(PgDriver.toPgSql("SELECT 1"), "SELECT 1", "בלי ? — ללא שינוי");
});

// ════════════════════════════════════════════════════════
//  תור הכתיבות — הסדר הוא ההבטחה
// ════════════════════════════════════════════════════════
test("תור: כתיבות מבוצעות **בסדר** גם כשנדחפו מיד זו אחר זו", async () => {
  const pg = new FakePg({ latency: 1 });
  const d = new PgDriver({ client: pg });

  for (let i = 1; i <= 25; i++) d.write("UPDATE t SET n = ?", [i]);
  await d.flush();

  const order = pg.calls.filter(c => c.text.startsWith("UPDATE t")).map(c => c.values[0]);
  assert.deepEqual(order, Array.from({ length: 25 }, (_, i) => i + 1),
    "🔴 סדר הכתיבות התהפך — שתי פעולות על אותה שורה יכולות לדרוס זו את זו");
});

test("תור: flush ממתין לכל מה שנדחף, כולל תוך כדי הניקוז", async () => {
  const pg = new FakePg({ latency: 1 });
  const d = new PgDriver({ client: pg });

  d.write("UPDATE a SET x = ?", [1]);
  const flushing = d.flush();
  d.write("UPDATE a SET x = ?", [2]);   // נדחף בזמן הניקוז
  await flushing;
  await d.flush();

  assert.equal(d.queue.stats().pending, 0);
  assert.equal(d.queue.stats().written, 2, "שתי הכתיבות בוצעו");
});

test("תור: כתיבה שנכשלת לא עוצרת את השאר", async () => {
  const errors = [];
  const pg = new FakePg({ failOn: "BROKEN" });
  const d = new PgDriver({ client: pg });
  d.queue.onError = (e) => errors.push(e.message);

  d.write("UPDATE ok SET a = ?", [1]);
  d.write("UPDATE BROKEN SET a = ?", [2]);
  d.write("UPDATE ok SET a = ?", [3]);
  await d.flush();

  const st = d.queue.stats();
  assert.equal(st.errors, 1);
  assert.equal(st.written, 2, "🔴 תקלה אחת הקפיאה את כל ההתמדה");
  assert.equal(errors.length, 1);
});

test("תור: כתיבה אינה חוסמת את הקורא", async () => {
  const pg = new FakePg({ latency: 20 });
  const d = new PgDriver({ client: pg });
  const t0 = Date.now();
  d.write("UPDATE t SET a = ?", [1]);   // סינכרוני מבחינת הקורא
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 15, `הכתיבה חסמה ${elapsed}ms — ה-API אמור להישאר סינכרוני`);
  await d.flush();
});

// ════════════════════════════════════════════════════════
//  מונה החשבוניות — הפריט בעל הסיכון החוקי
// ════════════════════════════════════════════════════════
test("חשבוניות: כל קריאה מקבלת מספר ייחודי ועולה", async () => {
  const d = new PgDriver({ client: new FakePg() });
  const seqs = [];
  for (let i = 0; i < 5; i++) seqs.push(await d.nextInvoiceSeq("kempinski", 2026));
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
});

test("חשבוניות: הקצאה מקבילה לא מחלקת את אותו מספר פעמיים", async () => {
  // 🔴 זה בדיוק הכשל שהמעבר ל-Postgres מכניס: ב-SQLite שלושת הצעדים
  //    אטומיים רק כי התהליך חד-חוטי. שתי חשבוניות מס עם אותו מספר
  //    סידורי הן בעיה חוקית, לא באג תצוגה.
  const d = new PgDriver({ client: new FakePg({ latency: 1 }) });
  const seqs = await Promise.all(Array.from({ length: 20 }, () => d.nextInvoiceSeq("lala", 2026)));
  assert.equal(new Set(seqs).size, 20, `🔴 מספרים כפולים: ${seqs.join(",")}`);
  assert.deepEqual([...seqs].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
});

test("חשבוניות: מונה נפרד לכל מלון ולכל שנה", async () => {
  const d = new PgDriver({ client: new FakePg() });
  assert.equal(await d.nextInvoiceSeq("lala", 2026), 1);
  assert.equal(await d.nextInvoiceSeq("kempinski", 2026), 1, "מלון אחר → סדרה נפרדת");
  assert.equal(await d.nextInvoiceSeq("lala", 2027), 1, "שנה אחרת → סדרה נפרדת");
  assert.equal(await d.nextInvoiceSeq("lala", 2026), 2);
});

test("חשבוניות: nextInvoiceSeqSafe עוברת אוטומטית למסלול האטומי", async () => {
  const before = await nextInvoiceSeqSafe("seqtest-hotel");
  assert.equal(typeof before, "number", "SQLite: עובד כמו קודם");

  const d = new PgDriver({ client: new FakePg() });
  setPgDriver(d);
  try {
    assert.equal(isPostgres(), true);
    assert.equal(await nextInvoiceSeqSafe("pg-hotel", 2026), 1);
    assert.equal(await nextInvoiceSeqSafe("pg-hotel", 2026), 2);
  } finally {
    setPgDriver(null);
  }
  assert.equal(isPostgres(), false, "חוזרים ל-SQLite");
});

// ════════════════════════════════════════════════════════
//  אתחול מלא + ניטור
// ════════════════════════════════════════════════════════
test("אתחול: יוצר סכימה, מוודא חיבור, ומדווח", async () => {
  const pg = new FakePg();
  const s = await initPersistence({ client: pg, url: "postgres://fake" });
  try {
    assert.equal(s.kind, "postgres");
    assert.equal(persistenceKind(), "postgres");
    assert.ok(pg.calls.some(c => /CREATE TABLE/i.test(c.text)), "הסכימה נוצרה");
    assert.ok(pg.calls.some(c => /SELECT 1/i.test(c.text)), "החיבור נבדק");
    assert.ok(pg.calls.some(c => /INSERT INTO stats/i.test(c.text)), "שורת stats הובטחה");

    const st = persistenceStats();
    assert.equal(typeof st.pending, "number");
    await flushPersistence();
  } finally {
    setPgDriver(null);
  }
});

test("אתחול: מסד שאינו מגיב נכשל בבירור", async () => {
  const dead = { async query() { throw new Error("ECONNREFUSED"); } };
  await assert.rejects(() => initPersistence({ client: dead, url: "postgres://dead" }), /אינו מגיב/);
  setPgDriver(null);
});

test("סכימת Postgres קיימת ומכילה את כל הטבלאות", async () => {
  const fs = await import("node:fs");
  const sql = fs.readFileSync("store/pg-schema.sql", "utf8");
  for (const t of ["sessions", "reservations", "alerts", "incidents", "config", "stats",
                   "hotel_numbers", "id_documents", "id_access_log", "guest_profiles", "invoice_counters"]) {
    assert.ok(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`).test(sql), `חסרה טבלה: ${t}`);
  }
  // בידוד הטננט נאכף ע"י מפתחות מורכבים, לא רק ע"י זהירות בקוד.
  assert.match(sql, /PRIMARY KEY \(hotel_id, phone\)/, "sessions ממופתח לפי מלון");
  assert.match(sql, /PRIMARY KEY \(hotel_id, year\)/, "מונה החשבוניות פר-מלון-ושנה");
});
