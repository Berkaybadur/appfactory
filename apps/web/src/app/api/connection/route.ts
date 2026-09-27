import { readFile } from "node:fs/promises";
import path from "node:path";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function root() {
  let directory = process.cwd();
  while (true) {
    try {
      await readFile(path.join(directory, "pnpm-workspace.yaml"));
      return directory;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error("Çalışma alanı bulunamadı.");
      directory = parent;
    }
  }
}
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
export async function POST(request: Request) {
  if (!localRequest(request))
    return Response.json(
      { error: "Yalnızca yerel panelden erişilebilir." },
      { status: 403 },
    );
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return Response.json({ error: "JSON istek gerekli." }, { status: 415 });
  const text = await request.text();
  if (text.length > 240_000)
    return Response.json({ error: "İstek çok büyük." }, { status: 413 });
  try {
    const token = (
      await readFile(path.join(await root(), "workspace/.worker-token"), "utf8")
    ).trim();
    const port = Number(process.env.WORKER_PORT ?? 4001);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Geçersiz worker portu.");
    const response = await fetch(`http://127.0.0.1:${port}/connection`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: text,
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    return Response.json(await response.json(), {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      {
        error:
          "Worker’a ulaşılamıyor. Ayrı terminalde pnpm dev:worker komutunu çalıştırın.",
      },
      { status: 503 },
    );
  }
}
