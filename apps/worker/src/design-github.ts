import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  designImageJobSchema,
  projectIdSchema,
  type DesignImageJob,
} from "@app-factory/schemas";
import { assertRealDirectory } from "@app-factory/generator";
import { GithubSync } from "./github";

const assetSchema = z.object({
  job: designImageJobSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export function validateDesignPng(png: Buffer, hash?: string) {
  if (
    png.length > 20_000_000 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error("Tasarım PNG dosyası geçersiz.");
  }
  const sha256 = createHash("sha256").update(png).digest("hex");
  if (hash && sha256 !== hash)
    throw new Error(
      "Tasarım görseli bütünlük kontrolünden geçemedi; yerel dosya korundu.",
    );
  return sha256;
}
async function localFile(file: string) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 20_000_000)
      throw new Error("Yerel tasarım dosyası geçersiz.");
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class DesignAssetGithub {
  get busy() {
    return this.pending.size > 0;
  }
  private pending = new Map<string, Promise<void>>();
  private last = new Map<string, number>();
  constructor(
    private root: string,
    private github: GithubSync,
  ) {}

  sync(
    projectId: string,
    jobs: Map<string, DesignImageJob>,
    force = false,
    projectName?: string,
  ): Promise<void> {
    projectIdSchema.parse(projectId);
    const existing = this.pending.get(projectId);
    if (existing)
      return force
        ? existing.then(() => this.sync(projectId, jobs, true, projectName))
        : existing;
    if (
      !force &&
      (this.github.busy || Date.now() - (this.last.get(projectId) ?? 0) < 15000)
    )
      return Promise.resolve();
    const work = this.transfer(projectId, jobs, projectName)
      .then(() => {
        this.last.set(projectId, Date.now());
      })
      .finally(() => {
        this.pending.delete(projectId);
      });
    this.pending.set(projectId, work);
    return work;
  }

  private async transfer(
    projectId: string,
    jobs: Map<string, DesignImageJob>,
    projectName?: string,
  ) {
    const pending = path.join(this.root, "workspace/design-images");
    await mkdir(pending, { recursive: true });
    const directory = await realpath(pending);
    await assertRealDirectory(directory);
    const local = [...jobs.values()].filter(
      (job) => job.projectId === projectId && job.status === "succeeded",
    );
    await this.github.syncDesignFiles(
      projectId,
      local.length > 0,
      async (remote, read) => {
        const additions = new Map<string, Buffer>();
        let totalBytes = 0;
        const countBytes = (png: Buffer) => {
          totalBytes += png.length;
          if (totalBytes > 100_000_000)
            throw new Error("Proje tasarım görselleri 100 MB sınırını aşıyor.");
        };
        const remoteIds = new Set<string>();
        const restored: {
          job: DesignImageJob;
          png: Buffer;
          existingPng: boolean;
          existingJob: boolean;
        }[] = [];
        // Validate the entire snapshot before restoring files or updating job records.
        for (const name of remote.keys()) {
          if (!name.endsWith(".json")) continue;
          const asset = assetSchema.parse(
            JSON.parse((await read(name)).toString("utf8")),
          );
          const { job } = asset;
          if (
            job.projectId !== projectId ||
            job.status !== "succeeded" ||
            name !== `design-images/${job.id}.json` ||
            remoteIds.has(job.id)
          )
            throw new Error("GitHub görsel kaydı proje ile uyuşmuyor.");
          remoteIds.add(job.id);
          const pngName = `design-images/${job.id}.png`;
          if (!remote.has(pngName))
            throw new Error("GitHub tasarım görseli eksik.");
          const existingPng = await localFile(
            path.join(directory, job.id + ".png"),
          );
          const existingJob = await localFile(
            path.join(directory, job.id + ".json"),
          );
          for (const record of [
            jobs.get(job.id),
            existingJob ? JSON.parse(existingJob.toString("utf8")) : undefined,
          ]) {
            if (
              record &&
              JSON.stringify(designImageJobSchema.parse(record)) !==
                JSON.stringify(job)
            )
              throw new Error(
                "Yerel ve GitHub görsel kaydı farklı; yerel kayıt korundu.",
              );
          }
          const png = existingPng ?? (await read(pngName));
          validateDesignPng(png, asset.sha256);
          const gitSha = createHash("sha1")
            .update(`blob ${png.length}\0`)
            .update(png)
            .digest("hex");
          if (gitSha !== remote.get(pngName))
            throw new Error(
              "GitHub tasarım görseli ve kaydı uyuşmuyor; yerel dosya korundu.",
            );
          countBytes(png);
          restored.push({
            job,
            png,
            existingPng: !!existingPng,
            existingJob: !!existingJob,
          });
        }
        if (remote.size !== remoteIds.size * 2)
          throw new Error("GitHub tasarım dosyalarının kayıtları eksik.");
        for (const input of local) {
          const job = designImageJobSchema.parse(input);
          if (remoteIds.has(job.id)) continue;
          const png = await localFile(path.join(directory, job.id + ".png"));
          if (!png)
            throw new Error(
              "GitHub'a gönderilecek yerel tasarım görseli eksik.",
            );
          const sha256 = validateDesignPng(png);
          countBytes(png);
          additions.set(`design-images/${job.id}.png`, png);
          additions.set(
            `design-images/${job.id}.json`,
            Buffer.from(JSON.stringify({ job, sha256 }, null, 2) + "\n"),
          );
        }
        for (const { job, png, existingPng, existingJob } of restored) {
          if (!existingPng)
            await writeFile(path.join(directory, job.id + ".png"), png, {
              flag: "wx",
              mode: 0o600,
            });
          if (!existingJob)
            await writeFile(
              path.join(directory, job.id + ".json"),
              JSON.stringify(job, null, 2) + "\n",
              { flag: "wx", mode: 0o600 },
            );
          jobs.set(job.id, job);
        }
        return additions;
      },
    );
  }
}
