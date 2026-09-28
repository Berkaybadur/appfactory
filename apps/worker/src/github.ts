import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  rename,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import {
  appConnectionSchema,
  builderJobSchema,
  projectIdSchema,
  sameSpecification,
  type BuilderJob,
  type Project,
} from "@app-factory/schemas";
import { assertRealDirectory } from "@app-factory/generator";
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const refSchema = z.object({ object: z.object({ sha: shaSchema }) });
const repoNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/);
const metadata = "appfactory-job.json";
const excluded = new Set(["node_modules", "dist", "design-targets"]);
export function githubRepoSlug(name: string) {
  const ascii = name
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .replace(/ğ/g, "g")
    .replace(/Ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/Ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/Ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/Ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/Ç/g, "c")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const slug = ascii
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug.length >= 2 ? slug : "proje";
}
export function githubRepoMarker(id: string) {
  projectIdSchema.parse(id);
  return `appfactory-project:${id}`;
}
export function githubRepoCandidates(id: string, projectName?: string) {
  projectIdSchema.parse(id);
  const names: string[] = [];
  if (projectName) {
    const slug = githubRepoSlug(projectName);
    names.push(slug);
    const suffix = id
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 8)
      .toLowerCase();
    if (suffix) {
      const unique = `${slug.slice(0, Math.max(1, 90 - suffix.length - 1))}-${suffix}`;
      names.push(unique);
    }
  }
  names.push(`appfactory-${id}`);
  return [
    ...new Set(names.filter((name) => repoNameSchema.safeParse(name).success)),
  ];
}
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
function connectionBuffer(raw: unknown) {
  const parsed = appConnectionSchema.safeParse(raw);
  const value = parsed.success ? parsed.data : { url: "", publishableKey: "" };
  return Buffer.from(JSON.stringify(value, null, 2) + "\n");
}
const emptyConnection = connectionBuffer({ url: "", publishableKey: "" });
async function packedConnection(cwd: string) {
  try {
    return connectionBuffer(
      JSON.parse(
        await readFile(path.join(cwd, "src/runtime/connection.json"), "utf8"),
      ),
    );
  } catch {
    return emptyConnection;
  }
}
export async function collectGithubFiles(cwd: string, token = "") {
  cwd = await realpath(cwd);
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
  files.set("src/runtime/connection.json", await packedConnection(cwd));
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
  private async resolvedRoot() {
    await mkdir(this.root, { recursive: true });
    this.root = await realpath(this.root);
    return this.root;
  }
  private repoRoute(name: string) {
    return `/repos/${this.owner}/${encodeURIComponent(repoNameSchema.parse(name))}`;
  }
  private async binding(id: string) {
    projectIdSchema.parse(id);
    const root = await this.resolvedRoot();
    const dir = path.join(root, "workspace/github");
    await mkdir(dir, { recursive: true });
    await assertRealDirectory(dir);
    const file = path.join(dir, id + "-repo.json");
    try {
      return {
        file,
        value: z
          .object({
            name: repoNameSchema.optional(),
            preferred: repoNameSchema.optional(),
          })
          .parse(JSON.parse(await readFile(file, "utf8"))),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return { file, value: null };
    }
  }
  private async bind(id: string, name: string) {
    const state = await this.binding(id);
    await writeFile(
      state.file,
      JSON.stringify({ ...state.value, name: repoNameSchema.parse(name) }),
      { mode: 0o600 },
    );
  }
  async preferName(id: string, projectName: string) {
    const state = await this.binding(id);
    if (state.value?.name) return;
    const preferred = githubRepoSlug(projectName);
    if (state.value?.preferred === preferred) return;
    await writeFile(state.file, JSON.stringify({ ...state.value, preferred }), {
      mode: 0o600,
    });
  }
  private ours(
    id: string,
    candidate: string,
    description: string | null | undefined,
  ) {
    return (
      candidate === `appfactory-${id}` || description === githubRepoMarker(id)
    );
  }
  private async api(
    route: string,
    method = "GET",
    body?: unknown,
    missing = false,
    conflict = false,
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
    if (missing && r.status === 404) {
      if (method === "DELETE") {
        // A private repo without token access also returns 404. Only a classic
        // token with full repo visibility can prove absence from this response.
        const scopes = (r.headers.get("x-oauth-scopes") ?? "")
          .split(",")
          .map((scope) => scope.trim());
        if (!scopes.includes("repo") || !scopes.includes("delete_repo"))
          throw new Error(
            "Depo bulunamadı veya token depoyu göremiyor. Silindiği doğrulanamadı; repo erişimini kontrol edin. Hiç oluşturulmamış depolar için repo ve delete_repo kapsamlı classic PAT kullanın.",
          );
      }
      return null;
    }
    if (conflict && r.status === 422) return null;
    if (!r.ok)
      throw new Error(
        `GitHub işlemi başarısız (HTTP ${r.status}). PAT ve repo izinlerini kontrol edin; uzak sürüm değişmişse önce indirin.`,
      );
    return r.status === 204 ? null : r.json();
  }
  async deleteProject(id: string, projectName?: string) {
    if (this.busy) throw new Error("GitHub işleminin bitmesini bekleyin.");
    this.busy = true;
    try {
      const found = await this.repo(id, false, projectName);
      await this.api(
        found?.route ?? this.repoRoute(`appfactory-${id}`),
        "DELETE",
        undefined,
        true,
      );
      this.status.delete(id);
    } catch (error) {
      throw new Error(
        "GitHub deposu silinemedi. PAT için Administration: write (classic PAT: delete_repo) iznini kontrol edin. " +
          (error instanceof Error ? error.message : ""),
      );
    } finally {
      this.busy = false;
    }
  }
  private async repo(id: string, create = false, projectName?: string) {
    projectIdSchema.parse(id);
    const bound = (await this.binding(id)).value;
    const names = [
      bound?.name,
      bound?.preferred,
      ...githubRepoCandidates(id, projectName),
    ].filter((name): name is string => !!name);
    for (const name of [...new Set(names)]) {
      const raw = await this.api(this.repoRoute(name), "GET", undefined, true);
      if (!raw) continue;
      const parsed = z
        .object({
          private: z.boolean(),
          default_branch: z.string(),
          name: z.string().optional(),
          description: z.string().nullable().optional(),
          html_url: z.string().optional(),
        })
        .parse(raw);
      if (!this.ours(id, parsed.name ?? name, parsed.description)) continue;
      if (!parsed.private)
        throw new Error("Yalnızca private repo kullanılabilir.");
      const actual = repoNameSchema.parse(
        parsed.name ? parsed.name.toLowerCase() : name,
      );
      await this.bind(id, actual);
      return {
        ...parsed,
        route: this.repoRoute(actual),
        url: parsed.html_url ?? `https://github.com/${this.owner}/${actual}`,
      };
    }
    if (!create) return null;
    const preferred =
      bound?.preferred ??
      (projectName ? githubRepoSlug(projectName) : `appfactory-${id}`);
    const fallback =
      githubRepoCandidates(id, projectName).find(
        (name) => name !== preferred,
      ) ?? `appfactory-${id}`;
    const user = z.object({ login: z.string() }).parse(await this.api("/user"));
    const createAt =
      user.login.toLowerCase() === this.owner.toLowerCase()
        ? "/user/repos"
        : `/orgs/${this.owner}/repos`;
    let created: unknown = null;
    for (const name of [...new Set([preferred, fallback])]) {
      created = await this.api(
        createAt,
        "POST",
        {
          name,
          private: true,
          auto_init: true,
          description: githubRepoMarker(id),
        },
        false,
        true,
      );
      if (created) break;
    }
    if (!created)
      throw new Error(
        "GitHub deposu oluşturulamadı. Aynı ada sahip başka bir repo olabilir; proje adını değiştirip tekrar deneyin.",
      );
    const repo = z
      .object({
        private: z.boolean(),
        default_branch: z.string(),
        name: z.string().optional(),
        description: z.string().nullable().optional(),
        html_url: z.string().optional(),
      })
      .parse(created);
    if (!repo.private) throw new Error("Yalnızca private repo kullanılabilir.");
    const actual = repoNameSchema.parse(
      repo.name ? repo.name.toLowerCase() : preferred,
    );
    await this.bind(id, actual);
    return {
      ...repo,
      route: this.repoRoute(actual),
      url: repo.html_url ?? `https://github.com/${this.owner}/${actual}`,
    };
  }
  private async state(id: string) {
    const root = await this.resolvedRoot();
    const dir = path.join(root, "workspace/github");
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
  private async headState(projectId: string) {
    const root = await this.resolvedRoot();
    const dir = path.join(root, "workspace/github");
    await mkdir(dir, { recursive: true });
    await assertRealDirectory(dir);
    const file = path.join(dir, projectId + "-head.json");
    try {
      return {
        file,
        value: z
          .object({ sha: shaSchema })
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
      await this.resolvedRoot();
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
      const repo = (await this.repo(job.project.id, true, job.project.name))!,
        branch = repo.default_branch;
      const ref = refSchema.parse(
          await this.api(
            `${repo.route}/git/ref/heads/${encodeURIComponent(branch)}`,
          ),
        ),
        jobState = await this.state(job.id),
        head = await this.headState(job.project.id);
      if (head.value && head.value.sha !== ref.object.sha)
        throw new Error(
          "GitHub sürümü başka bilgisayarda değişmiş. Üzerine yazılmadı; önce uzak sürümü alın.",
        );
      if (!head.value) {
        const existing = z
          .object({ message: z.string() })
          .safeParse(
            await this.api(`${repo.route}/git/commits/${ref.object.sha}`),
          );
        if (existing.success && /^App Factory /.test(existing.data.message))
          throw new Error(
            "GitHub sürümü başka bilgisayarda değişmiş. Üzerine yazılmadı; önce uzak sürümü alın.",
          );
      }
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
      const commit = z.object({ sha: shaSchema }).parse(
        await this.api(`${repo.route}/git/commits`, "POST", {
          message: `App Factory ${job.id} · ${job.status}`,
          tree: tree.sha,
          parents: [ref.object.sha],
        }),
      );
      progress(90);
      await this.api(
        `${repo.route}/git/refs/heads/${encodeURIComponent(branch)}`,
        "PATCH",
        {
          sha: commit.sha,
          force: false,
        },
      );
      await writeFile(
        jobState.file,
        JSON.stringify({
          sha: commit.sha,
          digest: hash,
          accounting: accounting(job),
        }),
        { mode: 0o600 },
      );
      await writeFile(head.file, JSON.stringify({ sha: commit.sha }), {
        mode: 0o600,
      });
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
    projectName?: string,
  ) {
    projectIdSchema.parse(projectId);
    if (this.busy) throw new Error("GitHub eşitlemesi sürüyor.");
    this.busy = true;
    try {
      const repo = await this.repo(projectId, create, projectName);
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
        const tree = z.object({ sha: shaSchema }).parse(
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
  async list(
    id: string,
    progress: (value: number) => void = () => {},
    projectName?: string,
  ) {
    const repo = await this.repo(id, false, projectName);
    progress(50);
    if (!repo) return { url: null, jobs: [] };
    const jobs: { id: string; sha: string; branch?: string }[] = [];
    const seen = new Set<string>();
    const main = await this.mainJob(repo);
    if (main) {
      jobs.push(main);
      seen.add(main.id);
    }
    for (let page = 1; page <= 10; page++) {
      const branches = z
        .array(
          z.object({ name: z.string(), commit: z.object({ sha: shaSchema }) }),
        )
        .parse(
          await this.api(`${repo.route}/branches?per_page=100&page=${page}`),
        );
      for (const b of branches) {
        if (!/^factory-[a-f0-9-]{36}$/.test(b.name)) continue;
        const jobId = b.name.slice(8);
        if (seen.has(jobId)) continue;
        jobs.push({ id: jobId, sha: b.commit.sha });
        seen.add(jobId);
      }
      if (branches.length < 100) return { url: repo.url, jobs };
    }
    throw new Error("GitHub sürüm sınırı aşıldı.");
  }
  private async mainJob(repo: {
    route: string;
    default_branch: string;
  }): Promise<{ id: string; sha: string; branch: string } | null> {
    const branch = repo.default_branch;
    const head = refSchema
      .nullable()
      .parse(
        await this.api(
          `${repo.route}/git/ref/heads/${encodeURIComponent(branch)}`,
          "GET",
          undefined,
          true,
        ),
      );
    if (!head) return null;
    try {
      const file = z
        .object({ encoding: z.literal("base64"), content: z.string() })
        .nullable()
        .parse(
          await this.api(
            `${repo.route}/contents/${metadata}?ref=${encodeURIComponent(branch)}`,
            "GET",
            undefined,
            true,
          ),
        );
      if (file) {
        const job = JSON.parse(
          Buffer.from(file.content.replace(/\s/g, ""), "base64").toString(
            "utf8",
          ),
        ) as { id?: unknown };
        return {
          id: z.uuid().parse(job.id).toLowerCase(),
          sha: head.object.sha,
          branch,
        };
      }
    } catch {
      // Commit message is enough when the contents API is unavailable.
    }
    try {
      const raw = z
        .object({
          message: z.string().optional(),
          commit: z.object({ message: z.string() }).optional(),
        })
        .parse(await this.api(`${repo.route}/git/commits/${head.object.sha}`));
      const message = raw.message ?? raw.commit?.message ?? "";
      const match =
        /App Factory ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
          message,
        );
      if (match)
        return {
          id: match[1]!.toLowerCase(),
          sha: head.object.sha,
          branch,
        };
    } catch {
      return null;
    }
    return null;
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
      const repo = await this.repo(project.id, false, project.name);
      if (!repo) throw new Error("GitHub deposu bulunamadı.");
      const mainRef = refSchema
        .nullable()
        .parse(
          await this.api(
            `${repo.route}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`,
            "GET",
            undefined,
            true,
          ),
        );
      const legacy = refSchema
        .nullable()
        .parse(
          await this.api(
            `${repo.route}/git/ref/heads/factory-${id}`,
            "GET",
            undefined,
            true,
          ),
        );
      if (mainRef?.object.sha !== sha && legacy?.object.sha !== sha)
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
      files.set(
        "src/runtime/connection.json",
        connectionBuffer(
          (() => {
            try {
              return files.has("src/runtime/connection.json")
                ? JSON.parse(
                    files.get("src/runtime/connection.json")!.toString("utf8"),
                  )
                : {};
            } catch {
              return {};
            }
          })(),
        ),
      );
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
      if (mainRef) {
        const head = await this.headState(project.id);
        await writeFile(
          head.file,
          JSON.stringify({ sha: mainRef.object.sha }),
          { mode: 0o600 },
        );
      }
      job.outputPath = path.relative(this.root, target);
      job.installed = false;
      progress(100);
      return job;
    } finally {
      this.busy = false;
    }
  }
}
