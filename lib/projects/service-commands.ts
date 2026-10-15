import type { ProjectScript, ProjectService } from "@/lib/workspace/types";

export type AllowlistedCommand = {
  executable: string;
  args: string[];
  cwd: string;
};

function windows(platform: NodeJS.Platform) {
  return platform === "win32";
}

export function requiresWindowsCommandShell(executable: string, platform: NodeJS.Platform = process.platform) {
  return windows(platform) && /\.(?:cmd|bat)$/i.test(executable);
}

export function packageScriptCommand(service: ProjectService, script: ProjectScript, platform: NodeJS.Platform = process.platform): AllowlistedCommand {
  const manager = service.capabilities.packageManager;
  if (!manager || !service.capabilities.packageScripts.includes(script)) throw new Error(`The ${script} package script is not available for this service.`);
  return {
    executable: `${manager}${windows(platform) ? ".cmd" : ""}`,
    args: manager === "npm" ? ["run", script] : [script],
    cwd: service.path,
  };
}

export function springLaunchArgs(service: ProjectService, port: number, springProfile: string | null = null) {
  // Keep long-running bootRun work in a session-scoped process tree instead of a reusable global Gradle daemon.
  if (service.capabilities.javaBuildTool === "gradle") {
    const applicationArgs = [`--server.port=${port}`, ...(springProfile ? [`--spring.profiles.active=${springProfile}`] : [])].join(" ");
    return ["--no-daemon", "bootRun", `--args=${applicationArgs}`];
  }
  if (service.capabilities.javaBuildTool === "maven") return [
    "spring-boot:run",
    ...(springProfile ? [`-Dspring-boot.run.profiles=${springProfile}`] : []),
    `-Dspring-boot.run.arguments=--server.port=${port}`,
  ];
  throw new Error("No supported Spring Boot build tool was detected.");
}

export function springWrapperCommand(service: ProjectService, port: number, platform: NodeJS.Platform = process.platform, springProfile: string | null = null): AllowlistedCommand | null {
  const args = springLaunchArgs(service, port, springProfile);
  if (service.capabilities.javaBuildTool === "gradle" && service.capabilities.hasGradleWrapper) {
    return { executable: windows(platform) ? ".\\gradlew.bat" : "./gradlew", args, cwd: service.path };
  }
  if (service.capabilities.javaBuildTool === "maven" && service.capabilities.hasMavenWrapper) {
    return { executable: windows(platform) ? ".\\mvnw.cmd" : "./mvnw", args, cwd: service.path };
  }
  return null;
}

export function javaCheckCommand(service: ProjectService, check: "test" | "build" | "verify", platform: NodeJS.Platform = process.platform): AllowlistedCommand | null {
  if (service.capabilities.javaBuildTool === "gradle" && service.capabilities.hasGradleWrapper && (check === "test" || check === "build")) {
    return { executable: windows(platform) ? ".\\gradlew.bat" : "./gradlew", args: [check], cwd: service.path };
  }
  if (service.capabilities.javaBuildTool === "maven" && service.capabilities.hasMavenWrapper && (check === "test" || check === "verify")) {
    return { executable: windows(platform) ? ".\\mvnw.cmd" : "./mvnw", args: [check], cwd: service.path };
  }
  return null;
}
