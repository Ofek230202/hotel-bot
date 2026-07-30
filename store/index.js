// ════════════════════════════════════════════════════════
//  STORE — מצב משותף בין תהליכים (הצעד הראשון לסקייל אופקי)
//  ----------------------------------------------------------
//  ── מה באמת חוסם ריצה על יותר מתהליך אחד ──────────────
//  `concurrency.js` מגן מצוין על **תהליך בודד**: `withLock` מסדר בתור את
//  ההודעות של אותו אורח, והסמפור מגביל קריאות AI. אבל הכול בזיכרון
//  התהליך. ברגע שרצים שני עותקים (או Railway מפעיל עוד instance):
//
//    • שתי הודעות של אותו אורח יכולות ליפול על **שני תהליכים** ולרוץ
//      בו-זמנית — בדיוק מה ש-`withLock` נועד למנוע. התוצאה: מצב צ'ק אין
//      שנדרס, או **הזמנת שירות חדרים כפולה**.
//    • הגבלת הקצב היא per-process, כך ש-N תהליכים = פי N הודעות מותרות.
//
//  לכן שכבה אחת עם שני מימושים:
//    • `MemoryStore` — ברירת המחדל. **התנהגות זהה להיום** בדיוק, אפס
//      תלות חיצונית, מושלם לתהליך בודד ולבדיקות.
//    • `RedisStore`  — כשמוגדר `REDIS_URL`. אותה סמנטיקה, משותפת לכל
//      התהליכים והמכונות.
//
//  נקודת ההחלפה היחידה היא הקובץ הזה — בדיוק כמו `payments/`, `pms/`
//  ו-`email/`. שום קוד עסקי לא יודע אם יש Redis.
// ════════════════════════════════════════════════════════
import { MemoryStore } from "./MemoryStore.js";
import { RedisStore } from "./RedisStore.js";

let _store = null;
let _kind = "memory";

// יצירת ה-store. `client` מוזרק בבדיקות (fake Redis) — זו גם הדרך
// היחידה לבדוק את מסלול Redis בלי שרת אמיתי.
export function createStore({ redisUrl = process.env.REDIS_URL, client = null } = {}) {
  if (client) return new RedisStore({ client });
  if (redisUrl) return new RedisStore({ url: redisUrl });
  return new MemoryStore();
}

export function store() {
  if (!_store) {
    _store = createStore();
    _kind = _store.kind;
  }
  return _store;
}

// הזרקה לבדיקות/אתחול מפורש. מחזיר את הקודם כדי שאפשר יהיה לשחזר.
export function setStore(s) {
  const prev = _store;
  _store = s;
  _kind = s?.kind || "memory";
  return prev;
}

export function storeKind() { store(); return _kind; }

// האם המצב המשותף פעיל (כלומר בטוח להריץ יותר מתהליך אחד).
export function isDistributed() { return storeKind() === "redis"; }

export { MemoryStore, RedisStore };
export * from "./lock.js";
