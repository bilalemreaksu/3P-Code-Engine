# Code Mode terminali

Desktop 3P MCP desteği korunur. Bu terminal, modelin araç listesini kendisi
yönetir: modele yalnızca `REPL`, `code_status` ve `code_cancel` verilir.
Dosya, kabuk ve MCP işlemleri `REPL` içindeki JavaScript yardımcılarından
geçer. İstemcinin başka yerleşik araçları bu oturumda bulunmaz.

Node.js 24+ ile:

```powershell
npm ci
npm run code -- --endpoint http://127.0.0.1:9931/v1 --model model-adi
```

Varsayılan izin modu `autoApprove` olur: classifier isteği, insan onay
penceresi, onay kuyruğu ve broker başlangıcı yoktur. Aynı anda başlayan
işler birbirinin onayını geçersizleştirmez. Açık `deny`, engelleyen hook'lar
ve çıktı denetimi uygulanır. `ask` otomatik geçilir. Eski `auto` modu ayrıca
seçilirse sınıflandırıcıyla çalışır ve bazı durumlarda insan onayı ister.

## Model ve sağlayıcı seçimi

Model adı için izin listesi yoktur. Üç API ailesi desteklenir:

| `--provider` | `--endpoint` | Araç protokolü |
| --- | --- | --- |
| `openai` (varsayılan) | OpenAI uyumlu API tabanı, ör. `http://localhost:9931/v1` | Önce native function calling; açık desteklenmiyor hatasında bir kez metne geçiş |
| `anthropic` | `https://api.anthropic.com/v1` | JSON metin protokolü, Messages API |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta` | JSON metin protokolü, generateContent API |

```powershell
npm run code -- --provider anthropic --endpoint https://api.anthropic.com/v1 --model MODEL_KIMLIGI
npm run code -- --provider gemini --endpoint https://generativelanguage.googleapis.com/v1beta --model MODEL_KIMLIGI
npm run code -- --endpoint http://localhost:9931/v1 --model YEREL_MODEL --tool-protocol text
```

API anahtarını `CODE_MODE_MODEL_API_KEY` ile verin. `--tool-protocol text`,
function calling desteklemeyen veya tools alanını sessizce yok sayan
modeller içindir. `native` yalnızca OpenAI uyumlu API'de kullanılabilir.
Varsayılan `auto`, bağlantı/yetki/kota hatalarını başka protokolle tekrarlamaz.
Sağlayıcı ve seçilen protokol oturumla saklanır; API anahtarı saklanmaz.

Metin protokolünde model açık JSON çağrısı üretir; normal açıklamalar veya
Markdown kod örnekleri çalıştırılmaz. Eksik JSON veya kesilmiş model cevabı
çalıştırılmaz. Modelin doğru JSON/JavaScript üretme becerisi gerekir;
sağlayıcı desteği her modelin aynı kalitede iş yapacağı garantisi değildir.

Oturum kendi izin modunu taşır: başlangıç modu oturum açılırken yazılır, güncel
mod çalışma anında değişebilir. `Shift+Tab` modu sırayla değiştirir, `/mode`
güncel modu gösterir, `/mode <mod>` modu açıkça kurar; arka plan uygunluğu
(`autoApprove`, `rules`, `auto`, `bypassPermissions`) modla birlikte yeniden hesaplanır ve
başlıkta görünür. Modu yalnızca terminaldeki insan değiştirebilir; modelin
bu konuda aracı yoktur.

Desktop kurulumundaki model, classifier ve MCP ayarlarını kullanmak için:

```powershell
npm run code -- --config "$env:LOCALAPPDATA\Claude-3p\claude_desktop_config.json" --cwd C:\Projects\app
```

`--config` açıkça verilen dosyadaki `3p-code-mode.env` ayarlarını yükler;
komut satırı ve önceden tanımlanmış ortam değişkenleri önceliklidir.
Yapılandırmada izin modu varsa korunur; config olmadan terminal `autoApprove`
seçer. Sağlayıcı için `CODE_MODE_MODEL_PROVIDER`, protokol için
`CODE_MODE_TOOL_PROTOCOL` da kullanılabilir. API anahtarı için `CODE_MODE_MODEL_API_KEY`, ayrı
classifier için `CODE_MODE_CLASSIFIER_API_KEY` ortam değişkeni kullanılabilir.

İsteğe bağlı ayarlar:

```powershell
npm run code -- --endpoint http://127.0.0.1:9931/v1 --model model-adi --permission-mode autoApprove --isolation docker
```

`--classifier-endpoint`, `--classifier-model`, `--cwd`, `--resume` ve
`--permission-mode autoApprove|default|acceptEdits|plan|auto|bypassPermissions|rules`
desteklenir. Docker ayrıca kabuk süreçlerini proje mount'u olan Linux
konteynerine taşır. Docker olmadan izin verilen kabuk komutları host
hesabının yetkileriyle çalışır; JavaScript motoru yine QuickJS'tir.

## Etkinleştirme (bağımsız, güvenilen ayar)

Code Mode'un bir projede **etkin** olması izin modu seçiminden ayrıdır:
`autoApprove` (varsayılan) modu seçmek özelliği açmaz. Oturum başlatmak için
proje, kullanıcı düzeyindeki güvenilen ayar dosyasında açıkça
etkinleştirilmiş olmalıdır — proje dizinindeki hiçbir dosya Code Mode'u
kendiliğinden açamaz:

```powershell
npm run code -- --enable --cwd C:\Projects\app
```

- Ayar, `CODE_MODE_DATA_DIR` altında `settings.json` olarak saklanır
  (varsayılan `%LOCALAPPDATA%\3p-code-engine`); kullanıcı düzeyi bir
  dosyadır. Kapatmak `--disable --cwd <proje>` ile yapılır.
- Ayar dosyası yoksa özellik her yerde kapalıdır (fail-closed başlangıç
  durumu). Bozuk dosya (geçersiz JSON, tanınmayan sürüm, hatalı `enabled`
  alanı) oturum başlangıcını açık hatayla reddeder: dosyayı düzeltin veya
  silin, sessiz sıfırlama yapılmaz.
- Etkinleştirilmemiş projede terminal başlatılamaz ve resume edilemez;
  hata gerekçesiyle birlikte etkinleştirme yolunu gösterir. Resume ayrıca
  Code Mode işaretini doğrular: dosya yoksa, bozuksa, Code Mode oturumu
  değilse ya da sürümü desteklenmiyorsa her biri ayrı gerekçesiyle açık
  hata verir.

## Konuşma ve kod kaydı

- Normal görünümde model mesajları, araç işlemleri ve edit önizlemeleri görünür.
- `Ctrl+O` aynı terminalde transcript'i açar/kapatır. Code satırları başlangıçta
  daraltılmıştır; yukarı/aşağı ve Enter ile seçilip genişletilir.
- `/status` iş durumlarını gösterir. Eski etkileşimli modlarda onay gerektiğinde onay sayfasının
  bağlantısı ve son tarih terminalde görünür; model karar veremez.
- Model `background:true` ile uzun kodu başlatırsa konuşmaya devam edilebilir.
  Tamamlanma sonucu hook denetiminden sonra modele `poll_event` olarak verilir;
  bu sentetik bir turdur, işin `source` kaydı `poll_event` olur ve süresi dolan
  onayları yeniden kurmaz.
- Süresi dolan bir onay yalnızca gerçek kullanıcı mesajıyla yeniden kurulur:
  aynı işin sonraki denemesi tekrar onay ister. Modelin başlattığı kod bu
  durumu değiştiremez.
- `Ctrl+C` çalışan işleri iptal eder; `/exit` veya boş satırda `Ctrl+D` çıkar.

Ön plan kodu varsayılan olarak ve en fazla 10 dakika, arka plan kodu 2 saat
çalışır; onayda geçen süre dahildir. `default`, `acceptEdits` ve `plan`
modlarında arka plan reddedilir. `rules` geriye uyumluluk uzantısıdır.

Konuşma, çalışma dizini, izin modu, iş kimlikleri ve Code Mode işareti veri
dizininde `chat-<hash>.json` olarak saklanır. Çıkışta devam komutu gösterilir:

```powershell
npm run code -- --resume OTURUM_KIMLIGI --endpoint http://127.0.0.1:9931/v1 --model model-adi
```

Oturum saklanan dizin ve izin moduyla açılır: başlangıç ortam değişkeni devam
eden oturumu artık sabitlemez. Saklanan mod bir kayıt tutucudur, kapı
değildir — ortam değişkeni saklanan moddan farklı olsa bile devam edilir ve
oturum bitişte yürüdüğü modu yeniden yazar; açık `--permission-mode` ise
güvendirilen bir insan tercihi olarak oturumu o moda taşar (terminaldeki
`/mode` ile aynı), hata değildir. Devam için projenin Code Mode'ta hâlâ
etkin olması yeterlidir. Ön plan
kodunun açık JSON `state`
değeri korunur; normal JavaScript değişkenleri tutulmaz. Çıkışta çalışan
işler iptal edilir; sunucu çökmesinden sonra çalışan iş yeniden yürütülmez.
Konuşma dosyaları düz JSON'dur; otomatik silinmez. `code_session_delete`
yalnızca yürütme state'ini siler, terminal konuşmasını silmez.

## Uyumluluk sınırı

Bu, Anthropic'in native Claude Code uygulaması değildir. Hesap/model kapıları,
Claude Desktop'ın kendi araç listesi, kendi Ctrl+O arayüzü ve yerleşik onay
pencereleri bu sunucuyla değiştirilemez. Terminalde denetlenen araç akışı ve
aynı oturumda transcript sağlanır; Desktop'ta MCP talimatlarını uygulama
kararı istemcinindir. Kabuk ve permission-pattern eşleştirme ayrıntıları da
Claude Code'un bütün ayar şemasının birebir uygulaması sayılmaz.

## Gerçek model doğrulaması

`npm run test:terminal:live -- --endpoint <url> --model <model>` gerçek
modelin bu terminal agent'ında tek REPL seçmesini, varsayılan `autoApprove`
ile Docker içinde dosya yazma/düzenleme/okuma etkilerini, broker ve onay
kuyruğu oluşmamasını doğrular. `--provider`, `--tool-protocol` ve
`--permission-mode` ile diğer bağlantılar seçilebilir. Rapor varsayılan
olarak `live-verification/terminal-report.json` dosyasındadır; `--report`
ile ayrı dosya seçilebilir. Güncel yerel proxy modeliyle hem native hem
metin protokolü doğrulandı:
[native raporu](live-verification/autoapprove-native-report.json),
[metin raporu](live-verification/autoapprove-text-report.json).
Her rapor kaynak hash'leri, süre ve model istek sayısını taşır; tek modelin
sonucu diğer modellere genellenmez. `test:auto:live`
isteğe bağlı eski classifier modunda zararsız yazmaya izin ve sentetik kimlik bilgisi çıkarmaya ret
senaryolarını çalıştırır. Bunlar sınırlı örneklerdir; bütün modellerle aynı
karar kalitesi veya native Claude Code ile ürün eşitliği anlamına gelmez.
