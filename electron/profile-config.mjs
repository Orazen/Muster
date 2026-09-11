import fs from "node:fs";
import path from "node:path";

const fail = (message) => { throw new Error(`Invalid MUSTER_PROFILE_ROOT: ${message}`); };

/** Build the explicit data layout without reading paths or mutating the app. */
export function resolveProfileConfiguration({ env = process.env, argv = process.argv, pathApi = path } = {}) {
  const root = env.MUSTER_PROFILE_ROOT;
  if (root === undefined) return null;
  if (!Object.is(String(root), root) || !root || root.trim() !== root || /[\0\r\n]/.test(root)) fail("supply a nonempty absolute normalized path");
  if (!pathApi.isAbsolute(root) || pathApi.resolve(root) !== root || pathApi.parse(root).root === root) fail("supply an absolute normalized directory below the filesystem root");
  const at = (...segments) => pathApi.join(root, ...segments);
  const home = at("home");
  const userData = at("user-data");
  const separator = argv.indexOf("--");
  const launchArgs = separator < 0 ? argv : argv.slice(0, separator);
  const switches = launchArgs.filter((arg) => arg === "--user-data-dir" || arg.startsWith("--user-data-dir="));
  if (switches.length !== 1 || switches[0] !== `--user-data-dir=${userData}`) {
    fail(`launch with exactly --user-data-dir=${userData}`);
  }
  const electronPaths = {
    home, appData: at("app-data"), userData, sessionData: userData,
    logs: at("logs"), temp: at("tmp"), crashDumps: at("crash-dumps"),
  };
  const environment = {
    MUSTER_PROFILE_ROOT: root,
    HOME: home, USERPROFILE: home,
    APPDATA: electronPaths.appData, LOCALAPPDATA: at("local-app-data"),
    XDG_CONFIG_HOME: at("config"), XDG_CACHE_HOME: at("cache"),
    XDG_DATA_HOME: at("data"), XDG_STATE_HOME: at("state"),
    TMPDIR: electronPaths.temp, TMP: electronPaths.temp, TEMP: electronPaths.temp,
    MAC_CHROMIUM_TMPDIR: electronPaths.temp,
    OMB_DATA_DIR: at("muster"), OMB_USER_DATA: userData, OMB_COMPANION_DIR: at("companion"),
    // An explicit profile overrides these known engine locations as a group.
    // Importing one inherited absolute home would reconnect the old account.
    CODEX_HOME: pathApi.join(home, ".codex"), CLAUDE_CONFIG_DIR: pathApi.join(home, ".claude"),
    FACTORY_HOME_OVERRIDE: home, HERMES_HOME: pathApi.join(home, ".hermes"),
    KIMI_CODE_HOME: pathApi.join(home, ".kimi-code"), GROK_HOME: pathApi.join(home, ".grok"),
    ZDOTDIR: home,
  };
  const cwd = at("workspace");
  const directories = [...new Set([root, ...Object.values(electronPaths), ...Object.values(environment), cwd,
    ...[".factory", ".qwen", ".gemini", ".opencode", ".unsloth"].map((name) => pathApi.join(home, name)),
  ])];
  const files = [
    pathApi.join(userData, "credentials.bin"), pathApi.join(userData, "cua-connection.json"),
    at("logs", "server.log"), at("muster", "config.json"), at("muster", "auth.secret"),
    at("muster", "bots.json"), at("muster", "groups.json"),
    ...["auth.db", "messages.db"].flatMap((name) => [name, `${name}-wal`, `${name}-shm`]).map((name) => at("muster", name)),
  ];
  return Object.freeze({ root, cwd, electronPaths: Object.freeze(electronPaths), environment: Object.freeze(environment), directories: Object.freeze(directories), files: Object.freeze(files) });
}

function existingDirectory(directory, fileSystem) {
  let info;
  try { info = fileSystem.lstatSync(directory); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`expected an unlinked directory: ${directory}`);
  if ((info.mode & 0o222) === 0 || (info.mode & 0o111) === 0) fail(`directory is not writable/searchable: ${directory}`);
  fileSystem.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK);
  return true;
}

/** Check mapped paths, not arbitrary workspace/cache/dependency contents. */
export function validateProfileDirectories(configuration, { fileSystem = fs, pathApi = path } = {}) {
  for (const directory of configuration.directories) {
    let current = directory;
    while (true) {
      // Ancestors are traversed but need not be writable when the profile
      // itself already exists; their identity must still never be a symlink.
      let info;
      try { info = fileSystem.lstatSync(current); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (info && (info.isSymbolicLink() || !info.isDirectory())) fail(`path contains a linked or non-directory ancestor: ${current}`);
      const parent = pathApi.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (!existingDirectory(directory, fileSystem)) {
      let parent = pathApi.dirname(directory);
      while (!fileSystem.existsSync(parent)) parent = pathApi.dirname(parent);
      existingDirectory(parent, fileSystem);
    }
  }
  for (const target of configuration.files) {
    let info;
    try { info = fileSystem.lstatSync(target); }
    catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) fail(`startup-owned file is linked or non-regular: ${target}`);
    if ((info.mode & 0o222) === 0) fail(`startup-owned file is not writable: ${target}`);
    fileSystem.accessSync(target, fs.constants.R_OK | fs.constants.W_OK);
  }
}

/** Apply before importing modules that capture Electron paths or start children.
 * This separates app data; it does not isolate OS permissions, services or I/O.
 */
export function configureProfilePaths({ app, env = process.env, argv = process.argv, fileSystem = fs, pathApi = path, chdir = process.chdir.bind(process) }) {
  const configuration = resolveProfileConfiguration({ env, argv, pathApi });
  if (!configuration) return null;
  if (app.isReady()) fail("profile setup must run before Electron becomes ready");
  // --user-data-dir must have taken effect before JS, not merely been added
  // to argv later. Reading this path never creates the real user's logs.
  if (app.getPath("userData") !== configuration.electronPaths.userData) fail("Electron did not apply the required launch-time user-data directory");
  validateProfileDirectories(configuration, { fileSystem, pathApi });
  for (const directory of configuration.directories) fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  validateProfileDirectories(configuration, { fileSystem, pathApi });

  for (const [name, directory] of Object.entries(configuration.electronPaths)) {
    if (name === "logs") app.setAppLogsPath(directory);
    else app.setPath(name, directory);
  }
  // Windows environments are case-insensitive. Remove stale variants so the
  // canonical profile values cannot coexist with a conflicting inherited key.
  const replaced = new Set([...Object.keys(configuration.environment), "BASH_ENV", "ENV"]);
  for (const key of Object.keys(env)) if (replaced.has(key.toUpperCase())) delete env[key];
  Object.assign(env, configuration.environment);
  chdir(configuration.cwd);
  return configuration;
}
