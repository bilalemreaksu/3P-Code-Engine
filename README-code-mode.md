# 3P Code Mode v0.9

Claude Desktop 3P için deneysel MCP kod yürütme sunucusu. Model, tek `code_execute` çağrısında JavaScript yazar; kod asenkron işlemleri sırayla veya `Promise.all` ile paralel çalıştırabilir, sonuçları süzebilir, dosyaları değiştirebilir ve komut/test çalıştırabilir. Anthropic Code Mode'un ayrı bir uygulamasıdır; onun dahili araçları, hook'ları, arayüzü ve izin sistemi değildir.

## Önemli yetki sınırı

Modelin gönderdiği JavaScript, sunucuyu başlatan Windows hesabının tüm yetkileriyle çalışır. `cwd` başlangıç dizinidir. Kurallar, onaylar ve hook'lar aşağıdaki yardımcı araçlara uygulanır. Doğrudan Node.js erişimi için işletim sistemi düzeyinde yalıtım gerekir; tehdit modeli ve kalan riskler [SECURITY.md](SECURITY.md) dosyasında belgelenmiştir.

## Desktop yapılandırması

Bu kurulum scripti Windows içindir; her kullanıcı kendi hesabında çalıştırır. Node.js 24 veya üzeri ve npm PATH üzerinde bulunmalıdır. Gerekli npm paketleri eksikse script `npm ci` çalıştırır (internet erişimi gerekir). Claude Desktop veya 3P yapılandırması önceden mevcut olmalıdır. Script kullanıcı adı, sabit proje yolu veya sabit Node kurulum dizini kullanmaz.

PowerShell'i projenin çıkarıldığı klasörde aç ve çalıştır:

```powershell
.\install-code-mode.ps1
```

Script mevcut `%LOCALAPPDATA%\Claude-3p\claude_desktop_config.json` ve `%APPDATA%\Claude\claude_desktop_config.json` dosyalarını arar. İkisi de mevcutsa yanlış profili seçmemek için `-ConfigPath` ister. Özel Node yolu için `-NodePath` kullanılabilir. Bir model sunucusu ve modeli belirlemek için isteğe bağlı:

```powershell
.\install-code-mode.ps1 -ConfigPath "$env:LOCALAPPDATA\Claude-3p\claude_desktop_config.json" `
  -ModelEndpoint 'http://127.0.0.1:9931/v1' -ModelName 'model-adi'
```

Mevcut yapılandırma yedeklenir; eski `3p-code-engine-reader` kaydı kaldırılır. Diğer MCP kayıtları ve daha önce tanımlanmış `3p-code-mode` ortam değişkenleri korunur. Kaydedilen Node ve proje yolları kurulum anındaki mutlak yollardır; proje taşınırsa scripti yeni yerinden yeniden çalıştırın. Desktop'ı yeniden başlatıp araç listesinde `code_execute` bulunduğunu doğrulayın. Bu işlemler her Desktop/3P sürümü veya her modelle doğrulanmış değildir.

## API

### Araç çağrısı kuralları ve PreToolUse

Varsayılan politika kurulum dizinindeki `code-mode-policy.json` dosyasıdır
(başlangıçta `{}`). Başka bir güvenilen dosya için MCP sunucusunun ortamında
`CODE_MODE_POLICY_PATH` değerini mutlak yola ayarlayın. Worker yapılandırmayı
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

Kurallar araç adına tam eşleşir. Kullanılabilir adlar `REPL`, `Read`, `Write`,
`Edit`, `Bash`, `McpListTools` ve `mcp__<sunucu>__<araç>` biçimindeki MCP araç adlarıdır.
`REPL` denetimi JavaScript başlamadan önce çalışır. `Bash` hem `run`
hem de `$` çağrılarını kapsar. `deny` çağrıyı engeller. `ask`, yerel insan
onay brokerinin web arayüzünde onay ister: iş, insan karar verene kadar
bekler. Ön plan ve arka plan çağrıları aynı broker üzerinden onaylanır;
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

### İzin modları

`CODE_MODE_PERMISSION_MODE` sunucu ortamından ayarlanır. Çağrı yapan model
bu ayarı araç parametresiyle değiştiremez.

| Mod | Yardımcı çağrılara etkisi |
| --- | --- |
| `rules` (varsayılan) | Yapılandırılmış `deny`, `ask` ve hook'lar uygulanır. |
| `default` | Yazma, düzenleme, kabuk ve dış MCP işlemleri onay ister. |
| `acceptEdits` | Dosya yazma ve düzenleme için modun ek onayı atlanır. Kabuk ve dış MCP işlemleri onay ister. |
| `plan` | Denetlenen yardımcılar arasından yalnızca `Read` ve `REPL` çalışabilir. |
| `auto` | JavaScript'in tamamı çalıştırılmadan önce bir kez sınıflandırılır. Yardımcı araç kuralları ve hook'lar uygulanır. |
| `bypassPermissions` | Mod ek onay istemez. Açık `deny`, `ask` ve hook'lar uygulanır. |

`auto` için `CODE_MODE_CLASSIFIER_ENDPOINT` ve `CODE_MODE_CLASSIFIER_MODEL`
zorunludur. İsteğe bağlı `CODE_MODE_CLASSIFIER_API_KEY` kullanılabilir.
Sunucu JavaScript'i ve başlangıç dizinini yapılandırılan OpenAI uyumlu
uç noktaya gönderir. Yalnızca `{"decision":"allow"}` sonucu yürütmeye izin
verir. Hata ve geçersiz sonuç çağrıyı engeller.

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
- Güvenlik modeli, doğrudan Node.js/shell kullanımının helper izinlerini
  aşabildiği ve sert sınır için OS izolasyonu: [SECURITY.md](SECURITY.md).

`review_changes`, `review_and_fix` ve `reviewAfter` kendi kabuk/model
akışlarını kullanır; yalnızca `rules` veya `bypassPermissions` modlarında
kullanılabilir. Code Mode yardımcı izinlerinin bunları denetlediği varsayılmamalıdır.

### Oturum ve transcript

`code_session_resume` çalışılan dizini, izin modunu ve son 100 yürütmenin
iş kimliğini döndürür. Aynı `sessionId` ile `code_execute` çağrısına devam
edilebilir. Kayıtlı oturumlarda `cwd` otomatik yüklenir ve izin modu eşleşir.
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

Çağrı parametreleri: `cwd` (mutlak başlangıç dizini), `code` (JavaScript kodu), `timeoutMs` (1000-600000, varsayılan 120000), isteğe bağlı `sessionId`. `return` kullanabilir veya kodu tek bir ifadeyle ya da noktalı virgülden sonra son bir ifadeyle bitirebilirsiniz. Bu basit son ifade desteği tüm JavaScript REPL davranışlarının aynısı değildir. Her çağrı yeni bir Node sürecidir; JavaScript değişkenleri çağrılar arasında korunmaz. Aynı `sessionId` ile JSON nesnesi `state` başarılı çağrılar arasında diske kaydedilir (en fazla 256 KiB) ve sunucu yeniden başladıktan sonra yüklenir. Başarısız çağrılar state'i kaydetmez ve aynı sunucuda aynı oturuma eşzamanlı çağrı reddedilir. `code_session_delete` durumu temizler; birden fazla sunucu süreciyle aynı veri dizinini eşzamanlı kullanmayın.

- `await read(file)` — UTF-8 metin okur (1 MiB sınırı).
- `await write(file, text)` — dosya oluşturur veya üzerine yazar.
- `await edit(file, oldText, newText)` — tam olarak bir kez eşleşen metni değiştirir.
- `await run(command, {cwd, timeoutMs})` — Windows PowerShell komutu çalıştırır; `exitCode`, `stdout`, `stderr`, `timedOut`, `truncated` döner. Başarısız çıkış kodunu kodun kendisi kontrol etmelidir.
- `log(...values)` — sonuca sınırlı günlük ekler.
- `await callMcp(server, tool, args)` - aşağıda yapılandırılan bir stdio MCP sunucusunun aracını çağırır.
- `await listMcpServers()` ve `await listMcpTools(server)` - yapılandırılmış stdio sunucularını ve araçlarını keşfeder.
- ``await $`komut`.text()`` - başarılı komutun çıktısını döndürür; başarısız komutta hata verir. ``await $`komut`.nothrow()`` - hata fırlatmadan sonuç nesnesini döndürür. Şablona eklenen her değer tek bir kabuk argümanı olarak tırnaklanır. Ortama göre Windows PowerShell veya POSIX shell kullanılır; tüm Claude Code sözdizimi ve davranışlarının eşdeğerliği garanti edilmez.

`code_start` arka planda kod başlatır; `code_status` iş durumunu/sonucunu ve `log`, komut çıktısı veya yardımcı işlem olaylarını alır. Sonraki sorguda `afterSequence` ile yalnızca yeni olaylar istenebilir. Olaylar boyut ve sayı sınırlarına tabidir; kayıp olay ve kesilmiş çıktı ayrıca bildirilir. Bu, sürekli itilen bir yayın değil, istemcinin aralıklarla sorgulamasıdır. `code_cancel` işi durdurmayı dener. Tamamlanan sonuçlar ve kod kaydı yeniden başlatmadan sonra iş kimliğiyle okunabilir; yeniden başlatma sırasında çalışan işler devam ettirilmez, sonuçları bilinmeyen `interrupted` olarak görünür. `code_job_delete` tamamlanmış işin saklanan kaydını siler. Arka plan limiti iki saattir. Durdurma, kendini ayırmış tüm alt süreçlerin sonlandırılacağını garanti etmez.

Durum ve iş kayıtları varsayılan olarak Windows'ta `%LOCALAPPDATA%\3p-code-engine` altında düz JSON olarak tutulur; `CODE_MODE_DATA_DIR` ile değiştirilebilir. Kod, çıktı ve hassas bilgi içerebilir; veriler şifrelenmez, otomatik süre sonunda silinmez. `code_session_delete` ve `code_job_delete` ile temizlenebilir. Çalışma sırasında sunucu çökerse kayıt ve disk yazımı tamamlanmamış olabilir.

`read`, `write`, `edit`, `run` ve `callMcp` yardımcılarından geçen başarılı işlemler sonuçtaki `operations` dizisinde yer alır. `edit` eski/yeni metnin ilk 2000 karakterini döndürür. Bu liste tam bir denetim kaydı değildir: kodun doğrudan Node, PowerShell veya başka bir programla yaptığı işlemleri yakalamaz ve hassas içerik içerebilir.

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
HTTP ve sınıflandırıcı testleri yerel TCP bağlantısı gerektirir. Canlı Desktop
modelinin gerçek araç seçimi ve istemcinin form görünümü ayrı doğrulama gerektirir.
Özellik karşılaştırması ve canlı doğrulama adımları:
[CODE-MODE-COMPATIBILITY.md](CODE-MODE-COMPATIBILITY.md).
