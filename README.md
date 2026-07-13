# ♞ SigmaBoy — Satranç Botu & Uygulaması

Tamamen tarayıcıda çalışan, bağımlılıksız (sıfır kütüphane) güçlü bir satranç motoru ve tam donanımlı arayüz. Motor bir Web Worker içinde çalışır; kurallar kütüphanesi perft testleriyle doğrulanmıştır.

## Çalıştırma

```bash
python3 -m http.server 8000
# tarayıcıda http://localhost:8000 adresini açın
```

(Web Worker kullanıldığı için `file://` yerine küçük bir HTTP sunucusu önerilir; worker açılamazsa uygulama otomatik olarak ana iş parçacığına düşer.)

## Motor (js/engine.js)

Arama:
- **İteratif derinleşme** + **aspirasyon pencereleri**
- **Alpha-beta (negamax) + PVS** (Principal Variation Search)
- **Transpozisyon tablosu** (2M giriş, çift 32-bit Zobrist anahtarı)
- **Null-move pruning**, **late move reductions (LMR)**, **futility pruning**, **mate-distance pruning**
- **Quiescence search** (şah kaçışları + delta pruning)
- Hamle sıralama: TT hamlesi → **MVV-LVA** → **killer moves** (2/kat) → **history heuristic**
- Şah uzatması, tekrar/50 hamle tespiti, **çoklu-PV** (analiz için 1-5 hat)

Değerlendirme (tapered mg/eg):
- PeSTO tarzı taş-kare tabloları
- Piyon yapısı: geçer / çift / izole piyonlar
- Fil çifti, (yarı) açık hatta kale, şah piyon kalkanı, hareketlilik, tempo

Ekstra: ~50 ana varyanttan kurulan **açılış kitabı** (670 pozisyon), 8 güç seviyesi (zayıf seviyelerde insansı gürültülü seçim).

## Arayüz

- **Oyna** — renk/seviye/süre seçimi, saatler (artımlı), ipucu, geri al, terk, açılış kitabı
- **Analiz** (chess.com tarzı) — canlı motor değerlendirmesi, değerlendirme çubuğu, çoklu hat, en iyi hamle oku, **Oyun Raporu**: hamle sınıflandırma (Parlak !!, En İyi ★, Mükemmel, İyi, Kitap, Tutarsızlık ?!, Hata ?, Vahim Hata ??), oyuncu başına **doğruluk yüzdesi**, tıklanabilir **değerlendirme grafiği**, varyant inceleme, PGN/FEN içe-dışa aktarma
- **Düzenleyici** (lichess tarzı) — taş paleti, sürükle-bırak, FEN girişi, hamle sırası/rok hakları, pozisyon doğrulama, "buradan oyna / analiz et"
- Sürükle-bırak + tıkla-oyna, yasal hamle noktaları, son hamle/şah vurguları, sağ tıkla **ok ve daire çizimi** (Shift/Alt/Ctrl ile renk), terfi seçici, yenen taşlar + materyal farkı, 4 tahta teması, tahta çevirme (F), klavye ile gezinme (ok tuşları), WebAudio ile sentezlenen sesler

## Testler

```bash
# hamle üretici doğrulaması (5 standart perft pozisyonu)
node -e "const SC=require('./js/chess.js');console.log(SC.perft(new SC.Position(SC.START_FEN),5))"
# → 4865609
```

## Dosyalar

| Dosya | İçerik |
|---|---|
| `js/chess.js` | Kural kütüphanesi (0x88, FEN/SAN/PGN, Zobrist, perft) |
| `js/engine.js` | Arama + değerlendirme + açılış kitabı + worker protokolü |
| `js/app.js` | Arayüz: tahta, modlar, rapor, saatler, düzenleyici |
| `js/pieces.js` | Özgün SVG taş seti |
| `js/sound.js` | Sentezlenmiş sesler |
