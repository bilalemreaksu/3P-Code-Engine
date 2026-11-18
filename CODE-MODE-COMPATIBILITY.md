# Claude Code Mode ile uyumluluk

3P Code Engine v0.12.0, Claude Code Mode'un araç çağrılarını JavaScript ile toplama yaklaşımını uygular. 3P terminali modeli ve araç protokolünü seçer. MCP yüzeyinde model seçimi ve sohbet arayüzü istemciye aittir. Karşılaştırma kamuya açık belgelere ve depodaki testlere dayanır. [Claude Code Mode](https://code.claude.com/docs/en/code-mode)

## Davranış karşılaştırması

| Davranış | Claude Code Mode | 3P Code Engine |
| --- | --- | --- |
| Birden çok araç çağrısı | Model bir JavaScript bloğunda çağrıları sıralayabilir, paralel çalıştırabilir ve çıktıyı süzebilir. | Terminalde `REPL`, MCP'de `code_execute` veya `code_start`. Sıralı `await`, `Promise.all` ve son ifade sonucu desteklenir. |
| Kullanılabilirlik | Uygun Claude Code hesabı, modeli ve etkileşimli terminal ile deneysel özellik. | Kullanıcı ayarından proje başına etkinleşen bağımsız terminal ve MCP sunucusu. Terminal OpenAI uyumlu, Anthropic ve Gemini uç noktalarına bağlanabilir. |
| Araç yüzeyi | Claude Code kendi araçlarını koddan çağırır. | Terminal dosya, kabuk ve stdio MCP yardımcılarını QuickJS üzerinden sunar. Desktop'ta `3p-code-mode` ek bir MCP sunucusudur. |
| İzinler | `auto` modunda sınıflandırıcı kod bloğunu inceler. Kurallar ve uygun hook'lar araç çağrısında uygulanır. | Varsayılan `autoApprove` onay istemez ve sınıflandırıcı kullanmaz. Açık `auto` seçimi blok başına sınıflandırma sunar. Kurallar ve hook'lar çalışma sırasında uygulanır. |
| Ön plan ve arka plan | Belirli izin modlarında arka planda çalışır. Ön plan 10 dakika, arka plan 2 saatle sınırlıdır. | Aynı varsayılan ve üst süreler. Terminal tamamlanmayı `poll_event` ile işler. MCP istemcisi `code_status` ile sorgular. |
| Kod kaydı | `Ctrl+O` ile konuşma kaydındaki kod genişletilir. | Terminalde `Ctrl+O` ve düzenleme önizlemesi bulunur. MCP'de kod ve olaylar iş kaydından okunur. |
| Oturuma devam | Claude Code'un kendi oturum yönetimi. | Terminal konuşmayı ve izin modunu saklar. MCP aynı `sessionId` ile açık JSON `state` üzerinden devam eder. Kesilen işler yeniden yürütülmez. |
| İşletim sistemi ayrımı | Claude Code kendi izin ve sandbox yapılandırmasını sunar. | QuickJS, JavaScript'in doğrudan host erişimini kapatır. Docker, dosya ve kabuk işlemleri için ek bir Linux çalışma alanı sağlar. |

Claude Code'un hesap ve sürüm kontrolleri, uzaktan kontrolü, tarayıcı entegrasyonları, ekip özellikleri ve Desktop arayüzü Anthropic ürününe aittir. 3P'nin kapsadığı akış JavaScript yürütme, yardımcı araçlar, yerel izinler ve iş kayıtlarıdır. [Claude Code gereksinimleri](https://code.claude.com/docs/en/code-mode#requirements) · [3P MCP API'si](README-code-mode.md#araç-apisi)

## İzinler ve hook farkları

3P'nin `allow`, `ask` ve `deny` desenleri, Claude Code ayar şemasının bir alt kümesini kapsar. Eski ayarları taşırken doğrudan örnekleri ve testleri esas alın. [3P kuralları](README-code-mode.md#kurallar-ve-hooklar) · [Claude Code izinleri](https://code.claude.com/docs/en/permissions) · [Claude Code hook referansı](https://code.claude.com/docs/en/hooks)

- `Edit(yol)` hem `Edit` hem `Write` çağrılarını kapsar. 3P'nin `Write(yol)` uzantısı yalnızca yazmayı, `Read(yol)` ise yalnızca okumayı kapsar. Yol desenleri metin tabanlıdır.
- `Bash(...)` komut metni ve doğrudan alt komutlara bakar. İç içe komut, yönlendirme, sarmalayıcı ve PowerShell alias davranışları Claude Code'daki tüm kurallarla aynı sınırlara sahip değildir. İşletim sistemi sınırları için [Docker modeline](SECURITY.md#docker-sınırı) bakın.
- 3P hook adaptörü `PreToolUse` ve arka plan `UserPromptSubmit` olaylarında `command`, `http` ve `mcp_tool` türlerini destekler. `matcher` tam adları, `|` ile ayrılan adları ve `*` değerini kabul eder. `timeout` saniye, `timeoutMs` milisaniye cinsindendir. Regex, `defer`, `prompt` ve `agent` türleri ile desteklenmeyen alanlar doğrulama hatası üretir.
- `updatedInput` sonrasında `deny` tekrar değerlendirilir. `auto` modunda hook'un değiştirdiği ve salt okunur kabul edilmeyen girdi için insan kararı gerekir. Terminalde yalnızca gerçek kullanıcı mesajı süresi dolan onay durumunu yeniden kurabilir. Desktop/MCP yüzeyinde zaman aşımı mevcut iş boyunca geçerli kalır.

## Doğrulama kayıtları

| Kanıt | Doğruladığı davranış |
| --- | --- |
| [QuickJS testleri](test-code-mode-runtime.mjs) ve [hata yolları](test-code-mode-runtime-errors.mjs) | Gerçek eşzamanlılık, CPU ve bellek sınırları, son ifade, Node erişiminin kısıtlanması ve hataların çağırana dönmesi. |
| [Sağlayıcı testleri](test-code-mode-portable.mjs) | Üç API ailesinde kontrollü yanıtlarla araç protokolü, gerçek dosya etkisi ve oturuma devam. Native talebin açıkça reddedilmesinde OpenAI metin protokolüne geçiş. |
| [Terminal akışı](test-terminal-flow.mjs) | Kontrollü model ile gerçek terminal girdisi, düzenleme farkı, çıktıyı engelleme, arka plan olayı, iptal, `Ctrl+O` ve yeniden başlatma. |
| [Yürütme yöneticisi](test-execution-manager.mjs), [kullanıcı ayarı](test-code-mode-settings.mjs), [izinler](test-code-mode-rules.mjs) ve [hook'lar](test-code-mode-hooks.mjs) | Süre sınırları, izin ve onay geçişleri, proje etkinleştirmesi ve politika biçimleri. `test-code-mode-rules.mjs` ayrıca doğrudan çalıştırılabilir. |
| [Docker izolasyonu](test-code-mode-isolation.mjs) ve [CI iş akışı](.github/workflows/ci.yml) | Gerçek Docker ile proje mount'u, host köprüsü, onay ve iptal. CI, Windows ve Ubuntu testlerinin yanında ayrı bir zorunlu Docker işi çalıştırır. |
| [Native terminal raporu](live-verification/terminal-proxy-native-2026-11-18.json) ve [JSON metin raporu](live-verification/terminal-proxy-text-2026-11-18.json) | Yerel OpenAI uyumlu uç noktada `autoApprove` ve Docker ile tek `REPL` içinde yazma, düzenleme ve iki okuma. Bir raporda iki okuma bulunması eşzamanlılık ölçümü yerine geçmez. |
| [Canlı sınıflandırıcı raporu](live-verification/classifier-eval-report.json) | Raporun kaynak sürümünde 51 çevrimdışı kontrol ve 19 canlı senaryo geçti. Canlı sonuçta 0 yanlış izin, 0 yanlış ret ve 0 bozuk yanıt var. |

Raporlardaki `model` alanı API'ye gönderilen kimliktir. Yerel Basalt yapılandırmasında `anthropic/claude-opus-5-5` takma adı `Qwen3.8-27B-QUASAR-NVFP4.basalt` dosyasına bağlı olarak doğrulandı. Aynı rotada yapılan canlı native test tek `REPL` içinde gerçek dosya etkisini doğruladı. Bir rapordaki takma ad tek başına fiziksel modeli tanımlamaz. Raporlar kaynak hash'leriyle değerlendirilir ve canlı model sonuçları kullanılan model, protokol ve senaryolarla sınırlıdır. [Basalt model yönlendirmesi](https://github.com/jesdga95/basalt/blob/main/docs/configuration/models.md)

Ayrıca Claude Desktop 3P'nin kayıtlı MCP yapılandırmasıyla taze bir sunucu süreci açıldı. Kalıcı proje etkinleştirmesi okundu ve `code_execute` Docker'da başarıyla sonuçlandı. Bu kontrol MCP bağlantısını ve yürütmeyi doğrudan doğruladı. Desktop sohbetinin model tarafından araç seçip sonucu göstermesi ayrı bir arayüz kontrolüdür. [Desktop doğrulama adımı](README-code-mode.md#ilk-desktop-çağrısı)

Önceki [MCP yüzey raporu](live-verification/report.json), [auto denemesi](live-verification/auto-report.json) ve eski terminal raporları ait oldukları kurulumun tarihsel kayıtlarıdır. Güncel kaynak, ayar ve Desktop arayüzü hakkındaki iddialar için ilgili güncel denetim veya yeni bir canlı çalıştırma gerekir.

## Testleri yeniden çalıştırma

~~~powershell
npm.cmd test
node test-code-mode-rules.mjs
npm.cmd run test:isolation:required
~~~

Canlı terminal örneği yerel Basalt takma adını kullanır. Başka bir kurulumda model kimliğini değiştirin. Eski kanıtı korumak için raporu ayrı bir yola yazın.

~~~powershell
$endpoint = 'http://127.0.0.1:9931/v1'
$model = 'anthropic/claude-opus-5-5'
npm.cmd run test:terminal:live -- --endpoint $endpoint --model $model --tool-protocol native --report (Join-Path $env:TEMP '3p-live-native.json')
npm.cmd run test:terminal:live -- --endpoint $endpoint --model $model --tool-protocol text --report (Join-Path $env:TEMP '3p-live-text.json')
npm.cmd run test:classifier:eval -- --endpoint $endpoint --model $model --isolation docker --report (Join-Path $env:TEMP '3p-classifier.json')
~~~

Canlı sınıflandırıcıya gönderilen örnekler sentetiktir. Hata veya yanlış izin raporu başarısız kılar. Yanlış ret sayısı ayrıca raporlanır. Dosya bulma, değişiklik yapma ve gerçek proje testini tek REPL'de koşma gibi daha geniş bir görev için seçtiğiniz modelle ayrı uygulama testi yapın.
