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

Varsayılan izin modu `auto` olur. Ayrı sınıflandırıcı verilmediyse aynı model
ve uç nokta kod bloğunu çalıştırmadan önce bir kez inceler. Hata, bağlantı
sorunu veya belirsiz cevap kodu çalıştırmaz. Araç kuralları ve hook'lar auto
onayından sonra da uygulanır; çalışma anında hesaplanan dosya/komutlar
araç denetimine girer. Yeni kodun sınıflandırılması önceki çalışan auto
kodunun inceleme onayını kaldırır; gereken sonraki çağrılar insan onayı ister.

Desktop kurulumundaki model, classifier ve MCP ayarlarını kullanmak için:

```powershell
npm run code -- --config "$env:LOCALAPPDATA\Claude-3p\claude_desktop_config.json" --cwd C:\Projects\app
```

`--config` açıkça verilen dosyadaki `3p-code-mode.env` ayarlarını yükler;
komut satırı ve önceden tanımlanmış ortam değişkenleri önceliklidir.
Yapılandırmada izin modu varsa korunur; config olmadan terminal `auto`
seçer. Model endpoint'i OpenAI uyumlu `/chat/completions` ve function tool
calling desteklemelidir. API anahtarı için `CODE_MODE_MODEL_API_KEY`, ayrı
classifier için `CODE_MODE_CLASSIFIER_API_KEY` ortam değişkeni kullanılabilir.

İsteğe bağlı ayarlar:

```powershell
npm run code -- --endpoint http://127.0.0.1:9931/v1 --model model-adi --permission-mode auto --isolation docker
```

`--classifier-endpoint`, `--classifier-model`, `--cwd`, `--resume` ve
`--permission-mode default|acceptEdits|plan|auto|bypassPermissions|rules`
desteklenir. Docker ayrıca kabuk süreçlerini proje mount'u olan Linux
konteynerine taşır. Docker olmadan izin verilen kabuk komutları host
hesabının yetkileriyle çalışır; JavaScript motoru yine QuickJS'tir.

## Konuşma ve kod kaydı

- Normal görünümde model mesajları, araç işlemleri ve edit önizlemeleri görünür.
- `Ctrl+O` aynı terminalde transcript'i açar/kapatır. Code satırları başlangıçta
  daraltılmıştır; yukarı/aşağı ve Enter ile seçilip genişletilir.
- `/status` iş durumlarını gösterir. İnsan onayı gerektiğinde onay sayfasının
  bağlantısı ve son tarih terminalde görünür; model karar veremez.
- Model `background:true` ile uzun kodu başlatırsa konuşmaya devam edilebilir.
  Tamamlanma sonucu hook denetiminden sonra modele `poll_event` olarak verilir.
- `Ctrl+C` çalışan işleri iptal eder; `/exit` veya boş satırda `Ctrl+D` çıkar.

Ön plan kodu varsayılan olarak ve en fazla 10 dakika, arka plan kodu 2 saat
çalışır; onayda geçen süre dahildir. `default`, `acceptEdits` ve `plan`
modlarında arka plan reddedilir. `rules` geriye uyumluluk uzantısıdır.

Konuşma, çalışma dizini, izin modu, iş kimlikleri ve Code Mode işareti veri
dizininde `chat-<hash>.json` olarak saklanır. Çıkışta devam komutu gösterilir:

```powershell
npm run code -- --resume OTURUM_KIMLIGI --endpoint http://127.0.0.1:9931/v1 --model model-adi --permission-mode auto
```

Oturum aynı dizin ve izin moduyla açılır. Ön plan kodunun açık JSON `state`
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
modelin bu terminal agent'ında REPL seçmesini, auto onayıyla Docker içinde
dosya yazma/düzenleme/okuma etkilerini doğrular. Rapor
`live-verification/terminal-report.json` dosyasındadır. `test:auto:live`
ayrıca zararsız yazmaya izin ve sentetik kimlik bilgisi çıkarmaya ret
senaryolarını çalıştırır. Bunlar sınırlı örneklerdir; bütün modellerle aynı
karar kalitesi veya native Claude Code ile ürün eşitliği anlamına gelmez.
