import { test } from "node:test";
import assert from "node:assert/strict";
import { designImagePrompt, generateDesignImage } from "./design-images";
import { PlannerError } from "./index";
import { type Project } from "@app-factory/schemas";
const project: Project = {
  id: "test",
  name: "Test",
  idea: "Alışkanlık takibi için mobil uygulama.",
  type: "mobile",
  android: true,
  ios: false,
  budgetLimit: 1,
  aiCost: 0,
  stage: "design",
  updatedAt: new Date().toISOString(),
};
test("image request is bounded, returns a PNG and accounts for tokens", async () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(1024, 16);
  png.writeUInt32BE(1536, 20);
  let calls = 0;
  const result = await generateDesignImage(
    designImagePrompt(project, "home", "Sıcak renkler"),
    "test",
    async (url, init) => {
      calls++;
      assert.equal(url, "https://api.openai.com/v1/images/generations");
      const body = JSON.parse(init?.body as string);
      assert.equal(body.n, 1);
      assert.equal(body.size, "1024x1536");
      assert.equal(body.quality, "medium");
      assert.ok(body.prompt.includes("Sıcak renkler"));
      return Response.json({
        data: [{ b64_json: png.toString("base64") }],
        usage: { input_tokens: 1000, output_tokens: 1000 },
      });
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.costUsd, 0.0175);
  assert.deepEqual(result.png, png);
});
test("image errors are safe and never retry automatically", async () => {
  let calls = 0;
  await assert.rejects(
    generateDesignImage("test", "secret", async () => {
      calls++;
      return new Response("secret", { status: 403 });
    }),
    (e) =>
      e instanceof PlannerError &&
      e.costUsd === 0 &&
      !e.message.includes("secret"),
  );
  assert.equal(calls, 1);
  await assert.rejects(
    generateDesignImage("test", "secret", async () =>
      Response.json({
        data: [{ b64_json: Buffer.from("not png").toString("base64") }],
      }),
    ),
    /doğrulanamadı/,
  );
  assert.throws(() => designImagePrompt(project, "register", ""), /Seçili/);
});

test("approved screens are sent as PNG reference inputs and image tokens use image pricing", async () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(1024, 16);
  png.writeUInt32BE(1536, 20);
  const references = [
    { assetId: "home", screenName: "Ana sayfa", png },
    { assetId: "settings", screenName: "Ayarlar", png },
  ];
  const prompt = designImagePrompt(
    project,
    "home",
    "Tutarlı tasarım",
    references.map(({ assetId, screenName }) => ({ assetId, screenName })),
  );
  assert.ok(prompt.includes("at most the two most recently approved"));
  assert.ok(prompt.includes("Ana sayfa") && prompt.includes("Ayarlar"));
  const result = await generateDesignImage(
    prompt,
    "test",
    async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/images/edits");
      assert.equal(new Headers(init?.headers).get("Content-Type"), null);
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get("model"), "gpt-image-2");
      assert.equal(init.body.get("prompt"), prompt);
      const images = init.body.getAll("image[]") as File[];
      assert.equal(images.length, 2);
      assert.deepEqual(Buffer.from(await images[0]!.arrayBuffer()), png);
      return Response.json({
        data: [{ b64_json: png.toString("base64") }],
        usage: {
          input_tokens: 3000,
          output_tokens: 1000,
          input_tokens_details: { text_tokens: 1000, image_tokens: 2000 },
        },
      });
    },
    references,
  );
  assert.equal(result.costUsd, 0.0255);
  const unknown = await generateDesignImage(
    prompt,
    "test",
    async () =>
      Response.json({
        data: [{ b64_json: png.toString("base64") }],
        usage: { input_tokens: 3000, output_tokens: 1000 },
      }),
    references,
  );
  assert.equal(unknown.costUsd, null);
});

test("more than three references are rejected before a paid API request", async () => {
  let calls = 0;
  await assert.rejects(
    generateDesignImage(
      "test",
      "test",
      async () => {
        calls++;
        return Response.json({});
      },
      Array.from({ length: 4 }, (_, index) => ({
        assetId: String(index),
        screenName: String(index),
        png: Buffer.from("fixture"),
      })),
    ),
    /En fazla 3/,
  );
  assert.equal(calls, 0);
});
