import { readFile } from "node:fs/promises";
import path from "node:path";
import { smokeRequestSchema } from "@app-factory/schemas";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function localRequest(request: Request) {
  try {
    const host = request.headers.get("host");
    if (!host) return false;
    const url = new URL("http://" + host);
    const origin = request.headers.get("origin");
    return (
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
      (!origin || new URL(origin).origin === url.origin)
    );
  } catch {
    return false;
  }
}
async function root() {
  let dir = process.cwd();
  while (true) {
    try {
      await readFile(path.join(dir, "pnpm-workspace.yaml"));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error("Çalışma alanı bulunamadı.");
      dir = parent;
    }
  }
}
async function proxy(request: Request, body?: unknown) {
  try {
    const token = (
      await readFile(path.join(await root(), "workspace/.worker-token"), "utf8")
    ).trim();
    const port = Number(process.env.WORKER_PORT ?? 4001);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Geçersiz worker portu.");
    const query = new URL(request.url).searchParams;
    const reportId = query.get("reportId") ?? "",
      file = query.get("file") ?? "";
    if (
      !body &&
      (!/^[a-f0-9-]{36}$/i.test(reportId) || !/^\d+\.png$/.test(file))
    )
      return Response.json({ error: "Geçersiz kanıt." }, { status: 400 });
    const response = await fetch(
      `http://127.0.0.1:${port}/smoke${body ? "" : `?reportId=${reportId}&file=${file}`}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: "no-store",
        signal: AbortSignal.timeout(45000),
      },
    );
    if (!body && response.ok)
      return new Response(await response.arrayBuffer(), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    return Response.json(await response.json(), {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Worker’a ulaşılamıyor. pnpm dev:worker ile başlatın." },
      { status: 503 },
    );
  }
}
export async function GET(request: Request) {
  if (!localRequest(request))
    return Response.json(
      { error: "Yalnızca yerel panelden erişilebilir." },
      { status: 403 },
    );
  return proxy(request);
}
export async function POST(request: Request) {
  if (!localRequest(request))
    return Response.json(
      { error: "Yalnızca yerel panelden erişilebilir." },
      { status: 403 },
    );
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return Response.json({ error: "JSON gerekli." }, { status: 415 });
  try {
    const text = await request.text();
    if (text.length > 28_300_000)
      return Response.json({ error: "İstek çok büyük." }, { status: 413 });
    return proxy(request, smokeRequestSchema.parse(JSON.parse(text)));
  } catch {
    return Response.json(
      { error: "Smoke test bilgileri geçersiz." },
      { status: 400 },
    );
  }
}
