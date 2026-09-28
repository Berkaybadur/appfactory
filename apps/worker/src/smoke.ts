import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertDesignAssets,
  assertRealDirectory,
} from "@app-factory/generator";
import {
  PlannerError,
  runSmokeReviewer,
  builderReservationUsd,
} from "@app-factory/ai";
import {
  getScreens,
  getSpecification,
  smokeReportSchema,
  smokeRequestSchema,
  projectSchema,
  type Project,
  type SmokeReport,
  type SmokeCheck,
  type BuilderJob,
} from "@app-factory/schemas";
import { sourceFingerprint } from "./preview";
import { validateDesignPng } from "./design-github";
import type { EasSource } from "./eas";

export function smokePassed(report: SmokeReport | undefined) {
  return (
    !!report &&
    report.status === "review" &&
    report.checks.length > 0 &&
    report.checks.every((check) => check.status === "passed") &&
    !!report.reviewedAt &&
    !report.repairJobId
  );
}
export function smokePlatforms(project: Project) {
  return (["android", "ios"] as const).filter((p) => project[p]);
}
export function smokeCases(
  project: Project,
  phase: SmokeReport["phase"],
): SmokeCheck[] {
  const screens = getScreens(getSpecification(project)).filter(
    (s) => s.enabled,
  );
  const cases =
    phase === "design"
      ? screens.map((s) => ({
          screenId: s.id,
          title: s.name + " — tasarım karşılaştırması",
          expected:
            "Onaylı tasarım ile aynı yerleşim, tipografi, renk, boşluk ve bileşenler.",
        }))
      : [
          ...screens.map((s) => ({
            screenId: s.id,
            title: s.name + " temel akışı",
            expected:
              (s.description || s.name) +
              " — Ekrana ulaşın, temel eylemi gerçekleştirin ve sonucu doğrulayın.",
          })),
          ...getSpecification(project).plan.scope.map((s) => ({
            screenId: "home",
            title: "Kapsam doğrulaması",
            expected: s,
          })),
          ...(project.plannerDraft?.tasks ?? []).flatMap((t) =>
            t.acceptance.map((a) => ({
              screenId: "home",
              title: t.title,
              expected: a,
            })),
          ),
          {
            screenId: "home",
            title: "Veri kalıcılığı ve hata durumları",
            expected:
              "Veri oluşturma/düzenleme, uygulamayı kapatıp açma, boş durum, geçersiz giriş ve bağlantı hatası davranışlarını doğrulayın. Projede bulunmayan işlemleri sonuç notunda belirtin.",
          },
        ];
  if (cases.length > 100)
    throw new Error("Smoke testi en fazla 100 kontrol maddesi destekliyor.");
  return cases.map((c, index) => ({
    ...c,
    id: String(index),
    status: "pending",
    actual: "Henüz test edilmedi.",
    steps: [],
    evidence: [],
  }));
}

export class SmokeManager {
  readonly reports = new Map<string, SmokeReport>();
  private locked = false;
  get busy() {
    return this.locked;
  }
  get enabled() {
    return !!this.key.trim();
  }
  constructor(
    private root: string,
    private resolve: (project: Project, id: string) => EasSource,
    private revise: (input: unknown) => Promise<BuilderJob>,
    private otherSpend: (id: string) => number = () => 0,
    private key = process.env.OPENAI_API_KEY ?? "",
    private review = runSmokeReviewer,
    private previewReady: (
      project: Project,
      id: string,
      platform: "android" | "ios",
    ) => Promise<void> = async () => {},
  ) {}
  list(projectId: string) {
    return [...this.reports.values()]
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  spent(projectId: string) {
    return this.list(projectId).reduce(
      (n, r) => n + r.costUsd + r.reservedUsd + r.uncertainCostUsd,
      0,
    );
  }
  private async persist(report: SmokeReport) {
    const file = path.join(this.root, "workspace/smoke", report.id + ".json");
    await writeFile(file + ".tmp", JSON.stringify(report), { mode: 0o600 });
    await rename(file + ".tmp", file);
  }
  async initialize() {
    const dir = path.join(this.root, "workspace/smoke");
    await mkdir(dir, { recursive: true });
    await assertRealDirectory(dir);
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".json")) continue;
      const report = smokeReportSchema.parse(
        JSON.parse(await readFile(path.join(dir, file), "utf8")),
      );
      if (file !== report.id + ".json")
        throw new Error("Smoke kaydı geçersiz.");
      if (report.status === "running") {
        report.status = "failed";
        report.uncertainCostUsd += report.reservedUsd;
        report.reservedUsd = 0;
        report.error = "Worker yeniden başladı. Smoke testi yeniden başlatın.";
        await this.persist(report);
      }
      this.reports.set(report.id, report);
    }
  }
  private async context(project: Project, id: string) {
    project = projectSchema.parse(project);
    const source = this.resolve(project, id);
    if (
      JSON.stringify(project.designReview) !==
      JSON.stringify(projectSchema.parse(source.project).designReview)
    )
      throw new Error(
        "Kod çıktısının onaylı tasarım referansları ile proje uyuşmuyor. Güncel çıktıyı seçin.",
      );
    const cwd = path.resolve(this.root, source.outputPath);
    if (
      cwd !==
      path.join(this.root, "workspace/generated-projects", project.id, id)
    )
      throw new Error("Çıktı yolu geçersiz.");
    await assertRealDirectory(cwd);
    const hash = createHash("sha256")
      .update(await sourceFingerprint(cwd))
      .update(JSON.stringify(getSpecification(project)))
      .update(JSON.stringify(project.designReview ?? null))
      .update(JSON.stringify(project.plannerDraft?.tasks ?? []))
      .update(JSON.stringify(smokePlatforms(project)));
    await assertDesignAssets(this.root, project);
    for (const ref of project.designReview?.images ?? [])
      hash.update(
        await readFile(
          path.join(this.root, "workspace/design-images", ref.assetId + ".png"),
        ),
      );
    return { fingerprint: hash.digest("hex") };
  }
  async info(project: Project, id: string) {
    const { fingerprint } = await this.context(project, id);
    const reports = this.list(project.id).filter((r) => r.sourceJobId === id);
    const current = reports.filter((r) => r.fingerprint === fingerprint);
    const platforms = smokePlatforms(project);
    const approved = (phase: SmokeReport["phase"]) =>
      platforms.length > 0 &&
      platforms.every((p) =>
        smokePassed(
          current.filter((r) => r.phase === phase && r.platform === p).at(-1),
        ),
      );
    const designApproved = approved("design");
    return {
      reports,
      fingerprint,
      platforms,
      designApproved,
      functionalApproved: designApproved && approved("functional"),
      busy: this.busy,
      enabled: this.enabled,
    };
  }
  async assertReady(project: Project, id: string) {
    const state = await this.info(project, id);
    if (!state.designApproved || !state.functionalApproved)
      throw new Error(
        "Önce güncel kodun tüm platformlardaki tasarım ve işlev smoke testlerini tamamlayıp raporlarını onaylayın.",
      );
  }
  async act(raw: unknown) {
    const input = smokeRequestSchema.parse(raw);
    if (input.action === "info")
      return this.info(input.project, input.sourceJobId);
    if (this.locked)
      throw new Error("Smoke testi veya düzeltme isteği sürüyor.");
    this.locked = true;
    let background = false;
    try {
      const state = await this.info(input.project, input.sourceJobId);
      if (input.action === "start") {
        if (!input.requestId) throw new Error("İstek kimliği gerekli.");
        const existing = this.reports.get(input.requestId);
        if (existing) {
          if (
            existing.projectId !== input.project.id ||
            existing.sourceJobId !== input.sourceJobId ||
            existing.phase !== input.phase ||
            existing.platform !== input.platform ||
            existing.fingerprint !== state.fingerprint
          )
            throw new Error("İstek kimliği başka teste ait.");
          return { ...state, busy: false };
        }
        if (!state.platforms.includes(input.platform))
          throw new Error("Bu platform projede seçili değil.");
        if (input.phase === "functional" && !state.designApproved)
          throw new Error(
            "Önce tüm platformların tasarım testlerini tamamlayıp sorunsuz raporları onaylayın.",
          );
        await this.previewReady(
          input.project,
          input.sourceJobId,
          input.platform,
        );
        if (input.phase === "design") {
          if (!this.enabled)
            throw new Error(
              "Tasarım karşılaştırması için OPENAI_API_KEY gerekli.",
            );
          const screens = getScreens(getSpecification(input.project)).filter(
            (s) => s.enabled,
          );
          if (
            input.project.designReview?.revision !==
              getSpecification(input.project).revision ||
            !screens.every((s) =>
              input.project.designReview?.images?.some(
                (r) => r.screenId === s.id,
              ),
            )
          )
            throw new Error(
              "Her ekran için güncel onaylı tasarım görseli gerekli.",
            );
        }
        const report: SmokeReport = {
          id: input.requestId,
          projectId: input.project.id,
          sourceJobId: input.sourceJobId,
          fingerprint: state.fingerprint,
          phase: input.phase,
          platform: input.platform,
          status: "draft",
          checks: smokeCases(input.project, input.phase),
          error: null,
          createdAt: new Date().toISOString(),
          reviewedAt: null,
          repairJobId: null,
          costUsd: 0,
          reservedUsd: 0,
          uncertainCostUsd: 0,
        };
        await this.persist(report);
        this.reports.set(report.id, report);
      } else {
        const report = this.reports.get(input.reportId ?? "");
        const latest = state.reports
          .filter(
            (r) =>
              r.phase === report?.phase &&
              r.platform === report?.platform &&
              r.fingerprint === state.fingerprint,
          )
          .at(-1);
        if (
          !report ||
          report.id !== latest?.id ||
          report.fingerprint !== input.fingerprint
        )
          throw new Error(
            "Rapor değişti veya güncel değil. Listeyi yenileyin.",
          );
        if (report.phase === "functional" && !state.designApproved)
          throw new Error(
            "Tasarım onayları geçersiz. Önce tasarım testlerini tamamlayın.",
          );
        if (input.action === "capture") {
          if (report.status !== "draft")
            throw new Error("Sonuç raporu değiştirilemez. Yeni test başlatın.");
          const check = report.checks.find((c) => c.id === input.checkId);
          if (!check) throw new Error("Kontrol maddesi bulunamadı.");
          if (
            report.phase === "functional" &&
            (!input.actual || !input.result || !input.steps?.length)
          )
            throw new Error("İşlev sonucu, gözlem ve test adımları gerekli.");
          if (report.phase === "design" && !input.pngBase64)
            throw new Error("Expo Go ekranının PNG görüntüsü gerekli.");
          if (input.pngBase64) {
            const png = Buffer.from(input.pngBase64, "base64");
            validateDesignPng(png);
            const dir = path.join(this.root, "workspace/smoke", report.id);
            await mkdir(dir, { recursive: true });
            await assertRealDirectory(dir);
            const file = `${report.checks.indexOf(check)}.png`;
            await writeFile(path.join(dir, file), png, { mode: 0o600 });
            check.evidence = [file];
          }
          if (report.phase === "functional") {
            check.actual = input.actual!;
            check.status = input.result!;
            check.steps = input.steps!;
          }
          await this.persist(report);
        } else if (input.action === "run") {
          if (report.status !== "draft")
            throw new Error("Bu test zaten raporlandı. Yeni test başlatın.");
          if (report.phase === "functional") {
            if (report.checks.some((c) => c.status === "pending"))
              throw new Error("Her kontrolün cihaz test sonucunu girin.");
            report.status = "review";
            await this.persist(report);
          } else {
            if (report.checks.some((c) => !c.evidence.length))
              throw new Error("Her ekranın Expo Go görüntüsünü ekleyin.");
            report.status = "running";
            await this.persist(report);
            background = true;
            void this.execute(input.project, report)
              .catch((error) => {
                console.error(
                  "Smoke raporu kaydedilemedi:",
                  error instanceof Error ? error.message : "Bilinmeyen hata",
                );
              })
              .finally(() => {
                this.locked = false;
              });
          }
        } else if (input.action === "approve") {
          if (
            report.status !== "review" ||
            !report.checks.length ||
            report.checks.some((c) => c.status !== "passed") ||
            report.repairJobId
          )
            throw new Error(
              "Sorunlu veya test edilemeyen maddeler onaylanamaz. Yeniden test edin.",
            );
          report.reviewedAt = new Date().toISOString();
          await this.persist(report);
        } else {
          if (report.status !== "review")
            throw new Error("Önce raporu oluşturup inceleyin.");
          const findings = report.checks.filter((c) => c.status === "failed");
          if (!findings.length)
            throw new Error(
              "Düzeltilecek hata bulunamadı. Test engellerini giderip yeniden deneyin.",
            );
          if (!input.requestId)
            throw new Error("Düzeltme istek kimliği gerekli.");
          if (report.repairJobId && report.repairJobId !== input.requestId)
            throw new Error(
              "Bu rapor için düzeltme başlatıldı. Yeni çıktıyı yeniden test edin.",
            );
          if (report.repairJobId === input.requestId)
            return { ...state, busy: false };
          const instruction =
            `Kullanıcı Expo Go ${report.platform} ${report.phase === "design" ? "tasarım" : "işlev"} smoke raporunu inceledi. Aşağıdaki gözlemlenen hataları düzelt. Onaylı tasarımları ve diğer işlevleri koru.\n` +
            findings
              .map(
                (f, i) =>
                  `${i + 1}. ${f.screenId}: ${f.title}\nBeklenen: ${f.expected}\nGözlenen: ${f.actual}\nAdımlar: ${f.steps.join("; ")}`,
              )
              .join("\n");
          if (instruction.length > 12000)
            throw new Error(
              "Bulgu listesi tek revizyon için çok uzun. Ekran bazlı revizyon uygulayın.",
            );
          const job = await this.revise({
            project: input.project,
            requestId: input.requestId,
            change: {
              sourceJobId: input.sourceJobId,
              screenId:
                report.phase === "design" &&
                new Set(findings.map((f) => f.screenId)).size === 1
                  ? findings[0]!.screenId
                  : "app",
              instruction,
            },
          });
          report.repairJobId = job.id;
          report.reviewedAt = new Date().toISOString();
          await this.persist(report);
        }
      }
    } finally {
      if (!background) this.locked = false;
    }
    return this.info(input.project, input.sourceJobId);
  }
  private async execute(project: Project, report: SmokeReport) {
    try {
      for (const check of report.checks) {
        const ref = project.designReview!.images!.find(
          (r) => r.screenId === check.screenId,
        )!;
        const reference = await readFile(
          path.join(this.root, "workspace/design-images", ref.assetId + ".png"),
        );
        const actual = await readFile(
          path.join(
            this.root,
            "workspace/smoke",
            report.id,
            check.evidence[0]!,
          ),
        );
        if (
          Math.max(
            project.aiCost,
            this.otherSpend(project.id) + this.spent(project.id),
          ) +
            builderReservationUsd >
          project.budgetLimit
        )
          throw new Error(
            "Smoke testi için proje bütçesi yetersiz. Tamamlanmayan maddeler başarılı sayılmadı.",
          );
        report.reservedUsd = builderReservationUsd;
        await this.persist(report);
        const result = await this.review(
          {
            context: JSON.stringify({
              phase: report.phase,
              platform: report.platform,
              screenId: check.screenId,
              title: check.title,
            }),
            images: [reference, actual],
          },
          this.key,
        );
        report.costUsd += result.costUsd;
        report.reservedUsd = 0;
        check.status = result.output.status;
        check.expected = result.output.expected;
        check.actual = result.output.actual;
        await this.persist(report);
      }
      if (
        (await this.context(project, report.sourceJobId)).fingerprint !==
        report.fingerprint
      )
        throw new Error(
          "Test sırasında kaynak değişti; rapor geçersiz. Yeniden test edin.",
        );
      report.status = "review";
    } catch (error) {
      if (report.reservedUsd) {
        if (error instanceof PlannerError && error.costUsd !== null)
          report.costUsd += error.costUsd;
        else report.uncertainCostUsd += report.reservedUsd;
        report.reservedUsd = 0;
      }
      report.status = "failed";
      report.error =
        error instanceof Error ? error.message : "Smoke testi başarısız.";
    } finally {
      await this.persist(report);
    }
  }
}
