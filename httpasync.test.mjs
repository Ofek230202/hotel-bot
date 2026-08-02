// ════════════════════════════════════════════════════════
//  HTTP-ASYNC — בקשה לא נשארת תלויה כשהאנדלר זורק
//  ----------------------------------------------------------
//  🔴 ב-Express 4 דחיית promise בתוך האנדלר **אינה נתפסת**: התוצאה אינה
//     500 אלא **כלום** — הבקשה נשארת פתוחה עד שהדפדפן מוותר. האורח רואה
//     עמוד שנטען לנצח בדיוק ברגע שהוא מוסר פרטי כרטיס.
//
//  הבדיקות כאן מריצות שרת אמיתי עם נתיבים שזורקים בכוונה, ומוודאות
//  שמתקבלת תשובה — עם timeout קצר, כי "נתקע" הוא בדיוק מה שנבדק.
// ════════════════════════════════════════════════════════
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { catchAsyncRoutes, errorHandler } from "./http-async.js";

async function withServer(build, fn) {
  const app = catchAsyncRoutes(express());
  build(app);
  app.use(errorHandler());
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
}

// fetch עם timeout — בלעדיו בדיקה על "נתקע" הייתה נתקעת בעצמה.
async function get(url, ms = 3000) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal }); }
  finally { clearTimeout(t); }
}

test("🔴 האנדלר אסינכרוני שזורק מחזיר 500 ולא משאיר את הבקשה תלויה", async () => {
  await withServer(
    app => app.get("/boom", async () => { throw new Error("התפוצץ"); }),
    async base => {
      const res = await get(`${base}/boom`);
      assert.equal(res.status, 500, "🔴 לא התקבלה תשובה תקינה");
      const body = await res.text();
      assert.ok(body.length > 0, "התקבל גוף תשובה");
      assert.ok(!body.includes("התפוצץ"), "🔴 פרטי השגיאה הפנימית דלפו ללקוח");
    },
  );
});

test("נתיב API מחזיר JSON, נתיב עמוד מחזיר HTML קריא לאורח", async () => {
  await withServer(
    app => {
      app.get("/api/boom", async () => { throw new Error("x"); });
      app.get("/page/boom", async () => { throw new Error("x"); });
    },
    async base => {
      const api = await get(`${base}/api/boom`);
      assert.match(api.headers.get("content-type") || "", /json/);
      assert.deepEqual(await api.json(), { error: "internal error" });

      const page = await get(`${base}/page/boom`);
      assert.match(page.headers.get("content-type") || "", /html/);
      const html = await page.text();
      // עמוד שגיאה שאורח רואה בטלפון — חייב להיות קריא, ובשתי השפות.
      assert.match(html, /lang="he"/);
      assert.match(html, /viewport/);
      assert.ok(/reception/i.test(html), "גם באנגלית — אורח דובר אנגלית מגיע לכאן");
    },
  );
});

test("חריגה סינכרונית מטופלת גם היא", async () => {
  await withServer(
    app => app.get("/sync-boom", () => { throw new Error("sync"); }),
    async base => assert.equal((await get(`${base}/sync-boom`)).status, 500),
  );
});

test("נתיב תקין ממשיך לעבוד רגיל (העטיפה שקופה)", async () => {
  await withServer(
    app => {
      app.get("/ok", (req, res) => res.json({ ok: true }));
      app.get("/ok-async", async (req, res) => { await Promise.resolve(); res.json({ ok: "async" }); });
    },
    async base => {
      assert.deepEqual(await (await get(`${base}/ok`)).json(), { ok: true });
      assert.deepEqual(await (await get(`${base}/ok-async`)).json(), { ok: "async" });
    },
  );
});

test("מידלוור (express.json וכדומה) עובר בלי נזק", async () => {
  await withServer(
    app => {
      app.use(express.json());
      app.post("/echo", (req, res) => res.json(req.body));
    },
    async base => {
      const r = await fetch(`${base}/echo`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      });
      assert.deepEqual(await r.json(), { hello: "world" });
    },
  );
});

test("תשובה שכבר נשלחה אינה נדרסת בשגיאה", async () => {
  await withServer(
    app => app.get("/late", async (req, res) => {
      res.json({ sent: true });          // כבר ענינו…
      throw new Error("אחרי התשובה");     // …ורק אז נכשלנו
    }),
    async base => {
      const r = await get(`${base}/late`);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { sent: true });
    },
  );
});

test("הראוטר עצמו (ולא רק ה-app) מוגן", async () => {
  await withServer(
    app => {
      const r = catchAsyncRoutes(express.Router());
      r.get("/r/boom", async () => { throw new Error("router"); });
      app.use(r);
    },
    async base => assert.equal((await get(`${base}/r/boom`)).status, 500),
  );
});
