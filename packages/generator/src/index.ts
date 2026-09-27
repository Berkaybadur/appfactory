import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  writeFile,
  realpath,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import {
  projectSchema,
  screenFile,
  designImageJobSchema,
  getSpecification,
  getScreens,
  projectIdSchema,
  type Project,
} from "@app-factory/schemas";

export const generatorConfig = {
  template: "templates/expo-base",
  output: "workspace/generated-projects",
  enabled: true,
} as const;
export async function assertRealDirectory(directory: string) {
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("Sembolik bağlantı dizini kullanılamaz.");
  const resolved = await realpath(directory);
  if (resolved !== path.resolve(directory))
    throw new Error("Çıktı yolu güvenli çalışma alanının dışında.");
}
export async function outputDirectory(
  root: string,
  projectId: string,
  jobId: string,
) {
  root = await realpath(root);
  projectIdSchema.parse(projectId);
  if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new Error("Geçersiz iş kimliği.");
  const base = path.join(root, "workspace", "generated-projects");
  await mkdir(base, { recursive: true });
  await assertRealDirectory(base);
  const projectDirectory = path.join(base, projectId);
  await mkdir(projectDirectory, { recursive: true });
  await assertRealDirectory(projectDirectory);
  return path.join(projectDirectory, jobId);
}
async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      result.push(
        ...(await listFiles(path.join(directory, entry.name), relative)),
      );
    else if (entry.isFile()) result.push(relative);
  }
  return result.sort();
}
export async function assertDesignAssets(root: string, project: Project) {
  for (const reference of project.designReview?.images ?? []) {
    for (const extension of ["json", "png"]) {
      try {
        const file = path.join(
          root,
          "workspace/design-images",
          reference.assetId + "." + extension,
        );
        if (!(await lstat(file)).isFile())
          throw new Error("Geçersiz görsel dosyası.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const name =
          getScreens(getSpecification(project)).find(
            (screen) => screen.id === reference.screenId,
          )?.name ?? reference.screenId;
        throw new Error(
          `“${name}” ekranının onaylı tasarım dosyası bu bilgisayarda yok. Tasarım sayfasını açıp GitHub görsel eşitlemesini tamamlayın. Görsel henüz repoya gönderilmediyse üretildiği bilgisayarda Tasarım sayfasını açın (${reference.assetId}).`,
        );
      }
    }
  }
}
export async function generateProject(
  root: string,
  input: Project,
  jobId: string,
) {
  root = await realpath(root);
  const project = projectSchema.parse(input);
  if (!["development", "tests", "build"].includes(project.stage))
    throw new Error("Önce plan, ekran ve tasarım onaylarını tamamlayın.");
  await assertDesignAssets(root, project);
  const specification = getSpecification(project);
  const destination = await outputDirectory(root, project.id, jobId);
  const references: {
    screenId: string;
    png: Buffer;
    brief: string;
    assetId: string;
  }[] = [];
  if (project.designReview?.images) {
    const required = getScreens(specification)
      .filter((s) => s.enabled)
      .map((s) => s.id);
    const refs = project.designReview.images;
    if (
      refs.length !== required.length ||
      !required.every((id) => refs.some((r) => r.screenId === id))
    )
      throw new Error("Tüm ekranlar için görsel onayı gerekli.");
  }
  for (const reference of project.designReview?.images ?? []) {
    if (project.designReview?.revision !== specification.revision)
      throw new Error("Görsel onayı güncel sürüme ait değil.");
    const directory = path.join(root, "workspace/design-images");
    await assertRealDirectory(directory);
    const job = designImageJobSchema.parse(
      JSON.parse(
        await readFile(
          path.join(directory, reference.assetId + ".json"),
          "utf8",
        ),
      ),
    );
    if (
      job.projectId !== project.id ||
      job.status !== "succeeded" ||
      job.screenId !== reference.screenId ||
      job.revision !== reference.sourceRevision
    )
      throw new Error("Onaylı görsel referansı doğrulanamadı.");
    const assetPath = path.join(directory, reference.assetId + ".png");
    if (!(await lstat(assetPath)).isFile())
      throw new Error("Görsel dosyası geçersiz.");
    references.push({
      screenId: reference.screenId,
      png: await readFile(assetPath),
      brief: job.brief,
      assetId: job.id,
    });
  }
  // Exclusive directory creation prevents overwriting previous output or user edits.
  await mkdir(destination);
  await assertRealDirectory(destination);
  const templateDirectory = path.join(root, generatorConfig.template);
  const routeFiles: Record<string, string> = {
    home: "app/index.tsx",
    create: "app/create.tsx",
    details: "app/items/[id].tsx",
    settings: "app/settings.tsx",
    register: "app/register.tsx",
  };
  const excluded = new Set(
    Object.entries(routeFiles)
      .filter(
        ([id]) =>
          !getScreens(specification).some((s) => s.id === id && s.enabled),
      )
      .map(([, file]) => file),
  );
  await cp(templateDirectory, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (source) =>
      !["node_modules", ".expo"].includes(path.basename(source)) &&
      !excluded.has(
        path.relative(templateDirectory, source).split(path.sep).join("/"),
      ),
  });
  for (const screen of getScreens(specification).filter(
    (s) => s.enabled && s.id.startsWith("custom-"),
  )) {
    await writeFile(
      path.join(destination, screenFile(screen.id)),
      `import { Text } from "react-native";
import { screen } from "../src/screens";
import { Page, styles } from "../src/ui";
export default function CustomScreen() {
 const definition = screen(${JSON.stringify(screen.id)});
 return <Page><Text style={styles.title}>{definition.name}</Text><Text style={styles.text}>{definition.description}</Text></Page>;
}
`,
      { flag: "wx" },
    );
  }
  await writeFile(
    path.join(destination, "src/screens.json"),
    JSON.stringify(getScreens(specification), null, 2) + "\n",
  );
  if (references.length) {
    const referenceDirectory = path.join(destination, "design-references");
    await mkdir(referenceDirectory);
    for (const ref of references)
      await writeFile(
        path.join(referenceDirectory, ref.screenId + ".png"),
        ref.png,
        { flag: "wx" },
      );
    await writeFile(
      path.join(referenceDirectory, "index.json"),
      JSON.stringify(
        references.map((ref) => ({
          screenId: ref.screenId,
          file: ref.screenId + ".png",
          assetId: ref.assetId,
          brief: ref.brief,
        })),
        null,
        2,
      ),
    );
  }
  const manifest = JSON.parse(
    await readFile(path.join(destination, "package.json"), "utf8"),
  );
  manifest.name = `mobile-${project.id.toLowerCase()}`;
  await writeFile(
    path.join(destination, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  // Stable across output revisions; distinct factory projects get distinct app IDs.
  const applicationId = `com.appfactory.p${createHash("sha256").update(project.id).digest("hex").slice(0, 24)}`;
  const appConfig = {
    expo: {
      name: project.name,
      slug: `mobile-${project.id.toLowerCase()}`,
      version: "1.0.0",
      scheme: `appfactory-${project.id.toLowerCase()}`,
      orientation: "portrait",
      userInterfaceStyle: "light",
      platforms: [
        ...(project.android ? ["android"] : []),
        ...(project.ios ? ["ios"] : []),
        "web",
      ],
      ...(project.android ? { android: { package: applicationId } } : {}),
      ...(project.ios ? { ios: { bundleIdentifier: applicationId } } : {}),
      plugins: ["expo-router"],
      web: { bundler: "metro" },
    },
  };
  await writeFile(
    path.join(destination, "app.json"),
    JSON.stringify(appConfig, null, 2) + "\n",
  );
  await writeFile(
    path.join(destination, "src/project.json"),
    JSON.stringify(
      { name: project.name, idea: specification.plan.summary },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    path.join(destination, "src/theme.json"),
    JSON.stringify(specification.design, null, 2) + "\n",
  );
  await writeFile(
    path.join(destination, "specification.json"),
    JSON.stringify(specification, null, 2) + "\n",
  );
  await writeFile(
    path.join(destination, "project-memory.json"),
    JSON.stringify(
      {
        projectId: project.id,
        name: project.name,
        idea: project.idea,
        budgetLimitUsd: project.budgetLimit,
        aiCostUsd: project.aiCost,
        template: "expo-base-v3",
        specification,
        designReview: project.designReview,
        plannerDraft: project.plannerDraft,
        scope: "Generic local CRUD starter, not AI-generated features",
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    path.join(destination, "README.md"),
    `# Üretilen mobil uygulama\n\nExpo SDK 57 başlangıç şablonu. Fikre özel AI özellikleri henüz yoktur.\n\n## Çalıştırma\n\nNode.js 22.14+ gerekir.\n\n\x60\x60\x60sh\nnpm install --ignore-scripts\nnpm run typecheck\nnpm run lint\nnpm start\n\x60\x60\x60\n\nExpo Go ile aynı ağdaki telefondan terminaldeki QR kodunu okutun. Bilgisayarda web önizlemesi için \x60npm run web\x60 kullanın. Bu işlem APK üretmez. SDK ile uyumlu Expo Go sürümü gerekir.\n\nKayıtlar AsyncStorage ile cihazda saklanır. Gerçek Android/iOS derlemesi ayrı bir adımdır.\n`,
  );
  return {
    outputPath: path.relative(root, destination),
    files: await listFiles(destination),
  };
}
