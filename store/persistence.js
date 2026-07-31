// ════════════════════════════════════════════════════════
//  PERSISTENCE — בחירת מסד הנתונים ואתחולו
//  ----------------------------------------------------------
//  נקודת ההחלפה היחידה בין SQLite ל-Postgres, בדיוק כמו `payments/`,
//  `pms/` ו-`store/`.
//
//   • אין `DATABASE_URL`  → SQLite (ברירת מחדל). **התנהגות זהה להיום.**
//   • יש `DATABASE_URL`   → Postgres, עם לקוח `pg` מוזרק.
//
//  ⚠️ ההפעלה מפורשת ואינה "קורית מעצמה" בייבוא: הידרציה מ-Postgres היא
//     אסינכרונית, ולכן חייבת לרוץ **לפני** שהשרת מתחיל לקבל תעבורה.
//     `server.js` קורא ל-`initPersistence()` לפני `listen`.
// ════════════════════════════════════════════════════════
import { setPgDriver, isPostgres, pgDriver, DEFAULT_HOTEL_ID } from "../db.js";
import { PgDriver } from "./PgDriver.js";

let _state = { kind: "sqlite", ready: true, hydrated: 0 };

export function persistenceKind() { return _state.kind; }
export function persistenceState() { return { ..._state }; }

/**
 * מפעיל את שכבת ההתמדה.
 *
 * client — לקוח `pg` מחובר. מוזרק כדי שהפרויקט לא ייקח תלות ב-`pg`
 * (5 תלויות בלבד), וכדי שאפשר יהיה לבדוק את המסלול בלי שרת.
 *
 * חיבור אמיתי:
 *     import pg from "pg";                       // npm i pg
 *     const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 *     await initPersistence({ client: pool });
 */
export async function initPersistence({ client = null, url = process.env.DATABASE_URL } = {}) {
  if (!url && !client) {
    _state = { kind: "sqlite", ready: true, hydrated: 0 };
    return _state;
  }
  if (!client) {
    // 🔴 לא מנסים לייבא `pg` דינמית ולהיכשל בשקט: זו הייתה נפילה שקטה
    //    שבה הענן היה עולה על SQLite בלי שאיש ידע. עדיף לצעוק.
    throw new Error(
      "DATABASE_URL מוגדר אך לא הוזרק לקוח Postgres. " +
      "יש להתקין `pg` ולקרוא ל-initPersistence({ client: pool }). ראה STORE.md."
    );
  }

  const driver = new PgDriver({ client, url });
  if (!(await driver.ping())) {
    throw new Error("Postgres אינו מגיב — בדקו את DATABASE_URL ואת הרשת.");
  }
  await driver.initSchema();
  setPgDriver(driver);

  // שורת stats למלון ברירת המחדל (idempotent), כמו במסלול SQLite.
  await driver.run(
    `INSERT INTO stats (hotel_id) VALUES (?) ON CONFLICT (hotel_id) DO NOTHING`,
    [DEFAULT_HOTEL_ID],
  );

  _state = { kind: "postgres", ready: true, hydrated: 0 };
  console.log(`🗄️  התמדה: PostgreSQL פעיל (סכימה מאומתת)`);
  return _state;
}

/** ממתין לכל הכתיבות שבתור. נקרא בכיבוי חינני ובמסלולי כסף. */
export async function flushPersistence() {
  if (isPostgres()) await pgDriver().flush();
}

/** לניטור: כמה כתיבות ממתינות/נכתבו/נכשלו. */
export function persistenceStats() {
  return isPostgres() ? pgDriver().queue.stats() : { pending: 0, written: 0, errors: 0, running: false };
}
