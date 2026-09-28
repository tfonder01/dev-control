"use client";

import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";
import { ArrowRight, FolderGit2, Search, SlidersHorizontal } from "lucide-react";

import { BranchLabel, CommitLabel, formatActivity, RepositoryState, TechnologyBadge } from "./components";
import { filterAndSortRepositories, type SortOption, type StatusFilter } from "@/lib/dashboard/repository-view";
import type { Repository } from "@/lib/workspace/types";

export function RepositoryBrowser({ repositories }: { repositories: Repository[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [stack, setStack] = useState("all");
  const [sort, setSort] = useState<SortOption>("recent");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  const stacks = useMemo(() => Array.from(new Set(
    repositories.flatMap((repository) => repository.technologies.map((technology) => technology.name)),
  )).sort((a, b) => a.localeCompare(b)), [repositories]);

  const visibleRepositories = useMemo(() => {
    return filterAndSortRepositories(repositories, { query: deferredQuery, status, stack, sort });
  }, [deferredQuery, repositories, sort, stack, status]);

  return (
    <div className="repository-panel">
      <div className="repository-toolbar">
        <label className="search-field">
          <Search aria-hidden="true" size={15} />
          <span className="sr-only">Search repositories</span>
          <input
            type="search"
            placeholder="Search repositories…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && <kbd>{visibleRepositories.length}</kbd>}
        </label>

        <div className="status-filter" aria-label="Repository status filter">
          {(["all", "modified", "clean"] as const).map((option) => (
            <button key={option} type="button" aria-pressed={status === option} onClick={() => setStatus(option)}>
              {option[0].toUpperCase() + option.slice(1)}
            </button>
          ))}
        </div>

        <label className="select-field">
          <span className="sr-only">Filter by technology</span>
          <select value={stack} onChange={(event) => setStack(event.target.value)}>
            <option value="all">All stacks</option>
            {stacks.map((technology) => <option value={technology} key={technology}>{technology}</option>)}
          </select>
        </label>

        <label className="select-field sort-field">
          <SlidersHorizontal aria-hidden="true" size={13} />
          <span className="sr-only">Sort repositories</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as SortOption)}>
            <option value="recent">Recently active</option>
            <option value="modified">Modified first</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>

      <div className="repository-scroll" tabIndex={0} aria-label="Repositories">
        {visibleRepositories.length === 0 ? (
          <div className="filtered-empty">
            <Search aria-hidden="true" size={21} />
            <strong>No matching repositories</strong>
            <span>Try a different search or filter.</span>
          </div>
        ) : (
          <div className="repository-list">
            {visibleRepositories.map((repository) => (
              <Link className={`repository-row ${repository.git.isDirty ? "is-modified" : ""}`} href={`/projects/${repository.id}`} key={repository.id}>
                <div className="repo-icon"><FolderGit2 aria-hidden="true" size={18} /></div>
                <div className="repo-primary">
                  <div className="repo-title-line">
                    <h3>{repository.name}</h3>
                    <RepositoryState repository={repository} />
                  </div>
                  <p title={repository.path}>{repository.relativePath}</p>
                  <div className="tech-list">
                    {repository.technologies.length > 0
                      ? repository.technologies.map((technology) => <TechnologyBadge key={technology.name} technology={technology} />)
                      : <span className="tech-badge tech-slate">Unclassified</span>}
                  </div>
                </div>
                <div className="repo-git">
                  <BranchLabel branch={repository.git.branch} />
                  <CommitLabel repository={repository} />
                </div>
                <div className="repo-activity">
                  <span>Last activity</span>
                  <time title={repository.git.latestCommitTimestamp ? new Date(repository.git.latestCommitTimestamp).toLocaleString() : undefined} dateTime={repository.git.latestCommitTimestamp ?? undefined}>
                    {formatActivity(repository.git.latestCommitTimestamp)}
                  </time>
                </div>
                <ArrowRight className="row-arrow" aria-hidden="true" size={16} />
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="repository-panel-footer" aria-live="polite">
        Showing {visibleRepositories.length} of {repositories.length}
      </div>
    </div>
  );
}
