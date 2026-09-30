const RUNTIME_ENVIRONMENT_KEYS = new Set([
  "ALL_PROXY",
  "APPDATA",
  "COLORTERM",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "COMSPEC",
  "COREPACK_HOME",
  "GRADLE_HOME",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "JAVA_HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "M2_HOME",
  "MAVEN_HOME",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_PREFIX",
  "NPM_CONFIG_USERCONFIG",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PNPM_HOME",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

/**
 * Builds the OS/toolchain boundary for a launched application. Repository
 * configuration is intentionally absent so the target framework can load it
 * from that repository instead of inheriting DevHub's application settings.
 */
export function createBoundedRuntimeEnvironment(
  inherited: Record<string, string | undefined>,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const environment: Record<string, string | undefined> = {};

  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && RUNTIME_ENVIRONMENT_KEYS.has(name.toUpperCase())) {
      environment[name] = value;
    }
  }

  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) environment[name] = value;
  }

  return environment as NodeJS.ProcessEnv;
}
