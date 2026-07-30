-- ════════════════════════════════════════════════════════
--  PostgreSQL schema — מקביל 1:1 לסכימת SQLite ב-db.js
--  ----------------------------------------------------------
--  שינויים מכוונים מול SQLite, וכל אחד מהם מסיבה:
--   • JSONB במקום TEXT — שאילתות על תוכן (למשל "כל הסשנים של מלון X
--     בשלב צ'ק אין") בלי לפרסר בצד האפליקציה.
--   • TIMESTAMPTZ במקום TEXT — השוואות זמן אמיתיות. SQLite שמר ISO
--     כמחרוזת, וזה עבד רק כי ISO ממוין לקסיקוגרפית. בפוסטגרס אין סיבה.
--   • מפתחות ראשיים מורכבים (hotel_id, …) — **בידוד הטננט נאכף ע"י
--     בסיס הנתונים עצמו**, ולא רק ע"י זהירות בקוד.
--   • אינדקסים חלקיים על השורות החמות בלבד — טבלה של מיליוני שורות
--     לא צריכה אינדקס מלא כדי לענות על "מי פעיל עכשיו".
--
--  ⚠️ הסכימה נכתבה מול db.js ונבדקה תחבירית, אך **לא הורצה מול שרת
--     Postgres אמיתי** בסביבה הזו (אין Docker/PG זמין). לפני שימוש:
--     `psql -f store/pg-schema.sql` על מסד ריק, ואז להריץ את הבדיקות.
-- ════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sessions (
  hotel_id       TEXT        NOT NULL,
  phone          TEXT        NOT NULL,
  data           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hotel_id, phone)
);
-- "מי פעיל ב-24 השעות האחרונות" — האינדקס היחיד שהדשבורד באמת צריך.
CREATE INDEX IF NOT EXISTS idx_sessions_active
  ON sessions (hotel_id, last_active_at DESC);
-- חיפוש לפי מספר חדר (הקבלה נכנסת לשיחה של חדר) — רק על סשנים שיש להם חדר.
CREATE INDEX IF NOT EXISTS idx_sessions_room
  ON sessions (hotel_id, (data->>'roomNumber'))
  WHERE data->>'roomNumber' IS NOT NULL;

CREATE TABLE IF NOT EXISTS reservations (
  id         TEXT        PRIMARY KEY,
  hotel_id   TEXT        NOT NULL,
  phone      TEXT,
  room       TEXT,
  stage      TEXT,
  data       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reservations_phone ON reservations (hotel_id, phone);
CREATE INDEX IF NOT EXISTS idx_reservations_room  ON reservations (hotel_id, room);
-- ההזמנות הפעילות בלבד — זו השאילתה החמה (checkout, no-show).
CREATE INDEX IF NOT EXISTS idx_reservations_active
  ON reservations (hotel_id, stage) WHERE stage = 'checked_in';

CREATE TABLE IF NOT EXISTS alerts (
  id       TEXT        PRIMARY KEY,
  hotel_id TEXT        NOT NULL,
  dept     TEXT,
  priority TEXT,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  data     JSONB       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_alerts_at ON alerts (hotel_id, at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id       TEXT        PRIMARY KEY,
  hotel_id TEXT        NOT NULL,
  kind     TEXT,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  data     JSONB       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_incidents_at ON incidents (hotel_id, at DESC);

CREATE TABLE IF NOT EXISTS config (
  hotel_id   TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stats (
  hotel_id         TEXT PRIMARY KEY,
  total_messages   BIGINT NOT NULL DEFAULT 0,
  check_ins        BIGINT NOT NULL DEFAULT 0,
  check_outs       BIGINT NOT NULL DEFAULT 0,
  service_requests BIGINT NOT NULL DEFAULT 0,
  emergencies      BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hotel_numbers (
  number      TEXT        PRIMARY KEY,
  hotel_id    TEXT        NOT NULL,
  from_number TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hotel_numbers_hotel ON hotel_numbers (hotel_id);

CREATE TABLE IF NOT EXISTS id_documents (
  id             TEXT        PRIMARY KEY,
  hotel_id       TEXT        NOT NULL,
  reservation_id TEXT,
  phone          TEXT,
  guest_name     TEXT,
  doc_type       TEXT,
  stored_path    TEXT,
  status         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_after    TIMESTAMPTZ,
  data           JSONB       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_id_documents_hotel ON id_documents (hotel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_id_documents_res   ON id_documents (hotel_id, reservation_id);
-- מחיקת retention רצה כל 6 שעות וסורקת רק את מה שבאמת פג.
CREATE INDEX IF NOT EXISTS idx_id_documents_purge
  ON id_documents (purge_after) WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS id_access_log (
  id          BIGSERIAL   PRIMARY KEY,
  document_id TEXT        NOT NULL,
  hotel_id    TEXT        NOT NULL,
  actor       TEXT,
  action      TEXT,
  allowed     BOOLEAN     NOT NULL DEFAULT true,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_id_access_doc   ON id_access_log (document_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_id_access_hotel ON id_access_log (hotel_id, at DESC);

CREATE TABLE IF NOT EXISTS guest_profiles (
  hotel_id   TEXT        NOT NULL,
  phone      TEXT        NOT NULL,
  data       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hotel_id, phone)
);

-- מונה חשבוניות פר-מלון. ⚠️ ההגדלה **חייבת** להיות אטומית: שני צ'ק
-- אאוטים בו-זמנית שמקבלים אותו מספר סידורי = שתי חשבוניות מס עם אותו
-- מספר, וזו בעיה חוקית ולא באג תצוגה.
--   UPDATE invoice_counters SET seq = seq + 1
--    WHERE hotel_id = $1 AND year = $2 RETURNING seq;
CREATE TABLE IF NOT EXISTS invoice_counters (
  hotel_id TEXT   NOT NULL,
  year     INT    NOT NULL,
  seq      BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (hotel_id, year)
);
