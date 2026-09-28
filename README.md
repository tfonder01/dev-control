# Dev Control

A local dashboard for inspecting Git repositories and safely initializing projects across a Windows development workspace.

## Configure

Copy `.env.example` to `.env.local` and set the root directory Dev Control should scan:

```dotenv
DEV_CONTROL_ROOT=C:\path\to\your\projects
```

Paths with spaces are supported. The configured path stays on the server and is never accepted from a browser request.

## Run locally

```powershell
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Workspace dashboard

- Git branch, working-tree status, changed files, latest commit, and origin remote
- Node.js, Next.js, React, package manager, Java, Maven, Spring Boot, Docker, Docker Compose, and Python markers
- Common package scripts and Maven commands (display only)
- Common repository configuration files
- Client-side repository search, status and stack filters, and activity/name sorting

Repository inspection uses read-only Git commands.

## New Project workflow

The explicit **New Project** flow accepts HTTPS GitHub repository URLs only and resolves every destination beneath `DEV_CONTROL_ROOT`. It refuses existing destination files/folders and atomically reserves the target before cloning.

- **Existing repo only** clones an existing GitHub repository.
- **Next.js** requires an empty GitHub repository, clones it, then runs a fixed `pnpm create next-app` configuration.
- **Empty** requires an empty GitHub repository and adds only selected starter documents.
- **Spring Boot** automatic scaffolding is intentionally unavailable until an approved Initializr configuration is defined; existing Spring repositories can be cloned.

The server can execute only predefined `git` and `pnpm create next-app` operations. There is no generic command or arbitrary destination endpoint. Failed operations remove only the newly reserved project destination.

## Scan behavior

Discovery is breadth-first, stops after six directory levels or 20,000 visited directories, and skips dependency, build, IDE, cache, and virtual-environment folders. A failure in one directory or repository is reported without stopping the rest of the scan.

The first request creates a server-only workspace snapshot. Dashboard and project-detail navigation reuse it instead of rescanning every repository. Snapshots begin a background refresh after 60 seconds, while the dashboard **Refresh** control always awaits a complete new scan and reports its duration. No filesystem watcher or database is used.

## Validate

```powershell
pnpm lint
pnpm test
pnpm build
```
