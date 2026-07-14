# ♞ SigmaBoy — Satranç Botu & Uygulaması

Tamamen tarayıcıda çalışan, bağımlılıksız (sıfır kütüphane) güçlü bir satranç motoru ve tam donanımlı arayüz. Motor bir Web Worker içinde çalışır; kurallar kütüphanesi perft testleriyle doğrulanmıştır.

## Çalıştırma

**En kolay yol — tek dosya:** `dist/sigmaboy.html` dosyasını indirip çift tıklayın. Her şey (motor dahil) içine gömülüdür, sunucu gerekmez.

**Depodan geliştirme sunucusuyla:**

```bash
git clone <repo> && cd sigmaboy
git checkout claude/chess-bot-app-nhz0i0   # kod bu daldadır
python3 -m http.server 8000
# tarayıcıda http://localhost:8000 adresini açın
```

Not: `index.html` doğrudan `file://` ile açılırsa Web Worker güvenlik kısıtına takılır; uygulama bunu algılar ve motoru otomatik olarak ana iş parçacığında çalıştırır (arayüz yine tam çalışır, motor düşünürken kısa takılmalar olabilir). Tek dosyalık `dist/sigmaboy.html` bu kısıta takılmaz: worker'ı gömülü kaynaktan (blob) oluşturur.

Tek dosyayı yeniden üretmek için: `node build.js`

## Motor (js/engine.js)

Arama:
- **İteratif derinleşme** + **aspirasyon pencereleri**
- **Alpha-beta (negamax) + PVS** (Principal Variation Search)
- **Transpozisyon tablosu** (2M giriş, çift 32-bit Zobrist anahtarı, yaş + derinlik öncelikli değiştirme)
- **Null-move pruning** (dinamik R), **reverse futility (static null move)**, **razoring**
- **Late move reductions** (logaritmik tablo, improving/killer ayarlı), **late move pruning**, **futility pruning**, **mate-distance pruning**
- **SEE (Static Exchange Evaluation)**: quiescence'ta ve sığ derinlikte kaybeden alışların budanması
- **Quiescence search** (şah kaçışları + delta pruning + SEE)
- Hamle sıralama: TT hamlesi → **MVV-LVA** → **killer moves** (2/kat) → **countermove** → **history heuristic**
- **Internal iterative deepening (IID)**, şah uzatması, tekrar/50 hamle tespiti, **çoklu-PV** (1-5 hat)

Değerlendirme (tapered mg/eg):
- PeSTO tarzı taş-kare tabloları
- Piyon yapısı: geçer (abluka cezalı) / çift / izole piyonlar
- **Şah güvenliği**: saldırı bölgesi birimleri (vezir varlığına duyarlı) + piyon kalkanı
- Fil çifti, (yarı) açık hatta kale, hareketlilik, tempo

Ekstra: ~50 ana varyanttan kurulan **açılış kitabı** (670 pozisyon), 9 güç seviyesi (zayıf seviyelerde insansı gürültülü seçim).

### Güç ölçümleri

Sürüm karşılaştırması (150 ms/hamle, kendi kendine maç):
- v1 → v2: **+13 =4 -3 (%75) ≈ +190 Elo**
- v2 → v2s (hızlı chess.js yığınları): aynı sürede ~%15 daha fazla düğüm, 3 sn'de derinlik 15→16

**Elo kalibrasyonu** — Stockfish 18 Lite (WASM) sınırlı güç kipine (UCI_Elo) karşı,
her basamak 12 oyun, SigmaBoy 150 ms/hamle:

| Rakip | Sonuç | Skor | Performans |
|---|---|---|---|
| SF UCI_Elo 2000 | +9 =1 -2 | %79 | ≈ 2232 |
| SF UCI_Elo 2200 | +10 =1 -1 | %88 | ≈ 2538 |
| SF UCI_Elo 2400 | +8 =1 -3 | %71 | ≈ 2554 |

Toplu tahmin: hızlı zaman kontrolünde (150 ms/hamle) **≈ 2400-2550 Elo**
(SF UCI_Elo ölçeğinde; ±100 örneklem payı). Seviye 7-9 (2,5-12 sn/hamle)
belirgin şekilde daha güçlü oynar.

### NNUE (deneysel)

Motor, Stockfish 18 Lite değerlendirmesinden damıtılmış 768→128 clipped-ReLU
**NNUE** ağı içerir (`js/nnue.js`, int16 kuantalı, artımlı akümülatörlü —
sıfırdan hesapla birebirliği 1230 düğümde doğrulandı; NNUE kipinde motor
saniyede 422 bin düğüme çıkar). Kıyas maçlarında klasik el yapımı değerlendirme
(HCE) hâlâ daha güçlü olduğundan **varsayılan kip HCE'dir**; ağ `engine.evalMode
= 'nnue'` ile etkinleştirilebilir. Eğitim hattı (`gen-positions` → SF etiketleme
→ SGD eğitimi) yeniden çalıştırılabilir durumda.

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
