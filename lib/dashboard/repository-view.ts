import type { Repository } from "../workspace/types";

export type StatusFilter = "all" | "modified" | "clean";
export type SortOption = "recent" | "modified" | "name";

function activityTime(repository: Repository) {
  return repository.git.latestCommitTimestamp ? Date.parse(repository.git.latestCommitTimestamp) : 0;
}

export function filterAndSortRepositories(
  repositories: Repository[],
  options: { query: string; status: StatusFilter; stack: string; sort: SortOption },
) {
  const query = options.query.trim().toLowerCase();
  const filtered = repositories.filter((repository) => {
    const matchesQuery = !query || `${repository.name} ${repository.relativePath}`.toLowerCase().includes(query);
    const matchesStatus = options.status === "all"
      || (options.status === "modified" && repository.git.isDirty)
      || (options.status === "clean" && !repository.git.isDirty && !repository.git.error);
    const matchesStack = options.stack === "all" || repository.technologies.some((technology) => technology.name === options.stack);
    return matchesQuery && matchesStatus && matchesStack;
  });

  return filtered.sort((a, b) => {
    if (options.sort === "name") return a.name.localeCompare(b.name);
    if (options.sort === "modified" && a.git.isDirty !== b.git.isDirty) return a.git.isDirty ? -1 : 1;
    return activityTime(b) - activityTime(a) || a.name.localeCompare(b.name);
  });
}
