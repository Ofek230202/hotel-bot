// ════════════════════════════════════════════════════════
//  MemoryStore — ברירת המחדל: הכול בזיכרון התהליך
//  ----------------------------------------------------------
//  מממש בדיוק את אותה סמנטיקה כמו RedisStore, אבל בתוך התהליך. כך
//  פריסה של תהליך בודד (המצב היום) עובדת בלי שום תלות חיצונית, ואותו
//  קוד עסקי רץ גם עם Redis וגם בלעדיו.
//
//  ⚠️ מגן על תהליך בודד בלבד. שני עותקים = שני MemoryStore נפרדים, ואז
//     נעילה "מצליחה" בשניהם. זו בדיוק הסיבה ש-`isDistributed()` קיים,
//     ושהשרת מתריע בעלייה כשרצים בלי Redis.
// ════════════════════════════════════════════════════════

export class MemoryStore {
  kind = "memory";

  #data = new Map();   // key → { value, expiresAt|null }

  #alive(rec, now) {
    if (!rec) return false;
    if (rec.expiresAt != null && rec.expiresAt <= now) return false;
    return true;
  }

  // ניקוי עצלן: מפתח שפג נמחק כשנוגעים בו. מונע גדילת זיכרון בלי טיימרים.
  #read(key, now = Date.now()) {
    const rec = this.#data.get(key);
    if (!this.#alive(rec, now)) { if (rec) this.#data.delete(key); return null; }
    return rec;
  }

  async get(key) { return this.#read(key)?.value ?? null; }

  async set(key, value, { ttlMs = null } = {}) {
    this.#data.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
    return true;
  }

  // SET ... NX PX — הבסיס לנעילה. מצליח רק אם המפתח אינו קיים/פג.
  async setIfAbsent(key, value, { ttlMs = 30_000 } = {}) {
    const now = Date.now();
    if (this.#read(key, now)) return false;
    this.#data.set(key, { value, expiresAt: now + ttlMs });
    return true;
  }

  // מחיקה **רק אם הערך תואם** — מונע מתהליך לשחרר נעילה של אחר
  // (מה שקורה כשהנעילה פגה באמצע עבודה איטית).
  async deleteIfEquals(key, value) {
    const rec = this.#read(key);
    if (!rec || rec.value !== value) return false;
    this.#data.delete(key);
    return true;
  }

  async delete(key) { return this.#data.delete(key); }

  // מונה עם TTL — הבסיס להגבלת קצב משותפת. מחזיר את הערך אחרי ההגדלה.
  async increment(key, { ttlMs = 60_000, by = 1 } = {}) {
    const now = Date.now();
    const rec = this.#read(key, now);
    if (!rec) {
      this.#data.set(key, { value: by, expiresAt: now + ttlMs });
      return by;
    }
    rec.value = Number(rec.value || 0) + by;
    return rec.value;
  }

  async ttl(key) {
    const rec = this.#read(key);
    if (!rec) return -2;                 // לא קיים (סמנטיקת Redis)
    if (rec.expiresAt == null) return -1; // ללא תפוגה
    return Math.max(0, rec.expiresAt - Date.now());
  }

  async ping() { return true; }
  async close() { this.#data.clear(); }

  // לבדיקות/ניטור בלבד.
  size() { return this.#data.size; }
}
