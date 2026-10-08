# TEST_NGROK candidate (MCP 0.4.1)

This is an isolated TEST/FIXTURE candidate. It does not implement formal Ant user identity or establish a public tunnel. Keep the existing service unchanged. Never publish without explicit approval.

## Identity and key distribution

`TEST_LOCAL` continues using the original loopback JWKS. `TEST_NGROK` never fetches a JWKS URL. It loads one RSA public key from `A02_TEST_JWKS_FILE`, verifies its exact bytes against the independently approved `A02_TEST_JWKS_SHA256`, rejects private/unknown key fields, requires RSA >=2048 bits / RS256 / signature use, and retains the verified document in memory. A file replacement cannot silently change the loaded trust anchor. A changed file on restart fails unless its approved digest also changes. Deployment administrators who can replace both trust anchor and digest remain trusted; this is not protection against a compromised deployment administrator.

Upload **only** `public-jwks.json` as Render Secret File `a02-test-public-jwks.json`, mounted at `/etc/secrets/a02-test-public-jwks.json`. Independently compare its SHA-256 to the local signed-off deployment manifest before setting the digest environment variable. This is an integrity pin, not a password. Do not fetch a pin from the tunnel itself. Secret Files and environment values must be set at runtime, never Docker ARG/COPY or Git. The private key never leaves the Windows issuer process.

Cloud JWT verification requires:

- algorithm RS256 and the pinned key;
- issuer exactly `urn:a02:careeragent:test`;
- audience exactly `urn:a02:careeragent:backend:test`;
- `exp`, `iat`, subject and `actor_role=PERSONAL_USER`;
- lifetime at most one hour; expiry enforced, future iat rejected;
- `environment=TEST`, `data_class=FIXTURE`;
- subject exactly configured `frontend_fixture_user_a` or `frontend_fixture_user_b`;
- explicit TEST session deadline within 24 hours, enforced on every authenticated request.

The actor is derived solely from validated claims. The MCP caller secret authenticates the TEST integration, not the Ant end user. `A02_TUNNEL_KEY` authenticates Render to the Gateway, not the Ant user. Never call either secret a real user credential. Formal Ant identity is a separate future integration.

Existing local fixture tokens have no issuer/audience and are intentionally rejected by TEST_NGROK. Use the explicit issuer below for a later approved controlled test. Backend must be configured to trust this issuer's local public JWKS; do not alter the frozen Backend contract or publish that JWKS through Gateway.

## Windows issuer (manual, not automatically started)

Run from the MCP project directory. First restrict `.runtime/cloud-test` to the operator before any secret file is created:

```powershell
$cloudDir = Join-Path $PWD '.runtime\cloud-test'
New-Item -ItemType Directory -Force $cloudDir | Out-Null
icacls $cloudDir /inheritance:r /grant:r "$([Security.Principal.WindowsIdentity]::GetCurrent().Name):(OI)(CI)F"
$env:MCP_ENVIRONMENT = 'TEST'
$env:MCP_DATA_CLASS = 'FIXTURE'
$env:NODE_ENV = 'test'
node deploy/test-issuer.mjs
```

The process binds only `127.0.0.1:19091`, writes public-jwks.json, public-manifest.json and ignored identity.env, and generates 30-minute User A/B JWTs without printing them. It exposes only the public JWKS GET. It does not save private keys or support remote signing. Restart creates a new trust anchor: rotate tokens, file and digest together, with reapproval. Stop on signing-key compromise; stopping the issuer alone does **not** revoke already-issued cloud tokens before expiry. Stop the MCP/Gateway or revoke their service credentials for immediate shutdown.

For that approved run, set the frozen Backend's existing `A02_INTEGRATION_JWK_SET_URI=http://127.0.0.1:19091/.well-known/jwks.json` and restart it with existing worker settings. This invalidates use of the older TEST identity for that runtime; update local MCP/Frontend TEST auth consistently. This phase has not changed or restarted the real Backend issuer configuration.

## Cloud configuration

| Variable | Required value / purpose |
|---|---|
| MOCK_MODE | false |
| MCP_ENVIRONMENT | TEST |
| MCP_DATA_CLASS | FIXTURE |
| MCP_IDENTITY_MODE | TEST_NGROK |
| NODE_ENV | test; production is deliberately rejected |
| HOST | 0.0.0.0 for Render |
| PORT | Render-provided port |
| CAREER_RUNTIME_ALLOWED_ORIGIN | exact approved `https://<assigned>.ngrok-free.app` origin; also supports single-label ngrok.app/ngrok.dev |
| CAREER_RUNTIME_BASE_URL | exactly that origin plus `/api/v1` |
| CAREER_RUNTIME_TIMEOUT_MS | 10000 default, 1..60000 |
| A02_TUNNEL_KEY | 64 hex characters from the Windows Gateway's independent key, stored as Render Secret |
| MCP_BEARER_TOKEN | independent caller secret, at least 32 characters |
| CAREER_RUNTIME_TOKEN | short-lived TEST JWT from the local issuer |
| A02_TEST_JWKS_FILE | /etc/secrets/a02-test-public-jwks.json |
| A02_TEST_JWKS_SHA256 | independently approved digest of exact public-file bytes |
| MCP_TEST_SUBJECT | one exact fixture user |
| MCP_TEST_EXPIRES_AT | explicit ISO timestamp, future and within 24h at startup |

Unset `CAREER_RUNTIME_JWKS_URL` in cloud mode: even a configured external URL is rejected. HTTP, wildcard origins, credentials in URLs, alternate origins/ports, query/hash and production modes are rejected. The header is always `X-A02-Tunnel-Key`; no historical alternative is supported. Redirects fail, writes are never automatically retried, and no failure triggers Mock.

`/health` is liveness, not proof of a working ngrok/Backend connection. Authentication is checked on actual MCP requests and can fail after the JWT/demo expires even while the process stays alive.

## Render candidate

- Branch: `codex/test-ngrok-candidate` (local only until separately approved).
- Root Directory: `careeragent-mcp-selfhost-0.4.0/careeragent-mcp-selfhost-0.4.0`.
- Blueprint path relative to repository: that directory plus `/render-test.yaml`.
- Dockerfile Path relative to Root Directory: `./Dockerfile.test`; Build Context: `.`.
- Service: `a02-careeragent-mcp-test-ngrok`, separate from the existing service.
- Automatic deploy disabled. The initial service creation can still deploy; do not create/sync it until approved.
- Docker build runs `npm ci --omit=dev --ignore-scripts`. Only package manifests, server.js and adapter.js are copied. Runtime is non-root. Issuer, private/local configs and tests are not included in the image.
- Version remains 0.4.1 and health shows TEST_NGROK; identify this candidate by its branch/commit, not version alone.

Render paths are root-relative per https://render.com/docs/monorepo-support; autoDeployTrigger: off per https://render.com/docs/blueprint-spec. Secret files must be mounted/readable to the non-root runtime; verify before deployment.

## Local validation versus pending public validation

`npm test` includes original TEST_LOCAL, Gateway and TEST_NGROK regressions. The cloud transport unit cases use intercepted fetch within isolated tests; a separate real local MCP transport verifies schemas and actor-spoof rejection. They do not claim public HTTPS/ngrok/Render success. The TEST issuer itself is launched only by its isolated local test and stopped afterward.

Before any ngrok security test: approved ngrok account/domain, key-protected Windows Gateway, fresh Backend configured with this public issuer, signed-off pinned public file, fresh JWT/deadline, and explicit approval to expose a protected test tunnel are required. Do not expose 8080/3306/19091 or management routes. Gateway is 127.0.0.1:18080. Verify external missing/wrong service key, JWT401, owner403, real409/500, TLS, forbidden routes, timeout and disconnects before Ant integration.

## Rollback

No push/deploy/public tunnel is part of this change. For a later failed independent service deployment, suspend the candidate, revoke its caller/tunnel credentials and stop ngrok. Keep the old Render service and Ant binding unchanged. Restore prior local Backend JWKS configuration and reissue corresponding local tokens if the approved test had changed it. JWTs remain valid until expiry unless the verifying service/trust anchor is withdrawn; rollback is not automatic token revocation. Do not downgrade to Mock and describe it as success.
