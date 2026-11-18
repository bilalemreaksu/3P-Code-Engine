# 3P Code Engine

Claude Desktop 3P için deneysel bir kod yürütme ve inceleme yığını:
bağımsız MCP sunucusu, broker tabanlı insan onayı, hook ve politika motoru,
auto mod ve yerel modele dayalı git fark incelemesi. Bu proje Anthropic'in
Claude Code ürününün parçası değildir.

## Bileşenler

v0.12: Node.js erişimi olmayan QuickJS yürütmesi, AST tabanlı son ifade
sonucu, varsayılan auto kurulumu ve yalnızca Code Mode araçları sunan
etkileşimli terminal. Docker ve Desktop 3P MCP desteği korunur.

| Bileşen | Açıklama |
| --- | --- |
| [Terminal](README-terminal.md) | Model araç listesini denetleyen oturum, auto, Ctrl+O, arka plan bildirimleri ve devam |
| [Code Mode](README-code-mode.md) | `code_execute` / `code_start` MCP araçları; JavaScript worker, politika/hook motoru, insan onay brokeri |
| [Güvenlik raporu](SECURITY.md) | Tehdit modeli, testle doğrulanmış garantiler, kalan risk ve OS izolasyonu |
| [Uyumluluk](CODE-MODE-COMPATIBILITY.md) | Claude Code'un Code Mode davranışlarına göre karşılaştırma ve canlı doğrulama durumu |
| [Kod incelemesi](README-review.md) | Yerel modele gönderilen git farkı, bağımsız doğrulama istekleri, risk tahmini ([inceleme yönergesi](REVIEW.md)) |

## Kurulum (Windows)

Node.js 24 veya üzeri gereklidir. Kurulum scripti sabit kullanıcı adı, proje
yolu veya Node dizini kullanmaz; her kullanıcı kendi hesabında çalıştırır:

```powershell
.\install-code-mode.ps1 -ModelEndpoint 'http://127.0.0.1:9931/v1' -ModelName 'model-adi'
```

Auto kurulumun varsayılanıdır; endpoint/model zorunludur. Tam denetimli
terminal için `npm run code -- --endpoint <url> --model <model>` kullanın.
Detaylar, API ve onay akışı için [README-code-mode.md](README-code-mode.md);
güvence ve sınırlar için [SECURITY.md](SECURITY.md).

## Test

```powershell
npm test
```

Gerçek stdio MCP istemcisi/sunucusu, broker onay akışı, hook'lar, transcript
görüntüleyici, inceleme motoru ve kurulum scripti bütünleşim testleri
çalıştırılır.
