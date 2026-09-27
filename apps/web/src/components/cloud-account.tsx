"use client";
import { useState } from "react";
import { useProjects } from "./project-provider";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { storedProjectsSchema } from "@app-factory/schemas";

export function CloudAccount() {
  const {
    cloud,
    importLocalProjects,
    retryCloud,
    downloadPending,
    loadCloudVersion,
  } = useProjects();
  const [message, setMessage] = useState("");
  const [backup, setBackup] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  async function run(action: string, operation: () => void | Promise<void>) {
    setPending(action);
    try {
      await operation();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "İşlem tamamlanamadı.",
      );
    } finally {
      setPending(null);
    }
  }
  function percentage(action: string) {
    const active = pending === action || cloud.action === action;
    return active
      ? ` · %${cloud.action === action || action === "load" ? (cloud.progress ?? 0) : 0}`
      : "";
  }
  const busy =
    pending !== null ||
    cloud.status === "loading" ||
    cloud.status === "refreshing" ||
    cloud.status === "saving";
  return (
    <details
      className="my-4 rounded-lg border bg-white p-4"
      open={cloud.status === "error" || pending === "load" || undefined}
    >
      <summary className="cursor-pointer text-sm font-medium">
        Bulut kaydı ve işlemleri
      </summary>
      <div className="mt-4 space-y-3 text-sm">
        {!cloud.configured ? (
          <p>
            Bulut kaydı yapılandırılmamış. Projeler şu anda bu tarayıcıda
            saklanıyor. Supabase bağlantısı eklendiğinde aynı hesapla diğer
            cihazlardan erişebilirsiniz.
          </p>
        ) : !cloud.userId ? (
          <p>Bulut işlemleri için giriş yapın.</p>
        ) : (
          <>
            <p>
              Projeler, planlar, ekran tanımları ve tasarım tercihleri ortak
              çalışma alanında saklanır. Tasarım görselleri proje ile aynı
              private GitHub deposunda PNG dosyaları olarak paylaşılır. Expo
              dosyaları ve çalışan önizleme üretim bilgisayarında kalır.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  try {
                    importLocalProjects();
                    setMessage(
                      "Yeni yerel projeler aktarım kuyruğuna alındı; ortak alandaki mevcut projeler korundu.",
                    );
                  } catch (e) {
                    setMessage(
                      e instanceof Error ? e.message : "Aktarılamadı.",
                    );
                  }
                }}
              >
                Yerel projeleri ortak alana aktar
                {percentage("import")}
              </Button>
              <Button variant="outline" onClick={retryCloud} disabled={busy}>
                Buluttan yenile / yeniden dene
                {percentage("refresh")}
              </Button>
              <Button
                variant="default"
                disabled={busy}
                onClick={() =>
                  void run("export", () => {
                    try {
                      const raw = localStorage.getItem(
                        "app-factory.projects.v1",
                      );
                      setBackup(
                        JSON.stringify(
                          storedProjectsSchema.parse(
                            JSON.parse(raw ?? '{"version":1,"projects":[]}'),
                          ),
                          null,
                          2,
                        ),
                      );
                    } catch {
                      setMessage("Yerel proje yedeği okunamadı.");
                    }
                  })
                }
              >
                Yerel projeleri dışa aktar
                {percentage("export")}
              </Button>
            </div>
            {(cloud.status === "error" || pending === "load") && (
              <div className="space-y-2">
                <p role="alert" className="text-destructive">
                  {cloud.error}
                </p>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run("pending", downloadPending)}
                >
                  Bekleyen değişiklikleri indir
                  {percentage("pending")}
                </Button>{" "}
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run("load", async () => {
                      try {
                        await loadCloudVersion();
                        setMessage("");
                      } catch (e) {
                        setMessage(
                          e instanceof Error ? e.message : "Yüklenemedi.",
                        );
                      }
                    })
                  }
                >
                  İndirdiğim değişiklikleri bırak, bulut sürümünü yükle
                  {percentage("load")}
                </Button>
              </div>
            )}
          </>
        )}
        {backup !== null && (
          <div className="space-y-2">
            <Label htmlFor="local-project-backup">
              Yerel proje yedeği (JSON)
            </Label>
            <Textarea
              id="local-project-backup"
              readOnly
              value={backup}
              className="min-h-32 font-mono text-xs"
            />
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run("backup", () => {
                  const url = URL.createObjectURL(
                    new Blob([backup], { type: "application/json" }),
                  );
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = "app-factory-projeler.json";
                  link.click();
                  URL.revokeObjectURL(url);
                })
              }
            >
              Yedeği indir
              {percentage("backup")}
            </Button>
          </div>
        )}
        {message && <p role="status">{message}</p>}
      </div>
    </details>
  );
}
