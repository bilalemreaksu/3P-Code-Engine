# 3P Code Mode v0.12

Claude Desktop 3P için deneysel MCP kod yürütme sunucusu ve [tam denetimli terminal oturumu](README-terminal.md). Model, tek çağrıda JavaScript yazar; kod asenkron işlemleri sırayla veya `Promise.all` ile paralel çalıştırabilir, sonuçları süzebilir, dosyaları değiştirebilir ve komut/test çalıştırabilir. Anthropic Code Mode'un ayrı bir uygulamasıdır; native Claude Code istemcisi değildir.

## Önemli yetki sınırı

Modelin JavaScript'i QuickJS WebAssembly motorunda çalışır: `process`, `require`, Node.js import'ları ve doğrudan `fetch` yoktur. Dosya, kabuk ve MCP erişimi denetlenen yardımcılarla yapılır. İzin verilen kabuk programları Docker olmadan host hesabının yetkilerine sahiptir; Docker ek OS sınırı sağlar. `cwd` başlangıç dizinidir. Ayrıntılar [SECURITY.md](SECURITY.md) dosyasındadır.

## Desktop yapılandırması

Bu kurulum scripti Windows içindir; her kullanıcı kendi hesabında çalıştırır. Node.js 24 veya üzeri ve npm PATH üzerinde bulunmalıdır. Gerekli npm paketleri eksikse script `npm ci` çalıştırır (internet erişimi gerekir). Claude Desktop veya 3P yapılandırması önceden mevcut olmalıdır. Script kullanıcı adı, sabit proje yolu veya sabit Node kurulum dizini kullanmaz.

PowerShell'i projenin çıkarıldığı klasörde aç ve çalıştır:

```powershell
.\install-code-mode.ps1 -ModelEndpoint 'http://127.0.0.1:9931/v1' -ModelName 'model-adi'
```

Script mevcut `%LOCALAPPDATA%\Claude-3p\claude_desktop_config.json` ve `%APPDATA%\Claude\claude_desktop_config.json` dosyalarını arar. İkisi de mevcutsa yanlış profili seçmemek için `-ConfigPath` ister. Özel Node yolu için `-NodePath` kullanılabilir. Bir model sunucusu ve modeli belirlemek için isteğe bağlı:

```powershell
.\install-code-mode.ps1 -ConfigPath "$env:LOCALAPPDATA\Claude-3p\claude_desktop_config.json" `
  -ModelEndpoint 'http://127.0.0.1:9931/v1' -ModelName 'model-adi'
```

Mevcut yapılandırma yedeklenir; eski `3p-code-engine-reader` kaydı kaldırılır. Diğer MCP kayıtları ve daha önce tanımlanmış `3p-code-mode` ortam değişkenleri korunur. Kaydedilen Node ve proje yolları kurulum anındaki mutlak yollardır; proje taşınırsa scripti yeni yerinden yeniden çalıştırın. Desktop'ı yeniden başlatıp araç listesinde `code_execute` bulunduğunu doğrulayın. Bu işlemler her Desktop/3P sürümü veya her modelle doğrulanmış değildir.

## Etkinleştirme (projeye özel, güvenilen kullanıcı ayarı)

Code Mode'un bir projede **etkin** olması, `permissionMode` seçiminden
ayırt edilen ayrı bir ayardır: `auto` (veya başka bir mod) seçmek özelliği
tek başına açmaz. Her proje, kullanıcı düzeyinde veri dizinindeki
`settings.json` dosyasında açıkça etkinleştirilir; proje dizinindeki hiçbir
dosya Code Mode'u kendiliğinden açamaz. Dosya yoksa özellik her yerde
kapalıdır (fail-closed başlangıç durumu). Etkinleştiren açık eylem
terminal komutudur (`node code-mode-cli.mjs --enable --cwd <proje>`, kapatmak
için `--disable`) ya da o güvenilen dosyanın elle düzenlenmesidir; kurulum
scripti etkinleştirme yapmaz. Bozuk bir dosya (geçersiz JSON, tanınmayan
sürüm, hatalı `enabled` alanı) yürütmeyi ve resume'u açık hatayla reddeder:
dosyayı düzeltin veya silin, sessiz sıfırlama yapılmaz.

Bu yüzeydeki etkisi: `code_execute`/`code_start` ve `code_session_resume`,
etkinleştirilmemiş bir projede `Code Mode is not enabled for <dizin>`
gerekçesiyle reddedilir; Anthropic hesap veya model uygunluğu kontrolleri
taklit edilmez.

## API

### Araç çağrısı kuralları ve PreToolUse

Varsayılan politika kurulum dizinindeki `code-mode-policy.json` dosyasıdır
(başlangıçta `{}`). Başka bir güvenilen dosya için MCP sunucusunun ortamında
`CODE_MODE_POLICY_PATH` değerini mutlak yola ayarlayın. Docker modunda sunucu, diğer modda worker yapılandırmayı
her yürütmenin başında okur; politika değişikliği için Desktop'ı yeniden
başlatmak gerekmez. Eksik veya geçersiz politika yürütmeyi engeller. Örnek:

```json
{
  "deny": ["Write"],
  "ask": ["Edit"],
  "preToolUse": [
    { "tool": "Bash", "command": "C:/Program Files/nodejs/node.exe", "args": ["C:/hooks/check-command.mjs"] }
  ]
}
```

Kurallar araç adına, `mcp__<sunucu>__<araç>` adının (yalnızca araç
bölümünde) `*` desenine veya komut/dosya kapsamına eşleşir. Kullanılabilir
adlar `REPL`, `Read`, `Write`, `Edit`, `Bash`, `McpListTools` ve
`mcp__<sunucu>__<araç>` biçiminde MCP araç adlarıdır.

Komut kapsamı (`Bash(...)`) komut metnine eşleşir; `*` her metni temsil
eder, `:*` eki ` *` ile eşdeğerdir, sondaki tek ` *` çıplak komutu da
kapsar (`Bash(npm run *)` → `npm run`), başka yerde `:` yazı olarak kalır.
Ayrıştırıcı tırnakları gözetir; ayıracılar `;` `&` `&&` `|` `|&` ve satır
sonudur:

- `deny`/`ask`: birleşik komutta **herhangi** bir alt komut eşleşirse
  uygulanır.
- `allow`: **tüm** komutu kapsaması gerekir — çözümlenebilen, yer
  değiştirme (substitution), yönlendirme veya parantez içermeyen ve her
  bölümü ya desenle eşleşen ya da aşağıdaki salt-okunur kümede olan
  komutlar. Bileşik, yönlendirilmiş veya çözümlenemeyen komut `allow`
  ile asla onaylanmaz (kötüye gidiş: istenir).

Salt-okunur komutlar hiçbir modda onay istemez: `ls`, `cat`, `echo`, `pwd`,
`head`, `tail`, `grep`, `find`, `wc`, `which`, `diff`, `stat`, `du`, çalışma
dizininde kalan `cd` ve salt-okunur `git` biçimleri; PowerShell
komutları/alias'ları (`Get-ChildItem`, `gci`, `Get-Content`, `Test-Path`,
`Select-Object` …) aynı gramerle değerlendirilir. Belgelenmiş istisnalar
onay ister: yazma/yürütme bayraklı komutlarda (`find`, `sort`, `sed`,
`git`) tırnaksız glob; çalışma dışına `cd`; başka dizine `cd` sonrası
`git`; `-a` dışı `which` bayrağı; 10.000 karakter üstü komut; çözümlenemeyen
sözdizimi. Salt-okunur kümesi ve komut eşleştirme metni bir kabuk
ağacını değil metni denetler; güvenilir bir sınır değildir, Docker sınırı
bunun için vardır.

Dosya kapsamları gitignore biçimlidir: `//yol` mutlak (Windows `C:\…` →
`/c/…`), `~/yol` ev dizini, `/yol` çalışma dizinine bağlı, çıplak `ad` derinlik
gözetmeden; `*` tek bölüm, `**` bölüm sınırı aşar. Tek dizin
bölümünde relative desenler (`src/**`) `allow` için yalnızca çalışma
dizini altında, `deny`/`ask` için çalışma dizini altında herhangi bir
derinlikte eşleşir; `/src/**` tüm listelerde bağlıdır. Native şemada
`Edit(path)` kuralları **Write aracını da kapsar**; `Write(path)` ise bu
projenin açık belgeli genişlemesidir ve yalnızca Write aracına uygulanır
(native şemada yol parametreli Write kuralları kabul edilip hiç
eşleşmez). Kuruluma kabul edilen `allow` kuralları yalnızca araç adı veya
`mcp__<sunucu>__` öneki altındaki `*` kullanabilir; `allow: ["*"]`
yazılmaz. Negasyon (`!`) desenleri yeniden yorumlanmadan kurulumda
reddedilir.

Öncelik her çağrıda: `deny` → hook'lar → hook `updatedInput` döndürürse
`deny` ve `plan` kısıtının değiştirilmiş girdiye karşı yeniden
denetlenmesi → `ask` (allow geçersiz kılamaz) → `allow` (modun onayı
atlar) → modun kendi onayı. `deny` tüm modlarda, `bypassPermissions` dahil,
özgün ve değiştirilmiş girdinin her ikisine karşı engeller. `ask` ve mod
onayı yerel insan onay brokerinin web arayüzünde ister: iş, insan karar
verene kadar bekler. Ön plan ve arka plan çağrıları aynı broker üzerinden onaylanır;
model, `code_status` ile bekleyen onayı yalnızca **görebilir** (işlem,
dosya, süre ve insanın açacağı bağlantı), **karar veremez**: hiçbir MCP aracı
onay taşıyamaz, karar için brokerin kendi sunduğu sayfanın kökeni
doğrulanır. Yanıt olumsuzsa veya iki dakikalık süre dolarsa çağrı engellenir.

Hook bir araç adına veya `*` ile tüm denetlenen araçlara bağlanabilir.
Standart girdiden `hook_event_name`, `tool_name`, `tool_input`, `cwd`
ve varsa `session_id` alanlarını içeren JSON alır. Hook'lar tanımlandıkları
sırada çalışır. `type` varsayılan olarak `command` değerindedir. Komut yolu
mutlak olmalıdır; `args` ayrı argümanlardır, kabuk komut metni değildir.

- `timeoutMs`: varsayılan 5000, 100–600000 arası. Hook yanıtı en fazla 64 KiB.
- Çıkış kodu 0: boş çıktı veya JSON karar okunur. Kod 2: her zaman engelle.
- Diğer normal çıkış kodları: devam et; `onFailure: "block"` ile engelle.
- Başlatma hatası, zaman aşımı, 126/127/>128 çıkışı, geçersiz JSON ve HTTP/MCP
  hatası: varsayılan engelle; `onFailure: "continue"` ile devam et.
- `{"decision":"block","reason":"..."}` her zaman engeller.
  `hookSpecificOutput.permissionDecision` için `allow`, `deny` ve `ask`
  desteklenir. `allow` açık `deny` kurallarını geçersiz kılmaz.
- `hookSpecificOutput.updatedInput` yalnızca `PreToolUse`'ta desteklenir ve
  girdi nesnesinin **tamamını** değiştirir: çalışan girdi, kuralların
  denetlediği girdi, onay önizlemesinde görünen girdi ve olay kaydına
  düşen girdi aynı nesnedir. Zincirde sonraki hook, öncekinin
  `updatedInput` çıktısını görür. `REPL` kodu hook ile değiştirilemez
  (açık hata).
- `hookSpecificOutput.additionalContext` (dize veya dize dizisi; toplam en
  fazla 64 KiB) sonuçla modele iletilir; `permissionDecisionReason` onay
  gerekçesi olarak gösterilir.
- Hook `allow`'ı yalnızca modun onayını atlar: `deny`/`ask` kuralları,
  `plan` kısıtı ve auto sınıflandırmayı geçersiz kılamaz. `auto` modunda
  hook tarafından değiştirilen girdi, sınıflandırmanın incelediği girdi
  olmadığı için insan onayı ister.

### Çıktı denetimi ve diğer hook türleri

`userPromptSubmit`, arka plan kodunun çıktısını modelden önce denetler.
Hook girdisi `hook_event_name: "UserPromptSubmit"`, `source: "poll_event"`,
`cwd`, `session_id` ve JSON metni olan `prompt` alanlarını içerir. `prompt`,
sonuç, günlükler, yardımcı işlemler, state ve bekletilen ilerleme olaylarını
kapsar. Bu hook'lar etkinse çıktı tamamlanana kadar bekletilir; onaydan önce
`code_status` üzerinden günlük veya komut çıktısı sızdırılmaz. Engellemede
`outputBlocked: true` ve hook nedeni döner; çıktı/state kaydedilmez. Dosyalara
uygulanmış değişiklikler geri alınmaz. Ön plandaki `code_execute` bu çıktı
olayını üretmez.

```json
{
  "preToolUse": [
    { "tool": "Bash", "type": "http", "url": "http://127.0.0.1:8090/pre-tool", "timeoutMs": 5000, "onFailure": "block" }
  ],
  "userPromptSubmit": [
    { "type": "command", "command": "C:/Program Files/nodejs/node.exe", "args": ["C:/hooks/check-output.mjs"] },
    { "type": "mcp_tool", "server": "policy", "mcpTool": "check_output" }
  ]
}
```

HTTP hook girdiyi POST JSON olarak alır; isteğe bağlı `headers` nesnesi
kullanılabilir. Başarılı yanıt boş olabilir veya JSON karar içerebilir;
yönlendirmeler izlenmez. MCP hook, yapılandırılmış stdio sunucusunda `mcpTool`
aracını çağırır. İsteğe bağlı `arguments` nesnesine olay alanları eklenir;
olay alanları geçersiz kılınamaz. Araç `structuredContent` veya JSON metni
döndürür. Bu hook çağrıları güvenilen politika yapılandırmasıdır; kendileri
yeniden `PreToolUse` tetikleyip sonsuz döngüye girmez.

Native Claude Code hook yapılandırması için uyumluluk adaptörü: politika
alanı `hooks: { "PreToolUse": [...], "UserPromptSubmit": [...] }` olarak da
verilebilir (düz `preToolUse`/`userPromptSubmit` alanlarıyla aynı anda
kullanılamaz); gruplar `matcher` + `hooks` dizisi taşır. `matcher` yalnızca
tam araç adlarını (`|` ile ayrılmış) veya `*` kabul eder; regex değildir.
Native `timeout` **saniye** birimindedir ve `timeoutMs` (milisaniye) ile
aynı anda verilemez. Native MCP `tool`/`input` alanları `mcpTool`/
`arguments`'a çevrilir. Desteklenmeyen alanlar ve türler (`if`, `async`,
`shell`, `statusMessage`, `once`, `allowedEnvVars`; `prompt`/`agent` türleri)
ile desteklenmeyen çıktı alanları (`systemMessage`, `terminalSequence`) ve
`defer` kararı sessizce yok sayılmaz — açık hatayla reddedilir.

### İzin modları

İzin modu, Code Mode'un o projede etkin olup olmadığını belirlemez;
etkinleştirme ayrı bir güvenilen kullanıcı ayarıdır (yukarıdaki bölüm).

`CODE_MODE_PERMISSION_MODE` sunucu ortamından ayarlanır. Çağrı yapan model
bu ayarı araç parametresiyle değiştiremez; bu yüzeyde mod çalışma anında
değişmez ve hiçbir araç mod parametresi kabul etmez. Burada başlatılan her
yürütme `source: 'mcp'` kaydeder: Desktop gerçek kullanıcı olayını bildiremez
(kullanıcının gerçek eylemini modelin araç çağrısından ayırt edemez), bu yüzden
süresi dolan onaylar bu yüzeyde yeniden kurulmaz ve iş bitene kadar ret olarak
kalır. Kurulum scripti varsayılan olarak
`auto` seçer; classifier verilmezse `ModelEndpoint`/`ModelName` veya kayıtlı
model ayarları kullanılır. Endpoint/model yoksa yapılandırma yazılmaz.
Doğrudan başlatılan MCP sunucusunda eski `rules` varsayılanı korunur.

| Mod | Yardımcı çağrılara etkisi |
| --- | --- |
| `rules` (varsayılan) | Yapılandırılmış `deny`, `ask` ve hook'lar uygulanır; `allow` kuralları sessizce eşleşir. |
| `default` | Yazma, düzenleme, kabuk ve dış MCP işlemleri onay ister; salt-okunur okumalar ve belgelenen salt-okunur kabut komutları onay istemez. |
| `acceptEdits` | Dosya yazma ve düzenleme için modun ek onayı atlanır. Kabuk ve dış MCP işlemleri onay ister. |
| `plan` | Yalnızca `Read`, `REPL` ve salt-okunur kabut komutları çalışabilir; kalan her şey reddedilir (hook ve `allow` kısıtı kaldıramaz). |
| `auto` | JavaScript'in tamamı çalıştırılmadan önce bir kez sınıflandırılır. Yardımcı araç kuralları ve hook'lar uygulanır; `allow` kuralıyla çözülen yardımcılar sınıflandırmayı beklemez. |
| `bypassPermissions` | Mod ek onay istemez. Açık `deny`, `ask` ve hook'lar uygulanır. |

`auto` için `CODE_MODE_CLASSIFIER_ENDPOINT` ve `CODE_MODE_CLASSIFIER_MODEL`
zorunludur. İsteğe bağlı `CODE_MODE_CLASSIFIER_API_KEY` ve
`CODE_MODE_CLASSIFIER_TIMEOUT_MS` (varsayılan 30000) kullanılabilir.
Sunucu JavaScript'i ve başlangıç dizinini yapılandırılan OpenAI uyumlu
uç noktaya gönderir. Sınıflandırma, kod bloğu başına tam olarak bir kez ve
TAM BLOKLA yapılır (araç başına parçalara bölünmez). Sınıflandırmaya giren
yegâne girdiler çalışma dizini, kod ve — yalnızca terminalde — güvenilen
kullanıcı niyeti (`userIntent`): insanın o turda yazdığı gerçek talep, ayrı bir
veri alanıyla taşınır. `poll_event` turları (sentetik arka plan tamamlanma
mesajları) ve MCP yüzeyi (gerçek kullanıcı olayı ayırt edilemeyen yüzey) niyet
taşımaz; kod yorumları ve araç çıktıları bu alanı dolduramaz. Niyet asla
kimlik bilgisi erişimi, dışa aktarma, yıkıcı/proje dışı işlem veya onay
atlama yetkilendiremez. Yalnızca `{"decision":"allow"}` sonucu yürütmeye izin
verir. Hata, bozuk ya da belirsiz sonuç çağrıyı engeller (fail-closed).

Gerçek model doğrulaması ve değerlendirme paketi:

```powershell
npm run test:classifier:eval -- --endpoint http://127.0.0.1:9931/v1 --model model-adi
npm run test:classifier:eval -- --offline
.\install-code-mode.ps1 -Isolation docker -PermissionMode auto `
  -ClassifierEndpoint http://127.0.0.1:9931/v1 -ClassifierModel model-adi
```

Paket (`test-classifier-eval.mjs`) iki katmanda değerlendirir. Offline
katman (`npm test` içinde, `--offline`; gerçek model gerektirmez) mock
classifier'la tesisatı deterministik doğrular: bozuk yanıtlarda fail-closed
ret (JSON dışı metin, boş içerik, HTTP 500, bağlantı kopması, yanıtsız
endpointte süre sınırı), kod bloğu başına inceleme değişmezliği (tek istekte
tam blok; ret gelince karışık blokta zararsız yarı bile çalışmaz),
çalıştırılmayan kodun etkisizliği (dosya etkisi yok, kayıtlı işlemin yok) ve
niyetin yalnızca gerçek kullanıcı turunda taşınması. Canlı katman (ör. Qwen
OpenAI-uyumlu endpoint) senaryo ailelerinde modelin yargı kalitesini ölçer:
normal proje işleri, hesaplanan yollar, dolaylı shell işlemleri, onay atlama
girişimleri, kod yorumuyla yetki iddiası ve niyet etkileşimi; yalnızca
sentetik dosya ve sırlar kullanılır. `test:auto:live` eski ad olarak kalır.

`live-verification/classifier-eval-report.json` yanlış izin / yanlış ret
sayılarını, reddedilen kodun etkisizlik kanıtını, model kimliğini (istenen
model ile isteklerde gerçekten giden model alanı) ve kaynak hash'lerini
(sınıflandırıcı, policy, runtime, paket) kaydeder. Yanlış izin veya bozuk
yanıt canlı katmanı başarısız sayar; yanlış retler sayı olarak raporlanır.
Bu senaryo aileleri bir model değerlendirmesidir, genel güvenlik iddiası
değildir: sınıflandırıcıya yardımcı API'ler ve normal proje işlerinin
kapsamı sunucu tarafından açıklanır; kod içindeki yorumlar ek yetki veremez.

Aynı sunucuda yeni bir auto kod sınıflandırması başladığında, önceki çalışan
auto işlerinin sınıflandırıcı onayı geçersizleşir. Sonraki değişiklik yapan
yardımcı çağrılar tek seferlik insan onayı ister; salt okuma devam eder.
Arka plan işi onay beklerken `code_status` sorgulanmalıdır; yanıt bekleyen
onaylar `pendingApprovals` alanında işlem, dosya, süre ve insanın açacağı
bağlantıyla görünür. `code_status` salt okunur bir araçtır: onayı yalnızca
gözlemler, karar veremez. Yanıt için iki dakika vardır; süre dolarsa sonraki
onay isteyen çağrılar da reddedilir. Yeni `code_execute`/`code_start` isteği
bu süre aşımı kilidini kaldırır. `CODE_MODE_APPROVAL_TIMEOUT_MS` güvenilen
sunucu ortamından 100–120000 ms arasında ayarlanabilir.

### İnsan onayı (broker)

Onaylar, MCP istemcisinden bağımsız çalışan yerel bir onay brokeri
(`approval-broker.mjs`) ile verilir. İlk onay gerekince broker, veri dizininde
`node approval-broker.mjs --data-dir <veri dizini>` olarak başlatılır;
yalnızca 127.0.0.1'de rastgele bir portta dinler ve kendi 128-bit token'ını
kullanır. İnsan, `code_status` içindeki bağlantıyı tarayıcıda açar; sayfa
bekleyen işlemleri, dosya/komut önizlemesini ve geri sayımı gösterir,
kabul/red kararı yalnızca o sayfadan (broker kökeni doğrulanır) alınır.

- Her onay `jobId`, işlem adı, dosya yolu/komut, mutlak süre sınırı ve 256-bit
  tek kullanımlık nonce ile ilişkilidir; ikinci karar `409` ile reddedilir.
- Kararlar hash zincirli `approvals.jsonl` denetim dosyasına yazılır
  (`request`, `decision`, `timeout`, `cancelled`, `lost`, `duplicate-decision`,
  `rejected-decision`).
- Bekleyen onaylar yalnızca broker belleğindedir: broker durursa `lost`
  olarak denetirlenir ve çalışan iş karar kaybı ile biter.
- Sunucu, istemcinin bildirdiği yetenekleri `client-capabilities.jsonl`
  dosyasına ve izolasyon durumunu `isolation.json` dosyasına yazar.
- QuickJS doğrudan Node.js erişimini kapatır; izin verilen kabuk
  programlarının yetkileri ve Docker sınırı: [SECURITY.md](SECURITY.md).

`review_changes`, `review_and_fix` ve `reviewAfter` kendi kabuk/model
akışlarını kullanır; yalnızca `rules` veya `bypassPermissions` modlarında
kullanılabilir. Code Mode yardımcı izinlerinin bunları denetlediği varsayılmamalıdır.

### OS izolasyonu (`CODE_MODE_ISOLATION=docker`)

QuickJS doğrudan Node.js erişimini kapatır. İzin verilen kabuk programlarının
host dosyalarına erişimini ayrıca sınırlamak için worker OS düzeyinde izole edilebilir.
`CODE_MODE_ISOLATION=docker` ile her iş tek kullanımlık bir Docker
konteynerinde koşar: işin projesi `/work` olarak bağlanır, host
dosyaları görünmez, host'un 127.0.0.1 arayüzü — yani onay brokeri —
konteynerden erişilemez, konuk kabuk Linux'tur. Tehdit modeli ve kalan
riskler [SECURITY.md](SECURITY.md) dosyasındaki "Sert sınır" bölümünde
belgelenmiştir.

Gereksinim: **Linux konteynerleri çalıştırabilen** bir Docker motoru
(Docker Desktop'ın WSL2 backend'i). Saf Windows container engine yeterli
değildir: imaj Linux'tur (`node:24-slim`) ve worker Linux konukta koşar;
motor imaji derleyemezse izolasyon testi hata detayıyla SKIP yazar ve
"geçti" sayılmaz.
Kurulum:

```powershell
.\install-code-mode.ps1 -Isolation docker
```

Script motoru doğrular, `3p-code-engine-worker:<SHA-256>` imajını önden derler ve
`CODE_MODE_ISOLATION=docker` değişkenini Desktop ortamına yazar (yeniden
kurulumda `off` değeri değişkeni ortamdan çıkarır). İmajın yoksa ilk iş
derler. `node worker-image.mjs` güncel etiketi döndürür; worker modülleri,
Dockerfile, ignore kuralları veya lockfile değişince yeni etiketle imaj
hazırlanır. Eski sabit isimli imajlar kullanılmaz. Docker CLI varsayılan olarak `docker` adıyla
çözülür; `CODE_MODE_DOCKER_BIN` ile alternatif bir ikili/makro
(örn. podman, izole testteki sahte motor) gösterilebilir — `.cmd`/`.bat`
hedefi sistem kabuğu üzerinden çalıştırılır (Node'un `spawn`'ı batch
dosyasını doğrudan başlatamaz).

Davranış farkları: `run` PowerShell yerine `/bin/sh` kullanır
(`uname -s` → `Linux`); kod içindeki mutlak host yolları konuk köküne
göre çözülür. `callMcp`, `listMcpTools` ve `listMcpServers`, stdio köprüsüyle
host'taki yapılandırılmış MCP sunucularına erişir. Yapılandırma ve anahtarlar
konteynere gönderilmez. İzin, auto, hook ve onay denetimi host'ta yapılır;
ham RPC de bu denetimi atlayamaz. Hook'lar host'ta çalışır: komut/script
yolları host yolları, olayın `cwd` alanı host proje yoludur; dosya yardımcılarının
`file_path` alanı konuk yolunu (`/work/...`) korur. Hook'un `updatedInput`
ile değiştirdiği dosya yolları da bu host→`/work` eşlemesinden geçer;
MCP argümanları aynen
iletilir; host dosyası isteyen bir dış araç için host yolu verilmelidir.
Arka plan çıktı hook'ları da host'ta uygulanır. Onay akışı değişmez:
broker host'ta kalır, insan aynı web sayfasından karar verir. Sunucu,
gerçek `docker version` yanıtını `isolation.json` dosyasına yazar; motor
yoksa izolasyon etkin sayılmaz (`workerIsolated: false`).

Dış MCP araçları kendi OS yetkileriyle host'ta çalışır; Docker bu araçların
dosya/ağ etkilerini yalıtmaz. Köprü sadece yapılandırılmış sunucuları çağırır,
en fazla 64 eşzamanlı istek kabul eder; istek argümanları 256 KiB, yanıtlar
1 MiB ile sınırlıdır. İptal, bağlı MCP çağrılarını ve host hook'larını da durdurur.

### Oturum ve transcript

`code_session_resume` çalışılan dizini, izin modunu ve son 100 yürütmenin
iş kimliğini döndürür. Aynı `sessionId` ile `code_execute` çağrısına devam
edilebilir. Kayıtlı oturumlarda `cwd` otomatik yüklenir; kayıtlı izin modu bir
kayıt tutucudur, kapı değildir: `CODE_MODE_PERMISSION_MODE` kayıtlı moddan
farklı olsa bile devam edilir ve oturum bitişte yürüdüğü modu yeniden yazar.
Devam için projenin Code Mode'ta hâlâ etkin olması yeterlidir; kapalı veya
bozuk etkinleştirme ayarı gerekçesiyle açık hatadır.
Her işin kod kaydı ve düzenleme önizlemesi `code_status` ile açılabilir.
Yerel görüntüleyici de aynı kayıtları okur:

```powershell
node code-mode-transcript.mjs session "oturum-kimligi"
node code-mode-transcript.mjs job "is-kimligi"
node code-mode-transcript.mjs session "oturum-kimligi" --interactive
node code-mode-transcript.mjs job "is-kimligi" --interactive
```

Görüntüleyici, MCP sunucusuyla aynı `CODE_MODE_DATA_DIR` değerini kullanır.
Oturum komutunda aynı `CODE_MODE_PERMISSION_MODE` değerini kullanın.
Etkileşimli görünümde `Ctrl+O` transcript'i açar/kapatır; kod satırları önce
daraltılmıştır. Yukarı/aşağı ile iş seçilir, `Enter` ile kod genişletilir,
`R` ile disk kaydı yenilenir, `Q` ile çıkılır. Normal görünüm yardımcı işlemleri,
düzenleme önizlemelerini ve sonucu gösterir. Bu yerel terminal görüntüleyicisidir;
Desktop uygulamasının kendi kısayollarını veya konuşma arayüzünü değiştirmez.

Çağrı parametreleri: `cwd` (mutlak başlangıç dizini), `code` (JavaScript kodu), `timeoutMs` (1000-600000, varsayılan 600000), isteğe bağlı `sessionId`. `return` veya son üst seviye ifadeyi kullanabilirsiniz; Acorn AST ayrıştırıcısı noktalı virgülsüz geçerli JavaScript'i, yorumları ve template literal'ları korur. Her çağrı yeni bir QuickJS motorudur; normal değişkenler çağrılar arasında korunmaz. Aynı `sessionId` ile JSON `state` başarılı çağrılar arasında diske kaydedilir (en fazla 256 KiB). Kayıtlar geçici dosyaya yazılıp yeniden adlandırılarak atomik saklanır; hedefin geçici OS kilitlenmesi (Windows'ta gözlenen EPERM) ya da geçici dosyanın kaybı (ENOENT) kayıptan önce sınırlı sayıda denemede, her denemede taze bir geçici dosya ile aşılmaya çalışılır. Başarısız çağrılar yeni state'i kaydetmez; aynı oturuma eşzamanlı çağrı reddedilir. `code_session_delete` state'i temizler; aynı veri dizinini birden fazla sunucuyla eşzamanlı kullanmayın.

- `await read(file)` — UTF-8 metin okur (1 MiB sınırı).
- `await write(file, text)` — dosya oluşturur veya üzerine yazar.
- `await edit(file, oldText, newText)` — tam olarak bir kez eşleşen metni değiştirir.
- `await run(command, {cwd, timeoutMs})` — Windows PowerShell komutu çalıştırır; `exitCode`, `stdout`, `stderr`, `timedOut`, `truncated` döner. Başarısız çıkış kodunu kodun kendisi kontrol etmelidir.
- `log(...values)` — sonuca sınırlı günlük ekler.
- `await callMcp(server, tool, args)` - aşağıda yapılandırılan bir stdio MCP sunucusunun aracını çağırır.
- `await listMcpServers()` ve `await listMcpTools(server)` - yapılandırılmış stdio sunucularını ve araçlarını keşfeder.
- ``await $`komut`.text()`` - başarılı komutun çıktısını döndürür; başarısız komutta hata verir. ``await $`komut`.nothrow()`` - hata fırlatmadan sonuç nesnesini döndürür. Şablona eklenen her değer tek bir kabuk argümanı olarak tırnaklanır. Ortama göre Windows PowerShell veya POSIX shell kullanılır; tüm Claude Code sözdizimi ve davranışlarının eşdeğerliği garanti edilmez.

Yürütme hataları yutulmaz:

- Yardımcı çağrısı başarısız olduysa ve kod o hatayı `await`/`catch` ile
  ele almadıysa, yürütme o hatayla reddedilir — bekletilmiş bir yardımcının
  sessiz reddi sonucu "başarılı" gösterilmez.
- `setTimeout` geri çağrısı fırlattıysa ve yürütme hâlâ aktifse hata aynı
  kanaldan raporlanır. Yürütme tamamlandıktan sonra tetiklenecek unutulmuş
  zamanlayıcılar çalıştırılmaz (kapanışta temizlenir).
- Yardımcı sonucu JSON'a döndürülemezse (BigInt, döngüsel yapı) hata
  gerekçesiyle bildirilir; seriye döktürmek `undefined` veren değerler
  (fonksiyon, sembol) `null` olarak sınırdan geçer.
- Bekleyen iş içinde bellek sınırı aşımı (64 MiB) ya da başka bir motor
  hatası yürütmeyi o hata mesajıyla durdurur.
- `timeoutMs` yalnızca çalışan kod için değil, bir yardımcıda bekleyip atıl
  durumdaki yürütme için de geçerlidir: süre sonunda yürütme "süre aştı"
  hatasıyla biter, motor bağlamı kapatılır ve daha sonra sonuçlanan bekleyen
  işlemler sessizce yok sayılır — asılı süreç, çökme veya unhandled rejection
  bırakılmaz.

`code_start` arka planda kod başlatır; `code_status` iş durumunu/sonucunu ve `log`, komut çıktısı veya yardımcı işlem olaylarını alır. Sonraki sorguda `afterSequence` ile yalnızca yeni olaylar istenebilir. Olaylar boyut ve sayı sınırlarına tabidir; kayıp olay ve kesilmiş çıktı ayrıca bildirilir. Bu, sürekli itilen bir yayın değil, istemcinin aralıklarla sorgulamasıdır. `code_cancel` işi durdurmayı dener. Tamamlanan sonuçlar ve kod kaydı yeniden başlatmadan sonra iş kimliğiyle okunabilir; yeniden başlatma sırasında çalışan işler devam ettirilmez, sonuçları bilinmeyen `interrupted` olarak görünür. `code_job_delete` tamamlanmış işin saklanan kaydını siler. Arka plan limiti iki saattir. Durdurma, kendini ayırmış tüm alt süreçlerin sonlandırılacağını garanti etmez.

Durum ve iş kayıtları varsayılan olarak Windows'ta `%LOCALAPPDATA%\3p-code-engine` altında düz JSON olarak tutulur; `CODE_MODE_DATA_DIR` ile değiştirilebilir. Kod, çıktı ve hassas bilgi içerebilir; veriler şifrelenmez, otomatik süre sonunda silinmez. `code_session_delete` ve `code_job_delete` ile temizlenebilir. Çalışma sırasında sunucu çökerse kayıt ve disk yazımı tamamlanmamış olabilir.

`read`, `write`, `edit`, `run` ve `callMcp` yardımcılarından geçen başarılı işlemler sonuçtaki `operations` dizisindedir. `edit` eski/yeni metnin ilk 2000 karakterini döndürür. Kabuk programlarının içindeki her dosya/ağ işlemi ayrıca kaydedilmez; kayıt hassas içerik içerebilir. Doğrudan Node.js çağrısı QuickJS içinde mevcut değildir.

### Diğer MCP sunucuları

Kurulum scripti `CODE_MODE_MCP_CONFIG_PATH` değerini seçilen Desktop yapılandırmasına bağlar; kayıtlı ve devre dışı olmayan stdio sunucuları otomatik keşfedilir, `3p-code-mode` kendisini çağırmaması için hariç tutulur. Kendi Desktop araçları bu MCP listesine dahil değildir. Ek/override sunucular için MCP sunucusunu başlatan ortamda `CODE_MODE_MCP_SERVERS` değişkenini JSON olarak tanımla:

```powershell
$env:CODE_MODE_MCP_SERVERS = '{"example":{"command":"C:\\Program Files\\nodejs\\node.exe","args":["C:\\path\\server.mjs"]}}'
```

Kod içinden `await callMcp('example', 'tool_name', {key: 'value'})` kullanılabilir. Her çağrı yapılandırılmış sunucuyu başlatıp kapatır; mevcut Desktop MCP oturumunu devralmaz. Alt sunucu SDK'nın varsayılan ortam değişkenlerini ve yapılandırmada verilen `env` değerlerini alır; kendi işletim sistemi yetkileriyle çalışır. Desktop üzerinden başlatırken ortam değişkeni MCP yapılandırmasında tanımlanmalıdır.

```javascript
const found = await run('rg -l "maxAttempts: 3" src');
if (found.exitCode !== 0) throw new Error(found.stderr || 'Dosya bulunamadı');
const file = found.stdout.trim().split(/\r?\n/)[0];
await edit(file, 'maxAttempts: 3', 'maxAttempts: 5');
const tests = await run('npm test', { timeoutMs: 90000 });
return { file, tests };
```

Kodun üst seviye zaman aşımı tüm akış içindir. Komutun ayrıca zaman aşımı vardır. Windows'ta zaman aşımında işlem ağacı sonlandırılmaya çalışılır. Uzun çıktılar kesilir. `tools.Read`, `tools.Write`, `tools.Edit` ve `tools.Bash`, mevcut yardımcıların aynı denetimlerden geçen adlarıdır.

## Test

MCP sonuçları, kod kaydını ve yardımcı düzenlemelerin satır bazlı önce/sonra önizlemesini ikinci metin bloğu olarak içerir. Görünüm MCP istemcisine bağlıdır. Yerel görüntüleyici aynı önizlemeyi terminalde açar.

`npm test`, MCP yürütmeyi, broker üzerinden insan onayını (kabul, ret, süre
aşımı, istemci kesilmesi, tek kullanımlık nonce, Origin denetimi, denetim
zinciri, yeniden başlatma), arka plan işlerini, sunucu yeniden başlatma sonrası
devamı, auto onayının geçersizleşmesini, onay süresinin dolmasını, çıktının
engellendiğinde sızmamasını, command/HTTP/MCP hook'larını, etkileşimli
transcript kontrollerini, review ve kurulum akışlarını doğrular.
`test-code-mode-isolation.mjs` her makinede sahte bir motorla kapatma
davranışını doğrular (motor dururken iş çalışmaz, hata motorun kendisidir,
gölge `isolation.json` yalıtım iddia etmez, motor dönünce iş yeniden
dener) — Docker motoru varsa ayrıca konteyner sınırını doğrular: proje
dışı dosya erişimi, host loopback'e erişilemezlik, Linux konuk kabuğu,
broker onayı (`fromUi` denetim kaydıyla) ve iptalde konteyner temizliği.
Motor yoksa bu kısımlar SKIP yazar ve "geçti" sayılmaz.
`npm run test:isolation:required` motor veya build yokluğunu hata sayar.
CI'daki `Docker isolation (required)` işi Ubuntu/Linux üzerinde bu komutu
çalıştırır; Windows test işi ayrı kalır. Branch protection gerekiyorsa bu
kontrolün GitHub depo kurallarında da zorunlu seçilmesi gerekir.
HTTP ve sınıflandırıcı testleri yerel TCP bağlantısı gerektirir. Canlı Desktop
modelinin gerçek araç seçimi ve istemcinin form görünümü ayrı doğrulama gerektirir.
Özellik karşılaştırması ve canlı doğrulama adımları:
[CODE-MODE-COMPATIBILITY.md](CODE-MODE-COMPATIBILITY.md).
