import { readFile } from "node:fs/promises";
import path from "node:path";
import { projectSchema, projectIdSchema } from "@app-factory/schemas";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const host = new URL("http://" + request.headers.get("host"));
    const origin = request.headers.get("origin");
    if (
      !["localhost", "127.0.0.1"].includes(host.hostname) ||
      (origin && new URL(origin).origin !== host.origin)
    )
      return Response.json(
        { error: "Yalnızca yerel panelden erişilebilir." },
        { status: 403 },
      );
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return Response.json({ error: "JSON istek gerekli." }, { status: 415 });
    const text = await request.text();
    if (Buffer.byteLength(text) > 240_000)
      return Response.json({ error: "İstek çok büyük." }, { status: 413 });
    const body = JSON.parse(text);
    const project = projectSchema
      .safeExtend({ id: projectIdSchema })
      .parse(body.project);
    if (
      body.confirmation !== project.name ||
      !["check", "delete"].includes(body.action)
    )
      return Response.json(
        { error: "Proje adı onayı geçersiz." },
        { status: 400 },
      );
    let root = process.cwd();
    while (true) {
      try {
        await readFile(path.join(root, "pnpm-workspace.yaml"));
        break;
      } catch {
        const parent = path.dirname(root);
        if (root === parent) throw new Error("Çalışma alanı bulunamadı.");
        root = parent;
      }
    }
    const token = (
      await readFile(path.join(root, "workspace/.worker-token"), "utf8")
    ).trim();
    const port = Number(process.env.WORKER_PORT ?? 4001);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Geçersiz port.");
    const response = await fetch(`http://127.0.0.1:${port}/projects/delete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        project,
        confirmation: body.confirmation,
        action: body.action,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(180000),
    });
    return Response.json(await response.json(), {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      {
        error:
          "Silme yanıtı alınamadı. Worker bağlantısını kontrol edip yeniden deneyin; proje tamamen silinmiş sayılmadı.",
      },
      { status: 503 },
    );
  }
}
