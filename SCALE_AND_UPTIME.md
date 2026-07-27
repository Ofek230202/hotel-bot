# StayBot — סקייל למיליונים ועדכון בלי השבתה (חלקים 1 + 15)

> איך המערכת בנויה לקרוא מיליוני הודעות ממיליוני מלונות בלי לקרוס, ואיך
> מתקנים/מעדכנים בזמן שהיא חיה — בלי שאף מלון או אורח ירגיש. מספרי עלות
> אמיתיים (us-east-1; אזורים אחרים יקרים יותר). מקורות בתחתית.

---

## 1. מה יש היום מול מה שצריך למיליונים

| שכבה | היום | לסקייל |
|---|---|---|
| **מסד נתונים** | SQLite (קובץ, תהליך בודד) | PostgreSQL מנוהל + PgBouncer; ריפליקות קריאה; partition לפי `hotel_id` |
| **סשנים/נעילות** | בזיכרון (`withLock`) | Redis מנוהל (סשנים + נעילה מבוזרת בין עותקים) |
| **קליטה** | webhook מעובד סינכרונית | תור (queue): מקבלים ב-<1ש', מעבדים אסינכרונית |
| **מחשוב** | תהליך אחד | N עותקים חסרי-מצב מאחורי load balancer, autoscaling |
| **ניטור** | לוגים | לוגים + מטריקות + מעקב שגיאות + התראות |

**השינוי היחיד שפותח הכל: להפוך את האפליקציה לחסרת-מצב (stateless).** הקוד כבר
כמעט שם — `tenant.js`, `hotel_id` בכל טבלה, write-through cache. המהלך: להצביע
את ה-cache ל-Postgres+Redis במקום SQLite+RAM (2–4 ימי עבודה, לא "שורה").

**כבר מוכן בקוד לסקייל:** בידוד מלונות מלא (AsyncLocalStorage + `hotel_id`),
נעילה per-guest, סמפור על קריאות AI, timeout+retry, rate-limit, **דדופ הודעות
נכנסות** (Part 17), **graceful shutdown** ו-**/ready** (למטה). נקודות ההחלפה
ל-Postgres/Redis מרוכזות ב-`db.js` ו-`state.js`.

## 2. הכלים המומלצים ועלויות

- **DB:** AWS RDS PostgreSQL (`t4g.medium` ≈ $48/חודש) או **Neon** (serverless, scale-to-zero, הזול להתחלה). Aurora כשגדלים. **PgBouncer/RDS Proxy חובה** (pooling).
- **Redis:** **Upstash** (serverless, $0.20/100K פקודות) או ElastiCache ($12–47/חודש).
- **תור:** **BullMQ** על ה-Redis הקיים (חינם, מומלץ) — webhook מכניס לתור ומחזיר 200 מיד, worker מעבד את קריאת ה-AI האיטית. גם retries ו-backpressure חינם. חלופה: AWS SQS ($0.40/מיליון).
- **מחשוב:** containers, **לא serverless** (קריאת AI מחזיקה סוקט 5–20ש'). AWS Fargate (~$18/חודש למשימה) + ALB (~$16–22). לפיילוט: **Fly.io** (~$3–6) או **Render** (~$25).
- **ניטור:** **Sentry** (שגיאות, חינם→$26) + CloudWatch/Grafana. Datadog בשלב הצמיחה.

## 3. סולם עלות חודשי (בכנות)

| | פיילוט ~10 מלונות | צמיחה ~1,000 מלונות | ענק ~100K מלונות |
|---|---|---|---|
| **תשתית** | ~$160–300 | ~$1.5–3K | ~$30–80K |
| **WhatsApp** (Twilio $0.005) | ~$150 | ~$15K | ~$1.5M |
| **Claude LLM** (~$0.02/הודעה) | ~$300 | ~$30K | ~$3M |
| **סה"כ** | **~$600/חודש** | **~$48K/חודש** | **~$4.6M/חודש** |

**האמת החשובה ביותר:** מעבר לפיילוט, **תשתית היא <10% מהעלות — WhatsApp+Claude
הם 90–98%.** לכן המאמץ ההנדסי צריך ללכת ל**הפחתת טוקנים והודעות לאורח**, לא
לשרתים:
- **Prompt caching** (system prompt קבוע → פי-10 זול יותר על החלק המוטמן).
- **קיצור-דרך דטרמיניסטי** — כן/לא, בחירת מנה, אישורים: בלי AI בכלל.
- **ניתוב ב-Haiku** (פי-3 זול) לסיווג, ו-Sonnet רק לחשיבת קונסיירז' אמיתית.
- זה בדיוק מה שכבר עשינו: תפריטי מסעדות **לפי דרישה** (כלי), לא בכל prompt.

## 4. עדכון בלי השבתה (zero-downtime) — חלק 15

**ללקוח במשפט אחד:** *"אנחנו משדרגים את המערכת בזמן שהיא רצה — הודעות חדשות
מוחזקות לשנייה ונענות ע"י הגרסה החדשה, הישנה מסיימת מה שהתחילה, ואף מלון או
אורח לא רואה הפסקה."*

**שלוש היכולות שכבר בקוד (Part 17):**
1. **/health + /ready** — ה-load balancer שולח תעבורה רק לעותק שעונה "מוכן"
   (DB נגיש). כך מחליפים עותקים אחד-אחד (rolling deploy) בלי downtime.
2. **Graceful shutdown (SIGTERM):** מסמן `draining` → ה-LB מסיט תעבורה → מפסיק
   לקבל חדשים → נותן לבקשות ולקריאות ה-AI שרצות לסיים → סוגר DB → יוצא נקי.
   חלון חסד ארוך מהקריאה האיטית ביותר ל-Claude.
3. **דדופ הודעות (idempotency):** retry של אותה הודעה (MessageSid) לא מעובד
   פעמיים — אין תשובה כפולה, הזמנה כפולה או חיוב כפול, גם אם עותק נהרג באמצע.

**מיגרציות DB בטוחות (expand → migrate → contract):** לעולם לא משנים סכימה
בצורה שוברת בצעד אחד (הקוד הישן והחדש רצים יחד באותו DB). מוסיפים עמודה
nullable → כותבים לשתי הצורות → ממלאים ברקע בקבוצות → רק אחר כך מוחקים את הישן.
`CREATE INDEX CONCURRENTLY` (לא נועל), backfill per-partition (לא נועל את כל
המלונות). כל שדה חדש ב-StayBot נוסף כך היום (ראה `db.js` — ALTER TABLE idempotent).

---

## מקורות
[RDS](https://aws.amazon.com/rds/postgresql/pricing/) · [Neon](https://neon.com/pricing) · [Upstash](https://upstash.com/pricing) · [Fargate](https://aws.amazon.com/fargate/pricing/) · [Fly.io](https://fly.io/docs/about/pricing/) · [BullMQ](https://docs.bullmq.io) · [Sentry](https://sentry.io/pricing/) · [Anthropic pricing](https://www.anthropic.com/pricing) · [Twilio WhatsApp pricing](https://www.twilio.com/en-us/whatsapp/pricing)
