# Code Mode MCP sunucusu

`3p-code-mode`, istemcinin ürettiği JavaScript'i QuickJS içinde çalıştıran bir stdio MCP sunucusudur. JavaScript, proje ve işletim sistemiyle denetimli yardımcılar üzerinden etkileşir. İstemci modeli seçer ve `code_execute` gibi araçları çağırır. Etkileşimli REPL, konuşma kaydı ve sağlayıcı seçimi için [bağımsız terminali](README-terminal.md) kullanın.

## Claude Desktop 3P kurulumu

Windows'ta Node.js 24+ ve mevcut bir Desktop yapılandırması gerekir. Docker kullanacaksanız Linux konteynerleri çalıştıran motoru başlatın. Motorun depo kökünden çalıştırın.

~~~powershell
$desktopConfig = Join-Path $env:LOCALAPPDATA 'Claude-3p\claude_desktop_config.json'
$project = 'C:\Projects\uygulama'
.\install-code-mode.ps1 -ConfigPath $desktopConfig -Isolation docker
npm.cmd run code -- --config $desktopConfig --enable --cwd $project
~~~

1. Kurulum scripti Desktop dosyasını yedekler, `3p-code-mode` kaydını yazar ve kullanacağı Node ile sunucu dosyasının mutlak yollarını kaydeder. Docker seçildiyse imajı da hazırlar. Motorun depo yolu değişirse kurulumu yeni konumda tekrarlayın.
2. `--enable` proje yolunu güvenilen kullanıcı dizinindeki `settings.json` dosyasına kaydeder. Desktop ve terminal aynı `CODE_MODE_DATA_DIR` değerini kullanmalıdır. `--config` seçeneği kayıtlı MCP ortamını yükler. Windows varsayılanı `%LOCALAPPDATA%\3p-code-engine` olur.
3. MCP kaydı yeni eklendiyse veya başlatma ayarları değiştiyse Desktop'ı tamamen kapatıp açın. Kayıtlı sunucu sonraki açılışlarda başlatılır. Yürütme izni proje için diskten okunur, bu nedenle etkinleştirme komutu her açılışta tekrarlanmaz.

Script `-ConfigPath` verilmediğinde `%LOCALAPPDATA%\Claude-3p\claude_desktop_config.json` ve `%APPDATA%\Claude\claude_desktop_config.json` dosyalarını arar. İkisi de varsa açık bir yol ister. Özel Node kurulumu için `-NodePath` kullanılabilir. `-Isolation` varsayılanı `off`, `-PermissionMode` varsayılanı `autoApprove` olur. Mevcut bir kurulumu güncellerken istediğiniz modu ve izolasyonu açıkça geçin. `-ModelEndpoint` ve `-ModelName` inceleme motorunun ortamına yazılır. Desktop sohbetinin model rotası, Desktop'ın kendi sağlayıcı profilinde ayarlanır.

### İlk Desktop çağrısı

Etkinleştirdiğiniz mutlak yolu kullanarak Desktop sohbetinden basit bir çağrı isteyin.

> `3p-code-mode` sunucusundaki `code_execute` aracını çağır. `cwd` olarak `C:\Projects\uygulama` kullan. `return { ok: true }` JavaScript'ini çalıştır ve araç sonucunu göster.

Araç bulunamıyorsa Desktop'ın yerel MCP konektörlerinde `3p-code-mode` kaydını kontrol edin. `Code Mode is not enabled` hatasında belirtilen `cwd` ile kullanıcı ayarındaki proje yolunu ve veri dizinini karşılaştırın. Alt dizin ayrı bir `cwd` olarak kullanılacaksa o yol da etkinleştirilir. Bozuk kullanıcı ayarı açık bir hata üretir. Kapatma işlemi [terminal kılavuzunda](README-terminal.md#projeyi-etkinleştirme) anlatılır.

### Basalt ile yerel Qwen

Doğrulanan örnekte Desktop 3P'nin gateway profili `http://127.0.0.1:9931` adresine bağlandı. Basalt yapılandırmasında `Qwen3.8-27B-QUASAR-NVFP4.basalt` dosyasının API takma adı `anthropic/claude-opus-5-5` olarak tanımlıydı. Desktop profili, Basalt'ın API'de sunduğu kimliği kullanır. Fiziksel ağırlık dosyasını Basalt yapılandırmasındaki `models[].model` alanından doğrulayın. [Basalt model yönlendirmesi](https://github.com/jesdga95/basalt/blob/main/docs/configuration/models.md)

~~~powershell
Invoke-RestMethod 'http://127.0.0.1:9931/health' | Select-Object model, loaded
(Invoke-RestMethod 'http://127.0.0.1:9931/v1/models').data | Select-Object id
~~~

Desktop, MCP aracını sohbetin parçası olarak seçer. `3p-code-mode` kaydı aracın kullanılabilirliğini sağlar. Kayıtlı yapılandırmayla yeni bir MCP sürecinin açıldığı ve çağrıyı tamamladığı doğrulandı. Modelin Desktop arayüzünde aracı seçmesi için yukarıdaki ilk çağrıyı kullanın. [Doğrulama kapsamı](CODE-MODE-COMPATIBILITY.md#doğrulama-kayıtları)

## Araç API'si

| Araç | Girdi ve sonuç |
| --- | --- |
| `code_execute` | `code`, yeni oturum için mutlak `cwd`, isteğe bağlı `sessionId`, `timeoutMs` ve `reviewAfter`. Ön planda tamamlanmayı bekler ve sonucu döndürür. |
| `code_start` | `code`, yeni oturum için mutlak `cwd`, isteğe bağlı `sessionId` ve `timeoutMs`. Arka plan iş kimliğini döndürür. |
| `code_status` | `jobId` ve isteğe bağlı `afterSequence`. İş durumunu, sonucu, yeni olayları ve varsa bekleyen onayları döndürür. İstemci bu aracı sorgular. |
| `code_cancel` | `jobId`. Çalışan işi durdurmayı dener. |
| `code_job_delete` | `jobId`. Tamamlanmış işin kayıt, çıktı ve olaylarını siler. |
| `code_session_resume` | `sessionId`. Proje yolunu ve son işlerin kimliklerini içeren oturum bilgilerini döndürür. |
| `code_session_delete` | `sessionId`. Saklanan yürütme durumunu siler. |
| `review_changes`, `review_and_fix` | Git değişikliği inceleme ve düzeltme araçları. Ayrıntılar [inceleme kılavuzunda](README-review.md#mcp) yer alır. |

`code` en fazla 65.536 karakter olabilir. `timeoutMs` alt sınırı 1.000 ms olur. Ön plan için varsayılan ve üst sınır 600.000 ms, arka plan için 7.200.000 ms'dir. Bütçe onay bekleme süresini de kapsar. Her yardımcı yürütmesi ayrıca kendi süre sınırına tabi olabilir.

`code_execute` yanıtındaki ilk MCP metin bloğu yürütme kaydını JSON olarak içerir. JavaScript'in döndürdüğü değer bu kaydın `result` alanında gösterim metni olarak yer alır. Kaydın `ok` alanı yürütme durumunu belirtir. `run` başarısız bir süreç çıkışı döndürdüyse JavaScript bu hatayı ayrıca ele alır.

### JavaScript yardımcıları

| Yardımcı | Davranış |
| --- | --- |
| `await read(file)` | UTF-8 metin okur. Okuma sınırı JavaScript dizesinde 1.048.576 birimdir. |
| `await write(file, text)` | UTF-8 yazar veya üzerine yazar. İzin kontrolünden sonra eksik üst dizinleri oluşturur. |
| `await edit(file, oldText, newText)` | Boş olmayan `oldText` tam bir kez eşleştiğinde metni değiştirir. |
| `await run(command, {cwd, timeoutMs})` | Kabuk komutunu çalıştırır. `ok`, `exitCode`, `stdout`, `stderr`, `timedOut` ve `truncated` döndürür. |
| ``await $`komut`.text()`` ve ``await $`komut`.nothrow()`` | Etiketli kabuk şablonu. `.text()` başarılı çıktıyı verir ve komut başarısızsa hata fırlatır. `.nothrow()` sonuç nesnesini verir. Şablon değişkenleri birer kabuk argümanı olarak tırnaklanır. |
| `await listMcpServers()` ve `await listMcpTools(server)` | Yapılandırılmış stdio MCP sunucularını ve araçlarını listeler. |
| `await callMcp(server, tool, args)` | Yapılandırılmış stdio MCP aracını çağırır. |
| `log(...values)` | Sonuca sınırlı bir günlük ekler. |

`tools.Read`, `tools.Write`, `tools.Edit` ve `tools.Bash` aynı yardımcıların diğer adlarıdır. Sonuç açık bir `return` ile veya son üst düzey ifadeyle verilebilir. Aynı dosyaya bağlı düzenlemeleri sıraya koyun. Bağımsız okumalar `Promise.all` ile paralel çalışabilir.

~~~javascript
const file = 'src/retry.js';
const [source, testSource] = await Promise.all([
  read(file),
  read('test/retry.test.js'),
]);
if (!source.includes('maxAttempts = 3') || !testSource.includes('retry')) {
  throw new Error('Beklenen kaynak veya test bulunamadı');
}

await edit(file, 'maxAttempts = 3', 'maxAttempts = 5');
const test = await run('node --test test/retry.test.js', { timeoutMs: 90000 });
return {
  file,
  ok: test.ok,
  exitCode: test.exitCode,
  output: (test.ok ? test.stdout : test.stderr || test.stdout).slice(-2000),
};
~~~

`run`, Windows host'ta PowerShell ve Linux host veya Docker'da `/bin/sh` kullanır. Başarısız komut çıkışını kod `ok` veya `exitCode` üzerinden işler. Ele alınmamış yardımcı reddi, çalışma sırasında fırlayan zamanlayıcı hatası, JSON'a çevrilemeyen sonuç, bellek veya süre sınırı yürütme hatasına dönüşür. İş kayıtları yardımcı işlemlerini ve düzenleme önizlemelerini içerebilir. Ayrıntılar [güvenlik modelinde](SECURITY.md#çıktı-ve-kayıtlar) yer alır.

### Arka plan, oturum ve kayıtlar

`code_status` ile `afterSequence` göndererek yeni olayları alın. Olay sayısı ve çıktı boyutu sınırlıdır. Tamamlanan işler yeniden başlatmadan sonra `jobId` ile okunabilir. Çalışan işler kesildiyse `interrupted` durumuna dönüşür ve yeniden yürütülmez.

Her çağrı yeni bir QuickJS bağlamı açar. Ön planda aynı `sessionId` kullanıldığında açık JSON `state` başarılı yürütmeler arasında saklanır. Bu alanın sınırı 256 KiB'dir. Yerel JavaScript değişkenlerinin ömrü çağrı süresidir. Aynı oturumda eşzamanlı yürütme reddedilir. `code_session_resume` son 100 iş kimliğiyle oturum bilgilerini döndürür. Desktop/MCP yüzeyinde güncel sunucu izin modu sonraki yürütmeye uygulanır. Yürütme sırasında kaydedilen eski izin modu geçmişe ait bilgidir.

~~~powershell
npm.cmd run transcript -- job 'IS_KIMLIGI'
npm.cmd run transcript -- session 'OTURUM_KIMLIGI' --interactive
~~~

Görüntüleyiciyi sunucuyla aynı `CODE_MODE_DATA_DIR` değerinde çalıştırın. Etkileşimli görünümde `Ctrl+O` ile kayıt açılır, `Enter` ile kod genişletilir. `R` yeniden okur, `Q` çıkar. Bu komutlar terminal görüntüleyicisinde geçerlidir.

## İzin modları

Sunucu `CODE_MODE_PERMISSION_MODE` ortam değişkenini okur. Mod, proje etkinleştirmesinden ayrıdır. Desktop'taki MCP çağrıları `source: 'mcp'` olarak kaydedilir. Terminalde `user` ve `poll_event` kaynakları ayrı işlenir.

| Mod | Yardımcı çağrıları | Arka plan |
| --- | --- | --- |
| `autoApprove` | Varsayılan. Onay brokeri ve sınıflandırıcı kullanılmaz. `ask` kararları otomatik geçilir. Açık `deny` kuralları ve engelleyici hook'lar uygulanır. | Evet |
| `rules` | Politikadaki `deny`, `ask` ve hook'lar uygulanır. | Evet |
| `default` | Dosya değişikliği, salt okunur kabul edilmeyen kabuk ve dış MCP çağrılarında modun onayı uygulanır. | Hayır |
| `acceptEdits` | Dosya yazma ve düzenleme modun ek onayından muaftır. Diğer işlemlerde `default` tabanı uygulanır. | Hayır |
| `plan` | `REPL`, `Read` ve salt okunur kabul edilen kabuk komutlarına izin verir. | Hayır |
| `auto` | Kod bloğu çalışmadan önce bir kez sınıflandırılır. Yardımcı çağrılar politikadan geçer. Geçersizleşen inceleme ve hook'un değiştirdiği yazma gibi çağrılar insan onayı isteyebilir. | Evet |
| `bypassPermissions` | Mod ek onay istemez. Açık `deny`, `ask` ve hook kararları uygulanır. | Evet |

### Sınıflandırıcı ve onaylar

`auto` için `CODE_MODE_CLASSIFIER_ENDPOINT` ve `CODE_MODE_CLASSIFIER_MODEL` ile bir OpenAI uyumlu API verin. Gerektiğinde `CODE_MODE_CLASSIFIER_API_KEY`, süre için `CODE_MODE_CLASSIFIER_TIMEOUT_MS` kullanın. Sınıflandırıcı, kodun tamamını ve çalışma dizinini alır. Yalnızca terminalin gerçek kullanıcı turu güvenilen niyet bilgisini de taşıyabilir. Güvenli olarak tanınan `allow` kararı çalışmayı başlatır. Model hatası, geçersiz sonuç ve ret yürütmeyi engeller.

Aynı sunucuda yeni `auto` incelemesi başladığında önceki çalışan `auto` işlerinin inceleme geçerliliği kaldırılır. İzin gerektiren sonraki yardımcı çağrılar broker üzerinden insan kararı bekler. `code_status` bağlantıyı `pendingApprovals` içinde gösterir. Zaman aşımı varsayılan olarak 120.000 ms'dir. Güvenilen sunucu ortamındaki `CODE_MODE_APPROVAL_TIMEOUT_MS` 100–120.000 arasında olabilir. Süresi dolan bir işin onay durumu, terminalde aynı oturuma gelen gerçek kullanıcı mesajıyla yeniden kurulabilir. Desktop/MCP'de bu işin onayları iş sona erene kadar reddedilir.

## Kurallar ve hook'lar

Varsayılan politika [code-mode-policy.json](code-mode-policy.json) dosyasıdır. Güvenilen başka bir JSON dosyası için sunucunun `CODE_MODE_POLICY_PATH` değerini mutlak yola ayarlayın. Politika yeni yürütmede okunur. Geçersiz veya eksik yapılandırma ilgili yürütmeyi engeller.

~~~json
{
  "deny": ["Edit(**/.env)", "Bash(git push *)"],
  "ask": ["Write"],
  "preToolUse": [
    {
      "tool": "Bash",
      "type": "http",
      "url": "http://127.0.0.1:8090/pre-tool",
      "timeoutMs": 5000,
      "onFailure": "block"
    }
  ]
}
~~~

Araç adlarına `REPL`, `Read`, `Write`, `Edit`, `Bash`, `McpListTools` ve `mcp__<sunucu>__<araç>` dahildir. `mcp__<sunucu>__*`, bir sunucunun araçlarına eşleşir. `Bash(...)` kuralları komut metnine uygulanır. `deny` ve `ask` için eşleşen bir alt komut yeterlidir. `allow`, çözümlenebilen komutun tamamını kapsamalıdır. Yönlendirme, iç içe komut çalıştırma ve benzeri sözdiziminde komut metni kurallarının kapsamı sınırlıdır.

Dosya desenlerinde `//yol` mutlak, `~/yol` ev dizinine göre, `/yol` çalışma dizinine göredir. Windows sürücüleri `//c/...` biçiminde yazılır. `*` bir yol bölümünü, `**` birden fazla bölümü kapsayabilir. `Edit(yol)`, `Edit` ve `Write` çağrılarına eşleşir. `Write(yol)` sadece `Write`, `Read(yol)` sadece `Read` çağrılarına eşleşir. Negasyon desenleri ve genel `allow: ["*"]` geçersizdir. [Desen uygulaması](code-mode-rules.mjs)

İlk `deny` denetimi gönderilen girdiye uygulanır. `PreToolUse` hook'ları yürür ve değiştirilen girdiye `deny` tekrar uygulanır. Ardından `plan` sınırı, güncel girdi için `ask` ve `allow`, izin modunun tabanı ve varsa `auto` incelemesi değerlendirilir. Hook'un `allow` kararı açık `deny`, `ask` veya `plan` kısıtını kaldıramaz. `autoApprove` modunda `ask` yine otomatik geçilir.

### Hook biçimleri

- `command` varsayılan türdür. `command` mutlak çalıştırılabilir dosya yolu, `args` ayrı argümanlardır. Olay JSON'u standart girdiden gelir. `http` türü olay JSON'unu POST eder ve yönlendirmeleri izlemez. `mcp_tool` türü, `server` ve `mcpTool` ile bağlanan aracı çağırır. Olay alanları isteğe bağlı `arguments` değerlerinin üzerine yazılır.
- `PreToolUse` girdisi `hook_event_name`, `tool_name`, `tool_input`, `cwd` ve varsa `session_id` alanlarını taşır. Hook'lar tanım sırasıyla çalışır. `hookSpecificOutput.updatedInput` araç girdisinin tamamını değiştirir ve sonraki hook'a aktarılır. `REPL` kodu bu alanla değiştirilemez. `additionalContext` sonucu modele aktarır.
- `timeoutMs` varsayılanı 5.000, aralığı 100–600.000 ms'dir. Hook çıktısı en fazla 64 KiB olabilir. Komut kodu `0` ile boş çıktı veya JSON karar kabul edilir. Kod `2` ve açık `block` veya `deny` kararları engeller. Normal başarısız çıkışlar `onFailure: "block"` ile engellenir. Zaman aşımı, başlatma, geçersiz yanıt ve HTTP/MCP hataları varsayılan olarak engeller. `onFailure: "continue"` bu hata davranışını değiştirebilir.
- `userPromptSubmit`, arka plan sonucu yayımlanmadan önce `source: "poll_event"` olayını alır. Sonuç, günlükler, `state` ve bekletilen olaylar JSON metni olarak `prompt` alanına eklenir. Engellemede `outputBlocked` ile neden döner. Daha önce uygulanmış dosya etkileri kalır.
- `hooks.PreToolUse` ve `hooks.UserPromptSubmit` biçimi bir Claude Code uyumluluk alt kümesidir. Düz `preToolUse` ve `userPromptSubmit` biçimleriyle karıştırmayın. `matcher` tam araç adlarını, `|` ile ayrılan adları veya `*` kabul eder. `timeout` saniye cinsindendir ve `timeoutMs` ile birlikte verilmez. Desteklenmeyen alanlar hata verir. [Uyumluluk ayrıntıları](CODE-MODE-COMPATIBILITY.md#izinler-ve-hook-farkları)

## Docker ve dış MCP

`CODE_MODE_ISOLATION=docker` seçilince her iş tek kullanımlık bir Linux konteynerinde çalışır. Proje `/work` altında yazılabilir olarak bağlanır. Linux Docker motoru ve worker imajı gerekir. `node worker-image.mjs` imaj etiketini hesaplar. İlk hazırlık veya kaynak değişikliği imaj derlemesi gerektirebilir. Motor veya imaj kullanılamazsa iş hata verir. [Docker sınırları](SECURITY.md#docker-sınırı)

Kurulum scripti `CODE_MODE_MCP_CONFIG_PATH` değerini Desktop dosyasına bağlar. Etkin stdio sunucuları bu dosyadan keşfedilir. Ek sunucular ve geçersiz kılmalar için `CODE_MODE_MCP_SERVERS` JSON nesnesini sunucu ortamında verin.

~~~powershell
$env:CODE_MODE_MCP_SERVERS = '{"example":{"command":"C:\\Program Files\\nodejs\\node.exe","args":["C:\\tools\\example-server.mjs"]}}'
~~~

`3p-code-mode` kendisini çağırmaz. Dış araçlar Desktop oturumundan bağımsız başlatılır. Docker modunda host köprüsü çağrıları politika denetiminden geçirir. Köprü eşzamanlı 64 istek, 256 KiB argüman ve 1 MiB yanıt sınırı uygular. Hook ve MCP programlarının kendi dosya ve ağ yetkileri host'a aittir. Docker'da dosya yardımcıları için proje içi bağıl yollar kullanın. Dış MCP aracı host dosyasına erişecekse aracın beklediği host yolunu verin.
