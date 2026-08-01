// ════════════════════════════════════════════════════════
//  LruCache — cache חסום בזיכרון, עם פינוי לפי שימוש אחרון
//  ----------------------------------------------------------
//  ── התקרה האמיתית לסקייל ─────────────────────────────
//  עד כה `state.js` ו-`checkin.js` החזיקו **את כל** הסשנים וההזמנות של
//  **כל** המלונות בזיכרון התהליך, לנצח. זה עבד מצוין למלון–שניים, ונופל
//  במיליוני מלונות — לא בגלל מסד הנתונים, אלא בגלל ה-RAM. זו הייתה
//  התקרה האמיתית, וזה מה שהמבנה הזה פותר.
//
//  ── למה LRU ולא TTL בלבד ─────────────────────────────
//  אורח פעיל כותב כל כמה דקות; אורח שסיים צ'ק אאוט לא יכתוב שוב. פינוי
//  לפי **שימוש אחרון** שומר בדיוק את מי שפעיל עכשיו, בלי לנחש כמה זמן
//  שהייה נמשכת. TTL קיים בנוסף, כדי שסשן שנשכח לא ישב לנצח.
//
//  🔴 **הפינוי בטוח רק כי הכתיבה היא write-through.** כל שינוי כבר נשמר
//     ל-DB לפני הפינוי, ולכן פינוי אינו מאבד מידע — הוא רק מרוקן זיכרון.
//     מי שיוסיף כאן "כתיבה עצלה" חייב לשנות את זה קודם.
//
//  Map ב-JS שומר סדר הכנסה, ולכן LRU הוא delete+set על כל גישה — בלי
//  רשימה מקושרת ובלי תלות חיצונית.
// ════════════════════════════════════════════════════════

export class LruCache {
  /**
   * max    — מספר הפריטים המרבי. חריגה → מפנים את הישן ביותר.
   * ttlMs  — פריט שלא נגעו בו יותר מזה נחשב פג (0 = ללא תפוגה).
   * onEvict(key, value, reason) — hook לניטור/בדיקות.
   */
  constructor({ max = 10_000, ttlMs = 0, onEvict = null, now = () => Date.now() } = {}) {
    this.max = Math.max(1, Number(max) || 1);
    this.ttlMs = Number(ttlMs) || 0;
    this.onEvict = onEvict;
    this.now = now;
    this.map = new Map();   // key → { value, at }
    this.stats = { hits: 0, misses: 0, evictions: 0, expirations: 0, sets: 0 };
  }

  #expired(rec) { return this.ttlMs > 0 && this.now() - rec.at > this.ttlMs; }

  #drop(key, reason) {
    const rec = this.map.get(key);
    if (!rec) return false;
    this.map.delete(key);
    if (reason === "evict") this.stats.evictions++;
    if (reason === "expire") this.stats.expirations++;
    try { this.onEvict?.(key, rec.value, reason); } catch { /* hook לא מפיל cache */ }
    return true;
  }

  has(key) {
    const rec = this.map.get(key);
    if (!rec) return false;
    if (this.#expired(rec)) { this.#drop(key, "expire"); return false; }
    return true;
  }

  get(key) {
    const rec = this.map.get(key);
    if (!rec) { this.stats.misses++; return undefined; }
    if (this.#expired(rec)) { this.#drop(key, "expire"); this.stats.misses++; return undefined; }
    // גישה = רענון מקום בתור (Map שומר סדר הכנסה).
    this.map.delete(key);
    rec.at = this.now();
    this.map.set(key, rec);
    this.stats.hits++;
    return rec.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, at: this.now() });
    this.stats.sets++;
    this.#evictIfNeeded();
    return value;
  }

  delete(key) { return this.#drop(key, "delete"); }

  clear() { this.map.clear(); }

  get size() { return this.map.size; }

  /** הערכים החיים בלבד (בלי פגי-תוקף). לא מרענן סדר. */
  values() {
    const out = [];
    for (const [key, rec] of [...this.map]) {
      if (this.#expired(rec)) { this.#drop(key, "expire"); continue; }
      out.push(rec.value);
    }
    return out;
  }

  keys() { return this.values().length === 0 ? [] : [...this.map.keys()]; }

  #evictIfNeeded() {
    while (this.map.size > this.max) {
      // הראשון ב-Map הוא הפחות-שומש לאחרונה.
      const oldest = this.map.keys().next().value;
      this.#drop(oldest, "evict");
    }
  }

  /** ניקוי יזום של פגי-תוקף (job תקופתי). מחזיר כמה פונו. */
  sweep() {
    let n = 0;
    for (const [key, rec] of [...this.map]) {
      if (this.#expired(rec)) { this.#drop(key, "expire"); n++; }
    }
    return n;
  }

  info() {
    const { hits, misses } = this.stats;
    const total = hits + misses;
    return {
      size: this.map.size, max: this.max, ttlMs: this.ttlMs,
      ...this.stats,
      hitRate: total ? Math.round((hits / total) * 100) : null,
    };
  }
}
