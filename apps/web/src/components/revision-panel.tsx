"use client";
import { useEffect, useRef, useState } from "react";
import {
  builderJobSchema,
  getScreens,
  getSpecification,
  sameSpecification,
  appWideScreenId,
  builderModelSchema,
  type BuilderJob,
  type Project,
} from "@app-factory/schemas";
import { OperationProgress, builderProgress } from "./operation-progress";
import { PreviewPanel } from "./preview-panel";
import { ConnectionPanel } from "./connection-panel";
import { Button } from "./ui/button";
import { useProjects } from "./project-provider";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
type BuilderModel = ReturnType<typeof builderModelSchema.parse>;
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
    [selected, setSelected] = useState(""),
    [issueKind, setIssueKind] = useState<"bug" | "design">("bug"),
    [model, setModel] = useState<"" | BuilderModel>("");
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
  const prefix =
    section === "build"
      ? issueKind === "bug"
        ? "Expo önizlemesinde görülen hata: "
        : "Expo önizlemesinde görülen tasarım sorunu: "
      : "";
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
              ...(model ? { model } : {}),
            }
          : {
              project: { ...project, revisions: [] },
              requestId: requestId.current,
              change: {
                sourceJobId: selectedId,
                screenId: screenId || screens[0]?.id,
                instruction: prefix + instruction.trim(),
              },
              ...(model ? { model } : {}),
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
  const modelSelect = (
    <label className="block space-y-1 text-sm">
      <span>AI modeli</span>
      <select
        className="block w-full rounded-md border bg-background p-2"
        value={model}
        disabled={pending || active}
        onChange={(e) => {
          const parsed = builderModelSchema.safeParse(e.target.value);
          setModel(parsed.success ? parsed.data : "");
        }}
      >
        <option value="">
          Varsayılan (ekranlar GPT-6 Luna, uygulama geneli GPT-5 mini)
        </option>
        <option value="gpt-5-mini">
          GPT-5 mini · akıl yürütmeli, daha pahalı
        </option>
        <option value="gpt-6-luna">GPT-6 Luna</option>
        <option value="gpt-4.1-mini">GPT-4.1 mini</option>
      </select>
    </label>
  );
  const requestForm = (
    <>
      {section === "build" && (
        <label className="block space-y-1 text-sm">
          <span>Sorun türü</span>
          <select
            className="block w-full rounded-md border bg-background p-2"
            value={issueKind}
            disabled={pending || active}
            onChange={(e) => {
              setIssueKind(e.target.value === "design" ? "design" : "bug");
              requestId.current = null;
            }}
          >
            <option value="bug">
              Hata (çökme, çalışmayan düğme, yanlış veri)
            </option>
            <option value="design">
              Tasarım sorunu (görünüm, yerleşim, renk)
            </option>
          </select>
        </label>
      )}
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
          <option value={appWideScreenId}>
            Uygulama geneli (ortak işlevler ve ilgili ekranlar)
          </option>
          {screens.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 text-sm">
        <span>
          {section === "build" ? "Önizlemede ne gördünüz?" : "Ne değişsin?"}
        </span>
        <textarea
          className="block min-h-24 w-full rounded-md border bg-background p-3"
          maxLength={2000 - prefix.length}
          value={instruction}
          disabled={pending || active}
          onChange={(e) => {
            setInstruction(e.target.value);
            requestId.current = null;
          }}
          placeholder={
            section === "build"
              ? issueKind === "bug"
                ? "Örneğin: Kaydet düğmesine basınca uygulama kapanıyor. Expo'daki kırmızı hata ekranında 'undefined is not an object' yazıyor."
                : "Örneğin: Kartlar ekrana sığmıyor, başlık çok büyük ve alt menü düğmeleri birbirine yapışık."
              : "Örneğin: Ana ekrandaki kartları daha kompakt yap, başlığı küçült ve ekleme düğmesini belirginleştir."
          }
        />
      </label>
      {modelSelect}
      <p className="text-xs text-muted-foreground">
        {screenId === appWideScreenId
          ? "Önce ortak işlevler (veri modeli, iş kuralları, veri katmanı, gerekirse migration) güncellenir; ardından AI'ın seçtiği her ekran ayrı görev olarak yeniden kodlanır. Yeni paket eklenmez. Her deneme için $0.08 bütçe ayrılır; yeniden deneme sayısı sınırsızdır, proje bütçesi dolunca durur."
          : "Bir görev bir ekranı değiştirir. Yeni backend, paket veya ortak veri modeli eklemez. Her deneme için $0.08 bütçe ayrılır; yeniden deneme sayısı sınırsızdır, proje bütçesi dolunca durur."}
      </p>
      {(error || connectionError) && (
        <p role="alert" className="text-sm text-destructive">
          {error || connectionError}
        </p>
      )}
      {!enabled && (
        <p className="text-sm">Revizyon için worker AI bağlantısı gerekli.</p>
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
          : section === "build"
            ? "Sorunu AI ile düzelt, yeniden kodla"
            : "Değişikliği AI ile uygula"}
      </Button>
      {(pending || latest) && (
        <OperationProgress
          {...builderProgress(pending ? null : (latest ?? null))}
        />
      )}
    </>
  );
  const latestSummary = latest && (
    <div className="space-y-2 border-t pt-4 text-sm">
      <p className="font-medium">
        Son revizyon:{" "}
        {latest.status === "ready"
          ? section === "build"
            ? "Kod kontrolleri geçti — yukarıdan yeni sürümün önizlemesini başlatın"
            : "Kod kontrolleri geçti — önizleme bekliyor"
          : latest.status === "running"
            ? "Hazırlanıyor"
            : "Başarısız — önceki çıktı korundu"}
      </p>
      <p>{latest.change?.instruction}</p>
      {latest.tasks.map((t, n) => (
        <div key={n} className="space-y-1">
          {latest.tasks.length > 1 && (
            <p className="font-medium">
              {t.name} ·{" "}
              {t.status === "ready"
                ? "Hazır"
                : t.status === "running"
                  ? "Kodlanıyor"
                  : t.status === "failed"
                    ? "Başarısız"
                    : "Sırada"}
            </p>
          )}
          {t.summary && <p>{t.summary}</p>}
          {t.limitations.map((l, i) => (
            <p key={i} className="text-muted-foreground">
              {l}
            </p>
          ))}
        </div>
      ))}
      {latest.error && <p className="text-destructive">{latest.error}</p>}
      <p>
        AI maliyeti: $
        {latest.tasks
          .reduce((n, t) => n + t.costUsd + t.uncertainCostUsd, 0)
          .toFixed(6)}{" "}
        · Deneme{" "}
        {(latest.tasks.find((t) => t.status !== "ready") ?? latest.tasks[0])
          ?.attempts ?? 0}
      </p>
      {section !== "tests" && latest.status === "failed" && (
        <div className="space-y-2 rounded-md border p-3">
          {modelSelect}
          <p className="text-xs text-muted-foreground">
            Seçilen model tamamlanmamış görevlerde kullanılır. Varsayılan
            seçiliyse önceki model korunur.
          </p>
          <Button
            variant="outline"
            disabled={pending || active}
            onClick={() => void submit(true)}
          >
            Revizyonu yeniden dene
          </Button>
        </div>
      )}
      {section === "tests" && (
        <details>
          <summary className="cursor-pointer">Kontrol günlükleri</summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
            {latest.setupLog}
            {latest.tasks.map((t) => t.log).join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
  return (
    <div className="space-y-5">
      {section === "build" && (
        <ConnectionPanel
          key={"connection:" + (selectedId ?? "none")}
          project={project}
          sourceJobId={active ? null : selectedId}
        />
      )}
      {section === "build" && (
        <PreviewPanel
          key={selectedId ?? "none"}
          project={project}
          sourceJobId={active ? null : selectedId}
          feedback={
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>2. Önizlemede gördüklerini bildir</CardTitle>
                <CardDescription>
                  Telefonda gördüğünüz hataları ve tasarım sorunlarını yazın. AI
                  seçilen ekranı yeniden kodlar ve kod kontrolleri çalışır.
                  Önceki sürüm korunur. Yeni sürüm hazır olunca önizleme ona
                  geçer; yukarıdan önizlemeyi yeniden başlatıp telefonda tekrar
                  kontrol edin.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {requestForm}
                {latestSummary}
              </CardContent>
            </Card>
          }
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
            {section === "development" && requestForm}
            {section === "tests" && connectionError && (
              <p role="alert" className="text-sm text-destructive">
                {connectionError}
              </p>
            )}
            {section !== "build" && latestSummary}
          </div>
        </CardContent>
      </details>
    </div>
  );
}
