# 3P Code Engine

Claude Desktop 3P için deneysel bir kod yürütme ve inceleme yığını:
bağımsız MCP sunucusu, broker tabanlı insan onayı, hook ve politika motoru,
auto mod ve yerel modele dayalı git fark incelemesi. Bu proje Anthropic'in
Claude Code ürününün parçası değildir.

## Bileşenler

| Bileşen | Açıklama |
| --- | --- |
| [Code Mode](README-code-mode.md) | `code_execute` / `code_start` MCP araçları; JavaScript worker, politika/hook motoru, insan onay brokeri |
| [Güvenlik raporu](SECURITY.md) | Tehdit modeli, testle doğrulanmış garantiler, kalan risk ve OS izolasyonu |
| [Uyumluluk](CODE-MODE-COMPATIBILITY.md) | Claude Code'un Code Mode davranışlarına göre karşılaştırma ve canlı doğrulama durumu |
| [Kod incelemesi](README-review.md) | Yerel modele gönderilen git farkı, bağımsız doğrulama istekleri, risk tahmini ([inceleme yönergesi](REVIEW.md)) |

## Kurulum (Windows)

Node.js 24 veya üzeri gereklidir. Kurulum scripti sabit kullanıcı adı, proje
yolu veya Node dizini kullanmaz; her kullanıcı kendi hesabında çalıştırır:

```powershell
.\install-code-mode.ps1
```

Detaylar, API ve onay akışı için [README-code-mode.md](README-code-mode.md);
güvence ve sınırlar için [SECURITY.md](SECURITY.md).

## Test

```powershell
npm test
```

Gerçek stdio MCP istemcisi/sunucusu, broker onay akışı, hook'lar, transcript
görüntüleyici, inceleme motoru ve kurulum scripti bütünleşim testleri
çalıştırılır.
