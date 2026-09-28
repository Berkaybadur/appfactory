"use client";
import { useEffect, useState } from "react";
import { type Project } from "@app-factory/schemas";
import { Button } from "./ui/button";
import { CardHeader, CardTitle, CardDescription, CardContent } from "./ui/card";
export function GithubPanel({ project }: { project: Project }) {
  const [state, setState] = useState<{
    enabled: boolean;
    busy: boolean;
    error?: string | null;
    url?: string;
    operation?: { id: string; progress: number; active: boolean } | null;
  }>({ enabled: false, busy: false });
  const [versions, setVersions] = useState<
    { id: string; sha: string; branch?: string }[]
  >([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [active, setActive] = useState<{
    id: string;
    action: "list" | "publish" | "restore";
    versionId?: string;
  } | null>(null);
  const working = pending || active !== null;
  function percentage(action: string, versionId?: string) {
    if (active?.action !== action || active.versionId !== versionId) return "";
    const value =
      state.operation?.id === active.id ? state.operation.progress : 0;
    return ` · %${Math.min(99, value)}`;
  }
  useEffect(() => {
    let stopped = false;
    let refreshing = false;
    async function refresh() {
      if (refreshing) return;
      refreshing = true;
      try {
        const r = await fetch(
          `/api/github?projectId=${encodeURIComponent(project.id)}`,
          { cache: "no-store" },
        );
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "GitHub durumu alınamadı.");
        if (!stopped) {
          setState(data);
          setActive((current) =>
            current &&
            data.operation &&
            current.id === data.operation.id &&
            !data.operation.active
              ? null
              : current,
          );
        }
      } catch (e) {
        if (!stopped)
          setError(e instanceof Error ? e.message : "Bağlantı kurulamadı.");
      } finally {
        refreshing = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [project.id]);
  async function action(
    action: "list" | "publish" | "restore",
    version?: { id: string; sha: string },
  ) {
    setPending(true);
    const operationId = crypto.randomUUID();
    setActive({ id: operationId, action, versionId: version?.id });
    setError("");
    try {
      const r = await fetch("/api/github", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          operationId,
          project: { ...project, revisions: [] },
          ...version,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "GitHub işlemi başarısız.");
      if (action === "list") {
        setActive(null);
        setVersions(data.jobs ?? []);
        if (data.url) setState((previous) => ({ ...previous, url: data.url }));
      }
    } catch (e) {
      setActive(null);
      setError(e instanceof Error ? e.message : "GitHub işlemi başarısız.");
    } finally {
      setPending(false);
    }
  }
  return (
    <details
      className="rounded-xl border bg-card py-6 text-card-foreground"
      open
    >
      <summary className="mx-6 cursor-pointer [&>[data-slot=card-header]]:inline-grid [&>[data-slot=card-header]]:w-[calc(100%-1.5rem)] [&>[data-slot=card-header]]:px-0 [&>[data-slot=card-header]]:align-top">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="leading-6">
              GitHub · Bilgisayarlar arası devam
            </CardTitle>
          </div>
          <CardDescription>
            Tasarım görselleri aynı private depoda saklanır. Kod kendiliğinden
            GitHub’a gitmez; inceledikten sonra aşağıdaki düğmeyle main’e
            gönderirsiniz. Diğer bilgisayarda aynı hesaba girin, GitHub
            sürümlerini gösterin, main · güncel sürümü bu bilgisayara alın. Kod
            gelmeden Supabase bağlantısı ve Expo önizlemesi boş görünür. Yerel
            değişikliklerin üzerine yazılmaz.
          </CardDescription>
        </CardHeader>
      </summary>
      <CardContent className="space-y-3">
        <div className="mt-4 space-y-3 text-sm">
          {!state.enabled && (
            <p className="text-sm">
              Worker için GITHUB_TOKEN gerekli. Üç bilgisayarda aynı
              GITHUB_OWNER hesabını kullanın ve private depolara erişim verin.
            </p>
          )}
          {(error || state.error) && (
            <p role="alert" className="text-sm text-destructive">
              {error || state.error}
            </p>
          )}
          {state.busy && (
            <p role="status" className="text-sm">
              Aktarım, üretim veya yerel kontroller sürüyor…
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!state.enabled || working || state.busy}
              onClick={() => void action("publish")}
            >
              Yerel çıktıları GitHub’a gönder
              {percentage("publish")}
            </Button>
            <Button
              variant="outline"
              disabled={!state.enabled || working || state.busy}
              onClick={() => void action("list")}
            >
              GitHub sürümlerini göster
              {percentage("list")}
            </Button>
            {state.url && (
              <Button asChild variant="default">
                <a href={state.url} target="_blank" rel="noreferrer">
                  Depoyu aç
                </a>
              </Button>
            )}
          </div>
          {versions.map((version) => (
            <div
              key={version.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border p-2"
            >
              <span className="text-xs">
                {version.branch
                  ? `${version.branch} · güncel sürüm`
                  : `Eski dal · ${version.id.slice(0, 8)}`}{" "}
                · {version.sha.slice(0, 8)}
              </span>
              <Button
                variant="default"
                disabled={working || state.busy}
                onClick={() => void action("restore", version)}
              >
                Bu bilgisayara al ve kontrol et
                {percentage("restore", version.id)}
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            İndirme AI çağrısı yapmaz. Güncel kod main dalındadır; listede “main
            · güncel sürüm” olarak görünür. Bağımlılıklar yeniden kurulur.
            Supabase publishable bağlantısı kodla birlikte gelir. Service role,
            .env ve cihaz onayları aktarılmaz.
          </p>
        </div>
      </CardContent>
    </details>
  );
}
