// ════════════════════════════════════════════════════════
//  REPO — התפר היחיד בין הקוד למסד הנתונים
//  ----------------------------------------------------------
//  לפני הקובץ הזה `PgDriver` היה קיים אך **לא זרם בו מידע**: כל
//  `db.prepare(...)` בפרויקט דיבר ישירות עם SQLite, ולכן Postgres קיבל
//  סכימה, ping ומונה חשבוניות — ולא סשן אחד. "מסלול Postgres" שאינו
//  מקבל נתונים אינו מסלול; הוא קובץ.
//
//  כאן זה נסגר. `prepare(sql)` מחזיר משפט שיודע לדבר עם **שניהם**:
//
//  ┌──────────────┬────────────────────┬──────────────────────────────┐
//  │              │ SQLite             │ Postgres                     │
//  ├──────────────┼────────────────────┼──────────────────────────────┤
//  │ .run()       │ סינכרוני           │ נכנס לתור מסודר (לא חוסם)    │
//  │ .get()/.all()│ סינכרוני           │ 🔴 זורק — ראה למטה           │
//  │ .*Async()    │ סינכרוני, עטוף     │ await אמיתי                  │
//  └──────────────┴────────────────────┴──────────────────────────────┘
//
//  ── למה `.run()` יכול להישאר סינכרוני ו-`.get()` לא ────
//  כתיבה היא write-through ואיש אינו קורא אותה בחזרה מיד, ולכן מותר
//  לתור אותה כל עוד **הסדר** נשמר (`WriteQueue`). קריאה, לעומת זאת,
//  מחזירה ערך — ואי אפשר להמתין לו בלי `await`.
//
//  🔴 **ולכן `.get()` ב-Postgres זורק ולא מחזיר null.** זו ההחלטה
//     החשובה בקובץ. `null` שקט פירושו "אין אורח כזה" — כלומר סשן שנטען
//     בהצלחה מ-Postgres היה נראה כאורח חדש, והאורח היה מאבד את השם,
//     החדר, ההיסטוריה ושלב הצ'ק אין באמצע שיחה. שגיאה רועשת בבדיקה
//     עדיפה על אורח שמאבד את הצ'ק אין שלו בפרודקשן.
//
//  ── תאימות לאחור ────────────────────────────────────────
//  בלי `DATABASE_URL` שום דבר לא משתנה: אותו SQLite, אותה סינכרוניות,
//  אותה התנהגות. הקובץ הזה הוא תוספת, לא החלפה.
// ════════════════════════════════════════════════════════
import { db, pgDriver, isPostgres } from "../db.js";

/** נזרקת כשקריאה סינכרונית נדרשת במסלול Postgres. מכוונת לתיקון. */
export class SyncReadUnavailable extends Error {
  constructor(sql) {
    super(
      `קריאה סינכרונית מ-DB אינה אפשרית במסלול Postgres. ` +
      `יש להשתמש ב-getAsync()/allAsync() או לטעון מראש (ensure*Loaded) ` +
      `לפני הקוד הסינכרוני. שאילתה: ${String(sql).replace(/\s+/g, " ").slice(0, 90)}…`
    );
    this.name = "SyncReadUnavailable";
    this.sql = sql;
  }
}

// ── תרגום דיאלקט ──────────────────────────────────────
// Postgres אינו מכיר `INSERT OR IGNORE`. ההמרה נעשית פעם אחת, ב-prepare,
// ולא בכל קריאה.
function toPgDialect(sql) {
  let out = String(sql);
  if (/INSERT\s+OR\s+IGNORE/i.test(out)) {
    out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO");
    if (!/ON\s+CONFLICT/i.test(out)) out = `${out.trimEnd().replace(/;$/, "")} ON CONFLICT DO NOTHING`;
  }
  if (/INSERT\s+OR\s+REPLACE/i.test(out)) {
    // אין תרגום בטוח בלי לדעת את מפתח ההתנגשות — עדיף לצעוק ב-prepare
    // מאשר לכתוב שורה כפולה בשקט.
    throw new Error(`INSERT OR REPLACE אינו נתמך ב-Postgres. השתמשו ב-ON CONFLICT מפורש: ${out.slice(0, 80)}`);
  }
  return out;
}

// שמות פרמטרים בסגנון SQLite (@name), לפי סדר הופעה ראשונה.
// `@` בתוך מחרוזת ליטרלית אינו פרמטר — לכן מתעלמים ממחרוזות.
function namedParams(sql) {
  const stripped = String(sql).replace(/'(?:[^']|'')*'/g, "''");
  const names = [];
  for (const m of stripped.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

// `@name` → `$n` לפי אותו סדר שבו נאסף `names`.
function namedToPositional(sql, names) {
  let out = String(sql);
  names.forEach((n, i) => {
    out = out.replace(new RegExp(`@${n}\\b`, "g"), `$${i + 1}`);
  });
  return out;
}

// `?` → `$1, $2, …`
function positionalToPg(sql) {
  let i = 0;
  return String(sql).replace(/\?/g, () => `$${++i}`);
}

// 🔴 `pg` מחזיר BIGINT כמחרוזת ("5" ולא 5). `COUNT(*)` הוא bigint, ולכן
//    `sessionCount()` היה מחזיר מחרוזת ו-`n > 3000` היה משווה מחרוזות —
//    "999" > "3000" הוא true. מנרמלים כאן, במקום אחד.
function coerceRow(row) {
  if (!row || typeof row !== "object") return row;
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "string" && /^-?\d+$/.test(v) && (k === "n" || k === "seq" || k === "count")) {
      row[k] = Number(v);
    }
  }
  return row;
}

class Statement {
  constructor(sql) {
    this.sql = sql;
    this.names = namedParams(sql);
    this._sqlite = null;    // מוכן בעצלתיים — כך שאילתה שרצה רק ב-PG לא נכשלת ב-SQLite
    this._pg = null;
  }

  #sqlite() {
    if (!this._sqlite) this._sqlite = db.prepare(this.sql);
    return this._sqlite;
  }

  #pgSql() {
    if (!this._pg) {
      const dialect = toPgDialect(this.sql);
      this._pg = this.names.length
        ? namedToPositional(dialect, this.names)
        : positionalToPg(dialect);
    }
    return this._pg;
  }

  // ארגומנטים בסגנון SQLite → מערך פוזיציוני ל-pg.
  #params(args) {
    if (this.names.length) {
      const obj = args[0] || {};
      return this.names.map(n => obj[n] ?? null);
    }
    return args.map(a => (a === undefined ? null : a));
  }

  // ── כתיבה ───────────────────────────────────────────
  // סינכרונית בשני המסלולים: ב-Postgres היא **נכנסת לתור מסודר**, ולכן
  // `patchSession()` וכל שאר הקוד הסינכרוני ממשיכים לעבוד כמו שהם.
  run(...args) {
    if (isPostgres()) {
      pgDriver().write(this.#pgSql(), this.#params(args));
      return { changes: 0, queued: true };
    }
    return this.#sqlite().run(...args);
  }

  /** כתיבה שממתינים לה בפועל (מסלולי כסף, בדיקות). */
  async runAsync(...args) {
    if (isPostgres()) return pgDriver().run(this.#pgSql(), this.#params(args));
    return this.#sqlite().run(...args);
  }

  // ── קריאה סינכרונית — SQLite בלבד, במכוון ───────────
  get(...args) {
    if (isPostgres()) throw new SyncReadUnavailable(this.sql);
    return this.#sqlite().get(...args);
  }

  all(...args) {
    if (isPostgres()) throw new SyncReadUnavailable(this.sql);
    return this.#sqlite().all(...args);
  }

  // ── קריאה אסינכרונית — עובדת בשני המסלולים ──────────
  async getAsync(...args) {
    if (isPostgres()) return coerceRow(await pgDriver().get(this.#pgSql(), this.#params(args)));
    return this.#sqlite().get(...args) ?? null;
  }

  async allAsync(...args) {
    if (isPostgres()) return (await pgDriver().query(this.#pgSql(), this.#params(args))).map(coerceRow);
    return this.#sqlite().all(...args);
  }
}

/**
 * מכין משפט שעובד מול SQLite ומול Postgres.
 * תחליף ישיר ל-`db.prepare` — אותה חתימה, אותה התנהגות ב-SQLite.
 */
export function prepare(sql) { return new Statement(sql); }

/** שאילתה חד-פעמית שה-SQL שלה נבנה בזמן ריצה (למשל `WHERE` דינמי). */
export function queryAll(sql, params = []) {
  if (isPostgres()) throw new SyncReadUnavailable(sql);
  return db.prepare(sql).all(...params);
}

export async function queryAllAsync(sql, params = []) {
  if (isPostgres()) return (await pgDriver().query(positionalToPg(toPgDialect(sql)), params)).map(coerceRow);
  return db.prepare(sql).all(...params);
}

/** לבדיקות ולניטור: מול מה אנחנו באמת מדברים. */
export function repoKind() { return isPostgres() ? "postgres" : "sqlite"; }

export const __test = { toPgDialect, namedParams, namedToPositional, positionalToPg, coerceRow };
