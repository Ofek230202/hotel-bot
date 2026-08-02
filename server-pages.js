// ════════════════════════════════════════════════════════
//  עמודי HTML של הצוות (להבדיל מעמודי האורח שב-checkin-routes.js)
//  ----------------------------------------------------------
//  מודול נפרד מ-`server.js` בכוונה: ייבוא של `server.js` **מפעיל שרת**,
//  ולכן ביקורת הניסוח (`voice-audit.mjs`) לא הייתה יכולה לבדוק את
//  העמודים האלה בלי להרים אותו. רינדור חייב להיות ניתן לייבוא בנפרד.
//
//  כל עמוד כאן בעברית: אלה עמודי **צוות**, וכל התראות הצוות בפרויקט
//  בעברית ללא קשר לשפת האורח (ראה §"שפה" ב-CLAUDE.md).
// ════════════════════════════════════════════════════════
import { shellPage, escapeHtml as esc } from "./checkin-routes.js";
import { configFor } from "./config.js";

/**
 * עמוד אישור קבלה על אירוע חירום.
 * נפתח מהטלפון של איש הביטחון, מתוך הקישור שבהתראה — לכן קצר, מיידי,
 * ואומר בפירוש מה קרה עכשיו (ההסלמה בוטלה) ומה עוד פתוח (הסגירה).
 */
export function incidentAckPage(inc, { already = false } = {}) {
  const cfg  = configFor(inc?.hotelId);
  const when = inc?.ackAt
    ? new Date(inc.ackAt).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", dateStyle: "short", timeStyle: "short" })
    : "";
  const where = inc?.roomNumber ? `חדר ${inc.roomNumber}` : "מיקום לא ידוע";
  const body =
    `<h1>${already ? "האירוע כבר אושר" : "אישור הקבלה נרשם"}</h1>` +
    `<p class="lead">${already
      ? `האירוע אושר קודם לכן על ידי ${esc(inc?.ackBy || "צוות")}${when ? `, בשעה ${esc(when)}` : ""}. ההסלמה מופסקת.`
      : `תודה. ההסלמה למנהל התורן בוטלה, והאירוע מסומן כמטופל על ידי ${esc(inc?.ackBy || "צוות")}.`}</p>` +
    `<div class="card">` +
    `<div class="row"><span>מיקום</span><b>${esc(where)}</b></div>` +
    `<div class="row"><span>אורח</span><b>${esc(inc?.guestName || "לא ידוע")}</b></div>` +
    `<div class="row"><span>הדיווח</span><b>${esc(String(inc?.description || "").slice(0, 200) || "לא נרשם")}</b></div>` +
    `</div>` +
    `<p class="note">האירוע נשאר פתוח ביומן עד שייסגר עם תיאור הטיפול שבוצע בפועל.</p>`;

  return shellPage({
    lang: "he",
    title: "אישור קבלה — אירוע חירום",
    icon: "✅",
    body,
    hotelId: inc?.hotelId,
    hotelName: cfg.name_he || cfg.name,
  });
}
