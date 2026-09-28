import { test } from "node:test";
import assert from "node:assert/strict";
import { runBuilder } from "./builder";
import { PlannerError } from "./index";
const input = { context: '{"task":"BUILD_SCREEN"}', image: Buffer.from("png") };
test("manual model selection sets compatible request options and model-specific cost", async () => {
  await assert.rejects(
    runBuilder(
      { ...input, model: "gpt-4.1-mini" },
      "test",
      async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, "gpt-4.1-mini");
        assert.equal(body.reasoning, undefined);
        return Response.json({
          status: "completed",
          usage: { input_tokens: 1000, output_tokens: 1000 },
          output: [],
        });
      },
    ),
    (error: unknown) =>
      error instanceof PlannerError && error.costUsd === 0.002,
  );
});
test("Builder sends one image and bounded task context, validates output and accounts usage", async () => {
  const result = await runBuilder(input, "test", async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.model, "gpt-6-luna");
    assert.equal(body.reasoning.effort, "medium");
    assert.equal(body.service_tier, "default");
    assert.equal(body.input[0].content[1].type, "input_image");
    assert.equal(body.input[0].content[0].text, input.context);
    return Response.json({
      status: "completed",
      usage: { input_tokens: 1000, output_tokens: 1000 },
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                code: "export default () => null;",
                summary: "Ekran",
                limitations: [],
              }),
            },
          ],
        },
      ],
    });
  });
  assert.equal(result.costUsd, 0.0006);
  await assert.rejects(
    runBuilder({ ...input, context: "a".repeat(80001) }, "test"),
    (e: unknown) => e instanceof PlannerError && e.costUsd === 0,
  );
  await assert.rejects(
    runBuilder(input, "test", async () =>
      Response.json({
        status: "completed",
        usage: { input_tokens: 1000, output_tokens: 1000 },
        output: [],
      }),
    ),
    (e: unknown) => e instanceof PlannerError && e.costUsd === 0.0006,
  );
});

test("text-only revision keeps structured output without an image payload", async () => {
  await runBuilder(
    { context: '{"task":"REVISE_SCREEN","changeRequest":"Kartları küçült"}' },
    "test",
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.input[0].content.length, 1);
      assert.equal(body.text.format.strict, true);
      assert.equal(body.max_output_tokens, 16000);
      assert.equal(body.reasoning.effort, "low");
      assert.match(body.instructions, /REVISE_SCREEN/);
      return Response.json({
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 10 },
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  code: "export default () => null;",
                  summary: "Güncellendi",
                  limitations: [],
                }),
              },
            ],
          },
        ],
      });
    },
  );
});

test("incomplete model output reports a token-limit error with usage cost", async () => {
  await assert.rejects(
    runBuilder(input, "test", async () =>
      Response.json({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 1000, output_tokens: 10000 },
        output: [],
      }),
    ),
    (error: unknown) =>
      error instanceof PlannerError &&
      error.message.includes("token") &&
      error.costUsd === 0.0051,
  );
});
