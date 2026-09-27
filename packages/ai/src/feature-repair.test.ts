import { test } from "node:test";
import assert from "node:assert/strict";
import { runFeatureBuilder } from "./builder";
import { featureFiles, type FeatureOutput } from "@app-factory/schemas";
import { PlannerError } from "./index";
const previous: FeatureOutput = {
  files: featureFiles.map((path) => ({
    path,
    code: "export const value = 1;",
  })),
  summary: "Önceki aday",
  limitations: [],
  capabilities: ["storage"],
  migrationSql: "",
  setup: [],
  coverage: [
    { requirement: "Kayıt", status: "implemented", detail: "Yerel kayıt" },
  ],
  tests: [1, 2, 3].map((n) => ({
    name: `test-${n}`,
    exportName: "value",
    argsJson: "[]",
    expectedJson: "1",
  })),
};
const response = (output: unknown) =>
  Response.json({
    status: "completed",
    usage: { input_tokens: 1000, output_tokens: 1000 },
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(output) }],
      },
    ],
  });
test("features default to GPT-5 mini and retain bounded cost accounting", async () => {
  const result = await runFeatureBuilder(
    { context: '{"task":"BUILD_APPLICATION_FEATURES"}' },
    "test",
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "gpt-5-mini");
      assert.equal(body.reasoning.effort, "medium");
      assert.equal(body.max_output_tokens, 16000);
      return response(previous);
    },
  );
  assert.equal(result.costUsd, 0.00225);
});
test("targeted repair merges only changed files and retains SQL, tests and other contracts", async () => {
  const result = await runFeatureBuilder(
    {
      context: JSON.stringify({
        task: "REPAIR_APPLICATION_FEATURES",
        previousCandidate: previous,
        previousDiagnostics: "TS2532",
      }),
    },
    "test",
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.max_output_tokens, 10000);
      assert.ok(body.text.format.schema.required.includes("migrationSql"));
      return response({
        summary: "Dizin erişimi düzeltildi",
        files: [
          { path: "src/features/domain.ts", code: "export const value = 2;" },
        ],
        migrationSql: null,
      });
    },
  );
  assert.equal(
    result.output.files.find((f) => f.path.endsWith("domain.ts"))?.code,
    "export const value = 2;",
  );
  assert.equal(result.output.files[0]?.code, previous.files[0]?.code);
  assert.deepEqual(result.output.tests, previous.tests);
  assert.equal(result.output.migrationSql, previous.migrationSql);
  assert.deepEqual(result.output.coverage, previous.coverage);
  await assert.rejects(
    runFeatureBuilder(
      { context: JSON.stringify({ previousCandidate: previous }) },
      "test",
      async () =>
        response({
          summary: "bad",
          files: [{ path: "tsconfig.json", code: "disable strict" }],
          migrationSql: null,
        }),
    ),
    (e: unknown) => e instanceof PlannerError && e.costUsd === 0.00225,
  );
  await assert.rejects(
    runFeatureBuilder(
      { context: JSON.stringify({ previousCandidate: previous }) },
      "test",
      async () => response({ summary: "boş", files: [], migrationSql: null }),
    ),
    /değişiklik içermiyor/,
  );
});
test("repair can replace a rejected migration without touching feature files", async () => {
  const backend = {
    ...previous,
    capabilities: ["backend" as const],
    migrationSql: "create table if not exists public.spots (id uuid);",
  };
  const fixed =
    backend.migrationSql +
    "\nalter table public.spots enable row level security;";
  const result = await runFeatureBuilder(
    {
      context: JSON.stringify({
        previousCandidate: backend,
        previousDiagnostics: "Migration RLS içermeli",
      }),
    },
    "test",
    async () =>
      response({ summary: "RLS eklendi", files: [], migrationSql: fixed }),
  );
  assert.equal(result.output.migrationSql, fixed);
  assert.deepEqual(result.output.files, backend.files);
});
