# 3P Code Engine

Modelden bağımsız kod yürütme ve inceleme motoru: MCP sunucusu, etkileşimli
terminal, QuickJS JavaScript yürütmesi, paralel araç çağrıları ve arka plan
işleri. Varsayılan `autoApprove` insan onayı veya sınıflandırıcı çağrısı
olmadan çalışır. Bu proje Anthropic'in Claude Code ürününün parçası değildir.

## Bileşenler

v0.12: Node.js erişimi olmayan QuickJS yürütmesi, AST tabanlı son ifade
sonucu, varsayılan onaysız kurulum ve yalnızca Code Mode araçları sunan
etkileşimli terminal. Docker ve Desktop 3P MCP desteği korunur.

Terminal OpenAI uyumlu API'lere, Anthropic Messages ve Gemini generateContent
API'lerine bağlanır. Native araç çağrısı olmayan modeller için JSON metin
protokolü vardır. Model adı kısıtlanmaz; modelin geçerli JavaScript/JSON
üretebilmesi gerekir. MCP yüzeyini kullanacak uygulamanın MCP desteği gerekir.

| Bileşen | Açıklama |
| --- | --- |
| [Terminal](README-terminal.md) | Üç API ailesi, native/metin protokolü, Ctrl+O, arka plan bildirimleri ve devam |
| [Code Mode](README-code-mode.md) | `code_execute` / `code_start` MCP araçları; JavaScript worker, otomatik onay ve politika/hook motoru |
| [Güvenlik raporu](SECURITY.md) | Tehdit modeli, testle doğrulanmış garantiler, kalan risk ve OS izolasyonu |
| [Uyumluluk](CODE-MODE-COMPATIBILITY.md) | Claude Code'un Code Mode davranışlarına göre karşılaştırma ve canlı doğrulama durumu |
| [Kod incelemesi](README-review.md) | Yerel modele gönderilen git farkı, bağımsız doğrulama istekleri, risk tahmini ([inceleme yönergesi](REVIEW.md)) |

## Kurulum (Windows)

Node.js 24 veya üzeri gereklidir. Kurulum scripti sabit kullanıcı adı, proje
yolu veya Node dizini kullanmaz; her kullanıcı kendi hesabında çalıştırır:

```powershell
.\install-code-mode.ps1
```

MCP kurulumu model endpoint'i gerektirmez; modeli bağlanan uygulama seçer.
Eski kurulumu scriptle güncelleyin ve istemciyi yeniden başlatın. Terminal
için önce `npm run code -- --enable --cwd <proje>`, ardından
`npm run code -- --endpoint <url> --model <model> --cwd <proje>` kullanın.
Detaylar ve API için [README-code-mode.md](README-code-mode.md);
güvence ve sınırlar için [SECURITY.md](SECURITY.md).

## Test

```powershell
npm test
```

Gerçek stdio MCP istemcisi/sunucusu, broker onay akışı, hook'lar, transcript
görüntüleyici, inceleme motoru ve kurulum scripti bütünleşim testleri
çalıştırılır.
