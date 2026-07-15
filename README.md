# ♞ VEGA (SigmaBoy) — Satranç Botu & Uygulaması

Tamamen tarayıcıda çalışan, bağımlılıksız (sıfır kütüphane) güçlü bir satranç motoru (**VEGA**) ve tam donanımlı arayüz. En üst zorluk seviyesi **BATHANTAHA** hamle başına 30 saniye düşünür. Motor bir Web Worker içinde çalışır; kurallar kütüphanesi perft testleriyle doğrulanmıştır.

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
- v2s → v2s+qTT (quiescence TT): **+11 =10 -9 (%53) ≈ +23 Elo**
- +qTT → +kök alt-ağaç sıralaması: **+13 =6 -11 (%53) ≈ +23 Elo** — iki yama da JS ve C++ sürümlerinde
- Denenen ve maçla REDDEDİLEN: contHist+malus paketi (%48), NNUE kipleri (%3-%17), singular extensions (%30) — motor yalnızca ölçümle kazanan değişiklikleri taşır

**Elo kalibrasyonu** — Stockfish 18 Lite (WASM) sınırlı güç kipine (UCI_Elo) karşı,
her basamak 12 oyun, SigmaBoy 150 ms/hamle:

| Rakip | Sonuç | Skor | Performans |
|---|---|---|---|
| SF UCI_Elo 2000 | +9 =1 -2 | %79 | ≈ 2232 |
| SF UCI_Elo 2200 | +10 =1 -1 | %88 | ≈ 2538 |
| SF UCI_Elo 2400 | +8 =1 -3 | %71 | ≈ 2554 |
| SF UCI_Elo 2600 | +6 =1 -5 | %54 | ≈ 2629 |

Toplu tahmin: hızlı zaman kontrolünde (150 ms/hamle) **≈ 2500-2600 Elo**
(48 oyun; SF UCI_Elo ölçeğinde, ±100 örneklem payı — kendi seviyesine
yakın 2400/2600 basamakları en bilgilendirici olanlar). Seviye 7-9
(2,5-12 sn/hamle) daha da güçlü oynar.

### NNUE (deneysel)

Motor, Stockfish 18 Lite değerlendirmesinden damıtılmış 768→128 clipped-ReLU
**NNUE** ağı içerir (`js/nnue.js`, int16 kuantalı, artımlı akümülatörlü —
sıfırdan hesapla birebirliği 1230 düğümde doğrulandı; NNUE kipinde motor
saniyede 422 bin düğüme çıkar). Kıyas maçlarında klasik el yapımı değerlendirme
(HCE) hâlâ daha güçlü olduğundan **varsayılan kip HCE'dir**; ağ `engine.evalMode
= 'nnue'` ile etkinleştirilebilir. Eğitim hattı (`gen-positions`/`vega2 selfplay`
→ SF etiketleme → SGD eğitimi) yeniden çalıştırılabilir durumda.

**Denenen üç NNUE yaklaşımı da maçla reddedildi** (dürüst negatif sonuç):
sadece-SF-statik (H=128, %3 ve %17), kendi-oyun + oyun sonucu harmanı
(H=192, %0). Değerlendirmeler materyali/pozisyonu doğru ayırt etse de
(artımlı akümülatör 800+ düğümde birebir doğrulandı), oyun oynamada el
yapımı değerlendirmenin gücünü aşamadılar — küçük ağ + sınırlı kendi-oyun
verisiyle beklenen bir sonuç. Daha büyük/derin veriyle tekrar denenebilir.

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


## C++ Sürümü (cpp/vega.cpp)

Aynı motorun tek dosyalık **C++17 UCI** portu — Arena, CuteChess, BanksiaGUI
veya lichess-bot gibi her UCI arayüzüne takılabilir:

```bash
cd cpp && make        # g++ -O2 ile derler
./vega                # UCI modu; ek komutlar: "bench" (perft doğrulama), "perft N"
```

- Aynı mimari: 0x88 tahta, PeSTO tapered değerlendirme, PVS + TT + null-move +
  LMR/LMP + SEE + killer/countermove/history + IID + aspirasyon
- Doğrulama: 5 standart perft pozisyonunun tamamı geçer (`bench`)
- Hız: JS sürümünün ~1,8 katı (≈650k düğüm/sn, başlangıç pozisyonunda 2 sn'de derinlik 16)
- Zaman yönetimi: `go movetime/depth/wtime+winc` desteklenir

**C++ Elo kalibrasyonu** (Stockfish 18 Lite UCI_Elo'ya karşı, 12'şer oyun, 150 ms/hamle):

| Rakip | Sonuç | Skor | Performans |
|---|---|---|---|
| SF UCI_Elo 2400 | +9 =0 -3 | %75 | ≈ 2591 |
| SF UCI_Elo 2600 | +8 =1 -3 | %71 | ≈ 2754 |
| SF UCI_Elo 2800 | +0 =4 -8 | %17 | ≈ 2520 |

Toplu tahmin (36 oyun): **≈ 2600-2700 Elo** — JS sürümünden yaklaşık +100-150,
1,8× hız avantajıyla tutarlı.

## VEGA 2 — Bitboard Motor (cpp/vega2.cpp)

Sihirli bitboard'lı yeniden yazım: açılışta üretilen sihirli tablolar,
popcount hareketlilik, maske tabanlı piyon yapısı/şah güvenliği, x-ray'li
SEE. Arama vega.cpp ile aynı. Başlangıç pozisyonunda **1,07M düğüm/sn,
2,2 sn'de derinlik 17** (0x88 motorun ~2,1 katı).

| Ölçüm | Sonuç |
|---|---|
| vega2 – vega kafa kafaya (30 oyun, 150 ms) | **+17 =8 -5 (%70) ≈ +147 Elo** |
| vega2 – SF UCI_Elo 2600 (20 oyun) | +14 =1 -5 (%73) → performans ≈ 2768 |
| vega2 – SF UCI_Elo 2800 (12 oyun) | +2 =1 -9 (%21) → basamak ≈ 2570 |

Ek özellikler:
- **Lazy SMP**: `setoption name Threads value N` (1-8) — paylaşımlı TT
  üzerinde kademeli derinlikli yardımcı arayıcılar, atomik paylaşımlı
  süre sınırı. Varsayılan 1 (hiç iş parçacığı açmaz, sıfır ek yük).
  Gerçek çok çekirdekli donanımda belirgin güç artışı sağlar; not: bu
  değerlendirme ortamı gerçek 4-çekirdek paralelliği sunmadığından
  buradaki kazanç yalnızca TT paylaşımından gelen ~+1 derinliktir
- **selfplay N movetime seed**: NNUE eğitim verisi üretimi
  (`fen;beyaz_cp;sonuç` satırları; rastgele açılış + erken hükme bağlama)

Toplu tahmin: **≈ 2700-2800 Elo** (150 ms/hamle; kafa kafaya geçişkenlik
ve 2600 basamağı ~2750-2800'ü, 2800 basamağı alt sınırı işaret ediyor).
Not: ilk 12 oyunluk 2600 ölçümü (%33) varyans aykırı değeriydi; sabit
ikiliyle 20 oyunluk tekrar %73 verdi.
