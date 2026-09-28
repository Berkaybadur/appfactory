import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, cp, writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  getSpecification,
  getScreens,
  type Project,
  type BuilderJob,
} from "@app-factory/schemas";
import { BuilderManager } from "./builder";
import {
  validateScreenCode,
  cleanScreenImports,
  validateRecordContract,
  validateRecordUsage,
} from "./builder-code";
import { PlannerError } from "@app-factory/ai";
const base: Project = {
  id: "builder-test",
  name: "Test",
  idea: "Yerel alışkanlık takibi için mobil uygulama.",
  type: "mobile",
  android: true,
  ios: false,
  budgetLimit: 2,
  aiCost: 0,
  stage: "development",
  updatedAt: new Date().toISOString(),
};
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "builder-test-"));
  await mkdir(path.join(root, "templates"));
  await cp(
    path.resolve("templates/expo-base"),
    path.join(root, "templates/expo-base"),
    { recursive: true },
  );
  await mkdir(path.join(root, "workspace/design-images"), { recursive: true });
  const screens = getScreens(getSpecification(base)).map((s) => ({
    ...s,
    enabled: s.id === "home" || s.id === "create",
  }));
  const images = [];
  for (const screen of screens.filter((s) => s.enabled)) {
    const id = randomUUID();
    images.push({ screenId: screen.id, assetId: id, sourceRevision: 0 });
    await writeFile(
      path.join(root, "workspace/design-images", id + ".png"),
      "test-image",
    );
    await writeFile(
      path.join(root, "workspace/design-images", id + ".json"),
      JSON.stringify({
        id,
        projectId: base.id,
        revision: 0,
        screenId: screen.id,
        screenName: screen.name,
        brief: "",
        status: "succeeded",
        costUsd: 0.02,
        reservedUsd: 0,
        uncertainCostUsd: 0,
        error: null,
        createdAt: new Date().toISOString(),
        model: "test",
      }),
    );
  }
  const project: Project = {
    ...base,
    specification: { ...getSpecification(base), revision: 1, screens },
    designReview: {
      revision: 1,
      screens: images.map((i) => i.screenId),
      images,
      reviewedAt: new Date().toISOString(),
    },
  };
  return { root, project };
}
async function finish(m: BuilderManager) {
  for (let i = 0; i < 300; i++) {
    if (!m.busy) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timeout");
}
const output = {
  code: 'import { useRecords } from "../src/records"; export default function Screen() { const {records} = useRecords(); return records.length; }',
  summary: "Ekran",
  limitations: [],
};
const command = async () => ({ exitCode: 0, output: "ok", durationMs: 1 });
test("Builder stops on failed checks, resumes only failed task and is idempotent", async () => {
  const { root, project } = await fixture();
  try {
    let calls = 0;
    let checks = 0;
    const m = new BuilderManager(
      root,
      () => 0.04,
      "test",
      async (input) => {
        calls++;
        return {
          output: {
            ...output,
            code: JSON.parse(input.context).currentCode + "\n// candidate",
          },
          costUsd: 0.01,
        };
      },
      async () => {
        checks++;
        return { ...(await command()), exitCode: checks === 4 ? 1 : 0 };
      },
    );
    await m.initialize();
    const job = await m.start(project, false, "screens");
    await finish(m);
    assert.equal(job.status, "failed");
    assert.equal(job.tasks[0]?.status, "ready");
    assert.equal(calls, 2);
    assert.equal(
      await readFile(path.join(root, job.outputPath, "app/create.tsx"), "utf8"),
      await readFile("templates/expo-base/app/create.tsx", "utf8"),
    );
    await m.start(project, false, "screens");
    assert.equal(calls, 2);
    await m.start(project, true, "screens");
    await finish(m);
    assert.equal(job.status, "ready");
    assert.equal(calls, 3);
    assert.equal(job.tasks[0]?.attempts, 1);
    assert.equal(job.tasks[1]?.attempts, 2);
    await m.start(project, true, "screens");
    assert.equal(calls, 3);
    assert.ok(Math.abs(m.totalCost(project.id) - 0.07) < 1e-8);
    const restarted = new BuilderManager(root);
    await restarted.initialize();
    assert.equal(restarted.list(project.id)[0]?.status, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Builder enforces approval and shared budget; manual retries are not capped", async () => {
  const { root, project } = await fixture();
  try {
    const m = new BuilderManager(
      root,
      () => 0,
      "test",
      async () => {
        throw new PlannerError("bad", 0);
      },
      command,
    );
    await m.initialize();
    await assert.rejects(
      m.start({ ...project, designReview: undefined }, false, "screens"),
      /onaylayın/,
    );
    await assert.rejects(
      m.start({ ...project, budgetLimit: 0.01 }, false, "screens"),
      /bütçesi/,
    );
    await m.start(project, false, "screens");
    await finish(m);
    await m.start(project, true, "screens");
    await finish(m);
    await m.start(project, true, "screens");
    await finish(m);
    await m.start(project, true, "screens");
    await finish(m);
    assert.equal(m.list(project.id)[0]?.tasks[0]?.attempts, 4);
    await assert.rejects(
      m.start({ ...project, aiCost: 1.99 }, true, "screens"),
      /bütçesi/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("restart retains in-flight reservation and marks task failed", async () => {
  const { root, project } = await fixture();
  try {
    const id = randomUUID();
    await mkdir(path.join(root, "workspace/builder"));
    const job: BuilderJob = {
      id,
      project,
      status: "running",
      outputPath: "",
      setupAttempts: 1,
      installed: false,
      setupLog: "",
      error: null,
      createdAt: new Date().toISOString(),
      tasks: [
        {
          screenId: "home",
          name: "Ana ekran",
          status: "running",
          attempts: 1,
          costUsd: 0,
          reservedUsd: 0.08,
          uncertainCostUsd: 0,
          summary: "",
          limitations: [],
          log: "",
        },
      ],
    };
    await writeFile(
      path.join(root, "workspace/builder", id + ".json"),
      JSON.stringify(job),
    );
    const m = new BuilderManager(root);
    await m.initialize();
    assert.equal(m.jobs.get(id)?.tasks[0]?.uncertainCostUsd, 0.08);
    assert.equal(m.jobs.get(id)?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("screen scope rejects imports, dynamic execution and check suppression", () => {
  validateScreenCode(
    'import {Text} from "react-native"; export default function Screen(){return <Text>Merhaba</Text>}',
    "app/index.tsx",
  );
  for (const code of [
    'import fs from "node:fs"; export default fs;',
    'export default () => import("evil");',
    'export default () => fetch("https://example.com");',
    "// @ts-nocheck\nexport default () => null;",
  ])
    assert.throws(() => validateScreenCode(code, "app/index.tsx"));
});

test("compiler removes unused imports but preserves used hooks and JSX imports", () => {
  const source =
    'import { Text, Image } from "react-native"; import { useRecords } from "../src/records"; export default function Screen(){ const {records} = useRecords(); return <Text>{records.length}</Text>; }';
  const cleaned = cleanScreenImports(source, "app/index.tsx");
  assert.ok(!cleaned.includes("Image"));
  assert.ok(cleaned.includes("Text"));
  validateRecordContract(cleaned, "app/index.tsx");
  assert.throws(
    () =>
      validateRecordContract(
        "export default function Screen(){ return null; }",
        "app/index.tsx",
      ),
    /yerel kayıt/,
  );
  assert.throws(
    () =>
      validateRecordContract(
        'import {useRecords} from "../src/records"; export default function Screen(){return null;}',
        "app/index.tsx",
      ),
    /yerel kayıt/,
  );
});

test("all template screens preserve their required record fields; an unused hook is rejected", async () => {
  for (const file of [
    "app/index.tsx",
    "app/create.tsx",
    "app/items/[id].tsx",
    "app/settings.tsx",
    "app/register.tsx",
  ]) {
    validateRecordUsage(
      await readFile(path.join("templates/expo-base", file), "utf8"),
      file,
    );
  }
  assert.throws(
    () =>
      validateRecordUsage(
        'import {useRecords} from "../src/records"; export default function Home(){const {records,ready,error}=useRecords(); return <Text>Sabit kitaplar</Text>;}',
        "app/index.tsx",
      ),
    /kullanılmıyor/,
  );
  assert.throws(
    () =>
      validateScreenCode(
        'import {Image} from "react-native"; export default function Home(){return <Image source={{uri:"https://example.com/a.png"}}/>;}',
        "app/index.tsx",
      ),
    /Image/,
  );
});

test("screen revision clones the working output, changes one screen and deduplicates submissions", async () => {
  const { root, project } = await fixture();
  try {
    const { generateProject } = await import("@app-factory/generator");
    const sourceId = randomUUID();
    const source = await generateProject(root, project, sourceId);
    await rm(path.join(root, source.outputPath, "design-references"), {
      recursive: true,
      force: true,
    });
    const original = await readFile(
      path.join(root, source.outputPath, "app/index.tsx"),
      "utf8",
    );
    let calls = 0;
    const m = new BuilderManager(
      root,
      () => 0,
      "test",
      async (input) => {
        calls++;
        const context = JSON.parse(input.context);
        assert.equal(context.task, "REVISE_SCREEN");
        assert.equal(context.changeRequest, "Başlığı daha belirgin yap.");
        assert.equal(input.image, undefined);
        return {
          output: { ...output, code: context.currentCode + "\n// revised" },
          costUsd: 0.01,
        };
      },
      command,
    );
    await m.initialize();
    const req = {
      project,
      requestId: randomUUID(),
      change: {
        sourceJobId: sourceId,
        screenId: "home",
        instruction: "Başlığı daha belirgin yap.",
      },
    };
    const resolve = () => ({
      id: sourceId,
      project,
      outputPath: source.outputPath,
    });
    const job = await m.revise(req, resolve);
    await m.revise(req, resolve);
    await finish(m);
    assert.equal(job.status, "ready");
    assert.equal(calls, 1);
    assert.equal(job.tasks.length, 1);
    assert.equal(
      await readFile(
        path.join(root, source.outputPath, "app/index.tsx"),
        "utf8",
      ),
      original,
    );
    assert.match(
      await readFile(path.join(root, job.outputPath, "app/index.tsx"), "utf8"),
      /revised/,
    );
    assert.equal(
      await readFile(path.join(root, job.outputPath, "app/create.tsx"), "utf8"),
      await readFile(
        path.join(root, source.outputPath, "app/create.tsx"),
        "utf8",
      ),
    );
    await assert.rejects(
      m.revise(
        { ...req, change: { ...req.change, instruction: "Başka talep" } },
        resolve,
      ),
      /kimliği başka/,
    );
    await assert.rejects(
      m.revise({ ...req, requestId: sourceId }, resolve),
      /yeni bir çıktı/,
    );
    const restored = new BuilderManager(root);
    await restored.initialize();
    assert.equal(restored.jobs.get(job.id)?.change?.sourceJobId, sourceId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("revision failed validation restores code and allows further manual retries", async () => {
  const { root, project } = await fixture();
  try {
    const { generateProject } = await import("@app-factory/generator");
    const sourceId = randomUUID();
    const source = await generateProject(root, project, sourceId);
    const original = await readFile(
      path.join(root, source.outputPath, "app/index.tsx"),
      "utf8",
    );
    let calls = 0;
    const inputs: { rejectedCode?: string; model?: string }[] = [];
    const m = new BuilderManager(
      root,
      () => 0,
      "test",
      async (input) => {
        calls++;
        const parsed = JSON.parse(input.context);
        inputs.push({
          rejectedCode: parsed.rejectedCode,
          model: input.model,
        });
        assert.equal(parsed.previousDiagnostics, undefined);
        assert.equal(parsed.rejectedCode, undefined);
        assert.equal(parsed.projectMemory?.tasks, undefined);
        return {
          output: {
            ...output,
            code: JSON.parse(input.context).currentCode + "\n// rejected",
          },
          costUsd: 0.01,
        };
      },
      async (_cmd, args) => ({
        ...(await command()),
        exitCode: args.includes("--noEmit") ? 1 : 0,
      }),
    );
    await m.initialize();
    const req = {
      project,
      requestId: randomUUID(),
      change: {
        sourceJobId: sourceId,
        screenId: "home",
        instruction: "Kartları küçült.",
      },
    };
    const resolve = () => ({
      id: sourceId,
      project,
      outputPath: source.outputPath,
    });
    const job = await m.revise(req, resolve);
    await finish(m);
    assert.equal(job.status, "failed");
    assert.equal(
      await readFile(path.join(root, job.outputPath, "app/index.tsx"), "utf8"),
      original,
    );
    for (let i = 0; i < 3; i++) {
      await m.revise(
        { ...req, retry: true, ...(i === 2 ? { model: "gpt-5-mini" } : {}) },
        resolve,
      );
      await finish(m);
    }
    assert.equal(calls, 4);
    assert.equal(inputs[3]?.model, "gpt-5-mini");
    assert.equal(job.tasks[0]?.attempts, 4);
    assert.ok(Math.abs((job.tasks[0]?.costUsd ?? 0) - 0.04) < 1e-9);
    assert.equal(
      await readFile(
        path.join(root, source.outputPath, "app/index.tsx"),
        "utf8",
      ),
      original,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
