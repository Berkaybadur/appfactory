import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deletedProjectIds,
  forgetBrowserProject,
  PROJECTS_KEY as key,
} from "./project-storage";
test("browser cleanup removes project copies and outbox backups without losing unrelated data", () => {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  } satisfies Storage;
  storage.setItem(
    key,
    JSON.stringify({ version: 1, projects: [{ id: "one" }, { id: "two" }] }),
  );
  storage.setItem(
    key + ".outbox.user.tab.backup",
    JSON.stringify([{ document: { id: "one" } }, { document: { id: "two" } }]),
  );
  storage.setItem("unrelated", "keep");
  forgetBrowserProject(storage, "one");
  assert.deepEqual(JSON.parse(storage.getItem(key)!).projects, [{ id: "two" }]);
  assert.deepEqual(
    JSON.parse(storage.getItem(key + ".outbox.user.tab.backup")!),
    [{ document: { id: "two" } }],
  );
  assert.equal(storage.getItem("unrelated"), "keep");
  assert.equal(deletedProjectIds(storage).has("one"), true);
});
