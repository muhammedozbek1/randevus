# Hostinger Kurulum Kılavuzu

Beyaz Kuaför uygulaması **statik bir site değil** — Node.js sunucusudur.
Bu yüzden FTP ile `public_html` içine dosya atıp bırakmak **çalıştırmaz**.
Aşağıdaki adımlar sırayla uygulanmalıdır.

---

## 0. Ön kontrol — planınız Node.js destekliyor mu?

hPanel → **Advanced** menüsünde **"Node.js"** kartı var mı?

- **Var** → devam edin (Aşağıdaki adımlar).
- **Yok** → bu plan paylaşımlı hosting'de Node.js çalıştıramaz.
  Ya planı yükseltin (Business/Premium, Cloud Hosting) ya da **VPS** alın.
  (VPS daha temizdir; `deploy/HOSTINGER-VPS.md` dosyasına bakın.)

---

## 1. "Web sitesi tanınamadı" hatasının çözümü

Bu hata iki sebeple olur:

### 1a. Domain website'e atanmamış

hPanel → **Websites** → domainin yanındaki **⋮** → **Assign Website**
→ `lawngreen-jackal-570185.hostingersite.com` seçin → **Assign**.

> Geçici `hostingersite.com` adresi mutlaka bir website'e atanmalıdır.

### 1b. Dosyalar document root içinde değil

hPanel → **File Manager** → `public_html` klasörüne girin.
**`index.html` doğrudan `public_html` içinde olmalı** (bir alt klasörde değil).

Kontrol listesi:
- [ ] `public_html/index.html` var mı?
- [ ] `public_html/server.js` var mı?
- [ ] `public_html/data/db.json` var mı?
- [ ] `public_html/sites/ornek/` var mı?

---

## 2. Dosyaları yükleme

Bu depoda hazırlanan `beyaz-kuafor-hostinger.zip` dosyası **düz (klasörsüz)** yapıdadır.

hPanel → File Manager → `public_html` → **Upload** → ZIP'i yükleyin → sağ tık →
**Extract** → mevcut klasöre çıkarın.

> ZIP'i çıkardıktan sonra `public_html/beyaz-kuafor/...` gibi bir klasör
> oluşmuşsa, içindeki dosyaları bir seviye yukarı taşıyın.

### Dosya izinleri
`public_html/data/db.json` → sağ tık → **Permissions** → `644`
`public_html/data` klasörü → `755`

---

## 3. Node.js uygulamasını kur (EN ÖNEMLİ ADIM)

hPanel → **Advanced** → **Node.js** → **Setup Node.js App**

| Alan | Değer |
|---|---|
| Node.js version | **22** (yoksa 20) |
| Application mode | **Production** |
| Application root | `public_html` ← **kök klasör olmalı** |
| Startup file | `startup.js` (veya `server.js`) |
| Application URL | `lawngreen-jackal-570185.hostingersite.com` |

Sonra **Create** → **Start**.

> **Neden "Application root" = `public_html` olmalı?**
> Uygulama `/api/...` adreslerini **kök yoldan** çağırır. Uygulama bir alt
> klasöre (örn. `public_html/nodeapp`) konursa adresler `/nodeapp/api/...`
> olur ve panel "Sunucuya ulaşılamıyor" der.
> (Uygulama alt klasörde çalışsa da API öneki otomatik uyarlanır, yine de
> kök klasör en temiz yoldur.)

### Environment variables (varsa)
| Değişken | Değer |
|---|---|
| `PORT` | **Boş bırakın** — Passenger kendisi verir |
| `HOST` | `0.0.0.0` |
| `DEFAULT_USER` | `admin` |
| `DEFAULT_PASS` | `<güçlü şifre>` |
| `DEFAULT_PIN` | `<4-6 rakam>` |

Ortam değişkeni ekranı yoksa `startup.js` içindeki `process.env.*` satırlarını
kendi şifrenizle düzenleyin.

### "Start" sonrası
Node.js sayfasında uygulama **running** ve bir **port** numarası görünmelidir.
Port boş/kapalı görünüyorsa uygulama çökmüştür: **hPanel → Advanced → Node.js →
Logs** bölümünden hatayı okuyun.

---

## 4. Kontrol (tarayıcıda)

1. `https://lawngreen-jackal-570185.hostingersite.com/` → **index sayfası** açılmalı
2. `/login.html` → giriş ekranı açılmalı, **site listesi dolu gelmeli**
   (liste boşsa API çalışmıyor demektir → 3. adımı kontrol edin)
3. Varsayılan kullanıcı bilgileriyle giriş (`admin` / README'deki şifre) → panel açılmalı
4. Randevu formu: `/randevu.html` → randevu oluşturun → panelde "Online Randevular"
   sekmesinde görünmeli

---

## 5. SSL (HTTPS)

hPanel → **Security** → **SSL** → **Install** (Let's Encrypt, ücretsiz).
Kendi domaininizi bağladığınızda tekrarlayın.

---

## 6. Canlıya almadan önce güvenlik

Panelden mutlaka değiştirin:

- [ ] **Ayarlar → Kullanıcılar** → `admin` şifresi (`beyaz2026` → güçlü şifre)
- [ ] **Ayarlar → PIN Kodu** → PIN (`1234` → 4-6 rakam)
- [ ] Örnek siteyi kaldırmak isterseniz: File Manager'da `public_html/sites/ornek`
      klasörünü silin (giriş ekranındaki "Örnek Kuaför" de kaybolur)

---

## 7. Yedekleme

`data/db.json` dosyası tüm verinizdir (randevular, işlem geçmişi, kasa, ayarlar).
`.gitignore` içinde olduğu için GitHub'a çıkmaz — **kendi yedeğinizi alın**.

hPanel → **Advanced → Cron Jobs** (Business/Premium) ile günlük yedek:

```
0 3 * * * tar -czf /home/USER/backups/db-$(date +\%F).tar.gz -C /home/USER/domains/DOMAIN/public_html data/db.json
```

---

## 8. Sorun giderme

| Belirti | Sebep / Çözüm |
|---|---|
| "Web sitesi tanınamadı" | Domain atanmamış (1a) veya dosyalar `public_html` dışında (1b) |
| Sayfa açılıyor ama giriş "Sunucuya ulaşılamıyor" | Node.js uygulaması kurulmamıyor / çalışmıyor (3. adım) |
| 404 "Bilinmeyen uç nokta" | Application root yanlış (alt klasörde çalışıyor) → `public_html` yapın |
| Site listesi boş | API çalışmıyor → Node.js loglarını kontrol edin |
| Dosya yazma hatası | `data/` klasörü izinleri → 755, `db.json` → 644 |
| Node.js başlamıyor | Node sürümü 22 yok → 20 seçin; loglara bakın |
