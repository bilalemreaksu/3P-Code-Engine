# 3P Code Mode v0.12 — yetki sınırları

## JavaScript motoru

Üretilen JavaScript, `code-mode-runtime.mjs` içindeki QuickJS WebAssembly
motorunda çalışır. Host nesneleri guest'e verilmez; yalnızca JSON argümanlar
ve sonuçlar sınırı geçer. Guest'te `process`, `require`, `Buffer`, `fetch`
veya Node modül yükleyicisi yoktur. Function/constructor erişimi QuickJS'te
kalır. Host fonksiyon prototipleri paylaşılmaz. Bu, v0.11'deki doğrudan
`import('node:fs')` yolunu kaldırır.

Dosya, kabuk ve MCP işlemleri denetlenen yardımcılarla yapılır. REPL hook'u ve
auto classifier kod başlamadan önce çalışır. Her yardımcı ayrıca deny/ask,
izin modu ve PreToolUse denetiminden geçer. QuickJS belleği 64 MiB, stack'i
1 MiB ile sınırlıdır; interrupt handler CPU döngülerine süre sınırı uygular.
Üst süreç toplam süreyi ve iptali denetler. Son ifade Acorn ile ayrıştırılır;
host'ta eval edilmez. QuickJS/WASM veya Node'da bilinmeyen bir açık
bulunmadığına dair mutlak güvenlik iddiası değildir.

## Kabuk ve dış MCP yetkileri

`run`/`$` bir Bash araç çağrısı olarak denetlenir. İzin verilen programın
içindeki her dosya/ağ işlemi ayrı Read/Write çağrısına çevrilmez. Örneğin
Write reddi, ayrıca izin verilen bir kabuk programının yazmasını engellemez.
Komut metni kuralları hesaplanmış/eval edilmiş her davranışı çözümlemez.

Docker kapalıysa izin verilen kabuk host hesabının yetkileriyle çalışır:
proje dışına, engine/veri dosyalarına veya yerel brokere erişebilir.
Brokerin Origin kontrolü browser kaynak kontrolüdür; OS yetkisi olan bir
program Origin taklit edebilir. MCP araçlarının karar taşıyamaması, ayrıca
izin verilmiş host kabuğunun mutlak olarak onay taklit edemeyeceği anlamına
gelmez. Helper politikası OS sandbox'ı değildir.

`review_changes`, `review_and_fix`, `reviewAfter` ayrı kabuk/model akışlarıdır;
yalnızca rules/bypassPermissions modlarında kullanılabilir. Terminal agent
bunları modele sunmaz.

## Docker sınırı

CODE_MODE_ISOLATION=docker her işi --rm --init ile tek kullanımlık Linux
konteynerinde çalıştırır. Proje /work altında yazılabilir mount'tur; diğer
host dosyaları bağlanmaz. Host'un 127.0.0.1'de dinleyen brokeri guest
loopback üzerinden erişilemez. İmaj bütün build girdilerinin SHA-256 hash'iyle
seçilir; motor/build hatasında host yürütmesine düşülmez.

Politika, classifier ve hook denetimi host'ta kalır. Yapılandırılmış MCP
sunucuları denetlenen stdio RPC köprüsünden çağrılır; ham istekler de bağımsız
izin denetiminden geçer. İstek sayısı 64, argüman 256 KiB, yanıt 1 MiB ile
sınırlıdır. İptal hook/MCP isteklerine iletilir ve konteyner kaldırılır.

Docker'ın kaldırmadığı yetkiler:

- Proje mount'u okunabilir/yazılabilirdir. Sırlar veya güvenilen engine/scriptler
  mount içindeyse erişilebilir olabilir. Çalışma alanını engine/veri/anahtar
  dizinlerinden ayrı tutmak gerekir.
- Konteynerin dış ağı açıktır; tam bir ağ egress filtresi uygulanmaz.
- Dış MCP sunucuları ve hook'lar host yetkileriyle çalışır. Docker bunların
  kendi dosya/ağ etkilerini yalıtmaz.
- Kendini ayırmış alt süreçlerin her ortamda sonlanması garanti edilmez.

## Onay brokeri

Broker yalnızca host 127.0.0.1'de rastgele portta dinler. Bekleyen karar,
iş kimliği, araç, dosya/komut, süre sınırı ve 256-bit tek kullanımlık nonce ile
ilişkilidir. Token örnek başına rastgeledir. Nonce MCP yanıtlarında görünmez;
hiçbir MCP aracı karar taşımaz. İnsan broker sayfasında yanıtlar. Tekrarlanan
karar 409 alır; süre dolarsa ret uygulanır. Broker kaybında onay geçerli
sayılmaz. Auto onayı geçersizleşen işin geri sayımı dolarsa yeni kod başlayana
kadar sonraki onay gereken çağrılar reddedilir.

approvals.jsonl SHA-256 zinciri request/decision/timeout/cancelled/lost ve
rejected/duplicate olaylarını kaydeder. Zincir, yetkili host programının
bütün dosyayı yeniden yazmasına karşı harici bir güven kökü değildir.

## Çıktı ve kayıtlar

Arka plan UserPromptSubmit hook'u varsa olay, sonuç, günlük ve yeni state
hook geçene kadar tutulur. Ret halinde bunlar paylaşılmaz; engelleme nedeni
döner. Yapılmış dosya değişiklikleri geri alınmaz. Ön plan poll_event değildir.

İş, state, terminal konuşması ve onay kayıtları düz JSON/JSONL dosyalarıdır;
hassas içerik barındırabilir, şifrelenmez veya otomatik silinmez. Model uç
noktasına konuşma/araç sonuçları, classifier'a kod gönderilir. API anahtarları
terminal konuşma kaydına eklenmez.

## Doğrulama

npm test; QuickJS escape denemelerini, CPU sınırını, paralelliği, MCP akışını,
hook'ları, auto onayını/geçersizleşmesini, brokeri, terminal model döngüsünü,
Ctrl+O stream/key olaylarını, installer ve imaj hash'ini doğrular. Docker varsa
gerçek konteyner sınırı da çalışır. test:isolation:required motor/build yokluğunu
hata sayar; CI Linux işi bunu kullanır. test:auto:live gerçek modeli ayrıca
doğrular; iki örneğin geçmesi classifier'ın genel doğruluğunu kanıtlamaz.

Önceki Desktop canlı raporu v0.11 dönemindendir. Yeni runtime/terminal testleri
Desktop'ın yeni sürümdeki UI doğrulamasının yerine geçmez.
