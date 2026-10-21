# DevHub

A local dashboard for inspecting and safely operating Git repositories across a Windows development workspace.

## Configure

Copy `.env.example` to `.env.local` and set the root directory DevHub should scan:

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
- Node.js, Next.js, React, package manager, Java, Maven, Gradle, Spring Boot, Docker, Docker Compose, and Python markers
- Common package scripts plus Maven and Gradle wrapper commands
- Common repository configuration files
- Client-side repository search, status and stack filters, and activity/name sorting

Repository inspection uses read-only Git commands. Project detail pages add explicit, allowlisted local actions for opening tools, starting a dev server, and running detected checks.

## New Project workflow

The explicit **New Project** flow accepts HTTPS GitHub repository URLs only and resolves every destination beneath `DEV_CONTROL_ROOT`. It refuses existing destination files/folders and atomically reserves the target before cloning.

- **Existing repo only** clones an existing GitHub repository.
- **Next.js** requires an empty GitHub repository, clones it, then runs a fixed `pnpm create next-app` configuration.
- **Empty** requires an empty GitHub repository and adds only selected starter documents.
- **Spring Boot** automatic scaffolding is intentionally unavailable until an approved Initializr configuration is defined; existing Spring repositories can be cloned.

The server can execute only predefined `git` and `pnpm create next-app` operations. There is no generic command or arbitrary destination endpoint. Failed operations remove only the newly reserved project destination.

## Project actions

Project detail actions accept only opaque repository/service IDs and a fixed action name. DevHub resolves every path and command from its server-side workspace snapshot; browser input never supplies a path or command. Standalone applications are represented as one root service, while monorepos can expose several independently runnable services.

- Open the trusted repository in Cursor, IntelliJ IDEA, Windows Explorer, or a local terminal.
- Start a detected Next.js `dev` script in Dev mode, or run the detected `build` script followed by the detected `start` script in Preview mode, using only the detected package manager.
- Start detected Spring Boot services through Maven `spring-boot:run` or Gradle `bootRun`, preferring repository wrappers including `gradlew.bat` on Windows.
- Run only detected `test`, `lint`, and `build` package scripts, Maven wrapper `test`/`verify`, and Gradle wrapper `test`/`build` tasks.
- Stop only service processes started and tracked by the current DevHub server process.

Dev-process ownership is intentionally in memory and tracked independently per service. Restarting DevHub forgets ownership and therefore disables Stop for orphaned processes rather than risking termination of an unrelated process. Port detection uses explicit script arguments, framework defaults, process output, and a listening-port check. Each service searches at most 20 consecutive ports from its detected preference and never stops or claims an existing listener.

Next.js launch mode and application profile are separate. Dev mode preserves hot reload. Preview is an explicit **Build & Start Preview** operation: DevHub always completes a production build before starting the production server and passes the selected dynamic port through the child environment. In-flight launches are coalesced per repository, so a second Preview request cannot create a duplicate process.

For each mode, DevHub inspects Next.js environment files in the service directory and framework order (`.env`, the mode-specific file, `.env.local`, then the mode-specific local file) for normalized, non-secret status metadata. Launched Next.js processes receive a bounded OS/toolchain environment plus only DevHub-owned runtime controls: `NODE_ENV`, `NO_COLOR`, `FORCE_COLOR`, and the dynamically selected `PORT` for the serving process. Application-specific values from DevHub's own environment are not inherited, so Next.js loads the target service's `.env*` files with its normal precedence. Preview uses the same bounded environment for build and start so build-time public configuration remains consistent; raw values and secret-bearing variables remain server-only.

Spring Boot ports are read conservatively from each service's application configuration, falling back to port 8080. DevHub uses the same bounded alternate-port selection and passes a fixed runtime port override. Docker containers are never started during scanning or page rendering, and externally running dependencies are never claimed.

Before a Spring Boot launch, DevHub resolves a server-only local runtime environment in this order: the DevHub process environment, repository-root `.env`/`.env.local`, service-local `.env`/`.env.local`, then an optional `development.envFile` named by the nearest service or repository `devhub.yml`/`devhub.yaml`. The configured file must resolve inside the trusted repository. Values are injected only into the Spring child process; the browser receives configured/not-configured status and never receives secret values. Recognizable required placeholders such as `DB_PASSWORD` and local PostgreSQL datasource ports are checked before the service starts. A project may independently set an optional `development.springProfile`; DevHub passes it as build-tool launch metadata and does not add it to the child environment. A DevHub-local `projects.<repository-id>.runtime.springProfile` entry in `.devhub/projects.json` overrides the repository setting without modifying the application checkout.

For service-specific secrets, create an ignored env file beside the Spring service (for example `backend/.env.local`) or point `development.envFile` to another ignored repository-local file. DevHub does not create, edit, display, or persist those secret values.

## Environment profile foundation

DevHub includes a server-only orchestration foundation for versioned, multi-repository workspace profiles. Code-reviewed profiles are loaded from `config/environment-profiles.json` and may be extended by the ignored owner-controlled `.devhub/environments.json` file. Duplicate base workspace IDs fail closed. UI-managed additions, overrides, and removals are stored separately in the ignored, versioned `.devhub/environment-profiles.local.json` overlay. A shipped profile is never rewritten: editing it records a local override, and removing it records a local tombstone without touching runtime resources. Definitions are never accepted directly from browser requests. The strict version 1 schema supports:

- stable workspace, profile, repository, and service references;
- fixed loopback ports, dependency graphs, deterministic start/stop ordering, and mutually exclusive profiles;
- Node/Next.js, Spring Boot, explicit Docker Compose project/service sets, and trusted local-process adapters;
- TCP, HTTP, process, and Docker health checks;
- profile-scoped in-memory ownership, external-service observation, graceful-first shutdown, and operation-scoped rollback; and
- repository-local environment files or external files resolved through owner-controlled path environment variables.

Configuration stores references and non-secret topology only. Environment-file contents are loaded server-side at launch time, passed only to the configured child runtime, and redacted from captured output. Trusted process commands, executable paths, working directories, and arguments originate only from this local configuration. Secret-bearing command arguments are rejected.

The project page exposes an environment selector only when multiple profiles exist, plus inspection, start, stop, restart, Open App, and **Manage environments** controls. Management supports add, edit, duplicate, and confirmed removal with a review step. Browser requests reference only server-approved service templates and external environment-reference IDs; executable arguments, Compose identity, repository environment paths, and private external paths stay server-side. Schema validation rejects unsafe hosts, duplicate ports, invalid graphs, unapproved references, and stale writes. Editing or removing a running profile is rejected until it is stopped. Node services also expose Development and Preview selection; Preview reuses the individual-service production build/start path. Every request re-resolves the trusted profile against the current workspace snapshot. Lifecycle operations are serialized per profile, and the browser receives only sanitized status DTOs. Existing per-service controls remain available independently. Changing a running frontend's mode requires the controlled Restart Environment action; a second listener is never launched on the fixed port.

The bundled `SentryWealth` / `Sandbox` profile targets the verified loopback topology: the established `devhub-sbzyspr8ueguv6vd` Compose project and `postgres` service on `127.0.0.1:5433`, Spring Boot on `127.0.0.1:8080`, then the Next.js frontend on `127.0.0.1:3002`. Preview is the configured default, while the Environment Profiles control can select Development before start or request a controlled restart into another mode. Both modes explicitly bind the configured host and port; DevHub's own development port remains independent at 3000. The profile references repository-owned ignored environment files without copying their contents. Fixed non-secret overrides force Plaid Sandbox, clear inherited Spring profile selection, retain the Production Trial acknowledgement gate, select the Sandbox frontend marker, and supply the backend BFF endpoint during both Preview build and start. The profile never names or reads the Production Trial private environment file.

The bundled `Production Trial` profile reuses the existing `sentrywealth-production-trial` Compose project, `postgres-trial` service, and `sentrywealth_production_trial_data` named volume on `127.0.0.1:5434`. It then starts Spring Boot with the `production-trial` profile on `127.0.0.1:8180`, runs the existing Next.js frontend in Preview on `127.0.0.1:3100`, and starts the repository's fixed Caddy configuration on `127.0.0.1:3443`. Open App always targets `https://localhost:3443/`. Its HTTPS health check uses the operating-system trust store with certificate validation enabled; it never accepts an invalid certificate. Caddy's graceful command is attempted only after the current listener is re-verified as part of DevHub's owned launch.

Before using the Trial profile, set these variables to the absolute paths of the two existing owner-controlled files. The preferred persistent local configuration is DevHub's ignored `.env.local`, which Next.js loads into the server process. On Windows, when an explicitly configured path variable is absent from the server process, DevHub also reads that variable from the current Windows User environment. Process variables take precedence. The files can remain outside both repositories; DevHub records only these reference names and loads contents only inside the trusted server process at launch time. The frontend needs no private env file: its documented non-secret API URL, display time zone, and environment marker are fixed in the trusted profile and supplied to both the Preview build and start commands.

```dotenv
DEVHUB_SENTRYWEALTH_TRIAL_DB_ENV_FILE=C:\owner-controlled\SentryWealth-Private\trial-db.env
DEVHUB_SENTRYWEALTH_TRIAL_BACKEND_ENV_FILE=C:\owner-controlled\SentryWealth-Private\trial-backend.env
```

After changing `.env.local` or the Windows User environment, restart the DevHub server. Missing variables and missing or invalid files produce distinct path-free preflight messages. Relative paths, directories, missing files, and external references that escape an owner-controlled base fail preflight. DevHub does not create the files, initialize a database, run the migration-only Compose service, alter Plaid flags, generate certificates, or change the trust store. Sandbox and Production Trial share an exclusive group, so a detected service in either profile blocks starting the other; DevHub reports the conflict and never silently stops it.

Real-data profiles require a checked confirmation for every start, stop, or restart request, including server-side enforcement. Healthy matching services started outside DevHub are shown as External and are never adopted or stopped. Ownership remains intentionally in memory; after a DevHub server restart, previously launched services are observed as external until they are stopped by their owner.

An optional secret-free runtime profile can make inference explicit:

```yaml
development:
  type: spring-boot
  envFile: .env
  port: 8080
  springProfile: dev
prerequisites:
  dockerCompose: false
  requiredEnv:
    - JWT_SECRET
  ports:
    - 5432
```

For confidently identified Compose dependencies with published host ports, the Development panel exposes separate **Start Dependencies** and **Stop Dependencies** actions. DevHub runs only targeted `docker compose up -d <identified services>` and `docker compose stop <tracked services>` operations under a deterministic repository-scoped Compose project name. It never starts an application service, runs an unscoped Compose stack, removes containers or volumes, prunes Docker data, or stops Docker Desktop.

Dependency services are recognized conservatively from service names, known images, dependency-specific environment markers, and published ports. Current recognized types are PostgreSQL, MySQL/MariaDB, Redis, RabbitMQ, and Kafka. Ambiguous or unpublished services remain metadata-only. Stop is available only for the exact service set started and tracked by the current DevHub process.

When a JDBC datasource hostname matches a detected Compose service and its container port has a published host mapping, DevHub derives a host-only URL for the Maven child environment, replacing only the Compose hostname and port with `localhost:<published-port>`. Database names, query parameters, and credentials remain unchanged; repository env and Spring configuration files are never rewritten.

## Scan behavior

Repository discovery is breadth-first, stops after six directory levels or 20,000 visited directories, and skips dependency, build, IDE, cache, and virtual-environment folders. Within each Git repository, bounded service discovery applies the same exclusions, stops at nested Git boundaries, and recognizes root or nested Node/Spring services plus Compose infrastructure. A failure in one directory or repository does not stop the rest of the scan.

The first request creates a server-only workspace snapshot. Dashboard and project-detail navigation reuse it instead of rescanning every repository. Snapshots begin a background refresh after 60 seconds, while the dashboard **Refresh** control always awaits a complete new scan and reports its duration. No filesystem watcher or database is used.

## Validate

```powershell
pnpm lint
pnpm test
pnpm build
```
