import "server-only";

import { access, readFile } from "node:fs/promises";
import path from "node:path";

import type { PackageManager, ProjectCapabilities, ProjectCommand, ProjectScript, Technology } from "./types";

const CONFIGURATION_MARKERS = [
  "package.json",
  "pom.xml",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "README.MD",
] as const;

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function addTechnology(technologies: Technology[], technology: Technology) {
  if (!technologies.some((item) => item.name === technology.name)) {
    technologies.push(technology);
  }
}

function detectDevPort(script: string, isNextJs: boolean) {
  const explicitPort = script.match(/(?:--port(?:=|\s+)|-p\s+)(\d{2,5})\b/i)?.[1]
    ?? script.match(/(?:^|\s)PORT=(\d{2,5})(?:\s|$)/i)?.[1];
  if (explicitPort) {
    const port = Number(explicitPort);
    if (port >= 1 && port <= 65_535) return { port, source: "script" as const };
  }

  if (isNextJs && /(?:^|\s)next(?:\s|$)/i.test(script)) {
    return { port: 3000, source: "framework-default" as const };
  }

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

async function detectSpringBootPort(repositoryPath: string) {
  const resources = path.join(/* turbopackIgnore: true */ repositoryPath, "src", "main", "resources");
  const baseFiles = ["application.properties", "application.yml", "application.yaml"];
  let activeProfile: string | null = null;
  let basePort: number | null = null;

  for (const file of baseFiles) {
    const contents = await readOptional(path.join(/* turbopackIgnore: true */ resources, file));
    if (!contents) continue;
    const isProperties = file.endsWith(".properties");
    const port = validPort(isProperties
      ? propertiesValue(contents, "server.port")
      : yamlValue(contents, ["server", "port"]) ?? yamlValue(contents, ["server.port"]));
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
      const port = validPort(extension === "properties"
        ? propertiesValue(contents, "server.port")
        : yamlValue(contents, ["server", "port"]) ?? yamlValue(contents, ["server.port"]));
      if (port) return { port, source: "spring-config" as const };
    }
  }

  if (basePort) return { port: basePort, source: "spring-config" as const };
  return { port: 8080, source: "framework-default" as const };
}

export async function detectStack(repositoryPath: string) {
  const technologies: Technology[] = [];
  const commands: ProjectCommand[] = [];
  const configurationFiles: string[] = [];
  const capabilities: ProjectCapabilities = {
    packageManager: null,
    packageScripts: [],
    hasMavenWrapper: false,
    hasSpringBoot: false,
    devPortHint: null,
    devPortSource: null,
  };

  const markerResults = await Promise.all(
    CONFIGURATION_MARKERS.map(async (marker) => ({
      marker,
      present: await exists(path.join(/* turbopackIgnore: true */ repositoryPath, marker)),
    })),
  );

  for (const result of markerResults) {
    if (result.present && !configurationFiles.some((item) => item.toLowerCase() === result.marker.toLowerCase())) {
      configurationFiles.push(result.marker);
    }
  }

  const packagePath = path.join(/* turbopackIgnore: true */ repositoryPath, "package.json");
  if (await exists(packagePath)) {
    addTechnology(technologies, { name: "Node.js", tone: "green" });

    try {
      const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };

      if (dependencies.next) addTechnology(technologies, { name: "Next.js", tone: "slate" });
      if (dependencies.react) addTechnology(technologies, { name: "React", tone: "cyan" });

      const packageManager: PackageManager = (await exists(path.join(/* turbopackIgnore: true */ repositoryPath, "pnpm-lock.yaml")))
        ? "pnpm"
        : (await exists(path.join(/* turbopackIgnore: true */ repositoryPath, "package-lock.json")))
          ? "npm"
          : (await exists(path.join(/* turbopackIgnore: true */ repositoryPath, "yarn.lock")))
            ? "yarn"
            : "npm";

      addTechnology(technologies, { name: packageManager, tone: "orange" });
      capabilities.packageManager = packageManager;

      for (const script of ["dev", "test", "lint", "build"] satisfies ProjectScript[]) {
        if (packageJson.scripts?.[script]) {
          capabilities.packageScripts.push(script);
          commands.push({ label: script, command: `${packageManager} ${packageManager === "npm" ? "run " : ""}${script}` });
        }
      }

      if (packageJson.scripts?.dev) {
        const detectedPort = detectDevPort(packageJson.scripts.dev, Boolean(dependencies.next));
        capabilities.devPortHint = detectedPort.port;
        capabilities.devPortSource = detectedPort.source;
      }
    } catch {
      // A malformed package file should not prevent the repository from appearing.
    }
  }

  const pomPath = path.join(/* turbopackIgnore: true */ repositoryPath, "pom.xml");
  if (await exists(pomPath)) {
    addTechnology(technologies, { name: "Java", tone: "orange" });
    addTechnology(technologies, { name: "Maven", tone: "purple" });

    try {
      const pom = await readFile(pomPath, "utf8");
      if (/spring-boot/i.test(pom)) {
        addTechnology(technologies, { name: "Spring Boot", tone: "green" });
        capabilities.hasSpringBoot = true;
        const detectedPort = await detectSpringBootPort(repositoryPath);
        capabilities.devPortHint = detectedPort.port;
        capabilities.devPortSource = detectedPort.source;
      }
    } catch {
      // Presence still identifies a Maven/Java project.
    }

    capabilities.hasMavenWrapper = await exists(path.join(/* turbopackIgnore: true */ repositoryPath, "mvnw.cmd"));
    const wrapper = capabilities.hasMavenWrapper ? ".\\mvnw.cmd" : "mvn";
    commands.push(
      { label: "test", command: `${wrapper} test` },
      { label: "verify", command: `${wrapper} verify` },
    );
  }

  if (await exists(path.join(/* turbopackIgnore: true */ repositoryPath, "Dockerfile"))) {
    addTechnology(technologies, { name: "Docker", tone: "blue" });
  }

  if (["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].some((file) => configurationFiles.includes(file))) {
    addTechnology(technologies, { name: "Docker Compose", tone: "blue" });
  }

  if (await exists(path.join(/* turbopackIgnore: true */ repositoryPath, "pyproject.toml")) || await exists(path.join(/* turbopackIgnore: true */ repositoryPath, "requirements.txt"))) {
    addTechnology(technologies, { name: "Python", tone: "blue" });
  }

  return { technologies, configurationFiles, commands, capabilities };
}
