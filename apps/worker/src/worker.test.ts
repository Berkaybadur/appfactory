import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runCommand } from "./runner";
import { JobManager } from "./jobs";
import type { GenerationJob } from "@app-factory/schemas";
test(
  "runner launches the installed npm CLI without a shell on Windows",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    for (const command of ["npm", "npm.cmd"]) {
      const result = await runCommand(command, ["--version"], process.cwd());
      assert.equal(result.exitCode, 0, result.output);
      assert.match(result.output, /\d+\.\d+\.\d+/);
    }
  },
);
test("runner records real failure and terminates timed-out processes", async () => {
  const failure = await runCommand(
    process.execPath,
    ["-e", 'console.error("test failure");process.exit(2)'],
    process.cwd(),
  );
  assert.equal(failure.exitCode, 2);
  assert.match(failure.output, /test failure/);
  const timeout = await runCommand(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    process.cwd(),
    100,
  );
  assert.equal(timeout.exitCode, null);
  assert.match(timeout.output, /zaman aşımı/);
});
test("restart marks unfinished jobs failed and keeps their attempt count", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "factory-worker-"));
  try {
    const directory = path.join(root, "workspace/jobs");
    await mkdir(directory, { recursive: true });
    const now = new Date().toISOString();
    const job: GenerationJob = {
      id: randomUUID(),
      projectId: "test",
      project: {
        id: "test",
        name: "Test",
        type: "mobile",
        android: true,
        ios: false,
        idea: "A sample project for worker recovery tests.",
        budgetLimit: 10,
        stage: "development",
        aiCost: 0,
        updatedAt: now,
      },
      status: "validating",
      operation: "validate",
      outputPath: "workspace/generated-projects/test",
      files: ["app.json"],
      checks: [
        {
          name: "typecheck",
          status: "running",
          output: "",
          exitCode: null,
          durationMs: 0,
        },
      ],
      validationAttempts: 3,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await writeFile(path.join(directory, "test.json"), JSON.stringify(job));
    const manager = new JobManager(root);
    await manager.initialize();
    assert.equal(manager.jobs.get("test")?.status, "failed");
    assert.equal(manager.jobs.get("test")?.checks[0]?.status, "failed");
    const persisted = JSON.parse(
      await readFile(path.join(directory, "test.json"), "utf8"),
    );
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.validationAttempts, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a newer approved specification creates a new job and archives the previous output", async () => {
  const { cp } = await import("node:fs/promises");
  const { getSpecification, reviseProject } =
    await import("@app-factory/schemas");
  const root = await mkdtemp(path.join(tmpdir(), "factory-revision-"));
  const project: GenerationJob["project"] = {
    id: "revision-test",
    name: "Test",
    type: "mobile",
    android: true,
    ios: false,
    idea: "Sürüm geçişini kontrol eden örnek uygulama.",
    budgetLimit: 10,
    stage: "development",
    aiCost: 0,
    updatedAt: new Date().toISOString(),
  };
  const waitForJob = async (manager: JobManager) => {
    for (let i = 0; i < 100; i++) {
      const job = manager.jobs.get(project.id);
      if (job && !["queued", "generating"].includes(job.status)) {
        assert.equal(job.status, "generated", job.error ?? "");
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Üretim zaman aşımı.");
  };
  try {
    await cp(path.resolve("templates"), path.join(root, "templates"), {
      recursive: true,
    });
    const manager = new JobManager(root);
    await manager.initialize();
    await manager.generate(project);
    const first = await waitForJob(manager);
    const revised = reviseProject(
      project,
      "design",
      { ...getSpecification(project).design, primary: "#166534" },
      0,
    );
    await assert.rejects(
      manager.generate({ ...revised, stage: "design" }),
      /tasarım onayı/,
    );
    const second = await manager.generate({ ...revised, stage: "development" });
    await waitForJob(manager);
    assert.notEqual(first.id, second.id);
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(
            root,
            "workspace/jobs/history",
            project.id,
            `${first.id}.json`,
          ),
          "utf8",
        ),
      ).id,
      first.id,
    );
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(root, first.outputPath, "src/theme.json"),
          "utf8",
        ),
      ).primary,
      "#2563EB",
    );
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(root, second.outputPath, "src/theme.json"),
          "utf8",
        ),
      ).primary,
      "#166534",
    );
    assert.equal(
      (await manager.generate({ ...revised, stage: "development" })).id,
      second.id,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
