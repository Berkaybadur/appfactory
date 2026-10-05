# App Factory V1

OpenAI bağlantılı Türkçe bir panel üzerinden mobil ve web uygulaması üretir.

## Çalıştırma

Node.js 22.14+ ve pnpm 10.28.2 gerekir.

```sh
corepack enable
pnpm install
pnpm dev
```

Ayrı terminalde:

```sh
pnpm dev:worker
```

Panel: http://127.0.0.1:3000 · Worker: http://127.0.0.1:4001/health.

Supabase veya AI anahtarı gerekmez. `WORKER_PORT` değiştirilirse hem web hem worker aynı değeri kullanmalıdır. Web için `apps/web/.env.local`, worker için terminal ortam değişkeni kullanın. `.env.example` örnekleri içerir. `pnpm` komutu yoksa `corepack enable` ile etkinleştirin.

## İş akışı

1. Yeni proje oluşturun. API anahtarı varsa AI Planner analizi başlar; yoksa ücretsiz yerel örnek plan açılır. Plan sayfasında AI taslağını inceleyip projeye uygulayın.
2. Planı onaylayın; ekranları seçip başlık ve açıklamalarını kaydedin. Tasarım sayfasında seçilen her ekranı inceleyip tasarımı onaylayın.
3. Geliştirme sayfasında **Expo projesini üret** düğmesine basın.
4. **Bağımlılıkları kur ve kontrolleri çalıştır** düğmesi npm bağımlılıklarını kurar; gerçek `tsc --noEmit` ve ESLint çalıştırır.
5. Gerçek sonuçlar ve işlem logları Testler sayfasında görünür. Kod kontrollerinden sonra Android/iOS Expo Go smoke testleri tamamlanır; yalnızca tüm hedef platformların tasarım ve işlev raporları onaylandığında Derleme aşamasına geçilir.
6. Geliştirme/Testler/Derleme sayfasında **Expo önizlemesini başlat** düğmesini kullanın. Telefonla aynı Wi-Fi ağına bağlanın ve QR kodunu Expo Go ile açın. SDK 57 uyumlu Expo Go ve iPhone için panelde bağlı Expo hesabıyla giriş gerekir.
7. Telefonda kontrol ettiğiniz platformu seçip önizlemeyi onaylayın. EAS build ancak bu kod sürümü için onay varsa başlatılabilir; onay build işlemini kendiliğinden başlatmaz.

Üretilen uygulama seçtiğiniz ekranlardan oluşan **genel bir başlangıç şablonudur**. Ana ekran zorunludur; kayıt oluşturma, kayıt düzenleme, ayarlar ve kayıt ol ekranı seçilebilir. Kayıt ol yalnızca ad/e-posta alanları bulunan bir arayüz prototipidir; hesap oluşturmaz veya veri göndermez. Seçilmeyen ekranların route dosyaları üretilmez. AsyncStorage ile yerel veri saklar. Fikre özel iş mantığı AI tarafından yazılmaz. Typecheck/lint başarısı APK, cihaz testi veya mağaza yayını anlamına gelmez. EAS/Android derlemesi bağlı değildir; ücretli işlem başlatılmaz.

## Veri ve işler

### Expo Go smoke testi ve onaylı düzeltme

Testler sayfasında çalışan kod sürümünü seçip Expo önizlemesini başlatın. Aynı sürümü Android ve iOS cihazlarınızda Expo Go ile açın; projede seçili her platform için ayrı kayıt tutulur.

1. **Tasarım:** Smoke testi başlatın ve her ekranın o cihazdan alınmış PNG görüntüsünü yükleyin (en fazla 10 MB). **Tasarımları karşılaştır ve sorun listesini oluştur** onaylı tasarım ile cihaz görüntüsünü AI ile karşılaştırır. Beklenen/gözlenen farklar ve iki görüntü raporda gösterilir. Bu görsel incelemedir; matematiksel piksel eşitliği ölçümü değildir.
2. Raporu inceleyin. Hata varsa **Sorunları gider** düğmesi mevcut Builder üzerinden ayrı bir revizyon üretir; rapor hazırlanırken kod kendiliğinden değiştirilmez. Yeni sürümü Expo Go’da açıp iki platformun testlerini yeniden yapın. Sorunsuz raporları ayrı ayrı onaylayın.
3. **İşlev:** Tüm hedef platformların tasarım raporları onaylanınca açılır. Ekran akışları, plan kapsamı, kabul kriterleri ve veri/hata davranışları için cihazda uyguladığınız adımları ve gözlediğiniz sonucu girin. Ekran kanıtı ekleyebilirsiniz. **İşlev testi raporunu oluştur** sonuçları listeler; aynı inceleme ve düzeltme akışı çalışır. Bu adımlar kullanıcı tarafından cihazda uygulanır; panel telefona otomatik tıklama göndermez.

Eksik, hatalı veya test edilemeyen kontroller başarı sayılmaz. Kod, tasarım referansı veya kapsam değişirse rapor onayları geçersizleşir. EAS işlemleri güncel smoke onaylarını sunucuda da kontrol eder. AI karşılaştırması proje bütçesine dahildir; bağlantı kesilirse belirsiz ücret korunur. Raporlar ve cihaz görüntüleri yerel `workspace/smoke/` klasöründe saklanır; diğer bilgisayarlara otomatik eşitlenmez. Proje silindiğinde bu kayıtlar da temizlenir.

### Üç bilgisayardan ortak proje kullanımı

Supabase ile ortak proje kaydı eklendi. Her bilgisayar aynı Supabase bağlantısını kullanır; ekip üyeleri kendi hesaplarıyla giriş yapar. Plan, ekran ve tasarım düzenlemeleri ortak çalışma alanına kaydedilir. Yerel projeler **Hesap ve bulut kaydı → Yerel projeleri ortak alana aktar** ile taşınır. Kurulum, üyelik SQL'i, çakışma yönetimi ve kapsam sınırları için [Supabase rehberi](supabase/README.md).

Supabase tablo/üyelik kurulumu tamamlanmadan bulut kaydı çalışmaz. Expo çalışma klasörleri ve QR oturumları yereldir. Tasarım PNG dosyaları ve üretilen uygulama kaynakları projenin private GitHub deposuyla paylaşılır (bkz. GITHUB-SYNC.md). Başka bilgisayarda ortak proje belgesinin görünmesi, o bilgisayarda kod çıktısı bulunduğu anlamına gelmez.

### Yerel mod ve üretim dosyaları

- Panel projeleri ve manuel onaylar bu tarayıcının `app-factory.projects.v1` localStorage kaydında saklanır. Tarayıcı verilerini temizlemek bunları kaldırır.
- Worker iş kayıtları `workspace/jobs/<proje-id>.json` içinde atomik olarak yazılır. Restart sırasında yarım kalan işler başarısız işaretlenir; otomatik tekrar yapılmaz.
- Çıktı `workspace/generated-projects/<proje-id>/<iş-id>/` altında ayrı dizine yazılır. Var olan dizinin üzerine yazılmaz; aynı üretim isteği mevcut işi döndürür.
- `project-memory.json` proje özetini ve bütçesini içerir. Üretim kayıtları, loglar ve çıktılar Git’e dahil edilmez.
- Worker tek seferde bir iş çalıştırır. Kurulum en fazla 6 dakika, her kod kontrolü en fazla 2 dakika sürer. Son 20.000 karakter log saklanır.
- Doğrulama başarısız olursa elle sınırsız yeniden denenebilir. Başarılı iş tekrar çalıştırılmaz. Başarısız dosya üretiminde eski çıktı korunur; yeni proje oluşturulabilir.
- Kurulum `npm install --ignore-scripts --no-audit --no-fund --fetch-retries=0` kullanır. Kullanıcı fikri bir komut veya kaynak kod olarak çalıştırılmaz; JSON olarak yazılır.
- Worker yalnızca loopback üzerinde dinler. Panel sunucusu, worker’ın ürettiği `workspace/.worker-token` ile haberleşir; token tarayıcıya verilmez. Bu kişisel yerel araçtır; internete dağıtım öncesinde kimlik doğrulama ve yetkilendirme eklenmelidir.

## Kontroller

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
```

Production build bu ortamda Turbopack’ın işlem bağlantısı hatası nedeniyle Next.js’in desteklediği `--webpack` seçeneğini kullanır. Geliştirme Turbopack ile çalışır. Worker esbuild ile bağımsız Node.js çıktısına derlenir; `pnpm --filter @app-factory/worker start` ile başlatılabilir.

## Paketler

- `apps/web`: Next.js App Router, Tailwind v4, shadcn/ui, React Hook Form; worker için yerel API köprüsü.
- `apps/worker`: kalıcı iş kuyruğu ve gerçek komut sonuçları.
- `packages/schemas`: Zod proje, iş ve istek şemaları.
- `packages/shared`: örnek içerikler, onay state machine’i ve maliyet ilkeleri.
- `packages/generator`: güvenli, ayrı dizine Expo şablon üretimi.
- `packages/database`: isteğe bağlı Supabase istemcisi. Kimlik bilgileri yoksa null döner.
- `packages/ai`: OpenAI Planner, Builder ve Expo ekran görüntülerini karşılaştıran tasarım Reviewer bağlantıları.
- `templates/expo-base`: Expo SDK 57 / Expo Router / TypeScript şablonu.
- `supabase/migrations`: ileride kalıcı proje veritabanı için ayrılmış dizin.

## Sonraki adımlar

Cihaz etkileşimlerinin otomasyonu ve smoke raporlarının bilgisayarlar arasında eşitlenmesi. AI görevlerinde ortak proje bütçesi uygulanır; elle yeniden deneme sayısı sınırsızdır. APK/EAS derlemesi ve cihaz doğrulaması ayrı aşamadır. V1 oyun üretmez.

## Sprint 3: düzenlenebilir plan ve tasarım

Plan sayfasında özet, kapsam maddeleri ve kapsam dışı açıklaması; Tasarım sayfasında renkler, köşe yuvarlaklığı ve ekran boşluğu düzenlenebilir. Kaydetmek yeni bir sürüm oluşturur; değişmeyen içerik sürüm artırmaz. Son 20 önceki sürüm salt okunur geçmişte saklanır. Bunlar da panel projeleri gibi bu tarayıcıda saklanır.

Plan değişikliği plan ve sonraki onayları, tasarım değişikliği tasarım ve sonraki onayları yeniler. Kaydedilmemiş içerik onaylanamaz. Bir sekmenin eski sürümü yeni sürümün üzerine yazamaz; bu durumda yenileme istenir.

Yeniden onaylanan sürüm için **Yeni sürümü üret** ayrı bir iş ve çıktı dizini oluşturur. Önceki iş kaydı `workspace/jobs/history/<proje-id>/<iş-id>.json` altında arşivlenir; önceki Expo klasörü korunur. Eski sürümün test sonucu güncel proje aşamasını ilerletmez.

Güncel plan `specification.json` ve `project-memory.json` dosyalarına aktarılır; plan özeti mobil ana ekranda kullanılır. Tasarım değerleri `src/theme.json` üzerinden Expo arayüzüne uygulanır. Builder onaylı görsellerden ekran kodu üretir; tüm kapsam maddeleri otomatik işlev koduna dönüşmez. Üretim isteği yalnızca güncel içeriği taşır, tüm sürüm geçmişini taşımaz.

## Geliştirmeden önce görsel inceleme

Tasarım sayfasında seçilen Expo ekranlarının gezilebilir, telefon çerçeveli HTML önizlemesi vardır. Ana ekranın boş/dolu listesi, örnek kayıt oluşturma/düzenleme ve ayarlar incelenebilir. Önizlemedeki veri gerçek uygulamaya yazılmaz. Renk, boşluk ve köşe değişiklikleri anında yansır; yerel cihaz kontrollerinin birebir ekran görüntüsü değildir.

Yeni tasarım onayları seçilen tüm ekranların ayrı ayrı incelenmesini gerektirir. Onay, incelenen ekranlarla birlikte geçerli sürüme kaydedilir. Plan/ekran/tasarım değişiklikleri görsel onayı da geçersiz kılar. Bu özellikten önce onaylanan projeler geriye dönük değiştirilmez. Ekran başlığı ve açıklaması önizleme ile Expo çıktısında aynı tanımlardan gelir. Ekran değişiklikleri projeyi ekran onayına döndürür. Mevcut projelerde varsayılan dört ekran korunur; kayıt ol seçeneği başlangıçta kapalıdır. Serbest bileşen ekleme ve gerçek kimlik doğrulama henüz yoktur.

## AI Planner kurulumu

`apps/worker/.env.example` dosyasını `apps/worker/.env` olarak kopyalayın ve `OPENAI_API_KEY` değerini yerel dosyaya ekleyin. Worker bu dosyayı başlangıçta okur; değişiklikten sonra yeniden başlatın. Anahtarı tarayıcıya, sohbete veya Git’e eklemeyin.

Planner, OpenAI Responses API üzerinden `gpt-4.1-mini-2025-04-14` modelini ve Structured Outputs kullanır. Resmî kaynaklar: [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [model ve fiyatlar](https://developers.openai.com/api/docs/models/gpt-4.1-mini). Yerel maliyet hesabı 23 Eylül 2026 tarihinde kontrol edilen standart giriş $0.40 / çıkış $1.60 (milyon token başına) değerlerini kullanır; fatura değildir ve fiyat değişiminde güncellenmelidir.

- Yalnızca proje adı, fikir ve platformlardan oluşan görev bağlamı gönderilir. Dosyalar ve sürüm geçmişi modele gönderilmez. İstekte `store: false` kullanılır.
- Plan, mevcut şablonlardan ekran seçimi, tasarım, önerilen alan/eylemler ve kabul kriterli geliştirme görevleri döner. Çıktı Zod ile doğrulanır.
- Görev başına toplam $0.10 ve proje bütçesi kontrol edilir. İstekten önce UTF-8 boyutu + ek pay ve 6.000 maksimum çıktı tokenı üzerinden bütçe ayrılır. Kullanım bilgisinde maliyet hesaplanır; belirsizse rezerv korunur.
- Başarısız analiz **elle** sınırsız yeniden denenebilir; yalnızca proje bütçesi sınırlar. Aynı proje için süren veya tamamlanmış analiz tekrar ücretlendirilmez. Bu sürümde proje başına bir Planner işi bulunur; tamamlanmış analizi yeniden üretme henüz yoktur.
- İşler `workspace/planner/<proje-id>.json` dosyalarında kalır. Yeniden başlatmada yarım kalan isteğin rezervi belirsiz harcama olarak tutulur. Anahtar ve sağlayıcı hata gövdeleri kaydedilmez.
- Taslak uygulandığında yeni sürüm ve plan onayı oluşur. Eski taslak yeni düzenlemelerin üzerine yazılamaz. Taslak projede ve üretim belleğinde saklanır.
- Özel alan/eylem önerileri **henüz çalışan kod veya birebir görsel önizleme değildir**. Önizleme mevcut beş ekran şablonunu kullanır. Görevler Geliştirme sayfasında görünür; Görsel onayı bulunan projelerde Builder, mevcut yerel kayıt davranışını koruyarak ekran kodunu üretir.

## Görsel tasarım onayı

Tasarım sayfasının ana görünümü artık AI görsel galerisidir. Seçili her ekran için tasarım yönü ve isteğe bağlı değişiklik talebiyle bir PNG üretilir. Ekranlar kod veya şablon etkileşimleri üzerinden değil, görsel taslaklar üzerinden onaylanır. Önceki şablon önizlemesi kapalı bir ayrıntı bölümünde durur.

- Worker mevcut OPENAI_API_KEY ile Image API kullanır. GPT Image 2, medium kalite, 1024×1536 PNG; ekran başına tek çağrı. Model erişimi/kuruluş doğrulaması hesapta gerekli olabilir.
- Her çağrıda $0.20 ve onaylı referans başına ek $0.05 yerel bütçe rezervi ayrılır; toplam düğmede gösterilir. Bu, sağlayıcının kesin fatura limiti değildir. Metin ve görsel girdi tokenları ayrı fiyatlarla hesaplanır; kullanım ayrıntıları eksikse rezerv belirsiz harcama olarak korunur. Proje bütçesi ve Planner harcaması birlikte kontrol edilir. [Resmî fiyatlandırma](https://developers.openai.com/api/docs/pricing) ve [görsel üretim rehberi](https://developers.openai.com/api/docs/guides/image-generation).
- Ekran bazındaki onaylar proje kaydında saklanır. Ana sayfa onaylandıktan sonra Ayarlar onu; Ayarlar da onaylandıktan sonra Kayıt ekranı ikisini referans alır. Üretimde onaylı Ana sayfa ve onay sırasına göre son iki güncel diğer ekran kullanılır; en fazla üç benzersiz PNG gönderilir. Diğer ekranların onayları proje kaydında korunur. Onaylanmamış, devre dışı, eski sürüme ait veya yeniden üretilmiş bir ekranın eski taslağı kullanılmaz. Üretilen ekranın kendisi referans listesinden çıkarılır.
- İlk görsel metinden üretilir; referans varsa onaylı PNG dosyaları [Images Edits API](https://developers.openai.com/api/reference/resources/images/methods/edit) isteğine eklenir. Renk, tipografi, ikonlar, boşluklar, butonlar ve ortak gezinme bileşenlerinin korunması istenir. Üçten fazla referans API çağrısından önce reddedilir; tüm ekranları içeren pafta oluşturulmaz. Görsel iş kaydı kullanılan referans kimliklerini içerir. Eksik referans dosyası ücretli istekten önce hata verir.
- Bir ekran için yeni taslak sayısı sınırlı değildir; her üretim elle istenir ve proje bütçesinden düşülür. Otomatik tekrar yoktur. Değişiklik isteği yeni bir taslak üretir; önceki dosyalar korunur. Referans kullanımı tutarlılığı yönlendirir; sonuçlar yine kullanıcı tarafından incelenip onaylanır.
- Görseller ve iş kayıtları workspace/design-images içinde tutulur ve projenin private GitHub deposuyla paylaşılır (bkz. GITHUB-SYNC.md). Sayfa yenileme yeniden ücretli çağrı başlatmaz.
- Her ekranın en güncel başarılı görseli incelenmeden toplu onay verilemez. Onay kaynak görsel kimliklerini kaydeder, proje sürümünü artırır ve geliştirmeyi açar. Proje değişince eski görsel onayı geçersiz kalır.
- Onaylanan görseller Expo çıktısındaki design-references klasörüne ve proje belleğine referans olarak aktarılır. **Geliştirme sayfasındaki Builder bu görselleri referans alır.** Görsel üzerindeki metin ve ikonlar da uygulama kodu değildir.

## Görsel referanslı Builder

- Geliştirme → Onaylı tasarımları kodla: her seçili ekran ayrı bir Responses API görevidir. Göreve yalnızca ilgili görsel, ekran dosyası, küçük ortak arayüzler ve proje özeti gönderilir.
- Çıktı ayrı bir Expo klasöründe oluşturulur. Her ekranın ardından gerçek TypeScript ve ESLint çalışır; ilk hatada durur. Elle yeniden deneme sınırsızdır; geçen ekranlar tekrar üretilmez.
- Çağrı başına $0.08 rezerv; otomatik tekrarlar ekran başına $0.24 ile sınırlıdır, elle tekrarlarda yalnızca proje bütçesi geçerlidir. Ortak proje bütçesi Planner/görsel/Builder maliyetlerini içerir. Belirsiz ücretler korunur.
- İşler workspace/builder içinde kalıcıdır. Yeniden başlatma otomatik API çağrısı yapmaz. Eski çıktı klasörleri korunur.
- Model yalnızca belirlenen ekran TSX dosyasını değiştirebilir; paket, kurulum komutu ve kontrol yapılandırmalarını değiştiremez. Kontroller ekran kodunu çalıştırmaz.
- Bu sürüm tasarım uygulaması ve mevcut yerel kayıt işlemleriyle sınırlıdır. Gerçek authentication, yeni backend entegrasyonları, görseldeki özgün illüstrasyonlar ve APK üretimi garanti edilmez. Kod kontrollerinin geçmesi görsel uyum veya cihaz testi anlamına gelmez.
- Görsel girişi: https://developers.openai.com/api/docs/guides/images-vision

## Expo Go önizleme yönetimi

Worker tek bir Expo Go LAN önizlemesini yönetir (8100–8149 arası boş port). Başlat/durdur, iOS ve Android manifest kontrolü, yerel QR üretimi ve Expo günlükleri paneldedir. Fast Refresh açıktır. Bilgisayar/worker açık kalmalıdır; worker kapanırken kendisinin başlattığı Metro sürecini sonlandırır. Yeniden açıldığında önizleme manuel başlatılır.

Cihaz onayı `workspace/previews` içinde kaynak işine ve kaynak dosyalarının SHA-256 özetine bağlı saklanır. Kod değişirse onay geçersizdir. Test edilmemiş diğer platform başarılı sayılmaz. Mevcut EAS geçmişi korunur, yeni build istekleri önizleme onayı gerektirir. Expo Go dışındaki özel native modüller ileride development build gerektirebilir. LAN dışından tünel erişimi bu sürümde yoktur.

## Ekran bazında AI revizyonu

Geliştirme, Testler ve Derleme sayfalarında **AI ile değişiklik iste** alanı vardır. Kontrolleri geçmiş kaynak sürüm ve açık ekran seçilir; en fazla 2000 karakterlik istek tek Builder görevine gider. Hem şablon çıktıları hem görselden üretilmiş ekranlar desteklenir. Referans görsel yoksa mevcut ekran tasarımı esas alınır.

Ekran listesindeki **Uygulama geneli** seçeneği birden fazla ekranı veya ortak işlevleri etkileyen istekler içindir. Önce tek bir görev `src/features/*` modüllerini (ve gerekiyorsa RLS içeren migration'ı) günceller; mevcut dışa aktarılan sözleşmeler korunur ve TypeScript/ESLint geçmezse değişiklik geri alınır. Aynı görev değişmesi gereken ekranları seçer; her ekran ardından kendi talimatıyla ayrı bir ekran görevi olarak yeniden kodlanır. Derleme sayfasındaki önizleme geri bildirimi de bu seçeneği kullanabilir.

Revizyon, kaynak dosyaları yeni iş klasörüne kopyalar; eski çıktıya dokunmaz. Yalnızca seçilen ekran dosyası AI tarafından değiştirilir. TypeScript/ESLint başarısızsa aday ekran geri alınır. Her çağrı için $0.08 rezervasyon ayrılır; elle yeniden deneme sayısı sınırsızdır ve yalnızca proje bütçesiyle sınırlanır. İş kimliği yinelenen gönderimleri engeller. Kurulum dosyaları, bağımlılıklar ve ortak modüller AI tarafından düzenlenmez.

Başarılı revizyonlar sürüm seçicisinde görünür; eski sürüme dönmek mümkündür. Yeni sürümün Expo önizlemesi ve kullanıcı onayı ayrı alınır. EAS build kendiliğinden başlamaz. API: GET/POST `/api/revisions`; iş kayıtları mevcut `workspace/builder` dizinindedir. Structured Outputs biçimi: https://developers.openai.com/api/docs/guides/structured-outputs

### Ekran yönetimi

Ekranlar sekmesinde en fazla 20 ekran tanımlanabilir. Ana ekran zorunludur; diğer ekranlar silinebilir. Kartlar başlangıçta kapalıdır; başlıktan veya Tümünü aç / Tümünü kapat düğmelerinden yönetilir. Yeni ekran otomatik açılır. Değişiklikler Ekranları kaydet ile ortak proje kaydına aktarılır ve ekran/tasarım onayları yenilenir. Mevcut üretilmiş çıktılar korunur. Özel ekranlar ayrı Expo rotası ve başlangıç içeriği alır; fikre özel davranışlar Builder aşamasında mevcut yetenekler kapsamında hazırlanır.

Kod üretimi (uygulama işlevleri, ekranlar ve tek ekran revizyonları) GPT-6 Luna kullanır: gpt-6-luna, medium reasoning, Standard servis katmanı. Planner modeli değişmez. Builder maliyeti milyon token başına 0.10 USD giriş / 0.50 USD çıkış üzerinden hesaplanır; belirsiz maliyet rezervi ve görev sınırları korunur. Kaynak: https://developers.openai.com/api/docs/models/gpt-6-luna (25 Eylül 2026).

### Demo testleri ve yayın tamamlama

Yeni Expo çıktılarında geliştirme önizlemesi Demo veri modunda açılır. Demo verileri temizleme ve gerçek moda geçiş kontrolleri bulunur. Demo kayıtları gerçek yerel depoya/backend'e yazılmaz; APK gerçek modda açılır. Builder uygulamaya özel örnekleri yalnızca demo modunda üretir. Önceden üretilmiş çıktılar otomatik değiştirilmez.

Derleme sekmesinde önizleme onayından sonra kurulum, bağlantı ve kabul testi maddeleri kullanıcı tarafından işaretlenir. Liste seçili kaynak ve dosya hash'ine bağlıdır; kod/bağlantı değişiklikleri onayları geçersizleştirir. Kayıtlar yerel workspace/release altında tutulur. Tüm maddeler tamamlanmadan EAS gönderimi worker tarafından engellenir. Gönderim hiçbir zaman otomatik değildir.

APK hazır olduktan sonra kullanıcı gerçek Android cihaz testini ayrıca onaylar. Tamamlanma kaydı yalnızca aynı kaynak dosyaları için tutulur; eski hash içermeyen EAS kayıtları tamamlandı olarak işaretlenemez. Model testleri gerçek cihaz veya backend kurulumu kanıtı değildir.

### Geliştirme görevlerinde yeniden deneme

Uygulama Builder görevleri ilk çağrıdan sonra en fazla iki otomatik tekrar yapar. Başarılı görevler tekrar çalışmaz; önceki hata tanısı sonraki çağrıya eklenir. Bütçe veya yerel hazırlık engellerinde ücretli tekrar yapılmaz. Başarısızlık sürerse panel model seçimi ve açık onay ister. Elle yeniden deneme sayısı sınırsızdır; her denemede ortak proje bütçesi kontrol edilir. Sayaç ve maliyet sıfırlanmaz.

Manuel seçenekler GPT-6 Luna ve GPT-4.1 mini. Model isteğe aktarılır; GPT-4.1 mini için reasoning parametresi gönderilmez. Standard token fiyatları sırasıyla $0.10/$0.50 ve $0.40/$1.60 (1M giriş/çıkış); otomatik tekrar limiti $0.24 ve deneme rezervi $0.08 değişmedi. Manuel onay proje bütçesini aşmaz.
Kaynaklar: https://developers.openai.com/api/docs/models/gpt-6-luna ve https://developers.openai.com/api/docs/models/gpt-4.1-mini (25 Eylül 2026).

### Üretilen uygulamaların GitHub paylaşımı

Builder çıktıları ve görev kayıtları **Yerel çıktıları GitHub’a gönder** ile private depoya yüklenir; başka bilgisayarda indirilip yerel kontrollerden geçirilerek devam edilir. Kurulum, PAT izinleri, çakışma davranışı ve kapsam için [GitHub paylaşım rehberi](GITHUB-SYNC.md).

### Proje silme

Tüm projeler listesindeki **Projeyi sil** düğmesi proje adını yazarak onay ister. Projenin bu bilgisayardaki üretilen dosyaları, görselleri, geçmiş sürümleri, iş/önizleme/derleme kayıtları, tarayıcı kopyaları, ortak Supabase proje kaydı (varsa eski görsel kayıtlarıyla birlikte) ve `GITHUB_OWNER/appfactory-<proje-id>` deposu kalıcı olarak silinir. Başka projeler, ekip üyelikleri ve çalışma alanı silinmez. Diğer bilgisayarlardaki indirilmiş dosyalar, dışa aktarılmış yedekler ve Expo hizmetindeki derlemeler bu bilgisayardan silinmez.

Önce [silme migration dosyasını](supabase/migrations/202609270001_project_deletion.sql) Supabase SQL Editor'da uygulayın; worker'ı yeniden başlatın. GitHub PAT, repo silme yetkisine sahip olmalıdır (fine-grained: Administration write; classic: delete_repo). Devam eden üretim/aktarım veya açık Expo önizlemesi varsa önce tamamlayın/durdurun. İşlem kısmen başarısız olursa kart korunur; aynı düğmeyle tekrar deneyin. Eski sekmelerin veriyi yeniden oluşturmasını engellemek için yalnızca proje kimliğini içeren silme işaretleri saklanır. Supabase kurulumu yoksa bulut kaydı silme adımı uygulanmaz.

### Veri modeli görevlerinde hedefli onarım

Veri modeli ve uygulama işlevlerinin varsayılan modeli GPT-5 mini (medium reasoning); ekran üretimi GPT-6 Luna olarak kalır. Son reddedilen aday varsa yeniden deneme yalnızca gerekli feature dosyalarının değişikliklerini ister. Worker değişmeyen dosyaları, SQL'i, kabul testlerini ve kapsam kaydını koruyarak sonucu birleştirir; tüm iş kuralı/TypeScript/ESLint kontrolleri tekrar çalışır. Hata halinde aday yine geri alınır. Strict ve noUncheckedIndexedAccess kuralları modele açıkça aktarılır.

Görev bağlamı 80 KB ile sınırlıdır. İlk üretim en fazla 16.000, hedefli onarım 10.000 çıkış token'ı ister (reasoning dahil). Otomatik tekrar limiti $0.24 ve deneme rezervi $0.08 değişmedi; belirsiz ücret sıfır kabul edilmez. GPT-5 mini Standard fiyatı 1M token başına $0.25 giriş / $2 çıkış: https://developers.openai.com/api/docs/models/gpt-5-mini (26 Eylül 2026). Eski görevlerin geçmiş model/maliyet kayıtları korunur; manuel onay ekranında GPT-5 mini seçilebilir. Model değişimi hatasız kod veya cihaz testi garantisi değildir.
