# WrongPort

Development ortamında hangi süreçlerin hangi TCP portlarını dinlediğini gösteren küçük bir araç: **CLI + web arayüzü**. Yalnızca bilinen dev süreçlerine odaklanır (node, vite, next, python, cargo, go, postgres, redis…), portlarını listeler ve süreçleri güvenli biçimde sonlandırır.

## Kurulum

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
npm test             # vitest: 7 dosya / 70 birim test (ayrıntı: aşağıdaki Testler)
npm run verify       # typecheck + test + build zinciri (tek komut, sırayla)
npm run build        # tsc + vite build
```

## Testler

```bash
npm test            # vitest run — 7 dosya / 70 test (~2 sn)
```

| Dosya | Kapsam |
| --- | --- |
| `src/core/inspector.test.ts` | lsof çıktı ayrıştırma: ` (LISTEN)` sonekli/soneksiz satırlar, IPv4/IPv6 bind'ler, başlık/bozuk/port'suz satırların atlanması, boş çıktı |
| `src/core/config.test.ts` | Config keşfi ve doğrulama: dosya önceliği (`wrongport.config.json` > `.wrongportrc.json` > `~/.config`), bozuk JSON ve tip hataları → `ConfigError`, varsayılan include/exclude birleşimi (WrongPort kendisi her zaman hariç), geçersiz regex reddi |
| `src/core/kill.test.ts` | Kill güvenliği: geçersiz pid reddi (0, 1, negatif, NaN), self-pid guard, olmayan pid → `ProcessNotFoundError`, gerçek çocuk süreçlerle SIGTERM ve SIGKILL akışları |
| `src/server/app.test.ts` | API güvenlik kısıtları (hono `app.request` ile): bozuk gövde → 400, taramada görünmeyen pid → 409, snapshot'ta görünen süreç → 200 + gerçek çıkış + tekrar kill → 409, self-pid → 500; sorgu parametreleri: `ports=` daraltma (`all=1` dâhil her modda sert kısıt) ve bozuk token toleransı, `only=` ile varsayılan filtrede gizli süreçleri ortaya çıkarma, `only`+`ports` önceliği, `matched` bayrağı, geçersiz `only` deseni → 400 + mesaj; istek sertleştirmesi: JSON content-type dışı kill → 415, loopback'e bağlıyken yabancı `Host` → 403; hata eşlemesi: `ScanError` → 503, beklenmeyen → 500; `startServer`: EADDRINUSE → anlaşılır mesaj, port 0 → gerçek port |
| `web/src/filterQuery.test.ts` | Arayüz filtre kutusu → sunucu parametresi eşlemesi: sayı/sayı listesi → `ports`, diğer her metin → `only` (regex), boş girdi → parametresiz |
| `web/src/api.test.ts` | İstemci API katmanı: sorgu parametresi kurulumu, sunucu hata mesajının yüzeylendirilmesi, 409 "stale snapshot" kill kurtarması (tek kez yenile + tekrar; diğer hatalarda tekrar yok) |
| `web/src/portAddress.test.ts` | Wildcard bind (`*`, `0.0.0.0`, `[::]`, `::`) ile loopback/LAN adres ayrımı — port rozeti renklendirmesi buna dayanır |

Notlar:

- Kill ve API testleri **yalnızca testin kendisinin spawn ettiği** geçici çocuk süreçleri kullanır; snapshot üyeliği kısıtı sayesinde makinedeki diğer süreçlere dokunamaz.
- Tarama yapan testler gerçek `lsof`/`ps` çağrıları yapar; bu yüzden macOS veya Linux gerekir.
- `src/core/inspector.ts` içindeki `lsof`/`ps` çağrıları 5 sn timeout ile korumalıdır; asılan bir alt süreç testi değil `ScanError`'ı yüzeye çıkarır.
- Arayüz filtre kutusu sunucu tarafına bağlıdır (250 ms debounce): sayı → `ports=`, diğer metin → `only=`. Eski client-side substring filtresi kaldırıldı — fark şu: client-side yalnızca sunucunun döndürdüğü satırları daraltabilirdi; sunucu filtresi (`only`) varsayılan dev filtresinde gizli süreçleri ortaya çıkarabilir, `ports=` ise `all=1` dâhil her modda sert kısıttır. Geçersiz `only` deseni (ör. `[`) 400 + açıklayıcı mesaj döner ve mesaj arayüzdeki hata bandında görünür.
- `ls --watch` tek seferlik tarama hatasında (timeout, yoğun makine) döngüyü sürdürür; üst üste 5 hata watch modunu sonlandırır ve başarıdan sonra hata kodu temizlenir.
- Arayüzde wildcard bind'li portlar (`*:3000`, `0.0.0.0`, `[::]`) `*:port` biçiminde ve uyarı rengiyle gösterilir — "dev sunucum ağa mı açıktı?" sorusunun cevabı ilk bakışta görünür. Belirli bir arayüze bağlı portlar (ör. `192.168.1.5:3000`, `[::ffff:…]`) da uyarı rengiyle, "ağdan erişilebilir olabilir" notuyla gösterilir; yalnızca loopback rozetleri normal renktedir. PID hücresine tıklamak panoya kopyalar.
- Tablo dolu olduğunda da dev filtresiyle gizlenen ek süreç sayısı tablo altında yazılır ("all processes" işaretiyle açılır).
- Arayüzdeki kill, sunucunun 409 (stale snapshot) cevabında — mesaj metninden bağımsız olarak — snapshot'ı bir kez yenileyip tekrar dener; polling kapalıyken veya onayda gecikince kill yine de çalışır. Sekmeye geri dönüldüğünde bir sonraki poll'u beklemeden tazeleme yapılır.

## HTTP API

| Uç nokta | Açıklama |
| --- | --- |
| `GET /api/health` | Sağlık kontrolü |
| `GET /api/processes?all=1` | Snapshot (JSON); `only`, `ports` sorgu parametreleri opsiyonel; geçersiz `only` deseni → 400 + mesaj; tarama hatası → 503 + `{error}`, beklenmeyen hata → 500 + `{error}` |
| `POST /api/kill` | Body: `{"pid": 1234, "force": false}`; `Content-Type: application/json` zorunludur (değilse 415); loopback'e bağlıyken `Host` başlığı doğrulanır (yabancıysa 403); pid ≤ 1 → 400; son tarama penceresinde olmayan pid → 409 |

Gereksinimler: Node ≥ 22, macOS veya Linux (`lsof`).
