# คู่มือตั้งค่าแอป Android + Health Connect (ทำครั้งเดียว)

แอป Android ของ Kindee คือหน้าเว็บเดิม (`index.html` บน GitHub Pages) ที่ห่อด้วย
[Capacitor](https://capacitorjs.com) เพื่อให้อ่านข้อมูลจาก **Health Connect** ได้
ซึ่งเว็บเบราว์เซอร์ทำไม่ได้

- แก้ `index.html` แล้ว deploy → แอปเห็นทันที **ไม่ต้อง build ใหม่**
- ต้อง build APK ใหม่เฉพาะเมื่อแก้ `android/`, `www/`, `capacitor.config.json` หรือ plugin
- แอปต้องต่ออินเทอร์เน็ตตอนเปิด (โหลดหน้าแอปจากเว็บ)

## ข้อมูลที่ดึงเข้า Kindee

| ดึง | ไม่ดึง (ตั้งใจ) |
|---|---|
| การนอน: เวลาเข้านอน/ตื่น, Deep, REM, เวลาบนเตียง | คะแนน Recovery / Readiness / Energy Score ของอุปกรณ์ — Kindee คำนวณ Recovery เอง ถ้าดึงมาจะมีสองตัวเลขขัดกัน |
| HRV, RHR, อัตราการหายใจ (ช่วงที่นอน) | Workout — เสี่ยงนับแคลอรี่ซ้ำกับที่บันทึกเอง ซึ่งทำให้เป้าแคลอรี่ผิด |
| ก้าวเดินรายวัน (ตัดวันตอน 04:00 แบบเดียวกับในแอป) | Nightly Recharge / Cardio Load ของ Polar (Health Connect ไม่มีข้อมูลนี้ — ต้องใช้ Polar AccessLink ในเฟส 2) |

กติกาการรวมข้อมูล:
- **ค่าที่กรอกเอง** (หรือนำเข้าจากรูป/Sheet) **ไม่ถูกเขียนทับ** — Health Connect เติมเฉพาะช่องที่ว่าง
- คืนที่มาจาก Health Connect จะถูกอัปเดตทุกครั้งที่ sync
- ถ้าใส่หลายเครื่องพร้อมกัน (แหวน + Polar) ระบบใช้แหล่งเดียวต่อคืน ไม่บวกกัน
  เลือกเองได้ที่ Settings → Health Connect → "แหล่งข้อมูลการนอน"
- ก้าวเดิน: ใช้ค่าที่ **มากกว่า** ระหว่างของเดิมกับ Health Connect
- ทุกคืนที่นำเข้าผ่านการตรวจช่วงค่าและคำนวณ Sleep Score แบบเดียวกับที่กรอกเอง
- Sync อัตโนมัติตอนเปิดแอปหรือกลับเข้าแอป (ห่างกันอย่างน้อย 15 นาที) หรือกด "Sync ตอนนี้"

---

## ขั้นที่ 1: ใส่กุญแจเซ็นแอปใน GitHub Secrets (~3 นาที)

กุญแจนี้ต้องเป็น **ตัวเดิมตลอดไป** — ถ้าหาย จะติดตั้งแอปเวอร์ชันใหม่ทับตัวเก่าไม่ได้
(ต้องถอนแอป = ข้อมูลในเครื่องหาย) และ Google Sign-In จะใช้ไม่ได้
**เก็บไฟล์ `kindee-release.jks` และรหัสผ่านไว้ที่ปลอดภัย** (เช่น Google Drive ส่วนตัว / password manager)

1. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**
2. เพิ่ม 2 ตัว:

   | ชื่อ | ค่า |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | เนื้อหาทั้งหมดของไฟล์ `keystore.base64.txt` |
   | `ANDROID_KEYSTORE_PASSWORD` | เนื้อหาของไฟล์ `keystore-password.txt` |

ลายนิ้วมือของกุญแจนี้ (ใช้ในขั้นที่ 2):

```
SHA-1:   F4:B1:18:F0:BD:33:29:96:E3:F8:8A:C5:FA:C2:03:2D:22:F4:1A:9D
SHA-256: A7:C7:A9:60:2A:93:BF:2B:4C:20:D6:DB:2F:62:5D:22:1E:34:8F:C7:A8:AF:05:5D:B3:1A:6C:47:8F:B9:A7:2F
```

## ขั้นที่ 2: เพิ่มแอป Android ใน Firebase (~5 นาที)

Google ไม่อนุญาตให้ login ผ่านหน้าเว็บที่ฝังในแอป (WebView) แอปจึงใช้หน้าเลือกบัญชี Google
แบบ native ของ Android แทน ซึ่งต้องลงทะเบียนแอปใน Firebase ก่อน

1. https://console.firebase.google.com → โปรเจกต์ **kindee-f0cc1** → ⚙️ **Project settings**
2. แท็บ **General** → **Your apps** → **Add app** → ไอคอน **Android**
   - Android package name: `com.nattapat.kindee` (พิมพ์ตามนี้เป๊ะ ๆ)
   - App nickname: `Kindee Android`
   - Debug signing certificate SHA-1: `F4:B1:18:F0:BD:33:29:96:E3:F8:8A:C5:FA:C2:03:2D:22:F4:1A:9D`
   - กด **Register app**
3. หลังสร้างเสร็จ ในการ์ดแอป Android กด **Add fingerprint** → ใส่ SHA-256 ด้านบนด้วย
4. กด **Download google-services.json**
5. อัปโหลดไฟล์เข้า repo ที่ path **`android/app/google-services.json`**
   (GitHub → เข้าโฟลเดอร์ `android/app` → **Add file → Upload files**)
   - ไฟล์นี้มีแค่ค่า config สาธารณะชุดเดียวกับที่อยู่ใน `index.html` อยู่แล้ว commit ได้

Google Sign-In ใน Firebase เปิดไว้แล้วตั้งแต่ `SETUP_AUTH.md` ขั้นที่ 1 ไม่ต้องทำซ้ำ

## ขั้นที่ 3: Build APK (~10 นาที, อัตโนมัติ)

workflow `.github/workflows/android.yml` จะ build ทุกครั้งที่มี push ที่แก้ไฟล์ฝั่ง Android
หรือสั่งเองที่ **Actions → android → Run workflow**

1. เปิด run ล่าสุดที่เป็นสีเขียว → ล่างสุดหัวข้อ **Artifacts** → ดาวน์โหลด `kindee-android-<เลข>`
2. แตก zip จะได้ `app-release.apk`

ถ้าไม่มี artifact ให้ดู warning ใน run — แปลว่ายังขาด secret (ขั้นที่ 1) หรือ
`google-services.json` (ขั้นที่ 2) ระบบตั้งใจไม่ปล่อย APK ที่ยังตั้งค่าไม่ครบ
เพราะจะติดตั้งไม่ได้หรือ login ไม่ได้

## ขั้นที่ 4: ติดตั้งบนมือถือ

1. ส่งไฟล์ APK เข้ามือถือ แล้วแตะเปิด
2. ถ้าขึ้นว่าไม่อนุญาตแหล่งที่ไม่รู้จัก → อนุญาตให้แอปที่ใช้เปิดไฟล์ (เช่น Files / Chrome) ติดตั้งแอปได้
3. เวอร์ชันถัดไปติดตั้งทับได้เลย ข้อมูลไม่หาย (เพราะใช้กุญแจเดิม)

Health Connect มีในเครื่องอยู่แล้วบน Android 14 ขึ้นไป ถ้าเป็น Android 9–13
ให้ติดตั้งแอป **Health Connect** จาก Play Store

## ขั้นที่ 5: ให้แอปอุปกรณ์ส่งข้อมูลเข้า Health Connect

ต้องทำในแอปของแต่ละอุปกรณ์ก่อน (ชื่อเมนูอาจต่างไปตามเวอร์ชัน):

- **Samsung Health / Galaxy Ring**: Samsung Health → ⋮ → Settings → **Health Connect** →
  อนุญาตการนอน, ก้าวเดิน, อัตราการเต้นหัวใจ, HRV, อัตราการหายใจ
- **Polar Flow** (ต้อง 5.9 ขึ้นไป): Settings → **Connected applications → Health Connect**
- **Garmin Connect**: Settings → **Connected Apps → Health Connect** — Garmin ส่งการนอนและก้าวเดิน
  แต่ไม่ส่ง HRV Status / Body Battery

ตรวจได้ที่ Settings ของเครื่อง → Health Connect → **Data and access** ว่ามีข้อมูลเข้ามาแล้ว

## ขั้นที่ 6: เชื่อมต่อใน Kindee

1. เปิดแอป Kindee → login ด้วย Google (หน้าเลือกบัญชีของ Android)
2. **Settings → ❤️ Health Connect → เชื่อมต่อ Health Connect**
3. อนุญาตทุกประเภทที่ขอ (อ่านอย่างเดียว ไม่ขอเขียน) รวมถึง "อ่านข้อมูลย้อนหลัง" ถ้ามีให้เลือก
4. แอปจะ sync ทันที ครั้งแรกย้อนหลัง 30 วัน (90 วันถ้าอนุญาตอ่านย้อนหลัง)

ถ้าใส่แหวนกับนาฬิกาพร้อมกัน ให้เลือก "แหล่งข้อมูลการนอน" เป็นเครื่องที่เชื่อถือที่สุด

## แก้ปัญหา

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| Login ไม่ขึ้นหน้าเลือกบัญชี หรือขึ้น error ว่า developer console / `DEVELOPER_ERROR` / no credentials | SHA-1 ใน Firebase ไม่ตรงกับกุญแจ หรือ `google-services.json` เป็นตัวเก่า → ตรวจขั้นที่ 2 แล้ว build ใหม่ |
| Login ได้แต่ขึ้นว่าไม่มีสิทธิ์ใช้งาน | อีเมลยังไม่อยู่ใน `allowedEmails` (ดู `SETUP_AUTH.md`) |
| Sync ได้ 0 คืน | แอปอุปกรณ์ยังไม่ได้ส่งข้อมูลเข้า Health Connect (ขั้นที่ 5) หรือกดปฏิเสธสิทธิ์ → กด "ตั้งค่าสิทธิ์ใน Health Connect" |
| HRV ว่าง | อุปกรณ์/แอปนั้นไม่ส่ง HRV เข้า Health Connect — กรอกเองได้เหมือนเดิม |
| ติดตั้งทับไม่ได้ "App not installed" | APK ถูกเซ็นด้วยกุญแจอื่น — ตรวจว่า secret ในขั้นที่ 1 เป็นกุญแจเดิม |
| เปิดแอปแล้วขึ้น "เชื่อมต่ออินเทอร์เน็ตไม่ได้" | แอปโหลดหน้าจาก GitHub Pages ต้องต่อเน็ต แล้วกด "ลองใหม่" |

## สำหรับนักพัฒนา

```bash
npm ci
npx cap sync android        # คัดลอก www/ + config เข้า android/ (ไฟล์เหล่านี้ถูก gitignore)
cd android && ./gradlew assembleRelease
```

- โค้ดฝั่งเว็บที่ใช้ native อยู่หลัง `isNativeApp()` ใน `index.html` — เรียก plugin ผ่าน
  `window.Capacitor.nativePromise()` เพราะไม่มี bundler ให้ import `@capacitor/core`
- แอป Android **ไม่ใช้ service worker** — bridge ของ Capacitor ถูกฉีดเฉพาะ response ที่ native
  ส่งเอง หน้าที่มาจาก cache ของ SW จะไม่มี bridge
- สิทธิ์ Health Connect ที่ประกาศใน `android/app/src/main/AndroidManifest.xml` ต้องตรงกับ
  `HC_READ_TYPES` ใน `index.html` (plugin ประกาศทุกประเภทแบบอ่าน+เขียน เราลบส่วนที่ไม่ใช้ออก)
