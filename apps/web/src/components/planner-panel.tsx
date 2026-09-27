"use client";
import { useEffect, useState } from "react";
import {
  plannerJobSchema,
  getSpecification,
  type PlannerJob,
  type Project,
} from "@app-factory/schemas";
import { useProjects } from "./project-provider";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
export function PlannerPanel({ project }: { project: Project }) {
  const { applyPlanner, syncPlannerCost } = useProjects();
  const [job, setJob] = useState<PlannerJob | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const r = await fetch(
          "/api/planner?projectId=" + encodeURIComponent(project.id),
          { cache: "no-store" },
        );
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "AI durumu alınamadı.");
        if (active) {
          setEnabled(data.enabled === true);
          const next = data.job ? plannerJobSchema.parse(data.job) : null;
          setJob(next);
          if (next) syncPlannerCost(next);
        }
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : "AI durumu alınamadı.");
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [project.id, syncPlannerCost]);
  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/planner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: { ...project, revisions: [] },
          retry: job?.status === "failed" && !stale,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "AI başlatılamadı.");
      setJob(plannerJobSchema.parse(data.job));
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI başlatılamadı.");
    } finally {
      setBusy(false);
    }
  };
  const applied = job?.id === project.plannerJobId;
  const stale =
    !!job && !applied && getSpecification(project).revision > job.baseRevision;
  return (
    <Card className="mb-6 gap-3 p-5 shadow-none">
      <h2 className="font-semibold">AI Planner</h2>
      <p className="text-sm text-muted-foreground">
        {enabled
          ? "Fikrinizden plan, ekran önerileri, tasarım ve geliştirme görevleri hazırlanır. Formları tek tek düzenlemeniz gerekmez."
          : "AI bağlantısı hazır değil. Worker ortamında OPENAI_API_KEY ayarlandığında kullanılabilir; aşağıdaki yerel plan akışı çalışmaya devam eder."}
      </p>
      <p className="text-xs text-muted-foreground">
        OpenAI · GPT-4.1 mini · Manuel yeniden deneme sayısı sınırsız; proje
        bütçesi dolunca durur. Proje adı, fikir ve platformlar sağlayıcıya
        gönderilir.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {job && (
        <div className="space-y-2 text-sm">
          <p>
            {job.status === "running"
              ? "AI analiz ediyor…"
              : job.status === "succeeded"
                ? "AI taslağı hazır."
                : "AI analizi tamamlanamadı."}{" "}
            · Deneme {job.attempts}
          </p>
          <p>
            Hesaplanan maliyet: ${job.costUsd.toFixed(6)} · Ayrılan / belirsiz
            bütçe: ${(job.reservedUsd + job.uncertainCostUsd).toFixed(6)}
          </p>
          {job.error && <p role="alert">{job.error}</p>}
        </div>
      )}
      {(!job ||
        job.status === "failed" ||
        (stale && job.status !== "running")) && (
        <Button
          className="self-start"
          disabled={!enabled || busy}
          onClick={() => void start()}
        >
          {stale
            ? "Güncel fikirle yeni analiz başlat"
            : job
              ? "Analizi yeniden dene"
              : "AI ile fikri analiz et"}
        </Button>
      )}
      {job?.output && (
        <>
          <p className="text-sm">{job.output.plan.summary}</p>
          <details>
            <summary className="cursor-pointer text-sm">
              AI önerilerini incele
            </summary>
            <div className="mt-3 space-y-4 text-sm">
              <ul className="list-inside list-disc">
                {job.output.plan.scope.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
              {job.output.screenNotes.map((s, i) => (
                <div key={i}>
                  <strong>
                    {job.output?.screens.find((x) => x.id === s.screenId)?.name}
                  </strong>
                  <p>Alanlar: {s.fields.join(", ") || "Yok"}</p>
                  <p>Eylemler: {s.actions.join(", ") || "Yok"}</p>
                </div>
              ))}
              <h3 className="font-medium">Geliştirme görevleri</h3>
              {job.output.tasks.map((t, i) => (
                <div key={i}>
                  <strong>
                    {i + 1}. {t.title}
                  </strong>
                  <p>{t.description}</p>
                  <ul className="list-inside list-disc">
                    {t.acceptance.map((a, j) => (
                      <li key={j}>{a}</li>
                    ))}
                  </ul>
                </div>
              ))}
              {job.output.limitations.map((l, i) => (
                <p key={i}>{l}</p>
              ))}
            </div>
          </details>
          <p className="text-xs text-muted-foreground">
            AI önerileri henüz çalışan özellik değildir. Önizleme ve Expo
            üretimi mevcut ekran şablonlarını kullanır. Özel alanlar ve
            görevlerin kodlanması Builder aşamasında eklenecek.
          </p>
          {applied ? (
            <p className="text-sm">
              AI taslağı projeye uygulandı. Aşağıdaki planı inceleyip onaylayın.
            </p>
          ) : (
            <Button
              className="self-start"
              disabled={getSpecification(project).revision !== job.baseRevision}
              onClick={() => {
                try {
                  applyPlanner(job);
                  setError("");
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : "Taslak uygulanamadı.",
                  );
                }
              }}
            >
              AI taslağını projeye uygula
            </Button>
          )}
          {!applied &&
            getSpecification(project).revision !== job.baseRevision && (
              <p role="alert" className="text-sm">
                Proje analizden sonra değişti. Eski taslak düzenlemelerinizin
                üzerine yazılamaz.
              </p>
            )}
        </>
      )}
    </Card>
  );
}
