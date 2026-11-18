# 3P Code Mode — Güvenlik Raporu

Bu rapor, 18 Kasım 2026 itibarıyla broker tabanlı insan onayı mimarisinin
tehdit modelini, uygulanabilir (ve testle doğrulanmış) garantileri, kalan
riskleri ve sert sınır için OS izolasyonu gereksinimini belgeler.

## Rollar

| Rol | Güvenilebilirlik | Yetki |
| --- | --- | --- |
| MCP sunucusu (`server-code-mode.mjs`) | Güvenilir altyapı | Çalışan hesabın tüm OS yetkileri |
| Worker (`code-mode-worker.mjs`) | **Güvenilmez** (model kodu çalışır) | Çalışan hesabın tüm OS yetkileri |
| Onay brokeri (`approval-broker.mjs`) | İnsan yüzeyi; sadece 127.0.0.1 | Bekleyen nonce'ları bellekde tutar; kararı insan verir |
| Model / MCP istemcisi | Güvenilmez; yalnızca gözlemleyici | `code_status` ile bekleyen onayı **görebilir**, karar **veremez** |

Worker, modelin ürettiği JavaScript'i `fs`, `child_process`, `fetch` dahil
tam Node.js API'siyle çalıştırır. Worker'ın asla görmediği tek şey brokerin
**belleği**dir: nonce'lar sunucu sürecinin hafızasında yaşamaz, broker
sürecin belleğinde yaşamaz, diske yazılmaz.

## Uygulanabilir (testle doğrulanmış) garantiler

- **MCP yüzeyinden onay verilemez.** Hiçbir MCP aracı bir onay kararını
  taşıyamaz: `code_status` salt okunur (`readOnlyHint: true`); yanıtta `tool`,
  `deadline` ve insanın açacağı `url` var, **nonce asla yok**. Test, nonce'un
  hiçbir `code_status` yanıtında görünmediğini ayrıca doğrular.
- **Her onay dört şeyle ilişkilidir:** `jobId` (iş kimliği), işlemin adı ve
  dosya yolu/komut (`tool`, `file`, `command`, önizleme), mutlak süre sınırı
  (`deadline`, brokerda uygulanan geri sayım + sunucu tarafında süre+5 sn
  güvence sayacı) ve 256-bit tek kullanımlık `nonce` (`crypto.randomBytes(32)`).
- **Tek kullanımlık nonce.** Tüketilen bir nonce'a ikinci karar `409` döner ve
  `duplicate-decision` olarak denetim kaydına yazılır; geç gelen sorgular
  saklanan sonucu tekrar oynatır.
- **Karar yalnızca insan yüzeyinden gelir.** `/decisions` istemci Origin
  başlığının brokerin kendi sunduğu onay sayfasının kökeni
  (`http://127.0.0.1:<port>`) olmasıyla doğrulanır. Token taşıyan arka plan
  `fetch`'i (ör. worker kodu) `403` alır ve `rejected-decision`
  (`origin-mismatch`) olarak denetimize düşer. `/cancel` yalnızca token ister
  çünkü onay **veremez**, sadece iptal edebilir (en kötü sonuç: kendi işini
  kendi engellemek).
- **Süre sınırı brokerda zorlanır.** İnsan karar vermezse broker `timeout`
  sonucu üretir; sunucudaki ek sayacı beklemenin asla sınırsız sürmesine
  izin vermez. Süre dolunca sonraki onay isteyen çağrılar da reddedilir.
- **Denetim zinciri.** `approvals.jsonl` her satırı önceki satırın SHA-256'sı
  ile bağlar. `request`, `decision`, `timeout`, `cancelled`, `lost`,
  `duplicate-decision`, `rejected-decision`, `start`, `shutdown` olayları
  kaydedilir; bir satırın değiştirilmesi zinciri bozar (`readAudit`).
- **Yeniden başlatma güvenli.** Bekleyen nonce'lar yalnızca bellektedir:
  broker durunca bekleyenler `lost` olarak denetimize yazılır, `broker.json`
  silinir; çalışan iş karar kaybı ile hatayla biter (sakin bir mesajla).
  Sağlıklı ama yavaş bir broker asla gasp edilmez (`pidAlive` koruması).
- **Broker yalnızca döngüsel arayüzde dinler.** Port 127.0.0.1'e sabitlenmiş;
  ağdan erişilemez. Her örneğin rastgele 128-bit token'ı vardır.

## Doğrudan Node.js/shell kullanımı: helper izinleri bir sandbox değildir

**En önemli sınırlama buradadır.** Worker, modelin kodunu çalışan hesabın
tüm yetkileriyle çalıştırır. Politika kuralları, onaylar ve hook'lar yalnızca
`read`, `write`, `edit`, `run`, `$` ve `callMcp` yardımcı çağrılarını denetler.
Model kodu `await import('node:fs')`, `child_process.exec` veya başka bir
programla aynı işi helper'lardan bağımsız yapabilir; bu yoldan hiçbir kural,
hook ya da onay uygulanmaz.

Sonuç: helper onayı, yetkisiz eylemi **imkansız kılan** bir mekanizma değil,
(a) insan denetim noktası ve (b) modelin normal akışını gözlemlenebilir
yapan bir katmandır. Bir worker süreci ayrıca `broker.log`, `broker.json` ve
işlem çıktılarını okuyabilir; bunlar gizli kalmasa da tek başına onay
vermeye yetmez (yukarıdaki garantiler).

## Kalan risk (aynı OS kullanıcısı)

Aynı Windows hesabında çalışan saldırgan bir model:

- token'ı (iletilen URL'de) ve nonce'ları (`/pending`) okuyabilir;
- Origin başlığını elle doldurarak `/decisions` çağrısı **deneleyebilir**.

Bu, sessiz arka plandan onay verememe garantisini (Origin denetimi + denetim
kayıdı + insanın arayüzü görmesi) kırar; ancak bu, aynı makinede aynı
hesabın sahibi her şeye zaten erişebildiği için **OS düzeyinde çözülemez**.
Herhangi bir dosya, port veya bellek mekanizması, aynı kullanıcının sürecine
karşı mutlak gizlilik sağlamaz.

## Sert sınır: OS izolasyonu (Docker backend'i uygulandı)

Gerçek bir güvenlik sınırı yalnızca **işletim sistemi düzeyinde** kurulur.
Bu depoda `CODE_MODE_ISOLATION=docker` değeriyle uygulandı ve
`test-code-mode-isolation.mjs` ile doğrulandı.

### Docker backend'i

Her iş tek kullanımlık bir konteynerde koşar: imaj `3p-code-engine-worker`
(`worker-image/Dockerfile`, taban `node:24-slim`; ilk iş bir kez derler,
imaj `npm ci` ile kurulur). Motor **Linux konteynerleri** çalıştırmalıdır
(Docker Desktop WSL2 backend'i); saf Windows container engine'inde imaj
derlenemez ve izolasyon etkin sayılmaz. Sunucu `docker run --rm` ile konuk başlatır; worker protokolü fork
IPC yerine stdio üzerinden satır bazlı JSON taşır (`code-mode-channel.mjs`).
Kurulum: `.\install-code-mode.ps1 -Isolation docker` (motoru doğrular,
imajı önden derler, `CODE_MODE_ISOLATION=docker`'i Desktop ortamına yazar).

Konteyner **kapatır** (testte doğrulanmış):

- **Host dosyaları görünmez.** Tek host yüzeyi işin projesidir: `cwd`
  salt bağ olarak `/work`'a takılır. Proje dışındaki her dosya — veri
  dizini (`%LOCALAPPDATA%\3p-code-engine`), `broker.log`, `broker.json`,
  Desktop yapılandırması — `ENOENT` ile erişilemez (test: projenin
  komşusundaki `secret.txt` okunamaz).
- **Host döngüsel arayüzüne erişim yoktur.** Broker yalnızca host'un
  127.0.0.1'inde dinler. Konteynerin kendi loopback'inde dinleyen hiçbir
  şey yoktur (test: worker'dan `fetch('http://127.0.0.1:<broker-port>')`
  bağlantı hatası alır); 127.0.0.1'e bağlı dinleyici host'un diğer
  arayüzlerinden de teslim edilmediği için konuk IP'sinden ulaşılamaz.
  İletilen onay URL'i model tarafından bilinse bile konuktan
  kullanılamaz.
- **Broker yüzeyi koruk altında kalır.** Token, tek kullanımlık nonce'lar,
  `approvals.jsonl` zinciri ve bekleyen onaylar host tarafında yaşar;
  onay yine yalnızca insanın tarayıcı sayfasından (Origin denetimi) gelir
  (test: izolasyondaki onay, `fromUi: true` ve `channel: 'ui'` denetim
  kaydıyla çözülür).

Konteyner **kapatmaz** (bilinçli kalan riskler):

- Proje dizini, modelin normal çalışma alanı olduğu için tümüyle erişilebilir.
- Konteynerin dış ağı varsayılan olarak açıktır: worker `fetch` ile
  internete erişebilir (host iç ağı hariç). Dış ağı kapatmak için
  `--network none` gerekir; bu, onay akışını etkilemez (broker host'tadır).
- `callMcp`/`listMcpServers` konukta Desktop yapılandırmasını görmez
  (yapılandırma host'tadır): bu modda "not configured" hatası döner.
- Hook'lar host yolu okuyamaz: politika host'ta `CODE_MODE_POLICY_PATH`
  üzerinden okunup işle birlikte konuğa verilir; hook scriptleri proje
  dizininde (yani `/work` altında) yaşar, mutlak yollar konuk köküne göre
  çözülür.
- Imaj tedarik zinciri: taban imaj `node:24-slim`, kod bu depodan kopyalanır.

Davranış farkları: konuk kabuk Linux'tur (`run` PowerShell yerine
`/bin/sh` kullanır, `uname -s` → `Linux`), kod içindeki mutlak host
yolları konuk köküne göre çözülür.

Yalıtım yalnızca flag ile değil, gerçek motorla kanıtlanır: sunucu
bağlantı başlatıldığında `docker version` sorar ve yanıtı `isolation.json`
dosyasına yazar (`isolationMode`, `dockerAvailable`, `workerIsolated`).
Motor yanıt vermezse `workerIsolated` `false` kalır ve izolasyon testi
SKIP yazıp durur — çalıştırılamayan sınır "geçti" sayılmaz.

### Alternatif yollar

1. **Farklı Windows kullanıcısı:** broker ve MCP sunucusu ayrı (düşük
   yetkili) bir hesapta çalışsın; model/worker ana hesapta. Farklı kullanıcının
   dosyalarını (ACL) ve belleğini okuyamaz; token ve denetim zinciri ona
   karşı korunur.
2. **Sanal makine:** worker'ı bir VM içinde çalıştırın; broker konuk
   dışarısında kalır.
3. **Yalıtım algılanır ve kaydedilir:** sunucu her istemci başlatıldığında
   `isolation.json` yazar (`container`, `wsl`, `isolationMode`,
   `dockerAvailable`, `workerIsolated` alanları); `verify-results.mjs` ve
   rapor bu durumu gösterir.

`workerIsolated: false` iken bu sistem, "insan onayı + gözlemlenebilirlik"
sunar; "güvenli kabuk" sunmaz.

## Denetim

- `test-approval.mjs`: onay, ret, süre aşımı, istemci kesilmesi (iptal),
  nonce tek kullanımı, Origin denetimi, denetim zinciri bütünlüğü,
  yeniden başlatma ve transcript çıkış yolları.
- `test-code-mode.mjs`: gerçek MCP stdio istemcisi (elicitation yeteneği
  **olmadan**), broker API'si üzerinden insan simülasyonu, `code_status`'un
  onayı tüketememesi, nonce sızıntısı yokluğu ve capability logu.
- `live-verification/verify-results.mjs`: canlı işlemden sonra yalnızca
  dosya varlığına değil, brokerin **gerçek onay denetim kaydına** bakar:
  `jobId`/`tool`/dosya eşleşmesi, kararın işin kendi ömrü içinde verilmesi,
  `channel === 'ui'`, brokerca doğrulanmış `fromUi === true` ve nonce'un
  tam bir kez tüketilmesi.
