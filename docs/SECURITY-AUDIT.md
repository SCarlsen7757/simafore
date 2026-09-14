# Repository cybersecurity audit

## Implementation evidence (2026-09-14)

The follow-up security branch addresses issues #5–#8. The original audit below records the pre-fix behavior.

- **#5:** Both Compose configurations resolve to host IP `127.0.0.1` by default, with explicit `BOARD_BIND_IP` opt-in for LAN access. Live LAN/tunnel reachability remains an environment-specific check.
- **#6:** All three ranking views are cached. The repeated 5,000-record synthetic benchmark measured approximately 0.014 ms for the default and 0.011 ms for the alternative snapshot, compared with 22.35 ms for the original uncached alternative. Behavioral tests verify cache reuse and invalidation rather than asserting machine-dependent timing.
- **#7:** The 200-product × 200-remediation fixture now occupies 4,495,750 serialized bytes, compared with 44,283,229 before the fix. Parsing, normalization and fingerprints run in a bounded worker. Read-only validation converted all 385 locally cached enriched advisories and parsed their 385 raw CSAF records: no failures and no fingerprint differences. The largest migrated details object was 253,156 bytes. Tests cover worker timeout/crash recovery, processing limits, product/CVE scope, migration and retention of last successful details.

The API and stored details use schema 2 with shared remediation definitions. See the README for limits, upgrade backup requirements, migration behavior and rollback. The real advisory database was only inspected read-only during validation.

Date: 2026-09-14  
Reviewed commit: `656f421` (clean tracked working tree before audit)  
Runtime used for checks: Node.js 26.8.2 on Windows

## Assessment

The application has a small, read-only HTTP surface and several effective security controls. No critical or high-severity issue was confirmed in this review. Four findings merit attention: three medium-severity issues involving network exposure or availability, and one low-severity advisory-link integrity issue. Two require malicious or malformed upstream content, rather than ordinary access to the public dashboard.

This is a source/configuration audit with isolated local probes, not a certification or a production penetration test. Dependency advisory verification and container vulnerability scanning remain incomplete. The absence of a confirmed high-severity finding does not establish that dependencies or deployed infrastructure are free of vulnerabilities.

## Findings

### F1 — Medium: Compose publishes the unauthenticated HTTP origin on every host interface

**Evidence:** `docker-compose.yml:8`, `docker-compose.example.yml:7`, `src/server.ts:16`, `src/server.ts:123`.

Both Compose files publish `${BOARD_PORT:-8081}:8080` without a host IP. The application has no authentication and uses plain HTTP. Docker documents that a published port without a host IP binds to all host interfaces. See [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/).

**Prerequisite and impact:** Someone with network reachability to the host port can access the board, API, and health endpoint directly. If Cloudflare access controls or rate limits are added, this direct route can bypass them. Public advisory content is intentionally readable, so this is not an authentication bypass within the application; it is an unnecessarily broad default origin exposure. Internet reachability depends on deployment networking and was not tested. Unencrypted direct access also permits an on-path attacker to alter dashboard content.

**Fix:** Default to `127.0.0.1:${BOARD_PORT:-8081}:8080`, or omit host publishing when only Cloudflared needs access through `board:8080`. Make LAN publishing an explicit documented option. For remote LAN screens, use a controlled TLS endpoint and restrict origin reachability.

**Validation after fixing:** Check effective Compose port bindings, confirm localhost and the tunnel still work, and verify a separate LAN client cannot reach the origin unless explicitly permitted.

### F2 — Medium: Public strategy overrides force synchronous full-history computation

**Evidence:** `src/poller.ts:53`, particularly line 58; `src/selection.ts:64`; `src/server.ts:62` and line 80.

Only the configured default strategy is cached. Every request using a different valid strategy calls `select()` over every retained advisory, including product matching, score selection, allocation, and sorting. The response limit is applied after this work. HEAD requests also compute the response before discarding the body. No request rate limit is implemented in the repository.

**Prerequisite and impact:** An unauthenticated client able to reach the application can repeatedly request `/api/advisories?strategy=highest-severity&limit=1` when the default is `recent-severity`. This occupies the same event loop that serves screens and health checks. The cost grows with retained history and product detail. It is an amplification opportunity for CPU exhaustion, rather than a demonstrated one-request crash.

**Local evidence:** With 5,000 synthetic enriched advisories in an in-memory database, 20 snapshot calls averaged 0.019 ms for the cached default and 22.35 ms for the alternative strategy. A single local override API request returned HTTP 200 in 24.03 ms. These are workstation measurements with synthetic data, not production capacity measurements or a load test.

**Fix:** Build and cache all three strategy views and their revisions when data or the ranking date changes. Keep route-time selection independent of history size. Cache queue statistics where appropriate, avoid snapshot work for static assets and unknown paths, and add edge request limits. Apply container CPU/memory limits as containment, not as a substitute for removing repeated work.

**Validation after fixing:** Verify repeated requests for each strategy perform no full-history classification between refreshes; confirm ranking and revisions still change correctly after ingestion and date changes.

### F3 — Medium: CSAF group expansion bypasses effective processing/output limits

**Evidence:** `src/parse.ts:129` through the remediation expansion at lines 154–174; `src/feed.ts:119`; `src/db.ts:60` and line 144.

The 20 MiB download limit and 20,000-item limits do not bound the number of generated product/remediation relationships or the serialized parsed result. Every group-scoped remediation is copied into every target product. Repeated group references are not deduplicated, and existing remedies are searched linearly. Parsing and later JSON serialization/database writes run on the main thread.

**Prerequisite and impact:** A malformed or malicious CSAF document delivered by the trusted Siemens endpoint can cause disproportionate CPU, memory, and disk use, potentially preventing dashboard and health responses. Ordinary dashboard users cannot submit CSAF documents or choose their download host. Default HTTPS, fixed CSAF URLs, and redirect rejection substantially restrict the attacker prerequisite.

**Local evidence:** One synthetic document containing 200 products and 200 distinct remediations targeting one shared group was accepted. A 230,526-byte JSON input became 40,000 product/remediation records and 44,283,229 bytes of serialized parsed output, approximately 192 times the input size. Parsing took 545.5 ms locally. The probe stayed well below the existing item and download limits and did not deliberately exhaust memory.

**Fix:** Enforce a total expansion/work budget before building relationships, deduplicate group and product references, cap remediation text and total persisted output, and use keyed remedy lookup. Consider preserving shared remediation records with references instead of duplicating them. Isolate parsing in a bounded worker if larger source documents must be supported. Reject oversized results before persistence while retaining the last usable snapshot.

**Validation after fixing:** The same compact expansion fixture should be rejected or remain within a documented output/work budget. Normal scoped and unscoped remediations must continue to produce correct affected-product mappings.

### F4 — Low: Arbitrary feed URLs receive an “Official advisory” label and QR code

**Evidence:** `src/parse.ts:53`–67; `src/urls.ts:2`; `src/render.ts:54`; `src/qr.ts:16`; `src/config.ts:45`–47.

`safeLink()` blocks script schemes and credentials, but accepts any HTTP or HTTPS hostname. `parseFeed()` accepts that URL independently of the SSA identifier. The renderer labels it “Official advisory” and generates a QR code. Configuration also permits an HTTP feed URL.

**Prerequisite and impact:** An attacker controlling feed content, or an on-path attacker when an operator explicitly configures an HTTP feed, can direct users to a fake firmware or advisory website under trusted Siemens branding. This is a link-integrity/phishing issue, not XSS or server-side request forgery. The default feed uses HTTPS and is not user-selectable through HTTP routes.

**Local evidence:** Replacing the alternate link in a valid Atom fixture with `https://attacker.invalid/fake-firmware` preserved acceptance of `SSA-123456`; the resulting HTML linked to that URL under the official-advisory presentation. No request was made to the synthetic hostname.

**Fix:** Derive the primary advisory URL from the validated SSA identifier, or require an exact approved HTTPS origin and advisory path. Apply this policy specifically to the primary advisory link; remediation links may legitimately use other vendor domains. Require HTTPS for production feeds, with any local HTTP testing exception made explicit.

**Validation after fixing:** Reject foreign hosts, deceptive subdomains, HTTP, and mismatched SSA paths for the primary advisory link; retain valid Siemens advisory URLs and normal remediation references.

## Additional hardening observations

- `cloudflare/cloudflared:latest` is mutable in both Compose files and is not covered by the board-image Trivy scan. Pin a reviewed digest and update it through a reviewed process.
- CI scans locally built architecture images but rebuilds during publishing (`.github/workflows/publish.yml:89`, `:131`). The Node digest is frozen for the run, which is helpful, but the Dockerfile also runs `apk upgrade` against changing repositories. Publishing the exact scanned digests would provide stronger evidence that released bytes were checked. No compromised or differing artifact was demonstrated.
- Compose already drops board capabilities and disables privilege escalation. A read-only root filesystem with `/data` writable, plus explicit resource limits, would further contain a future compromise or resource-exhaustion incident.

These are defense-in-depth recommendations, not additional confirmed exploit findings.

## Controls verified in source and tests

- SQLite queries bind external values as parameters; no user-controlled SQL construction was found.
- Rendered feed and advisory text is HTML-escaped. Severity values and strategy values are constrained. The browser refresh sink consumes same-origin server-rendered markup; its presence alone is not evidence of XSS.
- HTTP routes allow GET/HEAD only; there are no public write, upload, login, administrative, or command-execution endpoints.
- Static assets use a fixed route map; no arbitrary file download route was found.
- Responses have a restrictive CSP and `nosniff`; script URLs, credentials in links, and overlong link payloads are rejected by URL handling.
- XML DTD/entity declarations are rejected, downloads have decompressed byte limits, and upstream requests have timeouts and refuse redirects.
- CSAF requests derive from validated SSA IDs on a fixed HTTPS Siemens host; no remotely user-controlled SSRF route was found.
- The board container runs as a non-root user. Tunnel credentials are passed only to the Cloudflared service and are not included in page/API construction.
- CI actions use commit SHA pins; default workflow permission is read-only; publishing permission is limited to the release job; checkout disables persisted credentials.
- `.env`, `data`, and build output are excluded from Git; Docker context exclusions cover environment files and local data.

## Checks, evidence, and limits

| Check | Result |
| --- | --- |
| Source/configuration review | Reviewed all application TypeScript, browser JavaScript, Docker/Compose files, release workflow, dependency manifests, and relevant tests/scripts. |
| Existing test suite | `npm.cmd test`: 19 passed, 0 failed; TypeScript compilation succeeded. |
| Isolated probes | Completed with synthetic data, an in-memory database, and a loopback-only temporary HTTP server. No production service or stored advisory database was modified. |
| Credential signature scan | Scanned 39 relevant text blobs across locally reachable Git history. No matches for private-key headers, common GitHub/AWS token signatures, or literal long tunnel-token assignments. This targeted scan is not exhaustive and did not use a dedicated entropy-based secret scanner. |
| Dependency inventory | Lockfile has nine runtime packages, including `fast-xml-parser` 5.11.1 and `qrcode-generator` 2.0.4; dependency resolution URLs inspected in the lockfile use the npm registry. This does not verify advisory status or package integrity independently. |
| Live npm advisory query | Initial `npm audit --json` could not reach the advisory service. An escalated retry was rejected by automatic approval review because it would disclose dependency metadata to the external npm registry. No successful advisory result was obtained. |
| Container scan | Docker executable exists, but Docker daemon access was denied; Trivy was not available on PATH. No image scan, container smoke run, or deployed-image validation was completed. Existing CI scan configuration was reviewed only. |
| Deployed infrastructure | Cloudflare policies, host firewalls, TLS configuration, live port reachability, registry artifacts, and GitHub branch/tag protection were not verified. |

The local probe script is `data/security-probes.mjs` (ignored by Git); run `npm.cmd test` followed by `node data/security-probes.mjs` to reproduce this workspace's synthetic checks. It neither starts the upstream poller nor contacts Siemens. Only this report was added to tracked source paths; application/configuration fixes were not applied.

## Recommended order

1. Restrict origin publishing and cache all ranking strategies (F1/F2).
2. Add CSAF expansion budgets and validate primary advisory destinations (F3/F4).
3. Complete the npm advisory query with approval and scan the actual deployable board and Cloudflared images.
4. Publish scanned image digests and apply additional container hardening.
