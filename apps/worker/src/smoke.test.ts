import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getSpecification,
  getScreens,
  type Project,
  type BuilderJob,
} from "@app-factory/schemas";
import { PlannerError, type runSmokeReviewer } from "@app-factory/ai";
import { SmokeManager } from "./smoke";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=",
  "base64",
);
const base: Project = {
  id: "smoke-test",
  name: "Smoke test",
  idea: "Yerel alışkanlık takibi için mobil uygulama.",
  type: "mobile",
  android: true,
  ios: true,
  stage: "tests",
  budgetLimit: 10,
  aiCost: 0,
  updatedAt: new Date().toISOString(),
};
async function fixture(review?: typeof runSmokeReviewer) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "smoke-test-")),
  );
  const id = randomUUID(),
    assetId = randomUUID();
  const outputPath = `workspace/generated-projects/${base.id}/${id}`;
  await mkdir(path.join(root, outputPath), { recursive: true });
  await writeFile(path.join(root, outputPath, "app.tsx"), "original");
  await mkdir(path.join(root, "workspace/design-images"), { recursive: true });
  await writeFile(
    path.join(root, "workspace/design-images", assetId + ".png"),
    png,
  );
  await writeFile(
    path.join(root, "workspace/design-images", assetId + ".json"),
    "{}",
  );
  const spec = getSpecification(base);
  const project: Project = {
    ...base,
    specification: {
      ...spec,
      screens: getScreens(spec).map((s) => ({
        ...s,
        enabled: s.id === "home",
      })),
    },
    designReview: {
      revision: spec.revision,
      screens: ["home"],
      images: [{ screenId: "home", assetId, sourceRevision: 0 }],
      reviewedAt: new Date().toISOString(),
    },
  };
  const requests: unknown[] = [];
  const resolve = () => ({ id, project, outputPath });
  const revise = async (input: unknown) => {
    requests.push(input);
    return { id: (input as { requestId: string }).requestId } as BuilderJob;
  };
  const reviewer: typeof runSmokeReviewer =
    review ??
    (async (input) => {
      assert.equal(input.images?.length, 2);
      return {
        output: {
          status: "passed",
          expected: "Onaylı tasarımla uyumlu",
          actual: "Görsel fark görülmedi.",
          action: "none",
          target: "",
          value: "",
        },
        costUsd: 0.01,
      };
    });
  const manager = new SmokeManager(
    root,
    resolve,
    revise,
    () => 0,
    "test-key",
    reviewer,
  );
  await manager.initialize();
  const act = (input: object) =>
    manager.act({ project, sourceJobId: id, ...input });
  const start = async (platform: "android" | "ios", phase = "design") => {
    const requestId = randomUUID();
    const state = await act({ action: "start", phase, platform, requestId });
    return state.reports.find((r) => r.id === requestId)!;
  };
  const completeDesign = async (platform: "android" | "ios") => {
    const report = await start(platform);
    const params = { reportId: report.id, fingerprint: report.fingerprint };
    await act({
      action: "capture",
      ...params,
      checkId: "0",
      pngBase64: png.toString("base64"),
    });
    await act({ action: "run", ...params });
    await finish(manager);
    return report;
  };
  return {
    root,
    project,
    id,
    outputPath,
    manager,
    act,
    start,
    completeDesign,
    requests,
    resolve,
    revise,
    reviewer,
  };
}
async function finish(m: SmokeManager) {
  for (let i = 0; i < 200; i++) {
    if (!m.busy) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Smoke timed out");
}
test("both Expo platforms require reviewed design before functional tests; results survive restart and code invalidates them", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.start("ios", "functional"), /tasarım/);
    const android = await f.completeDesign("android");
    assert.equal((await f.manager.info(f.project, f.id)).designApproved, false);
    await f.act({
      action: "approve",
      reportId: android.id,
      fingerprint: android.fingerprint,
    });
    await assert.rejects(f.start("android", "functional"), /tasarım/);
    const ios = await f.completeDesign("ios");
    await f.act({
      action: "approve",
      reportId: ios.id,
      fingerprint: ios.fingerprint,
    });
    assert.equal((await f.manager.info(f.project, f.id)).designApproved, true);
    for (const platform of ["android", "ios"] as const) {
      const report = await f.start(platform, "functional");
      const params = { reportId: report.id, fingerprint: report.fingerprint };
      await assert.rejects(f.act({ action: "run", ...params }), /Her kontrol/);
      for (const check of report.checks)
        await f.act({
          action: "capture",
          ...params,
          checkId: check.id,
          result: "passed",
          actual: "Cihazda beklenen sonucu gördüm.",
          steps: ["Ekranı açtım", "İşlemi yapıp sonucu kontrol ettim"],
        });
      await f.act({ action: "run", ...params });
      await f.act({ action: "approve", ...params });
    }
    await f.manager.assertReady(f.project, f.id);
    const restored = new SmokeManager(f.root, f.resolve, f.revise);
    await restored.initialize();
    await restored.assertReady(f.project, f.id);
    await writeFile(path.join(f.root, f.outputPath, "app.tsx"), "changed");
    await assert.rejects(restored.assertReady(f.project, f.id), /smoke/);
    await assert.rejects(
      f.act({
        action: "approve",
        reportId: ios.id,
        fingerprint: ios.fingerprint,
      }),
      /güncel/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("missing evidence and failed findings cannot pass; only explicit repair creates a revision and retries are idempotent", async () => {
  const f = await fixture(async () => ({
    output: {
      status: "failed",
      expected: "Başlık tasarımdaki boyutta olmalı.",
      actual: "Başlık taşıyor.",
      action: "none",
      target: "",
      value: "",
    },
    costUsd: 0.01,
  }));
  try {
    const missing = await f.start("ios");
    await assert.rejects(
      f.act({
        action: "run",
        reportId: missing.id,
        fingerprint: missing.fingerprint,
      }),
      /Her ekran/,
    );
    const report = await f.completeDesign("android");
    assert.equal(f.requests.length, 0);
    const params = { reportId: report.id, fingerprint: report.fingerprint };
    await assert.rejects(f.act({ action: "approve", ...params }), /Sorunlu/);
    await assert.rejects(
      f.act({
        action: "capture",
        ...params,
        checkId: "0",
        pngBase64: png.toString("base64"),
      }),
      /değiştirilemez/,
    );
    const requestId = randomUUID();
    await f.act({ action: "repair", ...params, requestId });
    assert.equal(report.repairJobId, requestId);
    assert.equal(f.requests.length, 1);
    await f.act({ action: "repair", ...params, requestId });
    assert.equal(f.requests.length, 1);
    assert.match(JSON.stringify(f.requests[0]), /Başlık taşıyor/);
    await assert.rejects(
      f.act({ action: "repair", ...params, requestId: randomUUID() }),
      /başlatıldı/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("reviewer failures retain uncertain spend and never produce success", async () => {
  const f = await fixture(async () => {
    throw new PlannerError("Bağlantı kesildi");
  });
  try {
    const report = await f.completeDesign("android");
    assert.equal(report.status, "failed");
    assert.equal(report.uncertainCostUsd, 0.08);
    assert.equal(report.reservedUsd, 0);
    assert.equal((await f.manager.info(f.project, f.id)).designApproved, false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("blocked screenshots and exhausted budget never produce approval", async () => {
  const f = await fixture(async () => ({
    output: {
      status: "blocked",
      expected: "Ana ekran görüntüsü gerekli.",
      actual: "Expo yükleme ekranı görünüyor.",
    },
    costUsd: 0.01,
  }));
  try {
    const report = await f.completeDesign("android");
    await assert.rejects(
      f.act({
        action: "approve",
        reportId: report.id,
        fingerprint: report.fingerprint,
      }),
      /Sorunlu/,
    );
    await assert.rejects(
      f.act({
        action: "repair",
        reportId: report.id,
        fingerprint: report.fingerprint,
        requestId: randomUUID(),
      }),
      /Düzeltilecek/,
    );
    f.project.budgetLimit = 0.01;
    const next = await f.completeDesign("ios");
    assert.equal(next.status, "failed");
    assert.match(next.error!, /bütçe/);
    assert.equal(next.costUsd, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("interrupted comparison is failed on restart and its reservation is retained", async () => {
  const f = await fixture();
  try {
    const report = await f.start("android");
    await writeFile(
      path.join(f.root, "workspace/smoke", report.id + ".json"),
      JSON.stringify({ ...report, status: "running", reservedUsd: 0.08 }),
    );
    const restarted = new SmokeManager(f.root, f.resolve, f.revise);
    await restarted.initialize();
    assert.equal(restarted.reports.get(report.id)?.status, "failed");
    assert.equal(restarted.reports.get(report.id)?.uncertainCostUsd, 0.08);
    await assert.rejects(restarted.assertReady(f.project, f.id), /smoke/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
