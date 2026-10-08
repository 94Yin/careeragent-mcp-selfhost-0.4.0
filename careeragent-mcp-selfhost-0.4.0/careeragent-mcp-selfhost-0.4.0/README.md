# CareerAgent MCP 0.4.1 — local real Backend adapter

This release connects the five MCP tools to the frozen CareerAgent HTTP API. Real mode is the default. Missing `CAREER_RUNTIME_BASE_URL` fails startup; connection failures never fall back to fixtures.

## Identity boundary

`TEST_LOCAL` supports the accepted local runtime. The independent `TEST_NGROK` candidate supports controlled cloud TEST/FIXTURE integration using pinned public keys; see [candidate runbook](deploy/TEST_NGROK.md). For TEST_LOCAL: It requires `MCP_ENVIRONMENT=TEST`, non-production `NODE_ENV`, a loopback listener, loopback Backend and loopback trusted JWKS. Production configuration fails closed until a production Ant identity adapter is implemented. The Docker/Render files default to real mode but are not a completed public Ant deployment.

A secret MCP caller credential maps to one operator-configured Backend JWT. Each authenticated request verifies that JWT's RS256 signature, expiry, subject and `actor_role=PERSONAL_USER`. The actor is derived from verified claims and passed through request-local context. Tools reject an `actor` argument. This is a single-user TEST mapping, not an Ant multi-user identity implementation.

## Local bootstrap

Install dependencies with `npm ci`. Configure process environment using `.env.example` as a template; the server does not automatically load dotenv files. Keep secrets in ignored local files, never in source or evidence.

Required environment:

```text
NODE_ENV=test
HOST=127.0.0.1
PORT=13040
MOCK_MODE=false
MCP_ENVIRONMENT=TEST
MCP_IDENTITY_MODE=TEST_LOCAL
CAREER_RUNTIME_BASE_URL=http://127.0.0.1:8080/api/v1
CAREER_RUNTIME_JWKS_URL=http://127.0.0.1:19090/.well-known/jwks.json
CAREER_RUNTIME_TIMEOUT_MS=10000
MCP_BEARER_TOKEN=<random secret at least 32 characters>
CAREER_RUNTIME_TOKEN=<fresh signed TEST User A JWT>
```

Run `npm start`. Health is `http://127.0.0.1:13040/health`; Streamable HTTP is `http://127.0.0.1:13040/mcp`. Authenticate every MCP request with `Authorization: Bearer <MCP_BEARER_TOKEN>`. After rotating TEST JWKS/JWT, restart MCP with the fresh token. The Backend token is never accepted from tool arguments.

## Tools and authoritative responses

- `career_run_start`: sends command/idempotency keys, workflow type, trusted actor and payload.
- `career_run_status`: authoritative Backend run GET.
- `career_run_continue`: sends `action` (not `action_id`), expected state version, subject, payload and trusted actor.
- `career_decision_confirm`: sends `CONFIRM_CAREER_TARGET`, exact ranking subject, item/group and trusted actor.
- `artifact_get`: authoritative Backend artifact GET with the official view.

Use `tools/list` for complete argument schemas. JSON object arguments remain encoded in the existing `payload_json` / `subject_ref_json` fields where specified. `actor` is not a tool argument.

Tool content is the Backend JSON envelope with `http_status` added. Backend failures set MCP `isError=true` and preserve `code`, `message`, `retryable`, `request_id`, and version fields without flattening them into a string. MCP transport HTTP success is distinct from the Backend status carried in tool content.

Requests have a 10-second timeout, configurable from 1 to 60000 ms, including response body consumption. Timeout (`MCP_BACKEND_TIMEOUT`), connection failure (`MCP_BACKEND_UNAVAILABLE`) and invalid envelopes are distinct from Backend business errors. No requests are automatically retried. After a write timeout the outcome can be unknown: read authoritative state before deciding whether to replay the same idempotent command.

Explicit mock mode requires `MOCK_MODE=true`, `MCP_ENVIRONMENT=TEST` or `DEV`, non-production NODE_ENV and loopback HOST. It is excluded from real acceptance evidence.

## Verification

`npm test` runs 67 unit/transport/security regression tests, using isolated test HTTP servers for contract cases. They are separate from real integration evidence.

`node tests/real-backend-smoke.mjs` performs 23 calls against the real MCP / Spring / MySQL stack. It requires a fresh, unconsumed seeded Decision Run, fresh recovery fixture and tokens under the sibling CareerAgent `.runtime/frontend-integration`, plus this project's ignored `.runtime/mcp-auth.env`. It writes secret-free results to the sibling CareerAgent `evidence/mcp-repair-20261007` directory. Reset/reseed and restart the services before repeating it; a prior run consumes Decision and first-failure state.

The real smoke proves MCP start, HTTP GET and MCP status refer to the same recommendation run. It uses a separate PROFILE_BUILD run and its advertised CANCEL_RUN action for continue, and a fresh READ fixture for the five artifact views. It does not claim the newly started recommendation has completed, or that Ant/Frontend same-run integration has been accepted.
