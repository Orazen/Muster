#!/usr/bin/env python3
"""Promote a validated download payload on a Unix host, without moving its root.

The caller pins the transport manifest's SHA256. CI owns release provenance and
feed validation. This helper checks the transferred bytes and serializes local
promotion; it never deletes old updater targets or unrelated files.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

CLI = "muster-cli.mjs"
DESKTOP_STABLE = {"Muster.dmg", "Muster-intel.dmg", "Muster-setup.exe", "Muster.deb", "Muster.AppImage"}
STABLE = DESKTOP_STABLE | {CLI}
# Old published metadata predates the CLI inventory. Only new candidates require it.
BASE_STABLE = DESKTOP_STABLE - {"Muster-intel.dmg"}
FEEDS = {"latest-mac.yml", "latest.yml", "latest-linux.yml"}
ALIASES = STABLE | FEEDS | {"latest.json"}
FLAT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
SHA = re.compile(r"^[a-f0-9]{40}$")
DIGEST = re.compile(r"^[a-f0-9]{64}$")
STATE = ".mirror-state.json"


class PromotionError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise PromotionError(message)


def real_directory(path):
    path = Path(os.path.abspath(path))
    require(path.resolve() == path, "Directory path must not contain symlinks")
    require(stat.S_ISDIR(path.lstat().st_mode), "Expected a real directory")
    return path


def ensure_directory(path):
    try:
        path.mkdir(mode=0o755)
        sync_directory(path.parent)
    except FileExistsError:
        pass
    return real_directory(path)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


@contextlib.contextmanager
def regular_reader(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size > 0,
                "Expected a nonempty regular file without links: " + path.name)
        with os.fdopen(fd, "rb", closefd=False) as stream:
            yield stream, before
        require(identity(before) == identity(os.fstat(fd)), "File changed while reading: " + path.name)
        require(identity(before) == identity(path.lstat()), "File replaced while reading: " + path.name)
    finally:
        os.close(fd)


def descriptor(path):
    digest = hashlib.sha256()
    with regular_reader(path) as (stream, info):
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"name": path.name, "size": info.st_size, "sha256": digest.hexdigest()}


def json_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key")
        result[key] = value
    return result


def read_json(path):
    with regular_reader(path) as (stream, info):
        require(info.st_size <= 1024 * 1024, "Metadata exceeds 1 MiB")
        return json.loads(stream.read(), object_pairs_hook=json_pairs,
                          parse_constant=lambda value: (_ for _ in ()).throw(PromotionError("Invalid JSON number")))


def write_json(path, value):
    data = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def copy_verified(source, target, expected):
    digest = hashlib.sha256()
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    try:
        with os.fdopen(fd, "wb") as output:
            with regular_reader(source) as (input_stream, info):
                for chunk in iter(lambda: input_stream.read(1024 * 1024), b""):
                    digest.update(chunk)
                    output.write(chunk)
            require(info.st_size == expected["size"] and digest.hexdigest() == expected["sha256"],
                    "Copied bytes differ from manifest: " + source.name)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        target.unlink(missing_ok=True)
        raise


def parse_version(value):
    require(isinstance(value, str) and VERSION.fullmatch(value), "Expected a canonical stable version")
    return tuple(int(part) for part in value.split("."))


def metadata(path, version, sha, entries):
    data = read_json(path)
    require(isinstance(data, dict) and data.get("version") == version and data.get("sha") == sha,
            "latest.json version/SHA mismatch")
    require(isinstance(data.get("published"), str) and data["published"], "latest.json needs published timestamp")
    files, checksums = data.get("files"), data.get("checksums")
    require(isinstance(files, dict) and isinstance(checksums, dict), "Invalid latest.json file metadata")
    require(BASE_STABLE <= files.keys() <= STABLE and files.keys() == checksums.keys(), "Incomplete latest.json platforms")
    require(files.keys() == (entries.keys() & STABLE), "latest.json platform set differs from payload")
    for name, info in files.items():
        require(isinstance(info, dict) and info == {"size": entries[name]["size"], "sha256": entries[name]["sha256"]}
                and checksums[name] == entries[name]["sha256"], "latest.json bytes mismatch: " + name)
    return data


def versioned(name, version):
    return name == "Muster-" + version + "-cli.mjs" or (name.startswith("Muster-" + version + "-") or name == "Muster-" + version + ".dmg") \
        and name.endswith((".zip", ".dmg", ".exe", ".deb", ".AppImage", ".blockmap"))


def validate_cli(entries, version):
    cli_target = "Muster-" + version + "-cli.mjs"
    require(cli_target in entries, "Missing immutable CLI target")
    require(all(entries[CLI][field] == entries[cli_target][field] for field in ("size", "sha256")),
            "Stable CLI differs from immutable CLI target")


def load_candidate(root, candidate, version, sha, expected_manifest):
    parse_version(version)
    require(SHA.fullmatch(sha) and DIGEST.fullmatch(expected_manifest), "Invalid SHA argument")
    candidate = real_directory(candidate)
    require(candidate.parent == root / ".incoming" and FLAT.fullmatch(candidate.name), "Candidate must be a direct child of ROOT/.incoming")
    manifest_path = candidate / "mirror-manifest.json"
    require(descriptor(manifest_path)["sha256"] == expected_manifest, "Transport manifest SHA256 mismatch")
    manifest = read_json(manifest_path)
    require(isinstance(manifest, dict) and set(manifest) == {"schemaVersion", "version", "sha", "files"}
            and type(manifest["schemaVersion"]) is int and manifest["schemaVersion"] == 1
            and manifest["version"] == version and manifest["sha"] == sha, "Invalid transport manifest identity")
    require(isinstance(manifest["files"], list) and 1 <= len(manifest["files"]) <= 100, "Invalid manifest file list")
    entries = {}
    for entry in manifest["files"]:
        require(isinstance(entry, dict) and set(entry) == {"name", "size", "sha256"}, "Invalid manifest file entry")
        name = entry["name"]
        require(isinstance(name, str) and FLAT.fullmatch(name) and name not in entries
                and (name in ALIASES or versioned(name, version)), "Unsafe, duplicate or unmanaged manifest file")
        require(type(entry["size"]) is int and 0 < entry["size"] <= 2 ** 53 - 1
                and isinstance(entry["sha256"], str) and DIGEST.fullmatch(entry["sha256"]), "Invalid file size/hash")
        require(descriptor(candidate / name) == entry, "Candidate bytes mismatch: " + name)
        entries[name] = entry
    require(list(entries) == sorted(entries), "Manifest files must be sorted")
    require(set(os.listdir(candidate)) == set(entries) | {"mirror-manifest.json"}, "Unexpected candidate directory entry")
    require(BASE_STABLE | FEEDS | {"latest.json", CLI} <= entries.keys(), "Incomplete candidate payload")
    validate_cli(entries, version)
    latest = metadata(candidate / "latest.json", version, sha, entries)
    return candidate, entries, latest


def read_generation(root):
    pointer = root / ".current"
    require(pointer.is_symlink(), "Current pointer must be a symlink")
    target = os.readlink(pointer)
    parts = Path(target).parts
    require(len(parts) == 2 and parts[0] == ".generations" and FLAT.fullmatch(parts[1]), "Invalid current pointer target")
    generation = real_directory(root / target)
    state = read_json(generation / STATE)
    require(isinstance(state, dict) and state.get("kind") in ("legacy", "release", "empty")
            and state.get("schemaVersion") == 1, "Invalid generation state")
    auxiliary = state.get("auxiliary", {})
    require(isinstance(auxiliary, dict) and auxiliary.keys() <= {CLI}, "Invalid auxiliary inventory")
    for name, entry in auxiliary.items():
        require(descriptor(generation / name) == entry, "Auxiliary legacy bytes changed: " + name)
    if state["kind"] == "empty":
        require(set(state) - {"auxiliary"} == {"schemaVersion", "kind", "files"} and state["files"] == {}, "Invalid empty generation")
        return {**state, "path": generation}
    parse_version(state.get("version"))
    require(isinstance(state.get("sha"), str) and SHA.fullmatch(state["sha"]), "Invalid generation SHA")
    entries = state.get("files")
    require(isinstance(entries, dict) and BASE_STABLE | FEEDS | {"latest.json"} <= entries.keys(), "Incomplete generation")
    require(not (entries.keys() & auxiliary.keys()), "Auxiliary file duplicates published inventory")
    for name, entry in entries.items():
        require(isinstance(name, str) and FLAT.fullmatch(name)
                and (name in ALIASES or versioned(name, state["version"])), "Invalid generation file")
        require(descriptor(generation / name) == entry, "Published generation bytes changed: " + name)
    if CLI in entries:
        validate_cli(entries, state["version"])
    metadata(generation / "latest.json", state["version"], state["sha"], entries)
    return {**state, "path": generation}


def inspect_legacy(root):
    present = {name for name in ALIASES - {CLI} if os.path.lexists(root / name)}
    if not present:
        return None
    require(BASE_STABLE | FEEDS | {"latest.json"} <= present, "Legacy mirror is incomplete; repair before promotion")
    latest = read_json(root / "latest.json")
    require(isinstance(latest, dict), "Invalid legacy metadata")
    parse_version(latest.get("version"))
    require(isinstance(latest.get("sha"), str) and SHA.fullmatch(latest["sha"]), "Invalid legacy SHA")
    if isinstance(latest.get("files"), dict) and CLI in latest["files"]:
        present |= {CLI, "Muster-" + latest["version"] + "-cli.mjs"}
    entries = {name: descriptor(root / name) for name in sorted(present)}
    if CLI in entries:
        validate_cli(entries, latest["version"])
    metadata(root / "latest.json", latest["version"], latest["sha"], entries)
    return {"schemaVersion": 1, "kind": "legacy", "version": latest["version"], "sha": latest["sha"], "files": entries}


def untracked_cli(root, current):
    """Capture old public CLI bytes without inventing release provenance for them."""
    if CLI in current["files"] or CLI in current.get("auxiliary", {}):
        return None
    target = root / CLI
    if not os.path.lexists(target):
        return None
    if target.is_symlink():
        # A first-ever install may have stopped after creating a dangling alias.
        require(os.readlink(target) == ".current/" + CLI and not target.exists(),
                "Unexpected untracked CLI alias")
        return None
    return descriptor(target)


def check_monotonic(current, version, sha, entries):
    if current is None or current["kind"] == "empty":
        return False
    old, new = parse_version(current["version"]), parse_version(version)
    require(new >= old, "Refusing release downgrade")
    require((current["files"].keys() & STABLE) <= entries.keys(), "Refusing removal of a published platform")
    if new == old:
        require(current["sha"] == sha, "Same version has a different source SHA")
        if current["kind"] == "legacy":
            # Legacy metadata has no full target inventory. All managed aliases
            # must still match exactly; versioned collisions are checked below.
            require(all(entries.get(name) == info for name, info in current["files"].items()), "Same version has different published bytes")
        else:
            require(current["files"] == entries, "Same version has different published bytes")
        return True
    return False


def make_generation(root, source, state, checkpoint, auxiliary_source=None):
    directory = ensure_directory(root / ".generations")
    generation = directory / (state["kind"] + "-" + state.get("version", "initial") + "-" + uuid.uuid4().hex)
    generation.mkdir(mode=0o755)
    for name, entry in state["files"].items():
        copy_verified(source / name, generation / name, entry)
    for name, entry in state.get("auxiliary", {}).items():
        copy_verified((auxiliary_source or source) / name, generation / name, entry)
    write_json(generation / STATE, state)
    sync_directory(generation)
    sync_directory(directory)
    checkpoint("generation-ready", generation.name)
    return generation


def replace_pointer(root, generation):
    temporary = root / (".current-" + uuid.uuid4().hex)
    try:
        os.symlink(str(generation.relative_to(root)), temporary)
        os.replace(temporary, root / ".current")
        sync_directory(root)
    finally:
        temporary.unlink(missing_ok=True)


def ensure_aliases(root, current, candidate_entries, checkpoint):
    # During first migration both forms expose the same legacy bytes. A crash
    # may leave a mixture of files and aliases; this loop safely resumes it.
    current_files = {**current["files"], **current.get("auxiliary", {})}
    for name in sorted(ALIASES & (current_files.keys() | candidate_entries.keys())):
        target = root / name
        expected_link = ".current/" + name
        if target.is_symlink():
            require(os.readlink(target) == expected_link, "Unexpected public alias: " + name)
            continue
        if os.path.lexists(target):
            require(name in current_files and descriptor(target) == current_files[name], "Legacy alias changed: " + name)
        temporary = root / (".alias-" + uuid.uuid4().hex)
        try:
            os.symlink(expected_link, temporary)
            os.replace(temporary, target)
            sync_directory(root)
        finally:
            temporary.unlink(missing_ok=True)
        checkpoint("alias-ready", name)


def publish_versioned(root, candidate, entries, checkpoint):
    targets = {name: entry for name, entry in entries.items() if name not in ALIASES}
    # Validate all collisions before publishing even the first new file.
    for name, entry in targets.items():
        if os.path.lexists(root / name):
            require(descriptor(root / name) == entry, "Immutable updater target collision: " + name)
    for name, entry in targets.items():
        target = root / name
        if target.exists():
            continue
        temporary = root / (".target-" + uuid.uuid4().hex)
        try:
            copy_verified(candidate / name, temporary, entry)
            # All mirror writers hold the same flock. Rename publishes one
            # complete regular file; no interrupted hardlink cleanup is needed.
            require(not os.path.lexists(target), "Updater target appeared during publication")
            os.rename(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        sync_directory(root)
        checkpoint("target-ready", name)


def promote(root, candidate, version, sha, manifest_sha256, checkpoint=None):
    checkpoint = checkpoint or (lambda phase, detail: None)
    root = real_directory(root)
    # Kernel-owned flock is released after interruption/process death; there is
    # no stale PID guessing or unsafe lock deletion on retry.
    fd = os.open(root / ".promotion.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "Invalid promotion lock")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise PromotionError("Another promotion holds the lock") from error
        checkpoint("locked", "")
        candidate, entries, _ = load_candidate(root, candidate, version, sha, manifest_sha256)
        current = read_generation(root) if os.path.lexists(root / ".current") else inspect_legacy(root)
        unchanged = check_monotonic(current, version, sha, entries)
        # Fail collisions before bootstrapping legacy aliases or changing feeds.
        for name, entry in entries.items():
            if name not in ALIASES and os.path.lexists(root / name):
                require(descriptor(root / name) == entry, "Immutable updater target collision: " + name)
        if current is None:
            current = {"schemaVersion": 1, "files": {}, "kind": "empty"}
        auxiliary_cli = untracked_cli(root, current)
        if auxiliary_cli is not None:
            state = {key: value for key, value in current.items() if key != "path"}
            state["auxiliary"] = {CLI: auxiliary_cli}
            if "path" in current:
                # Preserve an already-managed generation's exact published bytes
                # while giving the unrelated flat CLI a resumable old-byte alias.
                state["path"] = make_generation(root, current["path"], state, checkpoint, auxiliary_source=root)
                replace_pointer(root, state["path"])
                checkpoint("auxiliary-current-ready", "")
            current = state
        if current is not None and "path" not in current:
            current["path"] = make_generation(root, root, current, checkpoint)
            replace_pointer(root, current["path"])
            # Persist an empty generation before creating aliases, so a crash
            # during the first-ever install can resume without mistaking its
            # dangling aliases for a corrupt legacy mirror.
            checkpoint("empty-current-ready" if current["kind"] == "empty" else "legacy-current-ready", "")
        ensure_aliases(root, current, entries, checkpoint)
        publish_versioned(root, candidate, entries, checkpoint)
        if unchanged and current["kind"] == "release":
            return {"status": "unchanged", "version": version, "sha": sha, "generation": str(current["path"].relative_to(root))}
        state = {"schemaVersion": 1, "kind": "release", "version": version, "sha": sha, "files": entries, "manifestSha256": manifest_sha256}
        generation = make_generation(root, candidate, state, checkpoint)
        checkpoint("before-promote", generation.name)
        replace_pointer(root, generation)
        checkpoint("promoted", generation.name)
        return {"status": "promoted", "version": version, "sha": sha, "generation": str(generation.relative_to(root))}
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--manifest-sha256", required=True)
    args = parser.parse_args()
    try:
        result = promote(args.root, args.candidate, args.version, args.sha, args.manifest_sha256)
        print(json.dumps(result, sort_keys=True))
    except (PromotionError, OSError, ValueError, TypeError, KeyError) as error:
        print("Mirror promotion rejected: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
