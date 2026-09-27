"use client";
import { type BuilderJob } from "@app-factory/schemas";
import {
  createContext,
  useContext,
  useSyncExternalStore,
  useEffect,
  type ReactNode,
} from "react";
import { ProjectSync, type PendingProject } from "@app-factory/database";
import { supabase, projectRepository } from "@/lib/cloud-projects";
import { projectSchema } from "@app-factory/schemas";
import {
  projectInputSchema,
  editProjectOverview,
  applyPlannerResult,
  type PlannerJob,
  reviseProject,
  approveVisualDesign,
  getSpecification,
  type Specification,
  sameSpecification,
  type SpecificationSection,
  storedProjectsSchema,
  generationJobSchema,
  type Project,
  type ProjectInput,
  type GenerationJob,
} from "@app-factory/schemas";
import {
  mockProjects,
  transition,
  type WorkflowEvent,
} from "@app-factory/shared";
const KEY = "app-factory.projects.v1";
type Snapshot = { projects: Project[]; ready: boolean; error: string | null };
type Store = Snapshot & {
  cloud: CloudState;
  importLocalProjects: () => void;
  retryCloud: () => void;
  downloadPending: () => void;
  loadCloudVersion: () => Promise<void>;
  restoreLocalProject: (id: string) => Promise<void>;
  applyImageApproval: (project: Project, expectedRevision: number) => void;
  syncImageCost: (id: string, cost: number) => void;
  applyPlanner: (job: PlannerJob) => void;
  syncPlannerCost: (job: PlannerJob) => void;
  approveDesign: (
    id: string,
    screens: readonly string[],
    revision: number,
  ) => void;
  create: (input: ProjectInput) => string;
  editOverview: (id: string, input: ProjectInput, expected: Project) => void;
  advance: (id: string, event: WorkflowEvent) => void;
  syncGeneration: (job: GenerationJob) => void;
  syncBuilder: (job: BuilderJob) => void;
  syncPreview: (project: Project) => void;
  editSpecification: (
    id: string,
    section: SpecificationSection,
    input: unknown,
    expectedRevision: number,
  ) => Specification;
};
const empty: Snapshot = { projects: [], ready: false, error: null };
let snapshot = empty;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
type CloudState = {
  configured: boolean;
  userId: string | null;
  email: string | null;
  status: "local" | "loading" | "signed-out" | "synced" | "saving" | "error";
  error: string | null;
  action?: "import" | "refresh" | "load";
  progress?: number;
};
let cloud: CloudState = {
  configured: !!supabase,
  userId: null,
  email: null,
  status: supabase ? "loading" : "local",
  error: null,
};
let sync: ProjectSync<Project> | null = null;
let cloudLoaded = false;
let downloadedPending = "";
const outboxKeys = new Map<string, string>();
function outboxKey(id: string) {
  const existing = outboxKeys.get(id);
  if (existing) return existing;
  // Each page owns its outbox, including duplicated tabs. Reloads recover the
  // previous page's pending records without sharing a writable key with it.
  const pointer = `${KEY}.outbox-pointer.${id}`;
  const prior = sessionStorage.getItem(pointer);
  const prefix = `${KEY}.outbox.${id}.`;
  const pending = prior?.startsWith(prefix)
    ? localStorage.getItem(prior)
    : null;
  const key = prefix + crypto.randomUUID();
  localStorage.setItem(key, pending ?? "[]");
  sessionStorage.setItem(pointer, key);
  outboxKeys.set(id, key);
  return key;
}
function setCloud(update: Partial<CloudState>) {
  cloud = { ...cloud, ...update };
  if (
    update.status &&
    update.status !== "loading" &&
    update.status !== "saving"
  ) {
    cloud = { ...cloud, action: undefined, progress: undefined };
  }
  snapshot = { ...snapshot };
  emit();
}
function currentProjects() {
  if (cloud.userId) return snapshot.projects;
  const raw = localStorage.getItem(KEY);
  return raw
    ? storedProjectsSchema.parse(JSON.parse(raw)).projects
    : snapshot.projects;
}
function persistProjects(projects: Project[]) {
  if (
    supabase &&
    (cloud.status === "loading" || (cloud.userId && !cloudLoaded))
  )
    throw new Error("Bulut projelerinin yüklenmesini bekleyin.");
  if (cloud.userId && sync) {
    sync.enqueue(projects);
  } else {
    localStorage.setItem(KEY, JSON.stringify({ version: 1, projects }));
    snapshot = { projects, ready: true, error: null };
    emit();
  }
}
async function activateCloud(user: { id: string; email?: string } | null) {
  if (user?.id === cloud.userId && cloud.status !== "loading") return;
  sync?.stop();
  sync = null;
  cloudLoaded = false;
  downloadedPending = "";
  if (!user) {
    cloud = {
      ...cloud,
      userId: null,
      email: null,
      status: "signed-out",
      error: null,
    };
    snapshot = empty;
    initialize();
    emit();
    return;
  }
  const ownerId = user.id;
  snapshot = { projects: [], ready: true, error: null };
  setCloud({
    userId: ownerId,
    email: user.email ?? null,
    status: "loading",
    error: null,
  });
  try {
    const raw = JSON.parse(
      localStorage.getItem(outboxKey(ownerId)) ?? "[]",
    ) as PendingProject<Project>[];
    if (!Array.isArray(raw)) throw new Error("Invalid outbox");
    const pending = raw.map((item) => {
      if (
        !Number.isSafeInteger(item.expectedVersion) ||
        item.expectedVersion < 0
      )
        throw new Error("Invalid version");
      return {
        document: projectSchema.parse(item.document),
        expectedVersion: item.expectedVersion,
      };
    });
    sync = new ProjectSync(
      projectRepository(ownerId),
      pending,
      (items) =>
        localStorage.setItem(outboxKey(ownerId), JSON.stringify(items)),
      (projects, status, error, progress) => {
        if (cloud.userId !== ownerId) return;
        if (status !== "error" && status !== "loading") cloudLoaded = true;
        snapshot = { projects, ready: true, error: null };
        setCloud({ status, error: error ?? null, progress });
      },
    );
    await sync.refresh();
  } catch {
    setCloud({
      status: "error",
      error:
        "Hesaba ait bekleyen kayıtlar okunamadı. Yerel depolama verisini silmeden kontrol edin.",
    });
  }
}
function importLocalProjects() {
  if (!cloud.userId || !cloudLoaded || !sync)
    throw new Error("Önce bulut hesabınıza giriş yapın.");
  const raw = localStorage.getItem(KEY);
  const local = raw ? storedProjectsSchema.parse(JSON.parse(raw)).projects : [];
  // Existing cloud IDs always win; importing never overwrites another device.
  setCloud({ action: "import", progress: 0 });
  try {
    persistProjects([
      ...snapshot.projects,
      ...local.filter(
        (p) => !snapshot.projects.some((remote) => remote.id === p.id),
      ),
    ]);
  } catch (error) {
    setCloud({ action: undefined, progress: undefined });
    throw error;
  }
}
function retryCloud() {
  if (sync) {
    setCloud({ action: "refresh", progress: 0 });
    void sync.refresh();
  }
}
function downloadPending() {
  if (!cloud.userId) return;
  const raw = localStorage.getItem(outboxKey(cloud.userId)) ?? "[]";
  const url = URL.createObjectURL(
    new Blob([raw], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "app-factory-bekleyen-degisiklikler.json";
  link.click();
  URL.revokeObjectURL(url);
  downloadedPending = raw;
}
async function loadCloudVersion() {
  if (!cloud.userId || !supabase) return;
  const key = outboxKey(cloud.userId);
  const pending = localStorage.getItem(key) ?? "[]";
  if (pending !== "[]" && downloadedPending !== pending)
    throw new Error(
      "Önce bekleyen değişiklikleri indirin. Bulut sürümü bu tarayıcıdaki bekleyen değişikliklerin yerini alacak.",
    );
  const { data } = await supabase.auth.getSession();
  if (data.session?.user.id !== cloud.userId)
    throw new Error("Oturum değişti.");
  // Keep an account-scoped recovery copy even after explicit discard.
  localStorage.setItem(`${key}.backup`, pending);
  localStorage.setItem(key, "[]");
  sync?.stop();
  cloud = { ...cloud, status: "loading" };
  await activateCloud(data.session.user);
}
// Translate only unchanged seeded text; preserve user-authored project content.
function localizeDemoProjects(projects: Project[]): Project[] {
  const legacy: Record<string, { name: string; idea: string }> = {
    "daily-focus": {
      name: "Daily Focus",
      idea: "A simple daily habit tracker with a focused list, weekly progress and gentle reminders.",
    },
    "pocket-pantry": {
      name: "Pocket Pantry",
      idea: "Track pantry items and expiry dates, then create a shopping list for missing essentials.",
    },
  };
  return projects.map((project) => {
    const old = legacy[project.id];
    const seed = mockProjects.find((item) => item.id === project.id);
    if (!old || !seed) return project;
    return {
      ...project,
      name: project.name === old.name ? seed.name : project.name,
      idea: project.idea === old.idea ? seed.idea : project.idea,
    };
  });
}
function initialize() {
  if (snapshot.ready) return;
  try {
    const raw = localStorage.getItem(KEY);
    snapshot = {
      projects: raw
        ? localizeDemoProjects(
            storedProjectsSchema.parse(JSON.parse(raw)).projects,
          )
        : mockProjects,
      ready: true,
      error: null,
    };
  } catch {
    snapshot = {
      projects: mockProjects,
      ready: true,
      error:
        "Kayıtlı veriler yüklenemedi. Demo projeler gösteriliyor; kaydetmek okunamayan verilerin üzerine yazabilir.",
    };
  }
}
function synchronize(event: StorageEvent) {
  if (cloud.userId) return;
  if (event.key !== KEY) return;
  try {
    snapshot = {
      projects: event.newValue
        ? localizeDemoProjects(
            storedProjectsSchema.parse(JSON.parse(event.newValue)).projects,
          )
        : mockProjects,
      ready: true,
      error: null,
    };
    emit();
  } catch {
    /* Preserve current data when another tab contains an invalid payload. */
  }
}
function subscribe(listener: () => void) {
  initialize();
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", synchronize);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", synchronize);
  };
}
function save(projects: Project[]) {
  persistProjects(projects);
}
function create(input: ProjectInput) {
  const validated = projectInputSchema.parse(input);
  const id = crypto.randomUUID();
  save([
    {
      ...validated,
      id,
      stage: transition("idea", "CREATE_PLAN"),
      aiCost: 0,
      updatedAt: new Date().toISOString(),
    },
    ...snapshot.projects,
  ]);
  return id;
}
async function restoreLocalProject(id: string) {
  const response = await fetch(
    `/api/jobs?projectId=${encodeURIComponent(id)}`,
    {
      cache: "no-store",
    },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Yerel proje alınamadı.");
  if (!data.job) throw new Error("Bu proje için yerel iş kaydı bulunamadı.");
  const job = generationJobSchema.parse(data.job);
  if (job.projectId !== id || job.project.id !== id)
    throw new Error("Yerel proje kaydı eşleşmiyor.");
  const projects = currentProjects();
  // Never replace a project already present in this browser.
  if (projects.some((project) => project.id === id)) {
    snapshot = { projects, ready: true, error: null };
    emit();
    return;
  }
  const restored: Project = {
    ...job.project,
    stage: job.status === "ready" ? "tests" : job.project.stage,
  };
  const next = [restored, ...projects];
  persistProjects(next);
}
function advance(id: string, event: WorkflowEvent) {
  if (event === "APPROVE_DESIGN")
    throw new Error("Önce ekran önizlemelerini inceleyin.");
  save(
    snapshot.projects.map((project) =>
      project.id === id
        ? {
            ...project,
            stage: transition(project.stage, event),
            updatedAt: new Date().toISOString(),
          }
        : project,
    ),
  );
}
function editOverview(id: string, input: ProjectInput, expected: Project) {
  const projects = currentProjects();
  const current = projects.find((project) => project.id === id);
  if (!current) throw new Error("Proje bulunamadı.");
  const next = editProjectOverview(current, input, expected);
  persistProjects(
    projects.map((project) => (project.id === id ? next : project)),
  );
}
function approveDesign(
  id: string,
  screens: readonly string[],
  revision: number,
) {
  const projects = currentProjects();
  const next = projects.map((project) =>
    project.id === id
      ? approveVisualDesign(project, screens, revision)
      : project,
  );
  persistProjects(next);
}
function editSpecification(
  id: string,
  section: SpecificationSection,
  input: unknown,
  expectedRevision: number,
) {
  const projects = currentProjects();
  const next = projects.map((project) =>
    project.id === id
      ? reviseProject(project, section, input, expectedRevision)
      : project,
  );
  // Persist first: a failed write must not be reported as a saved revision.
  persistProjects(next);
  const saved = next.find((project) => project.id === id);
  if (!saved) throw new Error("Proje bulunamadı.");
  return getSpecification(saved);
}
function syncPreview(project: Project) {
  const projects = currentProjects();
  save(
    projects.map((p) =>
      p.id === project.id && sameSpecification(p, project)
        ? { ...p, stage: "build" as const, updatedAt: new Date().toISOString() }
        : p,
    ),
  );
}
function syncBuilder(job: BuilderJob) {
  if (job.status !== "ready") return;
  const projects = currentProjects();
  const current = projects.find((p) => p.id === job.project.id);
  if (
    !current ||
    current.stage === "build" ||
    !sameSpecification(current, job.project)
  )
    return;
  const next = projects.map((p) =>
    p.id === current.id
      ? { ...p, stage: "build" as const, updatedAt: new Date().toISOString() }
      : p,
  );
  persistProjects(next);
}
function syncGeneration(job: GenerationJob) {
  const current = snapshot.projects.find(
    (project) => project.id === job.projectId,
  );
  if (
    !current ||
    !sameSpecification(current, job.project) ||
    !["development", "tests", "build"].includes(current.stage)
  )
    return;
  const stage =
    job.status === "ready" ? "build" : job.files.length ? "tests" : null;
  if (!stage) return;
  if (
    !snapshot.projects.some(
      (project) => project.id === job.projectId && project.stage !== stage,
    )
  )
    return;
  save(
    snapshot.projects.map((project) =>
      project.id === job.projectId
        ? { ...project, stage, updatedAt: job.updatedAt }
        : project,
    ),
  );
}
function syncPlannerCost(job: PlannerJob) {
  if (job.status === "running") return;
  const total = job.priorCostUsd + job.costUsd + job.uncertainCostUsd;
  if (
    !snapshot.projects.some((p) => p.id === job.projectId && p.aiCost < total)
  )
    return;
  const projects = currentProjects();
  const next = projects.map((p) =>
    p.id === job.projectId ? { ...p, aiCost: Math.max(p.aiCost, total) } : p,
  );
  persistProjects(next);
}
function applyPlanner(job: PlannerJob) {
  const projects = currentProjects();
  const next = projects.map((p) =>
    p.id === job.projectId ? applyPlannerResult(p, job) : p,
  );
  persistProjects(next);
}
function applyImageApproval(approved: Project, expectedRevision: number) {
  const projects = currentProjects();
  const current = projects.find((p) => p.id === approved.id);
  if (!current || getSpecification(current).revision !== expectedRevision)
    throw new Error("Proje değişti. Güncel tasarımı yeniden inceleyin.");
  const next = projects.map((p) =>
    p.id === approved.id
      ? { ...approved, aiCost: Math.max(p.aiCost, approved.aiCost) }
      : p,
  );
  persistProjects(next);
}
function syncImageCost(id: string, cost: number) {
  if (
    !Number.isFinite(cost) ||
    cost < 0 ||
    !snapshot.projects.some((p) => p.id === id && p.aiCost < cost)
  )
    return;
  const projects = currentProjects();
  const next = projects.map((p) =>
    p.id === id ? { ...p, aiCost: Math.max(p.aiCost, cost) } : p,
  );
  persistProjects(next);
}
const Context = createContext<Store | null>(null);
export function ProjectProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (!supabase) return;
    let disposed = false;
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      // Supabase auth callbacks must not await other auth operations.
      setTimeout(() => {
        if (!disposed) void activateCloud(session?.user ?? null);
      }, 0);
    });
    const refresh = () => {
      if (cloud.status === "synced") void sync?.refresh();
    };
    const timer = setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      data.subscription.unsubscribe();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      sync?.stop();
    };
  }, []);
  const state = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => empty,
  );
  return (
    <Context.Provider
      value={{
        ...state,
        cloud,
        importLocalProjects,
        retryCloud,
        downloadPending,
        loadCloudVersion,
        restoreLocalProject,
        create,
        editOverview,
        advance,
        syncGeneration,
        syncBuilder,
        syncPreview,
        editSpecification,
        approveDesign,
        applyPlanner,
        syncPlannerCost,
        applyImageApproval,
        syncImageCost,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useProjects() {
  const store = useContext(Context);
  if (!store) throw new Error("ProjectProvider required");
  return store;
}
