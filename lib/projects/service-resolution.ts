import type { ProjectService, Repository } from "@/lib/workspace/types";

export function resolveProjectService(repository: Repository, serviceId: string | undefined): ProjectService | null {
  if (!serviceId || !/^[A-Za-z0-9_-]{16}$/.test(serviceId)) return null;
  return repository.services.find((service) => service.id === serviceId) ?? null;
}

export function serviceRuntimeKey(repositoryId: string, serviceId: string, runtimeScope?: string) {
  return runtimeScope ? `${runtimeScope}:${repositoryId}:${serviceId}` : `${repositoryId}:${serviceId}`;
}
