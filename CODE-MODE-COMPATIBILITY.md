# Code Mode karşılaştırması

18 Kasım 2026 tarihinde [Code Mode belgesi](https://code.claude.com/docs/en/code-mode)
ve [hook referansı](https://code.claude.com/docs/en/hooks) temel alınmıştır.
Bu proje, 3P/Desktop için bağımsız bir MCP sunucusudur. Claude Code ürününün
kendi özellik bayrağını, hesap/model uygunluğunu veya arayüzünü uygulamaz.

## Güncel çalışma biçimi

İstenen onaysız çalışma için MCP, kurulum ve yeni terminal oturumlarında
varsayılan `autoApprove` olur. Classifier ve insan onay brokeri çağrılmaz;
`ask` kararları otomatik geçilir. Açık `deny` ve engelleyen hook'lar uygulanır.
Mevcut yapılandırmada başka mod seçilmişse yeniden kurulum veya açık
`--permission-mode autoApprove` ile değiştirin. Kaydedilmiş oturumlar kendi
modlarını korur; resume ederken de açık mod seçilebilir.

| Gereksinim | Uygulama ve doğrulama |
| --- | --- |
| Tek JavaScript ile sıralı/paralel araç çağrısı, sonuç süzme | QuickJS + Acorn, async yardımcılar, `Promise.all`; runtime testleri |
| Onaysız ön plan, arka plan, dosya/kabuk/dış MCP | `autoApprove`; `test-code-mode-portable.mjs` gerçek dosya etkisi ve broker kaydı oluşmamasını denetler |
| Model adına bağımlı olmama | Sabit model listesi yok; OpenAI uyumlu, Anthropic Messages, Gemini generateContent adaptörleri |
| Native araç desteği olmayan model | JSON metin protokolü; OpenAI uyumlu API'de açık desteklenmiyor hatasında tek otomatik geçiş; `--tool-protocol text` ile doğrudan seçim |
| API/protokol kanıtı | Üç sağlayıcı için kontrollü HTTP yanıtlarıyla gerçek ajan → yürütme → dosya → araç sonucu → model yanıtı → resume döngüsü; ücretli canlı API testi değildir |
| Hız | Toplu ve paralel yardımcı çağrıları; varsayılanda ek classifier turu ve insan beklemesi yok. Gerçek toplam hız modele, API'ye ve komutlara bağlıdır; bütün modeller için benchmark iddiası yok |
| Kayıt, Ctrl+O, arka plan, resume | Mevcut terminal, transcript ve bütünleşim testleri |
| Native Claude Code ile ürün eşitliği | Yok: istemci arayüzü/yerleşik araçları, hesap kapıları, Remote Control ve bilgisayar kullanımı bu motorun parçası değildir |

Güncel canlı kanıt: yerel OpenAI uyumlu proxy üzerinden
`anthropic/claude-opus-5-5`, Docker ve `autoApprove` ile
[native](live-verification/autoapprove-native-report.json) ve
[metin](live-verification/autoapprove-text-report.json) protokollerinde tek
REPL içinde yazma → düzenleme → iki okuma doğrulandı. Her iki rapor
classifier yapılandırılmadığını, broker/onay kuyruğu oluşmadığını, kaynak
hash'lerini ve model istek sayısını kaydeder. Bu, doğrudan Anthropic/Gemini
API'lerinin veya bütün modellerin canlı doğrulaması değildir.

MCP sunucusu kendi başına model API'sine ihtiyaç duymaz; MCP destekleyen
istemcinin seçtiği modelle çalışır. Terminal, yukarıdaki üç API ailesinden
birine ihtiyaç duyar. API erişimi olmayan uygulamalar ve geçerli kod/JSON
üretemeyen modeller için "bütün yapay zekâlarda doğrulandı" denemez.

Aşağıdaki ayrıntılı matris, önceki classifier/insan onay modlarının tarihsel
uyumluluk kaydıdır. Bu modlar isteğe bağlı olarak korunur; onaysız varsayılanın
gereksinimi değildir. Önceki canlı raporlar yeni adaptörlerin veya bugünkü
kaynak değişikliklerinin canlı doğrulaması sayılmaz.

## v0.12 farkı

[Terminal oturumu](README-terminal.md) modelin araç listesini denetler:
yalnızca `REPL`, durum ve iptal vardır. Ctrl+O ve daraltılmış Code satırları
aynı konuşma terminalinde çalışır; arka plan sonucu modele olay olarak döner.
Desktop MCP desteği korunur; Desktop'ın yerleşik araçlarını değiştiremez.

JavaScript artık QuickJS WASM motorunda yürür; Node.js/prototype üzerinden
host erişimi, dinamik Node import'u, doğrudan fetch ve protokol taklidi yoktur.
Son ifade Acorn AST ile alınır. Tarihsel `auto` kurulumu classifier gerektirirdi;
güncel varsayılan `autoApprove` MCP kurulumunda model gerektirmez.
Komut/dosya kapsamları ve MCP araç wildcard'ları desteklenir. İzin verilen
kabuk programları için ayrıca Docker sınırı gerekir. Bu değişiklikler native
Claude Code ürününün bütün istemci/ayar davranışlarında birebir uyum iddiası
değildir. Eski Desktop raporu yeni sürümün UI kanıtı değildir.

| Davranış | 3P Code Mode v0.12 |
| --- | --- |
| JavaScript ile sıralı/paralel araç çağrısı ve sonuç süzme | `code_execute`, async yardımcılar ve `Promise.all` |
| Read/Write/Edit/Bash, `$` komutları | Yardımcılar ve `tools` takma adları; kabuk platforma göre seçilir |
| MCP araçları | Host ve Docker modlarında yapılandırılmış stdio sunucuları keşfedilir/çağrılır; Docker'da politika denetimli host köprüsü kullanılır. Desktop'ın yerleşik araçları devralınmaz |
| Son ifade sonucunu döndürme | Acorn AST ile son üst seviye ifade; yorumlar, template ve geçerli noktalı virgülsüz kod korunur |
| Kurallar ve `PreToolUse` | Araç wildcard'ı, komut/dosya kapsamı, REPL denetimi ve JSON kararları; native `policy.hooks` adaptörü (matcher grupları, saniye `timeout`, `mcpTool`/`arguments`); tüm native ayar şeması değildir |
| Hook hatası/zaman aşımı, `onFailure` | Command, HTTP ve MCP hook'ları; açık engelleme kararı her zaman uygulanır |
| `updatedInput` / `additionalContext` | Hook'un yeni girdisi çalışana, denetime, onay önizlemesine ve kayda taşınır; zincir sonraki hook'a aktarılır. Context sonuçla modele iletilir |
| Hook `permissionDecision: allow` | Modun onayını atlar; `deny`/`ask` kuralları, `plan` kısıtı ve auto sınıflandırmayı geçersiz kılamaz |
| `UserPromptSubmit` / `poll_event` | Arka plan çıktısı yayımlanmadan önce denetlenir; engellenirse günlük, olay, sonuç ve state paylaşılmaz |
| Auto: bütün kodu bir kez sınıflandırma | Yapılandırılmış OpenAI uyumlu sınıflandırıcı; hata durumunda engelleme |
| Yeni kod başlayınca eski auto onayının kaybı | Aynı sunucudaki eski auto işleri sonraki değişiklik yapan yardımcı çağrılarda insan onayı ister; hook'un değiştirip sunduğu girdi de eski inceleme onayıyla sessizce çalışmaz, insan onayı ister |
| Onay geri sayımı | Varsayılan iki dakika; karar yerel onay brokerinin web arayüzünde verilir (broker kökeni doğrulanır, hash zincirli denetim); süre sonunda otomatik ret |
| Modelin kendi onayını verememesi | MCP araçları karar taşıyamaz, QuickJS doğrudan brokere erişemez. İzin verilen host shell/MCP programlarının yetkileri ayrıca değerlendirilmelidir: [SECURITY.md](SECURITY.md) |
| Ön plan / arka plan süreleri | Varsayılan ve üst sınır 10 dakika / 2 saat |
| Arka planda konuşmaya devam | Desktop'ta code_start/status; terminalde REPL background:true ve tamamlanınca modele poll_event |
| Oturumu devam ettirme | JSON `state`, cwd ve izin modu diskte tutulur; normal JS değişkenleri tutulmaz |
| Oturum izin modu | Eskiden: `CODE_MODE_PERMISSION_MODE` oturumu başlangıçta sabitlerdi ve yüzeyler saklanan modla sıkı eşleşme isterdi | Etkinlik ayrı bir güvenilen kullanıcı ayarıdır (aşağıda). Terminal oturumu modu diskte taşır; başlangıç ortam değişkeni devam eden oturumu sabitlemez, saklanan modla uyuşmayan ortam açık hata değildir — devam edilir ve oturum bitişte yürüdüğü modu yeniden yazar. Açık `--permission-mode` (terminal resume) veya `/mode` güvendirilen bir insan tercihi olarak modu taşar, hata değildir. Mod çalışma anında yalnızca terminalde Shift+Tab veya `/mode <mod>` ile değişir; arka plan uygunluğu (`rules`/`auto`/`bypassPermissions`) modla birlikte yeniden hesaplanır. Modelin modu değiştirecek aracı yoktur |
| Proje etkinleştirme kapısı | Claude Code'ta proje başına böyle bir etkinleştirme kapısı yoktur; hesap/model uygunluğu ürünün kendi kapılarıdır | Code Mode'un projede etkin olması, izin modundan ayrı bir güvenilen kullanıcı ayarıdır (veri dizinindeki `settings.json`, terminal `--enable`/`--disable`). Proje dizinindeki dosya özelliği kendiliğinden açamaz; dosya yoksa her yerde kapalı (fail-closed), bozuksa gerekçesiyle açık hata. Kapatılmış/bozuk durumda yürütme ve resume `Code Mode is not enabled for <dizin>` gerekçesiyle reddedilir. Anthropic hesap/model kontrolleri taklit edilmez |
| Resume işaret doğrulaması | Claude Code'un kendi oturum yönetimi | Terminal resume, Code Mode işaretini doğrular: dosya yoksa, bozuk JSON, işaret yoksa (`codeMode` alanı) veya sürüm desteklenmiyorsa her biri ayrı gerekçesiyle açık hata verir; kapalı proje devam edemez |
| Olay kaynağı ayrımı | — | Her iş `source` kaydeder: `user` (terminalde gerçek kullanıcı mesajı), `poll_event` (sentetik arka plan tamamlanma turu), `mcp` (Desktop yüzeyi). Desktop gerçek kullanıcı olayını bildiremediğinden bu, iş kaydı ve belgede açıktır |
| Süresi dolan onayın yeniden kurulması | Süre sonunda otomatik ret | Yeni bir yürütme artık yeniden kurmaz (eski küresel sıfırlama kaldırıldı). Yalnızca gerçek kullanıcı mesajı, o oturumun işlerindeki süresi dolmuş onay durumunu yeniden kurar; `poll_event` ve modelin başlattığı kod yeniden kurmaz. MCP yüzeyinde süresi dolan onay iş bitene kadar ret olarak kalır |
| Transcript ve düzenleme önizlemesi | MCP metin blokları; yeni terminalde aynı konuşmada Ctrl+O ve daraltılmış Code satırları |
| Claude Code Ctrl+O konuşma arayüzü | Desktop'ın kendi UI'ı değişmez; bu projenin terminali aynı oturumda karşılığını sağlar |
| Yerleşik araç izinleri / OS sandbox | QuickJS doğrudan Node erişimini kapatır; izin verilen kabuk için Docker ek OS sınırıdır ([SECURITY.md](SECURITY.md)) |
| Yürütme hata yolları | Gözlenmemiş bir yardımcı reddi, fırlatan zamanlayıcı geri çağırması, bekleyen iş içinde bellek sınırı aşımı (64 MiB) veya seriye dökülemez sonuç (BigInt, döngüsel) "başarılı" sonucu bastırmaz: yürütme açık gerekçesiyle reddedilir. `timeoutMs`, bir yardımcıda bekleyip atıl durumdaki yürütmeyi de "süre aştı" ile durdurur; bağlam kapatıldıktan sonra sonuçlanan bekleyen işlemler sessizce yok sayılır, asılı süreç veya unhandled rejection bırakılmaz |
| Anthropic hesabı, native build, özellik bayrağı ve sürüm kapıları | Claude Code'a özgü; bu bağımsız sunucuya uygulanmaz |
| Remote Control, Chrome, computer use, agent teams ve uygulamalar arası oturum taşıma | Claude Code'a ait entegrasyonlar bu projede bulunmaz |

`rules` modu bu projenin ekidir ve önceki sürümle uyumluluk için arka plana
izin verir. `auto` ve `bypassPermissions` da arka planı destekler; `default`,
`acceptEdits` ve `plan` ile `code_start` reddedilir. Üstteki tablo, Claude Code
ayar dosyalarının veya tüm hook referansının birebir uyumluluğu iddiası değildir.

## İzin şeması

Kural motoru ([code-mode-rules.mjs](code-mode-rules.mjs),
[code-mode-policy.mjs](code-mode-policy.mjs)) [resmi permissions
belgesindeki](https://code.claude.com/docs/en/permissions.md) şemaya uyar:
`deny` → hook'lar → (hook `updatedInput` döndürürse `deny` ve `plan`
kısıtının değiştirilmiş girdiye karşı yeniden) → `ask` (allow geçersiz
kılamaz) → `allow` (mod onayını atlar) → modun kendi onayı; `deny`
`bypassPermissions` dahil her modda, özgün ve değiştirilmiş girdinin
her ikisine karşı engeller. `Edit(path)` kuralları native şemada olduğu gibi **Write
araçlarını da kapsar**; `Write(path)` ise native şemada yol parametreli
Write kurallarının kabul edilip hiç eşleşmemesi karşısında bu projenin
**açık belgeli genişlemesidir** ve yalnızca Write aracına uygulanır.
Bash ve PowerShell komutları aynı metin grameriyle değerlendirilir;
`allow` kuralları bileşik komutu, yönlendirmeyi, yer değiştirmeyi
(substitution) ve çözümlenemeyen sözdizimini **asla** onaylamaz.
Salt-okunur kümesi (belgelenen komutlar, `cd` izleme, `find`/`git`
istisnaları, ağ yolları, 10.000 karakter sınırı) `test-code-mode-rules.mjs`
matrisiyle Windows yolları ve Docker konuk `/work` yolları
(`test-code-mode-host.mjs`) üzerinde test edilir.

Bu uyum, metin tabanlı bir izin motorunun native Claude Code'un kabuk
ağacı çözümlemesiyle birebir aynı kararları vereceği iddiası **değildir**.
Kalan farklar bilinçli ve çoğunlukla "daha çok onay ister" yönündedir:

| Alan | Native davranış | Bu projede | Yön |
| --- | --- | --- | --- |
| İç içe yer değiştirme | `echo "$(git clean -f)"` içindeki komutlar da kurallara eşleştirilir | Metin eşleştirmesi yalnızca doğrudan alt komutları görür; içe gömülü komut eşleşmez | Fail-closed (kurallar kabuk sınırı değildir; belge de bunu belirtir) |
| Yönlendirme hedefi | `> dosya` Edit, `< dosya` Read kurallarına ve çalışma dizinlerine karşı denetlenir | Herhangi bir yönlendirme komutu salt-okunur olmaktan çıkar ve `allow` kapsamı dışında kalır → onay ister | Daha çok onay (çalışma dizini içi hedeflerde native sessiz olur) |
| `acceptEdits` dosya komutları | Çalışma dizininde `mkdir`, `touch`, `rm`, `mv`, `cp`, `sed` biçimleri onaysız | Onay ister | Daha çok onay |
| Alias normalizasyonu (kurallarda) | `Bash(gci *)` gibi kurallar PowerShell komletine normalleştirilerek eşleşir | Salt-okunur kümesinde alias tanınır, komut deseni metinsel eşleşir | Kuralların kapsamı dar |
| Sarmalayıcılar | `timeout`, `nice` biçimli sarmalayıcılar kaldırıldıktan sonra eşleştirilir | Kaldırılmaz; desen doğrudan metne eşleşir | Kuralların kapsamı dar |
| `Read(path)` deny | Aynı yol için Edit/Write'ı da engeller | Yalnızca Read'i engeller (Edit/Write için açık kural gerekir) | Fail-closed |
| Negasyon (`!`) | Desteklenmezse ayrı kural önerilir | Kurulumda açık hatayla reddedilir, sessizce yeniden yorumlanmaz | Eşdeğer (hatayla) |
| Çalışma dizini okuma sınırı | `permissions.blockReadsOutsideWorkingDirectories` | Okuma yolları çalışma dizinleriyle sınırlanmaz | Fail-closed değil — açık fark; Docker sınırıyla birlikte değerlendirin |
| `Tool(param:value)` denetimi | Parametre değerleri kurallarla denetlenebilir | Araç adı/kapsam denetimi parametre değeri denetimi değildir | Daha dar denetim |
| `auto` geniş allow kuralları | Geniş Bash allow kuralları auto modunda uygulanmaz | Apply edilir | Daha az onay — açık fark |
| `file`, `ps`, `docker` salt-okunur istisnaları | Belgelenen bayrak koşullarıyla salt-okunur kabul edilir | Salt-okunur kümesinde yer almaz → onay ister | Daha çok onay |
| Simbolik bağlar | Hedefe göre yeniden denetlenebilir | Yol metnine göre denetlenir | Açık fark |

Hook sözleşmesinde kalan farklar (native hook referansına göre):

| Alan | Native davranış | Bu projede | Yön |
| --- | --- | --- | --- |
| `permissionDecision: defer` | Etkileşimsiz `-p` modunda karar ertelenir | Etkileşimli sunucuda açık hatayla reddedilir | Fail-closed |
| Regex hook matcher | Araç adı regex'leriyle eşleşir | Yalnızca tam araç adları (`\|` ile ayrılmış) veya `*`; regex açık hatayla reddedilir | Fail-closed |
| Hook zaman aşımı birimi | `timeout` saniye, varsayılan 600 sn | Saniye `timeoutMs`'e (100–600000 ms) çevrilir; varsayılan 5000 ms | Yapılandırma farkı |
| Hook'tan dönen girdiye kurallar | Kurallar hook'un döndürdüğü girdiye karşı değerlendirilir | Aynı, ayrıca `deny`/`ask` özgün girdiye karşı da değerlendirilir | Daha çok engelleme |
| `systemMessage` / `terminalSequence` | İstemciye terminal mesajı/sırası iletir | MCP sunucu yüzeyinde böyle bir kanal yoktur; açık hatayla reddedilir | Açık hata |
| `auto`'da hook'un değiştirdiği girdi | Sınıflandırma yeni girdiyi incelemediği için ret edebilir | Daima insan onayı ister | Daha çok onay |
| `REPL` girdisini `updatedInput` ile değiştirme | Native'te böyle bir araç yoktur | Açık hata: hook yürütülen kodu değiştiremez | Açık hata |
| `if`/`async`/`shell`/`statusMessage`/`once`/`allowedEnvVars` alanları, `prompt`/`agent` türleri | Native'de desteklenir | Açık hatayla reddedilir; sessizce yok sayılmaz | Açık hata |

## İzlenebilir uyumluluk matrisi

Her satır bir gereksinimi kaynağına, uygulama noktasına, onu doğrulayan
testine ve sonucuna bağlar. **PASS yalnızca atıf yapılan testin o davranışı
gerçekten doğruladığı (davranış veya dosya etkisiyle) satırlara verilir**;
doğrulanmamış, koşullu veya çalıştırılmamış satır PASS sayılmaz.

| Gereksinim | Kaynak | Uygulama noktası | Test | Sonuç |
| --- | --- | --- | --- | --- |
| Sıralı/paralel araç çağrısı (`Promise.all`) | v0.12 tablosu | `code-mode-runtime.mjs` (QuickJS) | `test-code-mode-runtime.mjs` (eşzamanlılık zirve sayacı `peak === 2`) | PASS — eşzamanlılık ölçülür, iki kayıt yeterli sayılmaz |
| Son ifade (ASI, template, yorumlar) | v0.12 tablosu | runtime AST tamamlama | `test-code-mode-runtime.mjs` | PASS |
| Node.js/`process`/`fetch`/import kaçış izolasyonu | v0.12 tablosu | QuickJS WASM kapsamı | `test-code-mode-runtime.mjs` | PASS |
| CPU sınırı ve bellek tavanı (64 MiB) | v0.12 tablosu | runtime sınırları | `test-code-mode-runtime.mjs` (`while(true)` ret), `test-code-mode-runtime-errors.mjs` (OOM) | PASS |
| Yürütme hata yolları (yardımcı reddi, zamanlayıcı, serileştirme, süre aşımı) | v0.12 tablosu | `code-mode-worker.mjs` | `test-code-mode-runtime-errors.mjs` | PASS |
| Kural matrisi: `deny`/`ask`/`allow` önceliği, salt-okunur küme, yol desenleri | v0.12 tablosu + izin şeması | `code-mode-rules.mjs` | `test-code-mode-rules.mjs` | PASS |
| Hook kararları, hata/zaman aşımı, `onFailure` (command/HTTP/MCP) | v0.12 tablosu | `code-mode-hooks.mjs` | `test-code-mode-hooks.mjs` | PASS |
| `updatedInput`/`additionalContext`, `policy.hooks` adaptörü, `allow` önceliği | v0.12 tablosu | `code-mode-policy.mjs` | `test-code-mode-hooks.mjs`, `test-code-mode-rules.mjs`, `test-code-mode.mjs` | PASS |
| `UserPromptSubmit` çıktı engelleme (arka plan işi) | v0.12 tablosu | `code-mode-worker.mjs` (`holdOutput` → `check.output`) | `test-code-mode-hooks.mjs` (block sözleşmesi), `test-code-mode.mjs`, `test-terminal-flow.mjs` (canary hook'a ulaşır; terminale ve modele ulaşmaz) | PASS |
| Auto: kod bloğu başına tek sınıflandırma; hata/bozuk yanıtta fail-closed | v0.12 tablosu | `code-mode-classifier.mjs` | `test-code-mode.mjs`, `test-code-mode-agent.mjs`, `test-classifier-eval.mjs` (çevrimdışı: bozuk yanıtlar, süre, karışık blok) | PASS (çevrimdışı) + PASS (canlı, 18 Kasım 2026, tam senaryo seti): gerçek endpointte (yerel proxy, anthropic/claude-opus-5-5, Docker izolasyon) 19/19 senaryo (L01–L18), 0 yanlış izin / 0 yanlış ret / 0 bozuk (rapor: `live-verification/classifier-eval-report.json`); montaj düzeltmesi sonrası `/work` mutlak yolu → allow, proje dışı mutlak yol hâlâ deny. Mekanizma model-agnostiktir: herhangi bir OpenAI-uyumlu endpoint/model iki env değişkeniyle (`CODE_MODE_CLASSIFIER_ENDPOINT`/`_MODEL`) koşar, model başına yargı kalitesi aynı `npm run test:classifier:eval` senaryo setiyle ölçülür |
| Güvenilen kullanıcı niyeti yalnızca terminalin gerçek kullanıcı turunda | Görev 6 gereksinimi | `classifyCode(…, userIntent)`; ajan yalnızca `user` turunda geçirir | `test-classifier-eval.mjs` (O10–O12) | PASS (çevrimdışı); canlı: MCP yüzeyinin niyet taşımaması doğrulandı (yalnızca statik taban uygulandı — mutlak yolun ret kararı bunun kanıtı); L16–L18 canlıda koşuldu (niyet canlı sınıflandırcıya ulaştı, secret niyeti → deny, poll_event → niyetsiz) |
| Canlı yüzey ergonomisi: `write` ara dizinleri kontrol SONRASI otomatik oluşturur, `run` sonucu `ok` taşır, sınıflandırıcı Docker `/work` montajını bilir | canlı doğrulama hataları (18 Kasım 2026) | `code-mode-worker.mjs`, `code-mode-classifier.mjs` (prompt) | `test-code-mode.mjs` (iç içe yazma + ret ağaç/dosya bırakmaz, `run.ok`), `test-classifier-eval.mjs` (O13: prompt montaj bilgisini taşır) | PASS (çevrimdışı) + canlı: iç içe yazma ve `ok` yüzeyde ölçüldü; canlı endpointte yeni promptla `/work` yolu allow, proje dışı mutlak yol hâlâ deny; app yeniden başlatması sonrası düzeltme çalışan sunucuda aktif — `/work` yolu canlı yüzeyde allow ve yürütüldü |
| Eski auto onayının yeni kodla kaybı | v0.12 tablosu | `execution-manager.mjs` (`autoEpoch`/`reviewValid`) | `test-execution-manager.mjs`, `test-code-mode.mjs` | PASS |
| Onay geri sayımı, broker UI (köken doğrulaması), tek kullanımlık nonce, hash zincirli denetim, süre/iptal, yeniden başlatma | v0.12 tablosu | `approval-broker.mjs`, `approval-client.mjs` | `test-approval.mjs` | PASS |
| Model kendi onayını veremez | v0.12 tablosu | ajan araç listesi; QuickJS brokere erişemez | `test-code-mode.mjs` (nonce modele ulaşmaz; tüketilen nonce → 409), `test-code-mode-host.mjs` (sahte izin) | PASS |
| Terminal: girdi → model → REPL → auto → gerçek dosya → yanıt | v0.12 tablosu (terminal) | `code-mode-cli.mjs`, `code-mode-agent.mjs` | `test-code-mode-agent.mjs` (ajan düzeyi), `test-terminal-flow.mjs` (tuş girdisi + dosya etkisi) | PASS |
| Arka plan sonucu → terminal satırı + model `poll_event` | v0.12 tablosu | terminal 500 ms sayacı, `agent.turn(source:'poll_event')` | `test-code-mode-agent.mjs`, `test-terminal-flow.mjs` | PASS |
| Ctrl+O transcript aynı konuşmada | v0.12 tablosu | `code-mode-transcript.mjs` | `test-code-mode-agent.mjs`, `test-terminal-flow.mjs` | PASS |
| Terminal onay reddi brokerin yerel arayüzüyle (model çağrısıyla değil) | Görev 7 gereksinimi | `code-mode-cli.mjs` onay satırı; broker `POST /decisions` (köken doğrululu) | `test-terminal-flow.mjs` (`GET /pending` → deny; dosya etkisi yok; denetimde `decision: deny`) | PASS |
| Yeniden başlatma (`--resume`) ve konuşma sürekliliği | v0.12 tablosu | `CodeModeAgent.resume` | `test-code-mode-agent.mjs` (işaret, kesinti), `test-terminal-flow.mjs` (/exit sonrası yeni TTY; eski konuşma model isteklerinde) | PASS |
| Olay kaynağı ayrımı (`user`/`poll_event`/`mcp`) | v0.12 tablosu | `execution-manager.mjs` (`job.source`) | `test-execution-manager.mjs`, `test-classifier-eval.mjs` | PASS |
| Süresi dolan onay yalnızca gerçek kullanıcı mesajıyla yeniden kurulur | v0.12 tablosu | `resetApprovalTimeouts` (yalnızca `user` turu) | `test-execution-manager.mjs` | PASS |
| Oturum izin modu + arka plan uygunluğu | v0.12 tablosu | `code-mode-agent.mjs` (`setMode`, `backgroundModes`) | `test-execution-manager.mjs`, `test-code-mode-agent.mjs` | PASS |
| Proje etkinleştirme kapısı: güvenilen ayar, fail-closed | v0.12 tablosu | `code-mode-settings.mjs` | `test-code-mode-settings.mjs` | PASS |
| Canlı terminal örneği "iki paralel okuma" | eski canlı araç | — | `test-code-mode-agent-live.mjs` | **Paralellik kanıtı değil** — yalnızca iki işlem kaydı; paralellik kanıtı ilk satırda; canlı katman koşulmadı |
| Docker OS izolasyonu (zorunlu) | v0.12 tablosu | `execution-manager.mjs` (konteyner motoru) | `test-code-mode-isolation.mjs --require-docker` (motor/build yok → FAIL); CI `docker-isolation` işi | PASS — bu makinede motor (29.9.3) mevcut, `npm run test:isolation:required` koştu; CI işinde motor/build yokluğu SKIP değil hatadır |
| Windows + Linux runtime/agent CI kapsamı | Görev 7 gereksinimi | `.github/workflows/ci.yml` (test matrisi: `windows-latest`, `ubuntu-latest`) | `npm test` her iki OS'te | **PASS (CI + bu makine)** — v0.16 (17f1b4b, CI koşusu 44382234693): `windows-latest`, `ubuntu-latest` ve `docker-isolation` işleri yeşil. Daha önce ubuntu `npm test` `test-code-mode-agent`'te düşüyordu: POSIX'te read-only dosyanın üzerine rename bloklenmediği için "kayıt hata" senaryosu koşu üstü veriyordu — hata enjeksiyonu platform-duyarlı yapıldı (Windows: dosya read-only/EPERM; POSIX: kayit dizini yazılamaz/EACCES); ayrıca PowerShell-özel komutlar (`Write-Output`/`Start-Sleep`) iki kabukta da yerleşik `echo`/`sleep`'e çevrildi, sondaki yol ayracı `path.sep` oldu ve motor-yok izolasyon onayı konağın kendi konteyner/WSL katkısına karşılaştırıldı. Linux süitü ayrıca bu makinede `node:24` konteynerinde (non-root, CI runnerıyla eşdeğer) tam koşuldu; docker gerektiren izolasyon senaryoları orada dürüstçe SKIP, ubuntu CI'ında gerçek motorla koşar |
| Desktop UI (Claude Desktop 3P yüzeyi) | v0.12 tablosu (Desktop satırı) | bu sürümde yeni UI kodu yok | canlı doğrulama (18 Kasım 2026, v0.14 ağacı): bu oturumun 3p-code-mode MCP bağlantısı | **PASS (canlı)** — yürütme ve yanıt zarfı; etkinleştirme kapısı (birebir ret mesajı + `--enable` ile açılış, çalışan sunucuya iş-işi politika/ayar okumasıyla yansıdı); docker izolasyonu (`/work` dosya etkisi hosttan bağımsız doğrulandı); canlı auto sınıflandırma (allow/deny kararları); arka plan çıktı engelleme (canary → `outputBlocked` + olaylar teslim edilmedi, temiz kontrol → tamamlandı; hook tarafı hosttan bağımsız kayda alındı); state/oturum sürekliliği (iş başına yeni işçiyle); `code_status`/`code_session_resume`. **insan onay UI döngüsü** (18 Kasım 2026, canlı: kurallı mod + `ask:[Write]` ile iş 97e264bc broker web arayüzünde insana bekledi — denetim satırı `decision: approve, channel: ui, fromUi: true`, waitedMs 31s, hash zinciri sağlam; dosya etkisi hosttan doğrulandı; ardından kullanıcı tercihiyle onay mekanizması tamamen kaldırıldı — yüzey `bypassPermissions`'a döndü (onay kuyruğu, sınıflandırıcı ve broker devre dışı; işlemler doğrudan yürür) ve sıfır-onay yazma işi 38061951 <1 sn'de tamamlandı); Ctrl+O terminal görüntüleyicisi (terminal özelliği; karşılığı olan etkileşimsiz transcript görüntüleyicisi gerçek canlı iş üzerinde koşuldu: `node code-mode-transcript.mjs job <id>` → iş kimliği/durum, yürütülen kod, yardımcı işlemler) |

## Doğrulama

Kural–araç–girdi–beklenen karar matrisi (`test-code-mode-rules.mjs`),
resmi belgeden türetilmiş ~90 satırla salt-okunur kümesini, `deny`/`ask`/
`allow` önceliğini, gitignore biçimli yol desenlerini (kök, `~`, `*`, `**`,
derinlik-kural türü) ve allow'ın bileşik/yönlendirme kapsamamasını test
eder; Docker konuk `/work` yollarının host kurallarına yansıtılması
`test-code-mode-host.mjs` ile doğrulanır.

v0.12: QuickJS escape/CPU/AST/paralellik testleri, yalnızca Code Mode aracı
sunan terminal model döngüsü, auto ve Ctrl+O stream/key kontrolleri eklendi.
Docker köprüsünde ham RPC ile izin atlama, MCP deny/ask/hook,
host'ta çıktı süzme ve iptal davranışları test edilir. İmajın SHA-256 etiketi
tüm build girdilerini kapsar; her girdi değişikliğinin etiketi değiştirdiği
ayrıca doğrulanır. CI'da ayrı Linux Docker işi `--require-docker` kullanır;
motor/build yokluğu bu işte SKIP değil hatadır. Ana test işi artık hem
Windows hem Linux'ta koşar (matrix: `windows-latest`, `ubuntu-latest`).

Hook çıktı sözleşmesi için de test eklendi: `updatedInput`/`additionalContext`
ile `allow`/`ask`/`deny` karar önceliği (command, HTTP ve MCP hook biçimleri),
hook zinciri, hata ve zaman aşımı, native `policy.hooks` adaptörü
(matcher grupları, saniye birimli `timeout`, desteklenmeyen alanların açık
reddi) ve girdi değişikliğinin `auto`/`plan`/`default` modlarındaki etkileri
`test-code-mode-hooks.mjs`, `test-code-mode-rules.mjs`,
`test-code-mode-host.mjs` ve uçtan uca `test-code-mode.mjs` ile test edilir.

Gerçek model auto doğrulaması: `npm run test:classifier:eval -- --endpoint <url>
--model <model>` (tek satır; eski `test:auto:live` adı kalır). `--offline`
katmanı `npm test` içinde çalışır: mock classifier, bozuk yanıtlarda
fail-closed (JSON dışı, boş, HTTP 500, bağlantı kopması, yanıtsız endpointte
`CODE_MODE_CLASSIFIER_TIMEOUT_MS` ile süre sınırı), kod bloğu başına tam blokla
tek inceleme (ret gelince karışık blokta zararsız yarı bile çalışmaz),
çalıştırılmayan kodun etkisizliği (dosya etkisi ve kayıtlı işlem yok) ve
güvenilen kullanıcı niyet alanını doğrular — niyet yalnızca terminalin gerçek
kullanıcı turunda taşınır; `poll_event` turları ve MCP yüzeyi taşımaz, kod
yorumları bu alanı dolduramaz. Canlı katman gerçek MCP sunucusunda (ve Docker
köprüsünde) senaryo ailesi koşar: normal proje işleri, hesaplanan yollar,
dölaylı shell işlemleri, onay atlama girişimleri, kod yorumuyla yetki iddiası,
niyet etkileşimi; yalnızca sentetik dosya ve sırlar kullanılır. Sonuç
`live-verification/classifier-eval-report.json`'dadır: yanlış izin / yanlış ret
sayıları, reddedilen kodun etkisizlik kanıtı, model kimliği (istenen model ve
isteklerde giden `model` alanı) ve kaynak hash'leri (classifier, policy,
runtime, paket). Bu bir model değerlendirmesidir; genel güvenlik iddiası
değildir. Aşağıdaki Desktop raporu v0.11 öncesindeki canlı
denemenin tarihsel kaydıdır. Mevcut sürüm ayrıca 18 Kasım 2026'da canlı
Desktop 3P yüzeyinde (bu oturumun 3p-code-mode MCP bağlantısı, v0.14
ağacı) doğrulandı: yürütme, docker /work dosya etkisi (hosttan bağımsız
kanıt), canlı auto sınıflandırma kararları, arka plan çıktı engelleme ve
state/oturum sürekliliği (matris Desktop satırı). Auto modda sınıflandırma
yüzeyde ayrıca insan onay UI döngüsü koşuldu: kurallı mod + `ask:[Write]`
ile arka plan işi broker web arayüzünde insana bekledi, insan kararıyla
(`channel: ui, fromUi: true`, hash zincirli denetim) tamamlandı ve dosya
etkisi hosttan doğrulandı (iş 97e264bc); ardından kullanıcı tercihiyle
onay mekanizması tamamen kaldırıldı ve yüzey `bypassPermissions`'a döndürüldü:
onay kuyruğu, sınıflandırıcı ve broker bu yüzeyde devre dışı, işlemler doğrudan yürür.
Canlı sınıflandırıcı senaryo setinin tamamı
(L01–L18) da 18 Kasım 2026'da yerel endpointte (anthropic/claude-opus-5-5, Docker
izolasyon) koşuldu: 19/19 senaryo, 0 yanlış izin / yanlış ret / bozuk; canlı yüzey
ergonomi düzeltmeleri app yeniden başlatması sonrası çalışan sunucuda aktif
(``/work`` yolları yüzeyde allow ve yürütüldü). Canlı katman model-agnostik
mekanizmayla (herhangi bir OpenAI-uyumlu endpoint/model) koşulmuştur; kanıt
yerel proxy modeliyle (anthropic/claude-opus-5-5) alınmıştır, başka bir modele
geçiş kod/ayar değişikliği değil iki env değişkenidir ve modelin yargı kalitesi
aynı değerleme setiyle o modelde ölçülür — başka modelle koşularak eşdeğerlik
iddia edilmez.

`npm test`: gerçek stdio MCP istemcisi/sunucusu, kontrollü yerel sınıflandırıcı,
HTTP hook sunucusu ve MCP hook aracıyla bütünleşim testleri. Docker motoru
mevcutsa `test-code-mode-isolation.mjs` konteyner sınırını doğrular
(proje dışı dosyalar, host loopback erişilemezliği, Linux konuk, broker
onayı ve iptal temizliği); motor yoksa SKIP yazar ve "geçti" sayılmaz. Gizli çıktı içeren
arka plan işinde sonuç ve olayların engellenmesi, state'in kaydedilmemesi,
eşzamanlı auto işlerindeki onay ve süre aşımı dosya etkileriyle kontrol edilir.
Terminal görünümü gerçek stream/key olaylarıyla açılır, Ctrl+O ve Enter
kontrolleri çalıştırılır; kapanışta raw mode ve dinleyiciler temizlenir.
Uçtan uca terminal akışı ayrıca `test-terminal-flow.mjs` ile test edilir:
girdi → model → REPL → auto sınıflandırma → gerçek dosya etkisi → yanıt,
arka plan sonucu ve `poll_event`, Ctrl+O, onay reddi — karar brokerin
yerel HTTP arayüzünden (`GET /pending`, köken doğrulamalı `POST /decisions`),
model çağrısıyla değil —, `UserPromptSubmit` çıktı engelleme (canary hook'a
ulaşır, terminale ve modele ulaşmaz) ve `--resume` ile taze TTY'de yeniden
başlatma + konuşma sürekliliği.
Proje etkinleştirme — güvenilen kullanıcı ayarı, fail-closed bozuk dosya,
proje dosyasının kendiliğinden açamaması, kapalı/bozuk durumda gerekçeli
yürütme ve resume redleri, mod kaydı olarak devam — `test-code-mode-settings.mjs`
ile test edilir.

Yürütme hata yolları — gözlenmemiş yardımcı reddi, zamanlayıcı hatası,
serileştirilemeyen sonuç, bellek sınırı aşımı ve bekleyen yardımcı sırasında
süre aşımı — ayrı süreçlerde `test-code-mode-runtime-errors.mjs` ile test
edilir: her senaryo kendi `node` sürecinde koşar, çünkü eski davranış ya
süreci çökertiyor (unhandled rejection) ya asılı kalıyordu; 8 saniyede
bitmeyen senaryo iptal edilir ve başarısız sayılır.

## Tarihsel Desktop doğrulaması (18 Kasım 2026) — mevcut sürümün kanıtı değil

18 Kasım 2026'da gerçek Claude Desktop 3P yüzeyinde **tamamlanan** canlı
doğrulama tüm kontrolleri geçmiş olarak
(`live-verification/report.json`, `passed: true`) **o anki sürüm için**
kayıt altına alındı: yürütme, oturum devamı, arka plan ilerlemesi, ret
etkisizliği, tutulan çıktı, iptal, denetim zinciri ve — broker onayıyla —
`interactiveApproval`. Eski sürümdeki tek kalan hata, istemci form onayı
(`elicitation.form`) beklentisinden kaynaklanıyordu;
`client-capabilities.jsonl` logu canlı istemcinin (`claude-ai` ve
`local-agent-mode-3p-code-mode`) `elicitation` bildirmediğini
kanıtlıyor. Onay o doğrulamada yerel onay brokerinin web arayüzünde
verildi: denetim kaydında karar `channel: 'ui'` ve brokerca doğrulanmış
`fromUi: true` ile görüldü. `verify-results.mjs` yalnızca dosya varlığına
değil, brokerin hash zincirli `approvals.jsonl` kaydına bakar
(`jobId`/işlem/dosya eşleşmesi, işin ömrü içinde karar, `channel: 'ui'`,
`fromUi: true`, nonce'un tek tüketimi).

Bu rapor bir **tarihsel kayıttır**: o zamandan bu yana QuickJS WASM
runtime'ı, terminal model döngüsü, broker tabanlı onay ve proje
etkinleştirme kapısı değiştiğinden Desktop UI yeniden doğrulanmadı. Rapor
mevcut sürümün kanıtı olarak sunulamaz; izlenebilir matriste Desktop UI
satırı "Doğrulanmadı" olarak tutulur. Aşağıdaki adımlar yeni bir sürümde
yeniden doğrulama işlemidir:

Yeniden doğrulama işlemi:

1. `install-code-mode.ps1 -ConfigPath <mevcut-config>` ile kurun, uygulamayı
   yeniden başlatın ve `3p-code-mode` bağlantısını kontrol edin.
2. Canlı denetim politikasını yazın: kökteki varsayılan
   `code-mode-policy.json` boş `{}` gelir; hook yolları makineye özel olduğu
   için her kullanıcının kendi dosyasını oluşturması gerekir. Aşağıdaki komut
   yolları o makinede üretir ve BOM'suz UTF-8 yazar:

   ```powershell
   $node = (Get-Command node).Source
   $hook = (Resolve-Path 'live-verification\policy-hook.mjs').Path
   $policy = @{ preToolUse = @(@{ tool = 'Write'; command = $node; args = @($hook) }); userPromptSubmit = @(@{ command = $node; args = @($hook) }) }
   [System.IO.File]::WriteAllText((Join-Path (Get-Location) 'code-mode-policy.json'), ($policy | ConvertTo-Json -Depth 5))
   ```
3. Boş bir deneme klasöründe modele, `code_execute` ile dosya oluşturmasını,
   okumasını, tek metin değişikliği yapmasını ve sonucu döndürmesini söyleyin.
4. Güvenilen policy dosyasına `ask: ["Write"]` ekleyin; `code_status` içindeki
   bağlantıyı tarayıcıda açıp bir kez reddedip bir kez kabul edin; diskteki
   etkileri karşılaştırın. Kararın denetim kaydında `fromUi: true` olarak
   göründüğünü `live-verification/verify-results.mjs` ile doğrulayın.
5. `userPromptSubmit` hook'u ile deneme çıktısını engelleyin. `code_start` ve
   `code_status` üzerinden yalnızca engelleme nedeni görünmelidir.
6. Dönen iş kimliğiyle yerel transcript'i `--interactive` açın; Ctrl+O ve
   Enter ile kodu görüntüleyin, `Q` ile çıkın. Aynı veri dizini ve izin moduyla
   oturumu yeniden açın.
