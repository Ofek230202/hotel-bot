// ════════════════════════════════════════════════════════
//  נקודת החיבור היחידה לספק בקשות הקונסיירז' (single wiring point)
//  ----------------------------------------------------------
//  כאן — ורק כאן — בוחרים מי מבצע בפועל בקשות של אורחים (מונית,
//  הזמנת שולחן, טיפול ספא, בקשה מיוחדת). כל שאר הקוד מייבא את
//  `concierge` מכאן ולא יודע מי הספק.
//
//  🔌 מעבר לשירות אמיתי בעתיד = החלפת שורה אחת:
//      import { GettProvider } from "./GettProvider.js";
//      export const concierge = new GettProvider();
//
//  ואם יידרש ניתוב לפי סוג בקשה (מונית → גט, שולחן → Tabit), גם זה
//  ייכתב *כאן* כספק מנתב אחד — ולא יתפזר בחזרה אל bot.js.
// ════════════════════════════════════════════════════════
import { MockConciergeProvider } from "./MockConciergeProvider.js";

export { REQUEST_TYPES } from "./ConciergeProvider.js";

export const concierge = new MockConciergeProvider();
