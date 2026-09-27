import { GithubSync } from "./github";
import { ReleaseManager } from "./release";
import { DesignAssetCloud } from "./design-cloud";
import { EasManager } from "./eas";
import { PreviewManager } from "./preview";
import type { Project } from "@app-factory/schemas";
import { stopEasCommands } from "./eas-cli";
import { easRequestSchema, sameSpecification } from "@app-factory/schemas";
import { BuilderManager } from "./builder";
import { loadEnvFile } from "node:process";
import { createServer, type IncomingMessage } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { generationRequestSchema, projectIdSchema } from "@app-factory/schemas";
import { DesignImageManager } from "./design-images";
import { approveImageDesign } from "@app-factory/schemas";
import { PlannerManager } from "./planner";
import { projectSchema } from "@app-factory/schemas";
import { JobManager } from "./jobs";
import { stopCommands } from "./runner";
const port = Number(process.env.WORKER_PORT ?? 4001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Geçersiz WORKER_PORT");
async function findRoot() {
  let directory = process.cwd();
  while (true) {
    try {
      await readFile(path.join(directory, "pnpm-workspace.yaml"));
      return directory;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error("Monorepo kökü bulunamadı.");
      directory = parent;
    }
  }
}
const root = await findRoot();
try {
  loadEnvFile(path.join(root, "apps/worker/.env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT")
    throw new Error("Worker .env dosyası okunamadı.");
}
const jobs = new JobManager(root);
const planner = new PlannerManager(root);
const plannerSpend = (id: string) => {
  const job = planner.jobs.get(id);
  return job
    ? job.priorCostUsd + job.costUsd + job.uncertainCostUsd + job.reservedUsd
    : 0;
};
const designImages: DesignImageManager = new DesignImageManager(
  root,
  (id) => plannerSpend(id) + builder.spent(id),
);
const designCloud = await DesignAssetCloud.fromEnvironment(root);
async function syncDesignCloud(id: string, force = false) {
  if (!designCloud) return;
  await designCloud.sync(id, designImages.jobs, force);
  designImages.cloudError = null;
}
designImages.onSaved = (id) => syncDesignCloud(id, true);
const builder: BuilderManager = new BuilderManager(
  root,
  (id) => plannerSpend(id) + designImages.spent(id),
);

let github: GithubSync | null = null;
let githubError: string | null = null;
let githubPending = false;
const githubOperations = new Map<
  string,
  {
    id: string;
    action: string;
    progress: number;
    active: boolean;
  }
>();
function startGithubOperation(projectId: string, id: unknown, action: string) {
  id ??= randomBytes(16).toString("hex");
  if (typeof id !== "string" || id.length > 100)
    throw new Error("İşlem kimliği geçersiz.");
  const operation = { id, action, progress: 0, active: true };
  githubOperations.set(projectId, operation);
  return operation;
}
try {
  github = await GithubSync.fromEnvironment(root);
} catch {
  githubError =
    "GitHub bağlantısı kurulamadı. PAT ve GITHUB_OWNER ayarlarını kontrol edip worker'ı yeniden başlatın.";
}
builder.onSettled = async (job) => {
  if (github) await github.publish(job);
};

const resolveSource = (project: Project, sourceId: string) => {
  const source = builder.jobs.get(sourceId) ?? jobs.jobs.get(project.id);
  if (
    !source ||
    source.id !== sourceId ||
    source.project.id !== project.id ||
    source.status !== "ready" ||
    !sameSpecification(source.project, project)
  )
    throw new Error(
      "Güncel çıktı önce TypeScript ve ESLint kontrollerinden geçmeli.",
    );
  return {
    id: source.id,
    project: source.project,
    outputPath: source.outputPath,
  };
};
const preview = new PreviewManager(root, resolveSource);
const release = new ReleaseManager(
  root,
  resolveSource,
  (id) => {
    const source = builder.jobs.get(id);
    const implementation = source?.implementation;
    return [
      ...(implementation?.setup ?? []).map((item) => "Kurulum: " + item),
      ...(implementation?.coverage ?? []).map(
        (item) => "İşlev kontrolü: " + item.requirement + " — " + item.detail,
      ),
      ...(source?.project.plannerDraft?.tasks ?? []).flatMap((task) =>
        task.acceptance.map((item) => "Kabul testi: " + item),
      ),
    ];
  },
  (project, id) => preview.assertApproved(project, id),
);
const eas = new EasManager(
  root,
  resolveSource,
  undefined,
  undefined,
  undefined,
  async (project, id) => {
    await preview.assertApproved(project, id);
    await release.assertReady(project, id);
  },
);
function committedCost(id: string) {
  return (
    plannerSpend(id) -
    (planner.jobs.get(id)?.reservedUsd ?? 0) +
    designImages
      .list(id)
      .reduce((n, j) => n + j.costUsd + j.uncertainCostUsd, 0) +
    builder
      .list(id)
      .reduce(
        (n, j) =>
          n + j.tasks.reduce((v, t) => v + t.costUsd + t.uncertainCostUsd, 0),
        0,
      )
  );
}
const token = randomBytes(32).toString("hex");
async function readBody(request: IncomingMessage) {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body) > 240_000) throw new Error("İstek çok büyük.");
  }
  return JSON.parse(body);
}
const server = createServer(async (request, response) => {
  const send = (status: number, data: unknown) => {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(data));
  };
  if (request.method === "GET" && request.url === "/health") {
    send(200, {
      status: "ok",
      mode: "local",
      aiEnabled: planner.enabled,
      generatorEnabled: true,
    });
    return;
  }
  const auth = request.headers.authorization ?? "";
  const expected = `Bearer ${token}`;
  if (
    request.headers.origin ||
    Buffer.byteLength(auth) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
  ) {
    send(403, { error: "Yetkisiz istek." });
    return;
  }
  try {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/revisions" && request.method === "GET") {
      const id = projectIdSchema.parse(url.searchParams.get("projectId"));
      send(200, {
        enabled: builder.enabled,
        jobs: builder.list(id).filter((j) => j.change),
        totalCostUsd: committedCost(id),
      });
      return;
    }
    if (url.pathname === "/revisions" && request.method === "POST") {
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        send(415, { error: "JSON istek gerekli." });
        return;
      }
      if (designImages.busy || planner.busy || github?.busy || githubPending)
        throw new Error("Başka bir AI görevi sürüyor.");
      send(202, {
        job: await builder.revise(await readBody(request), resolveSource),
      });
      return;
    }
    if (url.pathname === "/github" && request.method === "GET") {
      const id = projectIdSchema.parse(url.searchParams.get("projectId"));
      send(200, {
        enabled: !!github,
        busy: !!github?.busy || builder.busy || githubPending,
        error: githubError,
        ...github?.status.get(id),
        operation: githubOperations.get(id) ?? null,
      });
      return;
    }
    if (url.pathname === "/github" && request.method === "POST") {
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        send(415, { error: "JSON istek gerekli." });
        return;
      }
      if (!github) throw new Error(githubError ?? "GITHUB_TOKEN gerekli.");
      if (
        builder.busy ||
        github.busy ||
        githubPending ||
        designImages.busy ||
        planner.busy ||
        [...jobs.jobs.values()].some((job) =>
          ["queued", "generating", "validating"].includes(job.status),
        ) ||
        eas.busy
      )
        throw new Error("Başka bir işlem sürüyor.");
      const body = await readBody(request),
        project = projectSchema.parse(body.project);
      if (body.action === "list") {
        const operation = startGithubOperation(
          project.id,
          body.operationId,
          "list",
        );
        githubPending = true;
        try {
          send(
            200,
            await github.list(project.id, (value) => {
              operation.progress = value;
            }),
          );
        } finally {
          operation.active = false;
          githubPending = false;
        }
        return;
      }
      if (body.action === "publish") {
        const candidates = builder
          .list(project.id)
          .filter((job) => job.outputPath && job.status !== "running");
        if (!candidates.length)
          throw new Error("Bu bilgisayarda gönderilecek çıktı bulunamadı.");
        const sync = github;
        const operation = startGithubOperation(
          project.id,
          body.operationId,
          "publish",
        );
        githubPending = true;
        void (async () => {
          for (const [index, job] of candidates.entries()) {
            await sync.publish(job, (value) => {
              operation.progress = Math.min(
                99,
                Math.round(((index + value / 100) / candidates.length) * 100),
              );
            });
          }
        })()
          .catch((error) =>
            sync.status.set(project.id, {
              error:
                error instanceof Error
                  ? error.message
                  : "GitHub aktarımı başarısız.",
            }),
          )
          .finally(() => {
            operation.active = false;
            githubPending = false;
          });
        send(202, { ok: true });
        return;
      }
      if (body.action === "restore") {
        const info = await preview.info(project.id);
        if (info.session && ["starting", "ready"].includes(info.session.status))
          throw new Error("Önce açık Expo önizlemesini durdurun.");
        if (typeof body.id !== "string" || typeof body.sha !== "string")
          throw new Error("Sürüm bilgisi geçersiz.");
        const sync = github;
        const operation = startGithubOperation(
          project.id,
          body.operationId,
          "restore",
        );
        github.status.set(project.id, { error: null });
        void builder
          .importRemote(
            () =>
              sync.restore(project, body.id, body.sha, (value) => {
                operation.progress = Math.round(value * 0.7);
              }),
            (value) => {
              operation.progress = value;
            },
          )
          .then((job) => {
            sync.status.set(project.id, {
              error: job.status === "failed" ? job.error : null,
              updatedAt: new Date().toISOString(),
            });
          })
          .catch((error) => {
            sync.status.set(project.id, {
              error:
                error instanceof Error
                  ? error.message
                  : "GitHub indirmesi başarısız.",
            });
          })
          .finally(() => {
            operation.active = false;
          });
        send(202, { ok: true });
        return;
      }
      throw new Error("GitHub işlemi geçersiz.");
    }
    if (url.pathname === "/preview" && request.method === "GET") {
      send(
        200,
        await preview.info(
          projectIdSchema.parse(url.searchParams.get("projectId")),
        ),
      );
      return;
    }
    if (url.pathname === "/preview" && request.method === "POST") {
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        send(415, { error: "JSON istek gerekli." });
        return;
      }
      send(200, await preview.action(await readBody(request)));
      return;
    }
    if (url.pathname === "/eas" && request.method === "GET") {
      const id = projectIdSchema.parse(url.searchParams.get("projectId"));
      send(200, { enabled: eas.enabled, jobs: eas.list(id) });
      return;
    }
    if (url.pathname === "/eas" && request.method === "POST") {
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        send(415, { error: "JSON istek gerekli." });
        return;
      }
      const input = easRequestSchema.parse(await readBody(request));
      if (input.action === "checklist")
        send(200, {
          checklist: await release.info(input.project, input.sourceJobId),
        });
      else if (input.action === "check-item")
        send(200, {
          checklist: await release.set(
            input.project,
            input.sourceJobId,
            input.fingerprint,
            input.itemId,
            input.checked,
          ),
        });
      else if (input.action === "complete")
        send(200, {
          job: await eas.complete(
            input.project,
            input.sourceJobId,
            input.jobId,
          ),
        });
      else if (input.action === "start")
        send(202, { job: await eas.start(input) });
      else
        send(200, {
          job: await eas.refresh(
            input.jobId,
            input.projectId,
            input.action === "reconcile" ? input.buildId : undefined,
          ),
        });
      return;
    }
    if (url.pathname === "/builder" && request.method === "GET") {
      const id = projectIdSchema.parse(url.searchParams.get("projectId"));
      send(200, {
        enabled: builder.enabled,
        jobs: builder.list(id),
        totalCostUsd: committedCost(id),
      });
      return;
    }
    if (url.pathname === "/builder" && request.method === "POST") {
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        send(415, { error: "JSON istek gerekli." });
        return;
      }
      if (designImages.busy || planner.busy)
        throw new Error(
          "Başka bir AI görevi sürüyor. Tamamlanmasını bekleyin.",
        );
      const body = await readBody(request);
      await syncDesignCloud(projectSchema.parse(body.project).id, true);
      send(202, {
        job: await builder.start(
          body.project,
          body.retry === true,
          "application",
          body.approval,
        ),
      });
      return;
    }
    if (url.pathname === "/design-images" && request.method === "GET") {
      const assetId = url.searchParams.get("assetId");
      if (assetId) {
        const bytes = await designImages.image(assetId);
        response.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(bytes);
        return;
      }
      const id = projectIdSchema.parse(url.searchParams.get("projectId"));
      try {
        await syncDesignCloud(id);
      } catch (error) {
        designImages.cloudError =
          error instanceof Error
            ? error.message
            : "Bulut eşitlemesi başarısız.";
      }
      send(200, {
        enabled: designImages.enabled,
        cloudError: designImages.cloudError,
        cloudEnabled: !!designCloud,
        jobs: designImages.list(id),
        totalCostUsd: committedCost(id),
      });
      return;
    }
    if (url.pathname === "/design-images" && request.method === "POST") {
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        send(415, { error: "JSON istek gerekli." });
        return;
      }
      const body = await readBody(request);
      if (body.action === "approve") {
        const project = projectSchema
          .safeExtend({ id: projectIdSchema })
          .parse(body.project);
        if (
          !Array.isArray(body.reviewedIds) ||
          !body.reviewedIds.every((id: unknown) => typeof id === "string")
        )
          throw new Error("Görsel onayları geçersiz.");
        await syncDesignCloud(project.id, true);
        const approved = approveImageDesign(
          project,
          designImages.list(project.id),
          body.reviewedIds,
        );
        approved.aiCost = Math.max(
          approved.aiCost,
          designImages.totalCost(project.id),
        );
        send(200, { project: approved });
        return;
      }
      if (builder.busy || planner.busy)
        throw new Error("AI analizi sürüyor. Tamamlanmasını bekleyin.");
      await syncDesignCloud(projectSchema.parse(body.project).id, true);
      send(202, { job: await designImages.start(body) });
      return;
    }
    if (url.pathname === "/planner" && request.method === "GET") {
      const id = url.searchParams.get("projectId");
      send(200, {
        enabled: planner.enabled,
        job: id ? (planner.jobs.get(projectIdSchema.parse(id)) ?? null) : null,
      });
      return;
    }
    if (url.pathname === "/planner" && request.method === "POST") {
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        send(415, { error: "JSON istek gerekli." });
        return;
      }
      if (designImages.busy || builder.busy)
        throw new Error("Görsel üretimi sürüyor. Tamamlanmasını bekleyin.");
      const body = await readBody(request);
      const project = projectSchema
        .safeExtend({ id: projectIdSchema })
        .parse(body.project);
      send(202, {
        enabled: planner.enabled,
        job: await planner.start(project, body.retry === true),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/jobs") {
      const id = projectIdSchema.parse(url.searchParams.get("projectId"));
      send(200, { job: jobs.jobs.get(id) ?? null });
      return;
    }
    if (request.method === "POST" && url.pathname === "/jobs") {
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        send(415, { error: "JSON istek gerekli." });
        return;
      }
      const input = generationRequestSchema.parse(await readBody(request));
      const job =
        input.action === "generate"
          ? await jobs.generate(input.project)
          : await jobs.validate(input.projectId);
      send(202, { job });
      return;
    }
    send(404, { error: "Bulunamadı." });
  } catch (error) {
    send(400, {
      error: error instanceof Error ? error.message : "İstek işlenemedi.",
    });
  }
});
server.requestTimeout = 15_000;
server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  void (async () => {
    await jobs.initialize();
    await planner.initialize();
    await designImages.initialize();
    await builder.initialize();
    await eas.initialize();
    await preview.initialize();
    await mkdir(path.join(root, "workspace"), { recursive: true });
    await writeFile(path.join(root, "workspace/.worker-token"), token, {
      mode: 0o600,
    });
    console.log(
      `App Factory worker: http://127.0.0.1:${port} · Yerel üretim açık`,
    );
  })().catch((error) => {
    console.error(error);
    server.close();
    process.exitCode = 1;
  });
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopCommands();
    stopEasCommands();
    preview.stop();
    server.close(() => process.exit(0));
  });
