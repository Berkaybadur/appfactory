import { z } from "zod";
export const projectInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "En az 2 karakter girin.")
      .max(80, "En fazla 80 karakter kullanın."),
    type: z.literal("mobile"),
    android: z.boolean(),
    ios: z.boolean(),
    idea: z
      .string()
      .trim()
      .min(20, "Fikrinizi en az 20 karakterle açıklayın.")
      .max(5000, "En fazla 5.000 karakter kullanın."),
    budgetLimit: z
      .number({ error: "Geçerli bir bütçe girin." })
      .finite("Geçerli bir bütçe girin.")
      .min(0.01, "Bütçe en az 0,01 USD olmalıdır.")
      .max(1000, "V1 bütçeleri en fazla 1.000 USD olabilir."),
  })
  .refine((data) => data.android || data.ios, {
    message: "En az bir platform seçin.",
    path: ["android"],
  });
export type ProjectInput = z.infer<typeof projectInputSchema>;
export const stageSchema = z.enum([
  "idea",
  "plan",
  "screens",
  "design",
  "development",
  "tests",
  "build",
]);
export type Stage = z.infer<typeof stageSchema>;
export const planSchema = z.object({
  summary: z
    .string()
    .trim()
    .min(20, "Özet en az 20 karakter olmalıdır.")
    .max(5000, "Özet en fazla 5.000 karakter olabilir."),
  scope: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(300, "Her madde en fazla 300 karakter olabilir."),
    )
    .min(1, "En az bir kapsam maddesi girin.")
    .max(20, "En fazla 20 madde girin."),
  outOfScope: z
    .string()
    .trim()
    .max(2000, "Kapsam dışı açıklaması en fazla 2.000 karakter olabilir."),
});
const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "#RRGGBB biçiminde bir renk girin.");
export const designSchema = z.object({
  background: colorSchema,
  text: colorSchema,
  primary: colorSchema,
  radius: z
    .number({ error: "Geçerli bir köşe değeri girin." })
    .int("Tam sayı girin.")
    .min(0, "Köşe değeri en az 0 olmalıdır.")
    .max(24, "Köşe değeri en fazla 24 olabilir."),
  spacing: z
    .number({ error: "Geçerli bir boşluk değeri girin." })
    .int("Tam sayı girin.")
    .min(8, "Boşluk en az 8 olmalıdır.")
    .max(32, "Boşluk en fazla 32 olabilir."),
});
export const screenIds = [
  "home",
  "create",
  "details",
  "settings",
  "register",
] as const;
export const screenIdSchema = z.union([
  z.enum(screenIds),
  z.string().regex(/^custom-[a-z0-9-]{1,50}$/, "Geçersiz ekran kimliği."),
]);
export function screenFile(id: string): string {
  screenIdSchema.parse(id);
  const builtins: Record<string, string> = {
    home: "app/index.tsx",
    create: "app/create.tsx",
    details: "app/items/[id].tsx",
    settings: "app/settings.tsx",
    register: "app/register.tsx",
  };
  return builtins[id] ?? `app/${id}.tsx`;
}
export const screensSchema = z
  .array(
    z.object({
      id: screenIdSchema,
      enabled: z.boolean(),
      name: z.string().trim().min(1, "Ekran adı boş olamaz.").max(60),
      description: z.string().trim().max(500),
    }),
  )
  .min(1)
  .max(20, "En fazla 20 ekran ekleyebilirsiniz.")
  .refine(
    (s) => new Set(s.map((x) => x.id)).size === s.length,
    "Her ekran bir kez tanımlanmalıdır.",
  )
  .refine(
    (s) => s.some((x) => x.id === "home" && x.enabled),
    "Ana ekran zorunludur.",
  );
export type ScreenDefinition = z.infer<typeof screensSchema>[number];
export const defaultScreens: ScreenDefinition[] = [
  {
    id: "home",
    enabled: true,
    name: "Ana ekran",
    description: "Kayıtlarınızı buradan takip edin.",
  },
  {
    id: "create",
    enabled: true,
    name: "Kayıt oluştur",
    description: "Yeni kaydınızın başlığını ve notlarını girin.",
  },
  {
    id: "details",
    enabled: true,
    name: "Kayıt ayrıntıları",
    description: "Kaydınızı inceleyin ve düzenleyin.",
  },
  {
    id: "settings",
    enabled: true,
    name: "Ayarlar",
    description: "Uygulama ve yerel veriler hakkında bilgiler.",
  },
  {
    id: "register",
    enabled: false,
    name: "Kayıt ol",
    description: "Hesap oluşturma arayüzü prototipi.",
  },
];
export function getScreens(specification: { screens?: ScreenDefinition[] }) {
  return specification.screens ?? defaultScreens;
}
export const specificationSchema = z.object({
  revision: z.number().int().nonnegative(),
  plan: planSchema,
  screens: screensSchema.optional(),
  design: designSchema,
});
export type Specification = z.infer<typeof specificationSchema>;
export type SpecificationSection = "plan" | "screens" | "design";
const revisionSchema = z.object({
  specification: specificationSchema,
  changedSection: z.enum(["plan", "screens", "design"]),
  savedAt: z.iso.datetime(),
});
export const previewScreenIds = [
  "home",
  "create",
  "details",
  "settings",
] as const;
export const designReviewSchema = z.object({
  images: z
    .array(
      z.object({
        screenId: screenIdSchema,
        assetId: z.uuid(),
        sourceRevision: z.number().int().nonnegative(),
      }),
    )
    .max(20)
    .optional(),
  revision: z.number().int().nonnegative(),
  screens: z
    .array(screenIdSchema)
    .min(1)
    .max(20)
    .refine((s) => new Set(s).size === s.length, "Ekranlar tekrarlanamaz."),
  reviewedAt: z.iso.datetime(),
});
// Planner drafts are proposals; the deterministic workflow still requires approval.
export const plannerOutputSchema = z.object({
  plan: planSchema,
  screens: screensSchema,
  design: designSchema,
  screenNotes: z
    .array(
      z.object({
        screenId: screenIdSchema,
        fields: z.array(z.string().trim().min(1).max(150)).max(12),
        actions: z.array(z.string().trim().min(1).max(200)).max(8),
      }),
    )
    .max(20),
  tasks: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(150),
        description: z.string().trim().min(1).max(1000),
        acceptance: z.array(z.string().trim().min(1).max(300)).min(1).max(6),
      }),
    )
    .min(1)
    .max(15),
  limitations: z.array(z.string().trim().min(1).max(500)).max(10),
});
export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

export const projectSchema = projectInputSchema.safeExtend({
  id: z.string().min(1),
  stage: stageSchema,
  aiCost: z.number().nonnegative(),
  updatedAt: z.iso.datetime(),
  specification: specificationSchema.optional(),
  designReview: designReviewSchema.optional(),
  designDraftApprovals: z
    .object({
      revision: z.number().int().nonnegative(),
      assetIds: z
        .array(z.uuid())
        .max(20)
        .refine(
          (ids) => new Set(ids).size === ids.length,
          "Görseller tekrarlanamaz.",
        ),
    })
    .optional(),
  plannerJobId: z.string().optional(),
  plannerDraft: plannerOutputSchema.optional(),
  revisions: z.array(revisionSchema).max(20).optional(),
});
export type Project = z.infer<typeof projectSchema>;
export const storedProjectsSchema = z.object({
  version: z.literal(1),
  projects: z.array(projectSchema),
});

export const projectIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/);
export const jobStatusSchema = z.enum([
  "queued",
  "generating",
  "generated",
  "validating",
  "ready",
  "failed",
]);
export const checkSchema = z.object({
  name: z.enum(["install", "typecheck", "lint"]),
  status: z.enum(["pending", "running", "passed", "failed"]),
  output: z.string(),
  exitCode: z.number().nullable(),
  durationMs: z.number().nonnegative(),
});
export const generationJobSchema = z.object({
  id: z.uuid(),
  projectId: projectIdSchema,
  project: projectSchema,
  status: jobStatusSchema,
  operation: z.enum(["generate", "validate"]),
  outputPath: z.string(),
  files: z.array(z.string()),
  checks: z.array(checkSchema),
  validationAttempts: z.number().int().min(0).max(3),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type GenerationJob = z.infer<typeof generationJobSchema>;
export type JobCheck = z.infer<typeof checkSchema>;
export const generationRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("generate"),
    project: projectSchema.safeExtend({ id: projectIdSchema }),
  }),
  z.object({ action: z.literal("validate"), projectId: projectIdSchema }),
]);

export function getSpecification(project: Project): Specification {
  return (
    project.specification ?? {
      revision: 0,
      plan: {
        summary: project.idea,
        scope: [
          "Tek bir temel iş akışı",
          "Yerel veri saklama",
          "Sade gezinme ve erişilebilir form alanları",
        ],
        outOfScope: "Ödemeler, sosyal özellikler ve oyunlar.",
      },
      design: {
        background: "#FAFAFA",
        text: "#171717",
        primary: "#2563EB",
        radius: 8,
        spacing: 16,
      },
    }
  );
}
export function sameSpecification(a: Project, b: Project) {
  return (
    JSON.stringify(getSpecification(a)) === JSON.stringify(getSpecification(b))
  );
}
export function editProjectOverview(
  project: Project,
  input: unknown,
  expected: Project,
  now = new Date().toISOString(),
): Project {
  if (
    JSON.stringify(projectInputSchema.parse(project)) !==
      JSON.stringify(projectInputSchema.parse(expected)) ||
    !sameSpecification(project, expected) ||
    project.stage !== expected.stage
  )
    throw new Error("Proje değişti. Güncel bilgileri yükleyip tekrar deneyin.");
  const next = projectInputSchema.parse(input);
  const currentInput = projectInputSchema.parse(project);
  if (JSON.stringify(next) === JSON.stringify(currentInput)) return project;
  const contentChanged =
    next.name !== project.name ||
    next.idea !== project.idea ||
    next.android !== project.android ||
    next.ios !== project.ios;
  if (!contentChanged) return { ...project, ...next, updatedAt: now };
  const current = getSpecification(project);
  return {
    ...project,
    ...next,
    stage: project.stage === "idea" ? "idea" : "plan",
    specification: {
      ...current,
      revision: current.revision + 1,
      plan: project.specification
        ? current.plan
        : { ...current.plan, summary: next.idea },
    },
    designReview: undefined,
    plannerJobId: undefined,
    plannerDraft: undefined,
    revisions: [
      ...(project.revisions ?? []),
      {
        specification: current,
        changedSection: "plan" as const,
        savedAt: now,
      },
    ].slice(-20),
    updatedAt: now,
  };
}
export function reviseProject(
  project: Project,
  section: SpecificationSection,
  input: unknown,
  expectedRevision: number,
  now = new Date().toISOString(),
): Project {
  const current = getSpecification(project);
  if (current.revision !== expectedRevision)
    throw new Error(
      "Bu proje başka bir sekmede değişti. Sayfayı yenileyip tekrar deneyin.",
    );
  const next = {
    ...current,
    [section]:
      section === "plan"
        ? planSchema.parse(input)
        : section === "screens"
          ? screensSchema.parse(input)
          : designSchema.parse(input),
  };
  if (JSON.stringify(next) === JSON.stringify(current)) return project;
  next.revision++;
  const stages = [
    "idea",
    "plan",
    "screens",
    "design",
    "development",
    "tests",
    "build",
  ];
  const stage =
    stages.indexOf(project.stage) > stages.indexOf(section)
      ? section
      : project.stage;
  return {
    ...project,
    specification: next,
    designReview: undefined,
    revisions: [
      ...(project.revisions ?? []),
      { specification: current, changedSection: section, savedAt: now },
    ].slice(-20),
    stage,
    updatedAt: now,
  };
}

export function approveVisualDesign(
  project: Project,
  screens: readonly string[],
  expectedRevision: number,
): Project {
  if (project.stage !== "design")
    throw new Error("Tasarım onay aşamasında olmalısınız.");
  if (getSpecification(project).revision !== expectedRevision)
    throw new Error("Sürüm değişti. Güncel ekranları yeniden inceleyin.");
  const required = getScreens(getSpecification(project))
    .filter((s) => s.enabled)
    .map((s) => s.id);
  if (
    screens.length !== required.length ||
    !required.every((id) => screens.includes(id))
  )
    throw new Error("Seçilen ekranların tamamını inceleyin.");
  const review = designReviewSchema.parse({
    revision: expectedRevision,
    screens,
    reviewedAt: new Date().toISOString(),
  });
  return {
    ...project,
    stage: "development",
    designReview: review,
    updatedAt: review.reviewedAt,
  };
}

export const plannerJobSchema = z.object({
  id: z.uuid(),
  projectId: projectIdSchema,
  baseRevision: z.number().int().nonnegative(),
  input: projectInputSchema,
  priorCostUsd: z.number().nonnegative(),
  status: z.enum(["running", "succeeded", "failed"]),
  attempts: z.number().int().min(1).max(3),
  costUsd: z.number().nonnegative(),
  reservedUsd: z.number().nonnegative(),
  uncertainCostUsd: z.number().nonnegative(),
  taskLimitUsd: z.number().positive(),
  model: z.string(),
  output: plannerOutputSchema.nullable(),
  error: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type PlannerJob = z.infer<typeof plannerJobSchema>;

export function applyPlannerResult(project: Project, job: PlannerJob): Project {
  if (project.id !== job.projectId || job.status !== "succeeded" || !job.output)
    throw new Error("Tamamlanmış AI taslağı bulunamadı.");
  if (project.plannerJobId === job.id) return project;
  const current = getSpecification(project);
  if (current.revision !== job.baseRevision)
    throw new Error(
      "Proje analizden sonra değişti. Eski AI taslağı uygulanmadı.",
    );
  const output = plannerOutputSchema.parse(job.output);
  return {
    ...project,
    stage: "plan",
    specification: {
      revision: current.revision + 1,
      plan: output.plan,
      screens: output.screens,
      design: output.design,
    },
    designReview: undefined,
    plannerJobId: job.id,
    plannerDraft: output,
    aiCost: Math.max(
      project.aiCost,
      job.priorCostUsd + job.costUsd + job.uncertainCostUsd,
    ),
    revisions: [
      ...(project.revisions ?? []),
      {
        specification: current,
        changedSection: "plan" as const,
        savedAt: new Date().toISOString(),
      },
    ].slice(-20),
    updatedAt: new Date().toISOString(),
  };
}

// Fixed keys guarantee every supported screen appears once. The application
// continues to store its existing array representation.
const plannerScreenWire = screensSchema.element.omit({ id: true });
export const plannerWireSchema = plannerOutputSchema.extend({
  screens: z.object({
    home: plannerScreenWire.extend({ enabled: z.literal(true) }),
    create: plannerScreenWire,
    details: plannerScreenWire,
    settings: plannerScreenWire,
    register: plannerScreenWire,
  }),
});
export function plannerJsonSchema() {
  const schema = z.toJSONSchema(plannerWireSchema);
  delete schema.$schema;
  return schema;
}
export function parsePlannerWire(input: unknown) {
  const parsed = plannerWireSchema.safeParse(input);
  if (!parsed.success) return parsed;
  return plannerOutputSchema.safeParse({
    ...parsed.data,
    screens: screenIds.map((id) => ({ id, ...parsed.data.screens[id] })),
  });
}

export const designImageJobSchema = z.object({
  id: z.uuid(),
  projectId: projectIdSchema,
  revision: z.number().int().nonnegative(),
  screenId: screenIdSchema,
  screenName: z.string(),
  brief: z.string().max(1000),
  status: z.enum(["running", "succeeded", "failed"]),
  costUsd: z.number().nonnegative(),
  reservedUsd: z.number().nonnegative(),
  uncertainCostUsd: z.number().nonnegative(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  model: z.string(),
  referenceAssetIds: z.array(z.uuid()).max(20).optional(),
});
export type DesignImageJob = z.infer<typeof designImageJobSchema>;
// Reserve additional budget for the image inputs; actual usage is accounted separately.
export function designImageReservation(referenceCount: number) {
  return Math.round((0.2 + referenceCount * 0.05) * 100) / 100;
}
export function approvedDesignReferences(
  project: Project,
  jobs: DesignImageJob[],
  targetScreenId?: string,
) {
  const spec = getSpecification(project);
  const approvals = project.designDraftApprovals;
  if (approvals?.revision !== spec.revision) return [];
  const latest = new Map<string, DesignImageJob>();
  for (const job of jobs) {
    if (job.projectId !== project.id || job.revision !== spec.revision)
      continue;
    const previous = latest.get(job.screenId);
    if (!previous || job.createdAt >= previous.createdAt)
      latest.set(job.screenId, job);
  }
  const enabled = new Set(
    getScreens(spec)
      .filter((screen) => screen.enabled)
      .map((screen) => screen.id),
  );
  return approvals.assetIds.flatMap((id) => {
    const job = jobs.find((candidate) => candidate.id === id);
    return job &&
      job.projectId === project.id &&
      job.revision === spec.revision &&
      job.status === "succeeded" &&
      job.screenId !== targetScreenId &&
      enabled.has(job.screenId) &&
      latest.get(job.screenId)?.id === id
      ? [job]
      : [];
  });
}
export function designGenerationReferences(
  project: Project,
  jobs: DesignImageJob[],
  targetScreenId: string,
) {
  const approved = approvedDesignReferences(project, jobs, targetScreenId);
  const home = approved.find((job) => job.screenId === "home");
  const recent = approved.filter((job) => job.screenId !== "home").slice(-2);
  return home ? [home, ...recent] : recent;
}
export const designImageRequestSchema = z.object({
  project: projectSchema.safeExtend({ id: projectIdSchema }),
  screenId: screenIdSchema,
  brief: z.string().trim().max(1000),
  requestId: z.uuid(),
  expectedLatestId: z.uuid().nullable(),
});
export function approveImageDesign(
  project: Project,
  jobs: DesignImageJob[],
  reviewedIds: string[],
): Project {
  const spec = getSpecification(project);
  const selected = getScreens(spec).filter((s) => s.enabled);
  const images = selected.map((screen) => {
    const candidates = jobs.filter(
      (j) =>
        j.projectId === project.id &&
        j.revision === spec.revision &&
        j.screenId === screen.id,
    );
    const job = candidates.at(-1);
    if (!job || job.status !== "succeeded" || !reviewedIds.includes(job.id))
      throw new Error("Her ekranın en güncel görselini inceleyip onaylayın.");
    return {
      screenId: screen.id,
      assetId: job.id,
      sourceRevision: job.revision,
    };
  });
  if (!["design", "development", "tests", "build"].includes(project.stage))
    throw new Error("Önce plan ve ekran onaylarını tamamlayın.");
  const now = new Date().toISOString();
  return {
    ...project,
    stage: "development",
    specification: { ...spec, revision: spec.revision + 1 },
    designReview: {
      revision: spec.revision + 1,
      screens: selected.map((s) => s.id),
      reviewedAt: now,
      images,
    },
    revisions: [
      ...(project.revisions ?? []),
      { specification: spec, changedSection: "design" as const, savedAt: now },
    ].slice(-20),
    updatedAt: now,
  };
}

export const builderOutputSchema = z.object({
  code: z.string().min(20).max(50000),
  summary: z.string().min(1).max(1500),
  limitations: z.array(z.string().max(500)).max(12),
});
export function builderJsonSchema() {
  const schema = z.toJSONSchema(builderOutputSchema);
  delete schema.$schema;
  return schema;
}
export const builderModelSchema = z.enum([
  "gpt-6-luna",
  "gpt-4.1-mini",
  "gpt-5-mini",
]);
export const builderRetryApprovalSchema = z.object({
  confirmed: z.literal(true),
  model: builderModelSchema,
  jobId: z.uuid(),
  expectedAttempts: z.number().int().nonnegative(),
});
export const builderTaskSchema = z.object({
  kind: z.enum(["features", "screen"]).optional(),
  screenId: screenIdSchema,
  name: z.string(),
  status: z.enum(["pending", "running", "ready", "failed"]),
  attempts: z.number().int().nonnegative(),
  attemptLimit: z.number().int().min(3).optional(),
  model: builderModelSchema.optional(),
  costUsd: z.number().nonnegative(),
  reservedUsd: z.number().nonnegative(),
  uncertainCostUsd: z.number().nonnegative(),
  summary: z.string(),
  limitations: z.array(z.string()),
  log: z.string(),
});
export const codeChangeSchema = z.object({
  sourceJobId: z.uuid(),
  screenId: screenIdSchema,
  instruction: z.string().trim().min(5).max(2000),
});
export const revisionRequestSchema = z.object({
  project: projectSchema.safeExtend({ id: projectIdSchema }),
  requestId: z.uuid(),
  change: codeChangeSchema,
  retry: z.boolean().default(false),
});
export const builderJobSchema = z.object({
  applicationPrepared: z.boolean().optional(),
  mode: z.enum(["application", "screens"]).optional(),
  implementation: z
    .object({
      summary: z.string(),
      files: z.array(z.string()),
      checks: z.array(z.object({ name: z.string(), passed: z.boolean() })),
      setup: z.array(z.string()),
      coverage: z.array(
        z.object({
          requirement: z.string(),
          status: z.enum(["implemented", "needs_setup", "unsupported"]),
          detail: z.string(),
        }),
      ),
    })
    .optional(),
  change: codeChangeSchema.optional(),
  id: z.uuid(),
  project: projectSchema.safeExtend({ id: projectIdSchema }),
  status: z.enum(["running", "failed", "ready"]),
  outputPath: z.string(),
  setupAttempts: z.number().int().min(0).max(3),
  installed: z.boolean(),
  tasks: z.array(builderTaskSchema).min(1).max(21),
  error: z.string().nullable(),
  setupLog: z.string(),
  createdAt: z.iso.datetime(),
});
export type BuilderJob = z.infer<typeof builderJobSchema>;
export type BuilderTask = z.infer<typeof builderTaskSchema>;
export type BuilderOutput = z.infer<typeof builderOutputSchema>;

export const easJobSchema = z.object({
  id: z.uuid(),
  projectId: projectIdSchema,
  sourceJobId: z.uuid(),
  revision: z.number().int().nonnegative(),
  outputPath: z.string(),
  status: z.enum([
    "preparing",
    "submitting",
    "unknown",
    "needs_setup",
    "queued",
    "building",
    "finished",
    "failed",
    "canceled",
  ]),
  easProjectId: z.uuid().nullable(),
  buildId: z.uuid().nullable(),
  owner: z.string().nullable(),
  slug: z.string().nullable(),
  apkUrl: z.url().nullable(),
  error: z.string().nullable(),
  log: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deviceTest: z.enum(["not_tested", "passed"]),
  completedAt: z.iso.datetime().optional(),
  sourceFingerprint: z.string().optional(),
});
export type EasJob = z.infer<typeof easJobSchema>;
export const releaseChecklistSchema = z.object({
  fingerprint: z.string(),
  items: z.array(
    z.object({ id: z.string(), label: z.string(), checked: z.boolean() }),
  ),
  ready: z.boolean(),
});
export type ReleaseChecklist = z.infer<typeof releaseChecklistSchema>;
export const easRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("checklist"),
    project: projectSchema,
    sourceJobId: z.uuid(),
  }),
  z.object({
    action: z.literal("check-item"),
    project: projectSchema,
    sourceJobId: z.uuid(),
    fingerprint: z.string(),
    itemId: z.string(),
    checked: z.boolean(),
  }),
  z.object({
    action: z.literal("complete"),
    project: projectSchema,
    sourceJobId: z.uuid(),
    jobId: z.uuid(),
    confirmed: z.literal(true),
  }),
  z.object({
    action: z.literal("start"),
    project: projectSchema.safeExtend({ id: projectIdSchema }),
    sourceJobId: z.uuid(),
    requestId: z.uuid(),
    expectedLatestId: z.uuid().nullable(),
  }),
  z.object({
    action: z.literal("refresh"),
    projectId: projectIdSchema,
    jobId: z.uuid(),
  }),
  z.object({
    action: z.literal("reconcile"),
    projectId: projectIdSchema,
    jobId: z.uuid(),
    buildId: z.uuid(),
  }),
]);

export const previewSessionSchema = z.object({
  id: z.uuid(),
  projectId: projectIdSchema,
  sourceJobId: z.uuid(),
  status: z.enum(["starting", "ready", "stopped", "failed"]),
  url: z.string().nullable(),
  sdkVersion: z.string().nullable(),
  error: z.string().nullable(),
  log: z.string(),
  fingerprint: z.string(),
  createdAt: z.iso.datetime(),
});
export type PreviewSession = z.infer<typeof previewSessionSchema>;
export const previewApprovalSchema = z.object({
  projectId: projectIdSchema,
  sourceJobId: z.uuid(),
  sessionId: z.uuid(),
  fingerprint: z.string(),
  approvedAt: z.iso.datetime(),
  platforms: z.array(z.enum(["ios", "android"])).min(1),
});
export type PreviewApproval = z.infer<typeof previewApprovalSchema>;
export const previewRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    project: projectSchema.safeExtend({ id: projectIdSchema }),
    sourceJobId: z.uuid(),
  }),
  z.object({
    action: z.literal("stop"),
    projectId: projectIdSchema,
    sessionId: z.uuid(),
  }),
  z.object({
    action: z.literal("approve"),
    project: projectSchema.safeExtend({ id: projectIdSchema }),
    sourceJobId: z.uuid(),
    sessionId: z.uuid(),
    platforms: z.array(z.enum(["ios", "android"])).min(1),
  }),
]);

// App implementation is a bounded multi-file artifact. Configuration and package
// installation remain deterministic worker responsibilities.
export const featureFiles = [
  "src/features/models.ts",
  "src/features/domain.ts",
  "src/features/store.tsx",
  "src/features/services.ts",
] as const;
export const featureOutputSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.enum(featureFiles),
        code: z.string().min(10).max(50000),
      }),
    )
    .length(4),
  summary: z.string().min(1).max(2000),
  limitations: z.array(z.string().min(1).max(500)).max(15),
  capabilities: z
    .array(z.enum(["storage", "backend", "location", "camera", "maps"]))
    .max(5),
  migrationSql: z.string().max(50000),
  setup: z.array(z.string().min(1).max(1000)).max(15),
  coverage: z
    .array(
      z.object({
        requirement: z.string().min(1).max(500),
        status: z.enum(["implemented", "needs_setup", "unsupported"]),
        detail: z.string().min(1).max(1000),
      }),
    )
    .min(1)
    .max(30),
  tests: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        exportName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
        argsJson: z.string().max(10000),
        expectedJson: z.string().max(10000),
      }),
    )
    .min(3)
    .max(30),
});
export type FeatureOutput = z.infer<typeof featureOutputSchema>;
export function featureJsonSchema() {
  const schema = z.toJSONSchema(featureOutputSchema);
  delete schema.$schema;
  return schema;
}

export const featureRepairSchema = featureOutputSchema
  .pick({ summary: true })
  .extend({
    files: z.array(featureOutputSchema.shape.files.element).min(1).max(4),
  });

export function featureRepairJsonSchema() {
  const schema = z.toJSONSchema(featureRepairSchema);
  delete schema.$schema;
  return schema;
}
