// ════════════════════════════════════════════════════════
//  PMS-GUIDE — יוצר את PMS_GUIDE.md מתוך רישום הספקים
//  ----------------------------------------------------------
//  למה נוצר ולא נכתב ביד: מסמך שנכתב ביד מתנתק מהקוד תוך שבועיים —
//  מוסיפים ספק, משנים שדה, והמסמך משקר. כאן המסמך **נגזר מ-vendors.js**,
//  ולכן כל ספק שנתמך בקוד מופיע בו אוטומטית, עם בדיוק השדות שהקוד דורש.
//
//  הרצה:  node pms-guide.mjs          (כותב PMS_GUIDE.md)
//         node pms-guide.mjs --check  (נכשל אם המסמך אינו מעודכן)
// ════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { PMS_VENDORS, vendorSpec } from "./pms/vendors.js";

const OUT = path.join(process.cwd(), "PMS_GUIDE.md");

const byRegion = (a, b) => {
  // ישראל ראשונה — זה השוק בפועל; אחר כך לפי סדר חשיבות.
  const order = ["optima", "opera", "mews", "cloudbeds", "apaleo", "protel", "fidelio",
                 "guestline", "roomraccoon", "stayntouch", "clock", "hotelogix", "ezee"];
  return order.indexOf(a) - order.indexOf(b);
};

function credTable(spec) {
  const rows = (spec.credentialFields || []).map(f => {
    const req = f.required ? "**חובה**" : "רשות";
    const sec = f.secret ? " 🔒" : "";
    const help = [f.example ? `דוגמה: \`${f.example}\`` : "", f.helpHe || ""].filter(Boolean).join(" · ");
    return `| \`${f.key}\` | ${f.labelHe}${sec} | ${req} | ${help || "—"} |`;
  });
  if (!rows.length) return "_(אין שדות מוגדרים)_";
  return ["| שדה | מה זה | | הערות |", "|---|---|---|---|", ...rows].join("\n");
}

function vendorSection(id) {
  const spec = vendorSpec(id);
  const v = PMS_VENDORS[id];
  const caps = (spec.capabilities || []).sort();
  const canPost = caps.includes("folio.post");

  return `
### ${v.labelHe} — ${v.label}

| | |
|---|---|
| **מי מפתח** | ${v.vendorHe || "—"} |
| **איפה נפוץ** | ${v.region || "—"} |
| **למה זה חשוב** | ${v.marketHe || "—"} |
| **תיעוד** | ${v.docsUrl ? `<${v.docsUrl}>` : "—"} |
| **הרשמה עצמית?** | ${v.selfServe ? "✅ כן — אפשר להתחיל לבד" : "❌ לא — נדרשת פנייה דרך המלון/הספק"} |
| **פרטים אומתו?** | ${v.verified ? "✅ מול תיעוד הספק" : "⚠️ המבנה המדויק מגיע עם מסמך הספק (הנתיבים ניתנים לדריסה)"} |

**איך משיגים גישה:**
${v.accessHe || "דרך המלון."}
${v.warnHe ? `\n> ⚠️ **לשים לב:** ${v.warnHe}\n` : ""}
**מה לבקש מהמלון:**

${credTable(spec)}

**מה הבוט יוכל לעשות:** ${caps.map(c => `\`${c}\``).join(" · ")}
${canPost ? "" : "\n> 💡 אין רישום חיוב אוטומטי אצל ספק זה — חיובי שירות חדרים יועברו לצוות במקום להירשם לחשבון. האורח לא מרגיש הבדל.\n"}
**להפעלה בקוד** (שורת קונפיג אחת, פר-מלון):

\`\`\`js
updateConfigFor("<hotelId>", {
  pms_provider: "${id}",
  pms_credentials: {
${(spec.credentialFields || []).filter(f => f.required).map(f => `    ${f.key}: "<${f.labelHe}>",`).join("\n")}
  },
});
\`\`\`
${v.guideRef ? `\n📄 **מסמך מורחב:** \`${v.guideRef}\`\n` : ""}`;
}

function build() {
  const ids = Object.keys(PMS_VENDORS).sort(byRegion);
  const rows = ids.map(id => {
    const v = PMS_VENDORS[id];
    return `| **${v.labelHe}** | ${v.region || "—"} | ${v.selfServe ? "✅" : "❌"} | ${v.verified ? "✅" : "⚠️"} | \`${id}\` |`;
  });

  return `# מדריך חיבור PMS — מה לבקש מכל מלון

> **מסמך זה נוצר אוטומטית מ-\`pms/vendors.js\`** (\`node pms-guide.mjs\`).
> אין לערוך אותו ידנית — כל שינוי יידרס. להוספת ספק: מוסיפים מפרט ב-\`vendors.js\`.
>
> נוצר עבור ${ids.length} מערכות PMS.

---

## מה זה PMS ולמה זה משנה

PMS הוא "מוח התפעול" של המלון — ההזמנות, החדרים, חשבון האורח וסטטוס הניקיון.
**בלי חיבור** הבוט עובד מצוין אבל על המאגר שלנו: הוא מקבל כל מספר הזמנה,
מקצה חדר קבוע, והחיובים לא מגיעים לחשבון האמיתי.
**עם חיבור** — ההזמנה נבדקת אמיתית, החדר מגיע מהמלון, והחיובים נרשמים לחשבון.

**מבחינת האורח כלום לא משתנה. מבחינת המלון — הכל מסתנכרן.**

---

## טבלת החלטה מהירה

| מערכת | איפה נפוצה | הרשמה עצמית | פרטים אומתו | קוד להגדרה |
|---|---|---|---|---|
${rows.join("\n")}

**איך יודעים על מה המלון עובד?** פשוט שואלים: *"על איזו מערכת ניהול (PMS) אתם עובדים?"*
בישראל התשובה תהיה **אופטימה** ברוב המוחלט של המקרים.

---

## הכלל שחוסך זמן בכל פנייה

בכל מערכת יש הבדל בין **חיבור ערוצי מכירה** (Booking.com, Expedia) לבין
**ממשק תפעולי** (הזמנות וחשבון אורח). אלה מחלקות שונות אצל הספק.

> תמיד לומר: **"אנחנו צריכים ממשק תפעולי (PMS API) — לא חיבור ערוץ מכירה."**

בלי המשפט הזה מפנים אותך למחלקה הלא נכונה, וזה עולה שבועיים.

---

## שתי שאלות שקובעות את לוח הזמנים

1. **"האם ה-API נגיש מהאינטרנט, או רק מהרשת הפנימית של המלון?"**
   מערכות ותיקות (אופטימה מקומית, פידליו) מותקנות על שרת **בתוך המלון**.
   אז צריך פתיחת פורט או VPN — וזה שינוי תשתית שדורש את איש ה-IT.
   **זו סיבת העיכוב מספר 1.**

2. **"האם יש עלות אינטגרציה?"**
   לחלק מהספקים יש דמי שותף או דמי ממשק. עדיף לדעת מראש.

---

## מה עושים כשמשהו לא נתמך

לא כל מערכת מאפשרת הכל. הנפוץ ביותר: **רישום חיוב** (folio.post) שלא מאושר
לצד שלישי.

**המערכת בנויה לזה:** כל ספק מצהיר מה הוא יודע לעשות, והבוט **מדרדר בחן** —
אם אי אפשר לרשום חיוב אוטומטית, הבקשה עוברת לצוות כהתראה. שום דבר לא נשבר,
והאורח לא מרגיש.

---

## פירוט לפי מערכת
${ids.map(vendorSection).join("\n---\n")}

---

## איך בודקים שהחיבור עובד

\`\`\`js
import { pmsReadiness } from "./pms/index.js";
pmsReadiness("lala");
// → { vendor, ready, missing: [...], capabilities: [...] }
\`\`\`

\`missing\` מפרט **בדיוק** אילו שדות עוד חסרים — זו הרשימה לשלוח למלון.

⚠️ מלון שהוגדר עם ספק אך חסרים לו פרטים **לא ישבור צ'ק אין**: המערכת נופלת
אוטומטית למאגר המובנה ומדפיסה אזהרה שמפרטת מה חסר.

---

## רב-מלונות

כל מלון והחיבור שלו, באותו הרגע ובאותו תהליך:

\`\`\`
LALA        → optima      (אופטימה)
קמפינסקי    → opera       (אורקל)
מלון שלישי  → mock        (בלי PMS)
\`\`\`

אין גלובל אחד. \`pmsFor(hotelId)\` בונה ספק נפרד לכל מלון עם ה-credentials
שלו בלבד — ואין מסלול שבו מלון אחד נוגע בנתונים של אחר.
`;
}

const md = build();
if (process.argv.includes("--check")) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (cur.trim() !== md.trim()) {
    console.error("❌ PMS_GUIDE.md אינו מעודכן ביחס ל-pms/vendors.js — הריצו: node pms-guide.mjs");
    process.exit(1);
  }
  console.log("✅ PMS_GUIDE.md מעודכן");
} else {
  fs.writeFileSync(OUT, md, "utf8");
  console.log(`✅ נכתב ${OUT} (${Object.keys(PMS_VENDORS).length} מערכות)`);
}
