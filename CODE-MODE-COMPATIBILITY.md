# Code Mode karşılaştırması

18 Kasım 2026 tarihinde [Code Mode belgesi](https://code.claude.com/docs/en/code-mode)
ve [hook referansı](https://code.claude.com/docs/en/hooks) temel alınmıştır.
Bu proje, 3P/Desktop için bağımsız bir MCP sunucusudur. Claude Code ürününün
kendi özellik bayrağını, hesap/model uygunluğunu veya arayüzünü uygulamaz.

## v0.12 farkı

[Terminal oturumu](README-terminal.md) modelin araç listesini denetler:
yalnızca `REPL`, durum ve iptal vardır. Ctrl+O ve daraltılmış Code satırları
aynı konuşma terminalinde çalışır; arka plan sonucu modele olay olarak döner.
Desktop MCP desteği korunur; Desktop'ın yerleşik araçlarını değiştiremez.

JavaScript artık QuickJS WASM motorunda yürür; Node.js/prototype üzerinden
host erişimi, dinamik Node import'u, doğrudan fetch ve protokol taklidi yoktur.
Son ifade Acorn AST ile alınır. Auto kurulumu varsayılandır; ayrı classifier
verilmezse yapılandırılmış model kullanılır; model yoksa kurulum durur.
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
| Transcript ve düzenleme önizlemesi | MCP metin blokları; yeni terminalde aynı konuşmada Ctrl+O ve daraltılmış Code satırları |
| Claude Code Ctrl+O konuşma arayüzü | Desktop'ın kendi UI'ı değişmez; bu projenin terminali aynı oturumda karşılığını sağlar |
| Yerleşik araç izinleri / OS sandbox | QuickJS doğrudan Node erişimini kapatır; izin verilen kabuk için Docker ek OS sınırıdır ([SECURITY.md](SECURITY.md)) |
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
motor/build yokluğu bu işte SKIP değil hatadır.

Hook çıktı sözleşmesi için de test eklendi: `updatedInput`/`additionalContext`
ile `allow`/`ask`/`deny` karar önceliği (command, HTTP ve MCP hook biçimleri),
hook zinciri, hata ve zaman aşımı, native `policy.hooks` adaptörü
(matcher grupları, saniye birimli `timeout`, desteklenmeyen alanların açık
reddi) ve girdi değişikliğinin `auto`/`plan`/`default` modlarındaki etkileri
`test-code-mode-hooks.mjs`, `test-code-mode-rules.mjs`,
`test-code-mode-host.mjs` ve uçtan uca `test-code-mode.mjs` ile test edilir.

Gerçek model auto doğrulaması: `npm run test:auto:live -- --endpoint <url>
--model <model>` (tek satır). Sonuç `live-verification/auto-report.json`'dadır;
zararsız yazmaya izin ve sentetik kimlik bilgisi çıkarmaya ret, gerçek MCP
sunucusu ve Docker üzerinden doğrulanır. Bu sınırlı örnekler bir genel model
güvenliği iddiası değildir. Aşağıdaki Desktop raporu v0.11 öncesindeki canlı
denemenin kaydıdır; yeni testler onun yerine Desktop UI testi sayılmaz.

`npm test`: gerçek stdio MCP istemcisi/sunucusu, kontrollü yerel sınıflandırıcı,
HTTP hook sunucusu ve MCP hook aracıyla bütünleşim testleri. Docker motoru
mevcutsa `test-code-mode-isolation.mjs` konteyner sınırını doğrular
(proje dışı dosyalar, host loopback erişilemezliği, Linux konuk, broker
onayı ve iptal temizliği); motor yoksa SKIP yazar ve "geçti" sayılmaz. Gizli çıktı içeren
arka plan işinde sonuç ve olayların engellenmesi, state'in kaydedilmemesi,
eşzamanlı auto işlerindeki onay ve süre aşımı dosya etkileriyle kontrol edilir.
Terminal görünümü gerçek stream/key olaylarıyla açılır, Ctrl+O ve Enter
kontrolleri çalıştırılır; kapanışta raw mode ve dinleyiciler temizlenir.

Canlı Desktop doğrulaması 18 Kasım 2026'da gerçek Claude Desktop 3P
yüzeyinde **tamamlandı ve tüm kontroller geçti**
(`live-verification/report.json`, `passed: true`): yürütme, oturum devamı,
arka plan ilerlemesi, ret etkisizliği, tutulan çıktı, iptal, denetim zinciri
ve — broker onayıyla — `interactiveApproval`. Eski sürümdeki tek kalan
hata, istemci form onayı (`elicitation.form`) beklentisinden kaynaklanıyordu;
`client-capabilities.jsonl` logu canlı istemcinin (`claude-ai` ve
`local-agent-mode-3p-code-mode`) `elicitation` bildirmediğini
kanıtlıyor. Onay artık yerel onay brokerinin web arayüzünde veriliyor:
denetim kaydında karar `channel: 'ui'` ve brokerca doğrulanmış
`fromUi: true` ile görüldü. `verify-results.mjs` yalnızca dosya varlığına
değil, brokerin hash zincirli `approvals.jsonl` kaydına bakar
(`jobId`/işlem/dosya eşleşmesi, işin ömrü içinde karar, `channel: 'ui'`,
`fromUi: true`, nonce'un tek tüketimi).

Gelecek sürüm/istemci değişikliklerinde yeniden doğrulama (aynı adımlar):

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
