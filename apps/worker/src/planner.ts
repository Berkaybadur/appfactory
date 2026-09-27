import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  getSpecification,
  plannerJobSchema,
  projectSchema,
  projectIdSchema,
  type PlannerJob,
  type Project,
} from "@app-factory/schemas";
import { assertRealDirectory } from "@app-factory/generator";
import { model, reservation, runPlanner, PlannerError } from "@app-factory/ai";
export class PlannerManager {
  readonly jobs = new Map<string, PlannerJob>();
  private locked = false;
  get busy() {
    return this.locked;
  }
  constructor(
    private root: string,
    private key = process.env.OPENAI_API_KEY ?? "",
    private run = runPlanner,
  ) {}
  get enabled() {
    return !!this.key.trim();
  }
  private async persist(job: PlannerJob) {
    job.updatedAt = new Date().toISOString();
    const target = path.join(
      this.root,
      "workspace/planner",
      job.projectId + ".json",
    );
    await writeFile(target + ".tmp", JSON.stringify(job, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(target + ".tmp", target);
  }
  async initialize() {
    this.root = await realpath(this.root);
    const dir = path.join(this.root, "workspace/planner");
    await mkdir(dir, { recursive: true });
    await assertRealDirectory(dir);
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".json")) continue;
      const job = plannerJobSchema.parse(
        JSON.parse(await readFile(path.join(dir, file), "utf8")),
      );
      if (file !== job.projectId + ".json")
        throw new Error("AI iş kaydı dosya adı geçersiz.");
      if (job.status === "running") {
        job.status = "failed";
        job.uncertainCostUsd += job.reservedUsd;
        job.reservedUsd = 0;
        job.error =
          "Worker yeniden başladı. Önceki isteğin ücreti belirsiz; ayrılan bütçe korunuyor.";
        await this.persist(job);
      }
      this.jobs.set(job.projectId, job);
    }
  }
  async start(input: Project, retry = false) {
    const project = projectSchema
      .safeExtend({ id: projectIdSchema })
      .parse(input);
    const previous = this.jobs.get(project.id);
    const newAnalysis =
      previous &&
      getSpecification(project).revision > previous.baseRevision &&
      project.plannerJobId !== previous.id;
    if (newAnalysis && previous.status === "running")
      throw new Error("Mevcut AI analizinin tamamlanmasını bekleyin.");
    const existing = newAnalysis ? undefined : previous;
    if (existing && (existing.status !== "failed" || !retry)) return existing;
    if (!this.enabled)
      throw new Error("AI için worker ortamında OPENAI_API_KEY ayarlayın.");
    if (this.locked)
      throw new Error("Başka bir AI analizi sürüyor. Tamamlanmasını bekleyin.");
    if (
      existing &&
      existing.baseRevision !== getSpecification(project).revision
    )
      throw new Error("Proje değişti. Eski analiz yeniden denenemez.");
    const source = existing?.input ?? project;
    const reserved = reservation(source);
    const limit = existing?.taskLimitUsd ?? 0.1;
    const cost = existing?.costUsd ?? 0;
    const uncertain = existing?.uncertainCostUsd ?? 0;
    const prior =
      existing?.priorCostUsd ??
      Math.max(
        project.aiCost,
        previous
          ? previous.priorCostUsd + previous.costUsd + previous.uncertainCostUsd
          : 0,
      );
    if (prior + cost + uncertain + reserved > project.budgetLimit)
      throw new Error("Proje bütçesi bu istek için yetersiz.");
    const job: PlannerJob = {
      id: existing?.id ?? randomUUID(),
      projectId: project.id,
      baseRevision:
        existing?.baseRevision ?? getSpecification(project).revision,
      input: {
        name: source.name,
        type: "mobile",
        idea: source.idea,
        android: source.android,
        ios: source.ios,
        budgetLimit: project.budgetLimit,
      },
      priorCostUsd: prior,
      status: "running",
      attempts: (existing?.attempts ?? 0) + 1,
      costUsd: cost,
      uncertainCostUsd: uncertain,
      reservedUsd: reserved,
      taskLimitUsd: limit,
      model,
      output: null,
      error: null,
      updatedAt: new Date().toISOString(),
    };
    this.locked = true;
    try {
      await this.persist(job);
      this.jobs.set(project.id, job);
    } catch (e) {
      this.locked = false;
      throw e;
    }
    void this.execute(job);
    return job;
  }
  private async execute(job: PlannerJob) {
    try {
      const result = await this.run(job.input, this.key);
      job.costUsd += result.costUsd;
      job.output = result.output;
      job.status = "succeeded";
    } catch (e) {
      if (e instanceof PlannerError && e.costUsd !== null)
        job.costUsd += e.costUsd;
      else job.uncertainCostUsd += job.reservedUsd;
      job.status = "failed";
      job.error =
        e instanceof PlannerError ? e.message : "AI analizi tamamlanamadı.";
    } finally {
      job.reservedUsd = 0;
      try {
        await this.persist(job);
      } catch {
        job.status = "failed";
        job.error =
          "AI sonucu diske kaydedilemedi. Worker yeniden başlatıldığında bütçe korunacaktır.";
      }
      this.locked = false;
    }
  }
}
