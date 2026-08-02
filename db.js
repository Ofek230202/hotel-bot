// ════════════════════════════════════════════════════════
//  DB — persistence layer (SQLite via node:sqlite)
//  ----------------------------------------------------------
//  נקודת החיבור היחידה למסד הנתונים. כאן — ורק כאן — נפתח קובץ
//  ה-DB ומוגדרת הסכימה. שאר הקוד (state.js / checkin.js) ייגש
//  ל-DB דרך המודול הזה בלבד, בדיוק כמו ששכבת payments/ מבודדת
//  את ספק התשלום.
//
//  למה SQLite: קובץ אחד, בלי שרת להריץ, ACID אמיתי (transactions),
//  ומספיק בשפע לנפח של מלון–שניים. מעבר ל-Postgres בעתיד = החלפה
//  במקום אחד.
//
//  למה node:sqlite: SQLite מובנה בתוך Node עצמו (מ-Node 22+), עם API
//  סינכרוני — מחזיר תוצאה מיד בלי await. שני יתרונות: (1) אפס תלויות
//  native ואפס קומפילציה (better-sqlite3 דרש Python + build tools
//  שלא היו זמינים). (2) קוד סינכרוני מאפשר להחליף את הפנימיות של
//  getSession/patchSession/addFolioItem (הסינכרוניות היום) בלי להפוך
//  את כל הקוד ל-async ובלי לשבור את bot.js.
//
//  צרכנים: state.js (sessions/alerts/incidents/stats), checkin.js
//  (reservations+folio) ו-config.js (overrides של קונפיגורציית המלון).
//  כולם עובדים באותה שיטה: cache חי בזיכרון, write-through ל-DB,
//  הידרציה בעליית התהליך — כך שחתימות הפונקציות לא השתנו.
// ════════════════════════════════════════════════════════
import { DatabaseSync } from "node:sqlite";

// מזהה המלון — היום קבוע (מלון אחד). כל טבלה כוללת hotel_id כבר עכשיו,
// כדי שהמעבר ל-multi-tenant בעתיד לא ידרוש מיגרציית סכימה — רק להתחיל
// למלא את העמודה לפי המלון שאליו שייכת ההודעה.
export const DEFAULT_HOTEL_ID = process.env.HOTEL_ID || "kempinski";

// מיקום קובץ ה-DB. ברירת מחדל: hotel.db בשורש הפרויקט. ניתן לעקוף
// עם DB_PATH (למשל נתיב על דיסק קבוע בענן).
const DB_PATH = process.env.DB_PATH || "hotel.db";

export const db = new DatabaseSync(DB_PATH);

// WAL — עמידות טובה יותר וקריאות/כתיבות מקבילות חלקות יותר.
// foreign_keys — אכיפת קשרים בין טבלאות.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// ── synchronous — צוואר הבקבוק שנמדד בעומס ──────────────
// 🔴 ברירת המחדל של SQLite היא `FULL`: **fsync לדיסק בכל כתיבה**. נמדד
//    בבדיקת העומס: 917 כתיבות/שנייה מול 15,625 עם `NORMAL` — פי 17.
//    כל הודעת אורח מבצעת כמה כתיבות (מונה פעילות, היסטוריה, שלב צ'ק אין),
//    ולכן זה היה **החסם היחיד** על קצב המערכת כולה.
//
//    `NORMAL` הוא ההמלצה הרשמית של SQLite ביחד עם WAL. מה הוא מוותר עליו,
//    בכנות: קריסת *אפליקציה* בטוחה לחלוטין (מערכת ההפעלה עדיין כותבת),
//    ורק **נפילת חשמל/קריסת מערכת הפעלה** עלולה לאבד את העסקאות
//    האחרונות. מסד הנתונים לעולם לא נפגם.
//
//    מי שצריך עמידות מקסימלית (למשל SQLite על דיסק קבוע כמסד ייצור
//    יחיד) יכול להחזיר: `SQLITE_SYNCHRONOUS=FULL`. בפרודקשן אמיתית
//    היעד הוא Postgres ממילא, ושם הסוגיה אינה קיימת.
const SQLITE_SYNC = (process.env.SQLITE_SYNCHRONOUS || "NORMAL").toUpperCase();
if (["OFF", "NORMAL", "FULL", "EXTRA"].includes(SQLITE_SYNC)) {
  db.exec(`PRAGMA synchronous = ${SQLITE_SYNC}`);
} else {
  console.warn(`⚠️ SQLITE_SYNCHRONOUS="${SQLITE_SYNC}" אינו ערך מוכר — נשארים על NORMAL.`);
  db.exec("PRAGMA synchronous = NORMAL");
}

// ── סכימה ──────────────────────────────────────────────
// גישה: לכל ישות עמודות "שאילתה" מפורשות (מה שמסננים/ממיינים לפיו)
// + עמודת data JSON שמחזיקה את האובייקט המלא. כך patchSession יכול
// להמשיך לעשות Object.assign חופשי (נקרא JSON, ממזגים, כותבים בחזרה)
// בלי שנצטרך עמודה לכל שדה, וגם נשמרת יכולת סינון יעילה.
db.exec(`
  -- סשנים של אורחים (state.js: sessions). מפתח: מלון + טלפון.
  CREATE TABLE IF NOT EXISTS sessions (
    hotel_id       TEXT NOT NULL,
    phone          TEXT NOT NULL,
    stage          TEXT,
    last_active_at TEXT,
    data           TEXT NOT NULL,          -- אובייקט הסשן המלא (JSON)
    PRIMARY KEY (hotel_id, phone)
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_active
    ON sessions (hotel_id, last_active_at DESC);

  -- הזמנות (checkin.js: reservations). מפתח: מזהה ההזמנה (uuid).
  -- ה-folio (רשימת החיובים) נשמר בתוך data JSON, כדי לשמר את
  -- הפעולות הקיימות עליו (push/reduce/map) בלי טבלה נפרדת.
  CREATE TABLE IF NOT EXISTS reservations (
    id            TEXT PRIMARY KEY,
    hotel_id      TEXT NOT NULL,
    phone         TEXT,
    room_number   TEXT,
    stage         TEXT,
    checkout_date TEXT,                     -- ל-findNoShowReservations
    data          TEXT NOT NULL             -- ההזמנה המלאה + folio (JSON)
  );
  CREATE INDEX IF NOT EXISTS idx_reservations_phone
    ON reservations (hotel_id, phone, stage);
  CREATE INDEX IF NOT EXISTS idx_reservations_room
    ON reservations (hotel_id, room_number, stage);

  -- התראות לצוות (state.js: staffAlerts). ממוינות לפי זמן יורד.
  CREATE TABLE IF NOT EXISTS alerts (
    id       TEXT PRIMARY KEY,
    hotel_id TEXT NOT NULL,
    dept     TEXT,
    priority TEXT,
    at       TEXT,
    data     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_at
    ON alerts (hotel_id, at DESC);

  -- יומן אירועי חירום (state.js: incidents).
  CREATE TABLE IF NOT EXISTS incidents (
    id       TEXT PRIMARY KEY,
    hotel_id TEXT NOT NULL,
    status   TEXT,
    at       TEXT,
    data     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_incidents_at
    ON incidents (hotel_id, at DESC);

  -- קונפיגורציית המלון (config.js). שורה אחת לכל מלון.
  -- ⚠️ נשמרים כאן *רק ה-overrides* — ההפרש מול ברירות המחדל שבקוד,
  -- ולא הקונפיג המלא. זו החלטה מכוונת: כך ערך חדש שמתווסף ל-config.js
  -- (שירות חדש, שדה חדש) מגיע גם למלון שכבר ערך את הקונפיג שלו, במקום
  -- להיחסם על ידי snapshot ישן שנשמר ב-DB.
  CREATE TABLE IF NOT EXISTS config (
    hotel_id   TEXT PRIMARY KEY,
    data       TEXT NOT NULL,          -- overrides בלבד (JSON)
    updated_at TEXT
  );

  -- מונים (state.js: stats). שורה אחת לכל מלון.
  CREATE TABLE IF NOT EXISTS stats (
    hotel_id         TEXT PRIMARY KEY,
    total_messages   INTEGER NOT NULL DEFAULT 0,
    check_ins        INTEGER NOT NULL DEFAULT 0,
    check_outs       INTEGER NOT NULL DEFAULT 0,
    service_requests INTEGER NOT NULL DEFAULT 0,
    emergencies      INTEGER NOT NULL DEFAULT 0
  );

  -- ── מיפוי מספר Twilio נכנס → מלון (multi-tenant routing) ──
  -- כל מלון והמספר שלו. הודעה נכנסת מגיעה עם השדה To (המספר של המלון);
  -- מכאן שולפים לאיזה hotel_id היא שייכת. from_number הוא המספר שממנו
  -- *יוצאות* הודעות לאותו מלון (בד"כ זהה ל-number). זו הנקודה שמפרידה
  -- בין מלונות כבר בכניסה — לפני שנוצר סשן.
  CREATE TABLE IF NOT EXISTS hotel_numbers (
    number      TEXT PRIMARY KEY,   -- E.164 מנורמל, ללא הקידומת whatsapp:
    hotel_id    TEXT NOT NULL,
    from_number TEXT,               -- מספר יוצא (ברירת מחדל: number)
    updated_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_hotel_numbers_hotel
    ON hotel_numbers (hotel_id);

  -- ── רישום מסמכי זיהוי (מטא-דטא בלבד — לא התמונה) ──────
  -- התמונה עצמה מוצפנת בקובץ .enc (או ב-vault/PMS בפרודקשן). כאן נשמר
  -- *רישום* לכל מסמך: מי, מתי, מאיזה סוג, איפה מאוחסן, ומתי צריך למחוק
  -- אותו (retention). בלי רישום כזה אי אפשר לאכוף מדיניות שמירה/מחיקה
  -- ולא לענות על בקשת "מחקו את המידע שלי" (GDPR/חוק הגנת הפרטיות).
  CREATE TABLE IF NOT EXISTS id_documents (
    id             TEXT PRIMARY KEY,
    hotel_id       TEXT NOT NULL,
    reservation_id TEXT,
    phone          TEXT,
    guest_name     TEXT,
    doc_type       TEXT,
    stored_path    TEXT,            -- נתיב הקובץ המוצפן (או מזהה ב-vault)
    encrypted      INTEGER NOT NULL DEFAULT 1,
    status         TEXT,            -- verified | verified_discarded | manual_review
    created_at     TEXT,
    purge_after    TEXT,            -- תאריך שאחריו יימחק אוטומטית (retention)
    deleted_at     TEXT,            -- מתי נמחק בפועל (NULL = קיים)
    extracted_fields TEXT           -- שדות מינימליים שחולצו (JSON) — במקום התמונה
  );
  CREATE INDEX IF NOT EXISTS idx_id_documents_hotel
    ON id_documents (hotel_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_id_documents_purge
    ON id_documents (purge_after);
  CREATE INDEX IF NOT EXISTS idx_id_documents_res
    ON id_documents (hotel_id, reservation_id);

  -- ── פרופיל אורח חוצה-שהיות (Part י') ──────────────────
  -- זיכרון האורח בין ביקורים: כמה שהיות, העדפות אחרונות (קומה/נוף/מיטה),
  -- דירוג אחרון, ודגל VIP (אורח חוזר). זה מה שהופך "פקיד" ל"קונסיירז'
  -- שמכיר אותך". מפתח: מלון + טלפון (בידוד מולטי-טננט).
  CREATE TABLE IF NOT EXISTS guest_profiles (
    hotel_id   TEXT NOT NULL,
    phone      TEXT NOT NULL,
    data       TEXT NOT NULL,          -- { name, stays, preferences, lastRating, vip, ... }
    updated_at TEXT,
    PRIMARY KEY (hotel_id, phone)
  );

  -- ── מונה מספרי חשבונית רץ, פר-מלון ופר-שנה (Part ה') ──
  -- חשבונית מס בישראל חייבת מספר סידורי *רץ ובלתי-שביר*. שומרים מונה
  -- לכל מלון ולכל שנה; nextInvoiceSeq מקדם אותו אטומית (node:sqlite סינכרוני).
  --
  -- 🔴 המפתח הוא (hotel_id, year) ולא hotel_id בלבד — **בדיוק כמו
  --    ב-store/pg-schema.sql**. קודם הם היו שונים: SQLite ספר ברצף בלי
  --    לאפס, Postgres איפס בכל שנה. המספר מודפס בצורה 2026-00042, ולכן
  --    אותה מערכת הייתה מנפיקה מספרי חשבונית *שונים* לפי מסד הנתונים
  --    שבמקרה הוגדר — פער שקט במסמך שיש לו משמעות חוקית.
  CREATE TABLE IF NOT EXISTS invoice_counters (
    hotel_id TEXT    NOT NULL,
    year     INTEGER NOT NULL,
    seq      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hotel_id, year)
  );

  -- ── יומן גישה למסמכי זיהוי (audit trail) ──────────────
  -- כל פתיחה/צפייה/הורדה של מסמך זיהוי נרשמת: מי ניגש, מתי, למה, ומאיזה
  -- IP. זו דרישה של אבטחת מידע — בלי audit אי אפשר לדעת מי ראה PII רגיש.
  CREATE TABLE IF NOT EXISTS id_access_log (
    id          TEXT PRIMARY KEY,
    hotel_id    TEXT NOT NULL,
    document_id TEXT NOT NULL,
    actor       TEXT,              -- מי ניגש (משתמש/טוקן קבלה)
    action      TEXT,              -- view | download | purge | create
    purpose     TEXT,
    ip          TEXT,
    at          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_id_access_doc
    ON id_access_log (document_id, at DESC);
  CREATE INDEX IF NOT EXISTS idx_id_access_hotel
    ON id_access_log (hotel_id, at DESC);
`);

// ── מיגרציות idempotent לטבלאות קיימות (DB שכבר נוצר לפני שדה חדש) ──
// CREATE TABLE IF NOT EXISTS לא מוסיף עמודה לטבלה קיימת, ולכן שדה חדש
// מתווסף כאן דרך ALTER TABLE עטוף ב-try (נכשל בשקט אם העמודה כבר קיימת).
for (const alter of [
  `ALTER TABLE id_documents ADD COLUMN extracted_fields TEXT`,
]) {
  try { db.exec(alter); } catch { /* העמודה כבר קיימת — זה תקין */ }
}

// ── מיגרציה: invoice_counters ל-(hotel_id, year) ───────
// טבלה ישנה עם PK על hotel_id בלבד אינה יכולה להחזיק שורה לכל שנה, ו-ADD
// COLUMN אינו משנה מפתח ראשי. לכן בונים מחדש ומעבירים את הערך הקיים אל
// השנה הנוכחית — כך המספר הסידורי **ממשיך** ולא חוזר אחורה (מספר חשבונית
// שחוזר על עצמו הוא בעיה חוקית, לא אי-נוחות).
try {
  const cols = db.prepare(`PRAGMA table_info(invoice_counters)`).all();
  if (cols.length && !cols.some(c => c.name === "year")) {
    const yr = new Date().getFullYear();
    db.exec(`
      ALTER TABLE invoice_counters RENAME TO invoice_counters_old;
      CREATE TABLE invoice_counters (
        hotel_id TEXT    NOT NULL,
        year     INTEGER NOT NULL,
        seq      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hotel_id, year)
      );
      INSERT INTO invoice_counters (hotel_id, year, seq)
        SELECT hotel_id, ${yr}, seq FROM invoice_counters_old;
      DROP TABLE invoice_counters_old;
    `);
    console.log(`🧾 invoice_counters הועבר למפתח (מלון, שנה) — הרצף נשמר לשנת ${yr}.`);
  }
} catch (e) {
  console.error("⚠️ מיגרציית invoice_counters נכשלה:", e?.message || e);
}

// מוודא שקיימת שורת stats למלון (idempotent). שלבים הבאים יעדכנו אותה.
db.prepare(
  `INSERT OR IGNORE INTO stats (hotel_id) VALUES (?)`
).run(DEFAULT_HOTEL_ID);

// ── מספר חשבונית רץ הבא, פר-מלון (Part ה') ─────────────
// node:sqlite סינכרוני ו-JS חד-חוטי, לכן שלושת הצעדים רצים ללא הפרעה =
// אטומי בתהליך יחיד. מחזיר מספר רץ חדש (1, 2, 3, …) לכל מלון בנפרד.
export function nextInvoiceSeq(hotelId = DEFAULT_HOTEL_ID, year = new Date().getFullYear()) {
  db.prepare(`INSERT INTO invoice_counters (hotel_id, year, seq) VALUES (?, ?, 0) ON CONFLICT(hotel_id, year) DO NOTHING`).run(hotelId, year);
  db.prepare(`UPDATE invoice_counters SET seq = seq + 1 WHERE hotel_id = ? AND year = ?`).run(hotelId, year);
  return db.prepare(`SELECT seq FROM invoice_counters WHERE hotel_id = ? AND year = ?`).get(hotelId, year).seq;
}

// ── מסלול Postgres (אופציונלי) ─────────────────────────
// מוזרק מבחוץ (`setPgDriver`) ולא נוצר כאן, כדי שהפרויקט לא ייקח תלות
// ב-`pg` על מי שלא צריך אותה. כשהוא מוגדר — `nextInvoiceSeqSafe` עוברת
// למסלול האטומי, וזו הנקודה היחידה שבה **חובה** להשתמש בו.
let _pg = null;
export function setPgDriver(driver) { _pg = driver; return _pg; }
export function pgDriver() { return _pg; }
export function isPostgres() { return !!_pg; }

/**
 * מספר חשבונית רץ — הגרסה שבטוחה בשני העולמות.
 *
 * 🔴 למה זו פונקציה נפרדת ולמה היא async: ב-SQLite שלושת הצעדים אטומיים
 *    רק משום שהתהליך חד-חוטי. ברגע שיש Postgres וכמה תהליכים, שני
 *    צ'ק אאוטים בו-זמנית מקבלים את **אותו מספר** — שתי חשבוניות מס עם
 *    מספר סידורי זהה. זו בעיה חוקית, לא באג תצוגה. במסלול Postgres
 *    משתמשים ב-`UPDATE … RETURNING` שנועל את השורה.
 *    כל הקוראים (`issueInvoice`) הם async ממילא.
 */
export async function nextInvoiceSeqSafe(hotelId = DEFAULT_HOTEL_ID, year = new Date().getFullYear()) {
  if (_pg) return _pg.nextInvoiceSeq(hotelId, year);
  return nextInvoiceSeq(hotelId, year);
}
