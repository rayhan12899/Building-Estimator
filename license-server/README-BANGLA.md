# Building Estimator License Server (বাংলা)

## গুরুত্বপূর্ণ
এই ZIP-এ Electron client ও license-server source যুক্ত হয়েছে। **এটি চালু করতে একটি HTTPS server deploy করতে হবে**; server URL এবং signing key বসানোর আগে Product Key activation production-ready হবে না।

## Server setup
1. `license-server` ফোল্ডারে Node.js 20+ ব্যবহার করুন।
2. `npm install` চালান।
3. এই ZIP-এর `private-key.pem` এবং client-এর `electron/main.js`-এর Public Key পরস্পরের সঙ্গে মিলে যায়। `private-key.pem` কখনো public GitHub repo, installer বা customer-এর কাছে দেবেন না। Server host-এর secret/environment-এ private key রাখুন। নতুন key pair চাইলে `node generate-key.js` চালিয়ে নতুন Public Key client-এ বসান।
4. Linux/macOS-এ `export BE_LICENSE_PRIVATE_KEY="$(cat private-key.pem)"` এবং একটি শক্তিশালী `BE_LICENSE_ADMIN_TOKEN` সেট করুন। Windows PowerShell-এ `$env:BE_LICENSE_PRIVATE_KEY = Get-Content -Raw .\private-key.pem` এবং `$env:BE_LICENSE_ADMIN_TOKEN = "আপনার-দীর্ঘ-গোপন-টোকেন"` দিন। Environment variables সেট করুন: `BE_LICENSE_ADMIN_TOKEN`, `BE_LICENSE_PRIVATE_KEY` (private-key.pem-এর সম্পূর্ণ PEM content environment secret হিসেবে দিন), `PORT`, প্রয়োজনে `BE_LICENSE_DB`। Persistent disk ব্যবহার করুন; JSON DB ephemeral hosting-এ রাখবেন না।
5. `npm start` চালান এবং HTTPS reverse proxy/hosting দিন। `/health` দিয়ে পরীক্ষা করুন।
6. `electron/main.js`-এ `LICENSE_API_URL`-এর placeholder-কে আপনার HTTPS API URL দিয়ে বদলান এবং `LICENSE_PUBLIC_KEY`-এ server-এর public key বসান।
7. Electron rebuild করে Setup.exe প্রকাশ করুন।

## Admin API

উদাহরণ (PowerShell): `Invoke-RestMethod -Method Post -Uri https://YOUR-HOST/admin/keys -Headers @{Authorization="Bearer YOUR_ADMIN_TOKEN"} -ContentType "application/json" -Body '{"count":3,"expiresAt":"2027-11-19T00:00:00.000Z"}'`। Lifetime key-এর জন্য `expiresAt` বাদ দিন।
- Key তৈরি: `POST /admin/keys`, header `Authorization: Bearer <BE_LICENSE_ADMIN_TOKEN>`, JSON `{ "count": 5, "expiresAt": "2027-11-19T00:00:00.000Z" }`। Lifetime-এর জন্য `expiresAt` বাদ দিন।
- Key বাতিল: `POST /admin/revoke`, একই Authorization header, JSON `{ "key": "BE25-XXXXXX-XXXXXX-XXXXXX" }`।
- মেয়াদ admin key generation-এর সময় নির্ধারিত হয়। বিদ্যমান key expiry পরিবর্তন করতে server DB-তে সংশ্লিষ্ট `expiresAt` ISO date update করুন।

## Client behavior
প্রথম online `/v1/status` request-এ server ২৪ ঘণ্টার Trial clock শুরু করে। App launch-এর সময় online verification হয়। Trial expired হলে Activation page ছাড়া estimator খুলবে না। Product Key একবার একটি device ID-তে bind হয়। Internet না থাকলে online policy অনুযায়ী verification ব্যর্থ হবে এবং estimator খুলবে না।

## Release safety
- `main.js`/`preload.js`-এ কেবল license IPC যোগ হয়েছে; estimator HTML/Calculation engine/PDF/Document Manager/Updater logic পরিবর্তন করা হয়নি।
- Device ID Windows-এর stable Machine ID থেকে hash করা হয়; সাধারণ app reinstall বা AppData cleanup-এ এটি বদলায় না। OS reinstall/hardware identity পরিবর্তন হলে Admin-কে server DB-তে পুরোনো device binding reset করতে হবে।
- Admin API-কে HTTPS, strong secret, firewall/rate limit ও persistent storage দিয়ে সুরক্ষিত রাখুন।
