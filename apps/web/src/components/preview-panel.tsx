"use client";
import { useEffect, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  previewSessionSchema,
  previewApprovalSchema,
  type PreviewSession,
  type PreviewApproval,
  type Project,
} from "@app-factory/schemas";
import { Button } from "./ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "./ui/card";
import { Badge } from "./ui/badge";
import { EasPanel } from "./eas-panel";
import { useProjects } from "./project-provider";
export function PreviewPanel({
  project,
  sourceJobId,
  feedback,
}: {
  project: Project;
  sourceJobId: string | null;
  feedback?: ReactNode;
}) {
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [approvals, setApprovals] = useState<PreviewApproval[]>([]);
  const [occupied, setOccupied] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const [ios, setIos] = useState(false),
    [android, setAndroid] = useState(false);
  const { syncPreview } = useProjects();
  const current = session?.sourceJobId === sourceJobId ? session : null;
  const approval = approvals.find((a) => a.sourceJobId === sourceJobId);
  const approved =
    !!approval && (!current || current.fingerprint === approval.fingerprint);
  function receive(data: {
    session: unknown;
    approvals: unknown[];
    occupied: boolean;
  }) {
    setSession(data.session ? previewSessionSchema.parse(data.session) : null);
    setApprovals(data.approvals.map((a) => previewApprovalSchema.parse(a)));
    setOccupied(!!data.occupied);
  }
  useEffect(() => {
    let closed = false,
      fetching = false;
    const controller = new AbortController();
    async function poll() {
      if (fetching) return;
      fetching = true;
      try {
        const r = await fetch(
          `/api/preview?projectId=${encodeURIComponent(project.id)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Önizleme bilgisi alınamadı.");
        if (!closed) receive(data);
      } catch (e) {
        if (!closed)
          setError(
            e instanceof Error ? e.message : "Önizleme bağlantısı kesildi.",
          );
      } finally {
        fetching = false;
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => {
      closed = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [project.id]);
  async function post(body: object) {
    const r = await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? "Önizleme işlemi başarısız.");
    receive(data);
  }
  async function action(kind: "start" | "stop" | "approve" | "restart") {
    setPending(true);
    setError("");
    try {
      if (kind === "stop" || kind === "restart")
        await post({
          action: "stop",
          projectId: project.id,
          sessionId: session?.id,
        });
      if (kind !== "stop")
        await post({
          action: kind === "restart" ? "start" : kind,
          project: { ...project, revisions: [] },
          sourceJobId,
          ...(kind === "approve"
            ? {
                sessionId: current?.id,
                platforms: [
                  ...(ios ? ["ios"] : []),
                  ...(android ? ["android"] : []),
                ],
              }
            : {}),
        });
      if (kind === "start" || kind === "restart") {
        setIos(false);
        setAndroid(false);
      }
      if (kind === "approve") syncPreview(project);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Önizleme işlemi başarısız.");
    } finally {
      setPending(false);
    }
  }
  const active = !!session && ["starting", "ready"].includes(session.status);
  return (
    <div className="space-y-5">
      <Card className="shadow-none">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>1. Telefonda önizle · Expo Go</CardTitle>
            <Badge variant="secondary">
              {current?.status === "ready"
                ? "QR hazır"
                : current?.status === "starting"
                  ? "Expo başlatılıyor"
                  : approved
                    ? "Önizleme onaylandı"
                    : "Onay bekleniyor"}
            </Badge>
          </div>
          <CardDescription>
            Geliştirme → kod kontrolleri → telefonda inceleme ve onay → build.
            Önizleme için APK veya iOS build gerekmez.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!sourceJobId && (
            <p className="text-sm">
              Önce güncel projenin üretimini ve kod kontrollerini tamamlayın.
            </p>
          )}
          {occupied && (
            <p className="text-sm">
              Başka bir projenin önizlemesi açık. O projenin panelinden
              durdurun.
            </p>
          )}
          {active && !current && session?.projectId === project.id && (
            <div className="space-y-2 rounded-md border border-amber-300 p-3 text-sm">
              <p>
                Açık önizleme önceki sürümü gösteriyor. Yeni kodu telefonda
                görmek için önizlemeyi yeni sürümle yeniden başlatın.
              </p>
              <Button
                disabled={!sourceJobId || pending}
                onClick={() => void action("restart")}
              >
                Yeni sürümle önizlemeyi yeniden başlat
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!sourceJobId || pending || active || occupied}
              onClick={() => void action("start")}
            >
              Expo önizlemesini başlat
            </Button>
            {active && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void action("stop")}
              >
                Önizlemeyi durdur
              </Button>
            )}
          </div>
          {current?.status === "starting" && (
            <p className="text-sm">
              iOS ve Android Expo manifestleri hazırlanıyor…
            </p>
          )}
          {current?.status === "ready" && current.url && (
            <div className="flex flex-wrap items-start gap-6">
              <div className="rounded border bg-white p-2">
                <QRCodeSVG
                  value={current.url}
                  size={224}
                  marginSize={4}
                  title="Expo Go ile açmak için QR kodu"
                />
              </div>
              <div className="max-w-lg space-y-2 text-sm">
                <p className="font-medium">iOS ve Android için aynı QR kodu</p>
                <p>
                  Telefon ve bilgisayar aynı Wi-Fi ağına bağlı olmalı. iPhone’da
                  Kamera ile, Android’de Expo Go içindeki QR tarayıcıyla okutun.
                </p>
                <p>
                  iPhone’daki Expo Go’da panelde bağlı olan Expo hesabıyla giriş
                  yapın. Bu proje için SDK {current.sdkVersion} destekleyen Expo
                  Go gerekir.
                </p>
                <p className="break-all font-mono text-xs">{current.url}</p>
                <p className="text-muted-foreground">
                  Bilgisayar ve önizleme açık kalmalı. QR’ın hazır olması cihaz
                  testinin başarılı olduğu anlamına gelmez. Telefon
                  bağlanamıyorsa Wi-Fi, VPN ve yerel ağ izinlerini kontrol edin.
                </p>
                <a
                  className="underline"
                  href="https://expo.dev/go"
                  target="_blank"
                  rel="noreferrer"
                >
                  Uyumlu Expo Go sürümünü aç
                </a>
              </div>
            </div>
          )}
          {(error || current?.error) && (
            <p role="alert" className="text-sm text-destructive">
              {error || current?.error}
            </p>
          )}
          {current?.status === "ready" && (
            <div className="space-y-3 border-t pt-4">
              <p className="text-sm">
                Uygulamayı telefonda açıp ekranları ve temel işlemleri kontrol
                ettikten sonra denediğiniz cihazı seçin.
              </p>
              <div className="flex flex-wrap gap-5 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={ios}
                    onChange={(e) => setIos(e.target.checked)}
                  />
                  iPhone’da kontrol ettim
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={android}
                    onChange={(e) => setAndroid(e.target.checked)}
                  />
                  Android’de kontrol ettim
                </label>
              </div>
              <Button
                disabled={pending || (!ios && !android)}
                onClick={() => void action("approve")}
              >
                Önizlemeyi onayla, build adımını aç
              </Button>
            </div>
          )}
          {approved && (
            <p className="text-sm">
              Kullanıcı onayı kaydedildi:{" "}
              {approval.platforms
                .map((p) => (p === "ios" ? "iOS" : "Android"))
                .join(", ")}
              . Diğer platformlar test edilmiş sayılmaz. Kod değişirse yeniden
              onay gerekir.
            </p>
          )}
          {session?.log && (
            <details className="text-sm">
              <summary className="cursor-pointer">Expo günlükleri</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                {session.log}
              </pre>
            </details>
          )}
        </CardContent>
      </Card>
      {feedback}
      <EasPanel
        project={project}
        sourceJobId={sourceJobId}
        previewApproved={approved}
      />
    </div>
  );
}
