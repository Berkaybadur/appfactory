import {
  cp,
  mkdir,
  readFile,
  writeFile,
  rm,
  lstat,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { assertRealDirectory } from "@app-factory/generator";
import {
  getSpecification,
  getScreens,
  type Project,
  type FeatureOutput,
} from "@app-factory/schemas";

// Resumed jobs may have been generated before demo support was introduced.
// Add missing support without replacing existing application modules.
export async function ensureDemoSupport(root: string, cwd: string) {
  await assertRealDirectory(cwd);
  await assertRealDirectory(path.join(cwd, "src"));
  await assertRealDirectory(path.join(cwd, "app"));
  for (const name of ["demo.tsx", "demo-state.ts"]) {
    const target = path.join(cwd, "src", name);
    try {
      const info = await lstat(target);
      if (!info.isFile() || (await realpath(target)) !== target)
        throw new Error("Demo modül yolu geçersiz.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(
        target,
        await readFile(path.join(root, "templates/expo-base/src", name)),
        { flag: "wx" },
      );
    }
  }
  const target = path.join(cwd, "app/_layout.tsx");
  if (!(await lstat(target)).isFile() || (await realpath(target)) !== target)
    throw new Error("Uygulama layout yolu geçersiz.");
  const original = await readFile(target, "utf8");
  if (original.includes("<DemoProvider>")) return;
  const provider = original.includes("<AppProvider>")
    ? "AppProvider"
    : "RecordsProvider";
  if (
    !original.includes(`<${provider}>`) ||
    !original.includes(`</${provider}>`)
  )
    throw new Error("Demo modu için uygulama sağlayıcısı bulunamadı.");
  await writeFile(
    target,
    'import { DemoProvider } from "../src/demo";\n' +
      original
        .replace(`<${provider}>`, `<DemoProvider><${provider}>`)
        .replace(`</${provider}>`, `</${provider}></DemoProvider>`),
  );
}

export async function prepareApplication(root: string, cwd: string) {
  await assertRealDirectory(cwd);
  await mkdir(path.join(cwd, "src/runtime"), { recursive: true });
  await assertRealDirectory(path.join(cwd, "src/runtime"));
  await cp(
    path.join(root, "templates/expo-features"),
    path.join(cwd, "src/runtime"),
    { recursive: true },
  );
  const manifest = JSON.parse(
    await readFile(path.join(cwd, "package.json"), "utf8"),
  );
  Object.assign(manifest.dependencies, {
    "expo-location": "~57.0.20",
    "expo-image-picker": "~57.0.20",
    "react-native-maps": "1.27.2",
    "@supabase/supabase-js": "2.117.1",
    "react-native-url-polyfill": "2.0.0",
  });
  await writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const config = JSON.parse(await readFile(path.join(cwd, "app.json"), "utf8"));
  config.expo.plugins = config.expo.plugins.filter(
    (plugin: string | [string, unknown]) =>
      !["expo-location", "expo-image-picker"].includes(
        typeof plugin === "string" ? plugin : plugin[0],
      ),
  );
  config.expo.plugins.push(
    [
      "expo-location",
      {
        locationWhenInUsePermission:
          "Yakınınızdaki içerikleri göstermek için konumunuza izin verin.",
        isIosBackgroundLocationEnabled: false,
        isAndroidBackgroundLocationEnabled: false,
      },
    ],
    [
      "expo-image-picker",
      {
        cameraPermission:
          "Fotoğraf çekerek paylaşmak için kameraya izin verin.",
        photosPermission: false,
        microphonePermission: false,
      },
    ],
  );
  await writeFile(
    path.join(cwd, "app.json"),
    JSON.stringify(config, null, 2) + "\n",
  );
  const layoutPath = path.join(cwd, "app/_layout.tsx");
  let layout = await readFile(layoutPath, "utf8");
  if (!layout.includes('from "../src/features/store"')) {
    layout = 'import { AppProvider } from "../src/features/store";\n' + layout;
    // Keep the legacy provider while screens are replaced one at a time.
    layout = layout
      .replace("<RecordsProvider>", "<AppProvider><RecordsProvider>")
      .replace("</RecordsProvider>", "</RecordsProvider></AppProvider>");
  }
  await writeFile(layoutPath, layout);
}

export async function featureContext(
  cwd: string,
  project: Project,
  diagnostics: string,
  previousCandidate?: FeatureOutput,
) {
  const modules: Record<string, string> = {};
  for (const name of ["runtime.ts", "map.tsx"])
    modules[`src/runtime/${name}`] = await readFile(
      path.join(cwd, "src/runtime", name),
      "utf8",
    );
  modules["src/demo.tsx"] = await readFile(
    path.join(cwd, "src/demo.tsx"),
    "utf8",
  );
  const spec = getSpecification(project);
  return JSON.stringify({
    task: previousCandidate
      ? "REPAIR_APPLICATION_FEATURES"
      : "BUILD_APPLICATION_FEATURES",
    previousCandidate,
    compilerOptions: { strict: true, noUncheckedIndexedAccess: true },
    projectMemory: {
      name: project.name,
      idea: project.idea,
      plan: spec.plan,
      screens: getScreens(spec).filter((s) => s.enabled),
      tasks: previousCandidate ? undefined : project.plannerDraft?.tasks,
      screenNotes: previousCandidate
        ? undefined
        : project.plannerDraft?.screenNotes,
    },
    modules,
    files: [
      "src/features/models.ts",
      "src/features/domain.ts",
      "src/features/store.tsx",
      "src/features/services.ts",
    ],
    previousDiagnostics: diagnostics.slice(-8000),
  });
}

export const builderContextLimit = 80000;

export function fitBuilderContext(
  payload: Record<string, unknown>,
  limit = builderContextLimit,
) {
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  if (size(payload) <= limit) return JSON.stringify(payload);
  const next: Record<string, unknown> = { ...payload };
  delete next.rejectedCode;
  delete next.previousCandidate;
  if (size(next) <= limit) return JSON.stringify(next);
  if (typeof next.previousDiagnostics === "string")
    next.previousDiagnostics = next.previousDiagnostics.slice(-2000);
  const memory = next.projectMemory;
  if (memory && typeof memory === "object") {
    const value = memory as Record<string, unknown>;
    next.projectMemory = {
      name: value.name,
      summary: value.summary,
      design: value.design,
    };
  }
  delete next.notes;
  if (Array.isArray(next.enabledScreens))
    next.enabledScreens = (
      next.enabledScreens as { id?: string; screenId?: string; name?: string }[]
    ).map((screen) => ({
      id: screen.id ?? screen.screenId,
      name: screen.name,
    }));
  if (size(next) <= limit) return JSON.stringify(next);
  const drop = [
    "src/demo.tsx",
    "src/runtime/map.tsx",
    "src/records.tsx",
    "src/record-form.tsx",
    "src/runtime/runtime.ts",
    "src/features/domain.ts",
    "src/features/services.ts",
  ];
  if (next.modules && typeof next.modules === "object") {
    const files = { ...(next.modules as Record<string, string>) };
    for (const pathName of drop) {
      delete files[pathName];
      next.modules = files;
      if (size(next) <= limit) return JSON.stringify(next);
    }
  }
  delete next.migrationSql;
  if (size(next) <= limit) return JSON.stringify(next);
  throw new Error("Ekran bağlamı görev sınırını aşıyor.");
}

export async function applicationModules(cwd: string) {
  const files: Record<string, string> = {};
  for (const file of [
    "demo.tsx",
    "features/models.ts",
    "features/domain.ts",
    "features/store.tsx",
    "features/services.ts",
    "runtime/runtime.ts",
    "runtime/map.tsx",
  ]) {
    const target = path.join(cwd, "src", file);
    if (file === "demo.tsx" && !(await lstat(target).catch(() => null)))
      continue;
    if (!(await lstat(target)).isFile() || (await realpath(target)) !== target)
      throw new Error("Uygulama modül yolu geçersiz.");
    files[`src/${file}`] = await readFile(target, "utf8");
  }
  return files;
}

export async function writeFeatureCandidate(
  cwd: string,
  output: FeatureOutput,
) {
  const files = [
    ...output.files,
    { path: "backend/migration.sql", code: output.migrationSql },
    {
      path: "FEATURE-SETUP.md",
      code:
        "# Uygulama kurulumu\n\n" +
        output.setup.map((step) => `- ${step}`).join("\n") +
        "\n\nMigration otomatik uygulanmadı. Ayrı uygulama veritabanında SQL ve erişim politikalarını inceleyip uygulayın. Mobil bağlantı için src/runtime/connection.json dosyasına yalnızca HTTPS URL ve publishable anahtarı ekleyin. App Factory hesabı/anahtarları aktarılmaz. Android harita dağıtımı için Google Maps anahtarı ve uygulama kısıtları ayrıca yapılandırılmalıdır.\n",
    },
    { path: "feature-tests.json", code: JSON.stringify(output.tests, null, 2) },
  ];
  const originals = new Map<string, string | null>();
  const rollback = async () => {
    for (const [target, original] of originals) {
      if (original === null) await rm(target, { force: true });
      else await writeFile(target, original);
    }
  };
  try {
    for (const file of files) {
      const target = path.join(cwd, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await assertRealDirectory(path.dirname(target));
      try {
        if (
          !(await lstat(target)).isFile() ||
          (await realpath(target)) !== target
        )
          throw new Error("Uygulama dosya yolu geçersiz.");
        originals.set(target, await readFile(target, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        originals.set(target, null);
      }
      await writeFile(target, file.code + "\n");
    }
  } catch (error) {
    await rollback();
    throw error;
  }
  return rollback;
}
