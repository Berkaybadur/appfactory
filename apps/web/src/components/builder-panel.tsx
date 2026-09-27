"use client";
import { GithubPanel } from "./github-panel";

import Link from "next/link";
import { OperationProgress, builderProgress } from "./operation-progress";
import { RevisionPanel } from "./revision-panel";
import { useEffect, useState } from "react";
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
export function BuilderPanel({
  project,
  section,
}: {
  project: Project;
  section: "development" | "tests" | "build";
}) {
  const [job, setJob] = useState<BuilderJob | null>(null);
  const [history, setHistory] = useState<BuilderJob[]>([]);
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
        setJob(current);
        setHistory(jobs.filter((j) => j.id !== current?.id));
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
  }, [project.id, revision, syncImageCost, syncBuilder]);
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
  const exhausted = job && !job.installed && job.setupAttempts >= 3;
  const busy = job?.status === "running";
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
        sourceJobId={job?.status === "ready" && !stale ? job.id : null}
      />
      {section === "development" && (
        <details className="my-4 rounded-lg border bg-white p-6" open>
          <summary>
              <span className="leading-none font-semibold cursor-pointer">Plan ve tasarımdan çalışan uygulamaya</span>
          </summary>
          <div className="mt-4 space-y-3 text-sm">
            <p className="text-sm text-muted-foreground">
              GPT-5 mini ile önce veri modeli, iş kuralları, kayıt ve servis
              işlemleri üretilir. Ekranlar bu ortak işlevlere bağlanır. İş
              kuralı örnekleri, TypeScript ve ESLint sonuçları aşağıda
              gösterilir.
            </p>
            <p className="text-sm text-muted-foreground">
              Ortak işlevler ve her ekran için görev başına en fazla $0.24; her
              denemede $0.08 bütçe ayrılır. İlk başarısızlıktan sonra en fazla
              iki otomatik tekrar yapılır. Sonrasında model seçip bir ek
              denemeyi onaylayabilirsiniz. Bütçe sınırına ulaşılırsa işlem
              durur.
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
                  Görev sınırı $0.24.
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
                !!exhausted ||
                !!stale
              }
              onClick={() => void start()}
            >
              {sending
                ? "Başlatılıyor…"
                : busy
                  ? "Uygulama hazırlanıyor…"
                  : job?.status === "ready"
                    ? "Expo kod kontrolleri tamamlandı"
                    : job?.status === "failed"
                      ? "Başarısız görevden devam et"
                      : "Uygulama işlevlerini ve ekranları üret"}
            </Button>
            {(sending || job) && (
              <OperationProgress {...builderProgress(sending ? null : job)} />
            )}
            {job && (
              <p className="text-xs text-muted-foreground">
                {job.tasks.filter((t) => t.status === "ready").length}/
                {job.tasks.length} görev · Builder maliyeti: $
                {job.tasks.reduce((n, t) => n + t.costUsd, 0).toFixed(6)} ·
                Ayrılan / belirsiz: $
                {job.tasks
                  .reduce((n, t) => n + t.reservedUsd + t.uncertainCostUsd, 0)
                  .toFixed(6)}
              </p>
            )}
          </div>
        </details>
      )}
      {job?.implementation && (
        <details className="my-4 rounded-lg border bg-white p-6">
          <summary>
            <span className="leading-none font-semibold cursor-pointer">Üretilen uygulama işlevleri</span>
            <p className="text-sm text-muted-foreground mb-3">
              {job.implementation.summary}
            </p>
            <p className="text-sm text-muted-foreground">
              {job.implementation.checks.length} iş kuralı örneği doğrulandı. Bu
              kontroller cihaz ve canlı sunucu testinin yerine geçmez.
            </p>
          </summary>
          <div className="mt-4 space-y-3 text-sm">
            <ul className="space-y-3">
              {job.implementation.coverage.map((item, index) => (
                <li key={index} className="rounded-md border p-3 text-sm">
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
              ))}
            </ul>
            {job.implementation.setup.length > 0 && (
              <div className="rounded-md border border-amber-300 p-4">
                <h3 className="mb-2 text-sm font-medium">
                  Uygulamayı kullanmadan önce
                </h3>
                <ul className="list-disc space-y-2 pl-5 text-sm">
                  {job.implementation.setup.map((step, index) => (
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
                {job.implementation.checks.map((check, index) => (
                  <li key={index}>
                    {check.name} · {check.passed ? "Geçti" : "Başarısız"}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </details>
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
          {!job && (
            <p>
              {loaded
                ? "Bu sürüm için henüz Builder kontrol sonucu yok."
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
        job?.tasks.map((task) => (
          <Card
            key={`${task.kind ?? "screen"}:${task.screenId}`}
            className="shadow-none"
          >
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-base">{task.name}</CardTitle>
                <Badge variant="secondary">{labels[task.status]}</Badge>
              </div>
              <CardDescription>
                Deneme {task.attempts} ·{" "}
                {task.model ??
                  (task.kind === "features" ? "gpt-5-mini" : "gpt-6-luna")}{" "}
                · ${task.costUsd.toFixed(6)}
              </CardDescription>
            </CardHeader>
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
          </Card>
        ))}
      {section === "tests" && job?.setupLog && (
        <details>
          <summary className="cursor-pointer text-sm">Expo kurulumu</summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-xs">
            {job.setupLog}
          </pre>
        </details>
      )}
      {section !== "build" && job?.status === "ready" && !stale && (
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
