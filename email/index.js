// ════════════════════════════════════════════════════════
//  נקודת החיבור היחידה לספק המייל (single wiring point)
//  ----------------------------------------------------------
//  כאן — ורק כאן — בוחרים איזה ספק מייל פעיל בפרויקט.
//  כל שאר הקוד מייבא את `email` מכאן ולא יודע מי הספק בפועל.
//
//  מעבר לשירות מייל אמיתי בעתיד = החלפת שורה אחת:
//      import { SendGridProvider } from "./SendGridProvider.js";
//      export const email = new SendGridProvider();
// ════════════════════════════════════════════════════════
import { MockEmailProvider } from "./MockEmailProvider.js";

export const email = new MockEmailProvider();
