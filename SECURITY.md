# Security policy

## Supported versions

Muster ships as a rolling product: the current release tag (see
[Releases](https://github.com/Orazen/Muster/releases)) plus `main`.
Older releases receive no patches; update via the in-app updater or a
fresh download.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's **private vulnerability reporting** on this repository
(Security → Report a vulnerability). Reports reach the maintainers
directly and stay confidential until a fix ships.

Include: affected component (desktop app, local server, web UI, CLI,
companions), reproduction steps, and any evidence you can share.
Please do not test against installations you do not own.

## Scope notes

- Muster is local-first: the server and data live on the operator's
  machine. Remote access is explicit and pairing-based.
- Claims about security properties are made only from verified bytes
  (reproducible builds, checksums); release artifacts carry SHA256SUMS.
- This project is licensed under BSL 1.1 — see LICENSE.

## Disclosure

We coordinate disclosure: acknowledge, fix, publish, then credit the
reporter (unless anonymity is requested).
