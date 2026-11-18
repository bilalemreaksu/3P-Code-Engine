# Güvenlik modeli

3P Code Engine modelin ürettiği JavaScript'i QuickJS içinde çalıştırır. Dosya, kabuk ve MCP erişimi denetimli yardımcılar üzerinden yapılır. Docker seçeneği dosya ve kabuk işlerine ek işletim sistemi izolasyonu sağlar. Uygulanacak yetki sınırını proje etkinleştirmesi, izin modu, politika ve çalıştırma ortamı birlikte belirler.

## Güvenilen yapılandırma

- Proje etkinleştirmesi kullanıcıya ait `CODE_MODE_DATA_DIR/settings.json` dosyasından okunur. Proje yolu açıkça kaydedilir. Dosya yoksa tüm projeler kapalı başlar. Bozuk ayar yürütmeyi durdurur.
- Politika kaynağı `CODE_MODE_POLICY_PATH` veya motorun [varsayılan politika dosyasıdır](code-mode-policy.json). Desktop'ta MCP sunucusunun ortamı, terminalde ise komut satırı ve ortam izin modunu belirler.
- Varsayılan `autoApprove`, insan onayı veya sınıflandırıcı çağrısı yapmaz. `ask` kararlarını otomatik geçer. Açık `deny` ve engelleyici hook'lar tüm modlarda uygulanır. `bypassPermissions`, açık `ask` kararlarını da uygular. [İzin modları ve öncelik sırası](README-code-mode.md#izin-modları)
- `auto` seçildiğinde sınıflandırıcı modele kod, çalışma dizini ve varsa gerçek terminal kullanıcı niyeti gönderilir. Hata veya geçersiz karar yürütmeyi engeller. Sınıflandırıcı sonuçları, değerlendirilen örnekler ve yapılandırılan model ile sınırlıdır.

## QuickJS sınırı

`code-mode-runtime.mjs`, model kodunu QuickJS WebAssembly çalışma ortamında yürütür. Host ve JavaScript bağlamı arasında araç argümanları ve sonuçları veri olarak aktarılır. JavaScript bağlamının doğrudan `process`, `require`, `Buffer`, `fetch` ve Node modüllerine erişimi yoktur. Acorn, son üst düzey ifadeyi ayrıştırır. Yürütmenin yapıldığı yer QuickJS bağlamıdır.

JavaScript belleği 64 MiB, stack 1 MiB ile sınırlıdır. Interrupt handler CPU döngülerini ve yürütücü toplam süreyi denetler. Ele alınmamış yardımcı hataları, JSON'a çevrilemeyen sonuçlar ve bağlam çalışırken zamanlayıcı hataları başarısız yürütme olarak döner. Bu sınırlar, motor veya platform hatalarından bağımsız bir güvenlik garantisi vermez.

## Kabuk ve dış araçlar

`run` ve etiketli kabuk şablonu `Bash` aracı olarak denetlenir. Kabuk programının kendi işlemleri ayrı `Read` veya `Write` çağrılarına dönüşmez. Örneğin `Write` kuralının reddettiği bir dosyaya, ayrıca izin verilen bir kabuk programı işletim sistemi yetkileriyle yazabilir. Komut desenleri ve salt okunur komut tespiti metin üzerinde çalışır. Her alt işlem için bir işletim sistemi erişim kuralı gerekiyorsa izolasyon da kullanılmalıdır.

Docker kapalıyken izin verilen kabuk ve host'ta başlatılan yardımcı programlar mevcut kullanıcı hesabının yetkileriyle çalışır. Bu kapsam proje dışı dosyaları, kullanıcı verisini, ağı ve yerel brokeri içerebilir. MCP protokolü onay kararı taşımaz. Host yetkisiyle çalışan ayrı bir program broker ile doğrudan iletişim kurabilecek durumdaysa tarayıcıdaki köken denetimi tek başına yeterli değildir.

`review_changes`, `review_and_fix` ve `reviewAfter` ayrı bir akış kullanır. İnceleme kontrolleri host kabuğunda çalışır. Docker worker ve Code Mode yardımcı kuralları bu komutlara uygulanmaz. Düzeltme aracı dosyaları host üzerinde değiştirir. [İnceleme sınırları](README-review.md#veri-ve-çalıştırma-sınırları)

## Docker sınırı

Her yürütme için tek kullanımlık Linux konteyneri açılır. Proje `/work` altında yazılabilir bağlanır. Worker imajı build girdilerinin hash'iyle seçilir. Motor veya imaj hazırlanamazsa yürütme hata verir. Host'un loopback adresindeki broker konuk loopback adresinde bulunmaz.

- Bağlanan projenin içindeki dosyalar konuk işlemlere açıktır. Güvenilen engine, çalışma verisi ve anahtar dizinlerini proje mount'undan ayrı tutmak sınırı korur.
- Konteynerin dış ağı açıktır. Disk izolasyonu, ağ çıkış filtresi sağlamaz.
- Politika, hook ve sınıflandırıcı denetimleri host'ta yapılır. Köprü, dış MCP çağrılarını denetler. Hook ve dış MCP programlarının kendi dosya ve ağ erişimleri host yetkileriyle sürer.
- İptal yürütücüye, bağlı host çağrılarına ve konteynere iletilir. Kendini ayırmış süreçlerin her ortamda sonlanma garantisi yoktur.

## Yerel onay brokeri

Onay gerektiğinde broker host'ta `127.0.0.1` üzerinde rastgele bir portta başlar. Bekleyen karar iş, araç, girdi, son tarih ve tek kullanımlık nonce ile ilişkilidir. İnsan kararını brokerin sayfasında verir. Tekrarlanan karar reddedilir. Süre aşımı, broker bağlantısının kaybı ve iptal bekleyen kararı geçersiz kılar.

`approvals.jsonl`, istek ve karar olaylarında SHA-256 zinciri tutar. Bu kayıt, bütün dosyayı yeniden yazabilecek yetkide bir host sürecine karşı harici bir doğrulama kaynağı sağlamaz. Onayların bekleme süresi ve yeniden kurulma davranışı [MCP kılavuzunda](README-code-mode.md#sınıflandırıcı-ve-onaylar) açıklanır.

## Çıktı ve kayıtlar

- Arka plan çıktı hook'u etkinse sonuç, günlük, olay ve yeni `state` yayımdan önce bekletilir. Hook engellerse daha önce uygulanmış dosya etkileri kalır.
- Yardımcı işlem kayıtları komutları, dosya yollarını ve düzenleme önizlemelerini içerebilir. Kabuk programının kendi içindeki dosya veya ağ işlemleri tek tek kaydedilmez.
- İş, yürütme durumu, konuşma ve onay kayıtları kullanıcı dizininde düz JSON veya JSONL olarak saklanır. Bu kayıtlar hassas veri içerebilir. Şifreleme veya otomatik saklama süresi uygulanmaz. Tamamlanan MCP işleri ve yürütme durumları ilgili silme araçlarından yönetilir. Terminal konuşması ayrı bir dosyadır.
- Model uç noktası kullanıcı konuşmasını ve aktarılan araç sonuçlarını, `auto` sınıflandırıcısı ise kod bloğunu ve sınırlı bağlamı alır. İnceleme uç noktası Git diff'ini, proje inceleme yönergelerini ve istenen kaynak parçalarını alabilir. Anahtarları güvenilen ortam değişkenlerinde tutun.

## Doğrulama

`npm test`, QuickJS sınırları, zaman aşımı, eşzamanlılık, MCP araç akışı, politika, hook'lar ve brokeri denetler. `npm run test:isolation:required` gerçek Linux Docker motoruyla sınırı zorunlu olarak sınar. Canlı sınıflandırıcı değerlendirmesi, kullanılan model ve senaryolar için kanıt sağlar. [Test kapsamı ve canlı kayıtlar](CODE-MODE-COMPATIBILITY.md#doğrulama-kayıtları)
