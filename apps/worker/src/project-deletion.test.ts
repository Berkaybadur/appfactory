import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectDeletion } from "./project-deletion";

const source = "11111111-1111-4111-8111-111111111111";
const old = "22222222-2222-4222-8222-222222222222";
const asset = "33333333-3333-4333-8333-333333333333";
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "factory-delete-test-"));
  const put = async (name: string, value: unknown = "content") => {
    const file = path.join(root, "workspace", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  await put(`generated-projects/one/${source}/app.tsx`);
  await put(`generated-projects/two/${source}/app.tsx`, "keep");
  await put("jobs/one.json", { id: source, projectId: "one" });
  await put(`jobs/history/one/${old}.json`, { id: old, projectId: "one" });
  await put("planner/one.json", { projectId: "one" });
  await put("planner/two.json", { projectId: "two" });
  await put(`builder/${source}.json`, { id: source, project: { id: "one" } });
  await put(`builder/${source}-features-1.txt`);
  await put(`design-images/${asset}.json`, { id: asset, projectId: "one" });
  await put(`design-images/${asset}.png`);
  await put(`github/${old}.json`, { sha: "old" });
  await put("github/one-head.json", { sha: "head" });
  await put(`previews/${source}.json`, {
    projectId: "one",
    sourceJobId: source,
  });
  await put(`release/${old}.json`, { items: [] });
  await put(`smoke/${asset}.json`, { projectId: "one" });
  await put(`smoke/${asset}/0.png`);
  await put(`eas/jobs/${source}.json`, { id: source, projectId: "one" });
  await put("eas/links/one.json", { projectId: "one" });
  return { root, put, deletion: new ProjectDeletion(root) };
}
test("deletion removes all owned artifacts and history, preserving other projects", async () => {
  const { root, deletion } = await fixture();
  try {
    const targets = await deletion.plan("one");
    let calls = 0;
    await deletion.run("one", async () => {
      calls++;
      await access(path.join(root, "workspace/jobs/one.json"));
    });
    assert.equal(calls, 1);
    for (const target of targets)
      await assert.rejects(access(path.join(root, "workspace", target)), {
        code: "ENOENT",
      });
    assert.equal(
      await readFile(
        path.join(root, `workspace/generated-projects/two/${source}/app.tsx`),
        "utf8",
      ),
      "keep",
    );
    await access(path.join(root, "workspace/planner/two.json"));
    const restarted = new ProjectDeletion(root);
    await restarted.initialize();
    assert.throws(() => restarted.assertAvailable("one"), /siliniyor/);
    restarted.assertAvailable("two");
    await restarted.run("one", async () => {
      assert.fail("Successful GitHub deletion must not be sent again");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("remote failure preserves files and durable journal resumes after metadata loss", async () => {
  const { root, deletion } = await fixture();
  try {
    await assert.rejects(
      deletion.run("one", async () => {
        throw new Error("403");
      }),
      /403/,
    );
    await access(path.join(root, `workspace/design-images/${asset}.png`));
    assert.equal(deletion.busy, false);
    // Simulate an interrupted cleanup that removed job JSON before its PNG.
    await rm(path.join(root, `workspace/design-images/${asset}.json`));
    const restarted = new ProjectDeletion(root);
    await restarted.initialize();
    await restarted.run("one", async () => {});
    await assert.rejects(
      access(path.join(root, `workspace/design-images/${asset}.png`)),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("deletion rejects traversal and symlinked project directories before remote deletion", async () => {
  const { root, deletion } = await fixture();
  try {
    await assert.rejects(deletion.plan("../two"));
    const target = path.join(root, "workspace/generated-projects/linked");
    await symlink(
      path.join(root, "workspace/generated-projects/two"),
      target,
      "junction",
    );
    let calls = 0;
    await assert.rejects(
      deletion.run("linked", async () => {
        calls++;
      }),
      /sembolik/,
    );
    assert.equal(calls, 0);
    await access(
      path.join(root, `workspace/generated-projects/two/${source}/app.tsx`),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
