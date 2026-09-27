import { sourceFingerprint } from "./preview";
import { runCommand } from "./runner";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  realpath,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  easJobSchema,
  easRequestSchema,
  getSpecification,
  type EasJob,
  type Project,
} from "@app-factory/schemas";
import { assertRealDirectory } from "@app-factory/generator";
import { parseEasJson, runEas } from "./eas-cli";
export type EasSource = { id: string; project: Project; outputPath: string };
const linkSchema = z.object({
  projectId: z.string(),
  easProjectId: z.uuid(),
  owner: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  slug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  applicationId: z.string(),
});
const remoteSchema = z.object({
  id: z.uuid(),
  status: z.enum([
    "NEW",
    "IN_QUEUE",
    "IN_PROGRESS",
    "PENDING_CANCEL",
    "FINISHED",
    "ERRORED",
    "CANCELED",
  ]),
  platform: z.literal("ANDROID"),
  buildProfile: z.literal("preview"),
  message: z.string().optional(),
  app: z.object({ id: z.uuid() }),
  artifacts: z
    .object({
      applicationArchiveUrl: z.string().optional(),
      buildUrl: z.string().optional(),
    })
    .optional(),
});
const active = (job: EasJob) =>
  ["preparing", "submitting", "unknown", "queued", "building"].includes(
    job.status,
  );
export function safeApkUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      u.hostname === "expo.dev" &&
      u.pathname.startsWith("/artifacts/eas/") &&
      u.pathname.endsWith(".apk") &&
      !u.username &&
      !u.password &&
      !u.search
      ? u.toString()
      : null;
  } catch {
    return null;
  }
}
async function verifyOutput(cwd: string) {
  for (const [label, args] of [
    [
      "TypeScript",
      [path.join(cwd, "node_modules/typescript/bin/tsc"), "--noEmit"],
    ],
    ["ESLint", [path.join(cwd, "node_modules/eslint/bin/eslint.js"), "."]],
  ] as const) {
    const result = await runCommand(process.execPath, [...args], cwd, 120000);
    if (result.exitCode !== 0)
      throw new Error(
        label +
          " kontrolü başarısız; Expo’ya gönderilmedi.\n" +
          result.output.slice(-3000),
      );
  }
}
export class EasManager {
  readonly jobs = new Map<string, EasJob>();
  private locked = false;
  get busy() {
    return this.locked;
  }
  private writes = new Map<string, Promise<void>>();
  private refreshing = new Set<string>();
  private lastRefresh = new Map<string, number>();
  get enabled() {
    return !!this.token.trim();
  }
  constructor(
    private root: string,
    private resolveSource: (project: Project, id: string) => EasSource,
    private token = process.env.EXPO_TOKEN ?? "",
    private command = runEas,
    private verify = verifyOutput,
    private approve: (
      project: Project,
      id: string,
    ) => Promise<void> = async () => {},
  ) {}
  list(id: string) {
    return [...this.jobs.values()]
      .filter((j) => j.projectId === id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  private persist(job: EasJob) {
    job.updatedAt = new Date().toISOString();
    const p = path.join(this.root, "workspace/eas/jobs", job.id + ".json");
    const data = JSON.stringify(job, null, 2) + "\n";
    const previous = this.writes.get(job.id) ?? Promise.resolve();
    const write = previous
      .catch(() => {})
      .then(async () => {
        await writeFile(p + ".tmp", data, { mode: 0o600 });
        await rename(p + ".tmp", p);
      });
    this.writes.set(job.id, write);
    return write;
  }
  async initialize() {
    this.root = await realpath(this.root);
    for (const dir of [
      "workspace/eas",
      "workspace/eas/jobs",
      "workspace/eas/links",
    ]) {
      await mkdir(path.join(this.root, dir), { recursive: true });
      await assertRealDirectory(path.join(this.root, dir));
    }
    for (const file of await readdir(
      path.join(this.root, "workspace/eas/jobs"),
    )) {
      if (!file.endsWith(".json")) continue;
      const job = easJobSchema.parse(
        JSON.parse(
          await readFile(
            path.join(this.root, "workspace/eas/jobs", file),
            "utf8",
          ),
        ),
      );
      if (file !== job.id + ".json")
        throw new Error("EAS iş dosyası geçersiz.");
      if (job.status === "submitting") {
        job.status = "unknown";
        job.error =
          "Worker gönderim sırasında yeniden başladı. Yeni derleme başlatmadan Expo iş kimliğiyle eşleştirin.";
        await this.persist(job);
      }
      if (job.status === "preparing") {
        job.status = "failed";
        job.error = "Hazırlık yarıda kaldı. Bulut derlemesi başlatılmadı.";
        await this.persist(job);
      }
      this.jobs.set(job.id, job);
    }
  }
  private async cwd(job: EasJob) {
    const cwd = path.join(
      this.root,
      "workspace/generated-projects",
      job.projectId,
      job.sourceJobId,
    );
    if (path.resolve(this.root, job.outputPath) !== cwd)
      throw new Error("EAS çıktı yolu geçersiz.");
    await assertRealDirectory(cwd);
    return cwd;
  }
  private async jsonFile(cwd: string, file: string) {
    const p = path.join(cwd, file);
    if (!(await lstat(p)).isFile() || (await realpath(p)) !== p)
      throw new Error("EAS yapılandırma yolu geçersiz.");
    return JSON.parse(await readFile(p, "utf8"));
  }
  async complete(project: Project, sourceId: string, jobId: string) {
    const job = this.jobs.get(jobId);
    if (
      !job ||
      job.projectId !== project.id ||
      job.sourceJobId !== sourceId ||
      job.status !== "finished" ||
      !job.apkUrl
    )
      throw new Error(
        "Önce bu çıktının APK derlemesi başarıyla tamamlanmalıdır.",
      );
    this.resolveSource(project, sourceId);
    if (
      !job.sourceFingerprint ||
      job.sourceFingerprint !== (await sourceFingerprint(await this.cwd(job)))
    )
      throw new Error(
        "APK kaynak sürümü değişmiş veya doğrulanamıyor; bu çıktı tamamlandı işaretlenemez.",
      );
    job.deviceTest = "passed";
    job.completedAt = new Date().toISOString();
    await this.persist(job);
    return job;
  }
  async start(input: unknown) {
    const req = easRequestSchema.parse(input);
    if (req.action !== "start") throw new Error("Geçersiz EAS işlemi.");
    if (!this.enabled)
      throw new Error("Worker .env dosyasında EXPO_TOKEN gerekli.");
    const duplicate = this.jobs.get(req.requestId);
    if (duplicate) {
      if (
        duplicate.projectId !== req.project.id ||
        duplicate.sourceJobId !== req.sourceJobId
      )
        throw new Error("İstek kimliği başka işe ait.");
      return duplicate;
    }
    const source = this.resolveSource(req.project, req.sourceJobId);
    if (!source.project.android)
      throw new Error("Bu projede Android seçili değil.");
    const previous = this.list(req.project.id);
    if ((previous.at(-1)?.id ?? null) !== req.expectedLatestId)
      throw new Error("Derleme listesi değişti. Güncel sonucu bekleyin.");
    if (this.locked || previous.some(active))
      throw new Error(
        "Devam eden veya sonucu belirsiz bir derleme var. Önce durumunu kontrol edin.",
      );
    const attempts = previous.filter((j) => j.sourceJobId === source.id);
    if (attempts.some((j) => j.status === "finished"))
      throw new Error("Bu çıktının APK'sı zaten hazır.");
    const now = new Date().toISOString();
    const job: EasJob = {
      id: req.requestId,
      projectId: source.project.id,
      sourceJobId: source.id,
      revision: getSpecification(source.project).revision,
      outputPath: source.outputPath,
      status: "preparing",
      easProjectId: null,
      buildId: null,
      owner: null,
      slug: null,
      apkUrl: null,
      error: null,
      log: "",
      createdAt: now,
      updatedAt: now,
      deviceTest: "not_tested",
    };
    this.locked = true;
    try {
      await this.approve(source.project, source.id);
      await this.cwd(job);
      await this.persist(job);
      this.jobs.set(job.id, job);
    } catch (e) {
      this.locked = false;
      throw e;
    }
    void this.execute(job, source.project);
    return job;
  }
  private async prepare(job: EasJob, cwd: string) {
    const config = await this.jsonFile(cwd, "app.json");
    if (!config.expo) throw new Error("Expo yapılandırması eksik.");
    const linkFile = path.join(
      this.root,
      "workspace/eas/links",
      job.projectId + ".json",
    );
    let link: z.infer<typeof linkSchema> | undefined;
    try {
      link = linkSchema.parse(JSON.parse(await readFile(linkFile, "utf8")));
      if (link.projectId !== job.projectId)
        throw new Error("Expo proje eşlemesi geçersiz.");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const account = await this.command(["whoami"], cwd, this.token);
    if (account.code !== 0)
      throw new Error(
        "Expo hesabı doğrulanamadı. EXPO_TOKEN ve EAS CLI ayarını kontrol edin.",
      );
    const owner = account.stdout.trim().match(/^([a-zA-Z0-9_-]+)(?:\s|$)/)?.[1];
    if (!owner) throw new Error("Expo hesap adı okunamadı.");
    const slug = link?.slug ?? `app-factory-${job.projectId.toLowerCase()}`;
    // Preserve an already linked output; never silently point it at another app.
    const existing = config.expo.extra?.eas?.projectId;
    if (link && existing && existing !== link.easProjectId)
      throw new Error("Çıktı başka bir Expo projesine bağlı.");
    config.expo.owner = link?.owner ?? config.expo.owner ?? owner;
    config.expo.slug = link?.slug ?? config.expo.slug ?? slug;
    config.expo.android = {
      ...config.expo.android,
      package:
        link?.applicationId ??
        config.expo.android?.package ??
        `com.appfactory.p${createHash("sha256").update(job.projectId).digest("hex").slice(0, 24)}`,
    };
    if (link)
      config.expo.extra = {
        ...config.expo.extra,
        eas: { ...config.expo.extra?.eas, projectId: link.easProjectId },
      };
    await writeFile(
      path.join(cwd, "app.json"),
      JSON.stringify(config, null, 2) + "\n",
    );
    for (const file of ["eas.json", ".easignore"]) {
      let original = "";
      try {
        const info = await lstat(path.join(cwd, file));
        if (!info.isFile()) throw new Error("EAS dosyası geçersiz.");
        original = await readFile(path.join(cwd, file), "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const template = await readFile(
        path.join(this.root, "templates/expo-base", file),
        "utf8",
      );
      if (file === ".easignore")
        await writeFile(path.join(cwd, file), original + "\n" + template);
      else {
        const previous = original ? JSON.parse(original) : {};
        const required = JSON.parse(template);
        await writeFile(
          path.join(cwd, file),
          JSON.stringify(
            {
              ...previous,
              cli: { ...previous.cli, ...required.cli },
              build: { ...previous.build, preview: required.build.preview },
            },
            null,
            2,
          ) + "\n",
        );
      }
    }
    if (!link) {
      const result = await this.command(
        [
          "init",
          ...(existing ? ["--id", z.uuid().parse(existing)] : []),
          "--force",
          "--non-interactive",
        ],
        cwd,
        this.token,
      );
      if (result.code !== 0)
        throw new Error(
          "Expo proje bağlantısı kurulamadı. Hesap yetkilerini kontrol edin.",
        );
      const updated = await this.jsonFile(cwd, "app.json");
      link = linkSchema.parse({
        projectId: job.projectId,
        easProjectId: updated.expo?.extra?.eas?.projectId,
        owner: updated.expo?.owner,
        slug: updated.expo?.slug,
        applicationId: updated.expo?.android?.package,
      });
      await writeFile(linkFile + ".tmp", JSON.stringify(link, null, 2) + "\n", {
        mode: 0o600,
      });
      await rename(linkFile + ".tmp", linkFile);
    }
    job.easProjectId = link.easProjectId;
    job.owner = link.owner;
    job.slug = link.slug;
    await this.persist(job);
  }
  private apply(job: EasJob, input: unknown, requireMessage = false) {
    const remote = remoteSchema.parse(input);
    if (
      remote.app.id !== job.easProjectId ||
      (requireMessage && remote.message !== `App Factory ${job.id}`)
    )
      throw new Error("Expo derlemesi bu gönderime ait değil.");
    if (job.buildId && job.buildId !== remote.id)
      throw new Error("Expo derleme kimliği değişti.");
    job.buildId = remote.id;
    job.status =
      remote.status === "FINISHED"
        ? "finished"
        : remote.status === "ERRORED"
          ? "failed"
          : remote.status === "CANCELED"
            ? "canceled"
            : remote.status === "IN_PROGRESS" ||
                remote.status === "PENDING_CANCEL"
              ? "building"
              : "queued";
    job.apkUrl =
      job.status === "finished"
        ? safeApkUrl(
            remote.artifacts?.applicationArchiveUrl ??
              remote.artifacts?.buildUrl,
          )
        : null;
    job.error =
      job.status === "failed"
        ? "Expo derlemesi başarısız. Ayrıntılar Expo sayfasında."
        : job.status === "finished" && !job.apkUrl
          ? "Derleme tamamlandı ancak APK bağlantısı henüz alınamadı. Durumu yenileyin."
          : null;
  }
  private async execute(job: EasJob, project: Project) {
    try {
      const cwd = await this.cwd(job);
      await this.verify(cwd);
      await this.approve(project, job.sourceJobId);
      await this.prepare(job, cwd);
      job.sourceFingerprint = await sourceFingerprint(cwd);
      job.status = "submitting";
      await this.persist(job);
      const result = await this.command(
        [
          "build",
          "--platform",
          "android",
          "--profile",
          "preview",
          "--non-interactive",
          "--no-wait",
          "--json",
          "--message",
          `App Factory ${job.id}`,
        ],
        cwd,
        this.token,
      );
      // Only stderr is retained: JSON stdout can contain temporary signed URLs.
      job.log = result.stderr.slice(-5000);
      if (result.code !== 0) {
        if (
          /Generating a new Keystore is not supported in --non-interactive mode/i.test(
            result.stderr + result.stdout,
          )
        ) {
          job.status = "needs_setup";
          job.error =
            "İlk Android imzalama kurulumu gerekli. Çıktı klasöründe eas credentials:configure-build --platform android --profile preview komutunu bir kez çalıştırın; sonra yeniden deneyin.";
          return;
        }
        throw new Error(
          "EAS gönderiminin sonucu belirsiz. Expo sayfasını kontrol edip iş kimliğini eşleştirin; otomatik tekrar yapılmadı.",
        );
      }
      const value = parseEasJson(result.stdout);
      const remote = Array.isArray(value) ? value[0] : value;
      this.apply(job, remote);
    } catch (e) {
      job.status = job.status === "submitting" ? "unknown" : "failed";
      job.error = e instanceof Error ? e.message : "EAS işlemi tamamlanamadı.";
    } finally {
      try {
        await this.persist(job);
      } catch {
        job.status = "unknown";
        job.error = "EAS iş kaydı yazılamadı. Expo durumunu kontrol edin.";
      }
      this.locked = false;
    }
  }
  async refresh(id: string, projectId: string, buildId?: string) {
    const job = this.jobs.get(id);
    if (!job || job.projectId !== projectId)
      throw new Error("EAS işi bulunamadı.");
    if (!this.enabled) throw new Error("EXPO_TOKEN gerekli.");
    if (this.refreshing.has(id)) return job;
    if (["preparing", "submitting"].includes(job.status)) return job;
    if (!job.buildId && !buildId) return job;
    if (!buildId && Date.now() - (this.lastRefresh.get(id) ?? 0) < 15000)
      return job;
    if (buildId && job.status !== "unknown")
      throw new Error(
        "Eşleştirme yalnızca belirsiz gönderim için kullanılabilir.",
      );
    this.refreshing.add(id);
    try {
      const cwd = await this.cwd(job);
      const result = await this.command(
        ["build:view", buildId ?? job.buildId!, "--json"],
        cwd,
        this.token,
      );
      if (result.code !== 0)
        throw new Error(
          "Expo durumuna ulaşılamadı. Mevcut derleme kaydı korunuyor.",
        );
      this.apply(job, parseEasJson(result.stdout), !!buildId);
      await this.persist(job);
      this.lastRefresh.set(id, Date.now());
      return job;
    } finally {
      this.refreshing.delete(id);
    }
  }
}
