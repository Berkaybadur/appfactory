import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  realpath,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import {
  designImageJobSchema,
  designImageRequestSchema,
  designImageUploadSchema,
  getSpecification,
  getScreens,
  type DesignImageJob,
  designGenerationReferences,
  designImageReservation,
} from "@app-factory/schemas";
import { assertRealDirectory } from "@app-factory/generator";
import {
  designImagePrompt,
  generateDesignImage,
  imageModel,
  type DesignImageReference,
  PlannerError,
} from "@app-factory/ai";
import { validateDesignPng } from "./design-github";
export class DesignImageManager {
  onSaved?: (projectId: string) => Promise<void>;
  cloudError: string | null = null;
  readonly jobs = new Map<string, DesignImageJob>();
  private locked = false;
  get busy() {
    return this.locked;
  }
  get enabled() {
    return !!this.key.trim();
  }
  constructor(
    private root: string,
    private otherSpend: (id: string) => number = () => 0,
    private key = process.env.OPENAI_API_KEY ?? "",
    private run = generateDesignImage,
  ) {}
  list(projectId: string) {
    return [...this.jobs.values()]
      .filter((j) => j.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  spent(projectId: string) {
    return this.list(projectId).reduce(
      (n, j) => n + j.costUsd + j.uncertainCostUsd + j.reservedUsd,
      0,
    );
  }
  totalCost(projectId: string) {
    return (
      this.otherSpend(projectId) +
      this.list(projectId).reduce(
        (n, j) => n + j.costUsd + j.uncertainCostUsd,
        0,
      )
    );
  }
  private async persist(job: DesignImageJob) {
    const target = path.join(
      this.root,
      "workspace/design-images",
      job.id + ".json",
    );
    await writeFile(target + ".tmp", JSON.stringify(job, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(target + ".tmp", target);
  }
  async initialize() {
    this.root = await realpath(this.root);
    const dir = path.join(this.root, "workspace/design-images");
    await mkdir(dir, { recursive: true });
    await assertRealDirectory(dir);
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".json")) continue;
      const job = designImageJobSchema.parse(
        JSON.parse(await readFile(path.join(dir, file), "utf8")),
      );
      if (file !== job.id + ".json")
        throw new Error("Görsel iş kaydı geçersiz.");
      if (job.status === "running") {
        job.status = "failed";
        job.uncertainCostUsd += job.reservedUsd;
        job.reservedUsd = 0;
        job.error = "Worker yeniden başladı. Ücret belirsiz; rezerv korunuyor.";
        await this.persist(job);
      }
      this.jobs.set(job.id, job);
    }
  }
  async start(input: unknown) {
    const request = designImageRequestSchema.parse(input);
    const { project, screenId, brief, requestId, expectedLatestId } = request;
    const duplicate = this.jobs.get(requestId);
    if (duplicate) {
      if (duplicate.projectId !== project.id || duplicate.screenId !== screenId)
        throw new Error("İstek kimliği başka bir işe ait.");
      return duplicate;
    }
    if (!this.enabled)
      throw new Error("Görsel üretimi için OPENAI_API_KEY gerekli.");
    if (this.locked)
      throw new Error("Bir görsel üretiliyor. Tamamlanmasını bekleyin.");
    if (!["design", "development", "tests", "build"].includes(project.stage))
      throw new Error("Önce ekranları onaylayın.");
    const spec = getSpecification(project);
    const screen = getScreens(spec).find((s) => s.id === screenId && s.enabled);
    if (!screen) throw new Error("Seçili ekran bulunamadı.");
    const previous = this.list(project.id).filter(
      (j) => j.revision === spec.revision && j.screenId === screenId,
    );
    if ((previous.at(-1)?.id ?? null) !== expectedLatestId)
      throw new Error(
        "Bu ekran başka bir sekmede güncellendi. Güncel sonucu bekleyin.",
      );
    const references = designGenerationReferences(
      project,
      this.list(project.id),
      screenId,
    );
    if (project.designDraftApprovals?.revision === spec.revision) {
      for (const id of project.designDraftApprovals.assetIds) {
        const reference = this.jobs.get(id);
        if (
          !reference ||
          reference.projectId !== project.id ||
          reference.revision !== spec.revision ||
          reference.status !== "succeeded"
        )
          throw new Error(
            "Onaylı tasarım referansı bulunamadı. GitHub görsel eşitlemesini tamamlayın.",
          );
      }
    }
    const reservation = designImageReservation(references.length);
    if (
      Math.max(
        project.aiCost,
        this.otherSpend(project.id) + this.spent(project.id),
      ) +
        reservation >
      project.budgetLimit
    )
      throw new Error("Proje bütçesi yeni görsel için yetersiz.");
    const prompt = designImagePrompt(
      project,
      screenId,
      brief,
      references.map((reference) => ({
        assetId: reference.id,
        screenName: reference.screenName,
      })),
    );
    const job: DesignImageJob = {
      id: requestId,
      projectId: project.id,
      revision: spec.revision,
      screenId,
      screenName: screen.name,
      brief,
      status: "running",
      costUsd: 0,
      uncertainCostUsd: 0,
      reservedUsd: reservation,
      error: null,
      createdAt: new Date(
        Math.max(
          Date.now(),
          ...previous.map((j) => Date.parse(j.createdAt) + 1),
        ),
      ).toISOString(),
      model: imageModel,
      referenceAssetIds: references.map((reference) => reference.id),
    };
    this.locked = true;
    const referenceImages: DesignImageReference[] = [];
    try {
      for (const reference of references) {
        const file = path.join(
          this.root,
          "workspace/design-images",
          reference.id + ".png",
        );
        let png: Buffer;
        try {
          const info = await lstat(file);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 20_000_000)
            throw new Error("Invalid reference");
          png = await readFile(file);
          validateDesignPng(png);
        } catch {
          throw new Error(
            "Onaylı tasarım PNG dosyası eksik veya geçersiz. GitHub görsel eşitlemesini tamamlayın.",
          );
        }
        referenceImages.push({
          assetId: reference.id,
          screenName: reference.screenName,
          png,
        });
      }
      await this.persist(job);
      this.jobs.set(job.id, job);
    } catch (e) {
      this.locked = false;
      throw e;
    }
    void this.execute(job, prompt, referenceImages);
    return job;
  }
  private async execute(
    job: DesignImageJob,
    prompt: string,
    references: DesignImageReference[],
  ) {
    let accounted = false;
    try {
      const result = await this.run(prompt, this.key, undefined, references);
      if (result.costUsd === null) job.uncertainCostUsd = job.reservedUsd;
      else job.costUsd = result.costUsd;
      accounted = true;
      await writeFile(
        path.join(this.root, "workspace/design-images", job.id + ".png"),
        result.png,
        { flag: "wx", mode: 0o600 },
      );
      job.status = "succeeded";
    } catch (e) {
      if (!accounted) {
        if (e instanceof PlannerError && e.costUsd !== null)
          job.costUsd = e.costUsd;
        else job.uncertainCostUsd = job.reservedUsd;
      }
      job.status = "failed";
      job.error =
        e instanceof PlannerError
          ? e.message
          : "Görsel kaydedilemedi. Önceki dosyalar korunuyor.";
    } finally {
      job.reservedUsd = 0;
      try {
        await this.persist(job);
      } catch {
        job.status = "failed";
        job.error = "Görsel iş kaydı yazılamadı.";
      }
      if (job.status === "succeeded" && this.onSaved) {
        try {
          await this.onSaved(job.projectId);
          this.cloudError = null;
        } catch (error) {
          this.cloudError =
            error instanceof Error
              ? error.message
              : "Görsel GitHub'a gönderilemedi; yerel dosya korundu.";
        }
      }
      this.locked = false;
    }
  }
  async importPng(input: unknown) {
    const request = designImageUploadSchema.parse(input);
    const { project, screenId, requestId, expectedLatestId, pngBase64 } =
      request;
    const duplicate = this.jobs.get(requestId);
    if (duplicate) {
      if (duplicate.projectId !== project.id || duplicate.screenId !== screenId)
        throw new Error("İstek kimliği başka bir işe ait.");
      return duplicate;
    }
    if (this.locked)
      throw new Error("Bir görsel işleniyor. Tamamlanmasını bekleyin.");
    if (!["design", "development", "tests", "build"].includes(project.stage))
      throw new Error("Önce ekranları onaylayın.");
    const spec = getSpecification(project);
    const screen = getScreens(spec).find((s) => s.id === screenId && s.enabled);
    if (!screen) throw new Error("Seçili ekran bulunamadı.");
    const previous = this.list(project.id).filter(
      (j) => j.revision === spec.revision && j.screenId === screenId,
    );
    if ((previous.at(-1)?.id ?? null) !== expectedLatestId)
      throw new Error(
        "Bu ekran başka bir sekmede güncellendi. Güncel sonucu bekleyin.",
      );
    let png: Buffer;
    try {
      png = Buffer.from(pngBase64, "base64");
      validateDesignPng(png);
    } catch {
      throw new Error(
        "Yalnızca geçerli bir PNG dosyası yüklenebilir (en fazla 20 MB).",
      );
    }
    const job: DesignImageJob = {
      id: requestId,
      projectId: project.id,
      revision: spec.revision,
      screenId,
      screenName: screen.name,
      brief: "Yüklenen tasarım",
      status: "running",
      costUsd: 0,
      uncertainCostUsd: 0,
      reservedUsd: 0,
      error: null,
      createdAt: new Date(
        Math.max(
          Date.now(),
          ...previous.map((j) => Date.parse(j.createdAt) + 1),
        ),
      ).toISOString(),
      model: "upload",
      source: "upload",
      referenceAssetIds: [],
    };
    this.locked = true;
    try {
      await this.persist(job);
      this.jobs.set(job.id, job);
      await writeFile(
        path.join(this.root, "workspace/design-images", job.id + ".png"),
        png,
        { flag: "wx", mode: 0o600 },
      );
      job.status = "succeeded";
      await this.persist(job);
      if (this.onSaved) {
        try {
          await this.onSaved(job.projectId);
          this.cloudError = null;
        } catch (error) {
          this.cloudError =
            error instanceof Error
              ? error.message
              : "Görsel GitHub'a gönderilemedi; yerel dosya korundu.";
        }
      }
      return job;
    } catch (e) {
      job.status = "failed";
      job.error =
        e instanceof Error
          ? e.message
          : "Görsel kaydedilemedi. Önceki dosyalar korunuyor.";
      try {
        await this.persist(job);
      } catch {
        job.error = "Görsel iş kaydı yazılamadı.";
      }
      throw new Error(job.error);
    } finally {
      this.locked = false;
    }
  }
  async image(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.status !== "succeeded")
      throw new Error("Görsel bulunamadı.");
    return readFile(
      path.join(this.root, "workspace/design-images", job.id + ".png"),
    );
  }
}
