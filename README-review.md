# 3P Code Engine: kod inceleme

Bu özellik Claude Code ekibinin inceleme sürecinden esinlenen yerel bir ilk uygulamadır. Git farkını yerel modele gönderir; farklı bakış açılarıyla ayrı istekler, aday bulgular için bağımsız doğrulama istekleri, risk tahmini ve isteğe bağlı test komutları çalıştırır. Çağrılar tek model yuvasına uygun olarak sırayla yapılır; bunlar birbirinden bağımsız model oturumlarıdır, ayrı model veya gerçek insan değildir.

## Gereksinimler ve bağlantı

Node 24, Git ve OpenAI uyumlu `/models` ve `/chat/completions` sunucusu gerekir. Varsayılan adres `http://127.0.0.1:9931/v1`'dir; farklı sunucular için `REVIEW_MODEL_ENDPOINT` ayarlayın. Model adı belirtilmezse `/models` üzerinden tek bir model bulunması gerekir; birden fazla model varsa `REVIEW_MODEL_NAME` belirtilmelidir. `/models` desteklemeyen sunucularda da model adını açıkça ayarlayın. Sunucuya diff ve kökteki AGENTS.md, CLAUDE.md ve REVIEW.md gönderilir.

```powershell
$env:REVIEW_MODEL_ENDPOINT = 'http://127.0.0.1:9931/v1'
$env:REVIEW_MODEL_NAME = 'model-adi' # Tek model sunuluyorsa isteğe bağlı
npm run review -- --cwd $PWD.Path --base HEAD --mode standard --intent 'Değişikliğin amacı' --check 'npm test'
```

`--base HEAD` mevcut commit'e göre değişiklikleri inceler. Başka bir commit veya branch de verilebilir. Birden fazla `--check` belirtilebilir. `--auto-check`, kökteki package.json dosyasından mevcut `lint`, `typecheck`, `test`, `build` script'lerini seçer. Her iki seçenek de çalışma dizininde gerçek komutlar çalıştırır ve dosyaları değiştirebilir; güvenliğinden çağıran sorumludur. Diğer proje türleri için komutları açıkça belirtin; bu seçenek güvenlik taraması veya UI kontrolü bulmaz.

MCP sunucusu `review_changes` aracını da sunar: `cwd`, `base`, `intent`, `mode`, isteğe bağlı `checkCommands` ve `autoChecks` alır. `code_execute` içinde isteğe bağlı `reviewAfter` nesnesi verilirse kod çalıştıktan sonra inceleme başlar. Kod çalıştırma başarısı inceleme başarısı anlamına gelmez; ayrıca `review.status` kontrol edilir. Sunucuyu yeniden başlattıktan sonra Desktop tarafından keşfedilmesi gerekir. Model sunucusu ve Claude Desktop ile uçtan uca çalışma ayrıca doğrulanmalıdır.

## Rapor ve sınırlar

- Quick iki, Standard üç, Deep dört ayrı bakış açısı kullanır. Quick'te bir, diğerlerinde iki bağımsız doğrulama isteğiyle adaylar değerlendirilir. Aynı modelin tekrarları bağımsız uzmanlar gibi garanti vermez.
- Çıktı, commit ve değişiklik özeti, tahmini risk, bulgular, belirsiz bulgular, kontrol sonuçları ve uyarılar içerir. CLI çıkış kodu: 0 inceleme tamam ve bulgu yok; 1 doğrulanmış bulgu var; 2 eksik inceleme veya hata. Test çalıştırılmadığında durum eksiktir.
- Takip edilmeyen 256 KiB'a kadar metin dosyaları da değişikliğe eklenir. Binary dosyalar, bağlantılar ve büyük takip edilmeyen dosyalar incelenmez ve raporda belirtilir. Büyük diff kesilir ve inceleme eksik sayılır. Model ihtiyaç duyarsa iki turda en fazla altışar küçük dosya isteyebilir; proje dışına veya tanımlı gizli dosya yollarına erişemez. Bu isim tabanlı filtre tüm sırları tespit edemez; diff'i modele göndermeden önce gözden geçirin. Git'in yok saydığı takip edilmeyen dosyalar incelenmez.
- Model yanıtı veya doğrulaması başarısızsa temiz sonuç verilmez. Çalışma ağacı inceleme sırasında değişirse yeniden çalıştırılmalıdır. Bulguların doğruluğu ve satır numaraları ayrıca insan tarafından kontrol edilmelidir.
- Bu uygulama GitHub branch koruması/insan onayı/merge queue uygulamaz ve yayın/rollback yapmaz. Risk ve onay sayısı yalnızca öneridir. Çalıştırılan komutlar sandbox içinde değildir.
- Model yapılandırması için isteğe bağlı `REVIEW_MODEL_API_KEY` ortam değişkeni kullanılabilir; anahtarı komut satırına yazmayın.

## Rapor ve inceleme turları

Komuta `--report 'C:\workspace\review.md' --ledger 'C:\workspace\review-history.json'` eklenirse Markdown raporu ve yerel tur geçmişi yazılır. Aynı dosyayı kullanan üçüncü turda `history.limitReached` true olur; bu bir uyarıdır, yeniden inceleme veya merge işlemini engellemez. Her PR için ayrı geçmiş dosyası kullanın. Önceki bulgular `newFindingKeys` listesinden ayrılır.

## Otomatik düzeltme döngüsü

`npm run review:fix -- --cwd 'C:\path\to\repo' --base HEAD --auto-check` veya MCP `review_and_fix`, doğrulanmış ilk bulgu için modelden bir metin düzenlemesi ister, dosyaya uygular ve yeniden test/inceleme yapar. Bu işlem dosyaları gerçekten değiştirir. Her turda tek dosya değiştirilir; yalnızca bulgu dosyası ve tam bir kez eşleşen metin kabul edilir. Üçüncü inceleme turunda hâlâ bulgu varsa durur; eksik inceleme veya başarısız testte otomatik düzeltme yapmaz. Önceden yapılan değişiklikleri geri almaz; sonuçları Git diff ile kontrol edin. Bu döngü yalnızca kullanıcı veya istemci aracı çağırdığında çalışır ve genel amaçlı özerk bir ajan değildir.

## GitHub'a uyarlama

Projedeki `.github/workflows/ci.yml` PR, push ve merge queue olaylarında Windows testlerini ve bağımlılık denetimini çalıştırır. PR şablonu da eklenmiştir. GitHub deposunda CI'yı zorunlu kontrol yapmak, insan onaylarını ve konuşma çözümlemesini zorunlu tutmak, eski onayları geçersiz kılmak ve merge queue'yu açmak repo yöneticisinin GitHub ayarlarını gerektirir. Bunlar yalnızca workflow dosyasıyla etkinleşmez.

`.github/workflows/ai-review.yml`, depo değişkeni `REVIEW_MODEL_ENDPOINT` tanımlanırsa her PR'da AI incelemesi başlatır, raporu artifact olarak saklar ve sonucu kontrol olarak döndürür. İsteğe bağlı `REVIEW_MODEL_NAME` değişkeni model adını belirler. `127.0.0.1:9931` GitHub'ın bulut runner'ında senin bilgisayarın değildir: runner'dan erişilebilir bir endpoint gerekir. Workflow PR koduyla sır paylaşmaz, özel API anahtarını desteklemez ve otomatik yorum göndermez. Değişken tanımlı değilse iş atlanır; zorunlu branch kontrolü ve güvenilir ağ geçidi ayrıca yapılandırılmalıdır. Workflow gerçek GitHub ortamında henüz test edilmedi.

GitHub CLI ile yerelde hazırlanmış bir incelemeyi PR'a yorum olarak göndermek için önce incelemeyi PR'ın güncel base commit'iyle çalıştırın ve JSON raporunu repo dışına yazın (`--json C:\workspace\review.json`). PR branch'i yerelde checkout edilmiş, çalışma ağacı temiz ve `gh` ilgili depoda yetkili olmalıdır:

```powershell
node publish-pr-review.mjs --cwd 'C:\path\to\repo' --pr 123 --json 'C:\workspace\review.json'
# Önizleme doğruysa aynı komutun sonuna --publish eklenebilir.
```

Yayın aracı PR'ın base ve head commit'lerini, yerel çalışma ağacını ve diff özetini denetler; eksik inceleme göndermez. Yalnızca toplu yorum oluşturur, satır içi yorum, insan onayı, merge veya otomatik kapanış yapmaz. Bu özellik henüz gerçek PR üzerinde test edilmemiştir.

## İnceleme kalitesini ölçme

`node review-eval.mjs cases.json`, insan tarafından etiketlenmiş örneklerden recall ve precision hesaplar. Girdi bir dizidir; her öğe `{ "id": "1", "expected": [{ "file": "src/a.js", "line": 10, "category": "bug" }], "report": { "status": "findings", "findings": [...] } }` biçimindedir. Eşleştirme dosya ve varsa satır/kategori üzerinden yapılır; bu yaklaşık bir ölçümdür. Hazır gerçek hata veri seti veya otomatik zamanlama içermez.
