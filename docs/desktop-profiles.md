# Desktop profiles

An advanced launch option gives a Muster desktop instance its own application-data directories. Reuse the same profile path on later launches to reopen that profile. Launching without `MUSTER_PROFILE_ROOT` keeps the existing default behavior.

## Launch on macOS

Choose a normalized absolute directory and supply both the environment variable and the browser-data switch when starting the app binary. Replace the example path with your chosen location; keep both quoted arguments intact.

```sh
muster_profile='/Users/your-name/Muster Profiles/research'
MUSTER_PROFILE_ROOT="$muster_profile" \
  /Applications/Muster.app/Contents/MacOS/Muster \
  "--user-data-dir=$muster_profile/user-data"
```

Adjust the app binary path if Muster is installed elsewhere. This is a startup setting, not a switch for an already running window. Use the same command for subsequent launches of this profile; opening the app normally does not select it.

The profile path must be nonempty, absolute, normalized, and below the filesystem root. Avoid `.` or `..` segments, a trailing slash, leading or trailing whitespace, and symbolic links in the path or its ancestors. Spaces inside a directory name are supported. For example, macOS `/tmp` is usually a link; a chosen temporary profile would need its actual `/private/tmp/...` path.

Exactly one `--user-data-dir=<profile>/user-data` argument must appear before any `--` separator. Setting the environment variable alone cannot redirect browser data that Chromium initializes before JavaScript runs. Muster checks that Electron already applied the matching browser-data directory, then configures the remaining paths before loading application modules or starting children.

Invalid configuration stops startup instead of falling back to the default profile. Startup checks the mapped directories and their ancestors, checks designated existing state files for links and writability, creates missing mapped directories, and checks again. These checks do not traverse arbitrary workspace or dependency contents.

## Directory layout

Paths below are relative to the selected profile root.

| Directory | Use |
| --- | --- |
| `user-data/` | Electron user and session data, including browser state and Muster's credential file |
| `muster/` | Harness configuration, auth and message databases, fleet state, events, and native session data |
| `companion/` | Companion service state |
| `home/` | Home directory supplied to the app and children; known engine configuration directories live here |
| `workspace/` | Initial working directory for the app and its embedded server |
| `app-data/`, `local-app-data/` | Application-data environment paths |
| `config/`, `cache/`, `data/`, `state/` | XDG configuration, cache, data, and state paths |
| `tmp/` | Electron and child temporary paths |
| `logs/`, `crash-dumps/` | App logs and crash dumps |

Profile setup replaces `HOME`, `USERPROFILE`, the app-data and XDG variables, and the temporary-directory variables with this layout. It sets `OMB_DATA_DIR`, `OMB_USER_DATA`, and `OMB_COMPANION_DIR` to the corresponding directories above. Known engine overrides include `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `FACTORY_HOME_OVERRIDE`, `HERMES_HOME`, `KIMI_CODE_HOME`, and `GROK_HOME`; inherited values for those keys are replaced with locations beneath `home/`.

Selecting a profile does not import the existing fleet. Legacy `~/.opengrokbot` migration is allowed only when `OMB_DATA_DIR` is unset and the default `~/.muster` directory does not exist. Any explicit `OMB_DATA_DIR`, including one spelling the default path, prevents that migration. An explicit blank override is rejected. Profile startup supplies an explicit data directory, so it does not move the legacy fleet into the selected profile.

## Engines and child processes

Engine discovery retains the supplied `PATH` and `OMB_EXTRA_PATH`, and scans known install locations using the selected home. Profile launches suppress the background login-shell probe, so a CLI discovered only through shell startup files may need an explicit binary directory in `PATH` or `OMB_EXTRA_PATH`. System install directories remain discoverable. Profile setup also sets `ZDOTDIR` and removes inherited `BASH_ENV` and `ENV` startup hooks.

The MCP client and bridge add explicit profile paths to their existing minimal child environment, including `MUSTER_PROFILE_ROOT` for nested Muster helpers. They do not automatically copy provider credentials, Node hooks, or arbitrary environment keys through this path map. A target's deliberately configured environment is applied last and can override these paths. Likewise, the initial working directory does not prevent a tool or configured bot from using another directory.

## Scope and verification

This is data separation, not a sandbox. OS services, permissions, network access, system credential stores, and credentials supplied through other environment variables or configured integrations are not isolated by choosing a profile. A separate local credential file does not create a separate OS credential store or revoke an existing provider account. Host-computer access remains an explicit app-session action governed by the existing controls.

Local tests cover startup configuration, migration boundaries, and actual MCP child path propagation. An actual macOS ARM64 Electron path/utility-child probe passed 37 checks; the packaged local sign-up, onboarding, fake-engine task and reload flow passed 10 checks with a fresh profile and harness-configured network responses. Windows path handling has test coverage as data; native Windows profile execution and native Google sign-in have not been verified by those tests. This contract does not establish simultaneous-profile support or a completed release of the feature.
