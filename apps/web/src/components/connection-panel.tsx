"use client";
import { useEffect, useRef, useState } from "react";
import {
  appConnectionSchema,
  type AppConnection,
  type Project,
} from "@app-factory/schemas";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";

async function connectionRequest(
  project: Project,
  sourceJobId: string,
  connection?: AppConnection,
) {
  const r = await fetch("/api/connection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project: { ...project, revisions: [] },
      sourceJobId,
      ...(connection ? { connection } : {}),
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "Bağlantı bilgisi alınamadı.");
  return {
    available: data.available === true,
    connection: appConnectionSchema.parse(data.connection),
  };
}

export function ConnectionPanel({
  project,
  sourceJobId,
}: {
  project: Project;
  sourceJobId: string | null;
}) {
  const [available, setAvailable] = useState<boolean | null>(null),
    [saved, setSaved] = useState<AppConnection | null>(null),
    [url, setUrl] = useState(""),
    [publishableKey, setPublishableKey] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const latestProject = useRef(project);
  useEffect(() => {
    latestProject.current = project;
  }, [project]);
  function apply(result: Awaited<ReturnType<typeof connectionRequest>>) {
    setAvailable(result.available);
    setSaved(result.connection);
    setUrl(result.connection.url);
    setPublishableKey(result.connection.publishableKey);
  }
  useEffect(() => {
    if (!sourceJobId) return;
    let closed = false;
    connectionRequest(latestProject.current, sourceJobId)
      .then((result) => {
        if (closed) return;
        setAvailable(result.available);
        setSaved(result.connection);
        setUrl(result.connection.url);
        setPublishableKey(result.connection.publishableKey);
      })
      .catch((e: unknown) => {
        if (!closed)
          setError(
            e instanceof Error ? e.message : "Bağlantı bilgisi alınamadı.",
          );
      });
    return () => {
      closed = true;
    };
  }, [sourceJobId]);
  async function save(connection: AppConnection) {
    setPending(true);
    setError("");
    setNotice("");
    try {
      const parsed = appConnectionSchema.safeParse(connection);
      if (!parsed.success)
        throw new Error(
          parsed.error.issues[0]?.message ?? "Bağlantı bilgileri geçersiz.",
        );
      if (!sourceJobId) throw new Error("Önce çalışan bir sürüm seçin.");
      apply(
        await connectionRequest(
          latestProject.current,
          sourceJobId,
          parsed.data,
        ),
      );
      setNotice(
        parsed.data.url
          ? "Bağlantı bu sürüme kaydedildi. Açık önizlemeyi yeniden başlatıp telefonda kontrol edin; önceki önizleme onayı geçersiz sayılır."
          : "Bağlantı kaldırıldı. Uygulama backend gerektiren işlemlerde kurulum uyarısı gösterir.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bağlantı kaydedilemedi.");
    } finally {
      setPending(false);
    }
  }
  const connected = !!saved?.url;
  const changed =
    url.trim() !== (saved?.url ?? "") ||
    publishableKey.trim() !== (saved?.publishableKey ?? "");
  return (
    <details className="rounded-xl border bg-card py-6 text-card-foreground">
      <summary className="mx-6 cursor-pointer [&>[data-slot=card-header]]:inline-grid [&>[data-slot=card-header]]:w-[calc(100%-1.5rem)] [&>[data-slot=card-header]]:px-0 [&>[data-slot=card-header]]:align-top">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="leading-6">
              Uygulama bağlantısı · Supabase
            </CardTitle>
            <Badge variant="secondary">
              {available === false
                ? "Gerekmiyor"
                : connected
                  ? "Bağlı"
                  : "Bağlantı yok"}
            </Badge>
          </div>
          <CardDescription>
            Üretilen uygulamanın kullanacağı Supabase adresi ve publishable
            anahtarı. Seçili sürümün src/runtime/connection.json dosyasına
            yazılır.
          </CardDescription>
        </CardHeader>
      </summary>
      <CardContent className="mt-4 space-y-3 text-sm">
        {!sourceJobId && (
          <p>
            Bu bilgisayarda henüz çalışan bir kod çıktısı yok. GitHub
            sürümlerini göster → main · güncel sürüm → Bu bilgisayara al ve
            kontrol et.
          </p>
        )}
        {sourceJobId && available === false && (
          <p>
            Bu sürüm yalnızca cihazda veri saklıyor; backend bağlantısı
            kullanmıyor.
          </p>
        )}
        {sourceJobId && available && (
          <>
            <div className="space-y-1">
              <Label htmlFor="connection-url">Supabase proje adresi</Label>
              <Input
                id="connection-url"
                placeholder="https://xxxx.supabase.co"
                value={url}
                autoComplete="off"
                disabled={pending}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="connection-key">Publishable anahtar</Label>
              <Input
                id="connection-key"
                placeholder="sb_publishable_..."
                value={publishableKey}
                autoComplete="off"
                spellCheck={false}
                disabled={pending}
                onChange={(e) => setPublishableKey(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Uygulama için App Factory&apos;nin değil, ayrı bir Supabase
              projesi kullanın ve backend/migration.sql dosyasını o projede
              çalıştırın. Yalnızca publishable anahtar kabul edilir; service
              role veya secret anahtarlar mobil uygulamaya eklenemez. Adres ve
              publishable anahtar private GitHub deposunun main dalına gider;
              senkron alan diğer bilgisayar aynı bağlantıyı kullanır. Service
              role GitHub&apos;a gönderilmez. Bu sürümden türeyen revizyonlar
              bağlantıyı devralır.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={pending || !changed}
                onClick={() =>
                  void save({
                    url: url.trim(),
                    publishableKey: publishableKey.trim(),
                  })
                }
              >
                Bağlantıyı kaydet
              </Button>
              {connected && (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => void save({ url: "", publishableKey: "" })}
                >
                  Bağlantıyı kaldır
                </Button>
              )}
            </div>
          </>
        )}
        {notice && <p>{notice}</p>}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </details>
  );
}
