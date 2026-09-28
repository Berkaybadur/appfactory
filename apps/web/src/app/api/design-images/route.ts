import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  projectSchema,
  projectIdSchema,
  designImageRequestSchema,
  designImageUploadSchema,
} from "@app-factory/schemas";
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
async function proxy(request: Request, body?: unknown) {
  if (!localRequest(request))
    return Response.json(
      { error: "Yalnızca yerel panelden erişilebilir." },
      { status: 403 },
    );
  try {
    const token = (
      await readFile(path.join(await root(), "workspace/.worker-token"), "utf8")
    ).trim();
    const port = Number(process.env.WORKER_PORT ?? 4001);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Geçersiz worker portu.");
    const id = new URL(request.url).searchParams.get("projectId");
    const assetId = new URL(request.url).searchParams.get("assetId");
    const name = new URL(request.url).searchParams.get("name");
    if (assetId && !/^[0-9a-f-]{36}$/.test(assetId))
      return Response.json({ error: "Geçersiz görsel." }, { status: 400 });
    const query =
      !body && assetId
        ? `?assetId=${assetId}`
        : !body && id
          ? `?projectId=${projectIdSchema.parse(id)}${
              name && name.length <= 80
                ? `&name=${encodeURIComponent(name)}`
                : ""
            }`
          : "";
    const response = await fetch(
      `http://127.0.0.1:${port}/design-images${query}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: "no-store",
        signal: AbortSignal.timeout(120000),
      },
    );
    if (response.ok && assetId && !body)
      return new Response(await response.arrayBuffer(), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
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
export async function GET(request: Request) {
  return proxy(request);
}
export async function POST(request: Request) {
  if (!localRequest(request))
    return Response.json(
      { error: "Yalnızca yerel panelden erişilebilir." },
      { status: 403 },
    );
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return Response.json({ error: "JSON istek gerekli." }, { status: 415 });
  try {
    const text = await request.text();
    if (text.length > 28_000_000)
      return Response.json({ error: "İstek çok büyük." }, { status: 413 });
    const body = JSON.parse(text);
    if (body.action === "upload") {
      return proxy(request, designImageUploadSchema.parse(body));
    }
    if (text.length > 240_000)
      return Response.json({ error: "İstek çok büyük." }, { status: 413 });
    if (body.action === "approve") {
      const project = projectSchema
        .safeExtend({ id: projectIdSchema })
        .parse(body.project);
      return proxy(request, {
        action: "approve",
        project,
        reviewedIds: body.reviewedIds,
      });
    }
    return proxy(request, designImageRequestSchema.parse(body));
  } catch {
    return Response.json(
      { error: "Proje bilgileri geçersiz." },
      { status: 400 },
    );
  }
}
