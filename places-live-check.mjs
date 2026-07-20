// ════════════════════════════════════════════════════════
//  בדיקה חיה מול Google Places — לאימות ידני במפות
//  ----------------------------------------------------------
//  מריץ חיפוש אמיתי סביב מיקום המלון שב-config.js ומדפיס
//  שם · כתובת · דירוג · מרחק — כדי שאפשר יהיה לבדוק כל תוצאה
//  בגוגל מפות ולוודא שהמקומות אמיתיים ובאמת קרובים למלון.
//
//  הרצה (המפתח נשאר במשתנה סביבה, לא נכתב לשום קובץ):
//    GOOGLE_PLACES_API_KEY=<המפתח> node places-live-check.mjs
//    GOOGLE_PLACES_API_KEY=<המפתח> node places-live-check.mjs "מסעדת בשר"
// ════════════════════════════════════════════════════════
import dotenv from "dotenv";
dotenv.config();

const key = process.env.GOOGLE_PLACES_API_KEY;
if (!key || !key.trim()) {
  console.error("\n❌ אין GOOGLE_PLACES_API_KEY בסביבה.\n" +
    "   הרצה:  GOOGLE_PLACES_API_KEY=<המפתח> node places-live-check.mjs\n");
  process.exit(1);
}
// מפתח גוגל תקין הוא ~39 תווים שמתחילים ב-AIzaSy. מפתח קטוע נראה
// כמו מפתח, נבחר כספק החי, וכל חיפוש נכשל — בלי שום סימן חיצוני.
if (key.trim().length < 30) {
  console.error(`\n❌ המפתח נראה קטוע (${key.trim().length} תווים; מפתח מלא הוא כ-39).\n`);
  process.exit(1);
}

const { hotelConfig } = await import("./config.js");
const { places, placesLive } = await import("./places/index.js");

const loc = hotelConfig.location;
console.log(`\n🏨 המלון לפי config.js:`);
console.log(`   ${loc.address_he}`);
console.log(`   ${loc.address}`);
console.log(`   קואורדינטות: ${loc.lat}, ${loc.lng}   (רדיוס חיפוש: ${loc.search_radius_m} מ׳)`);
console.log(`   🔗 לבדיקה במפות: https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}`);
console.log(`\n🗺️  ספק חי: ${placesLive ? "Google Places (New)" : "MOCK ⚠️"}`);

const queries = process.argv.length > 2
  ? [process.argv.slice(2).join(" ")]
  : ["מסעדת בשר", "מסעדה כשרה", "בית קפה"];

for (const query of queries) {
  console.log(`\n${"═".repeat(70)}\n🔎 חיפוש: "${query}"\n${"═".repeat(70)}`);
  const t0 = Date.now();
  const res = await places.searchNearby({
    query,
    category: "restaurant",
    location: { lat: loc.lat, lng: loc.lng },
    radius: loc.search_radius_m,
    lang: "he",
  });
  const ms = Date.now() - t0;

  if (!res.ok) {
    console.error(`❌ החיפוש נכשל (${ms}ms) — סיבה: ${res.reason}`);
    if (res.reason === "invalid_key") {
      console.error(`   בדקו לפי הסדר:\n` +
        `   1. המפתח הועתק במלואו (כ-39 תווים)\n` +
        `   2. Places API (New) מופעל בפרויקט ב-Google Cloud\n` +
        `   3. למפתח אין הגבלת referrer/IP שחוסמת שרת\n` +
        `   4. לפרויקט יש חיוב (billing) פעיל`);
    }
    continue;
  }

  console.log(`✅ ${res.results.length} תוצאות · ${ms}ms\n`);
  res.results.forEach((r, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${r.name}`);
    console.log(`    📍 ${r.address}`);
    console.log(`    ⭐ ${r.rating ?? "—"}${r.ratingCount ? ` (${r.ratingCount} מדרגים)` : ""}` +
                `${r.priceSymbol ? ` · ${r.priceSymbol}` : ""} · ${r.distanceText}`);
    if (r.mapsUri) console.log(`    🔗 ${r.mapsUri}`);
    console.log("");
  });
}

// אימות אחרון: המפתח לא נכתב לשום מקום בפלט.
console.log("🔐 המפתח לא הודפס ולא נשמר בשום קובץ.\n");
