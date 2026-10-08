import express from "express";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { loadConfig, createIdentityResolver, runtimeRequest as backendRequest, AdapterError } from "./adapter.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest
} from "@modelcontextprotocol/sdk/types.js";

const VERSION = "0.4.1";
const PORT = Number(process.env.PORT || 3000);
const config = loadConfig();
const HOST = config.host;
const MOCK_MODE = config.mock;
const resolveIdentity = createIdentityResolver(config);
const caller = new AsyncLocalStorage();

const WORKFLOW_TYPES = ["PROFILE_BUILD", "RECOMMEND_AND_PLAN"];
const VIEW_TYPES = [
  "PROFILE",
  "CAREER_CANDIDATES",
  "PATH",
  "SKILL_TREE",
  "TASK_BOARD",
  "TRAINING",
  "GROWTH_REPORT",
  "CAREER_GRAPH"
];
const TARGET_REF_TYPES = ["LearningTaskInstance", "PracticeAttempt", "Scorecard", "ReviewCase"];

const runs = new Map();
const artifacts = new Map();
const idempotentResults = new Map();

function asObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function requireString(obj, key) {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(obj, key) {
  const value = obj[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function requireInteger(obj, key) {
  const value = obj[key];
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

function parseJsonObject(text, name, { required = true } = {}) {
  if (text === undefined || text === null || text === "") {
    if (!required) return undefined;
    throw new Error(`${name} is required`);
  }
  if (typeof text !== "string") throw new Error(`${name} must be a JSON string`);

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must decode to a JSON object`);
  }
  return value;
}

function ok(data, message = "OK") {
  return {
    success: true,
    data,
    message,
    request_id: `req_${randomUUID()}`
  };
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
  };
}

function toolError(error) {
  if (error instanceof AdapterError) return { ...toolResult(error.envelope), isError: true };
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify({
        success: false,
        error: {
          code: "MCP_INVALID_ARGUMENT",
          message,
          retryable: false
        }
      }, null, 2)
    }]
  };
}

async function runtimeRequest(path, init = {}) {
  return backendRequest(config, caller.getStore(), path, init);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createArtifact(viewType, payload) {
  const id = `artifact_${randomUUID()}`;
  artifacts.set(id, { view_type: viewType, view_version: 1, payload });
  return { id, version: 1, type: viewType };
}

function mockStart(args) {
  const replay = idempotentResults.get(args.idempotency_key);
  if (replay) return replay;

  const runId = `run_${randomUUID()}`;
  const run = {
    run_id: runId,
    workflow_type: args.workflow_type,
    status: "WAITING_USER",
    current_step: args.workflow_type === "PROFILE_BUILD" ? "PROFILE_INTAKE" : "RECOMMENDATION_PREP",
    reason_code: null,
    state_version: 1,
    next_actions: args.workflow_type === "PROFILE_BUILD"
      ? ["SUBMIT_PROFILE_INPUT"]
      : ["REQUEST_RECOMMENDATION"],
    artifact_refs: [],
    last_event_sequence: 1
  };

  runs.set(runId, run);
  const result = ok(clone(run), "Mock workflow created");
  idempotentResults.set(args.idempotency_key, result);
  return result;
}

function mockStatus(runId) {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  return ok(clone(run), "Mock status");
}

function mockContinue(args) {
  const replay = idempotentResults.get(args.idempotency_key);
  if (replay) return replay;

  const run = runs.get(args.runId);
  if (!run) throw new Error(`Run not found: ${args.runId}`);

  if (run.state_version !== args.expected_state_version) {
    throw new Error(`State version conflict: expected ${args.expected_state_version}, current ${run.state_version}`);
  }
  if (!run.next_actions.includes(args.action)) {
    throw new Error(`Action ${args.action} is not allowed. next_actions=${JSON.stringify(run.next_actions)}`);
  }

  if (args.action === "SUBMIT_PROFILE_INPUT") {
    const ref = createArtifact("PROFILE", {
      source: "MOCK",
      profile_status: "PUBLISHED",
      summary: "Mock profile created from submitted input.",
      submitted_payload: args.payload
    });
    run.artifact_refs.push(ref);
    run.status = "COMPLETED";
    run.current_step = "PROFILE_READY";
    run.next_actions = [];
  } else if (args.action === "REQUEST_RECOMMENDATION") {
    const ref = createArtifact("CAREER_CANDIDATES", {
      source: "MOCK",
      candidates: [
        {
          ranking_item_id: "rank_item_001",
          career_name: "Java Backend Engineer",
          recommendation_group: "CURRENT_FIT",
          rank: 1
        },
        {
          ranking_item_id: "rank_item_002",
          career_name: "Data Engineer",
          recommendation_group: "DEVELOPMENT",
          rank: 2
        }
      ]
    });

    run.artifact_refs.push(ref);
    run.status = "WAITING_USER";
    run.current_step = "CAREER_TARGET_CONFIRMATION";
    run.next_actions = ["CONFIRM_CAREER_TARGET", "REJECT_RECOMMENDATION_ITEM"];
  } else if (args.action === "REJECT_RECOMMENDATION_ITEM") {
    run.status = "WAITING_USER";
    run.current_step = "PREFERENCE_REVISION";
    run.next_actions = ["SUBMIT_PREFERENCE_REVISION"];
  } else if (args.action === "SUBMIT_PREFERENCE_REVISION") {
    run.status = "WAITING_USER";
    run.current_step = "RECOMMENDATION_PREP";
    run.next_actions = ["REQUEST_RECOMMENDATION"];
  } else {
    run.status = "RUNNING";
    run.current_step = args.action;
    run.next_actions = [];
  }

  run.state_version += 1;
  run.last_event_sequence += 1;

  const result = ok(clone(run), "Mock workflow advanced");
  idempotentResults.set(args.idempotency_key, result);
  return result;
}

function mockConfirm(args) {
  const replay = idempotentResults.get(args.idempotency_key);
  if (replay) return replay;

  const run = runs.get(args.runId);
  if (!run) throw new Error(`Run not found: ${args.runId}`);

  if (run.state_version !== args.expected_state_version) {
    throw new Error(`State version conflict: expected ${args.expected_state_version}, current ${run.state_version}`);
  }
  if (!run.next_actions.includes("CONFIRM_CAREER_TARGET")) {
    throw new Error(`CONFIRM_CAREER_TARGET is not allowed. next_actions=${JSON.stringify(run.next_actions)}`);
  }

  const ref = createArtifact("PATH", {
    source: "MOCK",
    ranking_item_id: args.ranking_item_id,
    recommendation_group: args.recommendation_group,
    confirmed: true,
    note: "Mock career target confirmation result."
  });

  run.artifact_refs.push(ref);
  run.status = "COMPLETED";
  run.current_step = "CAREER_TARGET_CONFIRMED";
  run.next_actions = [];
  run.state_version += 1;
  run.last_event_sequence += 1;

  const result = ok(clone(run), "Mock career target confirmed");
  idempotentResults.set(args.idempotency_key, result);
  return result;
}

function mockArtifact(artifactId, view) {
  const artifact = artifacts.get(artifactId);
  if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
  if (artifact.view_type !== view) {
    throw new Error(`View mismatch: artifact=${artifact.view_type}, requested=${view}`);
  }
  return ok(artifact, "Mock artifact");
}

const tools = [
  {
    name: "career_run_start",
    description: "创建职业工作流。用户明确同意后调用；读取服务器返回的 run_id、state_version、next_actions，不得用聊天历史代替服务器状态。",
    inputSchema: {
      type: "object",
      properties: {
        command_id: { type: "string", description: "本次操作唯一命令 ID；同一操作重试保持不变。" },
        idempotency_key: { type: "string", description: "幂等键；同一操作重试保持不变。" },
        workflow_type: {
          type: "string",
          enum: WORKFLOW_TYPES,
          description: "仅允许 PROFILE_BUILD 或 RECOMMEND_AND_PLAN。"
        },
        payload_json: {
          type: "string",
          description: "业务 payload 的 JSON 字符串；必须解码为对象，不得携带身份或凭证。"
        }
      },
      required: ["command_id", "idempotency_key", "workflow_type", "payload_json"],
      additionalProperties: false
    }
  },
  {
    name: "career_run_status",
    description: "查询工作流真实状态、允许动作、产物引用与事件游标。继续或确认前优先调用。",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "必须来自服务器返回的 run_id，不得编造。"
        }
      },
      required: ["runId"],
      additionalProperties: false
    }
  },
  {
    name: "career_run_continue",
    description: "仅提交最新 next_actions 中允许的动作；expected_state_version 必须来自最新状态。subject_ref_json/target_ref_json 为可选 JSON 字符串。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        command_id: { type: "string" },
        idempotency_key: { type: "string" },
        action: {
          type: "string",
          description: "必须来自最新 career_run_status.next_actions。"
        },
        expected_state_version: { type: "integer", minimum: 0 },
        payload_json: {
          type: "string",
          description: "业务 payload 的 JSON 字符串；必须解码为对象。"
        },
        subject_ref_json: {
          type: "string",
          description: "可选 subject_ref JSON 字符串，形如 {\"id\":\"...\",\"version\":1,\"type\":\"...\"}。"
        },
        target_ref_json: {
          type: "string",
          description: "可选 target_ref JSON 字符串；type 仅允许 LearningTaskInstance / PracticeAttempt / Scorecard / ReviewCase。"
        }
      },
      required: [
        "runId",
        "command_id",
        "idempotency_key",
        "action",
        "expected_state_version",
        "payload_json"
      ],
      additionalProperties: false
    }
  },
  {
    name: "career_decision_confirm",
    description: "确认目标职业。仅在用户明确确认且最新 next_actions 允许 CONFIRM_CAREER_TARGET 时调用。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        command_id: { type: "string" },
        idempotency_key: { type: "string" },
        expected_state_version: { type: "integer", minimum: 0 },
        subject_ref_json: {
          type: "string",
          description: "当前推荐产物引用的 JSON 字符串，必须来自服务器 artifact_refs。"
        },
        ranking_item_id: {
          type: "string",
          description: "必须来自当前推荐结果。"
        },
        recommendation_group: {
          type: "string",
          enum: ["CURRENT_FIT", "DEVELOPMENT"]
        }
      },
      required: [
        "runId",
        "command_id",
        "idempotency_key",
        "expected_state_version",
        "subject_ref_json",
        "ranking_item_id",
        "recommendation_group"
      ],
      additionalProperties: false
    }
  },
  {
    name: "artifact_get",
    description: "使用工作流返回的 artifact_refs 读取展示结果。artifactId 必须来自服务器；仅展示响应事实和证据。",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string" },
        view: { type: "string", enum: VIEW_TYPES }
      },
      required: ["artifactId", "view"],
      additionalProperties: false
    }
  }
];

async function handleTool(name, rawArgs) {
  const args = asObject(rawArgs ?? {}, "arguments");
  const definition = tools.find(tool => tool.name === name);
  if (!definition || Object.keys(args).some(key => !(key in definition.inputSchema.properties))) {
    throw new Error('Unknown tool or argument; identity cannot be supplied by tool arguments');
  }
  const actor = caller.getStore()?.actor;

  if (name === "career_run_start") {
    const command_id = requireString(args, "command_id");
    const idempotency_key = requireString(args, "idempotency_key");
    const workflow_type = requireString(args, "workflow_type");
    if (!WORKFLOW_TYPES.includes(workflow_type)) {
      throw new Error(`Unsupported workflow_type: ${workflow_type}`);
    }
    const payload = parseJsonObject(args.payload_json, "payload_json");

    const normalized = { command_id, idempotency_key, workflow_type, actor, payload };
    return MOCK_MODE
      ? mockStart(normalized)
      : runtimeRequest("/career/runs", {
          method: "POST",
          body: JSON.stringify(normalized)
        });
  }

  if (name === "career_run_status") {
    const runId = requireString(args, "runId");
    return MOCK_MODE
      ? mockStatus(runId)
      : runtimeRequest(`/career/runs/${encodeURIComponent(runId)}`);
  }

  if (name === "career_run_continue") {
    const runId = requireString(args, "runId");
    const command_id = requireString(args, "command_id");
    const idempotency_key = requireString(args, "idempotency_key");
    const action = requireString(args, "action");
    const expected_state_version = requireInteger(args, "expected_state_version");
    const payload = parseJsonObject(args.payload_json, "payload_json");
    const subject_ref = parseJsonObject(
      optionalString(args, "subject_ref_json"),
      "subject_ref_json",
      { required: false }
    );
    const target_ref = parseJsonObject(
      optionalString(args, "target_ref_json"),
      "target_ref_json",
      { required: false }
    );

    if (target_ref?.type && !TARGET_REF_TYPES.includes(target_ref.type)) {
      throw new Error(`Unsupported target_ref.type: ${target_ref.type}`);
    }

    const normalized = {
      runId,
      command_id,
      idempotency_key,
      actor,
      action,
      expected_state_version,
      payload,
      ...(subject_ref ? { subject_ref } : {}),
      ...(target_ref ? { target_ref } : {})
    };

    if (MOCK_MODE) return mockContinue(normalized);

    const { runId: ignored, ...body } = normalized;
    return runtimeRequest(`/career/runs/${encodeURIComponent(runId)}/actions`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  if (name === "career_decision_confirm") {
    const runId = requireString(args, "runId");
    const command_id = requireString(args, "command_id");
    const idempotency_key = requireString(args, "idempotency_key");
    const expected_state_version = requireInteger(args, "expected_state_version");
    const subject_ref = parseJsonObject(args.subject_ref_json, "subject_ref_json");
    const ranking_item_id = requireString(args, "ranking_item_id");
    const recommendation_group = requireString(args, "recommendation_group");

    if (!["CURRENT_FIT", "DEVELOPMENT"].includes(recommendation_group)) {
      throw new Error(`Unsupported recommendation_group: ${recommendation_group}`);
    }

    const normalized = {
      runId,
      command_id,
      idempotency_key,
      expected_state_version,
      subject_ref,
      ranking_item_id,
      recommendation_group
    };

    if (MOCK_MODE) return mockConfirm(normalized);

    return runtimeRequest(
      `/career/runs/${encodeURIComponent(runId)}/career-decisions`,
      {
        method: "POST",
        body: JSON.stringify({
          command_id,
          idempotency_key,
          actor,
          action: "CONFIRM_CAREER_TARGET",
          expected_state_version,
          subject_ref,
          payload: {
            ranking_item_id,
            recommendation_group
          }
        })
      }
    );
  }

  if (name === "artifact_get") {
    const artifactId = requireString(args, "artifactId");
    const view = requireString(args, "view");
    if (!VIEW_TYPES.includes(view)) {
      throw new Error(`Unsupported view: ${view}`);
    }

    return MOCK_MODE
      ? mockArtifact(artifactId, view)
      : runtimeRequest(
          `/artifacts/${encodeURIComponent(artifactId)}?view=${encodeURIComponent(view)}`
        );
  }

  throw new Error(`Unknown tool: ${name}`);
}

function createMcpServer() {
  const server = new Server(
    { name: "a02-careeragent-mcp", version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await handleTool(
        request.params.name,
        request.params.arguments ?? {}
      );
      return toolResult(result);
    } catch (error) {
      return toolError(error);
    }
  });

  return server;
}

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, Last-Event-ID"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Mcp-Session-Id"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

async function authorize(req, res, next) {
  try {
    req.trustedIdentity = await resolveIdentity(req.get('authorization'));
    next();
  } catch (error) {
    res.status(401).json(error instanceof AdapterError ? error.envelope : { success: false, error: { code: 'MCP_IDENTITY_INVALID', message: 'Identity verification failed', retryable: false } });
  }
}

app.get("/", (_req, res) => {
  res.json({
    name: "a02-careeragent-mcp",
    version: VERSION,
    transport: "streamableHttp",
    endpoint: "/mcp",
    health: "/health",
    mock_mode: MOCK_MODE,
    identity_mode: MOCK_MODE ? 'MOCK' : config.identityMode,
    environment: config.environment
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "a02-careeragent-mcp",
    version: VERSION,
    mock_mode: MOCK_MODE,
    identity_mode: MOCK_MODE ? 'MOCK' : config.identityMode,
    environment: config.environment
  });
});

const transports = new Map();

app.post("/mcp", authorize, async (req, res) => {
  try {
    const sessionId = req.get("mcp-session-id");
    let transport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports.set(newSessionId, transport);
        }
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      transport.onerror = (error) => {
        console.error("[mcp transport error]", error);
      };

      const server = createMcpServer();
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid MCP session ID provided"
        },
        id: null
      });
      return;
    }

    await caller.run(req.trustedIdentity, () => transport.handleRequest(req, res, req.body));
  } catch (error) {
    console.error("[POST /mcp error]", error);

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error"
        },
        id: null
      });
    }
  }
});

async function handleSessionRequest(req, res) {
  try {
    const sessionId = req.get("mcp-session-id");
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).send("Invalid or missing Mcp-Session-Id");
      return;
    }

    const transport = transports.get(sessionId);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error(`[${req.method} /mcp error]`, error);

    if (!res.headersSent) {
      res.status(500).send("Internal server error");
    }
  }
}

app.get("/mcp", authorize, handleSessionRequest);
app.delete("/mcp", authorize, handleSessionRequest);

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`CareerAgent MCP ${VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`Streamable HTTP endpoint: /mcp`);
  console.log(`Health endpoint: /health`);
  console.log(`MOCK_MODE=${MOCK_MODE}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down...`);
  for (const transport of transports.values()) {
    try {
      transport.close?.();
    } catch {}
  }

  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
