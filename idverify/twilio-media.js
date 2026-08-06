// ════════════════════════════════════════════════════════
//  מחיקת מדיה מהשרתים של Twilio — החצי החסר של verify-then-discard
//  ----------------------------------------------------------
//  🔴 **הפער שזה סוגר, והוא חמור:** המערכת הכריזה verify-then-discard
//     ואמרה לאורח, בשחור על גבי לבן, *"מוחקים את התמונה — היא אינה
//     נשמרת"*. מקומית זה נכון: בזרימת ה-discard הקובץ לא נכתב כלל.
//
//     אבל תמונת המסמך לא הגיעה אלינו מהאוויר. וואטסאפ העלה אותה
//     ל-**Twilio**, ו-`MediaUrl0` מצביע על עותק ששמור אצלם. Twilio
//     שומרת מדיה **עד שמוחקים אותה במפורש** דרך ה-API. כלומר: צילום
//     תעודת הזהות של האורח נשאר על שרתי Twilio (ארה"ב) גם אחרי
//     ש"מחקנו" — ואנחנו הצהרנו בפניו שלא.
//
//     זו אינה רק בעיה טכנית: הצהרת פרטיות **שגויה** גרועה מהיעדר
//     הצהרה. לפי חוק הגנת הפרטיות ולפי GDPR, מחיקה חייבת לכלול את כל
//     העותקים אצל מעבדי המשנה — ו-Twilio היא מעבד משנה לכל דבר.
//
//  לכן: אחרי האימות מוחקים את המדיה גם אצל Twilio. הפעולה **לעולם לא
//  חוסמת ולא מפילה** את הצ'ק אין — אורח לא ייתקע בגלל מחיקה שנכשלה —
//  אבל כישלון נרשם בקול, כי המשמעות שלו היא PII ששרד.
//
//  📄 Twilio: DELETE /2010-04-01/Accounts/{AccountSid}/Messages/{MessageSid}/Media/{MediaSid}
// ════════════════════════════════════════════════════════

// כתובת מדיה של Twilio נראית כך:
//   https://api.twilio.com/2010-04-01/Accounts/ACxxx/Messages/MMxxx/Media/MExxx
// מחלצים ממנה את שלושת המזהים. כתובת שאינה של Twilio (מוק/בדיקה) → null.
export function parseTwilioMediaUrl(url) {
  const m = String(url || "").match(
    /\/2010-04-01\/Accounts\/(AC[0-9a-zA-Z]+)\/Messages\/([A-Z]{2}[0-9a-zA-Z]+)\/Media\/([A-Z]{2}[0-9a-zA-Z]+)/
  );
  if (!m) return null;
  return { accountSid: m[1], messageSid: m[2], mediaSid: m[3] };
}

/**
 * מוחק את המדיה מהשרתים של Twilio.
 *
 * @returns {Promise<{ok:boolean, reason?:string, status?:number}>}
 *   לעולם לא זורק. `ok:false` עם reason — כדי שהקורא ירשום ולא ייפול.
 */
export async function deleteTwilioMedia(mediaUrl, {
  accountSid = process.env.TWILIO_ACCOUNT_SID,
  authToken  = process.env.TWILIO_AUTH_TOKEN,
  fetchImpl  = globalThis.fetch,
} = {}) {
  const ids = parseTwilioMediaUrl(mediaUrl);
  // לא כתובת של Twilio (מוק, בדיקה, קובץ מקומי) — אין מה למחוק.
  if (!ids) return { ok: true, reason: "not_twilio_media" };

  if (!accountSid || !authToken) {
    // אין credentials — לא נכשלים בשקט: זה אומר ש-PII נשאר אצל Twilio.
    return { ok: false, reason: "no_credentials" };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${ids.accountSid}` +
              `/Messages/${ids.messageSid}/Media/${ids.mediaSid}.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  try {
    const resp = await fetchImpl(url, {
      method: "DELETE",
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(10_000),
    });
    // 204 = נמחק. 404 = כבר לא קיים — גם זו הצלחה מבחינתנו (אידמפוטנטי).
    if (resp.status === 204 || resp.status === 404) {
      return { ok: true, status: resp.status };
    }
    return { ok: false, reason: `http_${resp.status}`, status: resp.status };
  } catch (e) {
    return { ok: false, reason: e?.name === "TimeoutError" ? "timeout" : "network" };
  }
}

/**
 * עוטף את המחיקה בלוג הנכון. זו הצורה שהקוד העסקי קורא לה.
 * לא חוסם, לא זורק — אבל כישלון **רועש**, כי הוא אומר ש-PII שרד.
 */
export async function purgeIdMediaFromProvider(mediaUrl, { context = "" } = {}) {
  const r = await deleteTwilioMedia(mediaUrl);
  if (r.ok) {
    if (r.reason !== "not_twilio_media") {
      console.log(`🔐 [ID] המדיה נמחקה גם משרתי Twilio${context ? ` (${context})` : ""}.`);
    }
    return r;
  }
  console.error(
    `🔴 [ID] מחיקת המדיה משרתי Twilio נכשלה (${r.reason})${context ? ` (${context})` : ""}.\n` +
    `   ⚠️ צילום מסמך הזיהוי **עדיין קיים אצל Twilio**, בניגוד להצהרת הפרטיות שנמסרה לאורח.\n` +
    `   יש למחוק ידנית בקונסולת Twilio, ולוודא ש-TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN מוגדרים.`
  );
  return r;
}
