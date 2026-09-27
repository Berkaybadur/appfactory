import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  appConnectionSchema,
  connectionRequestSchema,
  type AppConnection,
  type Project,
} from "@app-factory/schemas";
import { assertRealDirectory } from "@app-factory/generator";
import type { EasSource } from "./eas";

const empty: AppConnection = { url: "", publishableKey: "" };

export async function appConnection(
  root: string,
  resolveSource: (project: Project, id: string) => EasSource,
  raw: unknown,
) {
  const request = connectionRequestSchema.safeParse(raw);
  if (!request.success)
    throw new Error(
      request.error.issues[0]?.message ?? "Bağlantı bilgileri geçersiz.",
    );
  const input = request.data;
  const source = resolveSource(input.project, input.sourceJobId);
  const cwd = path.resolve(root, source.outputPath);
  if (
    cwd !==
    path.join(
      root,
      "workspace/generated-projects",
      source.project.id,
      source.id,
    )
  )
    throw new Error("Çıktı yolu geçersiz.");
  const runtime = path.join(cwd, "src/runtime");
  const available = await lstat(runtime)
    .then((info) => info.isDirectory())
    .catch(() => false);
  if (!available) {
    if (input.connection)
      throw new Error(
        "Bu sürüm backend bağlantısı kullanmıyor; bağlantı yalnızca uygulama işlevleri üretilmiş çıktılarda girilir.",
      );
    return { available: false, connection: empty };
  }
  await assertRealDirectory(runtime);
  const file = path.join(runtime, "connection.json");
  const info = await lstat(file).catch(() => null);
  if (info && (!info.isFile() || (await realpath(file)) !== file))
    throw new Error("Bağlantı dosyası yolu geçersiz.");
  if (input.connection) {
    await writeFile(
      file + ".tmp",
      JSON.stringify(input.connection, null, 2) + "\n",
      { mode: 0o600 },
    );
    await rename(file + ".tmp", file);
    return { available: true, connection: input.connection };
  }
  if (!info) return { available: true, connection: empty };
  const parsed = appConnectionSchema.safeParse(
    JSON.parse(await readFile(file, "utf8")),
  );
  return {
    available: true,
    connection: parsed.success ? parsed.data : empty,
  };
}
