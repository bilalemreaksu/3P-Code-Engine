# Code Mode terminali

Terminal, modeli `REPL`, `code_status` ve `code_cancel` araçlarıyla çalıştırır. Model birbiriyle ilişkili dosya, kabuk ve MCP işlemlerini tek JavaScript bloğunda birleştirebilir. Terminal sonucu ve yardımcı işlemleri gösterir, kodu konuşma kaydında saklar. Desktop kullanımı için [MCP kılavuzuna](README-code-mode.md) bakın.

## Projeyi etkinleştirme

Node.js 24+ ile motorun depo kökünde çalıştırın.

~~~powershell
npm.cmd ci
$project = 'C:\Projects\uygulama'
npm.cmd run code -- --enable --cwd $project
~~~

`--enable` model bağlantısı açmadan proje yolunu güvenilen kullanıcı ayarına ekler. Motor `CODE_MODE_DATA_DIR` içindeki `settings.json` dosyasını okur. Varsayılan dizin Windows'ta `%LOCALAPPDATA%\3p-code-engine`, Linux'ta `$XDG_STATE_HOME/3p-code-engine` veya `~/.local/state/3p-code-engine` olur. Yol tam olarak eşleşir, Windows'ta harf farkı göz ardı edilir. Alt dizinleri ayrı çalışma dizini olarak kullanacaksanız onları da etkinleştirin.

Desktop MCP yapılandırması farklı bir `CODE_MODE_DATA_DIR` kullanıyorsa aşağıdaki biçimle aynı veri dizinine yazın.

~~~powershell
$desktopConfig = Join-Path $env:LOCALAPPDATA 'Claude-3p\claude_desktop_config.json'
npm.cmd run code -- --config $desktopConfig --enable --cwd $project
~~~

Eksik ayar dosyası tüm projeleri kapalı kabul eder. Bozuk ayar dosyasında yürütme ve oturuma devam hata verir. CLI yardımında yer alan `--disable` v0.12.0'da etkinleştirme işlemine ulaşmaz. Bir proje kaydını kapatmak için motorun depo kökünde aşağıdaki komutu kullanın. Özel veri dizini kullanıyorsanız önce aynı `CODE_MODE_DATA_DIR` değerini ayarlayın.

~~~powershell
node --input-type=module -e "import { dataDir } from './execution-manager.mjs'; import { setProjectEnabled } from './code-mode-settings.mjs'; await setProjectEnabled(dataDir, process.argv[1], false)" -- $project
~~~

## Model bağlantısı

Uç nokta API taban adresidir. Model kimliğini sağlayıcıdan alın. OpenAI uyumlu sunucularda `/v1/models`, API kimliğini doğrulamak için kullanılabilir.

| `--provider` | Örnek taban adresi | Araç protokolü |
| --- | --- | --- |
| `openai` (varsayılan) | `http://127.0.0.1:9931/v1` | Native function calling veya JSON metin |
| `anthropic` | `https://api.anthropic.com/v1` | JSON metin, Messages API |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta` | JSON metin, generateContent API |

~~~powershell
npm.cmd run code -- --endpoint http://127.0.0.1:9931/v1 --model 'MODEL_KIMLIGI' --cwd $project --isolation docker
npm.cmd run code -- --provider anthropic --endpoint https://api.anthropic.com/v1 --model 'MODEL_KIMLIGI' --cwd $project
npm.cmd run code -- --provider gemini --endpoint https://generativelanguage.googleapis.com/v1beta --model 'MODEL_KIMLIGI' --cwd $project
~~~

- `--tool-protocol auto` OpenAI uyumlu API'de native çağrıyla başlar. Bağdaştırıcı, `400` veya `422` yanıtında araç çağrılarının desteklenmediğini açıkça tanırsa bir kez metin protokolüne geçer. Ağ, kota ve kimlik doğrulama hataları olarak kalan yanıtlar kullanıcıya iletilir.
- `--tool-protocol text`, model geçerli bir JSON çağrı zarfı üretebildiğinde doğrudan kullanılabilir. Markdown veya serbest metindeki JavaScript örnekleri yalnızca konuşma çıktısıdır. Geçersiz çağrı zarfları hata verir.
- Anahtarı `CODE_MODE_MODEL_API_KEY` üzerinden verin. `CODE_MODE_MODEL_ENDPOINT`, `CODE_MODE_MODEL_NAME`, `CODE_MODE_MODEL_PROVIDER` ve `CODE_MODE_TOOL_PROTOCOL` seçenekleri ortam değişkeninden de okunur.
- `--config <dosya>`, seçilen Desktop MCP kaydındaki `CODE_MODE_*` ve `REVIEW_MODEL_*` ortam değerlerini yükler. Komut satırı ve önceden ayarlanmış ortam önceliklidir. `--endpoint` ve `--model` seçenekleri, MCP kaydında model bilgisi bulunmadığında açıkça verilmelidir. Desktop'ın aktif gateway profili kendi yapılandırmasından yönetilir.

### Basalt üzerinde Qwen

Basalt, yapılandırmadaki `models[].alias` alanını API model kimliği olarak sunabilir. `9931` portunda doğrulanan kurulum `Qwen3.8-27B-QUASAR-NVFP4.basalt` dosyasını `anthropic/claude-opus-5-5` takma adıyla sundu. O kurulumda terminal ve Desktop, API çağrılarında takma adı kullanır. Başka bir Basalt kurulumunda kendi yapılandırmanızdaki kimliği kullanın. [Basalt model yönlendirme belgesi](https://github.com/jesdga95/basalt/blob/main/docs/configuration/models.md)

~~~powershell
(Invoke-RestMethod 'http://127.0.0.1:9931/v1/models').data | Select-Object id
npm.cmd run code -- --endpoint http://127.0.0.1:9931/v1 --model 'anthropic/claude-opus-5-5' --cwd $project --isolation docker
~~~

## Oturum kullanımı

| Tuş veya komut | İşlem |
| --- | --- |
| `Ctrl+O` | Konuşma ile kod kaydı arasında geçer |
| Ok tuşları ve `Enter` | Kod kaydında işi seçer ve kod bloğunu açar |
| `/status` | İşlerin durumunu gösterir |
| `Shift+Tab` veya `/mode <mod>` | Oturumun izin modunu değiştirir |
| `/mode` | Etkin izin modunu gösterir |
| `Ctrl+C` | Çalışan işleri iptal eder |
| `/exit` veya boş satırda `Ctrl+D` | Oturumu kapatır |

Normal görünüm araç işlemlerini ve düzenleme önizlemelerini gösterir. `autoApprove`, yeni bir terminal oturumunun varsayılan modudur. `auto` seçilirse tam JavaScript bloğu bir OpenAI uyumlu sınıflandırıcıya gönderilir. Ayrı sınıflandırıcı için `--classifier-endpoint`, `--classifier-model` ve gerektiğinde `CODE_MODE_CLASSIFIER_API_KEY` kullanın. Diğer modların davranışı [MCP kılavuzundaki tabloda](README-code-mode.md#izin-modları) açıklanır.

`autoApprove`, `rules`, `auto` ve `bypassPermissions` modlarında model `background:true` ile bir iş başlatabilir. İş sürerken konuşma devam eder. Terminal, tamamlanma sonucunu çıktı hook'undan sonra `poll_event` olarak modele iletir. Ön plan varsayılan ve üst sınırı 10 dakika, arka plan varsayılan ve üst sınırı 2 saattir. Onay bekleme süresi bu bütçeye dahildir.

### Oturuma devam

Terminal, konuşmayı, proje yolunu, izin modunu, sağlayıcıyı, araç protokolünü ve iş kimliklerini veri dizinindeki `chat-<hash>.json` dosyasında saklar. Oturum kimliği başlıkta ve çıkışta gösterilir.

~~~powershell
npm.cmd run code -- --resume 'OTURUM_KIMLIGI' --endpoint http://127.0.0.1:9931/v1 --model 'MODEL_KIMLIGI'
~~~

Devam sırasında proje etkin olmalıdır. Açık `--permission-mode` oturumun kayıtlı modunu değiştirebilir. Sağlayıcı ve protokol belirtilmediğinde kayıttaki değerler kullanılır. Model bağlantısını ve gerekliyse API anahtarını yeniden sağlayın. Ön plandaki yürütmenin açık JSON `state` değeri korunur. Çalışan işler oturum kapanışında iptal edilir, kesintiye uğrayan işler yeniden başlatılmaz.

## Doğrulama

~~~powershell
npm.cmd run test:terminal:flow
npm.cmd run test:terminal:live -- --endpoint http://127.0.0.1:9931/v1 --model 'MODEL_KIMLIGI' --tool-protocol native --report (Join-Path $env:TEMP '3p-terminal-native.json')
~~~

Canlı test geçici projeyi kendisi etkinleştirir. Modelin tek `REPL` seçimini ve yazma, düzenleme, okuma işlemlerinin gerçek dosya etkisini ölçer. Varsayılan test ayarları `autoApprove` ve Docker'dır. Metin protokolünü ölçmek için `--tool-protocol text` ile ayrı rapor üretin. [Test kapsamı ve kanıtlar](CODE-MODE-COMPATIBILITY.md#doğrulama-kayıtları)
