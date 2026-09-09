# Previous-run evidence on approval cards

Permission cards can carry the newest settled why-journal entry for the
requesting bot and task thread, strictly before the ask. Both normal asks
and failed automatic-approval fallbacks attach the same optional snapshot.
Missing matching history leaves the card unchanged.

Web, iPhone and Watch display a collapsed “Previous run” disclosure with
time, outcome, intent, decisions, and optional hypothesis/findings. The
existing one-tap Deny/Allow responses are unchanged. Old cards decode without
the new field. Watch remains a foreground client; this slice does not add
background push approval delivery.

The snapshot is historical context, not the current approval's rationale.
Journal entries are written only when runs settle. Selection filters bot
and thread before choosing the newest entry, including detached task
threads, and excludes future/equal-time entries. Failed and partial
outcomes remain explicit.

Wire field: `card.why`, with `source: "previous-run"`, `runId`, `botId`,
`threadId`, millisecond `at`, `intent`, `decisions`, `outcome`, optional
`hypothesis` and `findings`. Display text is bounded to 300 characters;
decisions to three entries of 200 characters. Credential-shaped content is
redacted before truncation and again at the transcript persistence boundary.
The card retains its snapshot across hydration, SSE delivery and resolution.

Verification covers selection isolation, ordering, missing evidence, text
bounds, copy independence, redaction/persistence, native decoding of old and
new cards, message patching and approval resolution. Native changes also
require unsigned iOS and Watch simulator builds.
