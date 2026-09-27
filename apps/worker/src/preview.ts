import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { createServer } from "node:net";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { assertRealDirectory } from "@app-factory/generator";
import {
  previewRequestSchema,
  previewApprovalSchema,
  type PreviewSession,
  type PreviewApproval,
  type Project,
} from "@app-factory/schemas";
import type { EasSource } from "./eas";
import { z } from "zod";

const ignored = new Set([
  "node_modules",
  ".expo",
  ".git",
  "dist",
  "design-targets",
]);
export async function sourceFingerprint(cwd: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(dir: string) {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const e of entries) {
      if (ignored.has(e.name) || e.name.endsWith(".log")) continue;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink())
        throw new Error(
          "Önizleme kaynaklarında sembolik bağlantı desteklenmiyor.",
        );
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        hash.update(path.relative(cwd, p));
        hash.update("\0");
        hash.update(await readFile(p));
        hash.update("\0");
      }
    }
  }
  await walk(cwd);
  return hash.digest("hex");
}
export function previewEnvironment(host: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    FORCE_COLOR: "0",
    EXPO_NO_TELEMETRY: "1",
    EXPO_NO_DOTENV: "1",
    EXPO_TOKEN: process.env.EXPO_TOKEN,
    REACT_NATIVE_PACKAGER_HOSTNAME: host,
  };
}
export function lanHost() {
  const candidates = Object.entries(networkInterfaces()).flatMap(
    ([name, addresses]) =>
      (addresses ?? [])
        .filter(
          (a) => a.family === "IPv4" && !a.internal && !name.startsWith("utun"),
        )
        .map((a) => ({ name, address: a.address })),
  );
  const host =
    candidates.find((a) => a.name === "en0") ??
    candidates.find((a) => /^(en|eth|wlan)/.test(a.name)) ??
    candidates[0];
  if (!host)
    throw new Error(
      "Yerel ağ bulunamadı. Bilgisayarı telefonla aynı Wi-Fi ağına bağlayın.",
    );
  return host.address;
}
async function availablePort() {
  for (let port = 8100; port < 8150; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "0.0.0.0", () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error("Expo önizlemesi için boş port bulunamadı.");
}
function terminate(child: ChildProcess) {
  try {
    if (child.pid && process.platform !== "win32")
      process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    /* already exited */
  }
}
export class PreviewManager {
  assertDeletable(projectId: string) {
    if (
      this.busy ||
      (this.session?.projectId === projectId &&
        ["starting", "ready"].includes(this.session.status))
    )
      throw new Error("Önce açık Expo önizlemesini durdurun.");
  }
  forget(projectId: string) {
    for (const [id, approval] of this.approvals)
      if (approval.projectId === projectId) this.approvals.delete(id);
    if (this.session?.projectId === projectId) this.session = null;
  }
  private session: PreviewSession | null = null;
  private child: ChildProcess | null = null;
  private busy = false;
  private approvals = new Map<string, PreviewApproval>();
  constructor(
    private root: string,
    private resolveSource: (project: Project, id: string) => EasSource,
  ) {}
  async initialize() {
    this.root = await realpath(this.root);
    const dir = path.join(this.root, "workspace/previews");
    await mkdir(dir, { recursive: true });
    await assertRealDirectory(dir);
    for (const file of await readdir(dir))
      if (file.endsWith(".json")) {
        const a = previewApprovalSchema.parse(
          JSON.parse(await readFile(path.join(dir, file), "utf8")),
        );
        if (file !== a.sourceJobId + ".json")
          throw new Error("Önizleme onay dosyası geçersiz.");
        this.approvals.set(a.sourceJobId, a);
      }
  }
  async info(projectId: string) {
    const approvals: PreviewApproval[] = [];
    for (const a of this.approvals.values()) {
      if (a.projectId !== projectId) continue;
      try {
        const cwd = path.join(
          this.root,
          "workspace/generated-projects",
          a.projectId,
          a.sourceJobId,
        );
        await assertRealDirectory(cwd);
        if (a.fingerprint === (await sourceFingerprint(cwd))) approvals.push(a);
      } catch {
        /* Missing or changed output invalidates the approval. */
      }
    }
    return {
      session: this.session?.projectId === projectId ? this.session : null,
      approvals,
      occupied:
        this.session &&
        ["starting", "ready"].includes(this.session.status) &&
        this.session.projectId !== projectId,
    };
  }
  private async cwd(source: EasSource) {
    const cwd = path.join(
      this.root,
      "workspace/generated-projects",
      source.project.id,
      source.id,
    );
    if (path.resolve(this.root, source.outputPath) !== cwd)
      throw new Error("Önizleme çıktı yolu geçersiz.");
    await assertRealDirectory(cwd);
    return cwd;
  }
  async assertApproved(project: Project, id: string) {
    const source = this.resolveSource(project, id),
      a = this.approvals.get(id);
    if (
      !a ||
      a.projectId !== project.id ||
      a.fingerprint !== (await sourceFingerprint(await this.cwd(source)))
    )
      throw new Error(
        "Bu kod sürümü için önce Expo Go önizlemesini telefonda inceleyip onaylayın.",
      );
  }
  async action(raw: unknown) {
    const input = previewRequestSchema.parse(raw);
    if (this.busy) throw new Error("Önizleme işlemi devam ediyor.");
    this.busy = true;
    try {
      if (input.action === "stop") {
        if (
          this.session?.id !== input.sessionId ||
          this.session.projectId !== input.projectId
        )
          throw new Error("Önizleme oturumu değişti.");
        this.stop();
        return this.info(input.projectId);
      }
      const source = this.resolveSource(input.project, input.sourceJobId),
        cwd = await this.cwd(source);
      const fingerprint = await sourceFingerprint(cwd);
      if (input.action === "approve") {
        const session = this.session;
        if (
          !session ||
          session.id !== input.sessionId ||
          session.status !== "ready" ||
          session.sourceJobId !== source.id ||
          session.projectId !== source.project.id
        )
          throw new Error("Önce güncel çıktının önizlemesini başlatın.");
        if (session.fingerprint !== fingerprint)
          throw new Error(
            "Kod değişti. Önizlemeyi yeniden başlatıp yeni sürümü inceleyin.",
          );
        const approval: PreviewApproval = {
          projectId: source.project.id,
          sourceJobId: source.id,
          sessionId: session.id,
          fingerprint,
          approvedAt: new Date().toISOString(),
          platforms: [...new Set(input.platforms)],
        };
        const file = path.join(
          this.root,
          "workspace/previews",
          source.id + ".json",
        );
        await writeFile(file + ".tmp", JSON.stringify(approval), {
          mode: 0o600,
        });
        await rename(file + ".tmp", file);
        this.approvals.set(source.id, approval);
      } else {
        if (
          this.session &&
          ["starting", "ready"].includes(this.session.status)
        ) {
          if (
            this.session.sourceJobId === source.id &&
            this.session.fingerprint === fingerprint
          )
            return this.info(source.project.id);
          throw new Error("Önce açık önizlemeyi durdurun.");
        }
        const host = lanHost(),
          port = await availablePort();
        const session: PreviewSession = {
          id: randomUUID(),
          projectId: source.project.id,
          sourceJobId: source.id,
          status: "starting",
          url: null,
          sdkVersion: null,
          error: null,
          log: "",
          fingerprint,
          createdAt: new Date().toISOString(),
        };
        this.session = session;
        const child = spawn(
          process.execPath,
          [
            path.join(cwd, "node_modules/expo/bin/cli"),
            "start",
            "--go",
            "--lan",
            "--port",
            String(port),
          ],
          {
            cwd,
            env: previewEnvironment(host),
            shell: false,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        this.child = child;
        const append = (chunk: Buffer) => {
          session.log = (session.log + chunk.toString()).slice(-8000);
          if (process.env.EXPO_TOKEN)
            session.log = session.log.replaceAll(
              process.env.EXPO_TOKEN,
              "[redacted]",
            );
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.once("error", () => {
          session.status = "failed";
          session.error =
            "Expo başlatılamadı. Bağımlılık kurulumunu kontrol edin.";
          session.url = null;
        });
        child.once("close", () => {
          if (session.status !== "stopped") {
            session.status = "failed";
            session.error ??=
              "Expo önizlemesi kapandı. Günlükleri kontrol edip yeniden başlatın.";
          }
          session.url = null;
          if (this.child === child) this.child = null;
        });
        void this.waitReady(session, child, port, host);
      }
      return this.info(source.project.id);
    } finally {
      this.busy = false;
    }
  }
  private async waitReady(
    session: PreviewSession,
    child: ChildProcess,
    port: number,
    host: string,
  ) {
    const deadline = Date.now() + 90000;
    while (session.status === "starting" && Date.now() < deadline) {
      try {
        for (const platform of ["ios", "android"]) {
          const response = await fetch(`http://127.0.0.1:${port}/`, {
            headers: {
              "expo-platform": platform,
              accept: "application/expo+json",
            },
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) throw new Error("Manifest hazır değil");
          const manifest = z
            .object({
              launchAsset: z.object({ url: z.string() }),
              extra: z.object({
                expoClient: z.object({ sdkVersion: z.string() }),
              }),
            })
            .parse(await response.json());
          if (
            !manifest.launchAsset?.url ||
            !manifest.extra?.expoClient?.sdkVersion
          )
            throw new Error("Expo Go manifesti bulunamadı");
          session.sdkVersion = manifest.extra.expoClient.sdkVersion;
        }
        if (session.status !== "starting") return;
        session.url = `exp://${host}:${port}`;
        session.status = "ready";
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    if (session.status === "starting") {
      session.status = "failed";
      session.error = "Expo 90 saniyede hazır olmadı. Günlükleri kontrol edin.";
      terminate(child);
    }
  }
  stop() {
    if (this.session) {
      this.session.status = "stopped";
      this.session.url = null;
    }
    if (this.child) terminate(this.child);
    this.child = null;
  }
}
