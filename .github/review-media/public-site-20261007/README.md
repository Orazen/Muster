# Public Workroom page review

Before images use exact base `3a4a091eafe2ce91714c381b2ddfb8eda438bc01` in an owned local fixture. After images use the frozen public-page candidate. These are local review captures, not production screenshots.

The 28 PNGs cover docs hub/readers, downloads, legal pages, teams and team dialogs, templates and switching pages at 1440px and 390px. Mobile comparison tables scroll internally; images show the initial left edge. Old team-page before images are omitted because that page requested external Google Fonts, which the isolated fixture deliberately did not fetch.

Release metadata and team catalog data are synthetic. The team dialog intentionally displays an escaped script string from its hostile-text test fixture; it does not execute. No live account, installer download or production write was used.

The final browser acceptance run passed 39 cases with no retries in 55.1 seconds. One separate baseline capture case passed in 7.6 seconds; two supplemental media-only cases passed in 14.2 seconds. Those three capture cases are not added to the 39 behavioral cases. All 70 frozen source hashes remained unchanged, and supplemental capture preserved the original 16 PNGs and browser receipt.

Independent source reviews accepted docs, support pages, shared CSS, legal presentation and the two new test instruments. The legal bodies and all 21 approved homepage/mascot files retain exact base bytes. Generated share/profile/directory changes are outside this candidate.

These fixtures emulate routing and do not prove production serving or authenticated app behavior. Browser responsive assertions and the screenshots are not a complete accessibility audit. Follow the PR checks and separately recorded release receipts for repository, hosted and served-version status.

`media-manifest.json` binds each image to its size and SHA256. The frozen browser receipt SHA256 is `365f87a760a077df6f8987332668dd38b479eab743fbea1fef1aa2ff2a1971d5`; the supplemental media receipt SHA256 is `7400bc60df828c95e209df1a6619fc204a11a1e41801881abc763018f8127578`.

Final local repository gate: `pnpm test` exited 0 on Node 24.21.0. Main suite: 525 files, 8,809 passed, 8 skipped, 0 failed (1604.19 seconds). Auxiliary checks: 13 native-loader, 22 broker, 21 updater, 14 desktop-lifecycle and 14 packaged-server checks: 84 passed. This is one file and five tests above the accepted 524/8804/8+84 baseline. Raw local gate log SHA256: `a77547927c8fce13389114bfd6b09400707d6ae1d831760bee611eaa6db83ce4`. All 70 frozen inputs remained unchanged. Hosted CI and deployment remain separate gates.
