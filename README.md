# mailbox

Mevcut bir e-posta hesabına IMAP/SMTP üzerinden bağlanan, tarayıcıdan kullanılan hafif bir web posta istemcisi.

## Özellikler

- Giriş (oturum bellekte tutulur, parola diske veya ortam değişkenine yazılmaz; oturum süresi 8 saat).
- Klasör listesi, ileti listesi ve ileti okuma; ekleri indirme.
- Bayrak, okundu işareti, taşıma, arşivleme ve silme (toplu işlemler).
- İleti gönderme (ek destekli) ve taslak kaydetme/silme.

## Teknoloji

Node.js (>= 20, ES modül), Express 5, ImapFlow, Nodemailer, mailparser, multer, iconv-lite, `he`; arayüz tek dosya `public/index.html`.

## Kurulum ve çalıştırma

```bash
npm install
npm start      # node server.js
```

## Ortam değişkenleri (yalnız adlar)

`MAIL_HOST`, `IMAP_PORT`, `SMTP_PORT`, `PORT`

Hepsinin varsayılanı vardır. Hesap bilgileri ortam değişkeniyle değil, giriş ekranından alınır.

## Yapı

- `server.js`: API uçları (`/api/login`, `/api/folders`, `/api/messages`, `/api/message/:uid`, `/api/send`, `/api/draft` vb.)
- `mailtext.js`: ileti gövdesi seçimi ve özet çıkarma
- `public/`: arayüz

## Lisans

Lisans dosyası yok. `package.json` içinde `ISC` yazıyor.
