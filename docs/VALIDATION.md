# Verification — 2026-09-14

- TypeScript typecheck, ESLint, Prettier check and 15 automated tests passed.
- Tests passed on the project's minimum Node 26.8.1 runtime.
- Dependency audit reported zero vulnerabilities.
- amd64 and arm64 Docker images built successfully; both passed endpoint, non-root, local-font and bind-persistence smoke tests.
- Source-build and published-image Compose configurations validated, including the optional tunnel profile.
- Live Atom ingestion and CSAF enrichment succeeded; the local Docker deployment retained 1,029 distinct advisories during this check. History enrichment continues in the background.
- Seven synthetic 1080p browser scenes passed: standard, empty, single, long, missing details, partial fixes and stale feed.
- Rotation, a simulated five-minute slot, scaling to 720p, connection loss, failed content replacement and recovery passed browser checks.
- Six real advisory layouts passed overflow checks without browser runtime or Content Security Policy errors.

The local preview runs at http://localhost:8081/tv. No image was pushed to a registry and no public tunnel was provisioned. GitHub Actions and its configured image vulnerability scans have not run remotely. Physical Anthias playback and phone QR scanning still require a device trial.

Browser screenshots are in `data/browser-check`; `board.png` is a representative live preview. These checks used synthetic test stores or isolated data directories, except for reading the live local deployment's public endpoints. The Beckhoff project was not modified.

## Rate limiting and focus-header update

Repeated Siemens HTTP 403 responses were observed. The exact upstream limit is unknown. The updated fetcher serializes feed/detail requests, defaults to 60-second spacing, honors Retry-After, and persists a shared escalating cooldown. Existing requests were paused for an hour; the deployed application's health endpoint confirmed that cooldown survived recreation. No Siemens probes were used to test this change.

All 18 automated tests pass, including simulated blocking, restart persistence, Retry-After and cooldown escalation. The five transport/poller tests also pass on Node 26.8.1. Both Compose configurations validate. Seven synthetic browser scenes and six cached live advisory layouts pass with the QR code in the focus header and additional room for product rows. The live preview screenshot has been updated.
