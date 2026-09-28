"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  smokeReportSchema,
  type Project,
  type SmokeReport,
  type SmokeCheck,
} from "@app-factory/schemas";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "./ui/card";
import { useProjects } from "./project-provider";

type State = {
  reports: SmokeReport[];
  fingerprint: string;
  designApproved: boolean;
  functionalApproved: boolean;
  busy: boolean;
  enabled: boolean;
  platforms: ("android" | "ios")[];
};
const labels = {
  pending: "Test bekliyor",
  passed: "Başarılı",
  failed: "Sorun bulundu",
  blocked: "Test edilemedi",
};
type Capture = {
  checkId: string;
  pngBase64?: string;
  actual?: string;
  result?: "passed" | "failed" | "blocked";
  steps?: string[];
};
export function SmokePanel({
  project,
  sourceJobId,
  revisionBusy,
}: {
  project: Project;
  sourceJobId: string | null;
  revisionBusy: boolean;
}) {
  const [state, setState] = useState<State | null>(null);
  const [phase, setPhase] = useState<"design" | "functional">("design");
  const [platform, setPlatform] = useState<"android" | "ios">(
    project.android ? "android" : "ios",
  );
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [reviewed, setReviewed] = useState("");
  const inFlight = useRef(false),
    requestId = useRef<string | null>(null);
  const { syncImageCost, syncSmoke } = useProjects();
  const receive = useCallback(
    (data: State & { totalCostUsd?: number }) => {
      setState({
        ...data,
        reports: data.reports.map((r) => smokeReportSchema.parse(r)),
      });
      if (typeof data.totalCostUsd === "number")
        syncImageCost(project.id, data.totalCostUsd);
      syncSmoke(project, data.functionalApproved);
    },
    [project, syncImageCost, syncSmoke],
  );
  useEffect(() => {
    if (!sourceJobId) return;
    let active = true,
      fetching = false;
    const controller = new AbortController();
    async function poll() {
      if (fetching || inFlight.current) return;
      fetching = true;
      try {
        const r = await fetch("/api/smoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "info",
            project: { ...project, revisions: [] },
            sourceJobId,
          }),
          signal: controller.signal,
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Rapor alınamadı.");
        if (active && !inFlight.current) {
          receive(data);
          setConnectionError("");
        }
      } catch (e) {
        if (active)
          setConnectionError(
            e instanceof Error ? e.message : "Rapor alınamadı.",
          );
      } finally {
        fetching = false;
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 4000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [project, sourceJobId, receive]);
  const report = state?.reports
    .filter((r) => r.phase === phase && r.platform === platform)
    .at(-1);
  const stale = !!report && report.fingerprint !== state?.fingerprint;
  const busy = pending || !!state?.busy || revisionBusy;
  const locked =
    busy || stale || (phase === "functional" && !state?.designApproved);
  async function action(
    kind: "start" | "capture" | "run" | "approve" | "repair",
    extra?: Capture,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      if (kind === "start" || kind === "repair")
        requestId.current ??= crypto.randomUUID();
      const r = await fetch("/api/smoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: kind,
          project: { ...project, revisions: [] },
          sourceJobId,
          phase,
          platform,
          reportId: report?.id,
          fingerprint: state?.fingerprint,
          ...(requestId.current ? { requestId: requestId.current } : {}),
          ...extra,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "İşlem başarısız.");
      receive(data);
      requestId.current = null;
      setReviewed("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "İşlem başarısız.");
      throw e;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  const send = (kind: "start" | "run" | "approve" | "repair") => {
    void action(kind).catch(() => {});
  };
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle>Expo Go smoke testleri</CardTitle>
        <CardDescription>
          Önce tasarımı, ardından işlevleri Android ve iOS cihazlarınızda
          kontrol edin. Raporları inceledikten sonra düzeltme komutunu siz
          verirsiniz.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Seçili kod sürümünün QR kodunu Expo Go’da açın. Tasarımda her ekranın
          gerçek PNG görüntüsünü yükleyin; AI onaylı tasarımla karşılaştırır.
          İşlev testlerini cihazda siz uygulayıp adımları ve sonuçları
          kaydedersiniz.
        </p>
        {!sourceJobId && (
          <p>Önce kod kontrollerinden geçen bir çıktı oluşturun.</p>
        )}
        <div className="flex flex-wrap gap-3">
          <label className="text-sm">
            Test aşaması
            <select
              aria-label="Smoke test aşaması"
              className="ml-2 rounded border bg-background p-2"
              disabled={busy}
              value={phase}
              onChange={(e) => {
                setPhase(e.target.value as typeof phase);
                setReviewed("");
                requestId.current = null;
              }}
            >
              <option value="design">1. Tasarım</option>
              <option value="functional">2. İşlev</option>
            </select>
          </label>
          <label className="text-sm">
            Platform
            <select
              aria-label="Smoke test platformu"
              className="ml-2 rounded border bg-background p-2"
              disabled={busy}
              value={platform}
              onChange={(e) => {
                setPlatform(e.target.value as typeof platform);
                setReviewed("");
                requestId.current = null;
              }}
            >
              {project.android && <option value="android">Android</option>}
              {project.ios && <option value="ios">iOS</option>}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">
            Tasarım:{" "}
            {state?.designApproved ? "Tüm platformlar onaylı" : "Bekliyor"}
          </Badge>
          <Badge variant="outline">
            İşlev:{" "}
            {state?.functionalApproved ? "Tüm platformlar onaylı" : "Bekliyor"}
          </Badge>
        </div>
        {phase === "functional" && !state?.designApproved && (
          <p className="text-sm">
            İşlev testleri, projedeki tüm platformların tasarım raporları
            sorunsuz tamamlanıp onaylandığında açılır.
          </p>
        )}
        {stale && (
          <p className="text-sm text-amber-700">
            Bu rapor eski koda veya tasarıma ait. Güncel sürüm için yeni test
            başlatın.
          </p>
        )}
        {(error || connectionError) && (
          <p role="alert" className="text-sm text-destructive">
            {error || connectionError}
          </p>
        )}
        <Button
          variant="outline"
          disabled={
            !sourceJobId ||
            !state ||
            busy ||
            (phase === "design" && !state.enabled) ||
            (phase === "functional" && !state.designApproved) ||
            (!!report && !stale && ["draft", "running"].includes(report.status))
          }
          onClick={() => send("start")}
        >
          {report ? "Yeni smoke testi başlat" : "Smoke testi başlat"}
        </Button>
        {report && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              {platform === "ios" ? "iOS" : "Android"} ·{" "}
              {new Date(report.createdAt).toLocaleString("tr-TR")} ·{" "}
              {report.checks.filter((c) => c.status === "failed").length} sorun
              · {report.checks.filter((c) => c.status === "blocked").length}{" "}
              test engeli · AI maliyeti $
              {(report.costUsd + report.uncertainCostUsd).toFixed(4)}
            </p>
            {report.status === "running" && (
              <p role="status">
                Onaylı tasarımlar ile Expo ekranları karşılaştırılıyor…
              </p>
            )}
            {report.error && (
              <p role="alert" className="text-destructive">
                {report.error}
              </p>
            )}
            {report.checks.map((check, index) => (
              <SmokeCheckRow
                key={report.id + ":" + check.id}
                check={check}
                index={index}
                report={report}
                project={project}
                disabled={locked}
                save={(value) => action("capture", value)}
              />
            ))}
            {report.status === "draft" && (
              <Button
                disabled={
                  locked ||
                  report.checks.some((c) =>
                    phase === "design"
                      ? !c.evidence.length
                      : c.status === "pending",
                  )
                }
                onClick={() => send("run")}
              >
                {phase === "design"
                  ? "Tasarımları karşılaştır ve sorun listesini oluştur"
                  : "İşlev testi raporunu oluştur"}
              </Button>
            )}
            {report.status === "review" &&
              !report.repairJobId &&
              !report.reviewedAt && (
                <>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={reviewed === report.id}
                      disabled={locked}
                      onChange={(e) =>
                        setReviewed(e.target.checked ? report.id : "")
                      }
                    />
                    Bulgu listesini ve ekran kanıtlarını inceledim.
                  </label>
                  {report.checks.some((c) => c.status === "failed") ? (
                    <>
                      <p className="text-xs text-muted-foreground">
                        Düzeltme AI bütçesini kullanır ve ayrı bir kod sürümü
                        oluşturur. Yeni sürümde her iki platformun tasarım ve
                        işlev testlerini yeniden uygulayın.
                      </p>
                      <Button
                        disabled={
                          locked || reviewed !== report.id || !state?.enabled
                        }
                        onClick={() => send("repair")}
                      >
                        Sorunları gider
                      </Button>
                    </>
                  ) : (
                    <Button
                      disabled={
                        locked ||
                        reviewed !== report.id ||
                        report.checks.some((c) => c.status !== "passed")
                      }
                      onClick={() => send("approve")}
                    >
                      Sorunsuz raporu onayla
                    </Button>
                  )}
                  {report.checks.some((c) => c.status === "blocked") && (
                    <p className="text-sm">
                      Test edilemeyen maddeler başarı sayılmaz. Test koşullarını
                      tamamlayıp yeni test başlatın.
                    </p>
                  )}
                </>
              )}
            {report.repairJobId && (
              <p className="text-sm">
                Düzeltme başlatıldı. Revizyon durumunu aşağıdan izleyin;
                başarısızsa yeniden deneyin. Hazır olduğunda yeni çalışan sürümü
                seçip Expo testlerini tekrarlayın.
              </p>
            )}
            {report.reviewedAt && !report.repairJobId && (
              <p className="text-sm">Rapor onaylandı.</p>
            )}
          </div>
        )}
        {!!state?.reports.length && (
          <details>
            <summary className="cursor-pointer text-sm">
              Test geçmişi ({state.reports.length})
            </summary>
            <ul className="mt-2 space-y-1 text-xs">
              {state.reports.map((r) => (
                <li key={r.id}>
                  {r.platform} · {r.phase === "design" ? "Tasarım" : "İşlev"} ·{" "}
                  {new Date(r.createdAt).toLocaleString("tr-TR")} ·{" "}
                  {r.status === "review"
                    ? `${r.checks.filter((c) => c.status === "failed").length} sorun`
                    : r.status === "draft"
                      ? "Sonuç bekliyor"
                      : r.status === "running"
                        ? "Çalışıyor"
                        : "Başarısız"}{" "}
                  ·{" "}
                  {r.fingerprint !== state.fingerprint
                    ? "Eski sürüm"
                    : "Güncel sürüm"}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function SmokeCheckRow({
  check,
  index,
  report,
  project,
  disabled,
  save,
}: {
  check: SmokeCheck;
  index: number;
  report: SmokeReport;
  project: Project;
  disabled: boolean;
  save: (value: Capture) => Promise<void>;
}) {
  const [actual, setActual] = useState(
    check.status === "pending" ? "" : check.actual,
  );
  const [steps, setSteps] = useState(check.steps.join("\n"));
  const [result, setResult] = useState<"passed" | "failed" | "blocked">(
    check.status === "pending" ? "passed" : check.status,
  );
  const [file, setFile] = useState<File | null>(null),
    [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const ref = project.designReview?.images?.find(
    (r) => r.screenId === check.screenId,
  );
  const evidence = check.evidence[0]
    ? `/api/smoke?reportId=${report.id}&file=${check.evidence[0]}`
    : null;
  async function submit() {
    setError("");
    setSaving(true);
    try {
      let pngBase64: string | undefined;
      if (file) {
        if (file.size > 10_000_000 || file.type !== "image/png")
          throw new Error("En fazla 10 MB boyutunda PNG seçin.");
        pngBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]!);
          reader.onerror = () => reject(new Error("Görsel okunamadı."));
          reader.readAsDataURL(file);
        });
      }
      await save({
        checkId: check.id,
        ...(pngBase64 ? { pngBase64 } : {}),
        ...(report.phase === "functional"
          ? {
              actual,
              result,
              steps: steps
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : {}),
      });
      setFile(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kaydedilemedi.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <details
      className="rounded-md border p-4"
      open={
        report.status === "draft" ||
        check.status === "failed" ||
        check.status === "blocked"
      }
    >
      <summary className="cursor-pointer text-sm font-medium">
        {index + 1}. {check.title} · {labels[check.status]}
      </summary>
      <div className="mt-3 space-y-3 text-sm">
        <p>
          <strong>Beklenen:</strong> {check.expected}
        </p>
        {check.status !== "pending" && (
          <p className="whitespace-pre-wrap">
            <strong>Gözlenen:</strong> {check.actual}
          </p>
        )}
        {report.status !== "draft" && check.steps.length > 0 && (
          <ol className="list-inside list-decimal">
            {check.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {report.phase === "design" && ref && (
            <Evidence
              url={`/api/design-images?assetId=${ref.assetId}`}
              title="Onaylı tasarım"
            />
          )}
          {evidence && (
            <Evidence
              url={evidence}
              title={`Expo Go · ${report.platform === "ios" ? "iOS" : "Android"}`}
            />
          )}
        </div>
        {report.status === "draft" && (
          <fieldset disabled={disabled || saving} className="space-y-3">
            {report.phase === "functional" && (
              <>
                <label className="block">
                  Sonuç
                  <select
                    className="mt-1 block rounded border bg-background p-2"
                    value={result}
                    onChange={(e) => setResult(e.target.value as typeof result)}
                  >
                    <option value="passed">Başarılı</option>
                    <option value="failed">Sorun bulundu</option>
                    <option value="blocked">Test edilemedi</option>
                  </select>
                </label>
                <label className="block">
                  Uyguladığınız adımlar
                  <textarea
                    className="mt-1 block min-h-20 w-full rounded border p-2"
                    value={steps}
                    maxLength={3000}
                    onChange={(e) => setSteps(e.target.value)}
                    placeholder="Her adımı ayrı satıra yazın."
                  />
                </label>
                <label className="block">
                  Cihazda gözlemlediğiniz sonuç
                  <textarea
                    className="mt-1 block min-h-20 w-full rounded border p-2"
                    value={actual}
                    maxLength={1500}
                    onChange={(e) => setActual(e.target.value)}
                    placeholder="Beklenen ile gerçekleşen davranışı belirtin."
                  />
                </label>
              </>
            )}
            <label className="block">
              {report.phase === "design"
                ? "Bu sürümün Expo ekran görüntüsü (PNG, zorunlu)"
                : "Ekran kanıtı (PNG, isteğe bağlı)"}
              <input
                className="mt-1 block w-full text-xs"
                type="file"
                accept="image/png"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <Button
              variant="outline"
              disabled={
                saving ||
                (report.phase === "design"
                  ? !file
                  : actual.trim().length < 5 || !steps.trim())
              }
              onClick={() => void submit()}
            >
              {saving ? "Kaydediliyor…" : "Test sonucunu kaydet"}
            </Button>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </fieldset>
        )}
      </div>
    </details>
  );
}
function Evidence({ url, title }: { url: string; title: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="rounded border p-2"
    >
      <p className="mb-2 text-xs">{title}</p>
      <Image
        unoptimized
        src={url}
        alt={title}
        width={390}
        height={844}
        className="h-64 w-full object-contain"
      />
    </a>
  );
}
