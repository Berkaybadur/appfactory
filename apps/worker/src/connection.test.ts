import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Project } from "@app-factory/schemas";
import { appConnection } from "./connection";

const project: Project = {
  id: "connection-test",
  name: "Bağlantı",
  idea: "Paylaşılan park yerleri uygulaması.",
  type: "mobile",
  android: true,
  ios: false,
  budgetLimit: 2,
  aiCost: 0,
  stage: "build",
  updatedAt: new Date().toISOString(),
};

test("connection is read and written only inside the selected output with publishable keys", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "connection-")),
  );
  try {
    const id = randomUUID();
    const outputPath = path.join(
      "workspace/generated-projects",
      project.id,
      id,
    );
    const runtime = path.join(root, outputPath, "src/runtime");
    await mkdir(runtime, { recursive: true });
    const file = path.join(runtime, "connection.json");
    await writeFile(file, '{ "url": "", "publishableKey": "" }\n');
    const resolve = () => ({ id, project, outputPath });
    const request = { project, sourceJobId: id };
    assert.deepEqual(await appConnection(root, resolve, request), {
      available: true,
      connection: { url: "", publishableKey: "" },
    });
    const connection = {
      url: "https://abcd.supabase.co",
      publishableKey: "sb_publishable_abcdefghijklmnop",
    };
    await appConnection(root, resolve, { ...request, connection });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), connection);
    assert.deepEqual(
      (await appConnection(root, resolve, request)).connection,
      connection,
    );
    for (const invalid of [
      { ...connection, publishableKey: "eyJhbGciOiJIUzI1NiJ9.service" },
      { ...connection, url: "http://abcd.supabase.co" },
      { ...connection, url: "" },
    ])
      await assert.rejects(
        appConnection(root, resolve, { ...request, connection: invalid }),
      );
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), connection);
    await assert.rejects(
      appConnection(
        root,
        () => ({ id, project, outputPath: "../outside" }),
        request,
      ),
      /yolu geçersiz/,
    );
    await rm(runtime, { recursive: true });
    assert.equal(
      (await appConnection(root, resolve, request)).available,
      false,
    );
    await assert.rejects(
      appConnection(root, resolve, { ...request, connection }),
      /backend bağlantısı kullanmıyor/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
