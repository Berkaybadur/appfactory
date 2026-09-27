import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { GithubSync, collectGithubFiles, portableFile } from "./github";
import { type BuilderJob, type DesignImageJob } from "@app-factory/schemas";
import { DesignAssetGithub, validateDesignPng } from "./design-github";
import { BuilderManager } from "./builder";
function mockGithub() {
  const blobs = new Map<string, Buffer>(),
    trees = new Map<string, unknown>(),
    commits = new Map<string, string>(),
    refs = new Map<string, string>([["main", "0".repeat(40)]]);
  let repo = false,
    counter = 0;
  const hash = () => (++counter).toString(16).padStart(40, "0");
  const transport: typeof fetch = async (url, init) => {
    const route = new URL(String(url)).pathname,
      method = init?.method ?? "GET",
      body = JSON.parse(String(init?.body ?? "{}"));
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer test-token",
    );
    if (route === "/user") return Response.json({ login: "team" });
    if (route === "/user/repos") {
      assert.equal(body.private, true);
      repo = true;
      return Response.json({ private: true, default_branch: "main" });
    }
    if (route === "/repos/team/appfactory-test")
      return repo
        ? Response.json({ private: true, default_branch: "main" })
        : new Response(null, { status: 404 });
    if (route.endsWith("/branches"))
      return Response.json(
        [...refs].map(([name, sha]) => ({ name, commit: { sha } })),
      );
    if (route.includes("/git/ref/heads/")) {
      const sha = refs.get(route.split("/heads/")[1]!);
      return sha
        ? Response.json({ object: { sha } })
        : new Response(null, { status: 404 });
    }
    if (route.endsWith("/git/blobs") && method === "POST") {
      const data = Buffer.from(body.content, "base64"),
        sha = createHash("sha1")
          .update(`blob ${data.length}\0`)
          .update(data)
          .digest("hex");
      blobs.set(sha, data);
      return Response.json({ sha });
    }
    if (route.includes("/git/blobs/")) {
      const data = blobs.get(route.split("/").at(-1)!)!;
      return Response.json({
        content: data.toString("base64"),
        encoding: "base64",
        size: data.length,
      });
    }
    if (route.endsWith("/git/trees") && method === "POST") {
      const sha = hash();
      trees.set(sha, body.tree);
      return Response.json({ sha });
    }
    if (route.includes("/git/trees/")) {
      const sha = route.split("/").at(-1)!;
      return Response.json({
        truncated: false,
        tree: trees.get(commits.get(sha) ?? sha),
      });
    }
    if (route.endsWith("/git/commits")) {
      const sha = hash();
      commits.set(sha, body.tree);
      return Response.json({ sha });
    }
    if (route.endsWith("/git/refs")) {
      refs.set(body.ref.replace("refs/heads/", ""), body.sha);
      return Response.json({ object: { sha: body.sha } });
    }
    if (route.includes("/git/refs/heads/")) {
      assert.equal(body.force, false);
      refs.set(route.split("/heads/")[1]!, body.sha);
      return Response.json({ object: { sha: body.sha } });
    }
    throw new Error("Unexpected mock route " + route);
  };
  return { transport, blobs, refs };
}

test("design PNG validation rejects corrupt data", () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const hash = validateDesignPng(png);
  assert.equal(validateDesignPng(png, hash), hash);
  assert.throws(() => validateDesignPng(png, "0".repeat(64)), /bütünlük/);
  assert.throws(() => validateDesignPng(Buffer.from("not a PNG")), /PNG/);
});

test("design images share the project GitHub repo before code generation and restore without AI", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "github-design-"));
  try {
    const first = path.join(root, "first"),
      second = path.join(root, "second");
    const cloud = mockGithub();
    let downloads = 0;
    const transport: typeof fetch = async (url, init) => {
      if (
        String(url).includes("/git/blobs/") &&
        (init?.method ?? "GET") === "GET"
      ) {
        const buffer = cloud.blobs.get(String(url).split("/").at(-1)!);
        if (buffer?.[0] === 137) downloads++;
      }
      return cloud.transport(url, init);
    };
    const sourceGithub = new GithubSync(first, "team", "test-token", transport);
    const destinationGithub = new GithubSync(
      second,
      "team",
      "test-token",
      transport,
    );
    const source = new DesignAssetGithub(first, sourceGithub);
    const destination = new DesignAssetGithub(second, destinationGithub);
    const job: DesignImageJob = {
      id: randomUUID(),
      projectId: "test",
      revision: 0,
      screenId: "home",
      screenName: "Ana ekran",
      brief: "Test",
      status: "succeeded",
      costUsd: 0.03,
      reservedUsd: 0,
      uncertainCostUsd: 0,
      error: null,
      createdAt: new Date().toISOString(),
      model: "test",
    };
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    await mkdir(path.join(first, "workspace/design-images"), {
      recursive: true,
    });
    await writeFile(
      path.join(first, "workspace/design-images", job.id + ".png"),
      png,
    );
    await writeFile(
      path.join(first, "workspace/design-images", job.id + ".json"),
      JSON.stringify(job),
    );
    const jobs = new Map([[job.id, job]]);
    await source.sync("test", jobs, true);
    const originalCommit = cloud.refs.get("factory-design-assets");
    assert.ok(originalCommit);
    assert.deepEqual((await sourceGithub.list("test")).jobs, []);
    assert.ok([...cloud.blobs.values()].some((buffer) => buffer.equals(png)));
    assert.ok(
      [...cloud.blobs.values()].every(
        (buffer) => !buffer.toString().includes("png_base64"),
      ),
    );
    const received = new Map<string, DesignImageJob>();
    await destination.sync("test", received, true);
    assert.deepEqual(received.get(job.id), job);
    const restoredPng = path.join(
      second,
      "workspace/design-images",
      job.id + ".png",
    );
    assert.deepEqual(await readFile(restoredPng), png);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(second, "workspace/design-images", job.id + ".json"),
          "utf8",
        ),
      ),
      job,
    );
    assert.equal(downloads, 1);
    await destination.sync("test", received, true);
    assert.equal(downloads, 1);
    assert.equal(cloud.refs.get("factory-design-assets"), originalCommit);
    // A later local image merges with the remote history instead of replacing it.
    const next = { ...job, id: randomUUID(), revision: 1 };
    received.set(next.id, next);
    await writeFile(
      path.join(second, "workspace/design-images", next.id + ".png"),
      png,
    );
    await destination.sync("test", received, true);
    await source.sync("test", jobs, true);
    assert.deepEqual(jobs.get(next.id), next);
    const changed = Buffer.concat([png, Buffer.from([2])]);
    await writeFile(restoredPng, changed);
    await assert.rejects(destination.sync("test", received, true), /bütünlük/);
    assert.deepEqual(await readFile(restoredPng), changed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub design download rejects records for another project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "github-design-invalid-"));
  try {
    const cloud = mockGithub();
    const github = new GithubSync(root, "team", "test-token", cloud.transport);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const job: DesignImageJob = {
      id: randomUUID(),
      projectId: "another",
      revision: 0,
      screenId: "home",
      screenName: "Home",
      brief: "Test",
      status: "succeeded",
      costUsd: 0,
      reservedUsd: 0,
      uncertainCostUsd: 0,
      error: null,
      createdAt: new Date().toISOString(),
      model: "test",
    };
    await github.syncDesignFiles(
      "test",
      true,
      async () =>
        new Map([
          [`design-images/${job.id}.png`, png],
          [
            `design-images/${job.id}.json`,
            Buffer.from(
              JSON.stringify({ job, sha256: validateDesignPng(png) }),
            ),
          ],
        ]),
    );
    const jobs = new Map<string, DesignImageJob>();
    await assert.rejects(
      new DesignAssetGithub(root, github).sync("test", jobs, true),
      /proje ile uyuşmuyor/,
    );
    assert.equal(jobs.size, 0);
    await assert.rejects(
      readFile(path.join(root, "workspace/design-images", job.id + ".png")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("GitHub round trip across computers preserves tasks and costs, excludes secrets and protects local/remote changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "github-test-"));
  try {
    const first = path.join(root, "first"),
      second = path.join(root, "second"),
      id = randomUUID();
    const outputPath = `workspace/generated-projects/test/${id}`,
      cwd = path.join(first, outputPath);
    await mkdir(path.join(cwd, "src/runtime"), { recursive: true });
    await writeFile(
      path.join(cwd, "app.tsx"),
      "export default function App(){return null;}",
    );
    await writeFile(path.join(cwd, ".env"), "GITHUB_TOKEN=secret");
    await mkdir(path.join(cwd, "design-references"));
    const referencePng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    await writeFile(path.join(cwd, "design-references/home.png"), referencePng);
    await writeFile(
      path.join(cwd, "src/runtime/connection.json"),
      '{"url":"private","publishableKey":"secret"}',
    );
    const job: BuilderJob = {
      id,
      mode: "application",
      project: {
        id: "test",
        name: "Test",
        idea: "Test application data",
        type: "mobile",
        android: true,
        ios: false,
        stage: "development",
        budgetLimit: 1,
        aiCost: 0,
        updatedAt: new Date().toISOString(),
      },
      status: "ready",
      outputPath,
      setupAttempts: 1,
      installed: true,
      error: null,
      setupLog: "secret logs",
      createdAt: new Date().toISOString(),
      tasks: [
        {
          screenId: "home",
          name: "Home",
          status: "ready",
          attempts: 2,
          costUsd: 0.02,
          reservedUsd: 0,
          uncertainCostUsd: 0,
          summary: "",
          limitations: [],
          log: "local log",
        },
      ],
    };
    const cloud = mockGithub(),
      a = new GithubSync(first, "team", "test-token", cloud.transport),
      b = new GithubSync(second, "team", "test-token", cloud.transport);
    const uploadProgress: number[] = [];
    const published = await a.publish(job, (value) =>
      uploadProgress.push(value),
    );
    assert.equal(uploadProgress.at(-1), 100);
    assert.ok(uploadProgress.some((value) => value > 20 && value < 80));
    assert.deepEqual(
      uploadProgress,
      [...uploadProgress].sort((a, b) => a - b),
    );
    assert.equal((await b.list("test")).jobs.length, 1);
    const downloadProgress: number[] = [];
    const imported = await b.restore(job.project, id, published.sha, (value) =>
      downloadProgress.push(value),
    );
    assert.equal(downloadProgress.at(-1), 100);
    assert.ok(downloadProgress.some((value) => value > 10 && value < 75));
    assert.deepEqual(
      downloadProgress,
      [...downloadProgress].sort((a, b) => a - b),
    );
    assert.equal(imported.tasks[0]?.attempts, 2);
    assert.equal(imported.tasks[0]?.costUsd, 0.02);
    assert.equal(imported.tasks[0]?.log, "");
    assert.equal(imported.installed, false);
    assert.deepEqual(
      await readFile(
        path.join(second, outputPath, "design-references/home.png"),
      ),
      referencePng,
    );
    await assert.rejects(readFile(path.join(second, outputPath, ".env")));
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(second, outputPath, "src/runtime/connection.json"),
          "utf8",
        ),
      ).url,
      "",
    );
    const commands: string[] = [];
    const manager = new BuilderManager(
      second,
      () => 0,
      "",
      undefined,
      async (command) => {
        commands.push(command);
        return { exitCode: 0, output: "mock", durationMs: 1 };
      },
    );
    await manager.initialize();
    const checkProgress: number[] = [];
    await manager.importRemote(
      async () => imported,
      (value) => checkProgress.push(value),
    );
    assert.deepEqual(checkProgress, [70, 80, 90, 95]);
    assert.equal(commands.length, 3);
    assert.equal(imported.status, "ready");
    await writeFile(
      path.join(second, outputPath, "app.tsx"),
      "changed on second computer",
    );
    await assert.rejects(
      b.restore(job.project, id, published.sha),
      /Yerel çıktı/,
    );
    await b.publish(imported);
    await assert.rejects(a.publish(job), /başka bilgisayarda/);
    const text = [...cloud.blobs.values()].map((b) => b.toString()).join("\n");
    assert.ok(!text.includes("GITHUB_TOKEN=secret"));
    assert.ok(!text.includes("secret logs"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("portable paths reject traversal, Windows aliases and token-bearing source", async () => {
  for (const p of [
    "../secret.ts",
    "a/../../x.ts",
    "C:/a.json",
    ".github/workflows/build.json",
    "a\\b.ts",
    "CON.ts",
    "a./b.ts",
    "node_modules/a.ts",
  ]) {
    assert.equal(portableFile(p), false, p);
  }
  const root = await mkdtemp(path.join(tmpdir(), "github-secret-"));
  try {
    await writeFile(
      path.join(root, "source.ts"),
      'const token="github_pat_' + "a".repeat(40) + '";',
    );
    await assert.rejects(collectGithubFiles(root), /gizli anahtar/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
