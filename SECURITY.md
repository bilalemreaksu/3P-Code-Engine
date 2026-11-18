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

## Sert sınır: OS izolasyonu

Gerçek bir güvenlik sınırı yalnızca **işletim sistemi düzeyinde** kurulur:

1. **Farklı Windows kullanıcısı:** broker ve MCP sunucusu ayrı (düşük
   yetkili) bir hesapta çalışsın; model/worker ana hesapta. Farklı kullanıcının
   dosyalarını (ACL) ve belleğini okuyamaz; token ve denetim zinciri ona
   karşı korunur.
2. **Konteyner / sanal makine:** worker'ı Docker, Windows Sandbox veya WSL2
   içinde çalıştırın. Broker konuk dışarısında kalır.
3. **Yalıtım algılanır ve kaydedilir:** sunucu her istemci başlatıldığında
   `isolation.json` yazar (`container`, `wsl`, `workerIsolated` alanları);
   `verify-results.mjs` ve rapor bu durumu gösterir.

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
