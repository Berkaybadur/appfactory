# Ortak Supabase çalışma alanı

Üç kişi App Factory'yi kendi bilgisayarında çalıştırır. Hepsi aynı Supabase projesini kullanır; her kişi kendi e-posta/parolasıyla giriş yapar. Üyeler aynı proje listesini görür ve düzenleyebilir. App Factory yayını gerekmez; Supabase bağlantısı için internet gerekir.

## Hazır ekip hesabıyla giriş

App Factory açılışında yalnızca giriş ekranı görünür. Panel, proje menüsü ve proje sayfaları oturum açılmadan oluşturulmaz; doğrudan proje bağlantıları da giriş ekranını gösterir. Geçerli oturum geri yüklendiğinde içerik açılır, çıkış yapıldığında giriş ekranına dönülür. Supabase yapılandırması eksikse yerel panel yerine kurulum uyarısı gösterilir. Önceden kalan yerel projeler silinmez; girişten sonra ortak alana aktarılabilir.

Yönetici hesabınızı önceden eklediyse **Hesap ve bulut kaydı → E-posta ile giriş bağlantısı gönder** kullanın. Parola gerekmez; bağlantıyı App Factory'nin çalıştığı bilgisayarda açın. E-posta gönderimi ancak bu düğmeye basılınca istenir. Supabase Auth yönlendirme adresleri her yerel kurulum için `http://127.0.0.1:3000` ve `http://localhost:3000` adreslerine izin vermelidir. Parolalı giriş mevcut parolası olan hesaplar için de kullanılabilir.

25 Eylül 2026'da canlı Supabase tabloları doğrulandı, ortak çalışma alanına üç ekip hesabı eklendi ve tarayıcıdan dışa aktarılan üç proje yazılıp birebir geri okundu. Anonim erişim engellendi. E-posta teslimi ve üç ayrı bilgisayardan kullanıcı girişi henüz doğrulanmadı. Üretilen Expo dosyaları bu aktarımda yer almaz.

## Bir defalık kurulum

1. Supabase SQL Editor'da `migrations/202609250001_projects.sql` dosyasını çalıştırın. Tablolar, RLS politikaları ve sürüm kontrollü kayıt fonksiyonu birlikte oluşturulur.
   Ardından `migrations/202609270001_project_deletion.sql` dosyasını uygulayın. Bu migration çalışma alanı üyelerinin proje silmesini ve silinen kimliklerin eski sekmelerden yeniden kaydedilmesini engelleyen denetimi ekler. Mevcut kurulumlarda yalnızca yeni migration gerekir. Silme RPC'si bulunmadığında proje silme işlemi dış kaynaklara dokunmadan hata verir.
2. Her bilgisayarda kök `.env` veya `apps/web/.env.local` içine aynı `NEXT_PUBLIC_SUPABASE_URL` ve `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` değerlerini yazın. Web sunucusunu yeniden başlatın; production kullanımında `pnpm build` tekrar gereklidir. Service-role anahtarını ekip üyelerine dağıtmayın; normal kullanım bu anahtarı gerektirmez.
3. App Factory'de **Hesap ve bulut kaydı → Hesap oluştur** alanını kullanın. Supabase e-posta doğrulaması açıksa e-postayı doğrulayın. Supabase Auth URL Configuration'da yerel `http://127.0.0.1:3000` / `http://localhost:3000` adreslerini tanımlayın.
4. Yönetici SQL Editor'da bir çalışma alanı oluşturup üç hesabı üye yapar. Aşağıdaki örnek adresleri değiştirin; üç kullanıcı da önce kayıt olmuş olmalıdır:

```sql
do $$
declare team_id uuid;
begin
  if (select count(*) from auth.users where lower(email) in
    ('bir@example.com', 'iki@example.com', 'uc@example.com')) <> 3 then
    raise exception 'Önce üç hesabı da oluşturun; adresleri kontrol edin.';
  end if;
  insert into public.factory_workspaces(name) values ('App Factory Ekibi') returning id into team_id;
  insert into public.factory_workspace_members(workspace_id, user_id)
    select team_id, id from auth.users where lower(email) in
      ('bir@example.com', 'iki@example.com', 'uc@example.com');
end $$;
```

Bu kurulum bloğunu bir kez çalıştırın. Üyelik yönetimi yalnızca yöneticiye aittir; kullanıcı kendine veya başkasına üyelik ekleyemez. V1 hesap başına bir ortak çalışma alanı destekler. Kayıt olan dördüncü bir hesap projeleri göremez.

## Mevcut projeleri taşıma ve eşitleme

- Mevcut tarayıcıda giriş yapın, **Yerel projeleri ortak alana aktar** düğmesine basın. Yerel kopya silinmez. Aynı kimlikli bulut projesi değiştirilmez; farklı yerel kopyalar birleştirilmez.
- Yeni proje ve plan/ekran/tasarım güncellemeleri ortak alana gönderilir. **Supabase · Kaydedildi** durumunu görmeden bulut kaydının tamamlandığını varsaymayın.
- Diğer bilgisayarlar listeyi 15 saniyede bir ve pencere odağı geri geldiğinde yeniler. **Buluttan yenile / yeniden dene** de kullanılabilir.
- Sürüm kontrolü eski cihazın yeni kaydı ezmesini engeller. Çakışmada önce bekleyen değişiklikleri indirin, sonra bulut sürümünü yükleyin ve değişikliği yeniden uygulayın.
- Ağ hatasında bekleyen kayıtlar hesap ve sekmeye özel yerel depolamada korunur. Aynı sekmeyi yeniden yüklemek kuyruğu kurtarır. Tarayıcı depolaması temizlenirse gönderilmemiş değişiklikler kaybolabilir. İndirilen JSON kurtarma kopyasıdır; otomatik JSON birleştirme yoktur.
- Giriş yapılmadan panel açılmaz. Supabase yapılandırması eksikse giriş ekranında açıklama gösterilir; mevcut yerel veriler silinmez.

## Ortak ve yerel veriler

Ortak: proje adı/fikri, aşama, bütçe/maliyet bilgisi, plan, ekranlar, tasarım tercihleri, plan taslağı ve belge sürüm geçmişi.

Yerel: worker işleri, Expo kaynak klasörleri, QR/Metro süreçleri, cihaza bağlı önizleme onayı ve EAS iş dosyaları. Tasarım PNG dosyaları ve başarılı görsel iş kayıtları proje ile aynı private GitHub deposunda paylaşılır; Supabase görsel dosyası saklamaz. Başka bilgisayarda proje tanımlarını düzenlemek mümkündür; aynı üretilmiş uygulamayı çalıştırmak için kaynakları ayrıca taşımak veya yeniden üretmek gerekir. Üretilen uygulamanın AsyncStorage kullanıcı verisi bu değişikliğe dahil değildir.

## Doğrulama

`pnpm test` mock repository ile iki cihaz çakışması, ağ hatasından kurtarma, kayıt sırasında yeni düzenleme, depolama hatası ve oturum sonrası yanıt testlerini içerir.

Migration yerel PGlite PostgreSQL motorunda da çalıştırıldı: üç üyenin okuma/yazması, üye olmayan ve anonim kullanıcının engellenmesi, üyelik tablosunun korunması, eski sürümün reddi ve kayıp yanıtın güvenli tekrarı doğrulandı. Bu canlı Supabase Auth testi değildir.

Erişim modeli Supabase'in [RLS belgelerini](https://supabase.com/docs/guides/database/postgres/row-level-security) izler. Service-role/secret anahtarı tarayıcı kodunda kullanılmaz.

### Hesap işlemleri

Üç mevcut ekip hesabı yönetici API'siyle doğrulanmıştır; parola ile girişte e-posta onayı beklemez. Bu işlem proje genelindeki yeni kullanıcı kayıt politikasını değiştirmez. Başlangıç parolaları kaynak kodda tutulmaz. Parola değiştirme ve çıkış, sağ üstteki Ortak çalışma alanı menüsündedir. Bulut kaydı ve işlemleri bölümü yalnızca proje eşitleme ve yedekleme işlemlerini içerir. E-posta bağlantısı sekmesi görünür ancak pasiftir; login-form.tsx içindeki emailLinkEnabled özelliği daha sonra etkinleştirilebilir.

## Paylaşılan tasarım görselleri

Görseller için Supabase base64 paylaşımı kaldırıldı. Worker, mevcut GITHUB_TOKEN ve GITHUB_OWNER ayarlarıyla PNG dosyalarını projenin private GitHub deposuna gönderir. Görsel paylaşımı için Supabase service-role anahtarı veya görsel tablosu kurulumu gerekmez. Proje belgeleri ve üyelikler Supabase üzerinden paylaşılmaya devam eder.

Tasarım sayfasını görsellerin bulunduğu bilgisayarda açmak, mevcut yerel dosyaları da GitHub'a aktarır. Diğer bilgisayarda aynı sayfa eksik görselleri indirir. Yeni görsel üretimi gerekmez. Ayrıntılar: [GitHub paylaşımı](../GITHUB-SYNC.md).

Eski factory_design_assets tablosu daha önce oluşturulduysa kayıtları yerinde kalır; uygulama bu tabloyu artık okumaz veya güncellemez. Bu değişiklik canlı veritabanında veri silmez.
