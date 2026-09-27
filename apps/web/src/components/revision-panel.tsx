"use client";
import { useEffect, useRef, useState } from "react";
import {
  builderJobSchema,
  getScreens,
  getSpecification,
  sameSpecification,
  type BuilderJob,
  type Project,
} from "@app-factory/schemas";
import { OperationProgress, builderProgress } from "./operation-progress";
import { PreviewPanel } from "./preview-panel";
import { Button } from "./ui/button";
import { useProjects } from "./project-provider";
import { CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
export function RevisionPanel({
  project,
  sourceJobId,
  section,
}: {
  project: Project;
  sourceJobId: string | null;
  section: "development" | "tests" | "build";
}) {
  const [jobs, setJobs] = useState<BuilderJob[]>([]),
    [enabled, setEnabled] = useState(false),
    [pending, setPending] = useState(false);
  const [error, setError] = useState(""),
    [connectionError, setConnectionError] = useState("");
  const [instruction, setInstruction] = useState(""),
    [screenId, setScreenId] = useState(""),
    [selected, setSelected] = useState("");
  const requestId = useRef<string | null>(null);
  const { syncImageCost } = useProjects();
  const screens = getScreens(getSpecification(project)).filter(
    (s) => s.enabled,
  );
  const ancestors = new Set(sourceJobId ? [sourceJobId] : []);
  const current = jobs.filter((j) => {
    if (
      !j.change ||
      !sameSpecification(j.project, project) ||
      !ancestors.has(j.change.sourceJobId)
    )
      return false;
    ancestors.add(j.id);
    return true;
  });
  const ready = current.filter((j) => j.status === "ready");
  const active = current.some((j) => j.status === "running");
  const latest = current.at(-1);
  const selectedId =
    selected &&
    (selected === sourceJobId || ready.some((j) => j.id === selected))
      ? selected
      : (ready.at(-1)?.id ?? sourceJobId);
  useEffect(() => {
    let disposed = false,
      fetching = false;
    const controller = new AbortController();
    async function poll() {
      if (fetching) return;
      fetching = true;
      try {
        const r = await fetch(`/api/revisions?projectId=${project.id}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Revizyonlar alınamadı.");
        if (!disposed) {
          setJobs(
            (data.jobs ?? []).map((j: unknown) => builderJobSchema.parse(j)),
          );
          setEnabled(data.enabled === true);
          setConnectionError("");
          syncImageCost(project.id, data.totalCostUsd);
        }
      } catch (e) {
        if (!disposed)
          setConnectionError(
            e instanceof Error ? e.message : "Bağlantı kesildi.",
          );
      } finally {
        fetching = false;
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [project.id, syncImageCost]);
  async function submit(retry = false) {
    setPending(true);
    setError("");
    try {
      if (!requestId.current) requestId.current = crypto.randomUUID();
      const body =
        retry && latest?.change
          ? {
              project: { ...project, revisions: [] },
              requestId: latest.id,
              change: latest.change,
              retry: true,
            }
          : {
              project: { ...project, revisions: [] },
              requestId: requestId.current,
              change: {
                sourceJobId: selectedId,
                screenId: screenId || screens[0]?.id,
                instruction: instruction.trim(),
              },
            };
      const r = await fetch("/api/revisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Revizyon başlatılamadı.");
      const job = builderJobSchema.parse(data.job);
      setJobs((prev) => [...prev.filter((j) => j.id !== job.id), job]);
      requestId.current = null;
      setSelected("");
      if (!retry) setInstruction("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revizyon başlatılamadı.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="space-y-5">
      {section === "build" && (
        <PreviewPanel
          key={selectedId ?? "none"}
          project={project}
          sourceJobId={active ? null : selectedId}
        />
      )}
      <details className="rounded-xl border bg-card py-6 text-card-foreground">
        <summary className="mx-6 cursor-pointer [&>[data-slot=card-header]]:inline-grid [&>[data-slot=card-header]]:w-[calc(100%-1.5rem)] [&>[data-slot=card-header]]:px-0 [&>[data-slot=card-header]]:align-top">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="leading-6">
                {section === "development"
                  ? "AI ile değişiklik iste"
                  : section === "tests"
                    ? "Revizyon kontrol sonuçları"
                    : "Önizlenecek sürüm"}
              </CardTitle>
            </div>
            <CardDescription>
              {section === "development"
                ? "Bir ekranı tarif ederek düzenletin. Çalışan sürüm korunur; yeni çıktı ayrı hazırlanır."
                : section === "tests"
                  ? "Revizyonların gerçek kod kontrol günlüklerini inceleyin."
                  : "Çalışan bir sürüm seçin; QR önizleme ve APK işlemleri bu sürüme bağlanır."}
            </CardDescription>
          </CardHeader>
        </summary>
        <CardContent className="space-y-3">
          <div className="mt-4 space-y-3 text-sm">
            {section !== "tests" && (
              <label className="block space-y-1 text-sm">
                <span>Çalışan sürüm</span>
                <select
                  className="block w-full rounded-md border bg-background p-2"
                  value={selectedId ?? ""}
                  disabled={active || pending}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    requestId.current = null;
                  }}
                >
                  <option value={sourceJobId ?? ""}>İlk çalışan çıktı</option>
                  {ready.map((j, i) => (
                    <option key={j.id} value={j.id}>
                      Revizyon {i + 1} · {j.tasks[0]?.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {section === "tests" && !latest && (
              <p className="text-sm text-muted-foreground">
                Henüz bu çıktıya bağlı revizyon kontrolü yok.
              </p>
            )}
            {section === "development" && (
              <>
                <label className="block space-y-1 text-sm">
                  <span>Hangi ekran?</span>
                  <select
                    className="block w-full rounded-md border bg-background p-2"
                    value={screenId || screens[0]?.id || ""}
                    disabled={pending || active}
                    onChange={(e) => {
                      setScreenId(e.target.value);
                      requestId.current = null;
                    }}
                  >
                    {screens.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Ne değişsin?</span>
                  <textarea
                    className="block min-h-24 w-full rounded-md border bg-background p-3"
                    maxLength={2000}
                    value={instruction}
                    disabled={pending || active}
                    onChange={(e) => {
                      setInstruction(e.target.value);
                      requestId.current = null;
                    }}
                    placeholder="Örneğin: Ana ekrandaki kartları daha kompakt yap, başlığı küçült ve ekleme düğmesini belirginleştir."
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  Bir görev bir ekranı değiştirir. Yeni backend, paket veya ortak
                  veri modeli eklemez. Deneme başına $0.08 bütçe ayrılır; görev
                  sınırı $0.24, en fazla iki manuel yeniden deneme.
                </p>
                {(error || connectionError) && (
                  <p role="alert" className="text-sm text-destructive">
                    {error || connectionError}
                  </p>
                )}
                {!enabled && (
                  <p className="text-sm">
                    Revizyon için worker AI bağlantısı gerekli.
                  </p>
                )}
                <Button
                  disabled={
                    !enabled ||
                    !selectedId ||
                    pending ||
                    active ||
                    instruction.trim().length < 5
                  }
                  onClick={() => void submit()}
                >
                  {active
                    ? "Revizyon hazırlanıyor…"
                    : "Değişikliği AI ile uygula"}
                </Button>
                {(pending || latest) && (
                  <OperationProgress
                    {...builderProgress(pending ? null : (latest ?? null))}
                  />
                )}
              </>
            )}
            {section !== "development" && connectionError && (
              <p role="alert" className="text-sm text-destructive">
                {connectionError}
              </p>
            )}
            {section !== "build" && latest && (
              <div className="space-y-2 border-t pt-4 text-sm">
                <p className="font-medium">
                  Son revizyon:{" "}
                  {latest.status === "ready"
                    ? "Kod kontrolleri geçti — önizleme bekliyor"
                    : latest.status === "running"
                      ? "Hazırlanıyor"
                      : "Başarısız — önceki çıktı korundu"}
                </p>
                <p>{latest.change?.instruction}</p>
                {latest.tasks[0]?.summary && <p>{latest.tasks[0].summary}</p>}
                {latest.tasks[0]?.limitations.map((l, i) => (
                  <p key={i} className="text-muted-foreground">
                    {l}
                  </p>
                ))}
                {latest.error && (
                  <p className="text-destructive">{latest.error}</p>
                )}
                <p>
                  AI maliyeti: $
                  {latest.tasks
                    .reduce((n, t) => n + t.costUsd + t.uncertainCostUsd, 0)
                    .toFixed(6)}{" "}
                  · Deneme {latest.tasks[0]?.attempts}/3
                </p>
                {section === "development" && latest.status === "failed" && (
                  <Button
                    variant="outline"
                    disabled={
                      pending ||
                      active ||
                      latest.tasks.some((t) => t.attempts >= 3) ||
                      (!latest.installed && latest.setupAttempts >= 3)
                    }
                    onClick={() => void submit(true)}
                  >
                    Revizyonu yeniden dene
                  </Button>
                )}
                {section === "tests" && (
                  <details>
                    <summary className="cursor-pointer">
                      Kontrol günlükleri
                    </summary>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
                      {latest.setupLog}
                      {latest.tasks.map((t) => t.log).join("\n")}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </details>
    </div>
  );
}
