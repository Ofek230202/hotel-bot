// ════════════════════════════════════════════════════════
//  PROFILES — פרופיל אורח חוצה-שהיות (Part י')
//  ----------------------------------------------------------
//  הפער הכי גדול בין "פקיד קבלה" ל"קונסיירז' של מלון יוקרה" הוא *זיכרון*:
//  מלון מובחר זוכר שהאורח אוהב קומה גבוהה, שיש לו אלרגיה, ומה חשב בפעם
//  שעברה. כאן שומרים פרופיל דק אך מתמיד לכל אורח (פר-מלון): מספר שהיות,
//  ההעדפה האחרונה שהביע, הדירוג האחרון, ודגל VIP לאורח חוזר.
//
//  בידוד מולטי-טננט: המפתח הוא (hotel_id, phone) — אורח חוזר במלון א'
//  אינו מזוהה כחוזר במלון ב'. עקבי עם שאר שכבת ה-state.
// ════════════════════════════════════════════════════════
import { db } from "./db.js";
import { currentHotelId } from "./tenant.js";

const VIP_THRESHOLD = 3; // 3 שהיות ומעלה = אורח חוזר / VIP

const upsertStmt = db.prepare(`
  INSERT INTO guest_profiles (hotel_id, phone, data, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(hotel_id, phone) DO UPDATE SET
    data = excluded.data, updated_at = excluded.updated_at
`);

// שליפת פרופיל האורח, או null אם זו הפעם הראשונה. לעולם לא זורק.
export function getProfile(phone, hotelId = currentHotelId()) {
  try {
    const row = db.prepare(`SELECT data FROM guest_profiles WHERE hotel_id = ? AND phone = ?`).get(hotelId, phone);
    return row?.data ? JSON.parse(row.data) : null;
  } catch (e) {
    console.error("getProfile failed:", e?.message || e);
    return null;
  }
}

// רישום שהייה שהסתיימה: מגדיל את מונה השהיות, שומר את ההעדפה האחרונה
// והדירוג, ומעדכן את דגל ה-VIP. idempotent-ידידותי: כל שדה חדש דורס רק
// אם נמסר, אחרת נשמר הקודם. מחזיר את הפרופיל המעודכן.
export function recordStay(phone, { hotelId = currentHotelId(), name = null, preferences = null, rating = null } = {}) {
  const cur   = getProfile(phone, hotelId) || { phone, stays: 0 };
  const stays = (cur.stays || 0) + 1;
  const next  = {
    phone,
    name:        name || cur.name || null,
    stays,
    preferences: preferences || cur.preferences || null, // ההעדפה האחרונה שהאורח ביקש
    lastRating:  rating ?? cur.lastRating ?? null,
    vip:         cur.vip || stays >= VIP_THRESHOLD,
    lastStayAt:  new Date().toISOString(),
  };
  try { upsertStmt.run(hotelId, phone, JSON.stringify(next), next.lastStayAt); }
  catch (e) { console.error("recordStay failed:", e?.message || e); }
  return next;
}

// עדכון הדירוג האחרון (נאסף אחרי הצ'ק אאוט, בשלב המשוב) — בלי להגדיל שהיות.
export function updateLastRating(phone, rating, hotelId = currentHotelId()) {
  const cur = getProfile(phone, hotelId);
  if (!cur) return null;
  cur.lastRating = rating ?? cur.lastRating ?? null;
  cur.updated_at = new Date().toISOString();
  try { upsertStmt.run(hotelId, phone, JSON.stringify(cur), cur.updated_at); }
  catch (e) { console.error("updateLastRating failed:", e?.message || e); }
  return cur;
}

// האם זה אורח חוזר (יש לו שהייה קודמת)?
export function isReturningGuest(phone, hotelId = currentHotelId()) {
  const p = getProfile(phone, hotelId);
  return !!(p && p.stays > 0);
}
