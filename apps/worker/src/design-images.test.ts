import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  getSpecification,
  getScreens,
  approveImageDesign,
  type Project,
  projectSchema,
  approvedDesignReferences,
  designGenerationReferences,
  designImageReservation,
  type DesignImageJob,
} from "@app-factory/schemas";
import { DesignImageManager } from "./design-images";
import type { DesignImageReference } from "@app-factory/ai";
const base: Project = {
  id: "image-test",
  name: "Test",
  idea: "Yerel alışkanlık takibi için mobil uygulama.",
  type: "mobile",
  android: true,
  ios: false,
  budgetLimit: 1,
  aiCost: 0,
  stage: "design",
  updatedAt: new Date().toISOString(),
};
const project = {
  ...base,
  specification: {
    ...getSpecification(base),
    screens: getScreens(getSpecification(base)).map((s) => ({
      ...s,
      enabled: s.id === "home",
    })),
  },
};
async function finish(m: DesignImageManager) {
  for (let i = 0; i < 100; i++) {
    if (!m.busy) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timeout");
}

test("generation selects home and the two latest approved other screens without removing approvals", () => {
  const ids = ["home", "register", "settings", "create", "details"];
  const jobs: DesignImageJob[] = ids.map((screenId, index) => ({
    id: randomUUID(),
    projectId: base.id,
    revision: 0,
    screenId,
    screenName: screenId,
    brief: "",
    status: "succeeded",
    costUsd: 0,
    reservedUsd: 0,
    uncertainCostUsd: 0,
    error: null,
    createdAt: new Date(index * 1000).toISOString(),
    model: "test",
  }));
  const current: Project = {
    ...base,
    specification: {
      ...getSpecification(base),
      screens: getScreens(getSpecification(base)).map((screen) => ({
        ...screen,
        enabled: true,
      })),
    },
    designDraftApprovals: { revision: 0, assetIds: jobs.map((job) => job.id) },
  };
  const selected = designGenerationReferences(current, jobs, "details");
  assert.deepEqual(
    selected.map((job) => job.screenId),
    ["home", "settings", "create"],
  );
  assert.equal(designImageReservation(selected.length), 0.35);
  assert.equal(approvedDesignReferences(current, jobs).length, jobs.length);
  assert.deepEqual(
    designGenerationReferences(current, jobs, "home").map(
      (job) => job.screenId,
    ),
    ["create", "details"],
  );
  const early = {
    ...current,
    designDraftApprovals: {
      revision: 0,
      assetIds: jobs.slice(0, 2).map((job) => job.id),
    },
  };
  assert.deepEqual(
    designGenerationReferences(early, jobs, "settings").map(
      (job) => job.screenId,
    ),
    ["home", "register"],
  );
  const withoutHome = {
    ...current,
    designDraftApprovals: {
      revision: 0,
      assetIds: jobs.slice(1).map((job) => job.id),
    },
  };
  assert.deepEqual(
    designGenerationReferences(withoutHome, jobs, "details").map(
      (job) => job.screenId,
    ),
    ["settings", "create"],
  );
});

test("home then settings then registration accumulate only approved current screen references", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "design-references-"));
  try {
    let current: Project = {
      ...base,
      budgetLimit: 5,
      specification: {
        ...getSpecification(base),
        screens: getScreens(getSpecification(base)).map((screen) => ({
          ...screen,
          enabled: ["home", "settings", "register"].includes(screen.id),
        })),
      },
    };
    const inputs: DesignImageReference[][] = [];
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(1024, 16);
    png.writeUInt32BE(1536, 20);
    const manager = new DesignImageManager(
      root,
      () => 0,
      "test",
      async (_prompt, _key, _transport, references = []) => {
        inputs.push(references);
        return { png, costUsd: 0.04 };
      },
    );
    await manager.initialize();
    const start = async (
      screenId: string,
      expectedLatestId: string | null = null,
    ) => {
      const job = await manager.start({
        project: current,
        screenId,
        brief: "",
        requestId: randomUUID(),
        expectedLatestId,
      });
      await finish(manager);
      return job;
    };
    const home = await start("home");
    assert.deepEqual(inputs[0], []);
    current = projectSchema.parse({
      ...current,
      designDraftApprovals: {
        revision: getSpecification(current).revision,
        assetIds: [home.id],
      },
    });
    const settings = await start("settings");
    assert.deepEqual(
      inputs[1]!.map((reference) => reference.assetId),
      [home.id],
    );
    assert.deepEqual(inputs[1]![0]!.png, png);
    current = projectSchema.parse({
      ...current,
      designDraftApprovals: {
        ...current.designDraftApprovals,
        assetIds: [home.id, settings.id],
      },
    });
    const register = await start("register");
    assert.deepEqual(
      inputs[2]!.map((reference) => reference.assetId),
      [home.id, settings.id],
    );
    assert.deepEqual(register.referenceAssetIds, [home.id, settings.id]);
    const saved = JSON.parse(
      await readFile(
        path.join(root, "workspace/design-images", register.id + ".json"),
        "utf8",
      ),
    );
    assert.deepEqual(saved.referenceAssetIds, [home.id, settings.id]);
    assert.deepEqual(
      approvedDesignReferences(current, manager.list(current.id), "home").map(
        (reference) => reference.id,
      ),
      [settings.id],
    );
    // Regenerating settings makes its old approval stale until its new image is approved.
    const revisedSettings = await start("settings", settings.id);
    assert.deepEqual(revisedSettings.referenceAssetIds, [home.id]);
    const secondRegister = await start("register", register.id);
    assert.deepEqual(secondRegister.referenceAssetIds, [home.id]);
    const calls = inputs.length;
    await unlink(path.join(root, "workspace/design-images", home.id + ".png"));
    await assert.rejects(
      start("register", secondRegister.id),
      /PNG dosyası eksik/,
    );
    assert.equal(inputs.length, calls);
    assert.equal(manager.busy, false);
    assert.deepEqual(
      approvedDesignReferences(
        {
          ...current,
          specification: { ...getSpecification(current), revision: 1 },
        },
        manager.list(current.id),
      ),
      [],
    );
    await assert.rejects(
      manager.start({
        project: {
          ...current,
          designDraftApprovals: { revision: 0, assetIds: [randomUUID()] },
        },
        screenId: "home",
        brief: "",
        requestId: randomUUID(),
        expectedLatestId: home.id,
      }),
      /Onaylı tasarım referansı bulunamadı/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("image requests are idempotent; history, costs and latest approval are enforced without a retry cap", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "design-test-"));
  try {
    let calls = 0;
    const m = new DesignImageManager(
      root,
      () => 0.02,
      "test",
      async () => {
        calls++;
        return { png: Buffer.from("fixture"), costUsd: 0.04 };
      },
    );
    await m.initialize();
    const request = {
      project,
      screenId: "home",
      brief: "Özgün",
      requestId: randomUUID(),
      expectedLatestId: null,
    };
    const first = await m.start(request);
    await finish(m);
    await m.start(request);
    assert.equal(calls, 1);
    assert.throws(() => approveImageDesign(project, m.list(project.id), []));
    const approved = approveImageDesign(project, m.list(project.id), [
      first.id,
    ]);
    assert.equal(approved.stage, "development");
    assert.equal(approved.specification?.revision, 1);
    assert.equal(approved.designReview?.images?.[0]?.assetId, first.id);
    const next = await m.start({
      ...request,
      requestId: randomUUID(),
      expectedLatestId: first.id,
    });
    await finish(m);
    assert.throws(() =>
      approveImageDesign(project, m.list(project.id), [first.id]),
    );
    await assert.rejects(
      m.start({
        ...request,
        requestId: randomUUID(),
        expectedLatestId: first.id,
      }),
      /güncellendi/,
    );
    await m.start({
      ...request,
      requestId: randomUUID(),
      expectedLatestId: next.id,
    });
    await finish(m);
    await m.start({
      ...request,
      requestId: randomUUID(),
      expectedLatestId: m.list(project.id).at(-1)!.id,
    });
    await finish(m);
    assert.equal(calls, 4);
    assert.equal(m.list(project.id).length, 4);
    assert.ok(Math.abs(m.totalCost(project.id) - 0.18) < 1e-9);
    assert.equal(
      (
        await readFile(root + "/workspace/design-images/" + first.id + ".png")
      ).toString(),
      "fixture",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("insufficient project budget prevents requests; interrupted generation keeps its reservation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "design-budget-"));
  try {
    const m = new DesignImageManager(
      root,
      () => 0.9,
      "test",
      () => new Promise(() => {}),
    );
    await m.initialize();
    const request = {
      project,
      screenId: "home",
      brief: "",
      requestId: randomUUID(),
      expectedLatestId: null,
    };
    await assert.rejects(m.start(request), /bütçesi/);
    await m.start({ ...request, project: { ...project, budgetLimit: 2 } });
    const restarted = new DesignImageManager(root);
    await restarted.initialize();
    assert.equal(restarted.list(project.id)[0]?.status, "failed");
    assert.equal(restarted.list(project.id)[0]?.uncertainCostUsd, 0.2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
