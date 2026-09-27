import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProjectSync,
  type PendingProject,
  type ProjectRepository,
} from "./project-sync";
type Doc = { id: string; title: string };
function repository() {
  const rows = new Map<string, { document: Doc; version: number }>();
  const repo: ProjectRepository<Doc> = {
    async list() {
      return structuredClone([...rows.values()]);
    },
    async save(document, version) {
      if ((rows.get(document.id)?.version ?? 0) !== version)
        throw new Error("conflict");
      const saved = { document, version: version + 1 };
      rows.set(document.id, saved);
      return saved;
    },
  };
  return { repo, rows };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("deletion fences writes, retains the card on failure, and retries before forgetting pending data", async () => {
  const { repo, rows } = repository();
  const doc = { id: "one", title: "delete me" };
  rows.set("one", { document: doc, version: 1 });
  rows.set("two", { document: { id: "two", title: "keep" }, version: 1 });
  const steps: string[] = [];
  repo.deleteProject = async (document, finish) => {
    steps.push(finish ? "finish" : "prepare");
    if (finish) rows.delete(document.id);
  };
  let visible: Doc[] = [];
  const sync = new ProjectSync(
    repo,
    [],
    () => {},
    (projects) => {
      visible = projects;
    },
  );
  await sync.refresh();
  await assert.rejects(
    sync.deleteProject(doc, async () => {
      throw new Error("GitHub denied");
    }),
    /GitHub denied/,
  );
  assert.equal(visible.length, 2);
  assert.deepEqual(steps, ["prepare"]);
  await sync.deleteProject(doc, async () => {
    steps.push("cleanup");
    assert.throws(() => sync.enqueue([doc]), /silme/);
  });
  assert.deepEqual(steps, ["prepare", "prepare", "cleanup", "finish"]);
  sync.enqueue([doc]);
  await settle();
  assert.deepEqual(
    visible.map((item) => item.id),
    ["two"],
  );
  assert.equal(rows.has("one"), false);
});

test("completed remote deletion drops an offline outbox before it can be uploaded", async () => {
  const { repo } = repository();
  repo.deletedIds = async () => ["one"];
  let saves = 0;
  repo.save = async () => {
    saves++;
    throw new Error("must not upload");
  };
  let pending: PendingProject<Doc>[] = [];
  let visible: Doc[] = [];
  const sync = new ProjectSync(
    repo,
    [{ document: { id: "one", title: "stale" }, expectedVersion: 0 }],
    (items) => {
      pending = items;
    },
    (items) => {
      visible = items;
    },
  );
  await sync.refresh();
  assert.equal(saves, 0);
  assert.deepEqual(pending, []);
  assert.deepEqual(visible, []);
});
test("periodic refresh retains loaded projects without returning to the initial loading state", async () => {
  const { repo, rows } = repository();
  const document = { id: "one", title: "initial" };
  rows.set(document.id, { document, version: 1 });
  const events: { projects: Doc[]; status: string; progress?: number }[] = [];
  const sync = new ProjectSync(
    repo,
    [],
    () => {},
    (projects, status, _error, progress) =>
      events.push({ projects, status, progress }),
  );
  await sync.refresh();
  assert.equal(events[0]?.status, "loading");
  events.length = 0;
  let release!: () => void;
  const list = repo.list;
  repo.list = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return list();
  };
  rows.set(document.id, {
    document: { ...document, title: "updated remotely" },
    version: 2,
  });
  const refreshing = sync.refresh();
  assert.deepEqual(events, [
    { projects: [document], status: "refreshing", progress: 0 },
  ]);
  release();
  await refreshing;
  assert.equal(events.at(-1)?.projects[0]?.title, "updated remotely");
  assert.equal(events.at(-1)?.status, "synced");
  assert.ok(events.every((event) => event.status !== "loading"));
  repo.list = async () => {
    throw new Error("offline");
  };
  events.length = 0;
  await sync.refresh();
  assert.deepEqual(
    events.map((event) => event.status),
    ["refreshing", "error"],
  );
  assert.equal(events.at(-1)?.projects[0]?.title, "updated remotely");
});

test("refresh reports completed records and clears progress on a failed save", async () => {
  const { repo } = repository();
  const events: { status: string; progress?: number }[] = [];
  const sync = new ProjectSync(
    repo,
    ["one", "two"].map((id) => ({
      document: { id, title: id },
      expectedVersion: 0,
    })),
    () => {},
    (_docs, status, _error, progress) => events.push({ status, progress }),
  );
  await sync.refresh();
  assert.deepEqual(events, [
    { status: "loading", progress: 0 },
    { status: "saving", progress: 33 },
    { status: "saving", progress: 67 },
    { status: "synced", progress: 100 },
  ]);
  repo.save = async () => {
    throw new Error("offline");
  };
  sync.enqueue([{ id: "three", title: "three" }]);
  await settle();
  assert.deepEqual(events.at(-1), { status: "error", progress: undefined });
});

test("local import counts only changed records", async () => {
  const { repo, rows } = repository();
  const existing = { id: "existing", title: "saved" };
  rows.set(existing.id, { document: existing, version: 1 });
  const events: { status: string; progress?: number }[] = [];
  const sync = new ProjectSync(
    repo,
    [],
    () => {},
    (_docs, status, _error, progress) => events.push({ status, progress }),
  );
  await sync.refresh();
  events.length = 0;
  sync.enqueue([
    existing,
    { id: "one", title: "one" },
    { id: "two", title: "two" },
  ]);
  await settle();
  assert.deepEqual(events, [
    { status: "saving", progress: 0 },
    { status: "saving", progress: 50 },
    { status: "synced", progress: 100 },
  ]);
});

test("importing an already synchronized project leaves the saved status intact", async () => {
  const { repo, rows } = repository();
  const document = { id: "one", title: "same" };
  rows.set(document.id, { document, version: 1 });
  let status = "";
  const sync = new ProjectSync(
    repo,
    [],
    () => {},
    (_docs, next) => {
      status = next;
    },
  );
  await sync.refresh();
  sync.enqueue([document]);
  await settle();
  assert.equal(status, "synced");
  assert.equal(rows.get("one")?.version, 1);
});
test("two devices load the same cloud project and stale edits cannot overwrite it", async () => {
  const { repo, rows } = repository();
  rows.set("one", { document: { id: "one", title: "base" }, version: 1 });
  let error = "";
  let pending: PendingProject<Doc>[] = [];
  const a = new ProjectSync(
    repo,
    [],
    () => {},
    () => {},
  );
  const b = new ProjectSync(
    repo,
    [],
    (value) => {
      pending = value;
    },
    (_docs, _status, message) => {
      error = message ?? "";
    },
  );
  await a.refresh();
  await b.refresh();
  a.enqueue([{ id: "one", title: "device A" }]);
  await settle();
  b.enqueue([{ id: "one", title: "device B" }]);
  await settle();
  assert.equal(rows.get("one")?.document.title, "device A");
  assert.equal(error, "conflict");
  assert.equal(pending[0]?.document.title, "device B");
});
test("failed network saves survive reload in the durable outbox", async () => {
  const { repo, rows } = repository();
  let offline = true;
  const network: ProjectRepository<Doc> = {
    ...repo,
    async save(doc, version) {
      if (offline) throw new Error("offline");
      return repo.save(doc, version);
    },
  };
  let pending: PendingProject<Doc>[] = [];
  const first = new ProjectSync(
    network,
    [],
    (value) => {
      pending = structuredClone(value);
    },
    () => {},
  );
  await first.refresh();
  first.enqueue([{ id: "one", title: "draft" }]);
  await settle();
  assert.equal(pending.length, 1);
  first.stop();
  offline = false;
  const reloaded = new ProjectSync(
    network,
    pending,
    (value) => {
      pending = value;
    },
    () => {},
  );
  await reloaded.refresh();
  assert.equal(rows.get("one")?.document.title, "draft");
  assert.equal(pending.length, 0);
});
test("an edit during an in-flight save uses the returned version for the next save", async () => {
  const { repo, rows } = repository();
  let release!: () => void;
  let first = true;
  const network: ProjectRepository<Doc> = {
    ...repo,
    async save(doc, version) {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return repo.save(doc, version);
    },
  };
  const sync = new ProjectSync(
    network,
    [],
    () => {},
    () => {},
  );
  await sync.refresh();
  sync.enqueue([{ id: "one", title: "first" }]);
  sync.enqueue([{ id: "one", title: "second" }]);
  release();
  await settle();
  assert.equal(rows.get("one")?.document.title, "second");
  assert.equal(rows.get("one")?.version, 2);
});
test("storage failure prevents upload and stopped account does not publish late responses", async () => {
  const { repo, rows } = repository();
  const broken = new ProjectSync(
    repo,
    [],
    () => {
      throw new Error("quota");
    },
    () => {},
  );
  await broken.refresh();
  assert.throws(() => broken.enqueue([{ id: "one", title: "lost" }]), /quota/);
  assert.equal(rows.size, 0);
  let release!: () => void;
  let notifications = 0;
  const slow: ProjectRepository<Doc> = {
    ...repo,
    async list() {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [];
    },
  };
  const sync = new ProjectSync(
    slow,
    [],
    () => {},
    () => {
      notifications++;
    },
  );
  const loading = sync.refresh();
  assert.equal(notifications, 1); // Initial loading notification precedes stop.
  sync.stop();
  release();
  await loading;
  assert.equal(notifications, 1);
});
