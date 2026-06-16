// ════════════════════════════════════════════════════════
//  נקודת החיבור היחידה לספק התשלום (single wiring point)
//  ----------------------------------------------------------
//  כאן — ורק כאן — בוחרים איזה ספק תשלום פעיל בפרויקט.
//  כל שאר הקוד מייבא את `payments` מכאן ולא יודע מי הספק בפועל.
//
//  מעבר לספק ישראלי בעתיד = החלפת שורה אחת:
//      import { CardComProvider } from "./CardComProvider.js";
//      export const payments = new CardComProvider();
// ════════════════════════════════════════════════════════
import { MockProvider } from "./MockProvider.js";

// מטבע המערכת — שקלים (ILS). סכומים נשמרים באגורות (50000 = ₪500).
export const PAYMENT_CURRENCY = "ils";

export const payments = new MockProvider();
