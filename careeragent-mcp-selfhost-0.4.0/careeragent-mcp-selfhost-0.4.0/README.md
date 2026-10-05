# CareerAgent MCP — self-hosted Streamable HTTP 0.4.0

Purpose: deploy CareerAgent as a public MCP Server and connect it to Ant TBox using:

- MCP creation mode: **自部署 MCP**
- Connection: **streamableHttp**
- MCP URL: `https://YOUR_HOST/mcp`

This build keeps the five CareerAgent tools and defaults to `MOCK_MODE=true`.

## Files

- `server.js`: Streamable HTTP MCP server
- `Dockerfile`: pinned Node.js `22.21.0`
- `render.yaml`: optional Render blueprint
- `.env.example`: environment variable template

## Local run

```powershell
npm install
npm start
```

Expected:

```text
CareerAgent MCP 0.4.0 listening on http://0.0.0.0:3000
Streamable HTTP endpoint: /mcp
Health endpoint: /health
MOCK_MODE=true
```

Health check:

```powershell
curl.exe http://127.0.0.1:3000/health
```

## Test with MCP Inspector

Run the server first, then start Inspector:

```powershell
npx @modelcontextprotocol/inspector
```

Open the Inspector URL shown in the terminal. In the UI:

- Transport Type: `Streamable HTTP`
- URL: `http://127.0.0.1:3000/mcp`
- Connect
- List Tools

Expected tools:

- `career_run_start`
- `career_run_status`
- `career_run_continue`
- `career_decision_confirm`
- `artifact_get`

## Docker local test

```powershell
docker build -t a02-careeragent-mcp:0.4.0 .
docker run --rm -p 3000:3000 -e MOCK_MODE=true a02-careeragent-mcp:0.4.0
```

Then open:

```text
http://127.0.0.1:3000/health
```

## Render deployment

Create a new Web Service from this folder/repository. The included `render.yaml`
and `Dockerfile` are ready for a Docker deployment.

After deployment, suppose Render gives:

```text
https://a02-careeragent-mcp.onrender.com
```

Then in Ant TBox use:

```text
MCP 创建方式: 自部署 MCP
连接方式: streamableHttp
MCP URL: https://a02-careeragent-mcp.onrender.com/mcp
```

For the first Mock-mode test, leave headers empty.

## Optional endpoint authentication

Set:

```text
MCP_BEARER_TOKEN=some-long-random-secret
```

Then configure TBox:

```text
Authorization: Bearer some-long-random-secret
```

## Switch to the real Career Workflow Runtime

Set:

```text
MOCK_MODE=false
CAREER_RUNTIME_BASE_URL=https://YOUR_RUNTIME/api/v1
CAREER_RUNTIME_TOKEN=...
```

The model never receives runtime credentials. Identity should be mapped by a trusted adapter.

## Important

This package is for **remote/self-hosted MCP**. It is not the npm/stdio one-click deployment package.
