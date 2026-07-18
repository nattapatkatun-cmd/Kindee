# คู่มือตั้งค่าระบบ Login + AI Proxy (ต้องทำเองครั้งเดียว)

โค้ดฝั่งแอปพร้อมแล้วทั้งหมด — เหลือขั้นตอนใน console ที่ต้องทำด้วยบัญชีของคุณเอง
ทำตามลำดับ 1 → 5 (อย่าสลับ ลำดับมีผล) ใช้เวลารวมประมาณ 20–30 นาที

---

## ขั้นที่ 1: เปิด Google Sign-In ใน Firebase (~3 นาที)

1. เข้า https://console.firebase.google.com → เลือกโปรเจกต์ **kindee-f0cc1**
2. เมนูซ้าย **Build → Authentication** → กด **Get started** (ถ้ายังไม่เคยเปิด)
3. แท็บ **Sign-in method** → กด **Google** → เปิดสวิตช์ **Enable**
   - ช่อง *Project support email* เลือก `ojo0308@gmail.com` → **Save**
4. แท็บ **Settings → Authorized domains** → กด **Add domain** แล้วเพิ่ม:
   - `nattapatkatun-cmd.github.io`
   - (`localhost` มีให้อยู่แล้วโดย default — ใช้ทดสอบในเครื่องได้)

## ขั้นที่ 2: วาง Security Rules (~3 นาที)

> ⚠️ สำคัญ: ทำขั้นนี้ **ก่อนแชร์ลิงก์ให้ใครเด็ดขาด** — ตอนนี้ rules เดิมของคุณ
> อาจเปิดกว้างอยู่ ใครรู้ project id ก็อ่านข้อมูลได้

1. Firebase Console → **Build → Firestore Database → แท็บ Rules**
2. ลบของเดิมทั้งหมด แล้ววางเนื้อหาจากไฟล์ **`firestore.rules`** ใน repo นี้ → กด **Publish**
3. ไปที่ **Build → Storage → แท็บ Rules**
4. วางเนื้อหาจากไฟล์ **`storage.rules`** → **Publish**

หมายเหตุ: rules ชุดนี้ยังอนุญาตให้ *บัญชีคุณ (ojo0308@gmail.com) เท่านั้น*
อ่าน/ลบข้อมูลเก่าที่ path `users/nattapat` ได้ เพื่อใช้ตอน migration ในขั้นที่ 4

## ขั้นที่ 3: Deploy Cloudflare Worker (~10 นาที)

Worker ตัวเดิมของคุณ (`kindee.ojo0308.workers.dev`) จะถูกแทนด้วยโค้ดใหม่ที่ทำ
**ทั้งหน้าที่เดิม** (ส่งต่อไป Google Sheets) **และหน้าที่ใหม่** (Gemini proxy + โควตา)

1. เข้า https://dash.cloudflare.com → **Workers & Pages** → เลือก worker `kindee`
2. กด **Edit code** (Quick edit) → ลบโค้ดเดิม วางเนื้อหาจากไฟล์ **`worker/worker.js`** → **Deploy**
   - 💡 เผื่ออยากย้อนกลับ: copy โค้ดเดิมเก็บไว้ก่อนลบ
3. สร้าง KV namespace สำหรับนับโควตา:
   - เมนูซ้าย **Storage & Databases → KV** → **Create a namespace** → ตั้งชื่อ `kindee-quota`
4. ผูก KV เข้ากับ worker:
   - กลับไปที่ worker `kindee` → **Settings → Bindings** → **Add binding**
   - Type: **KV namespace** | Variable name: `QUOTA` (พิมพ์ตามนี้เป๊ะ ๆ) | เลือก namespace `kindee-quota`
5. ตั้งค่า Variables ที่ **Settings → Variables and Secrets** → เพิ่มทีละตัว:

   | ชื่อ | ชนิด | ค่า |
   |---|---|---|
   | `GEMINI_KEYS` | **Secret** (Encrypt) | key ทั้ง 4 ของคุณคั่นด้วย comma ไม่มีเว้นวรรค เช่น `AIzaX...,AIzaY...,AIzaZ...,AIzaW...` |
   | `FIREBASE_WEB_API_KEY` | Text | `AIzaSyBpbLSVFZ6Liml-QxmZYvoN_tkmxSmQGX0` (ค่า apiKey ใน firebaseConfig — เป็นค่า public อยู่แล้ว) |
   | `DAILY_LIMIT` | Text | `20` (โควตา AI ต่อคนต่อวัน — ปรับได้ตามใจ) |
   | `ALLOWED_ORIGIN` | Text | `https://nattapatkatun-cmd.github.io` |

6. กด **Deploy** อีกครั้งหลังตั้งค่าเสร็จ

**ทดสอบ:** เปิด terminal หรือ browser แล้วยิง
`https://kindee.ojo0308.workers.dev/gemini` แบบ POST เปล่า ๆ — ถ้าได้
`{"error":"auth","message":"ต้องเข้าสู่ระบบก่อนใช้ฟีเจอร์ AI"}` แปลว่า worker ทำงานถูกต้อง

## ขั้นที่ 4: Login ครั้งแรก + ย้ายข้อมูลเดิม (~5 นาที)

1. เปิดแอป https://nattapatkatun-cmd.github.io/Kindee/ (ถ้ามีแบนเนอร์
   "มีอัปเดตใหม่" ให้แตะก่อน)
2. จะเจอหน้า login → กด **เข้าสู่ระบบด้วย Google** → เลือก `ojo0308@gmail.com`
3. แอปจะตรวจพบข้อมูลเดิมและถามว่า *"คัดลอกทั้งหมดเข้าบัญชี...?"* → กด **OK**
   - ระบบจะ **copy** (ไม่ใช่ย้าย) ข้อมูลทุก collection: มื้ออาหาร, โปรด, workout,
     น้ำหนัก, strength log, sleep, body comp ฯลฯ เข้า path ของบัญชีคุณ
   - เสร็จแล้วจะแจ้งจำนวนรายการและ reload อัตโนมัติ
4. **ตรวจสอบ:** ไล่ดู Dashboard / ประวัติมื้อ / น้ำหนัก / Strength ว่าข้อมูลครบ
5. ข้อมูลต้นฉบับที่ `users/nattapat` **ยังอยู่ครบ ไม่ถูกลบ** — เก็บไว้กี่วันก็ได้
   มั่นใจแล้วค่อยลบทีหลังผ่าน Firebase Console (Firestore → users → nattapat)
   หรือปล่อยไว้เฉย ๆ ก็ไม่มีอันตราย เพราะ rules กันคนอื่นเข้าไว้แล้ว

## ขั้นที่ 5: ทดสอบก่อนแชร์ (~5 นาที)

1. ลองฟีเจอร์ AI สักอย่าง (เช่น ถ่ายรูปอาหาร) — ควรทำงานได้**โดยไม่ต้องมี
   API key ในเครื่อง** (เรียกผ่าน worker แล้ว)
2. ทดสอบด้วยบัญชี Google อีกอัน (หรือเครื่องเพื่อน): login แล้วต้องเจอแอป**ว่างเปล่า**
   ไม่เห็นข้อมูลคุณ — ถ้าเห็นข้อมูลคุณแปลว่า rules ยังไม่ถูก publish กลับไปขั้นที่ 2
3. ผ่านทั้งสองข้อ = **แชร์ลิงก์ได้เลย** 🎉

---

## เรื่องที่ควรรู้หลังเปิดใช้

- **โควตา AI:** ผู้ใช้แต่ละคนใช้ AI ได้ `DAILY_LIMIT` ครั้ง/วัน (ตั้งไว้ 20)
  เกินแล้วจะขึ้นข้อความบอกในแอป — free tier ของ Gemini รับได้ ~250 req/วัน/key
  ดังนั้น 4 keys รองรับหลักสิบ users สบาย ๆ
- **การ์ด "Gemini API Keys (สำรอง)" ใน Settings:** ไม่ต้องใช้แล้วในการใช้งานปกติ
  เป็น fallback อัตโนมัติเฉพาะกรณี worker ล่มเท่านั้น
- **Google Sheets sync:** กลายเป็น per-user แล้ว — URL เดิมของคุณจะถูก restore
  อัตโนมัติจาก settings หลัง migration (ถ้าไม่ขึ้น ให้วาง URL ใน Settings →
  Google Sheets Sync → ทดสอบการเชื่อมต่อ หนึ่งครั้ง) ผู้ใช้คนอื่นไม่มีค่านี้
  ข้อมูลเขาจึงไม่วิ่งเข้า Sheet ของคุณ
- **Logout/สลับบัญชีบนเครื่องเดียว:** แอปเคลียร์ข้อมูล cache ในเครื่องอัตโนมัติ
  เมื่อ uid เปลี่ยน ข้อมูลจริงอยู่บน Firestore เสมอ
