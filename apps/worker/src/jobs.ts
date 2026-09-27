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
  generationJobSchema,
  getSpecification,
  sameSpecification,
  type GenerationJob,
  type Project,
  type JobCheck,
} from "@app-factory/schemas";
import {
  generateProject,
  assertRealDirectory,
  outputDirectory,
} from "@app-factory/generator";
import { runCommand } from "./runner";
const busy = (job: GenerationJob) =>
  ["queued", "generating", "validating"].includes(job.status);
export class JobManager {
  readonly jobs = new Map<string, GenerationJob>();
  private queue: GenerationJob[] = [];
  private working = false;
  constructor(public root: string) {}
  private async persist(job: GenerationJob) {
    job.updatedAt = new Date().toISOString();
    const target = path.join(
      this.root,
      "workspace/jobs",
      `${job.projectId}.json`,
    );
    const temporary = `${target}.tmp`;
    await writeFile(temporary, JSON.stringify(job, null, 2) + "\n");
    await rename(temporary, target);
  }
  async initialize() {
    this.root = await realpath(this.root);
    const directory = path.join(this.root, "workspace/jobs");
    await mkdir(directory, { recursive: true });
    await assertRealDirectory(directory);
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".json")) continue;
      const job = generationJobSchema.parse(
        JSON.parse(await readFile(path.join(directory, file), "utf8")),
      );
      if (file !== `${job.projectId}.json`)
        throw new Error("İş kaydı dosya adı geçersiz.");
      if (busy(job)) {
        job.status = "failed";
        job.error =
          "Worker yeniden başlatıldığı için iş yarıda kaldı. Otomatik yeniden deneme yapılmadı.";
        job.checks = job.checks.map((check) =>
          check.status === "running"
            ? {
                ...check,
                status: "failed",
                output: check.output + "\nWorker yeniden başlatıldı.",
              }
            : check,
        );
        await this.persist(job);
      }
      this.jobs.set(job.projectId, job);
    }
  }
  async generate(project: Project) {
    const existing = this.jobs.get(project.id);
    if (existing && !sameSpecification(existing.project, project)) {
      if (busy(existing))
        throw new Error(
          "Önce devam eden üretim veya kontrol işinin bitmesini bekleyin.",
        );
      if (
        getSpecification(project).revision <=
        getSpecification(existing.project).revision
      )
        throw new Error(
          "Üretim sürümü daha güncel. Projenizi yenileyip tekrar deneyin.",
        );
    }
    if (existing && sameSpecification(existing.project, project)) {
      if (busy(existing) || existing.files.length) return existing;
      throw new Error(
        "Bu proje için üretim başarısız oldu. Yeni bir proje oluşturarak yeniden deneyin; eski çıktı korunur.",
      );
    }
    if (project.stage !== "development")
      throw new Error("Üretim için tasarım onayı gerekli.");
    const now = new Date().toISOString();
    const job: GenerationJob = {
      id: randomUUID(),
      projectId: project.id,
      project,
      status: "queued",
      operation: "generate",
      outputPath: "",
      files: [],
      checks: [],
      validationAttempts: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(project.id, job);
    try {
      if (existing) {
        const archive = path.join(
          this.root,
          "workspace/jobs/history",
          project.id,
        );
        await mkdir(archive, { recursive: true });
        await assertRealDirectory(archive);
        await writeFile(
          path.join(archive, `${existing.id}.json`),
          JSON.stringify(existing, null, 2) + "\n",
        );
      }
      await this.persist(job);
    } catch (error) {
      if (existing) this.jobs.set(project.id, existing);
      else this.jobs.delete(project.id);
      throw error;
    }
    this.queue.push(job);
    void this.drain();
    return job;
  }
  async validate(projectId: string) {
    const job = this.jobs.get(projectId);
    if (!job || !job.files.length)
      throw new Error("Önce Expo projesini üretin.");
    if (busy(job)) return job;
    if (job.status === "ready") return job;
    job.validationAttempts++;
    job.operation = "validate";
    job.status = "queued";
    job.error = null;
    job.checks = (["install", "typecheck", "lint"] as const).map((name) => ({
      name,
      status: "pending",
      output: "",
      exitCode: null,
      durationMs: 0,
    }));
    await this.persist(job);
    this.queue.push(job);
    void this.drain();
    return job;
  }
  private async drain() {
    if (this.working) return;
    this.working = true;
    try {
      let job: GenerationJob | undefined;
      while ((job = this.queue.shift())) {
        try {
          if (job.operation === "generate") {
            job.status = "generating";
            await this.persist(job);
            const output = await generateProject(
              this.root,
              job.project,
              job.id,
            );
            Object.assign(job, output);
            job.status = "generated";
          } else {
            job.status = "validating";
            await this.persist(job);
            const cwd = await outputDirectory(this.root, job.projectId, job.id);
            await assertRealDirectory(cwd);
            for (const check of job.checks) {
              check.status = "running";
              await this.persist(job);
              const result = await this.check(check, cwd);
              Object.assign(check, result);
              check.status = result.exitCode === 0 ? "passed" : "failed";
              await this.persist(job);
              if (check.status === "failed")
                throw new Error(
                  `${check.name} kontrolü başarısız oldu. Ayrıntılar aşağıdaki işlem kaydında.`,
                );
            }
            job.status = "ready";
          }
          job.error = null;
          await this.persist(job);
        } catch (error) {
          job.status = "failed";
          job.error =
            error instanceof Error ? error.message : "İşlem başarısız oldu.";
          try {
            await this.persist(job);
          } catch (persistError) {
            console.error("İş sonucu diske yazılamadı:", persistError);
          }
        }
      }
    } finally {
      this.working = false;
    }
  }
  private check(check: JobCheck, cwd: string) {
    if (check.name === "install")
      return runCommand(
        process.platform === "win32" ? "npm.cmd" : "npm",
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--fetch-retries=0",
        ],
        cwd,
      );
    if (check.name === "typecheck")
      return runCommand(
        process.execPath,
        [path.join(cwd, "node_modules/typescript/bin/tsc"), "--noEmit"],
        cwd,
        120_000,
      );
    return runCommand(
      process.execPath,
      [
        path.join(cwd, "node_modules/eslint/bin/eslint.js"),
        ".",
        "--max-warnings",
        "0",
      ],
      cwd,
      120_000,
    );
  }
}
