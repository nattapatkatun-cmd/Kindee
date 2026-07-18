// กินดี — Cloudflare Worker
// ทำ 2 หน้าที่:
//   1. POST /gemini  — proxy ไป Gemini API โดยเก็บ API keys ไว้ฝั่ง server,
//      ตรวจ Firebase ID token ของผู้ใช้, เช็ค allowedEmails (closed beta)
//      แล้วจำกัดโควตา AI ต่อคนต่อวัน (KV)
//   2. POST /  (มี header x-target-url) — passthrough เดิมสำหรับ Google Sheets
//      webhook (จำกัดปลายทางเฉพาะ script.google.com)
//
// ── ต้องตั้งค่าใน Cloudflare Dashboard (ดู SETUP_AUTH.md) ──
// Variables & Secrets:
//   GEMINI_KEYS          (secret)  Gemini API keys คั่นด้วย comma เช่น "AIza...,AIza..."
//   FIREBASE_WEB_API_KEY (text)    Web API key ของ Firebase project (ค่า apiKey ใน firebaseConfig)
//   DAILY_LIMIT          (text)    โควตา AI ต่อ user ต่อวัน เช่น "20" (ไม่ตั้ง = 20)
//   ALLOWED_ORIGIN       (text)    origin ของเว็บ เช่น "https://nattapatkatun-cmd.github.io" (ไม่ตั้ง = *)
// KV Namespace binding:
//   QUOTA  → ผูกกับ namespace ที่สร้างไว้ (เก็บตัวนับโควตารายวัน)

const GEMINI_MODEL = 'gemini-2.5-flash';
// Public value (also embedded in index.html's firebaseConfig) — not a secret.
const FIREBASE_PROJECT_ID = 'kindee-f0cc1';
// bump ทุกครั้งที่แก้ไฟล์นี้ — เปิด https://kindee.ojo0308.workers.dev/health
// ในเบราว์เซอร์แล้วเทียบเลขนี้ เพื่อเช็คว่าโค้ดบน Cloudflare ตรงกับ repo หรือยัง
const WORKER_VERSION = '2026-07-18.1';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-target-url',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // เช็คว่า worker ที่ deploy อยู่เป็นเวอร์ชันไหน + ตั้งค่าครบไหม (ไม่เผยค่า secret)
    if (url.pathname === '/health' && request.method === 'GET') {
      return json(
        {
          ok: true,
          version: WORKER_VERSION,
          gemini: !!env.GEMINI_KEYS,
          firebase: !!env.FIREBASE_WEB_API_KEY,
          quotaKV: !!env.QUOTA,
          allowedOrigin: env.ALLOWED_ORIGIN || '*',
        },
        200,
        cors
      );
    }

    if (url.pathname === '/gemini' && request.method === 'POST') return handleGemini(request, env, cors);

    // ── Legacy passthrough: Google Apps Script webhook ──
    // POST = ส่งข้อมูล, GET = ping ทดสอบการเชื่อมต่อ (testSync ในแอปใช้ GET)
    const target = request.headers.get('x-target-url');
    if (target && (request.method === 'POST' || request.method === 'GET')) {
      if (!/^https:\/\/script\.google\.com\//.test(target)) {
        return json({ error: 'target not allowed' }, 403, cors);
      }
      const upstream = await fetch(target, {
        method: request.method,
        headers: request.method === 'POST' ? { 'Content-Type': 'application/json' } : {},
        body: request.method === 'POST' ? await request.text() : undefined,
        redirect: 'follow',
      });
      return new Response(await upstream.text(), { status: upstream.status, headers: cors });
    }

    return json({ error: 'not found' }, 404, cors);
  },
};

async function handleGemini(request, env, cors) {
  // 1) ตรวจ Firebase ID token
  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return json({ error: 'auth', message: 'ต้องเข้าสู่ระบบก่อนใช้ฟีเจอร์ AI' }, 401, cors);

  const user = await verifyFirebaseToken(idToken, env);
  if (!user) return json({ error: 'auth', message: 'token ไม่ถูกต้องหรือหมดอายุ — ลอง login ใหม่' }, 401, cors);

  // 1b) Closed-beta allowlist — เช็คผ่าน Firestore REST ด้วย idToken ตัวเดียวกับ
  // ที่ client ส่งมา (Firestore ตรวจ security rules ให้เองตาม auth context ของ
  // token นั้น ไม่ต้องมี service account) allowedEmails/{email} มีแค่เจ้าของ
  // อีเมลนั้นอ่านได้เอง ตรงกับ rules ฝั่ง Firestore พอดี — เจตนาเดียวกัน
  // ป้องกันคนที่มีแค่ลิงก์สมัครใช้ AI ได้โดยไม่ได้รับอนุญาต
  const allowed = await checkAllowlist(idToken, user.email, env);
  if (!allowed) {
    return json(
      { error: 'not_allowed', message: 'บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้งาน (อยู่ระหว่างช่วงทดสอบปิด) — ติดต่อผู้ดูแลเพื่อขอสิทธิ์' },
      403,
      cors
    );
  }

  // 2) โควตาต่อ user ต่อวัน (KV; นับตามวัน UTC — เพียงพอสำหรับกันการใช้เกิน)
  const limit = parseInt(env.DAILY_LIMIT || '20', 10);
  const day = new Date().toISOString().slice(0, 10);
  const quotaKey = `q:${user.uid}:${day}`;
  let used = 0;
  if (env.QUOTA) {
    used = parseInt((await env.QUOTA.get(quotaKey)) || '0', 10);
    if (used >= limit) {
      return json(
        { error: 'quota', message: `ใช้ AI ครบ ${limit} ครั้งของวันนี้แล้ว — รีเซ็ตหลังเที่ยงคืน (UTC)`, used, limit },
        429,
        cors
      );
    }
    // KV ไม่ atomic แต่สำหรับสเกลนี้ยอมรับได้ (พลาดนับได้แค่ ±1 ตอนยิงพร้อมกัน)
    await env.QUOTA.put(quotaKey, String(used + 1), { expirationTtl: 172800 });
  }

  // 3) เรียก Gemini พร้อม rotate keys: 429/quota → เปลี่ยน key ทันที,
  //    503/overload → รอสั้น ๆ แล้วลองใหม่ ก่อนเปลี่ยน key
  const keys = (env.GEMINI_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
  if (!keys.length) return json({ error: 'config', message: 'Worker ยังไม่ได้ตั้งค่า GEMINI_KEYS' }, 500, cors);

  const body = await request.text();
  const startIdx = used % keys.length; // กระจายโหลดข้าม keys
  let lastErr = null;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = keys[(startIdx + attempt) % keys.length];
    for (let retry = 0; retry < 3; retry++) {
      let resp, data;
      try {
        resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }
        );
        data = await resp.json();
      } catch (e) {
        lastErr = { message: 'เชื่อมต่อ Gemini ไม่ได้: ' + (e && e.message) };
        break; // network-level → ลอง key ถัดไป
      }

      if (!data.error) {
        return json(data, 200, cors); // สำเร็จ — ส่ง response Gemini กลับตรง ๆ
      }

      const msg = (data.error.message || '').toLowerCase();
      const code = data.error.code;
      const isRateLimit = code === 429 || msg.includes('quota') || msg.includes('rate') || msg.includes('limit');
      const isOverload = code === 503 || msg.includes('overloaded') || msg.includes('high demand') || msg.includes('unavailable');

      lastErr = data.error;
      if (isRateLimit) break; // key นี้หมดโควตา → key ถัดไปเลย
      if (isOverload && retry < 2) {
        await sleep(1500 * (retry + 1));
        continue; // ลอง key เดิมซ้ำ
      }
      if (isOverload) break; // ครบ retry → key ถัดไป
      // error อื่น (เช่น request ผิดรูปแบบ) — ส่งกลับเลย ไม่มีประโยชน์ที่จะ rotate
      return json({ error: data.error }, 200, cors);
    }
  }

  return json(
    { error: { message: 'AI ไม่พร้อมใช้งานชั่วคราว (ลองครบทุก key แล้ว): ' + ((lastErr && lastErr.message) || '') } },
    200,
    cors
  );
}

// ตรวจ ID token ผ่าน Identity Toolkit accounts:lookup — ง่ายและเชื่อถือได้
// (Google ตรวจลายเซ็น/วันหมดอายุให้เอง) แลกกับ 1 sub-request ต่อ AI call
async function verifyFirebaseToken(idToken, env) {
  if (!env.FIREBASE_WEB_API_KEY) return null;
  try {
    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_WEB_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    const data = await resp.json();
    const u = data && data.users && data.users[0];
    if (!u || !u.localId) return null;
    return { uid: u.localId, email: u.email || '' };
  } catch (e) {
    return null;
  }
}

async function checkAllowlist(idToken, email, env) {
  if (!email) return false;
  const docId = encodeURIComponent(email.toLowerCase());
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/allowedEmails/${docId}`;
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
    return resp.ok; // 200 = doc exists + readable per rules · 404/403 = not on the list
  } catch (e) {
    return false; // fail closed — network hiccup should not grant free AI access
  }
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
