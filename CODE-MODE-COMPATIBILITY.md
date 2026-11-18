# Code Mode karşılaştırması

18 Kasım 2026 tarihinde [Code Mode belgesi](https://code.claude.com/docs/en/code-mode)
ve [hook referansı](https://code.claude.com/docs/en/hooks) temel alınmıştır.
Bu proje, 3P/Desktop için bağımsız bir MCP sunucusudur. Claude Code ürününün
kendi özellik bayrağını, hesap/model uygunluğunu veya arayüzünü uygulamaz.

| Davranış | 3P Code Mode v0.9 |
| --- | --- |
| JavaScript ile sıralı/paralel araç çağrısı ve sonuç süzme | `code_execute`, async yardımcılar ve `Promise.all` |
| Read/Write/Edit/Bash, `$` komutları | Yardımcılar ve `tools` takma adları; kabuk platforma göre seçilir |
| MCP araçları | Yapılandırılmış stdio sunucuları keşfedilir ve çağrılır; Desktop'ın yerleşik araçları devralınmaz |
| Son ifade sonucunu döndürme | Tek ifade veya açık noktalı virgül sınırları desteklenir; tam JavaScript REPL ayrıştırıcısı değildir |
| Kurallar ve `PreToolUse` | Yardımcı araçlarda tam araç adı eşleşmesi, REPL denetimi, JSON kararları |
| Hook hatası/zaman aşımı, `onFailure` | Command, HTTP ve MCP hook'ları; açık engelleme kararı her zaman uygulanır |
| `UserPromptSubmit` / `poll_event` | Arka plan çıktısı yayımlanmadan önce denetlenir; engellenirse günlük, olay, sonuç ve state paylaşılmaz |
| Auto: bütün kodu bir kez sınıflandırma | Yapılandırılmış OpenAI uyumlu sınıflandırıcı; hata durumunda engelleme |
| Yeni kod başlayınca eski auto onayının kaybı | Aynı sunucudaki eski auto işleri sonraki değişiklik yapan yardımcı çağrılarda insan onayı ister |
| Onay geri sayımı | Varsayılan iki dakika; karar yerel onay brokerinin web arayüzünde verilir (broker kökeni doğrulanır, hash zincirli denetim); süre sonunda otomatik ret |
| Modelin kendi onayını verememesi | Hiçbir MCP aracı karar taşıyamaz (`code_status` salt okunur, nonce asla yanıtta yok); karar yalnızca broker sayfasının kökeninden kabul edilir. Doğrudan Node.js/shell bypass'ı ve OS izolasyonu: [SECURITY.md](SECURITY.md) |
| Ön plan / arka plan süreleri | En fazla 10 dakika / 2 saat; ön plan varsayılanı 2 dakika |
| Arka planda konuşmaya devam | `code_start` iş kimliğini hemen döndürür, `code_status` sorgulanır |
| Oturumu devam ettirme | JSON `state`, cwd ve izin modu diskte tutulur; normal JS değişkenleri tutulmaz |
| Transcript ve düzenleme önizlemesi | MCP metin blokları; terminalde `--interactive`, Ctrl+O ve daraltılmış Code satırları |
| Claude Code Ctrl+O konuşma arayüzü | MCP sunucusunun değiştiremediği istemci özelliği; yerel görüntüleyici karşılığı sağlanır |
| Yerleşik araç izinleri / OS sandbox | Bu sunucuda yalnızca yardımcı çağrılar denetlenir; doğrudan Node.js erişimi OS yetkileriyle çalışır |
| Anthropic hesabı, native build, özellik bayrağı ve sürüm kapıları | Claude Code'a özgü; bu bağımsız sunucuya uygulanmaz |
| Remote Control, Chrome, computer use, agent teams ve uygulamalar arası oturum taşıma | Claude Code'a ait entegrasyonlar bu projede bulunmaz |

`rules` modu bu projenin ekidir ve önceki sürümle uyumluluk için arka plana
izin verir. `auto` ve `bypassPermissions` da arka planı destekler; `default`,
`acceptEdits` ve `plan` ile `code_start` reddedilir. Üstteki tablo, Claude Code
ayar dosyalarının veya tüm hook referansının birebir uyumluluğu iddiası değildir.

## Doğrulama

`npm test`: gerçek stdio MCP istemcisi/sunucusu, kontrollü yerel sınıflandırıcı,
HTTP hook sunucusu ve MCP hook aracıyla bütünleşim testleri. Gizli çıktı içeren
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
