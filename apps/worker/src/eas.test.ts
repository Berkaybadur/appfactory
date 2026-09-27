import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { type Project } from "@app-factory/schemas";
import { EasManager as RealEasManager, safeApkUrl } from "./eas";
import { easEnvironment, parseEasJson, type EasCommandResult } from "./eas-cli";
class EasManager extends RealEasManager {
  constructor(...args: ConstructorParameters<typeof RealEasManager>) {
    super(args[0], args[1], args[2], args[3], async () => {});
  }
}
const project: Project = {
  id: "eas-test",
  name: "Test",
  idea: "Yerel kayıt uygulaması için örnek proje.",
  type: "mobile",
  android: true,
  ios: false,
  stage: "build",
  budgetLimit: 1,
  aiCost: 0,
  updatedAt: new Date().toISOString(),
};
const success = (stdout = ""): EasCommandResult => ({
  code: 0,
  stdout,
  stderr: "",
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "eas-test-"));
  await cp(
    path.resolve("templates/expo-base"),
    path.join(root, "templates/expo-base"),
    { recursive: true },
  );
  const sourceId = randomUUID();
  const outputPath = `workspace/generated-projects/${project.id}/${sourceId}`;
  const cwd = path.join(root, outputPath);
  await mkdir(cwd, { recursive: true });
  await writeFile(
    path.join(cwd, "app.json"),
    JSON.stringify({ expo: { name: "Test", slug: "mobile-eas-test" } }),
  );
  const source = { id: sourceId, project, outputPath };
  return {
    root,
    cwd,
    source,
    request: {
      action: "start" as const,
      project,
      sourceJobId: sourceId,
      requestId: randomUUID(),
      expectedLatestId: null as string | null,
    },
  };
}
async function finish(m: RealEasManager, id: string) {
  for (let i = 0; i < 200; i++) {
    if (
      !m.busy &&
      !["preparing", "submitting"].includes(m.jobs.get(id)?.status ?? "")
    )
      return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timeout");
}
function mock(
  cwd: string,
  cloudId: string,
  onBuild: (args: string[]) => Promise<EasCommandResult>,
) {
  return async (args: string[]) => {
    if (args[0] === "whoami")
      return success("tester (authenticated using EXPO_TOKEN)");
    if (args[0] === "init") {
      const p = path.join(cwd, "app.json");
      const config = JSON.parse(await readFile(p, "utf8"));
      config.expo.extra = { eas: { projectId: cloudId } };
      await writeFile(p, JSON.stringify(config));
      return success();
    }
    return onBuild(args);
  };
}
const remote = (
  cloudId: string,
  buildId: string,
  status = "IN_QUEUE",
  message?: string,
) => ({
  id: buildId,
  status,
  platform: "ANDROID",
  buildProfile: "preview",
  app: { id: cloudId },
  message,
  artifacts: {
    applicationArchiveUrl: "https://expo.dev/artifacts/eas/example.apk",
  },
});
test("EAS persists one submission, polls completion and keeps device test unperformed", async () => {
  const f = await fixture();
  const cloudId = randomUUID(),
    buildId = randomUUID();
  let builds = 0;
  try {
    const m = new EasManager(
      f.root,
      () => f.source,
      "test",
      mock(f.cwd, cloudId, async (args) => {
        if (args[0] === "build") {
          builds++;
          return success(JSON.stringify([remote(cloudId, buildId)]));
        }
        return success(JSON.stringify(remote(cloudId, buildId, "FINISHED")));
      }),
    );
    await m.initialize();
    const job = await m.start(f.request);
    await finish(m, job.id);
    assert.equal(job.status, "queued");
    await assert.rejects(
      m.complete(project, f.source.id, job.id),
      /APK derlemesi/,
    );
    await m.start(f.request);
    assert.equal(builds, 1);
    await m.refresh(job.id, project.id);
    assert.equal(job.status, "finished");
    assert.equal(job.deviceTest, "not_tested");
    assert.equal(job.apkUrl, "https://expo.dev/artifacts/eas/example.apk");
    await assert.rejects(
      m.start({
        ...f.request,
        requestId: randomUUID(),
        expectedLatestId: job.id,
      }),
      /zaten hazır/,
    );
    const restarted = new EasManager(f.root, () => f.source);
    await restarted.initialize();
    assert.equal(restarted.jobs.get(job.id)?.buildId, buildId);
    await restarted.complete(project, f.source.id, job.id);
    assert.equal(restarted.jobs.get(job.id)?.deviceTest, "passed");
    await writeFile(path.join(f.cwd, "changed.txt"), "changed");
    await assert.rejects(
      restarted.complete(project, f.source.id, job.id),
      /kaynak sürümü/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("unknown submission blocks duplicate builds and only matches its own cloud job", async () => {
  const f = await fixture();
  const cloudId = randomUUID(),
    buildId = randomUUID();
  let builds = 0;
  let wrong = true;
  try {
    const m = new EasManager(
      f.root,
      () => f.source,
      "test",
      mock(f.cwd, cloudId, async (args) => {
        if (args[0] === "build") {
          builds++;
          return { code: null, stdout: "", stderr: "timeout" };
        }
        return success(
          JSON.stringify(
            remote(
              cloudId,
              buildId,
              "IN_QUEUE",
              wrong
                ? "another submission"
                : `App Factory ${f.request.requestId}`,
            ),
          ),
        );
      }),
    );
    await m.initialize();
    const job = await m.start(f.request);
    await finish(m, job.id);
    assert.equal(job.status, "unknown");
    await assert.rejects(
      m.start({
        ...f.request,
        requestId: randomUUID(),
        expectedLatestId: job.id,
      }),
      /belirsiz/,
    );
    await assert.rejects(m.refresh(job.id, project.id, buildId), /ait değil/);
    assert.equal(job.buildId, null);
    wrong = false;
    await m.refresh(job.id, project.id, buildId);
    assert.equal(job.status, "queued");
    assert.equal(builds, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("restart never resubmits an interrupted EAS call", async () => {
  const f = await fixture();
  const cloudId = randomUUID();
  let calls = 0;
  try {
    const m = new EasManager(
      f.root,
      () => f.source,
      "test",
      mock(f.cwd, cloudId, async () => {
        calls++;
        return new Promise(() => {});
      }),
    );
    await m.initialize();
    const job = await m.start(f.request);
    for (let i = 0; i < 100 && calls === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls, 1);
    const restarted = new EasManager(f.root, () => f.source);
    await restarted.initialize();
    assert.equal(restarted.jobs.get(job.id)?.status, "unknown");
    assert.equal(calls, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("first-time signing is actionable and manual attempts are not capped", async () => {
  const f = await fixture();
  const cloudId = randomUUID();
  try {
    const m = new EasManager(
      f.root,
      () => f.source,
      "test",
      mock(f.cwd, cloudId, async () => ({
        code: 1,
        stdout: "",
        stderr:
          "Generating a new Keystore is not supported in --non-interactive mode",
      })),
    );
    await m.initialize();
    let previous: string | null = null;
    for (let n = 0; n < 4; n++) {
      const job = await m.start({
        ...f.request,
        requestId: randomUUID(),
        expectedLatestId: previous,
      });
      await finish(m, job.id);
      assert.equal(job.status, "needs_setup");
      previous = job.id;
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("invalid sources, Android selection and concurrent submissions fail before CLI", async () => {
  const f = await fixture();
  let called = 0;
  try {
    const command = async () => {
      called++;
      return success();
    };
    const m = new EasManager(
      f.root,
      () => {
        throw new Error("Kontroller geçmedi");
      },
      "test",
      command,
    );
    await m.initialize();
    await assert.rejects(m.start(f.request), /Kontroller/);
    assert.equal(called, 0);
    const invalid = new EasManager(
      f.root,
      () => ({ ...f.source, outputPath: "../outside" }),
      "test",
      command,
    );
    await invalid.initialize();
    await assert.rejects(invalid.start(f.request), /yolu/);
    assert.equal(called, 0);
    const concurrent = new EasManager(
      f.root,
      () => f.source,
      "test",
      () => new Promise(() => {}),
    );
    await concurrent.initialize();
    const results = await Promise.allSettled([
      concurrent.start(f.request),
      concurrent.start({ ...f.request, requestId: randomUUID() }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("CLI environment omits AI credentials and APK links only accept stable Expo artifacts", () => {
  const env = easEnvironment("/tmp/project", "test-token");
  assert.equal(env.EXPO_TOKEN, "test-token");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.EAS_PROJECT_ROOT, "/tmp/project");
  assert.equal(
    safeApkUrl("https://expo.dev/artifacts/eas/app.apk"),
    "https://expo.dev/artifacts/eas/app.apk",
  );
  for (const url of [
    "https://evil.example/app.apk",
    "javascript:alert(1)",
    "https://expo.dev/artifacts/eas/app.apk?secret=x",
    "https://user:pass@expo.dev/artifacts/eas/app.apk",
  ])
    assert.equal(safeApkUrl(url), null);
  assert.deepEqual(parseEasJson('CLI warning\n[{"id":1}]'), [{ id: 1 }]);
});

test("fresh code check failure prevents cloud commands", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const manager = new RealEasManager(
      f.root,
      () => f.source,
      "test",
      async () => {
        calls++;
        return success();
      },
      async () => {
        throw new Error("TypeScript kontrolü başarısız");
      },
    );
    await manager.initialize();
    const job = await manager.start(f.request);
    await finish(manager, job.id);
    assert.equal(job.status, "failed");
    assert.equal(calls, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
