// ════════════════════════════════════════════════════════
//  PgDriver — PostgreSQL מאחורי אותה שכבה כמו SQLite
//  ----------------------------------------------------------
//  ── למה זה לא "החלפת דרייבר" ───────────────────────────
//  `node:sqlite` **סינכרוני** ו-`pg` **אסינכרוני**. אי אפשר לעטוף
//  אסינכרוני בסינכרוני ב-Node — אין דרך לחכות לתוצאה בלי `await`.
//  לכן המעבר נשען על שלוש עובדות ארכיטקטוניות שכבר קיימות בקוד:
//
//   1. **קריאות זמן-ריצה כמעט לא נוגעות ב-DB.** `state.js`/`checkin.js`
//      מחזיקים cache חי בזיכרון; הקריאות הן ממנו. ה-DB נקרא בעיקר
//      **בעליית התהליך** (הידרציה) — ושם `await` מותר.
//   2. **הכתיבות הן write-through ולא נקראות בחזרה מיד.** לכן אפשר
//      לתור אותן ולשטוף אסינכרונית, כל עוד **הסדר נשמר**.
//   3. הקריאות הבודדות שכן קורות בזמן ריצה (פרופיל אורח, מסמכי זיהוי,
//      מונה חשבוניות) יושבות כולן בהקשר אסינכרוני ממילא.
//
//  ── מה שהתור מבטיח, ומה שלא ────────────────────────────
//  ✅ **סדר**: כתיבות מבוצעות בסדר שבו נוצרו. שתי פעולות על אותה שורה
//     לא יתהפכו.
//  ✅ **אין אובדן בשגרה**: `flush()` ממתין לכל מה שבתור; נקרא בכיבוי
//     חינני ובנקודות קריטיות (תשלום, חשבונית).
//  ⚠️ **חלון עמידות**: קריסה *פתאומית* עלולה לאבד כתיבות שטרם נשטפו.
//     לכן מסלולי כסף קוראים `flush()` במפורש ולא נשענים על התור.
//
//  ⚠️ **מה שלא נבדק כאן**: אין שרת Postgres בסביבת הפיתוח הזו. הלוגיקה
//     (תור, סדר, הידרציה, מונה אטומי) נבדקת מול לקוח מזויף שמדבר את
//     אותו פרוטוקול; החיבור עצמו מחייב `psql -f store/pg-schema.sql`
//     והרצת הבדיקות מול מסד אמיתי. ראה STORE.md.
// ════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export class PgDriver {
  kind = "postgres";

  /**
   * client — לקוח `pg` מוזרק (Pool או Client מחובר). מוזרק ולא נוצר כאן
   * מאותה סיבה כמו ב-RedisStore: הפרויקט לא נושא תלות שלא כולם צריכים,
   * וזו הדרך היחידה לבדוק את המסלול בלי שרת.
   */
  constructor({ client = null, url = null } = {}) {
    if (!client) {
      throw new Error(
        "PgDriver requires an injected client: new PgDriver({ client }) with a connected `pg` Pool. See STORE.md."
      );
    }
    this.client = client;
    this.url = url;
    this.queue = new WriteQueue(this);
  }

  // pg משתמש ב-$1,$2 ולא ב-?. הקוד הקיים כתוב עם ?, ולכן ממירים כאן —
  // במקום אחד, במקום לשכתב עשרות שאילתות.
  static toPgSql(sql) {
    let i = 0;
    return String(sql).replace(/\?/g, () => `$${++i}`);
  }

  async query(sql, params = []) {
    const res = await this.client.query(PgDriver.toPgSql(sql), params);
    return res?.rows ?? [];
  }

  async get(sql, params = []) {
    const rows = await this.query(sql, params);
    return rows[0] ?? null;
  }

  async run(sql, params = []) {
    const res = await this.client.query(PgDriver.toPgSql(sql), params);
    return { changes: res?.rowCount ?? 0 };
  }

  async exec(sql) {
    await this.client.query(String(sql));
  }

  /** כתיבה מתורת — לא מחזירה תוצאה, אך שומרת על הסדר. */
  write(sql, params = []) { this.queue.push(sql, params); }

  /** ממתין לכל מה שבתור. נקרא בכיבוי ובמסלולי כסף. */
  flush() { return this.queue.flush(); }

  /** יוצר את הסכימה מקובץ ה-SQL (idempotent). */
  async initSchema() {
    const sql = fs.readFileSync(path.join(HERE, "pg-schema.sql"), "utf8");
    await this.exec(sql);
  }

  /**
   * מספר חשבונית רץ — **אטומי**.
   * 🔴 ב-SQLite זה עבד רק כי התהליך חד-חוטי. עם Postgres וכמה תהליכים,
   *    שני צ'ק אאוטים בו-זמנית היו מקבלים את אותו מספר — כלומר שתי
   *    חשבוניות מס עם אותו מספר סידורי. זו בעיה **חוקית**, לא באג תצוגה.
   *    `UPDATE … RETURNING` נועל את השורה ומחזיר ערך ייחודי בעסקה אחת.
   */
  async nextInvoiceSeq(hotelId, year = new Date().getFullYear()) {
    await this.run(
      `INSERT INTO invoice_counters (hotel_id, year, seq) VALUES (?, ?, 0)
       ON CONFLICT (hotel_id, year) DO NOTHING`, [hotelId, year],
    );
    const row = await this.get(
      `UPDATE invoice_counters SET seq = seq + 1
        WHERE hotel_id = ? AND year = ? RETURNING seq`, [hotelId, year],
    );
    return Number(row?.seq);
  }

  async ping() {
    try { await this.client.query("SELECT 1"); return true; } catch { return false; }
  }

  async close() {
    await this.flush();
    try { await this.client.end?.(); } catch { /* ignore */ }
  }
}

// ════════════════════════════════════════════════════════
//  WriteQueue — כתיבות אסינכרוניות בסדר, מאחורי API סינכרוני
// ════════════════════════════════════════════════════════
//  זה מה שמאפשר ל-`patchSession()` להישאר סינכרוני מול Postgres.
//  הקורא ממשיך מיד; הכתיבה מתבצעת ברקע, **בסדר**, ואפשר להמתין לה.
export class WriteQueue {
  constructor(driver, { onError = null } = {}) {
    this.driver = driver;
    this.items = [];
    this.running = false;
    this.onError = onError;
    this.errors = 0;
    this.written = 0;
    this._idle = Promise.resolve();
  }

  push(sql, params = []) {
    this.items.push({ sql, params });
    if (!this.running) this._idle = this.#drain();
    return this._idle;
  }

  async #drain() {
    this.running = true;
    try {
      while (this.items.length) {
        // shift ולא splice: הסדר הוא ההבטחה המרכזית של התור.
        const { sql, params } = this.items.shift();
        try {
          await this.driver.run(sql, params);
          this.written++;
        } catch (e) {
          this.errors++;
          // כתיבה שנכשלה לא עוצרת את התור — אחרת תקלה אחת הייתה
          // מקפיאה את כל ההתמדה של המערכת.
          (this.onError || defaultOnError)(e, sql);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** ממתין לניקוז מלא של התור (כולל פריטים שנוספו תוך כדי). */
  async flush() {
    while (this.items.length || this.running) {
      await this._idle;
      // פריט שנוסף בדיוק בזמן הניקוז — מנקזים שוב.
      if (this.items.length && !this.running) this._idle = this.#drain();
    }
  }

  stats() { return { pending: this.items.length, written: this.written, errors: this.errors, running: this.running }; }
}

function defaultOnError(e, sql) {
  console.error(`🚨 כתיבה ל-DB נכשלה (${String(sql).slice(0, 60)}…):`, e?.message || e);
}
