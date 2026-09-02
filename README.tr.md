# WrongPort

[English](README.md) | Türkçe

Development ortamında hangi süreçlerin hangi TCP portlarını dinlediğini gösteren küçük bir araç: **CLI + web arayüzü**. Yalnızca bilinen dev süreçlerine odaklanır (node, vite, next, python, cargo, go, postgres, redis…), portlarını listeler ve süreçleri güvenli biçimde sonlandırır.

## Kurulum

npm'den global kurulum:

```bash
npm install -g wrongport
```

Ya da kaynaktan derleyin:

```bash
npm install
npm run build        # dist/ (core + cli + api) ve web-dist/ (web UI)
npm link             # isteğe bağlı: global `wrongport` komutu
```

## Kullanım

| Komut | Ne yapar |
| --- | --- |
| `wrongport` / `wrongport ls` | Dinlenen portları ve sahiplerini tablo olarak listeler |
| `wrongport ls --all` | Dev filtresini atlat, tüm dinleyen süreçleri gösterir |
| `wrongport ls --watch` | Canlı tablo, 3 sn'de bir yeniler (`--watch 1` = 1 sn) |
| `wrongport ls --json` | Ham JSON snapshot |
| `wrongport kill 3000` | 3000 portunu dinleyen süreci SIGTERM ile kapatır (onay ister) |
| `wrongport kill 1234 -f -y` | PID 1234'e SIGKILL gönderir, onay istemez |
| `wrongport serve` | Web UI + API başlatır → http://127.0.0.1:3789 |
| `wrongport serve --open` | Aynı + tarayıcıyı açar |
| `wrongport serve -p 0` | Boş bir port seçer; yazdırılan adreste gerçek port görünür |

## Güvenlik modeli

- Kill yalnızca **güncel bir taramada görülmüş** PID'ler üzerinde çalışır; API'de bu tarama 30 sn geçerlidir. Bu uç nokta genel amaçlı bir "uzaktan kill" servisi değildir.
- Sunucu varsayılan olarak yalnız `127.0.0.1`'e bağlanır. Ağdaki diğer makinelere açmak için `--host` kullanın — dikkatli olun, kill yetkisi veren bir arayüzdür.
- Loopback'e bağlıyken `/api/kill` yalnızca `Content-Type: application/json` ile çalışır (siteler arası form istekleri 415 alır) ve `Host` başlığı döngüsel adres değilse 403 döner — DNS rebinding ile erişen bir sayfa tarama okuyamaz ya da kill yetkilendiremez.
- WrongPort kendisini, pid 1'i ve geçersiz PID'leri öldürmeyi reddeder.
- Varsayılan sinyal SIGTERM'dir; `-9/--force` gerçek SIGKILL'dir.
- Tarama hataları (lsof yok, timeout) API'de 503 + açıklamalı `{error}` JSON'u olarak döner; beklenmeyen hatalar 500 + `{error}`.

## Yapılandırma

Proje kökünde `wrongport.config.json` (veya `.wrongportrc.json`), yoksa `~/.config/wrongport/config.json`:

```json
{
  "include": ["\\bnode\\b", "\\bvite\\b"],
  "exclude": ["\\bwebpack\\b"],
  "ports": [3000, 5173]
}
```

- `include`: `"<isim> <komut>"` üzerinde case-insensitive regex; **varsayılan listenin yerine geçer**.
- `exclude`: eşleşen süreçleri filtrelenmiş sonuçtan çıkarır (WrongPort kendisi her zaman hariçtir).
- `ports`: sonucu belirtilen portlarla sınırlar. 1–65535 dışındaki değerler `ConfigError` ile reddedilir; CLI `--ports` da aynı doğrulamayı yapar (bozuk bir `--ports` listesi filtreyi sessizce devre dışı bırakamaz).
- CLI'da `--only` ek desen, `--ports` ek port kısıtı, `--all` filtreyi tamamen atlatır.

## Geliştirme

```bash
npm run dev:api      # API'yi tsx watch ile çalıştırır (3789)
npm run dev:web      # Vite dev sunucusu (5174, /api → 3789 proxy)
npm run typecheck    # hem node hem web tarafı için tsc
npm test             # vitest: 17 dosya / 202 birim test (ayrıntı: aşağıdaki Testler)
npm run test:coverage  # aynı süit + v8 coverage raporu (%100 gate)
npm run verify       # typecheck + coverage'lı test + build zinciri (tek komut, sırayla)
npm run release      # release hattı — aşağıdaki Release bölümüne bakın
npm run build        # tsc + vite build
```

## Release

```bash
npm run release            # verify → sürüm artırımı (patch) → commit + tag v*
npm run release -- minor   # major | minor | patch
npm run release -- --push  # branch ve tag'i de pushlar
npm run release:dry        # yalnızca plan: yazma, commit, tag yok
```

Tag'i pushlamak (`npm run release -- --push`) GitHub Actions `Release` workflow'unu tetikler; workflow temiz bir `npm ci` ile kurar, `npm run verify`'i yeniden çalıştırır ve paketi deponun `NPM_TOKEN` secret'ıyla npm'e yayınlar. Yayınlanan paket yalnızca `dist/` ve `web-dist/`'i içerir (`files` allowlist).

## Testler

```bash
npm test               # vitest run — 17 dosya / 202 test (~2,5 sn)
npm run test:coverage  # aynı süit + v8 coverage raporu
```

Coverage `vitest.config.ts` içinde **%100 statement / branch / function / line** olarak zorlanır; %100'ün altına düşmek süiti başarısız kılar, yani yalnızca yukarı doğru değişebilir. Yalnızca arayüz barındıran `types.ts` dosyaları ve CSS çalışma zamanı statement'ı içermediğinden raporun dışındadır.

| Dosya | Kapsam |
| --- | --- |
| `src/core/inspector.test.ts` | lsof çıktı ayrıştırma: ` (LISTEN)` sonekli/soneksiz satırlar, IPv4/IPv6 bind'ler, başlık/bozuk/port'suz/aralık dışı satırların atlanması, boş çıktı; `joinListenRows`: ps tercihı, yarış durumu yedeği, port birleştirme/tekilleştirme; **stub'lu `execFile`** ile `scanProcesses` seçim semantiği (gerçek lsof/ps yok): varsayılan dev filtresi, eklemeli `only=`, `all=1` dâhil sert `ports=` kısıtı, config-port yedeği, exclude desenleri, `matched` bayrakları, sıralama + pid eşitliği kırılımı ve tüm `ScanError` eşlemeleri (eksik lsof/ps, exit 1 = boş sonuç, genel ve Error-olmayan hatalar); **Windows yolu**: `netstat` + `Get-CimInstance` CSV ayrıştırma (CRLF güvenli, tırnaklı/tıraksız alanlar, bozuk pid'ler), win32'de `only=`/`ports=` seçimi, netstat/powershell ENOENT + hata eşlemeleri |
| `src/core/config.test.ts` | Config keşfi ve doğrulama: dosya önceliği (`wrongport.config.json` > `.wrongportrc.json` > `~/.config`), bozuk JSON ve tip hataları → `ConfigError`, kökü obje olmayan config reddi, varsayılan include/exclude birleşimi (WrongPort kendisi her zaman hariç), geçersiz regex reddi |
| `src/core/kill.test.ts` | Kill güvenliği: geçersiz pid reddi (0, 1, negatif, NaN), self-pid guard, olmayan pid → `ProcessNotFoundError`, gerçek çocuk süreçlerle SIGTERM ve SIGKILL akışları, EPERM/ESRCH sonda eşlemesi, sarmalanan sinyal hataları, bekleme aşımı → `exited: false` |
| `src/server/app.test.ts` | API güvenlik kısıtları (hono `app.request` + **enjekte edilebilir scan double**) — kill yolları gerçektir (spawn edilen süreçler + gerçek sinyaller): bozuk gövde → 400, taramada görünmeyen pid → 409, snapshot'taki süreç → 200 + gerçek çıkış + tekrar → 409, self-pid → 500, snapshot sonrası ölen pid → 404; sorgu parametreleri (`all=1` dâhil sert `ports=` kısıtı, eklemeli `only=`, boş/bozuk tokenlar, boş `ports=` → port 0 tuhaflığı); geçersiz `only` deseni → 400 + mesaj; sertleştirme: content-type yoksa/JSON değilse → 415, yabancı `Host` → 403; hata eşlemesi: `ScanError` → 503, beklenmeyen → 500; statik UI sunumu: SPA fallback, sondaki bölü çizgili dizinler, değişmez `/assets/`, mime tablosu, directory traversal → 403, NUL/bozuk yüzde kaçışı → 400, kabuk yoksa → 404; `startServer`: EADDRINUSE, port 0, `WRONGPORT_PORT`/`WRONGPORT_HOST` env önceliği, `0.0.0.0`/`::` → localhost gösterimi |
| `src/server/app.server.test.ts` | Mock'lu `serve` ile `startServer` bind yönetimi: EACCES → yetki ipucu, genel bind hataları, `address()` yedeği, wildcard gösterimi, listen sonrası dağınık soket hatalarının yutulması |
| `src/cli/index.test.ts` | Mock'lu I/O ile commander üzerinden tüm CLI: çıplak komut = `ls`, `--json`, `--only/--ports/--all` iletimi, `--ports` doğrulama hataları, watch modu (tek seferlik hatalara dayanma, üst üste 5 hatada durma, çıkış kodu kurtarma, çıplak/sayısal olmayan değerlerde 3 sn kadans), `kill` (pid/port/`-a` hedefleme, y/yes/red onayları, `ProcessNotFoundError` vs genel vs Error-olmayan hatalar), `serve` (eksik web build uyarısı, port/host seçenekleri, platforma göre `--open` spawn'ı + hata toleransı), ana-modül guard'ı (symlink'li bin realpath'i dâhil), CLI sürümü ↔ package.json eşzamanlılığı |
| `src/cli/table.test.ts` | Tablo çizici: başlık/satırlar/altbilgi, dar stdout boyutlandırma, isim/komut kısaltma, filtreyle gizlenen ve boş makine durumları, ANSI yardımcıları |
| `web/src/filterQuery.test.ts` | Arayüz filtre kutusu → sunucu parametresi eşlemesi: sayı/sayı listesi → `ports`, diğer her metin → `only` (regex), boş girdi → parametresiz |
| `web/src/api.test.ts` | İstemci API katmanı: sorgu parametresi kurulumu, sunucu hata mesajının yüzeylendirilmesi, gövdede `error` yokken çıplak durum kodu yedeği, 409 "stale snapshot" kill kurtarması (tek kez yenile + tekrar; diğer hatalarda tekrar yok) |
| `web/src/portAddress.test.ts` | Wildcard bind (`*`, `0.0.0.0`, `[::]`, `::`) ile loopback/LAN adres ayrımı, port'suz adresler dâhil — port rozeti renklendirmesi buna dayanır |
| `web/src/useProcesses.test.tsx` | Veri kancası: 250 ms debounce, görünür sekmede aralık polling'i, gizli sekmede tick atlama + yok sayılan visibilitychange, görünürlüğe dönüşte tazeleme, filtre değişiminde yeniden çekme, hata yüzeylendirme vs `AbortError` yutma, refresh'in uçuştaki isteği iptal etmesi, unmount iptali |
| `web/src/App.test.tsx` | App kabuğu: sayılar/platform, tablo + mobil kart düzenleri, unfiltered etiketi, boş durumlar (yükleniyor / boş / filtreli / gizli ipucu), filtre debounce → `only=`/`ports=`, all anahtarı, kadans seçici, yenile düğmesi durumu, öneri çipleri, sunucu + aksiyon hata bantları ve kapatma, her iki düzende iki adımlı kill (`kill` ve `-9`) + kill sonrası tazeleme |
| `web/src/main.test.tsx` | Bootstrap uygulaması `#root`'a monte eder; `#root` yoksa hata fırlatır |
| `web/src/components/PortBadges.test.tsx` | Rozet tonlaması (jsdom + Testing Library): wildcard → `*:port` + uyarı tonu, loopback → normal ton, belirli arayüz → uyarı tonu ve "loopback only" olmayan başlık |
| `web/src/components/PidCell.test.tsx` | PID hücresi: tıklayınca panoya kopyalar ve "copied ✓" gösterir; flaş 1,2 sn sonra temizlenir; pano yoksa veya reddederse sessizce bozulur |
| `web/src/components/HiddenProcessesHint.test.tsx` | Gizli süreç ipucu: 0/negatif sayıda hiçbir şey çizmez, pozitif sayıda sayıyı ve yönlendirmeyi yazar |
| `web/src/components/KillButton.test.tsx` | İki adımlı güvenlik düğmesi: ilk tık silahlanır (onay etiketi + tehlike tonu), ikinci tık `onConfirm`'i tam bir kez tetikler; blur ve 2,5 sn zaman aşımı silahlanmayı kaldırır, son teslimden hemen önceki onay yine de çalışır |

Notlar:

- Kill ve API testleri **yalnızca testin kendisinin spawn ettiği** geçici çocuk süreçleri kullanır; snapshot üyeliği kısıtı sayesinde makinedeki diğer süreçlere dokunamaz.
- Taramalar `execFile`/`scanProcesses` sınırında sahteleştirilir; bu yüzden süit platformdan bağımsızdır (macOS, Linux, Windows). `lsof` yalnızca WrongPort'un kendisini **çalıştırmak** için gerekir, testleri için değil.
- `useProcesses` kimlik koruması yalnızca `refreshing` bayrağını korur — geç gelen cevap snapshot'ı yine üzerine yazar (testle sabitlenmiştir).
- Değersiz `ports=` (boş değer) sahiplenilmesi imkânsız port `0` olarak ayrıştırılır — belgelenmiş tuhaflık olarak testle sabitlenmiştir.
- Arayüz filtre kutusu sunucu tarafına bağlıdır (250 ms debounce): sayı → `ports=`, diğer metin → `only=`. Eski client-side substring filtresi kaldırıldı — fark şu: client-side yalnızca sunucunun döndürdüğü satırları daraltabilirdi; sunucu filtresi (`only`) varsayılan dev filtresinde gizli süreçleri ortaya çıkarabilir, `ports=` ise `all=1` dâhil her modda sert kısıttır. Geçersiz `only` deseni (ör. `[`) 400 + açıklayıcı mesaj döner ve mesaj arayüzdeki hata bandında görünür.
- `ls --watch` tek seferlik tarama hatasında (timeout, yoğun makine) döngüyü sürdürür; üst üste 5 hata watch modunu sonlandırır ve başarıdan sonra hata kodu temizlenir.
- Arayüz bileşen testleri jsdom + Testing Library ile, dosya başına `// @vitest-environment jsdom` bildirimiyle çalışır — genel ortam 'node' kaldığı için sunucu testleri yavaşlamaz. `@testing-library/react` ve `jsdom` devDependency'dir.
- Arayüzde wildcard bind'li portlar (`*:3000`, `0.0.0.0`, `[::]`) `*:port` biçiminde ve uyarı rengiyle gösterilir — "dev sunucum ağa mı açıktı?" sorusunun cevabı ilk bakışta görünür. Belirli bir arayüze bağlı portlar (ör. `192.168.1.5:3000`, `[::ffff:…]`) da uyarı rengiyle, "ağdan erişilebilir olabilir" notuyla gösterilir; yalnızca loopback rozetleri normal renktedir. PID hücresine tıklamak panoya kopyalar.
- Tablo dolu olduğunda da dev filtresiyle gizlenen ek süreç sayısı tablo altında yazılır ("all processes" işaretiyle açılır).
- Arayüzdeki kill, sunucunun 409 (stale snapshot) cevabında — mesaj metninden bağımsız olarak — snapshot'ı bir kez yenileyip tekrar dener; polling kapalıyken veya onayda gecikince kill yine de çalışır. Sekmeye geri dönüldüğünde bir sonraki poll'u beklemeden tazeleme yapılır.

## HTTP API

| Uç nokta | Açıklama |
| --- | --- |
| `GET /api/health` | Sağlık kontrolü |
| `GET /api/processes?all=1` | Snapshot (JSON); `only`, `ports` sorgu parametreleri opsiyonel; geçersiz `only` deseni → 400 + mesaj; tarama hatası → 503 + `{error}`, beklenmeyen hata → 500 + `{error}` |
| `POST /api/kill` | Body: `{"pid": 1234, "force": false}`; `Content-Type: application/json` zorunludur (değilse 415); loopback'e bağlıyken `Host` başlığı doğrulanır (yabancıysa 403); pid ≤ 1 → 400; son tarama penceresinde olmayan pid → 409 |

Gereksinimler: Node ≥ 22. macOS/Linux `lsof` ister; Windows yerleşik `netstat` + PowerShell (`Get-CimInstance`) kullanır — kullanıcı sütunu Windows'ta boş kalır.
