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
`);

// מוודא שקיימת שורת stats למלון (idempotent). שלבים הבאים יעדכנו אותה.
db.prepare(
  `INSERT OR IGNORE INTO stats (hotel_id) VALUES (?)`
).run(DEFAULT_HOTEL_ID);
