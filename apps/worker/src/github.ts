import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import {
  builderJobSchema,
  projectIdSchema,
  sameSpecification,
  type BuilderJob,
  type Project,
} from "@app-factory/schemas";
import { assertRealDirectory } from "@app-factory/generator";
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const refSchema = z.object({ object: z.object({ sha: shaSchema }) });
const metadata = "appfactory-job.json";
const excluded = new Set(["node_modules", "dist", "design-targets"]);
export function portableFile(name: string) {
  if ([".gitignore", ".easignore"].includes(name)) return true;
  const parts = name.split("/");
  if (
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        excluded.has(p) ||
        p.startsWith(".") ||
        /[\\:<>"|?*\x00-\x1f]/.test(p) ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p),
    )
  )
    return false;
  return /\.(tsx?|jsx?|mjs|cjs|json|md|sql|png|jpe?g|webp|svg|ttf|otf)$/i.test(
    name,
  );
}
function checkSecrets(data: Buffer, token: string) {
  const text = data.toString("utf8");
  if (
    (token && text.includes(token)) ||
    /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sb_secret_[A-Za-z0-9_-]{10,})/.test(
      text,
    )
  )
    throw new Error(
      "Dosyada gizli anahtar bulundu. GitHub aktarımı durduruldu.",
    );
  for (const key of [
    "OPENAI_API_KEY",
    "EXPO_TOKEN",
    "SUPABASE_SERVICE_ROLE_KEY",
  ])
    if (process.env[key] && text.includes(process.env[key]!))
      throw new Error("Sunucu anahtarı GitHub'a gönderilemez.");
}
const emptyConnection = Buffer.from('{"url":"","publishableKey":""}\n');
export async function collectGithubFiles(cwd: string, token = "") {
  await assertRealDirectory(cwd);
  const files = new Map<string, Buffer>();
  let size = 0;
  async function walk(dir: string, prefix = "") {
    for (const name of (await readdir(dir)).sort()) {
      if (
        excluded.has(name) ||
        (name.startsWith(".") && ![".gitignore", ".easignore"].includes(name))
      )
        continue;
      const relative = prefix + name,
        target = path.join(dir, name),
        info = await lstat(target);
      if (info.isSymbolicLink())
        throw new Error("Sembolik bağlantı GitHub'a gönderilemez.");
      if (info.isDirectory()) {
        await walk(target, relative + "/");
        continue;
      }
      if (
        !info.isFile() ||
        !portableFile(relative) ||
        relative === "src/runtime/connection.json" ||
        relative === metadata
      )
        continue;
      if (info.size > 5_000_000)
        throw new Error("GitHub dosya boyutu sınırı aşıldı.");
      const data = await readFile(target);
      size += data.length;
      if (size > 25_000_000 || files.size >= 500)
        throw new Error("GitHub çıktı boyutu sınırı aşıldı.");
      checkSecrets(data, token);
      files.set(relative, data);
    }
  }
  await walk(cwd);
  files.set("src/runtime/connection.json", emptyConnection);
  return files;
}
function digest(files: Map<string, Buffer>) {
  const h = createHash("sha256");
  for (const [name, data] of [...files].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    h.update(name);
    h.update("\0");
    h.update(data);
    h.update("\0");
  }
  return h.digest("hex");
}
function accounting(job: BuilderJob) {
  return JSON.stringify({
    status: job.status,
    tasks: job.tasks.map((t) => ({
      status: t.status,
      attempts: t.attempts,
      costUsd: t.costUsd,
      uncertainCostUsd: t.uncertainCostUsd,
      reservedUsd: t.reservedUsd,
    })),
  });
}
export class GithubSync {
  busy = false;
  readonly status = new Map<
    string,
    { error: string | null; url?: string; updatedAt?: string }
  >();
  constructor(
    private root: string,
    private owner: string,
    private token: string,
    private transport: typeof fetch = fetch,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner))
      throw new Error("GITHUB_OWNER geçersiz.");
  }
  static async fromEnvironment(root: string) {
    let env: Record<string, string | undefined> = {};
    try {
      env = parseEnv(await readFile(path.join(root, ".env"), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const token = process.env.GITHUB_TOKEN ?? env.GITHUB_TOKEN;
    if (!token) return null;
    let owner = process.env.GITHUB_OWNER ?? env.GITHUB_OWNER;
    if (!owner) {
      const probe = new GithubSync(root, "placeholder", token);
      owner = z
        .object({ login: z.string() })
        .parse(await probe.api("/user")).login;
    }
    return new GithubSync(root, owner, token);
  }
  private route(id: string) {
    projectIdSchema.parse(id);
    return `/repos/${this.owner}/appfactory-${id}`;
  }
  private async api(
    route: string,
    method = "GET",
    body?: unknown,
    missing = false,
  ): Promise<unknown> {
    let r: Response;
    try {
      r = await this.transport("https://api.github.com" + route, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60000),
        redirect: "error",
      });
    } catch {
      throw new Error("GitHub bağlantısı kurulamadı. Yerel çıktı korundu.");
    }
    if (missing && r.status === 404) return null;
    if (!r.ok)
      throw new Error(
        `GitHub işlemi başarısız (HTTP ${r.status}). PAT ve repo izinlerini kontrol edin; uzak sürüm değişmişse önce indirin.`,
      );
    return r.json();
  }
  private async repo(id: string, create = false) {
    const route = this.route(id);
    let raw = await this.api(route, "GET", undefined, true);
    if (!raw && create) {
      const user = z
        .object({ login: z.string() })
        .parse(await this.api("/user"));
      raw = await this.api(
        user.login.toLowerCase() === this.owner.toLowerCase()
          ? "/user/repos"
          : `/orgs/${this.owner}/repos`,
        "POST",
        {
          name: `appfactory-${id}`,
          private: true,
          auto_init: true,
          description: "App Factory generated mobile application",
        },
      );
    }
    if (!raw) return null;
    const repo = z
      .object({ private: z.boolean(), default_branch: z.string() })
      .parse(raw);
    if (!repo.private) throw new Error("Yalnızca private repo kullanılabilir.");
    return {
      ...repo,
      route,
      url: `https://github.com/${this.owner}/appfactory-${id}`,
    };
  }
  private async state(id: string) {
    const dir = path.join(this.root, "workspace/github");
    await mkdir(dir, { recursive: true });
    await assertRealDirectory(dir);
    const file = path.join(dir, id + ".json");
    try {
      return {
        file,
        value: z
          .object({
            sha: shaSchema,
            digest: z.string(),
            accounting: z.string().optional(),
          })
          .parse(JSON.parse(await readFile(file, "utf8"))),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return { file, value: null };
    }
  }
  async publish(
    input: BuilderJob,
    progress: (value: number) => void = () => {},
  ) {
    if (this.busy) throw new Error("GitHub eşitlemesi sürüyor.");
    this.busy = true;
    try {
      const job = builderJobSchema.parse(input);
      if (job.status === "running" || !job.outputPath)
        throw new Error("Çalışan veya çıktısı olmayan görev gönderilemez.");
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
      const files = await collectGithubFiles(cwd, this.token),
        hash = digest(files);
      const portable = {
        ...job,
        outputPath: `workspace/generated-projects/${job.project.id}/${job.id}`,
        setupLog: "",
        tasks: job.tasks.map((t) => ({ ...t, log: "" })),
        error:
          job.status === "failed"
            ? "Önceki bilgisayarda görev durdu. Model seçip devam edebilirsiniz."
            : null,
      };
      files.set(metadata, Buffer.from(JSON.stringify(portable, null, 2)));
      for (const data of files.values()) checkSecrets(data, this.token);
      progress(10);
      const repo = (await this.repo(job.project.id, true))!,
        branch = `factory-${job.id}`;
      const ref = refSchema
          .nullable()
          .parse(
            await this.api(
              `${repo.route}/git/ref/heads/${branch}`,
              "GET",
              undefined,
              true,
            ),
          ),
        state = await this.state(job.id);
      if (ref && state.value?.sha !== ref.object.sha)
        throw new Error(
          "GitHub sürümü başka bilgisayarda değişmiş. Üzerine yazılmadı; önce uzak sürümü alın.",
        );
      const entries = [];
      progress(20);
      for (const [name, data] of files) {
        const blob = z.object({ sha: shaSchema }).parse(
          await this.api(`${repo.route}/git/blobs`, "POST", {
            content: data.toString("base64"),
            encoding: "base64",
          }),
        );
        entries.push({
          path: name,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        });
        progress(Math.round(20 + (60 * entries.length) / files.size));
      }
      const tree = z
        .object({ sha: shaSchema })
        .parse(
          await this.api(`${repo.route}/git/trees`, "POST", { tree: entries }),
        );
      const base =
        ref ??
        refSchema.parse(
          await this.api(
            `${repo.route}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`,
          ),
        );
      const commit = z.object({ sha: shaSchema }).parse(
        await this.api(`${repo.route}/git/commits`, "POST", {
          message: `App Factory ${job.id} · ${job.status}`,
          tree: tree.sha,
          parents: [base.object.sha],
        }),
      );
      progress(90);
      if (ref)
        await this.api(`${repo.route}/git/refs/heads/${branch}`, "PATCH", {
          sha: commit.sha,
          force: false,
        });
      else
        await this.api(`${repo.route}/git/refs`, "POST", {
          ref: `refs/heads/${branch}`,
          sha: commit.sha,
        });
      await writeFile(
        state.file,
        JSON.stringify({
          sha: commit.sha,
          digest: hash,
          accounting: accounting(job),
        }),
        { mode: 0o600 },
      );
      this.status.set(job.project.id, {
        error: null,
        url: repo.url,
        updatedAt: new Date().toISOString(),
      });
      progress(100);
      return { url: repo.url, sha: commit.sha };
    } catch (e) {
      this.status.set(input.project.id, {
        error: e instanceof Error ? e.message : "GitHub aktarımı başarısız.",
      });
      throw e;
    } finally {
      this.busy = false;
    }
  }
  private async blob(route: string, sha: string, limit = 5_000_000) {
    const blob = z
      .object({
        encoding: z.literal("base64"),
        content: z.string(),
        size: z.number().max(limit),
      })
      .parse(await this.api(`${route}/git/blobs/${shaSchema.parse(sha)}`));
    const data = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
    if (
      data.length !== blob.size ||
      createHash("sha1")
        .update(`blob ${data.length}\0`)
        .update(data)
        .digest("hex") !== sha
    )
      throw new Error("GitHub dosya bütünlüğü doğrulanamadı.");
    return data;
  }
  async syncDesignFiles(
    projectId: string,
    create: boolean,
    reconcile: (
      remote: Map<string, string>,
      read: (name: string) => Promise<Buffer>,
    ) => Promise<Map<string, Buffer>>,
  ) {
    projectIdSchema.parse(projectId);
    if (this.busy) throw new Error("GitHub eşitlemesi sürüyor.");
    this.busy = true;
    try {
      const repo = await this.repo(projectId, create);
      if (!repo) return;
      const branch = "factory-design-assets";
      const ref = refSchema
        .nullable()
        .parse(
          await this.api(
            `${repo.route}/git/ref/heads/${branch}`,
            "GET",
            undefined,
            true,
          ),
        );
      const remote = new Map<string, string>();
      if (ref) {
        const tree = z
          .object({
            truncated: z.boolean(),
            tree: z.array(
              z.object({
                path: z.string(),
                mode: z.string(),
                type: z.string(),
                sha: shaSchema,
              }),
            ),
          })
          .parse(
            await this.api(
              `${repo.route}/git/trees/${ref.object.sha}?recursive=1`,
            ),
          );
        if (tree.truncated || tree.tree.length > 2001)
          throw new Error("GitHub tasarım dosyası sınırı aşıldı.");
        for (const entry of tree.tree) {
          if (entry.type === "tree" && entry.path === "design-images") continue;
          if (
            entry.type !== "blob" ||
            entry.mode !== "100644" ||
            !/^design-images\/[a-f0-9-]{36}\.(json|png)$/.test(entry.path) ||
            remote.has(entry.path)
          ) {
            throw new Error("GitHub tasarım dosyası geçersiz.");
          }
          remote.set(entry.path, entry.sha);
        }
      }
      const additions = await reconcile(remote, async (name) => {
        const sha = remote.get(name);
        if (!sha) throw new Error("GitHub tasarım dosyası eksik.");
        return this.blob(
          repo.route,
          sha,
          name.endsWith(".png") ? 20_000_000 : 100_000,
        );
      });
      if (additions.size) {
        if (remote.size + additions.size > 2000)
          throw new Error("GitHub tasarım dosyası sınırı aşıldı.");
        const entries = [...remote].map(([name, sha]) => ({
          path: name,
          mode: "100644",
          type: "blob",
          sha,
        }));
        for (const [name, data] of additions) {
          if (
            remote.has(name) ||
            !/^design-images\/[a-f0-9-]{36}\.(json|png)$/.test(name) ||
            data.length > 20_000_000
          ) {
            throw new Error("Tasarım dosyası mevcut kaydın üzerine yazamaz.");
          }
          checkSecrets(data, this.token);
          const blob = z.object({ sha: shaSchema }).parse(
            await this.api(`${repo.route}/git/blobs`, "POST", {
              content: data.toString("base64"),
              encoding: "base64",
            }),
          );
          entries.push({
            path: name,
            mode: "100644",
            type: "blob",
            sha: blob.sha,
          });
        }
        const tree = z
          .object({ sha: shaSchema })
          .parse(
            await this.api(`${repo.route}/git/trees`, "POST", {
              tree: entries,
            }),
          );
        const base =
          ref ??
          refSchema.parse(
            await this.api(
              `${repo.route}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`,
            ),
          );
        const commit = z.object({ sha: shaSchema }).parse(
          await this.api(`${repo.route}/git/commits`, "POST", {
            message: "App Factory tasarım görselleri",
            tree: tree.sha,
            parents: [base.object.sha],
          }),
        );
        if (ref) {
          await this.api(`${repo.route}/git/refs/heads/${branch}`, "PATCH", {
            sha: commit.sha,
            force: false,
          });
        } else {
          await this.api(`${repo.route}/git/refs`, "POST", {
            ref: `refs/heads/${branch}`,
            sha: commit.sha,
          });
        }
      }
      this.status.set(projectId, {
        error: null,
        ...this.status.get(projectId),
        url: repo.url,
      });
    } finally {
      this.busy = false;
    }
  }
  async list(id: string, progress: (value: number) => void = () => {}) {
    const repo = await this.repo(id);
    progress(50);
    if (!repo) return { url: null, jobs: [] };
    const jobs = [];
    for (let page = 1; page <= 10; page++) {
      const branches = z
        .array(
          z.object({ name: z.string(), commit: z.object({ sha: shaSchema }) }),
        )
        .parse(
          await this.api(`${repo.route}/branches?per_page=100&page=${page}`),
        );
      for (const b of branches)
        if (/^factory-[a-f0-9-]{36}$/.test(b.name))
          jobs.push({ id: b.name.slice(8), sha: b.commit.sha });
      if (branches.length < 100) return { url: repo.url, jobs };
    }
    throw new Error("GitHub sürüm sınırı aşıldı.");
  }
  async restore(
    project: Project,
    id: string,
    sha: string,
    progress: (value: number) => void = () => {},
  ) {
    if (this.busy) throw new Error("GitHub eşitlemesi sürüyor.");
    this.busy = true;
    try {
      z.uuid().parse(id);
      shaSchema.parse(sha);
      const repo = await this.repo(project.id);
      if (!repo) throw new Error("GitHub deposu bulunamadı.");
      const ref = refSchema.parse(
        await this.api(`${repo.route}/git/ref/heads/factory-${id}`),
      );
      if (ref.object.sha !== sha)
        throw new Error("Uzak sürüm değişti. Listeyi yenileyin.");
      const tree = z
        .object({
          truncated: z.boolean(),
          tree: z.array(
            z.object({
              path: z.string(),
              mode: z.string(),
              type: z.string(),
              sha: shaSchema,
            }),
          ),
        })
        .parse(await this.api(`${repo.route}/git/trees/${sha}?recursive=1`));
      if (tree.truncated || tree.tree.length > 600)
        throw new Error("GitHub dosya listesi sınırı aşıldı.");
      const files = new Map<string, Buffer>();
      progress(10);
      const fileCount = tree.tree.filter(
        (entry) => entry.type !== "tree",
      ).length;
      const normalized = new Set<string>();
      let size = 0;
      for (const e of tree.tree) {
        if (e.type === "tree") continue;
        if (
          e.type !== "blob" ||
          e.mode !== "100644" ||
          !portableFile(e.path) ||
          normalized.has(e.path.toLowerCase())
        )
          throw new Error("GitHub çıktısında geçersiz dosya var.");
        normalized.add(e.path.toLowerCase());
        const data = await this.blob(repo.route, e.sha);
        size += data.length;
        if (size > 25_000_000)
          throw new Error("GitHub çıktı boyutu sınırı aşıldı.");
        checkSecrets(data, this.token);
        files.set(e.path, data);
        progress(Math.round(10 + (65 * files.size) / fileCount));
      }
      const job = builderJobSchema.parse(
        JSON.parse(files.get(metadata)?.toString() ?? "null"),
      );
      files.delete(metadata);
      if (
        job.id !== id ||
        job.project.id !== project.id ||
        job.status === "running" ||
        !sameSpecification(job.project, project)
      )
        throw new Error(
          "Görev veya proje sürümü uyuşmuyor. Önce ortak proje kaydını yenileyin.",
        );
      files.set("src/runtime/connection.json", emptyConnection);
      const parent = path.join(
        this.root,
        "workspace/generated-projects",
        project.id,
      );
      await mkdir(parent, { recursive: true });
      await assertRealDirectory(parent);
      const target = path.join(parent, id),
        state = await this.state(id);
      const existing = await lstat(target).catch((e) => {
        if (e.code !== "ENOENT") throw e;
        return null;
      });
      if (
        existing &&
        (!state.value ||
          digest(await collectGithubFiles(target, this.token)) !==
            state.value.digest)
      )
        throw new Error(
          "Yerel çıktı değiştirilmiş veya eşitlenmemiş. Üzerine yazılmadı; önce yerel sürümü gönderin.",
        );
      if (existing) {
        const localJobPath = path.join(
          this.root,
          "workspace/builder",
          id + ".json",
        );
        const localJob = await readFile(localJobPath, "utf8").catch((e) => {
          if (e.code !== "ENOENT") throw e;
          return null;
        });
        if (
          localJob &&
          accounting(builderJobSchema.parse(JSON.parse(localJob))) !==
            state.value?.accounting
        )
          throw new Error(
            "Yerel görev veya maliyet kaydı değişmiş. Önce GitHub'a gönderin; kayıtların üzerine yazılmadı.",
          );
      }
      const staging = path.join(parent, `${id}-download-${Date.now()}`);
      progress(80);
      await mkdir(staging);
      await assertRealDirectory(staging);
      for (const [name, data] of files) {
        const file = path.join(staging, ...name.split("/"));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, data, { flag: "wx" });
      }
      const backup = path.join(parent, `${id}-backup-${Date.now()}`);
      if (existing) await rename(target, backup);
      try {
        await rename(staging, target);
      } catch (e) {
        if (existing) await rename(backup, target);
        throw e;
      }
      await writeFile(
        state.file,
        JSON.stringify({
          sha,
          digest: digest(files),
          accounting: accounting(job),
        }),
        { mode: 0o600 },
      );
      job.outputPath = path.relative(this.root, target);
      job.installed = false;
      progress(100);
      return job;
    } finally {
      this.busy = false;
    }
  }
}
