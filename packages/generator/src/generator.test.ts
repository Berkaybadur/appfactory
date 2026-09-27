import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { generateProject, outputDirectory } from "./index";
import { getSpecification, type Project } from "@app-factory/schemas";
const project: Project = {
  id: "generator-test",
  name: 'Türkçe "Başlık"',
  type: "mobile",
  android: true,
  ios: false,
  idea: "Kayıtları listeleyen ve yerel olarak saklayan uygulama.",
  budgetLimit: 10,
  stage: "development",
  aiCost: 0,
  updatedAt: new Date().toISOString(),
};
test("produces isolated Expo output with safely serialized user content and preserves existing files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "factory-generator-"));
  try {
    await cp(path.resolve("templates"), path.join(root, "templates"), {
      recursive: true,
    });
    const id = randomUUID();
    const customized = {
      ...project,
      specification: {
        ...getSpecification(project),
        revision: 1,
        design: { ...getSpecification(project).design, primary: "#336699" },
      },
    };
    const output = await generateProject(root, customized, id);
    const destination = path.join(root, output.outputPath);
    const config = JSON.parse(
      await readFile(path.join(destination, "app.json"), "utf8"),
    );
    assert.equal(config.expo.name, project.name);
    assert.deepEqual(config.expo.platforms, ["android", "web"]);
    assert.ok(output.files.includes("app/items/[id].tsx"));
    assert.equal(
      JSON.parse(
        await readFile(path.join(destination, "src/theme.json"), "utf8"),
      ).primary,
      "#336699",
    );
    assert.equal(
      JSON.parse(
        await readFile(path.join(destination, "project-memory.json"), "utf8"),
      ).specification.revision,
      1,
    );
    assert.equal(
      JSON.parse(
        await readFile(path.join(destination, "src/project.json"), "utf8"),
      ).idea,
      project.idea,
    );
    await assert.rejects(generateProject(root, project, id), {
      code: "EEXIST",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("rejects paths and unapproved projects", async () => {
  await assert.rejects(outputDirectory(tmpdir(), "../escape", randomUUID()));
  await assert.rejects(
    generateProject(tmpdir(), { ...project, stage: "plan" }, randomUUID()),
    /onay/,
  );
});
test("rejects symlink output roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "factory-symlink-"));
  try {
    await mkdir(path.join(root, "workspace"));
    await mkdir(path.join(root, "outside"));
    await symlink(
      path.join(root, "outside"),
      path.join(root, "workspace/generated-projects"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      outputDirectory(root, project.id, randomUUID()),
      /bağlantı/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selected routes and edited content are generated without disabled screens", async () => {
  const { getScreens } = await import("@app-factory/schemas");
  const root = await mkdtemp(path.join(tmpdir(), "factory-screens-"));
  try {
    await cp(path.resolve("templates"), path.join(root, "templates"), {
      recursive: true,
    });
    const screens = getScreens(getSpecification(project)).map((s) => ({
      ...s,
      enabled: s.id === "home" || s.id === "register",
      name: s.id === "register" ? 'Üye ol "özel"' : s.name,
      description: "Türkçe içerik <script> çalıştırılmaz.",
    }));
    const output = await generateProject(
      root,
      { ...project, specification: { ...getSpecification(project), screens } },
      randomUUID(),
    );
    assert.ok(output.files.includes("app/index.tsx"));
    assert.ok(output.files.includes("app/register.tsx"));
    for (const file of [
      "app/create.tsx",
      "app/items/[id].tsx",
      "app/settings.tsx",
    ])
      assert.equal(output.files.includes(file), false);
    const generated = JSON.parse(
      await readFile(
        path.join(root, output.outputPath, "src/screens.json"),
        "utf8",
      ),
    );
    assert.deepEqual(generated, screens);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approved design images are copied as Builder references with provenance", async () => {
  const { writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "factory-reference-"));
  try {
    await cp(path.resolve("templates"), path.join(root, "templates"), {
      recursive: true,
    });
    await mkdir(path.join(root, "workspace/design-images"), {
      recursive: true,
    });
    const assetId = randomUUID();
    const bytes = Buffer.from("image fixture");
    await writeFile(
      path.join(root, "workspace/design-images", assetId + ".png"),
      bytes,
    );
    await writeFile(
      path.join(root, "workspace/design-images", assetId + ".json"),
      JSON.stringify({
        id: assetId,
        projectId: project.id,
        revision: 0,
        screenId: "home",
        screenName: "Ana ekran",
        brief: "Özgün tasarım",
        status: "succeeded",
        costUsd: 0.03,
        reservedUsd: 0,
        uncertainCostUsd: 0,
        error: null,
        createdAt: new Date().toISOString(),
        model: "gpt-image-2",
      }),
    );
    const approved: Project = {
      ...project,
      specification: {
        ...getSpecification(project),
        revision: 1,
        screens: (await import("@app-factory/schemas"))
          .getScreens(getSpecification(project))
          .map((s) => ({ ...s, enabled: s.id === "home" })),
      },
      designReview: {
        revision: 1,
        screens: ["home"],
        reviewedAt: new Date().toISOString(),
        images: [{ screenId: "home", assetId, sourceRevision: 0 }],
      },
    };
    const output = await generateProject(root, approved, randomUUID());
    assert.deepEqual(
      await readFile(
        path.join(root, output.outputPath, "design-references/home.png"),
      ),
      bytes,
    );
    const refs = JSON.parse(
      await readFile(
        path.join(root, output.outputPath, "design-references/index.json"),
        "utf8",
      ),
    );
    assert.equal(refs[0].assetId, assetId);
    assert.equal(refs[0].brief, "Özgün tasarım");
    await assert.rejects(
      generateProject(
        root,
        { ...approved, id: "different-project" },
        randomUUID(),
      ),
      /doğrulanamadı/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EAS APK configuration uses stable per-project IDs and excludes factory metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "factory-eas-"));
  try {
    await cp(path.resolve("templates"), path.join(root, "templates"), {
      recursive: true,
    });
    const input = { ...project, ios: true };
    const first = await generateProject(root, input, randomUUID());
    const second = await generateProject(
      root,
      { ...input, name: "Yeni ad" },
      randomUUID(),
    );
    const other = await generateProject(
      root,
      { ...input, id: "another-project" },
      randomUUID(),
    );
    const config = async (output: { outputPath: string }) =>
      JSON.parse(
        await readFile(path.join(root, output.outputPath, "app.json"), "utf8"),
      ).expo;
    const a = await config(first),
      b = await config(second),
      c = await config(other);
    assert.match(a.android.package, /^com\.appfactory\.p[a-f0-9]{24}$/);
    assert.equal(a.android.package, a.ios.bundleIdentifier);
    assert.equal(a.android.package, b.android.package);
    assert.notEqual(a.android.package, c.android.package);
    assert.equal(a.extra, undefined); // No invented Expo account/project association.
    const eas = JSON.parse(
      await readFile(path.join(root, first.outputPath, "eas.json"), "utf8"),
    );
    assert.equal(eas.build.preview.distribution, "internal");
    assert.equal(eas.build.preview.android.buildType, "apk");
    const ignore = await readFile(
      path.join(root, first.outputPath, ".easignore"),
      "utf8",
    );
    for (const pattern of [
      "**/.env",
      "**/.env.*",
      "project-memory.json",
      "specification.json",
      "design-references/",
      "credentials.json",
    ])
      assert.ok(ignore.split(/\r?\n/).includes(pattern));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("custom screens generate routes while removed optional routes are excluded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "factory-custom-"));
  try {
    await cp(path.resolve("templates"), path.join(root, "templates"), {
      recursive: true,
    });
    const specification = {
      ...getSpecification(project),
      screens: [
        { id: "home", enabled: true, name: "Ana ekran", description: "" },
        {
          id: "custom-notes",
          enabled: true,
          name: "Notlar",
          description: "Özel açıklama",
        },
        { id: "custom-hidden", enabled: false, name: "Gizli", description: "" },
      ],
    };
    const result = await generateProject(
      root,
      { ...project, specification },
      randomUUID(),
    );
    assert.ok(result.files.includes("app/custom-notes.tsx"));
    for (const file of [
      "app/create.tsx",
      "app/settings.tsx",
      "app/register.tsx",
      "app/items/[id].tsx",
      "app/custom-hidden.tsx",
    ])
      assert.ok(!result.files.includes(file));
    const source = await readFile(
      path.join(root, result.outputPath, "app/custom-notes.tsx"),
      "utf8",
    );
    assert.match(source, /custom-notes/);
    assert.match(source, /definition.description/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing design metadata or PNG gives actionable recovery before generation", async () => {
  const { assertDesignAssets } = await import("./index");
  const { writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "factory-missing-design-"));
  const assetId = randomUUID();
  const input = {
    ...project,
    designReview: {
      revision: 0,
      screens: ["home"],
      reviewedAt: new Date().toISOString(),
      images: [{ screenId: "home", assetId, sourceRevision: 0 }],
    },
  };
  try {
    await assert.rejects(
      assertDesignAssets(root, input),
      /tasarım dosyası bu bilgisayarda yok/,
    );
    await mkdir(path.join(root, "workspace/design-images"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "workspace/design-images", assetId + ".json"),
      "{}",
    );
    await assert.rejects(
      assertDesignAssets(root, input),
      /GitHub görsel eşitlemesini/,
    );
    await writeFile(
      path.join(root, "workspace/design-images", assetId + ".png"),
      "fixture",
    );
    await assert.doesNotReject(assertDesignAssets(root, input));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
