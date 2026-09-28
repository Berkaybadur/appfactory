import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { projectIdSchema } from "@app-factory/schemas";

const absent = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

/** Durable journal: a failed cleanup can resume even after its job metadata is gone. */
export class ProjectDeletion {
  readonly blocked = new Set<string>();
  busy = false;
  constructor(private root: string) {}

  private async checked(relative: string) {
    const base = path.resolve(this.root, "workspace");
    const target = path.resolve(base, relative);
    if (!target.startsWith(base + path.sep) || relative.includes(":"))
      throw new Error("Silme yolu çalışma alanı dışında.");
    let current = base;
    for (const part of ["", ...path.relative(base, target).split(path.sep)]) {
      current = path.join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error("Silme yolunda sembolik bağlantı var.");
      } catch (error) {
        if (absent(error)) break;
        throw error;
      }
    }
    return target;
  }
  private async names(relative: string) {
    try {
      return await readdir(await this.checked(relative));
    } catch (error) {
      if (absent(error)) return [];
      throw error;
    }
  }
  async initialize() {
    for (const name of await this.names("deleted-projects")) {
      if (name.endsWith(".json"))
        this.blocked.add(projectIdSchema.parse(name.slice(0, -5)));
    }
  }
  assertAvailable(id: unknown) {
    if (typeof id === "string" && this.blocked.has(id))
      throw new Error(
        "Bu proje siliniyor veya silindi. Proje kartından silmeyi tamamlayın.",
      );
  }
  async plan(id: string): Promise<string[]> {
    projectIdSchema.parse(id);
    const journal = await this.checked(`deleted-projects/${id}.json`);
    try {
      const record = JSON.parse(await readFile(journal, "utf8"));
      const saved: unknown = record.targets;
      if (
        !Array.isArray(saved) ||
        !saved.every((item) => typeof item === "string")
      )
        throw new Error("Silme günlüğü geçersiz.");
      for (const item of saved) await this.checked(item);
      return saved;
    } catch (error) {
      if (!absent(error)) throw error;
    }

    const targets = new Set<string>([
      `generated-projects/${id}`,
      `jobs/history/${id}`,
      `jobs/${id}.json`,
      `jobs/${id}.json.tmp`,
      `planner/${id}.json`,
      `planner/${id}.json.tmp`,
      `eas/links/${id}.json`,
      `eas/links/${id}.json.tmp`,
      `github/${id}-head.json`,
      `github/${id}-head.json.tmp`,
    ]);
    const sources = new Set<string>();
    // Include old/archived source IDs, even if no longer in the managers' maps.
    for (const name of await this.names(`generated-projects/${id}`)) {
      const match = name.match(/^([a-f0-9-]{36})(?:$|-)/i);
      if (match) sources.add(match[1]!);
    }
    for (const directory of [
      "jobs",
      `jobs/history/${id}`,
      "builder",
      "design-images",
      "previews",
      "smoke",
      "eas/jobs",
    ]) {
      for (const name of await this.names(directory)) {
        if (!name.endsWith(".json")) continue;
        const file = `${directory}/${name}`;
        const record = JSON.parse(
          await readFile(await this.checked(file), "utf8"),
        );
        if ((record.projectId ?? record.project?.id) !== id) continue;
        targets.add(file);
        targets.add(file + ".tmp");
        if (directory === "design-images")
          targets.add(file.slice(0, -5) + ".png");
        else if (directory === "smoke") targets.add(file.slice(0, -5));
        else if (directory === "builder" || directory.startsWith("jobs")) {
          if (
            typeof record.id !== "string" ||
            !/^[a-f0-9-]{36}$/i.test(record.id)
          )
            throw new Error("Proje iş kimliği geçersiz.");
          sources.add(record.id);
        }
        if (directory === "previews") sources.add(record.sourceJobId);
      }
    }
    for (const directory of ["builder", "github", "previews", "release"]) {
      for (const name of await this.names(directory)) {
        if (
          [...sources].some(
            (source) =>
              name.startsWith(source + ".") || name.startsWith(source + "-"),
          )
        )
          targets.add(`${directory}/${name}`);
      }
    }
    for (const target of targets) await this.checked(target);
    return [...targets];
  }
  async run(id: string, deleteRemote: () => Promise<void>) {
    if (this.busy) throw new Error("Silme işleminin bitmesini bekleyin.");
    this.busy = true;
    try {
      const targets = await this.plan(id);
      const directory = await this.checked("deleted-projects");
      await mkdir(directory, { recursive: true });
      const journal = await this.checked(`deleted-projects/${id}.json`);
      let remoteDeleted = false;
      try {
        remoteDeleted =
          JSON.parse(await readFile(journal, "utf8")).remoteDeleted === true;
      } catch (error) {
        if (!absent(error)) throw error;
      }
      const persist = async (remaining: string[]) => {
        const temporary = await this.checked(`deleted-projects/${id}.json.tmp`);
        await writeFile(
          temporary,
          JSON.stringify({ targets: remaining, remoteDeleted }),
          { mode: 0o600 },
        );
        await rename(temporary, journal);
      };
      await persist(targets);
      this.blocked.add(id);
      if (!remoteDeleted) {
        await deleteRemote();
        remoteDeleted = true;
        await persist(targets);
      }
      for (const target of targets)
        await rm(await this.checked(target), { recursive: true, force: true });
      // Retain only the ID marker to reject stale tabs after a worker restart.
      await persist([]);
    } finally {
      this.busy = false;
    }
  }
}
