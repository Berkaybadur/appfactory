"use client";
import { OperationProgress } from "./operation-progress";
import { RevisionPanel } from "./revision-panel";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  generationJobSchema,
  getSpecification,
  sameSpecification,
  type GenerationJob,
  type Project,
} from "@app-factory/schemas";
import { useProjects } from "@/components/project-provider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
const statusLabels: Record<GenerationJob["status"], string> = {
  queued: "Sırada",
  generating: "Dosyalar üretiliyor",
  generated: "Proje üretildi",
  validating: "Kontroller çalışıyor",
  ready: "Kontroller başarılı",
  failed: "İşlem başarısız",
};
const checkLabels = {
  install: "Bağımlılık kurulumu",
  typecheck: "TypeScript tip kontrolü",
  lint: "ESLint",
};
const checkStates = {
  pending: "Bekliyor",
  running: "Çalışıyor",
  passed: "Başarılı",
  failed: "Başarısız",
};
export function GenerationPanel({
  project,
  section,
}: {
  project: Project;
  section: "development" | "tests" | "build";
}) {
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { syncGeneration } = useProjects();
  useEffect(() => {
    let active = true;
    let pending = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch(
          `/api/jobs?projectId=${encodeURIComponent(project.id)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "İş durumu alınamadı.");
        const next = data.job ? generationJobSchema.parse(data.job) : null;
        if (active) {
          setJob(next);
          setError(null);
          if (next) syncGeneration(next);
        }
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : "İş durumu alınamadı.");
      } finally {
        pending = false;
        if (active) setLoading(false);
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 3000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [project.id, syncGeneration]);
  const submit = async (action: "generate" | "validate") => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "generate"
            ? { action, project: { ...project, revisions: [] } }
            : { action, projectId: project.id },
        ),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "İşlem başlatılamadı.");
      const next = generationJobSchema.parse(data.job);
      setJob(next);
      syncGeneration(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "İşlem başlatılamadı.");
    } finally {
      setSending(false);
    }
  };
  const busy =
    sending ||
    (!!job && ["queued", "generating", "validating"].includes(job.status));
  const stale = !!job && !sameSpecification(project, job.project);
  const titles = {
    development: "Geliştirme",
    tests: "Testler",
    build: "Derleme ve Önizleme",
  };
  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">{titles[section]}</h2>
      <RevisionPanel
        section={section}
        project={project}
        sourceJobId={job?.status === "ready" && !stale ? job.id : null}
      />
      {section === "development" && (
        <Card className="gap-3 p-5 shadow-none">
          <h3 className="font-medium">Onaylı görsellerden ekran kodu üretin</h3>
          <p className="text-sm text-muted-foreground">
            Bu proje şablon çıktısını kullanıyor. Tasarım sayfasında seçili
            ekranların görsellerini üretip onayladığınızda Builder açılır; yeni
            uygulama ayrı bir klasörde hazırlanır.
          </p>
          <Button asChild variant="outline">
            <Link href={`/projects/${project.id}/design`}>
              Tasarım görsellerine git
            </Link>
          </Button>
        </Card>
      )}
      {section === "development" && project.plannerDraft && (
        <Card className="gap-3 p-5 shadow-none">
          <h3 className="font-medium">AI geliştirme görevleri</h3>
          <p className="text-sm text-muted-foreground">
            Bu görevler kapsam önerileridir. Görsel onayı sonrası Builder ekran
            tasarımını ve mevcut yerel kayıt işlemlerini uygular; tüm
            entegrasyonları tamamlanmış saymaz.
          </p>
          {project.plannerDraft.tasks.map((task, index) => (
            <details key={index}>
              <summary className="cursor-pointer text-sm">
                {index + 1}. {task.title}
              </summary>
              <p className="mt-2 text-sm">{task.description}</p>
              <ul className="list-inside list-disc text-sm">
                {task.acceptance.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </details>
          ))}
        </Card>
      )}
      {section === "development" && (
        <div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Türkçe, seçtiğiniz ekranlardan oluşan Expo başlangıç uygulaması.
            Kayıt oluşturma ve düzenleme, ilgili ekranlar seçildiğinde
            kullanılabilir. Veriler cihazda saklanır. Fikre özel AI özellikleri
            henüz üretilmez.
          </p>
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {section !== "build" && (
        <Card className="shadow-none">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-base">
                {section === "development"
                  ? "Yerel üretim işi"
                  : "Kod kontrolleri"}
              </CardTitle>
              <Badge variant="outline">
                {loading
                  ? "Yükleniyor…"
                  : job
                    ? stale
                      ? "Önceki sürümün çıktısı"
                      : statusLabels[job.status]
                    : "Henüz üretilmedi"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {stale && (
              <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3">
                <p className="text-sm">
                  Bu çıktı önceki sürüme ait (sürüm{" "}
                  {getSpecification(job!.project).revision}). Geçerli sürüm:{" "}
                  {getSpecification(project).revision}. Eski sonuçlar yeni sürüm
                  için geçerli değildir.
                </p>
                {section === "development" && (
                  <Button
                    disabled={
                      busy || !!error || project.stage !== "development"
                    }
                    onClick={() => {
                      void submit("generate");
                    }}
                  >
                    Yeni sürümü üret
                  </Button>
                )}
              </div>
            )}
            {!job && section === "development" && (
              <>
                <p className="text-sm text-muted-foreground">
                  Onaylanan proje bilgileriyle ayrı bir Expo projesi
                  oluşturulur. AI çağrısı veya ücretli derleme yapılmaz.
                </p>
                <Button
                  disabled={loading || sending || !!error}
                  onClick={() => {
                    void submit("generate");
                  }}
                >
                  Expo projesini üret
                </Button>
                {sending && (
                  <OperationProgress
                    value={0}
                    label="Expo üretim isteği gönderiliyor…"
                  />
                )}
              </>
            )}
            {job && (
              <>
                <p className="text-xs text-muted-foreground">
                  Sürüm: {getSpecification(job.project).revision} · İş kimliği:{" "}
                  {job.id}
                  <br />
                  Son güncelleme:{" "}
                  {new Date(job.updatedAt).toLocaleString("tr-TR")}
                </p>
                {job.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {job.error}
                  </p>
                )}
                {job.outputPath && (
                  <div>
                    <p className="mb-1 text-sm font-medium">Çıktı klasörü</p>
                    <code className="block break-all rounded-md bg-muted p-3 text-xs">
                      {job.outputPath}
                    </code>
                  </div>
                )}
                {section === "development" && (
                  <OperationProgress
                    value={job.files.length ? 100 : 0}
                    label={
                      job.files.length
                        ? "Expo başlangıç dosyaları üretildi."
                        : job.status === "failed"
                          ? "Expo üretimi başarısız."
                          : "Expo dosyaları hazırlanıyor…"
                    }
                  />
                )}
                {busy && (
                  <p role="status" className="text-sm text-muted-foreground">
                    İşlem sürüyor. Bu sayfadan ayrılabilirsiniz; worker arka
                    planda devam eder.
                  </p>
                )}
                {section === "tests" &&
                  !stale &&
                  job.files.length > 0 &&
                  job.status !== "ready" && (
                    <div className="space-y-2">
                      <Button
                        disabled={busy || !!error}
                        onClick={() => {
                          void submit("validate");
                        }}
                      >
                        {job.validationAttempts
                          ? "Kontrolleri yeniden dene"
                          : "Bağımlılıkları kur ve kontrolleri çalıştır"}
                      </Button>
                      <p className="text-xs leading-5 text-muted-foreground">
                        npm paketleri indirilir; ardından gerçek TypeScript ve
                        ESLint kontrolleri çalışır. Otomatik tekrar yok.
                        Kullanılan deneme: {job.validationAttempts}.
                      </p>
                    </div>
                  )}
                {section === "development" && job.files.length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-sm font-medium">
                      Üretilen dosyalar ({job.files.length})
                    </summary>
                    <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                      {job.files.map((file) => (
                        <li key={file}>
                          <code>{file}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}
      {section === "tests" && (
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">
              Gerçek kontrol sonuçları
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!job?.checks.length ? (
              <p className="text-sm text-muted-foreground">
                Henüz kontrol çalıştırılmadı.
              </p>
            ) : (
              job.checks.map((check) => (
                <details
                  key={check.name}
                  className="rounded-md border p-3"
                  open={check.status === "failed"}
                >
                  <summary className="cursor-pointer text-sm">
                    {checkLabels[check.name]} · {checkStates[check.status]}
                    {check.durationMs > 0
                      ? ` · ${(check.durationMs / 1000).toFixed(1)} sn`
                      : ""}
                  </summary>
                  <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
                    {check.output || "Henüz çıktı yok."}
                  </pre>
                </details>
              ))
            )}
            <p className="text-xs text-muted-foreground">
              Sonuçlar son çalıştırılan kod sürümüne aittir; cihaz testi veya
              APK derlemesi yerine geçmez.
            </p>
          </CardContent>
        </Card>
      )}
      {section !== "build" && (
        <Button asChild variant="outline">
          <Link
            href={`/projects/${project.id}/${section === "development" ? "tests" : project.stage === "build" && !stale ? "build" : "development"}`}
          >
            {section === "development"
              ? "Testlere git"
              : project.stage === "build" && !stale
                ? "QR önizleme ve derlemeye git"
                : "Geliştirmeye git"}
          </Link>
        </Button>
      )}
    </div>
  );
}
