export type CloudRow<T> = { document: T; version: number };
export type PendingProject<T> = { document: T; expectedVersion: number };
export interface ProjectRepository<T> {
  list(): Promise<CloudRow<T>[]>;
  save(document: T, expectedVersion: number): Promise<CloudRow<T>>;
  deletedIds?(): Promise<string[]>;
  deleteProject?(document: T, finish: boolean): Promise<void>;
}

/** One writer per browser session; failed saves remain in a durable outbox. */
export class ProjectSync<T extends { id: string }> {
  private rows = new Map<string, CloudRow<T>>();
  private pending = new Map<string, PendingProject<T>>();
  private running = false;
  private stopped = false;
  private loaded = false;
  private deleted = new Set<string>();
  private deleting = false;
  constructor(
    private repository: ProjectRepository<T>,
    pending: PendingProject<T>[],
    private persist: (pending: PendingProject<T>[]) => void,
    private changed: (
      projects: T[],
      status: "synced" | "saving" | "loading" | "refreshing" | "error",
      error?: string,
      progress?: number,
    ) => void,
  ) {
    for (const item of pending) this.pending.set(item.document.id, item);
  }
  stop() {
    this.stopped = true;
  }
  private notify(
    status: "synced" | "saving" | "loading" | "refreshing" | "error",
    error?: string,
    progress?: number,
  ) {
    if (this.stopped) return;
    const projects = new Map(
      [...this.rows].map(([id, row]) => [id, row.document]),
    );
    for (const [id, item] of this.pending) projects.set(id, item.document);
    this.changed([...projects.values()], status, error, progress);
  }
  async refresh() {
    if (this.running || this.stopped) return;
    this.running = true;
    // Only the first load should replace the UI with its loading screen.
    this.notify(this.loaded ? "refreshing" : "loading", undefined, 0);
    try {
      const deleted = this.repository.deletedIds
        ? await this.repository.deletedIds()
        : [];
      if (this.stopped) return;
      for (const id of deleted) {
        this.deleted.add(id);
        this.pending.delete(id);
      }
      if (deleted.length) this.persist([...this.pending.values()]);
      const rows = await this.repository.list();
      if (this.stopped) return;
      this.rows = new Map(
        rows
          .filter((row) => !this.deleted.has(row.document.id))
          .map((row) => [row.document.id, row]),
      );
      this.loaded = true;
      this.notify(
        this.pending.size ? "saving" : "synced",
        undefined,
        Math.round(100 / (1 + this.pending.size)),
      );
    } catch (error) {
      this.notify(
        "error",
        error instanceof Error
          ? error.message
          : "Supabase kayıtları alınamadı. Bağlantıyı ve veritabanı kurulumunu kontrol edin.",
      );
      return;
    } finally {
      this.running = false;
    }
    await this.flush(1);
  }
  enqueue(projects: T[]) {
    if (this.deleting)
      throw new Error("Proje silme işleminin bitmesini bekleyin.");
    if (this.stopped) throw new Error("Oturum değişti. Yeniden giriş yapın.");
    const next = new Map(this.pending);
    for (const document of projects) {
      if (this.deleted.has(document.id)) continue;
      const previous = next.get(document.id);
      if (
        JSON.stringify(
          previous?.document ?? this.rows.get(document.id)?.document,
        ) === JSON.stringify(document)
      )
        continue;
      next.set(document.id, {
        document,
        expectedVersion:
          previous?.expectedVersion ?? this.rows.get(document.id)?.version ?? 0,
      });
    }
    // Storage failure must prevent reporting the edit as queued successfully.
    this.persist([...next.values()]);
    this.pending = next;
    this.notify(this.pending.size ? "saving" : "synced", undefined, 0);
    void this.flush();
  }
  async deleteProject(document: T, cleanup: () => Promise<void>) {
    if (this.running || this.stopped || !this.loaded)
      throw new Error("Bulut eşitlemesinin bitmesini bekleyip tekrar deneyin.");
    if (!this.repository.deleteProject)
      throw new Error("Bulut silme desteği kurulmamış.");
    this.running = true;
    this.deleting = true;
    try {
      await this.repository.deleteProject(document, false);
      await cleanup();
      await this.repository.deleteProject(document, true);
      this.deleted.add(document.id);
      this.pending.delete(document.id);
      this.rows.delete(document.id);
      this.persist([...this.pending.values()]);
      this.notify(this.pending.size ? "saving" : "synced");
    } catch (error) {
      this.notify(
        "error",
        error instanceof Error ? error.message : "Proje silinemedi.",
      );
      throw error;
    } finally {
      this.running = false;
      this.deleting = false;
    }
    await this.flush();
  }
  async flush(completed = 0) {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (this.pending.size && !this.stopped) {
        const [id, item] = this.pending.entries().next().value!;
        const saved = await this.repository.save(
          item.document,
          item.expectedVersion,
        );
        if (this.stopped) return;
        const next = new Map(this.pending);
        if (next.get(id) === item) next.delete(id);
        else next.set(id, { ...next.get(id)!, expectedVersion: saved.version });
        this.persist([...next.values()]);
        this.pending = next;
        this.rows.set(id, saved);
        completed++;
        this.notify(
          this.pending.size ? "saving" : "synced",
          undefined,
          Math.round((100 * completed) / (completed + this.pending.size)),
        );
      }
    } catch (error) {
      this.notify(
        "error",
        error instanceof Error
          ? error.message
          : "Buluta kaydedilemedi; değişiklik bu tarayıcıda bekliyor.",
      );
    } finally {
      this.running = false;
    }
  }
}
