import { screenFile } from "@app-factory/schemas";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  realpath,
  lstat,
  cp,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  builderJobSchema,
  featureOutputSchema,
  builderRetryApprovalSchema,
  projectSchema,
  projectIdSchema,
  getScreens,
  getSpecification,
  sameSpecification,
  revisionRequestSchema,
  appWideScreenId,
  type BuilderJob,
  type BuilderTask,
  type Project,
} from "@app-factory/schemas";
import {
  assertDesignAssets,
  assertRealDirectory,
  generateProject,
} from "@app-factory/generator";
import {
  runBuilder,
  runFeatureBuilder,
  runAppRevision,
  builderReservationUsd,
  builderTaskLimitUsd,
  PlannerError,
} from "@app-factory/ai";
import { runCommand } from "./runner";
import type { EasSource } from "./eas";
import {
  validateScreenCode,
  cleanScreenImports,
  validateRecordContract,
  validateRecordUsage,
  screenRequirements,
} from "./builder-code";
import {
  prepareApplication,
  ensureDemoSupport,
  featureContext,
  applicationModules,
  writeFeatureCandidate,
} from "./feature-build";
import {
  validateFeatures,
  validateApplicationCode,
  checkFeatureRules,
} from "./feature-code";
function lintWarning(log: string) {
  const count = /\(0 errors?, (\d+) warnings?\)/.exec(log)?.[1];
  return count
    ? [
        `ESLint ${count} uyarı verdi (hata değil); ayrıntılar Testler sayfasındaki kontrol günlüklerinde.`,
      ]
    : [];
}
export class BuilderManager {
  readonly jobs = new Map<string, BuilderJob>();
  onSettled?: (job: BuilderJob) => Promise<void>;
  async importRemote(
    load: () => Promise<BuilderJob>,
    progress: (value: number) => void = () => {},
  ) {
    if (this.locked) throw new Error("Builder işi sürüyor.");
    this.locked = true;
    try {
      const job = await load();
      progress(70);
      const cwd = path.resolve(this.root, job.outputPath);
      if (
        cwd !==
        path.join(
          this.root,
          "workspace/generated-projects",
          job.project.id,
          job.id,
        )
      )
        throw new Error("Çıktı yolu geçersiz.");
      const expectedStatus = job.status;
      job.status = "running";
      this.jobs.set(job.id, job);
      await this.persist(job);
      try {
        const install = await this.command(
          "npm",
          [
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--fetch-retries=0",
          ],
          cwd,
        );
        job.setupLog = install.output;
        if (install.exitCode !== 0)
          throw new Error("Çıktı indirildi; bağımlılıklar kurulamadı.");
        job.installed = true;
        progress(80);
        if (expectedStatus === "ready") {
          for (const [label, args] of [
            [
              "TypeScript",
              [path.join(cwd, "node_modules/typescript/bin/tsc"), "--noEmit"],
            ],
            [
              "ESLint",
              [path.join(cwd, "node_modules/eslint/bin/eslint.js"), "."],
            ],
          ] as const) {
            const check = await this.command(
              process.execPath,
              [...args],
              cwd,
              120000,
            );
            if (check.exitCode !== 0)
              throw new Error(
                label + " kontrolü başarısız. İndirilen çıktı yerelde korundu.",
              );
            progress(label === "TypeScript" ? 90 : 95);
          }
        }
        job.status = expectedStatus;
      } catch (error) {
        job.status = "failed";
        job.error =
          error instanceof Error ? error.message : "Kurulum başarısız.";
        if (job.tasks.every((t) => t.status === "ready"))
          job.tasks[job.tasks.length - 1]!.status = "failed";
      }
      await this.persist(job);
      return job;
    } finally {
      this.locked = false;
    }
  }
  private locked = false;
  get busy() {
    return this.locked;
  }
  get enabled() {
    return !!this.key.trim();
  }
  constructor(
    private root: string,
    private otherSpend: (id: string) => number = () => 0,
    private key = process.env.OPENAI_API_KEY ?? "",
    private run = runBuilder,
    private command = runCommand,
    private generate = generateProject,
    private runFeatures = runFeatureBuilder,
    private runApp = runAppRevision,
  ) {}
  list(id: string) {
    return [...this.jobs.values()]
      .filter((j) => j.project.id === id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  spent(id: string) {
    return this.list(id).reduce(
      (n, j) =>
        n +
        j.tasks.reduce(
          (s, t) => s + t.costUsd + t.uncertainCostUsd + t.reservedUsd,
          0,
        ),
      0,
    );
  }
  totalCost(id: string) {
    return (
      this.otherSpend(id) +
      this.spent(id) -
      this.list(id).reduce(
        (n, j) => n + j.tasks.reduce((s, t) => s + t.reservedUsd, 0),
        0,
      )
    );
  }
  private async persist(job: BuilderJob) {
    const file = path.join(this.root, "workspace/builder", job.id + ".json");
    await writeFile(file + ".tmp", JSON.stringify(job, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(file + ".tmp", file);
  }
  async initialize() {
    this.root = await realpath(this.root);
    const dir = path.join(this.root, "workspace/builder");
    await mkdir(dir, { recursive: true });
    await assertRealDirectory(dir);
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".json")) continue;
      const job = builderJobSchema.parse(
        JSON.parse(await readFile(path.join(dir, file), "utf8")),
      );
      if (file !== job.id + ".json")
        throw new Error("Builder iş kaydı geçersiz.");
      if (job.status === "running") {
        job.status = "failed";
        job.error = "Worker yeniden başladı. Görev elle devam ettirilebilir.";
        for (const task of job.tasks)
          if (task.status === "running") {
            task.status = "failed";
            task.uncertainCostUsd += task.reservedUsd;
            task.reservedUsd = 0;
          }
        await this.persist(job);
      }
      this.jobs.set(job.id, job);
    }
  }
  async start(
    input: Project,
    retry = false,
    mode: "application" | "screens" = "application",
    approval?: unknown,
  ) {
    const project = projectSchema
      .safeExtend({ id: projectIdSchema })
      .parse(input);
    if (!this.enabled) throw new Error("Builder için OPENAI_API_KEY gerekli.");
    if (
      !["development", "tests", "build"].includes(project.stage) ||
      !project.designReview ||
      project.designReview.revision !== getSpecification(project).revision
    )
      throw new Error("Önce tüm tasarım görsellerini onaylayın.");
    const existing = this.list(project.id).find(
      (j) =>
        !j.change &&
        (j.mode ?? "screens") === mode &&
        getSpecification(j.project).revision ===
          getSpecification(project).revision,
    );
    if (existing && !sameSpecification(existing.project, project))
      throw new Error("Proje sürümü değişti. Sayfayı yenileyin.");
    if (existing && (existing.status !== "failed" || !retry)) return existing;
    if (this.locked)
      throw new Error("Bir Builder işi sürüyor. Tamamlanmasını bekleyin.");
    const failedTask = existing?.tasks.find((t) => t.status !== "ready");
    const manual =
      existing && retry && mode === "application"
        ? builderRetryApprovalSchema.parse(approval)
        : undefined;
    if (
      manual &&
      (manual.jobId !== existing?.id ||
        manual.expectedAttempts !== failedTask?.attempts)
    )
      throw new Error("Görev değişti. Güncel görev için yeniden onay verin.");
    if (
      Math.max(project.aiCost, this.totalCost(project.id)) +
        builderReservationUsd >
      project.budgetLimit
    )
      throw new Error("Builder için proje bütçesi yetersiz.");
    await assertDesignAssets(this.root, project);
    if (manual && failedTask) failedTask.model = manual.model;
    const job: BuilderJob = existing ?? {
      mode,
      id: randomUUID(),
      project,
      status: "running",
      outputPath: "",
      setupAttempts: 0,
      installed: false,
      error: null,
      setupLog: "",
      createdAt: new Date().toISOString(),
      tasks: [
        ...(mode === "application"
          ? [
              {
                kind: "features" as const,
                screenId: "home",
                name: "Veri modeli ve uygulama işlevleri",
                status: "pending" as const,
                attempts: 0,
                costUsd: 0,
                reservedUsd: 0,
                uncertainCostUsd: 0,
                summary: "",
                limitations: [],
                log: "",
              },
            ]
          : []),
        ...getScreens(getSpecification(project))
          .filter((s) => s.enabled)
          .map((s) => ({
            screenId: s.id,
            name: s.name,
            status: "pending" as const,
            attempts: 0,
            costUsd: 0,
            reservedUsd: 0,
            uncertainCostUsd: 0,
            summary: "",
            limitations: [],
            log: "",
          })),
      ],
    };
    this.locked = true;
    job.status = "running";
    job.error = null;
    try {
      await this.persist(job);
      this.jobs.set(job.id, job);
    } catch (error) {
      this.locked = false;
      throw error;
    }
    void this.execute(job);
    return job;
  }
  async revise(
    raw: unknown,
    resolveSource: (project: Project, id: string) => EasSource,
  ) {
    const req = revisionRequestSchema.parse(raw);
    const prior = this.jobs.get(req.requestId);
    if (
      prior &&
      (prior.project.id !== req.project.id ||
        JSON.stringify(prior.change) !== JSON.stringify(req.change) ||
        !sameSpecification(prior.project, req.project))
    )
      throw new Error("Revizyon istek kimliği başka işe ait.");
    if (prior && (!req.retry || prior.status !== "failed")) return prior;
    if (req.retry && !prior)
      throw new Error("Yeniden denenecek revizyon bulunamadı.");
    if (!this.enabled) throw new Error("Builder için OPENAI_API_KEY gerekli.");
    if (this.locked)
      throw new Error("Bir Builder işi sürüyor. Tamamlanmasını bekleyin.");
    const source = resolveSource(req.project, req.change.sourceJobId);
    if (req.requestId === source.id)
      throw new Error("Revizyon yeni bir çıktı kimliği kullanmalı.");
    const appWide = req.change.screenId === appWideScreenId;
    const screen = appWide
      ? { id: "home" as const, name: "Uygulama geneli" }
      : getScreens(getSpecification(source.project)).find(
          (s) => s.id === req.change.screenId && s.enabled,
        );
    if (!screen) throw new Error("Seçili ekran projede açık değil.");
    if (
      appWide &&
      !(await lstat(
        path.join(this.root, source.outputPath, "src/features/store.tsx"),
      )
        .then((info) => info.isFile())
        .catch(() => false))
    )
      throw new Error(
        "Uygulama geneli değişiklik, ortak uygulama işlevleri üretilmiş çıktılarda kullanılabilir.",
      );
    if (
      Math.max(req.project.aiCost, this.totalCost(req.project.id)) +
        builderReservationUsd >
      req.project.budgetLimit
    )
      throw new Error("Revizyon için proje bütçesi yetersiz.");
    const job: BuilderJob = prior ?? {
      id: req.requestId,
      project: req.project,
      change: req.change,
      status: "running",
      outputPath: "",
      setupAttempts: 0,
      installed: false,
      error: null,
      setupLog: "",
      createdAt: new Date().toISOString(),
      tasks: [
        {
          ...(appWide ? { kind: "app" as const } : {}),
          ...(req.model ? { model: req.model } : {}),
          screenId: screen.id,
          name: screen.name,
          status: "pending" as const,
          attempts: 0,
          costUsd: 0,
          reservedUsd: 0,
          uncertainCostUsd: 0,
          summary: "",
          limitations: [],
          log: "",
        },
      ],
    };
    if (prior && req.model)
      for (const task of prior.tasks)
        if (task.status !== "ready") task.model = req.model;
    this.locked = true;
    job.status = "running";
    job.error = null;
    try {
      if (!prior) {
        const destination = path.join(
          this.root,
          "workspace/generated-projects",
          job.project.id,
          job.id,
        );
        try {
          await lstat(destination);
          throw new Error("Revizyon çıktı klasörü zaten var.");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      await this.persist(job);
      this.jobs.set(job.id, job);
    } catch (e) {
      this.locked = false;
      throw e;
    }
    void this.execute(job);
    return job;
  }
  private async cloneRevision(job: BuilderJob) {
    const source = path.join(
      this.root,
      "workspace/generated-projects",
      job.project.id,
      job.change!.sourceJobId,
    );
    const destination = path.join(
      this.root,
      "workspace/generated-projects",
      job.project.id,
      job.id,
    );
    await assertRealDirectory(source);
    await mkdir(destination, { recursive: true });
    await assertRealDirectory(destination);
    await cp(source, destination, {
      recursive: true,
      filter: async (file) => {
        const name = path.basename(file);
        if (
          [
            "node_modules",
            ".expo",
            ".git",
            ".npmrc",
            "credentials.json",
          ].includes(name) ||
          name.startsWith(".env") ||
          /\.(pem|key|p12|jks|keystore)$/.test(name)
        )
          return false;
        if ((await lstat(file)).isSymbolicLink())
          throw new Error("Revizyon kaynağı sembolik bağlantı içeriyor.");
        return true;
      },
    });
    await assertRealDirectory(destination);
    await writeFile(
      path.join(destination, "eslint.config.js"),
      await readFile(
        path.join(this.root, "templates/expo-base/eslint.config.js"),
      ),
    );
    return { outputPath: path.relative(this.root, destination) };
  }
  private async checkedFile(directory: string, file: string) {
    const target = path.join(directory, file);
    const info = await lstat(target);
    if (!info.isFile() || (await realpath(target)) !== target)
      throw new Error("Builder dosya yolu geçersiz.");
    return target;
  }
  private async executeFeatures(
    job: BuilderJob,
    task: BuilderTask,
    cwd: string,
  ) {
    await ensureDemoSupport(this.root, cwd);
    let previousCandidate;
    if (task.attempts > 0) {
      try {
        const file = await this.checkedFile(
          path.join(this.root, "workspace/builder"),
          job.id + "-features-" + task.attempts + ".txt",
        );
        if ((await lstat(file)).size <= 200000) {
          const parsed = featureOutputSchema.safeParse(
            JSON.parse(await readFile(file, "utf8")),
          );
          if (parsed.success) previousCandidate = parsed.data;
        }
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          !(error instanceof SyntaxError)
        )
          throw error;
      }
    }
    const context = await featureContext(
      cwd,
      job.project,
      task.log,
      previousCandidate,
    );
    if (Buffer.byteLength(context) > 80000)
      throw new Error("Uygulama bağlamı görev sınırını aşıyor.");
    task.status = "running";
    task.attempts++;
    task.reservedUsd = builderReservationUsd;
    await this.persist(job);
    let accounted = false;
    let rollback: (() => Promise<void>) | undefined;
    try {
      const result = await this.runFeatures(
        { context, model: task.model },
        this.key,
      );
      task.costUsd += result.costUsd;
      task.reservedUsd = 0;
      accounted = true;
      await this.persist(job);
      await writeFile(
        path.join(
          this.root,
          "workspace/builder",
          `${job.id}-features-${task.attempts}.txt`,
        ),
        JSON.stringify(result.output, null, 2),
        { flag: "wx", mode: 0o600 },
      );
      const output = validateFeatures(result.output);
      const checks = await checkFeatureRules(output);
      rollback = await writeFeatureCandidate(cwd, output);
      task.log =
        checks.map((c) => `İş kuralı: ${c.name} · Başarılı`).join("\n") + "\n";
      for (const [name, args] of [
        [
          "TypeScript",
          [path.join(cwd, "node_modules/typescript/bin/tsc"), "--noEmit"],
        ],
        ["ESLint", [path.join(cwd, "node_modules/eslint/bin/eslint.js"), "."]],
      ] as const) {
        const check = await this.command(
          process.execPath,
          [...args],
          cwd,
          120000,
        );
        task.log = (
          task.log +
          `${name}: ${check.exitCode === 0 ? "Başarılı" : "Başarısız"}\n${check.output}\n`
        ).slice(-20000);
        if (check.exitCode !== 0)
          throw new Error(
            `Uygulama işlevleri ${name} kontrolünü geçemedi. Dosyalar geri alındı.`,
          );
      }
      task.summary = output.summary;
      task.limitations = [...output.limitations, ...lintWarning(task.log)];
      job.implementation = {
        summary: output.summary,
        files: output.files.map((file) => file.path),
        checks,
        setup: [
          ...output.setup,
          ...(output.capabilities.includes("maps")
            ? [
                "Android dağıtımı için Google Maps anahtarını uygulama kimliğiyle sınırlandırıp yapılandırın; web önizlemesi konum listesi gösterir.",
              ]
            : []),
        ],
        coverage: output.coverage,
      };
      task.status = "ready";
      await this.persist(job);
    } catch (error) {
      if (rollback) await rollback();
      if (!accounted) {
        if (error instanceof PlannerError && error.costUsd !== null)
          task.costUsd += error.costUsd;
        else task.uncertainCostUsd += task.reservedUsd;
      }
      task.reservedUsd = 0;
      task.status = "failed";
      job.implementation = undefined;
      task.log = (
        task.log +
        "\n" +
        (error instanceof Error
          ? error.message
          : "Uygulama işlevleri üretilemedi.")
      ).slice(-20000);
      throw error;
    }
  }
  private async executeAppRevision(
    job: BuilderJob,
    task: BuilderTask,
    cwd: string,
  ) {
    const spec = getSpecification(job.project);
    const enabledScreens = getScreens(spec).filter((s) => s.enabled);
    const modules = await applicationModules(cwd);
    let migrationSql = "";
    try {
      migrationSql = await readFile(
        await this.checkedFile(cwd, "backend/migration.sql"),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const context = JSON.stringify({
      task: "REVISE_APPLICATION",
      changeRequest: job.change!.instruction,
      projectMemory: {
        name: job.project.name,
        idea: job.project.idea,
        summary: spec.plan.summary,
        scope: spec.plan.scope,
      },
      enabledScreens: enabledScreens.map((s) => ({
        screenId: s.id,
        name: s.name,
        description: s.description,
        file: screenFile(s.id),
      })),
      modules,
      migrationSql,
      compilerOptions: { strict: true, noUncheckedIndexedAccess: true },
      previousDiagnostics: task.log.slice(-8000),
    });
    if (Buffer.byteLength(context) > 80000)
      throw new Error("Uygulama bağlamı görev sınırını aşıyor.");
    task.status = "running";
    task.attempts++;
    task.reservedUsd = builderReservationUsd;
    await this.persist(job);
    let accounted = false;
    let rollback: (() => Promise<void>) | undefined;
    try {
      const result = await this.runApp(
        { context, model: task.model },
        this.key,
      );
      task.costUsd += result.costUsd;
      task.reservedUsd = 0;
      accounted = true;
      await this.persist(job);
      await writeFile(
        path.join(
          this.root,
          "workspace/builder",
          `${job.id}-app-${task.attempts}.txt`,
        ),
        JSON.stringify(result.output, null, 2),
        { flag: "wx", mode: 0o600 },
      );
      const output = result.output;
      if (new Set(output.files.map((f) => f.path)).size !== output.files.length)
        throw new Error("Uygulama değişikliğinde yinelenen dosya var.");
      const screenIds = new Set(enabledScreens.map((s) => s.id as string));
      const screens = output.screens.filter((s) => screenIds.has(s.screenId));
      if (new Set(screens.map((s) => s.screenId)).size !== screens.length)
        throw new Error("Uygulama değişikliğinde yinelenen ekran var.");
      if (
        !output.files.length &&
        output.migrationSql === null &&
        !screens.length
      )
        throw new Error("Uygulama değişikliği hiçbir dosyayı etkilemiyor.");
      for (const file of output.files)
        validateApplicationCode(file.code, file.path);
      if (
        output.migrationSql !== null &&
        (!/enable\s+row\s+level\s+security/i.test(output.migrationSql) ||
          /\bfactory_[a-z_]+/i.test(output.migrationSql))
      )
        throw new Error(
          "Migration RLS içermeli ve App Factory verilerine dokunmamalı.",
        );
      const writes = [
        ...output.files,
        ...(output.migrationSql !== null
          ? [{ path: "backend/migration.sql", code: output.migrationSql }]
          : []),
      ];
      const originals = new Map<string, string | null>();
      rollback = async () => {
        for (const [target, original] of originals) {
          if (original === null) await rm(target, { force: true });
          else await writeFile(target, original);
        }
      };
      for (const file of writes) {
        const target = path.join(cwd, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await assertRealDirectory(path.dirname(target));
        try {
          originals.set(
            target,
            await readFile(await this.checkedFile(cwd, file.path), "utf8"),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          originals.set(target, null);
        }
        await writeFile(target, file.code + "\n");
      }
      task.log = "";
      for (const [name, args] of [
        [
          "TypeScript",
          [path.join(cwd, "node_modules/typescript/bin/tsc"), "--noEmit"],
        ],
        ["ESLint", [path.join(cwd, "node_modules/eslint/bin/eslint.js"), "."]],
      ] as const) {
        const check = await this.command(
          process.execPath,
          [...args],
          cwd,
          120000,
        );
        task.log = (
          task.log +
          `${name}: ${check.exitCode === 0 ? "Başarılı" : "Başarısız"}\n${check.output}\n`
        ).slice(-20000);
        if (check.exitCode !== 0)
          throw new Error(
            `Uygulama geneli değişiklik ${name} kontrolünü geçemedi. Dosyalar geri alındı.`,
          );
      }
      task.summary = output.summary;
      task.limitations = [...output.limitations, ...lintWarning(task.log)];
      task.status = "ready";
      const shared = output.files.map((f) => f.path).join(", ");
      for (const item of screens) {
        const screen = enabledScreens.find((s) => s.id === item.screenId)!;
        job.tasks.push({
          ...(task.model ? { model: task.model } : {}),
          screenId: screen.id,
          name: screen.name,
          instruction: (
            `Uygulama geneli istek: ${job.change!.instruction}\n` +
            (shared ? `Güncellenen ortak modüller: ${shared}\n` : "") +
            `Bu ekran için: ${item.instruction}`
          ).slice(0, 4000),
          status: "pending",
          attempts: 0,
          costUsd: 0,
          reservedUsd: 0,
          uncertainCostUsd: 0,
          summary: "",
          limitations: [],
          log: "",
        });
      }
      await this.persist(job);
    } catch (error) {
      if (rollback) await rollback();
      if (!accounted) {
        if (error instanceof PlannerError && error.costUsd !== null)
          task.costUsd += error.costUsd;
        else task.uncertainCostUsd += task.reservedUsd;
      }
      task.reservedUsd = 0;
      task.status = "failed";
      task.log = (
        task.log +
        "\n" +
        (error instanceof Error
          ? error.message
          : "Uygulama geneli değişiklik uygulanamadı.")
      ).slice(-20000);
      throw error;
    }
  }
  private async execute(job: BuilderJob, nested = false): Promise<void> {
    const initialAttempts = job.tasks.map((task) => task.attempts);
    try {
      if (!job.outputPath) {
        job.setupAttempts++;
        await this.persist(job);
        const result = job.change
          ? await this.cloneRevision(job)
          : await this.generate(this.root, job.project, job.id);
        job.outputPath = result.outputPath;
        await this.persist(job);
      } else if (!job.installed) {
        job.setupAttempts++;
        await this.persist(job);
      }
      const cwd = path.join(
        this.root,
        "workspace/generated-projects",
        job.project.id,
        job.id,
      );
      if (path.resolve(this.root, job.outputPath) !== cwd)
        throw new Error("Builder çıktı yolu geçersiz.");
      await assertRealDirectory(cwd);
      if (
        job.mode === "application" &&
        !job.change &&
        !job.applicationPrepared
      ) {
        await prepareApplication(this.root, cwd);
        job.applicationPrepared = true;
        await this.persist(job);
      }
      if (!job.installed) {
        const result = await this.command(
          "npm",
          [
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--fetch-retries=0",
          ],
          cwd,
        );
        job.setupLog = result.output;
        job.installed = result.exitCode === 0;
        await this.persist(job);
        if (!job.installed) throw new Error("Expo bağımlılıkları kurulamadı.");
      }
      for (const task of job.tasks) {
        if (task.status === "ready") continue;
        if (
          Math.max(job.project.aiCost, this.totalCost(job.project.id)) +
            builderReservationUsd >
          job.project.budgetLimit
        )
          throw new Error("Proje bütçesi sonraki ekran için yetersiz.");
        if (task.kind === "features") {
          await this.executeFeatures(job, task, cwd);
          continue;
        }
        if (task.kind === "app") {
          await this.executeAppRevision(job, task, cwd);
          continue;
        }
        const file = screenFile(task.screenId);
        const target = await this.checkedFile(cwd, file);
        const modules: Record<string, string> = {};
        for (const name of [
          "records.tsx",
          "screens.ts",
          "record-form.tsx",
          "ui.tsx",
          "theme.json",
          "project.json",
        ]) {
          modules["src/" + name] = await readFile(
            await this.checkedFile(cwd, "src/" + name),
            "utf8",
          );
        }
        const originalCode = await readFile(target, "utf8");
        const applicationMode =
          job.mode === "application" ||
          (job.change &&
            (await lstat(path.join(cwd, "src/features/store.tsx"))
              .then(() => true)
              .catch(() => false)));
        if (applicationMode)
          Object.assign(modules, await applicationModules(cwd));
        const spec = getSpecification(job.project);
        const rejectedCode =
          task.status === "failed" && task.attempts > 0
            ? await readFile(
                path.join(
                  this.root,
                  "workspace/builder",
                  `${job.id}-${task.screenId}-${task.attempts}.txt`,
                ),
                "utf8",
              ).catch(() => undefined)
            : undefined;
        const contextData = {
          task: job.change ? "REVISE_SCREEN" : "BUILD_SCREEN",
          applicationMode: !!applicationMode,
          changeRequest: task.instruction ?? job.change?.instruction,
          file,
          projectMemory: {
            name: job.project.name,
            summary: spec.plan.summary,
            idea: job.project.idea,
            scope: spec.plan.scope,
            tasks: job.project.plannerDraft?.tasks,
            design: spec.design,
          },
          screen: getScreens(spec).find((s) => s.id === task.screenId),
          enabledScreens: getScreens(spec).filter((s) => s.enabled),
          notes: job.project.plannerDraft?.screenNotes.find(
            (s) => s.screenId === task.screenId,
          ),
          modules,
          currentCode: originalCode,
          requirements: applicationMode
            ? {
                useApp: true,
                enabledRoutes: getScreens(spec)
                  .filter((s) => s.enabled)
                  .map((s) => screenFile(s.id)),
              }
            : screenRequirements(file),
          previousDiagnostics: task.log.slice(-8000),
        };
        let context = JSON.stringify(
          rejectedCode ? { ...contextData, rejectedCode } : contextData,
        );
        if (Buffer.byteLength(context) > 80000)
          context = JSON.stringify(contextData);
        let image: Buffer | undefined;
        try {
          image = await readFile(
            await this.checkedFile(
              cwd,
              `design-references/${task.screenId}.png`,
            ),
          );
        } catch (error) {
          if (
            (!job.change && !applicationMode) ||
            (error as NodeJS.ErrnoException).code !== "ENOENT"
          )
            throw error;
        }
        if (Buffer.byteLength(context) > 80000)
          throw new Error("Ekran bağlamı görev sınırını aşıyor.");
        task.status = "running";
        task.log = "";
        task.attempts++;
        task.reservedUsd = builderReservationUsd;
        await this.persist(job);
        let accounted = false;
        let candidateWritten = false;
        try {
          const result = await this.run(
            { context, image, model: task.model },
            this.key,
          );
          task.costUsd += result.costUsd;
          task.reservedUsd = 0;
          accounted = true;
          task.summary = result.output.summary;
          task.limitations = result.output.limitations;
          await this.persist(job);
          // Preserve every candidate outside the Expo tree, including rejected checks.
          await writeFile(
            path.join(
              this.root,
              "workspace/builder",
              `${job.id}-${task.screenId}-${task.attempts}.txt`,
            ),
            result.output.code,
            { flag: "wx", mode: 0o600 },
          );
          if (applicationMode)
            validateApplicationCode(result.output.code, file, true);
          else validateScreenCode(result.output.code, file);
          const code = cleanScreenImports(result.output.code, file);
          if (applicationMode) validateApplicationCode(code, file, true);
          else {
            validateRecordContract(code, file);
            validateRecordUsage(code, file);
          }
          candidateWritten = true;
          await writeFile(target, code + "\n");
          task.log = "";
          for (const [label, args] of [
            [
              "TypeScript",
              [path.join(cwd, "node_modules/typescript/bin/tsc"), "--noEmit"],
            ],
            [
              "ESLint",
              [path.join(cwd, "node_modules/eslint/bin/eslint.js"), "."],
            ],
          ] as const) {
            const check = await this.command(
              process.execPath,
              [...args],
              cwd,
              120000,
            );
            task.log = (
              task.log +
              `${label}: ${check.exitCode === 0 ? "Başarılı" : "Başarısız"}\n${check.output}\n`
            ).slice(-20000);
            await this.persist(job);
            if (check.exitCode !== 0)
              throw new Error(`${task.name}: ${label} kontrolü başarısız.`);
          }
          task.limitations = [...task.limitations, ...lintWarning(task.log)];
          task.status = "ready";
          await this.persist(job);
        } catch (error) {
          if (candidateWritten) await writeFile(target, originalCode);
          if (!accounted) {
            if (error instanceof PlannerError && error.costUsd !== null)
              task.costUsd += error.costUsd;
            else task.uncertainCostUsd += task.reservedUsd;
          }
          task.reservedUsd = 0;
          task.status = "failed";
          if (!task.log)
            task.log =
              error instanceof Error ? error.message : "Görev başarısız.";
          throw error;
        }
      }
      await writeFile(
        path.join(cwd, "builder-report.json"),
        JSON.stringify(
          {
            tasks: job.tasks,
            implementation: job.implementation,
            totalCostUsd: this.totalCost(job.project.id),
            note: "Kod kontrolleri tamamlandı. Cihaz testi ve görsel uyum incelemesi ayrıca gerekli.",
          },
          null,
          2,
        ),
      );
      job.status = "ready";
      job.error = null;
    } catch (error) {
      job.status = "failed";
      job.error =
        error instanceof Error ? error.message : "Builder tamamlanamadı.";
      const index = job.tasks.findIndex((task) => task.status === "failed");
      const failed = job.tasks[index];
      if (
        job.mode === "application" &&
        !job.change &&
        failed &&
        !failed.model &&
        failed.attempts > (initialAttempts[index] ?? 0) &&
        failed.attempts < 3 &&
        failed.costUsd + failed.uncertainCostUsd + builderReservationUsd <=
          builderTaskLimitUsd + 0.000001 &&
        Math.max(job.project.aiCost, this.totalCost(job.project.id)) +
          builderReservationUsd <=
          job.project.budgetLimit
      ) {
        job.status = "running";
        job.error = `Otomatik yeniden deneme ${failed.attempts}/2: ${job.error}`;
        await this.persist(job);
        return await this.execute(job, true);
      }
    } finally {
      try {
        await this.persist(job);
      } catch {
        job.status = "failed";
        job.error = "Builder iş kaydı yazılamadı.";
      }
      if (!nested) {
        try {
          if (job.outputPath) await this.onSettled?.(job);
        } catch {
          /* Sync status is reported separately. */
        }
        this.locked = false;
      }
    }
  }
}
