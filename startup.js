/* ==========================================================================
   Beyaz Kuaför — Başlangıç dosyası (Hostinger / Passenger)
   --------------------------------------------------------------------------
   hPanel → Advanced → Node.js → "Setup Node.js App" ekranındaki
   "Startup file" alanına `startup.js` yazabilirsiniz. Passenger uygulamayı
   `node startup.js` ile başlatır ve PORT ortam değişkenini kendisi verir.

   Bu dosya yalnızca eksik ortam değişkenlerini tamamlar; asıl sunucu
   `server.js` dosyasıdır. İsterseniz startup file olarak doğrudan
   `server.js` de yazabilirsiniz — bu durumda bu dosya kullanılmaz.
   ========================================================================== */
'use strict';

process.env.HOST = process.env.HOST || '0.0.0.0';

/* İsteğe bağlı: hPanel'de ortam değişkeni tanımlayamadıysanız
   varsayılan şifre/PIN'i buradan da değiştirebilirsiniz.
   (Örnek: process.env.DEFAULT_PASS = 'GucluSifre2026';) */

require('./server.js');
