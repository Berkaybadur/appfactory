import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import {
  getSpecification,
  getScreens,
  applyPlannerResult,
  editProjectOverview,
  type Project,
  type PlannerOutput,
} from "@app-factory/schemas";
import { PlannerError, reservation } from "@app-factory/ai";
import { PlannerManager } from "./planner";
const project: Project = {
  id: "planner-test",
  name: "Test",
  idea: "Yerel verilerle çalışan basit bir mobil uygulama.",
  type: "mobile",
  android: true,
  ios: false,
  budgetLimit: 1,
  stage: "plan",
  aiCost: 0,
  updatedAt: new Date().toISOString(),
};
const spec = getSpecification(project);
const output: PlannerOutput = {
  plan: spec.plan,
  design: spec.design,
  screens: getScreens(spec),
  screenNotes: [],
  tasks: [
    {
      title: "Görev",
      description: "Özelliği geliştir.",
      acceptance: ["Çalışır."],
    },
  ],
  limitations: [],
};
async function finished(manager: PlannerManager) {
  for (let i = 0; i < 100; i++) {
    const job = manager.jobs.get(project.id);
    if (job?.status !== "running" && !manager.busy) {
      return job!;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Test zaman aşımı");
}
test("persistent Planner is idempotent and stale results cannot overwrite edits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "planner-test-"));
  try {
    let calls = 0;
    const manager = new PlannerManager(root, "test", async () => {
      calls++;
      return { output, costUsd: 0.002 };
    });
    await manager.initialize();
    const first = await manager.start(project);
    await manager.start(project);
    const job = await finished(manager);
    assert.equal(calls, 1);
    assert.equal(job.id, first.id);
    const applied = applyPlannerResult(project, job);
    assert.equal(applied.stage, "plan");
    assert.equal(applied.specification?.revision, 1);
    assert.equal(applyPlannerResult(applied, job), applied);
    assert.throws(
      () =>
        applyPlannerResult(
          { ...project, specification: { ...spec, revision: 2 } },
          job,
        ),
      /değişti/,
    );
    const restarted = new PlannerManager(root, "test", async () => {
      throw new Error("Must not run");
    });
    await restarted.initialize();
    assert.equal((await restarted.start(project)).status, "succeeded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("edited overview starts a fresh analysis and retains previous analysis costs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "planner-overview-"));
  try {
    const inputs: string[] = [];
    const manager = new PlannerManager(root, "test", async (input) => {
      inputs.push(input.idea);
      return { output, costUsd: 0.002 };
    });
    await manager.initialize();
    await manager.start(project);
    const first = await finished(manager);
    const applied = applyPlannerResult(project, first);
    assert.equal((await manager.start(applied)).id, first.id);
    const next = editProjectOverview(
      applied,
      {
        ...applied,
        idea: "Yeni fikirle alışveriş listelerini yöneten uygulama.",
      },
      applied,
    );
    assert.throws(() => applyPlannerResult(next, first), /değişti/);
    await assert.rejects(
      manager.start({ ...next, budgetLimit: 0.01 }),
      /bütçesi/,
    );
    const second = await manager.start({ ...next, aiCost: 0 });
    await finished(manager);
    assert.notEqual(second.id, first.id);
    assert.equal(second.attempts, 1);
    assert.equal(second.priorCostUsd, first.costUsd);
    assert.equal(second.baseRevision, getSpecification(next).revision);
    assert.deepEqual(inputs, [project.idea, next.idea]);
    const final = applyPlannerResult(next, second);
    assert.equal(final.aiCost, 0.004);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overview changes cannot replace a running analysis", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "planner-running-"));
  let complete!: (value: { output: PlannerOutput; costUsd: number }) => void;
  const manager = new PlannerManager(
    root,
    "test",
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  try {
    await manager.initialize();
    const first = await manager.start(project);
    const next = editProjectOverview(
      project,
      { ...project, name: "Yeni isim" },
      project,
    );
    await assert.rejects(manager.start(next), /tamamlanmasını/);
    assert.equal(manager.jobs.get(project.id)?.id, first.id);
  } finally {
    complete({ output, costUsd: 0.002 });
    await finished(manager);
    await rm(root, { recursive: true, force: true });
  }
});
test("budget and missing key prevent paid requests; manual retries are not capped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "planner-limits-"));
  try {
    let calls = 0;
    const run = async () => {
      calls++;
      throw new PlannerError("Failure", 0);
    };
    const off = new PlannerManager(root, "", run);
    await off.initialize();
    await assert.rejects(off.start(project), /OPENAI_API_KEY/);
    const manager = new PlannerManager(root, "test", run);
    await manager.initialize();
    await assert.rejects(
      manager.start({ ...project, budgetLimit: 0.01 }),
      /bütçesi/,
    );
    assert.equal(calls, 0);
    for (let i = 0; i < 4; i++) {
      await manager.start(project, i > 0);
      await finished(manager);
    }
    assert.equal(calls, 4);
    await assert.rejects(
      manager.start({ ...project, budgetLimit: 0.01 }, true),
      /bütçesi/,
    );
    assert.equal(calls, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("interrupted requests retain reserved budget after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "planner-restart-"));
  try {
    const manager = new PlannerManager(
      root,
      "test",
      () => new Promise(() => {}),
    );
    await manager.initialize();
    await manager.start(project);
    const restarted = new PlannerManager(root, "test");
    await restarted.initialize();
    const job = restarted.jobs.get(project.id)!;
    assert.equal(job.status, "failed");
    assert.equal(job.uncertainCostUsd, reservation(project));
    assert.equal(job.reservedUsd, 0);
    const persisted = JSON.parse(
      await readFile(
        root + "/workspace/planner/" + project.id + ".json",
        "utf8",
      ),
    );
    assert.equal(persisted.uncertainCostUsd, job.uncertainCostUsd);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
