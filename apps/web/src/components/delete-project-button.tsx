"use client";
import { useId, useState } from "react";
import { Trash2, LoaderCircle } from "lucide-react";
import type { Project } from "@app-factory/schemas";
import { useProjects } from "./project-provider";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function DeleteProjectButton({ project }: { project: Project }) {
  const { deleteProject } = useProjects();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  return (
    <div className="border-t px-6 py-4">
      {!open ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          aria-label={`${project.name} projesini sil`}
          onClick={() => setOpen(true)}
        >
          <Trash2 /> Projeyi sil
        </Button>
      ) : (
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy || confirmation !== project.name) return;
            setBusy(true);
            setError(null);
            try {
              await deleteProject(project.id, confirmation);
            } catch (error) {
              setError(
                error instanceof Error ? error.message : "Silme tamamlanamadı.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="text-sm text-destructive">Bu işlem geri alınamaz.</p>
          <p className="text-xs text-muted-foreground">
            Silmeden önce diğer bilgisayarlarda bu projeyi kapatın. Bu
            bilgisayardaki proje dosyaları, üretilen görseller ve iş kayıtları,
            ortak Supabase kayıtları ve GitHub deposu silinecek. Diğer
            bilgisayarlarda indirilmiş dosyalar ayrıca temizlenmelidir.
          </p>
          <label htmlFor={inputId} className="block text-xs">
            Onaylamak için <strong>{project.name}</strong> yazın.
          </label>
          <Input
            id={inputId}
            autoComplete="off"
            value={confirmation}
            disabled={busy}
            onChange={(event) => setConfirmation(event.target.value)}
          />
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error} Bazı adımlar tamamlanmış olabilir; silmeyi yeniden
              deneyebilirsiniz.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="destructive"
              size="sm"
              disabled={busy || confirmation !== project.name}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              {busy ? "Siliniyor…" : "Kalıcı olarak sil"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setConfirmation("");
                setError(null);
              }}
            >
              Vazgeç
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
