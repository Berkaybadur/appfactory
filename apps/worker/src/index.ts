import { GithubSync } from "./github";
import { SmokeManager } from "./smoke";
import { smokeRequestSchema } from "@app-factory/schemas";
import { ProjectDeletion } from "./project-deletion";
import { ReleaseManager } from "./release";
import { DesignAssetGithub } from "./design-github";
import { EasManager } from "./eas";
import { PreviewManager, sourceFingerprint } from "./preview";
import { appConnection } from "./connection";
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
const deletion = new ProjectDeletion(root);
let activeRequests = 0;
const planner = new PlannerManager(root);
const plannerSpend = (id: string) => {
  const job = planner.jobs.get(id);
  return job
    ? job.priorCostUsd + job.costUsd + job.uncertainCostUsd + job.reservedUsd
    : 0;
};
const designImages: DesignImageManager = new DesignImageManager(
  root,
  (id) => plannerSpend(id) + builder.spent(id) + smoke.spent(id),
);
const builder: BuilderManager = new BuilderManager(
  root,
  (id) => plannerSpend(id) + designImages.spent(id) + smoke.spent(id),
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
const designGithub = github ? new DesignAssetGithub(root, github) : null;
async function rememberGithub(project: { id: string; name: string }) {
  if (github) await github.preferName(project.id, project.name);
}
async function syncDesignGithub(
  id: string,
  force = false,
  projectName?: string,
) {
  deletion.assertAvailable(id);
  if (!designGithub) return;
  await designGithub.sync(id, designImages.jobs, force, projectName);
  designImages.cloudError = null;
}
designImages.onSaved = (id) => syncDesignGithub(id, true);

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
const smoke = new SmokeManager(
  root,
  resolveSource,
  (input) => builder.revise(input, resolveSource),
  (id) => plannerSpend(id) + designImages.spent(id) + builder.spent(id),
  undefined,
  undefined,
  async (project, id) => {
    const state = await preview.info(project.id);
    if (
      state.session?.sourceJobId !== id ||
      state.session.status !== "ready" ||
      state.session.fingerprint !==
        (await sourceFingerprint(
          path.resolve(root, resolveSource(project, id).outputPath),
        ))
    )
      throw new Error(
        "Önce bu kod sürümünün Expo Go önizlemesini başlatın ve cihazda açın.",
      );
  },
);
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
  async (project, id) => {
    await smoke.assertReady(project, id);
    await preview.assertApproved(project, id);
  },
);
const eas = new EasManager(
  root,
  resolveSource,
  undefined,
  undefined,
  undefined,
  async (project, id) => {
    await smoke.assertReady(project, id);
    await preview.assertApproved(project, id);
    await release.assertReady(project, id);
  },
);
function committedCost(id: string) {
  return (
    smoke
      .list(id)
      .reduce((n, report) => n + report.costUsd + report.uncertainCostUsd, 0) +
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
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const limit = ["/design-images", "/smoke"].includes(url.pathname)
    ? 28_300_000
    : 240_000;
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body) > limit) throw new Error("İstek çok büyük.");
  }
  const parsed = JSON.parse(body);
  if (request.url !== "/projects/delete")
    deletion.assertAvailable(parsed.project?.id ?? parsed.projectId);
  return parsed;
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
  activeRequests++;
  try {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (smoke.busy && request.method === "POST" && url.pathname !== "/smoke")
      throw new Error(
        "Smoke testi sürüyor. Kaynak değişiklikleri için tamamlanmasını bekleyin.",
      );
    if (deletion.busy)
      throw new Error("Proje silme işlemi sürüyor. Tamamlanmasını bekleyin.");
    if (url.pathname === "/projects/delete" && request.method === "POST") {
      if (!request.headers["content-type"]?.startsWith("application/json"))
        throw new Error("JSON istek gerekli.");
      const body = await readBody(request);
      const project = projectSchema
        .safeExtend({ id: projectIdSchema })
        .parse(body.project);
      if (
        body.confirmation !== project.name ||
        !["check", "delete"].includes(body.action)
      )
        throw new Error("Silmek için proje adını eksiksiz yazın.");
      if (
        activeRequests > 1 ||
        builder.busy ||
        planner.busy ||
        designImages.busy ||
        designGithub?.busy ||
        github?.busy ||
        githubPending ||
        eas.busy ||
        [...jobs.jobs.values()].some((job) =>
          ["queued", "generating", "validating"].includes(job.status),
        )
      )
        throw new Error(
          "Devam eden işlemlerin bitmesini bekleyip silmeyi yeniden deneyin.",
        );
      preview.assertDeletable(project.id);
      if (!github)
        throw new Error(
          githubError ??
            "Depoyu silebilmek için GITHUB_TOKEN bağlantısını yapılandırın.",
        );
      if (body.action === "check") await deletion.plan(project.id);
      else {
        const remote = github;
        await deletion.run(project.id, () =>
          remote.deleteProject(project.id, project.name),
        );
        jobs.jobs.delete(project.id);
        planner.jobs.delete(project.id);
        for (const [id, job] of builder.jobs)
          if (job.project.id === project.id) builder.jobs.delete(id);
        for (const [id, job] of designImages.jobs)
          if (job.projectId === project.id) designImages.jobs.delete(id);
        for (const [id, job] of eas.jobs)
          if (job.projectId === project.id) eas.jobs.delete(id);
        preview.forget(project.id);
        github.status.delete(project.id);
        githubOperations.delete(project.id);
      }
      send(200, { ok: true });
      return;
    }
    deletion.assertAvailable(url.searchParams.get("projectId"));
    const asset = url.searchParams.get("assetId");
    if (asset)
      deletion.assertAvailable(designImages.jobs.get(asset)?.projectId);
    if (url.pathname === "/revisions" && request.method === "GET") {
      const id = projectIdSchema.parse(url.searchParams.get("projectId"));
      send(200, {
        enabled: builder.enabled,
        jobs: builder.list(id).filter((j) => j.change),
        totalCostUsd: committedCost(id),
      });
      return;
    }
    if (url.pathname === "/smoke" && request.method === "POST") {
      if (!request.headers["content-type"]?.startsWith("application/json"))
        throw new Error("JSON istek gerekli.");
      const input = smokeRequestSchema.parse(await readBody(request));
      if (
        input.action !== "info" &&
        (builder.busy ||
          planner.busy ||
          designImages.busy ||
          github?.busy ||
          githubPending)
      )
        throw new Error("Önce devam eden üretim/eşitleme işlemini tamamlayın.");
      send(200, {
        ...(await smoke.act(input)),
        totalCostUsd: committedCost(input.project.id),
      });
      return;
    }
    if (url.pathname === "/smoke" && request.method === "GET") {
      const report = smoke.reports.get(url.searchParams.get("reportId") ?? "");
      const file = url.searchParams.get("file") ?? "";
      if (
        !report ||
        !report.checks.some((c) => c.evidence.includes(file)) ||
        !/^\d+\.png$/.test(file)
      )
        throw new Error("Test kanıtı bulunamadı.");
      deletion.assertAvailable(report.projectId);
      const png = await readFile(
        path.join(root, "workspace/smoke", report.id, file),
      );
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      });
      response.end(png);
      return;
    }
    if (url.pathname === "/revisions" && request.method === "POST") {
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        send(415, { error: "JSON istek gerekli." });
        return;
      }
      if (designImages.busy || planner.busy)
        throw new Error("Başka bir AI görevi sürüyor.");
      // A failed job is published right after it settles; wait instead of rejecting the retry.
      const deadline = Date.now() + 30000;
      while ((github?.busy || githubPending) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 500));
      if (github?.busy || githubPending)
        throw new Error(
          "GitHub'a yükleme sürüyor. Birkaç saniye sonra tekrar deneyin.",
        );
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
      await rememberGithub(project);
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
            await github.list(
              project.id,
              (value) => {
                operation.progress = value;
              },
              project.name,
            ),
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
        if (
          !candidates.length &&
          !designImages
            .list(project.id)
            .some((job) => job.status === "succeeded")
        )
          throw new Error("Bu bilgisayarda gönderilecek çıktı bulunamadı.");
        const sync = github;
        const operation = startGithubOperation(
          project.id,
          body.operationId,
          "publish",
        );
        githubPending = true;
        void (async () => {
          await syncDesignGithub(project.id, true, project.name);
          operation.progress = 10;
          for (const [index, job] of candidates.entries()) {
            await sync.publish(job, (value) => {
              operation.progress = Math.min(
                99,
                Math.round(
                  10 + ((index + value / 100) / candidates.length) * 90,
                ),
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
            async () => {
              await syncDesignGithub(project.id, true, project.name);
              return sync.restore(project, body.id, body.sha, (value) => {
                operation.progress = Math.round(value * 0.7);
              });
            },
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
    if (url.pathname === "/connection" && request.method === "POST") {
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        send(415, { error: "JSON istek gerekli." });
        return;
      }
      send(
        200,
        await appConnection(root, resolveSource, await readBody(request)),
      );
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
      const built = projectSchema.parse(body.project);
      await rememberGithub(built);
      await syncDesignGithub(built.id, true, built.name);
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
      const projectName = url.searchParams.get("name")?.trim() || undefined;
      try {
        if (projectName && github) await github.preferName(id, projectName);
        await syncDesignGithub(id, false, projectName ?? undefined);
      } catch (error) {
        designImages.cloudError =
          error instanceof Error
            ? error.message
            : "Bulut eşitlemesi başarısız.";
      }
      send(200, {
        enabled: designImages.enabled,
        cloudError: designImages.cloudError,
        cloudEnabled: !!designGithub,
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
        await rememberGithub(project);
        await syncDesignGithub(project.id, true, project.name);
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
      const designProject = projectSchema.parse(body.project);
      await rememberGithub(designProject);
      await syncDesignGithub(designProject.id, true, designProject.name);
      if (body.action === "upload") {
        send(202, { job: await designImages.importPng(body) });
        return;
      }
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
  } finally {
    activeRequests--;
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
    await smoke.initialize();
    await eas.initialize();
    await preview.initialize();
    await deletion.initialize();
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
