// ════════════════════════════════════════════════════════
//  MockEmailProvider — ספק מייל מדומה
//  ----------------------------------------------------------
//  לא שולח מייל אמיתי. רק רושם ללוג "מייל נשלח ל-X" ומחזיר
//  אישור הצלחה. נועד לפיתוח/הדגמה עד שנחבר שירות מייל אמיתי
//  (SendGrid / SMTP / וכו') דרך אותו ממשק — החלפה במקום אחד.
//
//  חשוב: send לא זורק בזרימה הרגילה, כדי ששליחת המייל לעולם
//  לא תפיל ניתוב מחלקה או הסלמת חירום.
// ════════════════════════════════════════════════════════
import { v4 as uuidv4 } from "uuid";
import { EmailProvider } from "./EmailProvider.js";

export class MockEmailProvider extends EmailProvider {
  async send({ to, subject, body, dept, priority } = {}) {
    const tag = priority === "high" ? "🚨" : "📧";
    console.log(`${tag} [MOCK EMAIL] → ${to || "—"} | מחלקה: ${dept || "—"} | ${subject || ""}`);
    if (body) console.log(`   └─ ${body.replace(/\n/g, " ").slice(0, 200)}`);
    return {
      success: true,
      to: to || null,
      messageId: `mock_email_${uuidv4()}`,
      status: "sent",
    };
  }
}
