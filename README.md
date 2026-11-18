# 3P Code Engine

3P Code Engine, modelin ürettiği JavaScript ile birden fazla araç çağrısını tek yürütmede birleştirir. Dosya ve kabuk işlemlerini sıralayabilir, bağımsız çağrıları paralel çalıştırabilir ve modele kısa bir sonuç döndürebilir. Proje bir MCP sunucusu, etkileşimli bir terminal ve Git değişikliklerini inceleyen ayrı bir araç sunar.

| Kullanım | Başlangıç noktası |
| --- | --- |
| Claude Desktop 3P veya başka bir MCP istemcisi | [MCP kurulumu ve API](README-code-mode.md) |
| Qwen, yerel bir model veya başka bir sağlayıcı ile doğrudan konuşma | [Terminal kurulumu](README-terminal.md) |
| Git diff incelemesi, rapor ve düzeltme döngüsü | [Kod inceleme kılavuzu](README-review.md) |
| Claude Code Code Mode ile farklar ve test kanıtları | [Uyumluluk ve doğrulama](CODE-MODE-COMPATIBILITY.md) |
| QuickJS, Docker ve izin sınırları | [Güvenlik modeli](SECURITY.md) |

## Hızlı başlangıç

Node.js 24 veya üzeri gerekir. Aşağıdaki komutları motorun depo kökünde çalıştırın. Örnekler Windows PowerShell içindir.

~~~powershell
npm.cmd ci
~~~

### Claude Desktop 3P

Windows kurulumunda Linux konteynerleri çalıştıran Docker Desktop kullanabilirsiniz. Komuttaki `-ConfigPath`, MCP kaydının ekleneceği Desktop 3P dosyasını seçer. `$project` değişkenini Code Mode ile açmak istediğiniz proje dizinine ayarlayın.

~~~powershell
$desktopConfig = Join-Path $env:LOCALAPPDATA 'Claude-3p\claude_desktop_config.json'
$project = 'C:\Projects\uygulama'
.\install-code-mode.ps1 -ConfigPath $desktopConfig -Isolation docker
npm.cmd run code -- --config $desktopConfig --enable --cwd $project
~~~

MCP kaydı eklendikten sonra Desktop'ı tamamen kapatıp açın. Proje tercihi kullanıcı ayarına kaydedilir ve sonraki açılışlarda okunur. Desktop çalışırken etkinleştirme tercihi yeni yürütmelerde de okunur. Model, sohbet sırasında `3p-code-mode` sunucusunun aracını ne zaman çağıracağına karar verir. İlk çağrıyı ve Basalt/Qwen örneğini [MCP kılavuzunda](README-code-mode.md) bulabilirsiniz.

### Bağımsız terminal

~~~powershell
$project = 'C:\Projects\uygulama'
npm.cmd run code -- --enable --cwd $project
npm.cmd run code -- --endpoint http://127.0.0.1:9931/v1 --model 'MODEL_KIMLIGI' --cwd $project --isolation docker
~~~

`MODEL_KIMLIGI` yerine model sunucusunun sunduğu API kimliğini girin. Terminal OpenAI uyumlu API, Anthropic Messages ve Gemini generateContent bağdaştırıcılarını destekler. Protokol ve sağlayıcı seçenekleri [terminal kılavuzunda](README-terminal.md#model-bağlantısı) açıklanır.

Taze kurulumun izin modu `autoApprove`'dur. Bu modda kullanıcı onayı veya sınıflandırıcı çağrısı yapılmaz. Açık `deny` kuralları ve engelleyici hook'lar uygulanır. Proje etkinleştirmesi, izin modu ve Docker birbirinden bağımsız ayarlardır. [İzin modları](README-code-mode.md#izin-modları)

## Testler

~~~powershell
npm.cmd test
npm.cmd run test:isolation:required
~~~

İlk komut yerel bütünleşim testlerini çalıştırır ve yerel TCP bağlantıları gerektirir. İkinci komut gerçek bir Linux Docker motoru bekler. Canlı modeli ayrı bir komutla test etmek için [doğrulama kılavuzunu](CODE-MODE-COMPATIBILITY.md#testleri-yeniden-çalıştırma) kullanın.

Proje MIT lisanslıdır. [Lisans](LICENSE)
