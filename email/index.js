// ════════════════════════════════════════════════════════
//  נקודת החיבור היחידה לספק המייל (single wiring point)
//  ----------------------------------------------------------
//  כאן — ורק כאן — בוחרים איזה ספק מייל פעיל בפרויקט.
//  כל שאר הקוד מייבא את `email` מכאן ולא יודע מי הספק בפועל.
//
//  ── מוכן לפרודקשן ──────────────────────────────────────
//  אם מוגדר EMAIL_API_KEY (עם EMAIL_PROVIDER=resend|sendgrid ו-EMAIL_FROM)
//  → נבחר HttpEmailProvider ששולח מייל *אמיתי* למחלקות. אחרת → Mock
//  (רק לוג), עם אזהרה בעלייה כדי שלא נפעיל מלון אמיתי בלי מיילים אמיתיים.
//  מלון אמיתי = הגדרת מפתח אחד, בלי שינוי קוד.
// ════════════════════════════════════════════════════════
import { MockEmailProvider } from "./MockEmailProvider.js";
import { HttpEmailProvider } from "./HttpEmailProvider.js";

function pickProvider() {
  const key = process.env.EMAIL_API_KEY;
  if (key) {
    return new HttpEmailProvider({
      provider: process.env.EMAIL_PROVIDER || "resend",
      apiKey:   key,
      from:     process.env.EMAIL_FROM,
    });
  }
  return new MockEmailProvider();
}

export const email = pickProvider();

// האם המייל אמיתי? (לבדיקת מוכנות בעליית השרת.)
export const emailIsLive = email instanceof HttpEmailProvider;
