"use client";
import {
  createSupabaseClient,
  type ProjectRepository,
} from "@app-factory/database";
import { projectSchema, type Project } from "@app-factory/schemas";

export const supabase = createSupabaseClient({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
});

export function projectRepository(
  ownerId: string,
  onDeleted?: (id: string) => void,
): ProjectRepository<Project> {
  const client = supabase!;
  let workspaceId: string | null = null;
  async function workspace() {
    if (workspaceId) return workspaceId;
    const { data, error } = await client
      .from("factory_workspace_members")
      .select("workspace_id")
      .eq("user_id", ownerId);
    if (error)
      throw new Error(
        "Ortak çalışma alanı okunamadı. Supabase kurulumunu kontrol edin.",
      );
    if (data.length !== 1)
      throw new Error(
        "Hesabınızı Supabase üzerinde ortak çalışma alanına ekleyin. Bu sürüm hesap başına bir çalışma alanı destekler.",
      );
    workspaceId = data[0]!.workspace_id as string;
    return workspaceId;
  }
  return {
    async deletedIds() {
      const { data, error } = await client
        .from("factory_project_deletions")
        .select("id")
        .eq("workspace_id", await workspace())
        .eq("completed", true);
      if (error?.code === "42P01" || error?.code === "PGRST205") return [];
      if (error)
        throw new Error(
          "Silme denetimi okunamadı. Supabase bağlantısını kontrol edin.",
        );
      const ids = data.map((row) => row.id as string);
      ids.forEach((id) => onDeleted?.(id));
      return ids;
    },
    async deleteProject(document, finish) {
      const { data: session } = await client.auth.getSession();
      if (session.session?.user.id !== ownerId)
        throw new Error("Oturum değişti; silme durduruldu.");
      const { error } = await client.rpc("delete_factory_project", {
        target_workspace: await workspace(),
        target_id: document.id,
        confirmation: document.name,
        finish,
      });
      if (error)
        throw new Error(
          "Supabase silme işlemi tamamlanamadı. Bağlantıyı, güncel proje adını ve 202609270001_project_deletion.sql migration kurulumunu kontrol edip silmeyi yeniden deneyin.",
        );
    },
    async list() {
      const { data, error } = await client
        .from("factory_projects")
        .select("document, version")
        .eq("workspace_id", await workspace())
        .order("updated_at", { ascending: false });
      if (error)
        throw new Error(
          "Supabase kayıtları okunamadı. Veritabanı kurulumunu kontrol edin.",
        );
      return data.map((row) => ({
        document: projectSchema.parse(row.document),
        version: row.version as number,
      }));
    },
    async save(document, expectedVersion) {
      const { data: session } = await client.auth.getSession();
      if (session.session?.user.id !== ownerId)
        throw new Error("Oturum değişti; kayıt gönderilmedi.");
      const { data, error } = await client.rpc("save_factory_project", {
        target_workspace: await workspace(),
        project_document: projectSchema.parse(document),
        expected_version: expectedVersion,
      });
      if (error)
        throw new Error(
          error.code === "40001"
            ? "Bu proje başka cihazda değişti. Bekleyen değişiklikleri indirip bulut sürümünü yükleyin."
            : "Supabase kaydı başarısız. Değişiklikler bu tarayıcıda bekliyor; bağlantıyı ve veritabanı kurulumunu kontrol edin.",
        );
      const row = data?.[0];
      if (!row || !Number.isSafeInteger(row.version))
        throw new Error("Bulut kayıt yanıtı doğrulanamadı.");
      return {
        document: projectSchema.parse(row.document),
        version: row.version as number,
      };
    },
  };
}
