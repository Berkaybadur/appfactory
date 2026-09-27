"use client";
import { useEffect, useRef, useState } from "react";
import {
  easJobSchema,
  getSpecification,
  type EasJob,
  type Project,
} from "@app-factory/schemas";
import { ReleaseChecklistPanel } from "./release-checklist";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./ui/card";
const labels: Record<EasJob["status"], string> = {
  preparing: "Expo projesi hazırlanıyor",
  submitting: "Expo’ya gönderiliyor",
  unknown: "Gönderim sonucu belirsiz",
  needs_setup: "İmzalama kurulumu gerekli",
  queued: "Expo kuyruğunda",
  building: "APK derleniyor",
  finished: "APK hazır",
  failed: "Başarısız",
  canceled: "İptal edildi",
};
function expoUrl(job: EasJob) {
  if (!job.owner || !job.slug) return null;
  return `https://expo.dev/accounts/${encodeURIComponent(job.owner)}/projects/${encodeURIComponent(job.slug)}${job.buildId ? `/builds/${job.buildId}` : "/builds"}`;
}
export function EasPanel({
  project,
  sourceJobId,
  previewApproved,
}: {
  project: Project;
  sourceJobId: string | null;
  previewApproved: boolean;
}) {
  const [jobs, setJobs] = useState<EasJob[]>([]),
    [enabled, setEnabled] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [connectionError, setConnectionError] = useState(""),
    [buildId, setBuildId] = useState("");
  const [checklistReady, setChecklistReady] = useState(false);
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  const current =
    jobs.filter((j) => j.sourceJobId === sourceJobId).at(-1) ?? null;
  const latest = jobs.at(-1) ?? null;
  const job = current ?? latest;
  const active = jobs.some((j) =>
    ["preparing", "submitting", "unknown", "queued", "building"].includes(
      j.status,
    ),
  );
  const ref = useRef(jobs);
  useEffect(() => {
    ref.current = jobs;
  }, [jobs]);
  useEffect(() => {
    let closed = false,
      fetching = false;
    let lastRemote = 0;
    const controller = new AbortController();
    async function poll() {
      if (fetching) return;
      fetching = true;
      try {
        const tracked = ref.current.find(
          (j) => j.buildId && ["queued", "building"].includes(j.status),
        );
        if (tracked && Date.now() - lastRemote > 30000) {
          lastRemote = Date.now();
          const r = await fetch("/api/eas", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "refresh",
              projectId: project.id,
              jobId: tracked.id,
            }),
            signal: controller.signal,
          });
          if (!r.ok) {
            const data = await r.json();
            throw new Error(data.error ?? "Expo durumu alınamadı.");
          }
        }
        const response = await fetch(
          `/api/eas?projectId=${encodeURIComponent(project.id)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error ?? "EAS bilgisi alınamadı.");
        if (!closed) {
          setJobs((data.jobs ?? []).map((j: unknown) => easJobSchema.parse(j)));
          setEnabled(data.enabled === true);
          setLoaded(true);
          setConnectionError("");
        }
      } catch (e) {
        if (!closed)
          setConnectionError(
            e instanceof Error ? e.message : "EAS bağlantısı kesildi.",
          );
      } finally {
        fetching = false;
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      closed = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [project.id]);
  async function action(kind: "start" | "refresh" | "reconcile" | "complete") {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const body =
        kind === "complete"
          ? {
              action: kind,
              project: { ...project, revisions: [] },
              sourceJobId,
              jobId: current?.id,
              confirmed: true,
            }
          : kind === "start"
            ? {
                action: kind,
                project: { ...project, revisions: [] },
                sourceJobId,
                requestId: crypto.randomUUID(),
                expectedLatestId: latest?.id ?? null,
              }
            : {
                action: kind,
                projectId: project.id,
                jobId: job?.id,
                ...(kind === "reconcile" ? { buildId: buildId.trim() } : {}),
              };
      const response = await fetch("/api/eas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? "EAS işlemi tamamlanamadı.");
      const result = easJobSchema.parse(data.job);
      setJobs((prev) =>
        [...prev.filter((j) => j.id !== result.id), result].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "EAS işlemi başarısız.");
    } finally {
      setPending(false);
    }
  }
  const attempts = jobs.filter((j) => j.sourceJobId === sourceJobId).length;
  const link = job ? expoUrl(job) : null;
  return (
    <Card className="shadow-none">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>3. Android APK · Expo EAS</CardTitle>
          {job && <Badge variant="secondary">{labels[job.status]}</Badge>}
        </div>
        <CardDescription>
          Kaynak kodu Expo’ya yüklenir ve preview APK üretilir. EAS kotası AI
          bütçesinden ayrıdır; mağazaya gönderim yapılmaz.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!previewApproved && (
          <p className="text-sm">
            Build için önce yukarıdaki Expo Go önizlemesini inceleyip onaylayın.
          </p>
        )}
        {!project.android && (
          <p className="text-sm">Bu projede Android hedefi seçili değil.</p>
        )}
        {!sourceJobId && (
          <p className="text-sm text-muted-foreground">
            APK oluşturmak için güncel çıktının TypeScript ve ESLint
            kontrollerini tamamlayın.
          </p>
        )}
        {loaded && !enabled && (
          <p className="text-sm">Worker .env dosyasında EXPO_TOKEN gerekli.</p>
        )}
        {(error || connectionError) && (
          <p role="alert" className="text-sm text-destructive">
            {error || connectionError}
          </p>
        )}
        {job?.error && <p className="text-sm text-destructive">{job.error}</p>}
        {job && (
          <p className="text-xs text-muted-foreground">
            Derleme sürümü: {job.revision} · Güncel sürüm:{" "}
            {getSpecification(project).revision}
            {job.sourceJobId !== sourceJobId ? " · Önceki çıktıya ait" : ""}
          </p>
        )}
        {sourceJobId && (
          <ReleaseChecklistPanel
            key={sourceJobId}
            project={project}
            sourceJobId={sourceJobId}
            approved={previewApproved}
            onReady={setChecklistReady}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void action("start")}
            disabled={
              !checklistReady ||
              !previewApproved ||
              !loaded ||
              !enabled ||
              !sourceJobId ||
              !project.android ||
              pending ||
              active ||
              current?.status === "finished"
            }
          >
            {pending
              ? "İşleniyor…"
              : current?.status === "finished"
                ? "Bu çıktının APK’sı hazır"
                : attempts
                  ? "APK oluşturmayı yeniden dene"
                  : "EAS’e gönder ve APK oluştur"}
          </Button>
          {job && (job.buildId || job.status === "unknown") && (
            <Button
              variant="outline"
              disabled={pending || !enabled}
              onClick={() => void action("refresh")}
            >
              Durumu yenile
            </Button>
          )}
          {link && (
            <Button asChild variant="outline">
              <a href={link} target="_blank" rel="noreferrer">
                Expo’da aç
              </a>
            </Button>
          )}
          {job?.status === "finished" && job.apkUrl && (
            <Button asChild variant="outline">
              <a href={job.apkUrl} target="_blank" rel="noreferrer">
                APK’yı indir
              </a>
            </Button>
          )}
        </div>
        {job?.status === "unknown" && (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm">
              Expo’daki bu gönderimin iş kimliğini girin. Eşleştirme yapılana
              kadar yeni derleme açılmaz.
            </p>
            <label htmlFor={`eas-build-${project.id}`} className="text-sm">
              Expo derleme kimliği
            </label>
            <input
              id={`eas-build-${project.id}`}
              value={buildId}
              onChange={(e) => setBuildId(e.target.value)}
              className="h-9 w-full rounded-md border px-3 text-sm"
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            />
            <Button
              variant="outline"
              disabled={pending || !buildId.trim()}
              onClick={() => void action("reconcile")}
            >
              Mevcut işi eşleştir
            </Button>
          </div>
        )}
        {job?.status === "needs_setup" && (
          <details open>
            <summary className="text-sm">
              Tek seferlik imzalama kurulumu
            </summary>
            <p className="mt-2 text-sm text-muted-foreground">
              Terminalde Expo hesabınızla oturum açtıktan sonra aşağıdaki komutu
              çalıştırın. Ardından panelden yeniden deneyebilirsiniz.
            </p>
            <pre className="mt-2 overflow-auto rounded border p-3 text-xs">{`cd "${job.outputPath}"\neas credentials:configure-build --platform android --profile preview`}</pre>
          </details>
        )}
        <p className="text-xs text-muted-foreground">
          {current?.deviceTest === "passed"
            ? "Android cihaz testi kullanıcı tarafından onaylandı. Proje tamamlandı."
            : "Android cihaz testi henüz onaylanmadı. iPhone’a APK kurulamaz."}
        </p>
        {current?.status === "finished" &&
          current.apkUrl &&
          current.deviceTest !== "passed" && (
            <div className="space-y-3 rounded-md border p-3">
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={acknowledged === current.id}
                  onChange={(e) =>
                    setAcknowledged(e.target.checked ? current.id : null)
                  }
                />
                APK’yı Android cihazda kurdum ve temel işlemleri test ettim.
              </label>
              <Button
                disabled={
                  pending ||
                  acknowledged !== current.id ||
                  !current.sourceFingerprint
                }
                onClick={() => void action("complete")}
              >
                Cihaz testini onayla ve tamamla
              </Button>
              {!current.sourceFingerprint && (
                <p>
                  Bu eski derlemede kaynak doğrulaması yok. Yeni çıktı ve
                  derleme gerekli.
                </p>
              )}
            </div>
          )}
        {job?.log && (
          <details>
            <summary className="cursor-pointer text-sm">
              EAS işlem kaydı
            </summary>
            <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded border p-3 text-xs">
              {job.log}
            </pre>
          </details>
        )}
        {jobs.length > 1 && (
          <details>
            <summary className="cursor-pointer text-sm">
              Derleme geçmişi
            </summary>
            <ul className="mt-2 space-y-2 text-sm">
              {jobs.map((j) => (
                <li key={j.id}>
                  Sürüm {j.revision} · {labels[j.status]}{" "}
                  {expoUrl(j) && (
                    <a
                      className="underline"
                      target="_blank"
                      rel="noreferrer"
                      href={expoUrl(j)!}
                    >
                      Expo kaydı
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
