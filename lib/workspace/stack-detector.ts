import "server-only";

import { access, readFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectCommand, Technology } from "./types";

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

export async function detectStack(repositoryPath: string) {
  const technologies: Technology[] = [];
  const commands: ProjectCommand[] = [];
  const configurationFiles: string[] = [];

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

      const packageManager = (await exists(path.join(/* turbopackIgnore: true */ repositoryPath, "pnpm-lock.yaml")))
        ? "pnpm"
        : (await exists(path.join(/* turbopackIgnore: true */ repositoryPath, "package-lock.json")))
          ? "npm"
          : (await exists(path.join(/* turbopackIgnore: true */ repositoryPath, "yarn.lock")))
            ? "yarn"
            : "npm";

      addTechnology(technologies, { name: packageManager, tone: "orange" });

      for (const script of ["dev", "test", "lint", "build"]) {
        if (packageJson.scripts?.[script]) {
          commands.push({ label: script, command: `${packageManager} ${packageManager === "npm" ? "run " : ""}${script}` });
        }
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
      if (/spring-boot/i.test(pom)) addTechnology(technologies, { name: "Spring Boot", tone: "green" });
    } catch {
      // Presence still identifies a Maven/Java project.
    }

    const wrapper = (await exists(path.join(/* turbopackIgnore: true */ repositoryPath, "mvnw.cmd"))) ? ".\\mvnw.cmd" : "mvn";
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

  return { technologies, configurationFiles, commands };
}
