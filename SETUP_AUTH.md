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

## ขั้นที่ 6 (🆕 อัปเดต): เปิดระบบ Allowlist — ปิดไม่ให้คนแปลกหน้าสมัครได้

เดิมใครมีลิงก์ก็กด login แล้วได้บัญชีเต็มรูปแบบทันที ไม่มีการควบคุมเลย
อัปเดตนี้เพิ่มด่านตรวจ: **login ด้วย Google ได้เสมอ แต่ใช้แอปได้ต้องมีชื่อ
อีเมลอยู่ใน allowlist ก่อน** ทั้งฝั่งข้อมูล (Firestore) และฝั่ง AI (Worker)
เช็คจากลิสต์เดียวกัน ไม่ต้องจำสองที่

> ⚠️ **ต้องทำขั้นที่ 6.1 ก่อนเปิดแอปทดสอบ ไม่งั้นจะล็อกตัวเองออกจากแอป** —
> รวมถึงบัญชีเจ้าของแอปเองก็ต้องอยู่ใน allowlist ด้วย ไม่มีข้อยกเว้น
> (path ข้อมูลเก่า `users/nattapat` ยังเข้าได้เสมอโดยไม่ต้องอยู่ใน allowlist
> เพื่อกัน bootstrap ตัวเองล็อกตัวเอง แต่ข้อมูล "ปัจจุบัน" ของบัญชีคุณหลัง
> migrate แล้วต้องผ่าน allowlist เหมือนคนอื่น)

### 6.1 เพิ่มอีเมลตัวเองในนี้ก่อนเลย (~2 นาที)

1. Firebase Console → **Build → Firestore Database → แท็บ Data**
2. กด **Start collection** → Collection ID: `allowedEmails`
3. Document ID: `ojo0308@gmail.com` (พิมพ์เอง อย่าใช้ Auto-ID — ต้องเป็นอีเมล
   ตัวพิมพ์เล็กทั้งหมดเป๊ะ ๆ เพราะแอปเทียบแบบ lowercase)
4. เพิ่ม field อะไรก็ได้ 1 อัน เช่น `note` (string) = `owner` → **Save**
   (เนื้อหา field ไม่สำคัญ แค่ต้องมี document อยู่ที่ ID นี้)

### 6.2 วาง Rules + Worker เวอร์ชันใหม่

1. Firestore Database → Rules → ลบของเดิม วางเนื้อหาใหม่จาก **`firestore.rules`** → **Publish**
2. Cloudflare → worker `kindee` → Edit code → วางเนื้อหาใหม่จาก **`worker/worker.js`** → **Deploy**
   (ไม่มี Variable/KV ใหม่ต้องตั้งเพิ่ม ใช้ของเดิมจากขั้นที่ 3 ได้เลย)

### 6.3 เพิ่มคนอื่นเข้า allowlist (ทำได้เรื่อย ๆ ตอนอยากเชิญใครเพิ่ม)

ทำซ้ำขั้น 6.1 แต่เปลี่ยน Document ID เป็นอีเมล (ตัวพิมพ์เล็ก) ของคนที่จะเชิญ
— ไม่ต้องแก้โค้ด ไม่ต้อง deploy ใหม่ เพิ่มปุ๊บใช้ได้ทันที (login ใหม่หรือรีเฟรชหน้า)

### 6.4 หน้าตาตอนคนที่ไม่ได้รับอนุญาต login

จะ login ด้วย Google ผ่านปกติ แต่แอปจะเปลี่ยนไปแสดงหน้า **"🔒 ยังไม่ได้รับสิทธิ์
ใช้งาน"** แทนหน้าแอปปกติ พร้อมปุ่มออกจากระบบ/ลองบัญชีอื่น — ไม่ใช่ error
แบบ "โหลด Firebase ไม่สำเร็จ" ที่อาจดูเหมือนแอปพัง

---

## เรื่องที่ควรรู้หลังเปิดใช้

- **Allowlist ไม่ใช่ของถาวร:** ตอนพร้อมเปิด public จริง (เช่น ขึ้น Play Store)
  แค่ลบเงื่อนไข `isAllowed()` ออกจาก `firestore.rules` (เหลือแค่เช็ค uid) และ
  ลบส่วนเช็ค allowlist ออกจาก `worker.js` แล้ว publish/deploy ใหม่ — ไม่กระทบ
  auth หรือข้อมูลเดิมเลย เป็นแค่ flag เปิด/ปิด
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
