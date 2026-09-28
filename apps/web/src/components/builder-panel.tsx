"use client";
import { GithubPanel } from "./github-panel";

import Link from "next/link";
import { OperationProgress, builderProgress } from "./operation-progress";
import { RevisionPanel } from "./revision-panel";
import { useEffect, useState, type ReactNode } from "react";
import {
  builderJobSchema,
  getSpecification,
  sameSpecification,
  type BuilderJob,
  type Project,
} from "@app-factory/schemas";
import { useProjects } from "./project-provider";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./ui/card";
import { Badge } from "./ui/badge";
const labels = {
  pending: "Bekliyor",
  running: "Üretiliyor / kontrol ediliyor",
  ready: "Kontroller geçti",
  failed: "Durduruldu",
};

function CoverageItem({
  item,
}: {
  item: NonNullable<BuilderJob["implementation"]>["coverage"][number];
}) {
  return (
    <li className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{item.requirement}</span>
        <Badge variant="outline">
          {
            {
              implemented: "Kodlandı",
              needs_setup: "Kurulum gerekli",
              unsupported: "Desteklenmiyor",
            }[item.status]
          }
        </Badge>
      </div>
      <p className="mt-2 text-muted-foreground">{item.detail}</p>
    </li>
  );
}

function TaskCard({
  collapsible,
  running,
  header,
  children,
}: {
  collapsible: boolean;
  running: boolean;
  header: ReactNode;
  children: ReactNode;
}) {
  if (!collapsible) {
    return (
      <Card className="shadow-none">
        {header}
        {children}
      </Card>
    );
  }
  return (
    <details
      open={running}
      className="rounded-xl border bg-card py-6 text-card-foreground"
    >
      <summary className="mx-6 cursor-pointer [&>[data-slot=card-header]]:inline-grid [&>[data-slot=card-header]]:w-[calc(100%-1.5rem)] [&>[data-slot=card-header]]:px-0 [&>[data-slot=card-header]]:align-top">
        {header}
      </summary>
      <div className="mt-6">{children}</div>
    </details>
  );
}
export function BuilderPanel({
  project,
  section,
}: {
  project: Project;
  section: "development" | "tests" | "build";
}) {
  const [job, setJob] = useState<BuilderJob | null>(null);
  const [history, setHistory] = useState<BuilderJob[]>([]);
  const [output, setOutput] = useState<BuilderJob | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [retryModel, setRetryModel] = useState("gpt-5-mini");
  const [confirmation, setConfirmation] = useState("");
  const failedTask = job?.tasks.find((task) => task.status !== "ready");
  const confirmationKey = `${job?.id}:${failedTask?.attempts}:${retryModel}`;
  const [error, setError] = useState("");
  const { syncImageCost, syncBuilder } = useProjects();
  const revision = getSpecification(project).revision;
  useEffect(() => {
    let disposed = false;
    async function refresh() {
      try {
        const response = await fetch(`/api/builder?projectId=${project.id}`, {
          cache: "no-store",
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error ?? "Builder bilgisi alınamadı.");
        const jobs: BuilderJob[] = (data.jobs ?? []).map((j: unknown) =>
          builderJobSchema.parse(j),
        );
        if (disposed) return;
        const current =
          jobs.find(
            (j) =>
              !j.change &&
              j.mode === "application" &&
              getSpecification(j.project).revision === revision,
          ) ?? null;
        const readyOutputs = jobs.filter(
          (j) => j.status === "ready" && sameSpecification(project, j.project),
        );
        setJob(current);
        setHistory(jobs.filter((j) => j.id !== current?.id));
        setOutput(
          (current?.status === "ready" &&
          sameSpecification(project, current.project)
            ? current
            : null) ??
            readyOutputs.at(-1) ??
            null,
        );
        setEnabled(data.enabled === true);
        setLoaded(true);
        setError("");
        syncImageCost(project.id, data.totalCostUsd);
        if (current) syncBuilder(current);
      } catch (e) {
        if (!disposed) {
          setError(e instanceof Error ? e.message : "Bağlantı kurulamadı.");
          setLoaded(false);
        }
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [project, revision, syncImageCost, syncBuilder]);
  async function start() {
    setSending(true);
    setError("");
    try {
      const response = await fetch("/api/builder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: { ...project, revisions: [] },
          retry: job?.status === "failed",
          ...(job?.status === "failed"
            ? {
                approval: {
                  confirmed: confirmation === confirmationKey,
                  model: retryModel,
                  jobId: job.id,
                  expectedAttempts: failedTask?.attempts,
                },
              }
            : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Builder başlatılamadı.");
      setJob(builderJobSchema.parse(data.job));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Builder başlatılamadı.");
    } finally {
      setSending(false);
    }
  }
  const stale = job && !sameSpecification(project, job.project);
  const busy = job?.status === "running";
  const outputId = output?.id ?? null;
  const view = output ?? job;
  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">
        {
          {
            development: "Geliştirme",
            tests: "Testler",
            build: "Derleme ve Önizleme",
          }[section]
        }
      </h2>
      <GithubPanel project={project} />
      <RevisionPanel
        section={section}
        project={project}
        sourceJobId={outputId}
      />
      {section === "development" && (
        <details className="my-4 rounded-lg border bg-white p-6" open>
          <summary>
            <span className="leading-none font-semibold cursor-pointer">
              Plan ve tasarımdan çalışan uygulamaya
            </span>
          </summary>
          <div className="mt-4 space-y-3 text-sm">
            <p className="text-sm text-muted-foreground">
              GPT-5 mini ile önce veri modeli, iş kuralları, kayıt ve servis
              işlemleri üretilir. Ekranlar bu ortak işlevlere bağlanır. İş
              kuralı örnekleri, TypeScript ve ESLint sonuçları aşağıda
              gösterilir.
            </p>
            <p className="text-sm text-muted-foreground">
              Her denemede $0.08 bütçe ayrılır. İlk başarısızlıktan sonra en
              fazla iki otomatik tekrar yapılır. Sonrasında model seçip
              istediğiniz kadar ek deneme onaylayabilirsiniz. Proje bütçesi
              dolunca işlem durur.
            </p>
            <p className="text-sm text-muted-foreground">
              Yerel özellikler ve desteklenen servis bağlantıları fikrinize göre
              kodlanır. Hesap, ortak veri, konum veya kamera kullanan
              uygulamalarda gerekli servis kurulumu ve cihaz izinleri ayrıca
              gösterilir.
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {job?.error && (
              <p role="alert" className="text-sm text-destructive">
                {job.error}
              </p>
            )}
            {stale && (
              <p className="text-sm text-destructive">
                Bu çıktı eski içeriğe ait. Güncel tasarımı onaylayın.
              </p>
            )}
            {!job && output && (
              <p className="text-sm">
                GitHub’dan alınan sürüm bu bilgisayarda hazır. Uygulamayı baştan
                üretmeyin. Supabase bağlantısı ve Expo önizlemesi Derleme
                sayfasındadır.
              </p>
            )}
            {!enabled && loaded && (
              <p className="text-sm">
                Worker .env dosyasında OPENAI_API_KEY gerekli.
              </p>
            )}
            {job?.status === "failed" && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm">
                  İşlem durdu. Hangi AI modeliyle yeniden denensin?
                </p>
                <label className="block text-sm">
                  AI modeli
                  <select
                    value={retryModel}
                    onChange={(e) => {
                      setRetryModel(e.target.value);
                      setConfirmation("");
                    }}
                    className="ml-2 rounded border p-2"
                  >
                    <option value="gpt-5-mini">
                      GPT-5 mini · İşlevler için önerilen
                    </option>
                    <option value="gpt-6-luna">GPT-6 Luna</option>
                    <option value="gpt-4.1-mini">GPT-4.1 mini</option>
                  </select>
                </label>
                <p className="text-xs text-muted-foreground">
                  Seçilen model yalnızca başarısız görev için kullanılır.
                  Harcanan maliyet korunur; bir ek deneme için $0.08 ayrılır.
                </p>
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={confirmation === confirmationKey}
                    onChange={(e) =>
                      setConfirmation(e.target.checked ? confirmationKey : "")
                    }
                  />
                  Seçtiğim modelle bir ücretli denemeyi onaylıyorum.
                </label>
              </div>
            )}
            <Button
              disabled={
                !loaded ||
                (job?.status === "failed" &&
                  confirmation !== confirmationKey) ||
                !enabled ||
                sending ||
                busy ||
                job?.status === "ready" ||
                (!job && !!output) ||
                !!stale
              }
              onClick={() => void start()}
            >
              {sending
                ? "Başlatılıyor…"
                : busy
                  ? "Uygulama hazırlanıyor…"
                  : job?.status === "ready" || (!job && !!output)
                    ? "Expo kod kontrolleri tamamlandı"
                    : job?.status === "failed"
                      ? "Başarısız görevden devam et"
                      : "Uygulama işlevlerini ve ekranları üret"}
            </Button>
            {(sending || view) && (
              <OperationProgress {...builderProgress(sending ? null : view)} />
            )}
            {view && (
              <p className="text-xs text-muted-foreground">
                {view.tasks.filter((t) => t.status === "ready").length}/
                {view.tasks.length} görev · Builder maliyeti: $
                {view.tasks.reduce((n, t) => n + t.costUsd, 0).toFixed(6)} ·
                Ayrılan / belirsiz: $
                {view.tasks
                  .reduce((n, t) => n + t.reservedUsd + t.uncertainCostUsd, 0)
                  .toFixed(6)}
              </p>
            )}
          </div>
        </details>
      )}
      {view?.implementation && (
        <div className="my-4 rounded-lg border bg-white p-6">
          <details>
            <summary className="cursor-pointer [&>[data-slot=card-header]]:inline-grid [&>[data-slot=card-header]]:w-[calc(100%-1.5rem)] [&>[data-slot=card-header]]:px-0 [&>[data-slot=card-header]]:align-top">
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="leading-6">
                    Üretilen uygulama işlevleri
                  </CardTitle>
                </div>
                <CardDescription>
                  <p className="text-sm text-muted-foreground mb-3">
                    {view.implementation.summary}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {view.implementation.checks.length} iş kuralı örneği
                    doğrulandı. Bu kontroller cihaz ve canlı sunucu testinin
                    yerine geçmez.
                  </p>
                </CardDescription>
              </CardHeader>
            </summary>
            <div className="mt-4 space-y-3 text-sm">
              <ul className="space-y-3">
                {view.implementation.coverage.map((item, index) => (
                  <CoverageItem key={index} item={item} />
                ))}
              </ul>
              {view.implementation.setup.length > 0 && (
                <div className="rounded-md border border-amber-300 p-4">
                  <h3 className="mb-2 text-sm font-medium">
                    Uygulamayı kullanmadan önce
                  </h3>
                  <ul className="list-disc space-y-2 pl-5 text-sm">
                    {view.implementation.setup.map((step, index) => (
                      <li key={index}>{step}</li>
                    ))}
                  </ul>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Sunucu kurulumu otomatik yapılmadı. Kurulum dosyaları ve
                    migration üretilen uygulama klasöründedir.
                  </p>
                </div>
              )}
              <details className="text-sm">
                <summary>İş kuralı kontrolleri</summary>
                <ul className="mt-2 list-disc pl-5">
                  {view.implementation.checks.map((check, index) => (
                    <li key={index}>
                      {check.name} · {check.passed ? "Geçti" : "Başarısız"}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          </details>
          {view.implementation.coverage.slice(-1).map((item) => (
            <ul key="latest-coverage" className="mt-4 peer-open:hidden">
              <CoverageItem item={item} />
            </ul>
          ))}
        </div>
      )}
      {section === "tests" && (
        <Card className="p-5 shadow-none">
          <h3 className="font-medium">Kod kontrol sonuçları</h3>
          <p className="text-sm text-muted-foreground">
            TypeScript ve ESLint üretim sırasında gerçek kod üzerinde çalışır.
            Cihaz testi yerine geçmez. Başarısız kod görevlerini Geliştirme
            sekmesinden manuel yeniden deneyebilirsiniz.
          </p>
          {error && <p role="alert">{error}</p>}
          {!view && (
            <p>
              {loaded
                ? "Bu sürüm için henüz Builder kontrol sonucu yok. GitHub’dan main sürümünü bu bilgisayara alın."
                : "Kontroller yükleniyor…"}
            </p>
          )}
          <Button asChild variant="outline">
            <Link href={`/projects/${project.id}/development`}>
              Geliştirmeye git
            </Link>
          </Button>
        </Card>
      )}
      {section !== "build" &&
        view?.tasks.map((task) => (
          <TaskCard
            key={`${view.id}:${task.kind ?? "screen"}:${task.screenId}:${section === "development" ? task.status : "tests"}`}
            collapsible={section === "development"}
            running={task.status === "running"}
            header={
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-base">{task.name}</CardTitle>
                  <Badge variant="secondary">{labels[task.status]}</Badge>
                </div>
                <CardDescription>
                  Deneme {task.attempts} ·{" "}
                  {task.model ??
                    (task.kind === "features"
                      ? "gpt-5-mini"
                      : "gpt-6-luna")}{" "}
                  · ${task.costUsd.toFixed(6)}
                </CardDescription>
              </CardHeader>
            }
          >
            <CardContent className="space-y-3">
              {section === "development" && task.summary && (
                <p className="text-sm">{task.summary}</p>
              )}
              {section === "development" && task.limitations.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {task.limitations.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              )}
              {section === "tests" && task.log && (
                <details>
                  <summary className="cursor-pointer text-sm">
                    Kontrol çıktısı
                  </summary>
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded border p-3 text-xs">
                    {task.log}
                  </pre>
                </details>
              )}
            </CardContent>
          </TaskCard>
        ))}
      {section === "tests" && view?.setupLog && (
        <details>
          <summary className="cursor-pointer text-sm">Expo kurulumu</summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-xs">
            {view.setupLog}
          </pre>
        </details>
      )}
      {section !== "build" &&
        (section === "development" || project.stage === "build") &&
        ((job?.status === "ready" && !stale) || outputId) && (
          <Button asChild variant="outline">
            <Link
              href={`/projects/${project.id}/${section === "development" ? "tests" : "build"}`}
            >
              {section === "development"
                ? "Kontrol sonuçlarına git"
                : "QR önizleme ve derlemeye git"}
            </Link>
          </Button>
        )}
      {section === "development" && history.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm">
            Önceki sürümlerin çıktıları
          </summary>
          {history.map((j) => (
            <p key={j.id} className="mt-2 break-all text-xs">
              Sürüm {getSpecification(j.project).revision} ·{" "}
              {j.outputPath || "Çıktı oluşturulmadı"}
            </p>
          ))}
        </details>
      )}
    </div>
  );
}
