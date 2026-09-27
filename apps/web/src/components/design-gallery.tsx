"use client";
import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  getSpecification,
  getScreens,
  designImageJobSchema,
  projectSchema,
  type DesignImageJob,
  type Project,
  approvedDesignReferences,
  designGenerationReferences,
  designImageReservation,
} from "@app-factory/schemas";
import { useProjects } from "./project-provider";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { SpecificationEditor } from "./specification-editor";
import { OperationProgress } from "./operation-progress";
import { MobilePreview } from "./mobile-preview";
export function DesignGallery({ project }: { project: Project }) {
  const { applyImageApproval, approveDraftImage, syncImageCost } =
    useProjects();
  const spec = getSpecification(project);
  const screens = getScreens(spec).filter((s) => s.enabled);
  const [recovering, setRecovering] = useState(false);
  const hasApproval =
    project.designReview?.revision === spec.revision &&
    !!project.designReview.images?.length;
  const approved = hasApproval && !recovering;
  const [jobs, setJobs] = useState<DesignImageJob[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [cloudError, setCloudError] = useState("");
  const [sending, setSending] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [brief, setBrief] = useState(
    "Modern, özgün ve premium bir mobil deneyim. Güçlü tipografi, dengeli boşluklar ve fikre özel görsel bir kimlik. Sıradan yönetim paneli görünümünden uzaklaş.",
  );
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const reviewed = approvedDesignReferences(project, jobs).map((job) => job.id);
  const [loaded, setLoaded] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const r = await fetch(
          "/api/design-images?projectId=" + encodeURIComponent(project.id),
          { cache: "no-store" },
        );
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Görseller yüklenemedi.");
        if (active) {
          setJobs(data.jobs.map((j: unknown) => designImageJobSchema.parse(j)));
          setEnabled(data.enabled === true);
          setConnectionError("");
          setCloudError(
            data.cloudError ??
              (data.cloudEnabled
                ? ""
                : "Görsel paylaşımı için worker GitHub bağlantısı gerekli."),
          );
          syncImageCost(project.id, data.totalCostUsd);
        }
      } catch (e) {
        if (active)
          setConnectionError(
            e instanceof Error ? e.message : "Görseller yüklenemedi.",
          );
      } finally {
        fetching = false;
        if (active) setLoading(false);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [project.id, syncImageCost]);
  const current = (id: string) =>
    jobs.filter((j) => j.revision === spec.revision && j.screenId === id);
  const busy = sending || jobs.some((j) => j.status === "running");
  const allReviewed = screens.every((s) => {
    const j = current(s.id).at(-1);
    return (
      j?.status === "succeeded" &&
      reviewed.includes(j.id) &&
      loaded.includes(j.id)
    );
  });
  const generate = async (screenId: string) => {
    setOperation(screenId);
    setSending(true);
    setError("");
    try {
      const direction = [brief, feedback[screenId] ?? ""]
        .filter(Boolean)
        .join("\n");
      if (direction.length > 1000)
        throw new Error(
          "Tasarım yönü ve geri bildirim toplamı en fazla 1.000 karakter olabilir.",
        );
      const r = await fetch("/api/design-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: { ...project, revisions: [] },
          screenId,
          brief: direction,
          requestId: crypto.randomUUID(),
          expectedLatestId: current(screenId).at(-1)?.id ?? null,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Üretim başlatılamadı.");
      const j = designImageJobSchema.parse(data.job);
      setJobs((previous) => [...previous.filter((x) => x.id !== j.id), j]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Üretim başlatılamadı.");
    } finally {
      setSending(false);
      setOperation(null);
    }
  };
  const approve = async () => {
    setOperation("approve");
    setSending(true);
    setError("");
    try {
      const r = await fetch("/api/design-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "approve",
          project: { ...project, revisions: [] },
          reviewedIds: reviewed,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Onay kaydedilemedi.");
      // Retain local revision history; the request intentionally omitted it.
      const next = projectSchema.parse(data.project);
      next.revisions = [
        ...(project.revisions ?? []),
        ...(next.revisions ?? []),
      ].slice(-20);
      applyImageApproval(next, spec.revision);
      setRecovering(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onay kaydedilemedi.");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Görsel Tasarım</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Uygulamanın görünümüne gerçek görsel taslaklar üzerinden karar ver.
          Her ekranı incele, değişiklik iste ve tasarımı onayla.
        </p>
      </div>
      <Card className="gap-3 p-5 shadow-none">
        <Label htmlFor="art-direction">Tasarım yönü</Label>
        <Textarea
          id="art-direction"
          value={brief}
          maxLength={700}
          disabled={approved || busy}
          onChange={(e) => setBrief(e.target.value)}
          className="min-h-24"
        />
        <p className="text-xs leading-5 text-muted-foreground">
          Görsel için $0.20, her onaylı referans için ek $0.05 bütçe ayrılır;
          gerçek kullanım ayrıca hesaplanır. Her ekran sürümünde ilk üretim + en
          fazla iki manuel yeniden üretim. Otomatik tekrar yoktur. Üretim birkaç
          dakika sürebilir.
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          Bunlar tasarım referanslarıdır; henüz çalışan uygulama değildir.
          Onaylanan görseller Geliştirme aşamasında Builder tarafından Expo
          ekranlarına dönüştürülür. Görsel uyum ve cihaz testi ayrıca incelenir.
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          Yeni tasarımlar onaylı Ana sayfayı ve son iki onaylı diğer ekranı
          referans alır (en fazla 3 görsel). Renkler, tipografi, butonlar ve
          gezinme düzeni birlikte korunur.
        </p>
        {!enabled && !loading && (
          <p className="text-sm">
            Görsel üretimi kullanılamıyor. Worker ve API anahtarını kontrol
            edin.
          </p>
        )}
      </Card>
      {cloudError && (
        <p role="alert" className="text-sm text-destructive">
          {cloudError}
        </p>
      )}
      {(error || connectionError) && (
        <p role="alert" className="text-sm text-destructive">
          {error || connectionError}
        </p>
      )}
      {hasApproval &&
        !loading &&
        !connectionError &&
        project.designReview?.images?.some(
          (ref) =>
            !jobs.some(
              (job) => job.id === ref.assetId && job.status === "succeeded",
            ),
        ) && (
          <Card className="gap-3 border-amber-300 p-5 shadow-none">
            <h3 className="font-medium">
              Onaylı görseller bu bilgisayarda bulunamadı
            </h3>
            <p className="text-sm">
              Tasarım görselleri projenin private GitHub deposundan alınır.
              GitHub bağlantısını kontrol edin. Eski görseller henüz repoya
              gönderilmediyse üretildikleri bilgisayarda Tasarım sayfasını açın;
              mevcut PNG dosyaları otomatik aktarılır.
            </p>
            <p className="text-xs text-muted-foreground">
              Yeni görsel üretimi ücretlidir. Bu düğme yalnızca üretim
              alanlarını açar; mevcut onay, yeni görselleri onaylayana kadar
              korunur.
            </p>
            {!recovering && (
              <Button variant="outline" onClick={() => setRecovering(true)}>
                Bu bilgisayarda yeniden tasarım hazırla
              </Button>
            )}
          </Card>
        )}
      <div className="grid items-start gap-5 md:grid-cols-2 xl:grid-cols-3">
        {screens.map((screen) => {
          const history = current(screen.id);
          const latest = history.at(-1);
          const approvedRef = project.designReview?.images?.find(
            (i) => i.screenId === screen.id,
          );
          const displayed = approved
            ? jobs.find((j) => j.id === approvedRef?.assetId)
            : latest;
          const imageUrl =
            displayed?.status === "succeeded"
              ? "/api/design-images?assetId=" + displayed.id
              : null;
          return (
            <Card
              key={screen.id}
              className="gap-4 overflow-hidden p-4 shadow-none"
            >
              <div>
                <h3 className="font-medium">{screen.name}</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {screen.description}
                </p>
              </div>
              {imageUrl && displayed ? (
                <a
                  href={imageUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={screen.name + " görselini büyüt"}
                >
                  <Image
                    src={imageUrl}
                    alt={screen.name + " AI tasarım taslağı"}
                    width={1024}
                    height={1536}
                    unoptimized
                    className="h-auto w-full rounded-lg border"
                    onLoad={() =>
                      setLoaded((ids) =>
                        ids.includes(displayed.id)
                          ? ids
                          : [...ids, displayed.id],
                      )
                    }
                  />
                </a>
              ) : (
                <div className="flex aspect-[2/3] items-center justify-center rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
                  {displayed?.status === "running"
                    ? "Tasarım hazırlanıyor…"
                    : loading
                      ? "Görseller yükleniyor…"
                      : "Bu ekranın görsel taslağı henüz yok."}
                </div>
              )}
              {displayed?.error && (
                <p role="alert" className="text-xs text-destructive">
                  {displayed.error}
                </p>
              )}
              {displayed && (
                <p className="text-xs text-muted-foreground">
                  Maliyet: ${displayed.costUsd.toFixed(4)} · Ayrılan / belirsiz:
                  $
                  {(displayed.reservedUsd + displayed.uncertainCostUsd).toFixed(
                    4,
                  )}
                </p>
              )}
              {approved ? (
                <p className="text-sm">Tasarım onaylandı.</p>
              ) : (
                <>
                  {imageUrl && displayed && (
                    <Button
                      variant={
                        reviewed.includes(displayed.id) ? "outline" : "default"
                      }
                      disabled={
                        !loaded.includes(displayed.id) ||
                        reviewed.includes(displayed.id) ||
                        busy
                      }
                      onClick={() => {
                        try {
                          approveDraftImage(displayed, jobs);
                          setError("");
                        } catch (error) {
                          setError(
                            error instanceof Error
                              ? error.message
                              : "Onay kaydedilemedi.",
                          );
                        }
                      }}
                    >
                      {reviewed.includes(displayed.id)
                        ? "Görsel onaylandı"
                        : "Bu görseli onaylıyorum"}
                    </Button>
                  )}
                  <Label htmlFor={screen.id + "-feedback"}>
                    Değişiklik isteği (isteğe bağlı)
                  </Label>
                  <Textarea
                    id={screen.id + "-feedback"}
                    placeholder="Örn. Daha güçlü tipografi, sıcak renkler ve daha büyük ana eylem…"
                    value={feedback[screen.id] ?? ""}
                    maxLength={300}
                    disabled={busy}
                    onChange={(e) =>
                      setFeedback({ ...feedback, [screen.id]: e.target.value })
                    }
                  />
                  <Button
                    variant="outline"
                    disabled={
                      !enabled || loading || busy || history.length >= 3
                    }
                    onClick={() => void generate(screen.id)}
                  >
                    {latest ? "Yeni taslak üret" : "Görsel taslak üret"} ·{" "}
                    {history.length}/3
                    {" · $" +
                      designImageReservation(
                        designGenerationReferences(project, jobs, screen.id)
                          .length,
                      ).toFixed(2)}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {designGenerationReferences(project, jobs, screen.id).length
                      ? "Yeni taslak için onaylı referanslar: " +
                        designGenerationReferences(project, jobs, screen.id)
                          .map((job) => job.screenName)
                          .join(", ")
                      : "İlk onaylanan ekran, sonraki tasarımların görsel dilini belirleyecek."}
                  </p>
                  {(operation === screen.id || latest) && (
                    <OperationProgress
                      value={
                        operation === screen.id
                          ? 0
                          : latest?.status === "succeeded"
                            ? 100
                            : 50
                      }
                      label={
                        operation === screen.id
                          ? "Görsel üretim isteği gönderiliyor…"
                          : latest?.status === "running"
                            ? "AI tasarım görselini hazırlıyor…"
                            : latest?.status === "succeeded"
                              ? "Tasarım görseli hazır."
                              : "Görsel üretimi başarısız; yeniden deneyebilirsiniz."
                      }
                      detail="İki adım: isteğin kabul edilmesi ve görselin tamamlanması. Model ara ilerleme yüzdesi bildirmez."
                    />
                  )}
                  {history.length > 1 && (
                    <details>
                      <summary className="cursor-pointer text-xs">
                        Önceki taslaklar
                      </summary>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {history
                          .slice(0, -1)
                          .filter((j) => j.status === "succeeded")
                          .map((j, i) => (
                            <a
                              className="text-xs underline"
                              key={j.id}
                              href={"/api/design-images?assetId=" + j.id}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Taslak {i + 1}
                            </a>
                          ))}
                      </div>
                    </details>
                  )}
                </>
              )}
            </Card>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-white p-4">
        <p className="text-sm text-muted-foreground">
          {approved
            ? "Onaylanan görseller geliştirme referansına eklendi."
            : "Geliştirmeden önce her ekranın en güncel görselini onayla."}
        </p>
        {approved ? (
          <Button asChild>
            <Link href={"/projects/" + project.id + "/development"}>
              Geliştirmeye geç
            </Link>
          </Button>
        ) : (
          <Button
            disabled={!allReviewed || busy || !!connectionError || !!cloudError}
            onClick={() => void approve()}
          >
            Tasarımı onayla ve devam et
          </Button>
        )}
      </div>
      {operation === "approve" && (
        <OperationProgress value={0} label="Tasarım onayı kaydediliyor…" />
      )}
      {approved && (
        <p className="text-xs text-muted-foreground">
          Yeni bir tasarım turu için Plan veya Ekranlar bölümündeki içeriği
          güncelleyip tekrar onaylayabilirsin. Önceki görseller korunur.
        </p>
      )}
      {!enabled && !loading && !connectionError && (
        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer text-sm">
            API anahtarı olmadan yerel şablon akışı
          </summary>
          <div className="mt-4">
            <SpecificationEditor project={project} section="design" />
          </div>
        </details>
      )}
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer text-sm text-muted-foreground">
          Mevcut başlangıç şablonunu göster
        </summary>
        <div className="mt-4">
          <MobilePreview
            project={project}
            specification={spec}
            canReview={false}
            onReview={() => {}}
          />
        </div>
      </details>
    </div>
  );
}
