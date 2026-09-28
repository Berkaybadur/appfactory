import { test } from "node:test";
import assert from "node:assert/strict";
import { runSmokeReviewer } from "./index";
test("Expo reviewer receives approved and actual screenshots in order and returns findings without editing code", async () => {
  const result = await runSmokeReviewer(
    {
      context: '{"platform":"ios","screenId":"home"}',
      images: [Buffer.from("approved"), Buffer.from("actual")],
    },
    "test-key",
    (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.store, false);
      assert.equal(
        body.input[0].content[1].image_url,
        "data:image/png;base64," + Buffer.from("approved").toString("base64"),
      );
      assert.equal(
        body.input[0].content[2].image_url,
        "data:image/png;base64," + Buffer.from("actual").toString("base64"),
      );
      assert.deepEqual(body.text.format.schema.properties.status.enum, [
        "passed",
        "failed",
        "blocked",
      ]);
      return Response.json({
        status: "completed",
        usage: { input_tokens: 1000, output_tokens: 100 },
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  status: "failed",
                  expected: "Başlık tek satır olmalı.",
                  actual: "Başlık iki satıra taşıyor.",
                }),
              },
            ],
          },
        ],
      });
    }) as typeof fetch,
  );
  assert.equal(result.output.status, "failed");
  assert.equal(result.costUsd, 0.00056);
});
