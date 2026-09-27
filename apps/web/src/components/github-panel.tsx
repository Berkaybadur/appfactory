"use client";
import { useEffect, useState } from "react";
import { type Project } from "@app-factory/schemas";
import { Button } from "./ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
export function GithubPanel({ project }: { project: Project }) {
  const [state, setState] = useState<{
    enabled: boolean;
    busy: boolean;
    error?: string | null;
    url?: string;
  }>({ enabled: false, busy: false });
  const [versions, setVersions] = useState<{ id: string; sha: string }[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let stopped = false;
    async function refresh() {
      try {
        const r = await fetch(
          `/api/github?projectId=${encodeURIComponent(project.id)}`,
          { cache: "no-store" },
        );
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "GitHub durumu alınamadı.");
        if (!stopped) setState(data);
      } catch (e) {
        if (!stopped)
          setError(e instanceof Error ? e.message : "Bağlantı kurulamadı.");
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
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
    setError("");
    try {
      const r = await fetch("/api/github", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          project: { ...project, revisions: [] },
          ...version,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "GitHub işlemi başarısız.");
      if (action === "list") {
        setVersions(data.jobs ?? []);
        if (data.url) setState((previous) => ({ ...previous, url: data.url }));
      }
      if (action === "restore") setState((s) => ({ ...s, busy: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "GitHub işlemi başarısız.");
    } finally {
      setPending(false);
    }
  }
  return (
    <details className="my-4 rounded-lg border bg-white p-6" open>
      <summary>
          <span className="leading-none font-semibold cursor-pointer">GitHub · Bilgisayarlar arası devam</span>
          <p className="text-sm text-muted-foreground">
            Üretim tamamlandığında veya durduğunda kod ve görev kaydı private
            depoya otomatik gönderilir. Başka bilgisayarda bir sürümü alarak devam
            edebilirsiniz. Yerel değişikliklerin üzerine yazılmaz.
          </p>
      </summary>
      <div className="mt-4 space-y-3 text-sm">
        {!state.enabled && (
          <p className="text-sm">
            Worker için GITHUB_TOKEN gerekli. Üç bilgisayarda aynı GITHUB_OWNER
            hesabını kullanın ve private depolara erişim verin.
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
            disabled={!state.enabled || pending || state.busy}
            onClick={() => void action("publish")}
          >
            Yerel çıktıları GitHub’a gönder
          </Button>
          <Button
            variant="outline"
            disabled={!state.enabled || pending || state.busy}
            onClick={() => void action("list")}
          >
            GitHub sürümlerini göster
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
              Çıktı {version.id} · {version.sha.slice(0, 8)}
            </span>
            <Button
              variant="default"
              disabled={pending || state.busy}
              onClick={() => void action("restore", version)}
            >
              Bu bilgisayara al ve kontrol et
            </Button>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          İndirme AI çağrısı yapmaz. Bağımlılıklar yeniden kurulur. Bağlantı
          anahtarları ve cihaz onayları aktarılmaz.
        </p>
      </div>
    </details>
  );
}
