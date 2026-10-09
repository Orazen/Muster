# Muster Linux ARM64 source lint

This private package keeps Muster's `pnpm lint` command (`oxlint .`). On Linux ARM64 GNU it uses an explicitly imported Oxc source build containing allocator fix `523d5374430ebc4a140239e5e8d43482235b022a`. Other platforms, including ARM64 musl, delegate to the pinned official `oxlint@1.86.0` package. This is not an upstream release of that fix, and a private build is not an installed-platform acceptance receipt.

The currently admitted GNU runtime is Node 24 / ABI 137 / glibc 2.36. Other GNU ARM64 runtime combinations fail with a preparation/runtime error; they are not silently redirected to the published binary or WASI. The root project retains `@oxlint/plugins@1.86.0`; that plugin API was exercised with this exact source build. Support for other GNU runtimes requires a separately verified build and updated source lock.

Preparation is explicit. Installation runs no build, import, postinstall or network acquisition:

```sh
node tools/oxlint-linux-arm64/prepare.mjs --from /your/pinned-oxc/apps/oxlint
pnpm lint
```

The import checks the 18 exact matching JavaScript/native/source package files in `source-lock.json`, the ELF64 ARM64 header and the upstream MIT license. It writes a fresh ignored `.omb-scratch/oxlint-linux-arm64-<commit>` directory and a completion record only after verification. Existing or partial output is preserved and refused; preparation never overwrites or deletes it. A missing or altered import makes lint fail. Runtime loads only the pinned local native, refuses native/WASI overrides, and verifies the prepared inventory afterward. These checks do not provide operating-system isolation.

To reproduce the source build, use the exact upstream commit and its lockfiles, Node 24.21.0, pnpm 12.7.0 and Rust 1.99.0, targeting `aarch64-unknown-linux-gnu`. The accepted release profile keeps allocator support, optimization level 3, fat LTO, one codegen unit and panic abort:

```sh
git checkout 523d5374430ebc4a140239e5e8d43482235b022a
pnpm install --frozen-lockfile --offline
pnpm --dir apps/oxlint run build-napi-release -- --frozen --offline
pnpm --dir apps/oxlint run build-js
```

Toolchains, registry dependencies and native build prerequisites must already be available. The import accepts only the recorded artifact bytes; byte-for-byte reproducibility on another host is not assumed. A different build output needs provenance and consumer review before changing the lock. Root Muster's pnpm 10.33.0 is distinct from the upstream build's pnpm 12.7.0. No compiled binary is committed or published by this package.

The prior private build and Linux consumer exercised all 30 custom-rule fixtures, 31 actual native-load observations and unchanged current-main lint: 1,290 files, one existing warning and zero errors. Its output parser failed on ANSI formatting; a separate strict SGR-only replay reconciled the complete raw evidence. Those historical checks are not a passing run of this new package. Integration must additionally check a fresh package install, explicit preparation, this bin's real GNU native-load provenance, the same custom rules and current repository lint. Focused data tests use synthetic ELF bytes and do not load a native binary.

This wrapper belongs to the private Muster repository and inherits its root license. Imported Oxc code is MIT licensed; its exact 1,119-byte license is copied into the prepared tree. Retain that notice with the derived artifacts. The official delegation dependency retains its own license. Do not publish this private package or its compiled artifact.
