# Git değişikliklerini inceleme

İnceleme motoru bir Git tabanına göre değişiklikleri toplar, isteğe bağlı kontrolleri çalıştırır ve aday bulguları ayrı model istekleriyle doğrular. Çıktı bir risk tahmini, doğrulanan ve belirsiz bulgular, kontrol sonuçları ve kapsam uyarıları içerir. İnsan incelemesi ve GitHub birleştirme politikaları kendi süreçlerinde yürütülür.

## Hızlı başlangıç

Node.js 24+, Git ve OpenAI uyumlu bir model uç noktası gerekir. Varsayılan API tabanı `http://127.0.0.1:9931/v1` olur. `REVIEW_MODEL_NAME` verilmezse motor `/models` çıktısında tam bir model kimliği bekler. Birden fazla modelde veya model listeleme desteği bulunmadığında kimliği açıkça verin. Gerekirse `REVIEW_MODEL_API_KEY` kullanın.

Motorun depo kökünde çalıştırın.

~~~powershell
$env:REVIEW_MODEL_ENDPOINT = 'http://127.0.0.1:9931/v1'
$env:REVIEW_MODEL_NAME = 'MODEL_KIMLIGI'
$project = 'C:\Projects\uygulama'
npm.cmd run review -- --cwd $project --base HEAD --mode standard --intent 'Değişikliğin amacı' --check 'npm test'
~~~

`--base HEAD` çalışma ağacını mevcut commit ile karşılaştırır. Bir branch veya commit de kullanılabilir. Her `--check` ayrı bir gerçek kabuk komutu çalıştırır. `--auto-check`, proje kökündeki `package.json` içinde tanımlı `lint`, `typecheck`, `test` ve `build` komutlarını bu sırayla ekler. Diğer kontrolleri açıkça belirtin.

## İnceleme modu ve sonuç

| Mod | Bakış açısı sayısı | Aday bulgu başına doğrulama isteği |
| --- | --- | --- |
| `quick` | 2 | 1 |
| `standard` | 3 | 2 |
| `deep` | 4 | 2 |

İstekler tek model yuvasına uygun olarak sıralı çalışır. Her doğrulama istek bağlamı ayrıdır. Bir adayın bulgu sayılması için bütün doğrulama isteklerinde onaylanması gerekir. Görüşler ayrışırsa bulgu belirsiz kalır.

| Durum | CLI çıkış kodu | Anlamı |
| --- | --- | --- |
| `reviewed` | 0 | İnceleme tamamlandı ve onaylanmış bulgu kalmadı. |
| `findings` | 1 | İnceleme tamamlandı ve onaylanmış bulgu var. |
| `incomplete` veya hata | 2 | Kanıt, kapsam, kontrol veya model yanıtı incelemeyi tamamlamak için yetersiz. |

Hiç kontrol çalıştırılmadığında, bir kontrol başarısız olduğunda, çalışma ağacı değiştiğinde veya kapsama dair uyarı olduğunda rapor eksik sayılabilir. Sonuçtaki dosya ve satır numaralarını ayrıca inceleyin.

### Rapor ve inceleme geçmişi

~~~powershell
$reviewReport = Join-Path $env:TEMP '3p-review.md'
$reviewJson = Join-Path $env:TEMP '3p-review.json'
$reviewLedger = Join-Path $env:TEMP '3p-review-history.json'
npm.cmd run review -- --cwd $project --base HEAD --auto-check --report $reviewReport --json $reviewJson --ledger $reviewLedger
~~~

`--report` Markdown, `--json` makine tarafından okunabilir rapor, `--ledger` yerel inceleme geçmişi yazar. Her PR için ayrı bir geçmiş kullanın. Üçüncü turdan itibaren `limitReached` işaretlenir. `newFindingKeys` önceki kayıtlarda bulunmayan bulguları gösterir. Bu bilgi raporlama amaçlıdır.

## MCP

`review_changes` aracı `cwd`, `base`, `intent`, `mode` ve isteğe bağlı `checkCommands` ile `autoChecks` alır. `code_execute` için `reviewAfter` verildiğinde başarılı kod yürütmesinin ardından inceleme başlar. Kod yürütmesinin sonucuyla birlikte `review.status` alanını kontrol edin.

`review_changes`, `review_and_fix` ve `reviewAfter` MCP yüzeyinde `rules`, `bypassPermissions` veya `autoApprove` ile çalışır. Terminalin model araç listesi yürütme araçlarını içerir. Terminalden inceleme yapmak için ayrı `npm run review` komutunu kullanın.

## Otomatik düzeltme döngüsü

~~~powershell
npm.cmd run review:fix -- --cwd $project --base HEAD --auto-check
~~~

Komut veya `review_and_fix` aracı, tamamlanmış incelemenin ilk doğrulanmış bulgusu için modelden düzenleme ister. Döngü her turda yalnızca bulgudaki dosyayı ve tam bir kez eşleşen metni değiştirebilir. Ardından kontroller ve inceleme yeniden çalışır. En fazla üç inceleme turunda en fazla iki düzenleme yapılır. MCP çağrısı `maxRounds` değerini 1–3 arasında seçebilir.

Eksik inceleme, başarısız kontrol veya tur sınırı döngüyü durdurur. Önceki değişiklikler çalışma ağacında kalır. `review:fix`, yalnızca `reviewed` durumunda çıkış kodu 0 verir. Diğer durumlarda kod 2 döndürür. Son değişiklikleri `git diff` ile inceleyin.

## Veri ve çalıştırma sınırları

- İnceleme uç noktası Git diff'ini ve varsa kökteki `AGENTS.md`, `CLAUDE.md` ve `REVIEW.md` içeriğini alır. Model her inceleme ya da doğrulama isteğinde en fazla iki turda altışar küçük dosya parçası isteyebilir. Kanıt okumaları depo sınırı ve hassas ad filtresiyle kısıtlanır. Git diff'inde bulunan izlenen hassas veriler ayrıca ayıklanmaz.
- Uygun takip edilmeyen metin dosyaları 256 KiB'a kadar diff'e eklenebilir. Büyük, ikili, hassas adlı veya normal dosya olmayan girdiler raporun kapsamını daraltır. Git'in yok saydığı takip edilmeyen dosyalar değerlendirme dışında kalır. Çok büyük bir diff kesilir ve rapor eksik sayılır.
- Kontrol komutları host kabuğunda kullanıcı yetkileriyle çalışır ve dosya değiştirebilir. Code Mode yardımcı kuralları ile Docker worker izolasyonu bu akışa uygulanmaz. [Güvenlik modeli](SECURITY.md#kabuk-ve-dış-araçlar)

## GitHub

[CI iş akışı](.github/workflows/ci.yml), PR, push ve merge queue olaylarında Windows ve Ubuntu üzerinde test ve bağımlılık denetimi yapar. Ubuntu'da ayrı bir zorunlu Docker izolasyon işi çalışır. Zorunlu kontroller ve insan onayı gibi kurallar GitHub depo ayarlarında yönetilir.

[AI inceleme iş akışı](.github/workflows/ai-review.yml), depo değişkeni `REVIEW_MODEL_ENDPOINT` ayarlandığında PR'ın head commit'ini base commit'e göre inceler. `REVIEW_MODEL_NAME` isteğe bağlıdır. Uç nokta GitHub runner'ından erişilebilir olmalıdır. Yerel `127.0.0.1` yalnızca komutun çalıştığı makineyi gösterir. İş akışı model anahtarı almaz, Markdown ve JSON çıktılarını artifact olarak saklar ve inceleme sonucunu kontrol durumuna yansıtır.

### PR yorumunu önizleme ve yayımlama

PR'ın güncel base commit'iyle inceleme yapın. JSON raporunu repo dışına yazın. Yerel çalışma ağacı temiz ve `gh` ilgili depoda yetkili olmalıdır.

~~~powershell
node publish-pr-review.mjs --cwd $project --pr 123 --json $reviewJson
~~~

Komut PR'ın base ve head commit'lerini, yerel çalışma ağacını ve diff özetini doğrular. Önizlemeyi inceledikten sonra `--publish` eklemek toplu PR inceleme yorumu gönderir. Tamamlanmış ve belirsiz bulgusu kalmamış raporlar yayımlanabilir.

## İnceleme kalitesini ölçme

`node review-eval.mjs cases.json`, insan tarafından etiketlenmiş örnekler üzerinden precision ve recall hesaplar. Girdi, her biri `id`, `expected` ve `report` alanları taşıyan bir JSON dizisidir. Eşleştirme dosyaya ve belirtilmişse kategori ile satıra dayanır. `report.findings` üretilen bulguları içerir. Ölçümün kapsamı etiketlerin ve eşleştirme alanlarının kapsamıyla sınırlıdır. [İnceleme yönergesi](REVIEW.md)
