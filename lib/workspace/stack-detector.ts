import { createHash } from "node:crypto";
import { access, opendir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { MAX_SCAN_DEPTH, SKIPPED_DIRECTORIES } from "./scan-rules.ts";
import type {
  InfrastructureDefinition,
  JavaBuildTool,
  PackageManager,
  ProjectCapabilities,
  ProjectCommand,
  ProjectScript,
  ProjectService,
  Technology,
} from "./types";

const SERVICE_SCAN_LIMIT = 5_000;
const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"] as const;
const INFORMATIONAL_MARKERS = ["AGENTS.md", "CLAUDE.md", "README.md", "README.MD", ".env", ".env.local", ".env.development", "devhub.yml", "devhub.yaml"] as const;

function opaqueId(kind: string, relativePath: string) {
  return createHash("sha256").update(`${kind}:${relativePath.toLowerCase()}`).digest("base64url").slice(0, 16);
}

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isNestedRepository(directoryPath: string, repositoryPath: string) {
  if (directoryPath === repositoryPath) return false;
  try {
    const marker = await stat(path.join(/* turbopackIgnore: true */ directoryPath, ".git"));
    return marker.isDirectory() || marker.isFile();
  } catch {
    return false;
  }
}

function repositoryRelative(repositoryPath: string, targetPath: string) {
  return path.relative(repositoryPath, targetPath).replaceAll(path.sep, "/") || ".";
}

function addTechnology(technologies: Technology[], technology: Technology) {
  if (!technologies.some((item) => item.name === technology.name)) technologies.push(technology);
}

function detectDevPort(script: string, isNextJs: boolean) {
  const explicitPort = script.match(/(?:--port(?:=|\s+)|-p\s+)(\d{2,5})\b/i)?.[1]
    ?? script.match(/(?:^|\s)PORT=(\d{2,5})(?:\s|$)/i)?.[1];
  if (explicitPort) {
    const port = Number(explicitPort);
    if (port >= 1 && port <= 65_535) return { port, source: "script" as const };
  }
  if (isNextJs && /(?:^|\s)next(?:\s|$)/i.test(script)) return { port: 3000, source: "framework-default" as const };
  return { port: null, source: null };
}

function configuredValue(value: string) {
  const cleaned = value.trim().replace(/^["']|["']$/g, "");
  return cleaned.match(/^\$\{[^:}]+:([^}]+)\}$/)?.[1]?.trim() ?? cleaned;
}

function validPort(value: string | null) {
  if (!value) return null;
  const port = Number(configuredValue(value));
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function propertiesValue(contents: string, key: string) {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#!][^:=\s]*)\s*[:=]\s*(.*?)\s*$/);
    if (match?.[1] === key) return match[2];
  }
  return null;
}

function yamlValue(contents: string, expectedPath: string[]) {
  const pathStack: { indent: number; key: string }[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const indent = match[1].length;
    while (pathStack.length > 0 && pathStack[pathStack.length - 1].indent >= indent) pathStack.pop();
    const keys = [...pathStack.map((item) => item.key), match[2]];
    const value = match[3].replace(/\s+#.*$/, "").trim();
    if (keys.join(".") === expectedPath.join(".") && value) return value;
    if (!value) pathStack.push({ indent, key: match[2] });
  }
  return null;
}

async function readOptional(filePath: string) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function detectSpringBootPort(servicePath: string) {
  const resources = path.join(/* turbopackIgnore: true */ servicePath, "src", "main", "resources");
  const baseFiles = ["application.properties", "application.yml", "application.yaml"];
  let activeProfile: string | null = null;
  let basePort: number | null = null;

  for (const file of baseFiles) {
    const contents = await readOptional(path.join(/* turbopackIgnore: true */ resources, file));
    if (!contents) continue;
    const isProperties = file.endsWith(".properties");
    const port = validPort(isProperties ? propertiesValue(contents, "server.port") : yamlValue(contents, ["server", "port"]) ?? yamlValue(contents, ["server.port"]));
    if (port && !basePort) basePort = port;
    const configuredProfile = configuredValue(isProperties
      ? propertiesValue(contents, "spring.profiles.active") ?? ""
      : yamlValue(contents, ["spring", "profiles", "active"]) ?? yamlValue(contents, ["spring.profiles.active"]) ?? "");
    if (/^[A-Za-z0-9_-]+$/.test(configuredProfile)) activeProfile = configuredProfile;
  }

  if (activeProfile) {
    for (const extension of ["properties", "yml", "yaml"]) {
      const contents = await readOptional(path.join(/* turbopackIgnore: true */ resources, `application-${activeProfile}.${extension}`));
      if (!contents) continue;
      const port = validPort(extension === "properties" ? propertiesValue(contents, "server.port") : yamlValue(contents, ["server", "port"]) ?? yamlValue(contents, ["server.port"]));
      if (port) return { port, source: "spring-config" as const };
    }
  }
  if (basePort) return { port: basePort, source: "spring-config" as const };
  return { port: 8080, source: "framework-default" as const };
}

async function springConfigurationFiles(repositoryPath: string, servicePath: string) {
  try {
    return (await readdir(path.join(/* turbopackIgnore: true */ servicePath, "src", "main", "resources")))
      .filter((file) => /^application(?:-[A-Za-z0-9_-]+)?\.(?:properties|ya?ml)$/.test(file))
      .sort()
      .map((file) => repositoryRelative(repositoryPath, path.join(servicePath, "src", "main", "resources", file)));
  } catch {
    return [];
  }
}

async function packageManager(repositoryPath: string, servicePath: string, declared?: string): Promise<PackageManager> {
  const declaredManager = declared?.split("@")[0];
  if (declaredManager === "pnpm" || declaredManager === "npm" || declaredManager === "yarn") return declaredManager;
  for (const directory of servicePath === repositoryPath ? [servicePath] : [servicePath, repositoryPath]) {
    if (await exists(path.join(directory, "pnpm-lock.yaml"))) return "pnpm";
    if (await exists(path.join(directory, "package-lock.json"))) return "npm";
    if (await exists(path.join(directory, "yarn.lock"))) return "yarn";
  }
  return "npm";
}

function emptyCapabilities(): ProjectCapabilities {
  return {
    packageManager: null,
    packageScripts: [],
    hasMavenWrapper: false,
    hasGradleWrapper: false,
    hasSpringBoot: false,
    javaBuildTool: null,
    devPortHint: null,
    devPortSource: null,
  };
}

async function detectNodeService(repositoryPath: string, servicePath: string): Promise<ProjectService | null> {
  const packagePath = path.join(/* turbopackIgnore: true */ servicePath, "package.json");
  if (!await exists(packagePath)) return null;
  try {
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
      name?: string;
      packageManager?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    const scripts = packageJson.scripts ?? {};
    const manager = await packageManager(repositoryPath, servicePath, packageJson.packageManager);
    const technologies: Technology[] = [{ name: "Node.js", tone: "green" }];
    if (dependencies.next) addTechnology(technologies, { name: "Next.js", tone: "slate" });
    if (dependencies.react) addTechnology(technologies, { name: "React", tone: "cyan" });
    addTechnology(technologies, { name: manager, tone: "orange" });
    const capabilities = emptyCapabilities();
    capabilities.packageManager = manager;
    const commands: ProjectCommand[] = [];
    for (const script of ["dev", "start", "test", "lint", "build"] satisfies ProjectScript[]) {
      if (!scripts[script]) continue;
      capabilities.packageScripts.push(script);
      commands.push({ label: script, command: `${manager} ${manager === "npm" ? "run " : ""}${script}` });
    }
    if (scripts.dev) {
      const detectedPort = detectDevPort(scripts.dev, Boolean(dependencies.next));
      capabilities.devPortHint = detectedPort.port;
      capabilities.devPortSource = detectedPort.source;
    }
    const relativePath = repositoryRelative(repositoryPath, servicePath);
    return {
      id: opaqueId("node", relativePath),
      name: packageJson.name?.trim() || (relativePath === "." ? path.basename(repositoryPath) : path.basename(servicePath)),
      path: servicePath,
      relativePath,
      kind: "node",
      technologies,
      configurationFiles: [repositoryRelative(repositoryPath, packagePath)],
      commands,
      capabilities,
    };
  } catch {
    return null;
  }
}

async function springBuildTool(servicePath: string): Promise<{ tool: JavaBuildTool; buildFile: string; contents: string } | null> {
  const pom = path.join(/* turbopackIgnore: true */ servicePath, "pom.xml");
  const pomContents = await readOptional(pom);
  if (pomContents && /spring-boot/i.test(pomContents)) return { tool: "maven", buildFile: pom, contents: pomContents };
  for (const name of ["build.gradle", "build.gradle.kts"]) {
    const buildFile = path.join(/* turbopackIgnore: true */ servicePath, name);
    const contents = await readOptional(buildFile);
    if (contents && /org\.springframework\.boot|spring-boot/i.test(contents)) return { tool: "gradle", buildFile, contents };
  }
  return null;
}

async function detectSpringService(repositoryPath: string, servicePath: string): Promise<ProjectService | null> {
  const build = await springBuildTool(servicePath);
  if (!build) return null;
  const relativePath = repositoryRelative(repositoryPath, servicePath);
  const capabilities = emptyCapabilities();
  capabilities.hasSpringBoot = true;
  capabilities.javaBuildTool = build.tool;
  capabilities.hasMavenWrapper = build.tool === "maven" && (await exists(path.join(servicePath, "mvnw.cmd")) || await exists(path.join(servicePath, "mvnw")));
  capabilities.hasGradleWrapper = build.tool === "gradle" && (await exists(path.join(servicePath, "gradlew.bat")) || await exists(path.join(servicePath, "gradlew")));
  const port = await detectSpringBootPort(servicePath);
  capabilities.devPortHint = port.port;
  capabilities.devPortSource = port.source;
  const technologies: Technology[] = [{ name: "Java", tone: "orange" }];
  addTechnology(technologies, { name: build.tool === "maven" ? "Maven" : "Gradle", tone: "purple" });
  addTechnology(technologies, { name: "Spring Boot", tone: "green" });
  const launcher = build.tool === "maven"
    ? capabilities.hasMavenWrapper ? (process.platform === "win32" ? ".\\mvnw.cmd" : "./mvnw") : "mvn"
    : capabilities.hasGradleWrapper ? (process.platform === "win32" ? ".\\gradlew.bat" : "./gradlew") : "gradle";
  const commands = build.tool === "maven"
    ? [{ label: "test", command: `${launcher} test` }, { label: "verify", command: `${launcher} verify` }]
    : [{ label: "test", command: `${launcher} test` }, { label: "build", command: `${launcher} build` }];
  return {
    id: opaqueId("spring-boot", relativePath),
    name: relativePath === "." ? path.basename(repositoryPath) : path.basename(servicePath),
    path: servicePath,
    relativePath,
    kind: "spring-boot",
    technologies,
    configurationFiles: [repositoryRelative(repositoryPath, build.buildFile), ...await springConfigurationFiles(repositoryPath, servicePath)],
    commands,
    capabilities,
  };
}

async function scanDirectories(repositoryPath: string) {
  const directories: string[] = [];
  const queue = [{ directoryPath: repositoryPath, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < SERVICE_SCAN_LIMIT) {
    const current = queue.shift();
    if (!current) break;
    visited += 1;
    if (await isNestedRepository(current.directoryPath, repositoryPath)) continue;
    directories.push(current.directoryPath);
    if (current.depth >= MAX_SCAN_DEPTH) continue;
    try {
      const directory = await opendir(current.directoryPath);
      for await (const entry of directory) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git" || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        queue.push({ directoryPath: path.join(/* turbopackIgnore: true */ current.directoryPath, entry.name), depth: current.depth + 1 });
      }
    } catch {
      // One unreadable service directory must not hide the repository.
    }
  }
  return directories;
}

export async function detectStack(repositoryPath: string) {
  const directories = await scanDirectories(repositoryPath);
  const services: ProjectService[] = [];
  const infrastructure: InfrastructureDefinition[] = [];
  const technologies: Technology[] = [];
  const configurationFiles: string[] = [];

  for (const directory of directories) {
    const [node, spring] = await Promise.all([
      detectNodeService(repositoryPath, directory),
      detectSpringService(repositoryPath, directory),
    ]);
    for (const service of [node, spring]) {
      if (!service) continue;
      services.push(service);
      service.technologies.forEach((technology) => addTechnology(technologies, technology));
      configurationFiles.push(...service.configurationFiles);
    }

    for (const composeFile of COMPOSE_FILES) {
      const composePath = path.join(/* turbopackIgnore: true */ directory, composeFile);
      if (!await exists(composePath)) continue;
      const relativePath = repositoryRelative(repositoryPath, composePath);
      infrastructure.push({
        id: opaqueId("docker-compose", relativePath),
        name: path.basename(directory) === path.basename(repositoryPath) ? "Docker Compose" : path.basename(directory),
        path: directory,
        relativePath: repositoryRelative(repositoryPath, directory),
        kind: "docker-compose",
        configurationFile: relativePath,
      });
      configurationFiles.push(relativePath);
      addTechnology(technologies, { name: "Docker Compose", tone: "blue" });
    }

    const dockerfile = path.join(/* turbopackIgnore: true */ directory, "Dockerfile");
    if (await exists(dockerfile)) {
      configurationFiles.push(repositoryRelative(repositoryPath, dockerfile));
      addTechnology(technologies, { name: "Docker", tone: "blue" });
    }
    if (await exists(path.join(directory, "pyproject.toml")) || await exists(path.join(directory, "requirements.txt"))) {
      addTechnology(technologies, { name: "Python", tone: "blue" });
    }
  }

  for (const marker of INFORMATIONAL_MARKERS) {
    const markerPath = path.join(/* turbopackIgnore: true */ repositoryPath, marker);
    if (await exists(markerPath)) configurationFiles.push(marker);
  }

  services.sort((left, right) => left.relativePath.localeCompare(right.relativePath) || left.kind.localeCompare(right.kind));
  infrastructure.sort((left, right) => left.configurationFile.localeCompare(right.configurationFile));
  return {
    technologies,
    configurationFiles: [...new Set(configurationFiles)].sort(),
    services,
    infrastructure,
  };
}
