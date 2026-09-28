import ts from "typescript";
import path from "node:path";
import { Worker } from "node:worker_threads";
import assert from "node:assert/strict";
import {
  featureFiles,
  featureOutputSchema,
  type FeatureOutput,
} from "@app-factory/schemas";

const forbidden = new Set([
  "require",
  "eval",
  "Function",
  "process",
  "global",
  "globalThis",
  "window",
  "document",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "WebView",
  "Linking",
  "constructor",
  "__proto__",
  "prototype",
  "Reflect",
  "Proxy",
]);
export function validateApplicationCode(
  code: string,
  file: string,
  screen = false,
) {
  if (/eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error/.test(code))
    throw new Error("Kod denetimleri kapatılamaz.");
  const pure = file.endsWith("/domain.ts") || file.endsWith("/models.ts");
  const source = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const locals = new Set<string>([
    ...featureFiles.map((f) => f.replace(/\.tsx?$/, "")),
    "src/demo",
    "src/runtime/runtime",
    "src/runtime/map",
    "src/ui",
    "src/screens",
    "src/theme.json",
    "src/project.json",
  ]);
  function visit(node: ts.Node) {
    if (
      (ts.isIdentifier(node) || ts.isStringLiteral(node)) &&
      forbidden.has(node.text)
    )
      throw new Error(`İzin verilmeyen kod erişimi: ${node.text}`);
    if (
      ts.isImportEqualsDeclaration(node) ||
      (ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    )
      throw new Error("Dinamik modül yüklenemez.");
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        if (!ts.isStringLiteral(node.moduleSpecifier))
          throw new Error("Modül adı sabit olmalı.");
        const name = node.moduleSpecifier.text;
        if (pure) {
          if (
            !ts.isImportDeclaration(node) ||
            !node.importClause?.isTypeOnly ||
            name !== "./models"
          )
            throw new Error("İş kuralları yalnızca models tiplerini alabilir.");
        } else if (name.startsWith(".")) {
          const resolved = path.posix.normalize(
            path.posix.join(path.posix.dirname(file), name),
          );
          if (!locals.has(resolved))
            throw new Error(`İzin verilmeyen yerel modül: ${name}`);
        } else if (
          ![
            "react",
            "react-native",
            ...(screen ? ["expo-router"] : []),
          ].includes(name)
        )
          throw new Error(
            name === "react-native-maps"
              ? "Harita için src/runtime/map içindeki AppMap kullanın; react-native-maps ekrana veya özellik dosyasına eklenemez."
              : `İzin verilmeyen paket: ${name}`,
          );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (screen) {
    let defaultExport = false;
    let usesStore = false;
    const aliases = new Set<string>();
    for (const node of source.statements) {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.endsWith("/features/store")
      ) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          for (const item of bindings.elements)
            if ((item.propertyName?.text ?? item.name.text) === "useApp")
              aliases.add(item.name.text);
      }
    }
    function inspect(node: ts.Node) {
      if (
        ts.isExportAssignment(node) ||
        (ts.canHaveModifiers(node) &&
          ts
            .getModifiers(node)
            ?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
      )
        defaultExport = true;
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        aliases.has(node.expression.text)
      )
        usesStore = true;
      ts.forEachChild(node, inspect);
    }
    inspect(source);
    if (!defaultExport || !usesStore)
      throw new Error(
        "Ekran default export ve çalışan useApp bağlantısı içermeli.",
      );
  }
}

export function validateFeatures(input: unknown): FeatureOutput {
  const output = featureOutputSchema.parse(input);
  if (new Set(output.files.map((f) => f.path)).size !== featureFiles.length)
    throw new Error("Her uygulama modülü tam olarak bir kez üretilmeli.");
  for (const file of output.files)
    validateApplicationCode(file.code, file.path);
  if (new Set(output.tests.map((t) => t.name)).size !== output.tests.length)
    throw new Error("İş kuralı test adları benzersiz olmalı.");
  if (output.capabilities.includes("backend")) {
    if (!output.migrationSql.trim() || !output.setup.length)
      throw new Error(
        "Sunucu bağlantısı migration ve kurulum adımları gerektirir.",
      );
    if (
      !/enable\s+row\s+level\s+security/i.test(output.migrationSql) ||
      /\bfactory_[a-z_]+/i.test(output.migrationSql)
    )
      throw new Error(
        "Migration RLS içermeli ve App Factory verilerine dokunmamalı.",
      );
    // Deployment is not performed by the Builder. Recover inconsistent reporting
    // without another paid call; never upgrade unsupported or pending coverage.
    if (!output.coverage.some((c) => c.status === "needs_setup")) {
      const notice =
        "Sunucu kurulumu ve gerçek bağlantı doğrulaması bekliyor. ";
      output.coverage = output.coverage.map((item) =>
        item.status === "implemented"
          ? {
              ...item,
              status: "needs_setup" as const,
              detail: notice + item.detail.slice(0, 1000 - notice.length),
            }
          : item,
      );
    }
  }
  return output;
}

// Run only import-free pure rules, not generated React/native/service code.
// A disposable worker supplies resource limits; its VM has no host objects,
// module loader, network, timers or credentials. This is a test harness, not a
// general-purpose security sandbox for arbitrary third-party programs.
export async function checkFeatureRules(output: FeatureOutput) {
  const code = output.files.find(
    (f) => f.path === "src/features/domain.ts",
  )!.code;
  validateApplicationCode(code, "src/features/domain.ts");
  const javascript = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const tests = output.tests.map((test) => {
    const args: unknown = JSON.parse(test.argsJson);
    if (!Array.isArray(args))
      throw new Error("Test argümanları JSON dizisi olmalı.");
    return {
      ...test,
      args,
      expected: JSON.parse(test.expectedJson) as unknown,
    };
  });
  const results = await new Promise<string[]>((resolve, reject) => {
    const worker = new Worker(
      `
      const {parentPort,workerData}=require('node:worker_threads');
      const vm=require('node:vm');
      try {
        const results=workerData.tests.map(test => {
          const source='const exports = {};\\n'+workerData.code+'\\nJSON.stringify(exports['+JSON.stringify(test.exportName)+'](...'+JSON.stringify(test.args)+'))';
          return vm.runInNewContext(source, undefined, {timeout:500,contextCodeGeneration:{strings:false,wasm:false}});
        });
        parentPort.postMessage({results});
      } catch(e) { parentPort.postMessage({error:String(e.message)}); }
    `,
      {
        eval: true,
        env: {},
        workerData: { code: javascript, tests },
        resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 },
      },
    );
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("İş kuralı testleri zaman aşımına uğradı."));
    }, 5000);
    worker.once(
      "message",
      (message: { results?: string[]; error?: string }) => {
        clearTimeout(timer);
        void worker.terminate();
        if (message.error)
          reject(new Error(`İş kuralı testi: ${message.error}`));
        else resolve(message.results!);
      },
    );
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error("İş kuralı test süreci durdu."));
    });
  });
  return tests.map((test, index) => {
    try {
      assert.deepEqual(JSON.parse(results[index]!), test.expected);
    } catch {
      throw new Error(`İş kuralı testi başarısız: ${test.name}`);
    }
    return { name: test.name, passed: true };
  });
}
