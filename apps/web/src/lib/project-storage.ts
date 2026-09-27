export const PROJECTS_KEY = "app-factory.projects.v1";
export function deletedProjectIds(storage: Storage): Set<string> {
  return new Set(
    JSON.parse(storage.getItem(PROJECTS_KEY + ".deleted") ?? "[]") as string[],
  );
}
/** Remove only this project's copies, including session outboxes and recovery backups. */
export function forgetBrowserProject(storage: Storage, id: string) {
  const deleted = deletedProjectIds(storage);
  deleted.add(id);
  storage.setItem(PROJECTS_KEY + ".deleted", JSON.stringify([...deleted]));
  const keys = Array.from({ length: storage.length }, (_, index) =>
    storage.key(index),
  ).filter((key): key is string => !!key);
  for (const key of keys) {
    if (key !== PROJECTS_KEY && !key.startsWith(PROJECTS_KEY + ".outbox."))
      continue;
    const raw = storage.getItem(key);
    if (!raw) continue;
    const value = JSON.parse(raw);
    if (key === PROJECTS_KEY && Array.isArray(value.projects)) {
      value.projects = value.projects.filter(
        (project: { id: string }) => project.id !== id,
      );
      storage.setItem(key, JSON.stringify(value));
    } else if (Array.isArray(value)) {
      storage.setItem(
        key,
        JSON.stringify(
          value.filter(
            (item: { document?: { id: string } }) => item.document?.id !== id,
          ),
        ),
      );
    }
  }
}
