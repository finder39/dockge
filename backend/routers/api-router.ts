import { DockgeServer } from "../dockge-server";
import { Router } from "../router";
import express, { Express, Request, Response, NextFunction, Router as ExpressRouter } from "express";
import { Stack } from "../stack";
import { log } from "../log";
import { DockgeSocket, ValidationError } from "../util-server";
import { UNKNOWN, CREATED_FILE, CREATED_STACK, RUNNING, EXITED, RUNNING_AND_EXITED, UNHEALTHY } from "../../common/util-common";
import { Agent } from "../models/agent";
import childProcessAsync from "promisify-child-process";
import crypto from "crypto";
import { StackSettingsService } from "../stack-settings-service";
import { UpdateHistoryService } from "../update-history-service";
import { Settings } from "../settings";
import { Cron } from "croner";

const STATUS_NAMES: Record<number, string> = {
    [UNKNOWN]: "unknown",
    [CREATED_FILE]: "created_file",
    [CREATED_STACK]: "created_stack",
    [RUNNING]: "running",
    [EXITED]: "exited",
    [RUNNING_AND_EXITED]: "running_and_exited",
    [UNHEALTHY]: "unhealthy",
};

/** Validate stack name matches Dockge's allowed pattern: [a-z0-9_-]+ */
const VALID_STACK_NAME = /^[a-z0-9_-]+$/;

async function apiKeyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check Settings DB first, then fall back to env var
    const settingsKey = await Settings.get("apiKey") as string | null;
    const apiKey = settingsKey || process.env.DOCKGE_API_KEY;

    if (!apiKey) {
        res.status(503).json({ error: "API key not configured. Generate one in Settings or set DOCKGE_API_KEY environment variable." });
        return;
    }

    const provided = req.headers["x-api-key"];
    if (typeof provided !== "string" || provided.length !== apiKey.length ||
        !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(apiKey))) {
        res.status(401).json({ error: "Invalid or missing API key" });
        return;
    }

    next();
}

/** Middleware to validate :name param matches allowed stack name pattern */
function validateStackName(req: Request, res: Response, next: NextFunction): void {
    const name = req.params.name;
    if (!name || !VALID_STACK_NAME.test(name)) {
        res.status(400).json({ ok: false, error: "Invalid stack name" });
        return;
    }
    next();
}

/** Validate endpoint query param format if provided */
function validateEndpoint(endpoint: string | undefined): boolean {
    if (!endpoint || endpoint === "") {
        return true; // empty = local/master
    }
    // Endpoint is a host:port string (e.g., "192.168.1.100:5001")
    // Allow alphanumeric, dots, colons, hyphens, spaces
    return /^[a-zA-Z0-9._: -]+$/.test(endpoint);
}

/**
 * Resolve an endpoint query param that may be an agent name (e.g. "Voltorb")
 * to the actual endpoint string. Returns the original value if no name match.
 */
async function resolveEndpoint(endpoint: string | undefined): Promise<string> {
    if (!endpoint || endpoint === "") {
        return "";
    }
    // If it looks like a host:port already, return as-is
    if (/^\d/.test(endpoint) || endpoint.includes(":")) {
        return endpoint;
    }
    // Try to match against agent names (case-insensitive)
    const agentList = await Agent.getAgentList();
    for (const url in agentList) {
        const agent = agentList[url];
        const name = agent.name || "";
        if (name.toLowerCase() === endpoint.toLowerCase()) {
            return agent.endpoint;
        }
    }
    // No match — return original (will likely fail downstream, which is correct)
    return endpoint;
}

/**
 * Find a logged-in browser socket (used only for agent management operations
 * that need to update the UI, like adding/removing agents).
 */
function findBrowserSocket(server: DockgeServer): DockgeSocket | null {
    for (const [, socket] of server.io.sockets.sockets) {
        const ds = socket as DockgeSocket;
        if (ds.instanceManager && ds.userID) {
            return ds;
        }
    }
    return null;
}

/**
 * Emit an event to a remote agent via the server's persistent agent manager.
 * Returns a promise that resolves with the callback result.
 */
function emitToAgent(server: DockgeServer, endpoint: string, eventName: string, ...args: unknown[]): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Timeout waiting for response from agent ${endpoint}`));
        }, 30000);

        server.serverAgentManager.emitToEndpoint(endpoint, eventName, ...args, (result: Record<string, unknown>) => {
            clearTimeout(timeout);
            resolve(result);
        }).catch((e: Error) => {
            clearTimeout(timeout);
            reject(e);
        });
    });
}

export class ApiRouter extends Router {
    create(app: Express, server: DockgeServer): ExpressRouter {
        const router = express.Router();

        // All /api routes require API key (except /api/health which is public)
        router.get("/api/health", (_req: Request, res: Response) => {
            res.json({ status: "ok", version: server.packageJSON.version });
        });

        // Apply API key middleware to all other /api routes
        router.use("/api", apiKeyAuth);

        // GET /api/agents — list all connected agents
        router.get("/api/agents", async (_req: Request, res: Response) => {
            try {
                const agentList = await Agent.getAgentList();
                const agents: { endpoint: string; name: string; url: string; version: string | null }[] = [];

                // The master agent may or may not be persisted in the DB (url="").
                // Check if a master entry exists; if not, add a default one.
                let hasMaster = false;

                for (const url in agentList) {
                    const agent = agentList[url];
                    if (url === "" || agent.endpoint === "") {
                        hasMaster = true;
                        agents.push({
                            endpoint: "",
                            name: agent.name || "master",
                            url: "",
                            version: server.packageJSON.version ?? null,
                        });
                    } else {
                        agents.push({
                            endpoint: agent.endpoint,
                            name: agent.name || agent.endpoint,
                            url: agent.url,
                            version: server.serverAgentManager.getVersion(agent.endpoint) ?? null,
                        });
                    }
                }

                if (!hasMaster) {
                    agents.unshift({
                        endpoint: "",
                        name: "master",
                        url: "",
                        version: server.packageJSON.version ?? null,
                    });
                }

                res.json({ ok: true, agents });
            } catch (e) {
                log.error("api", "GET /api/agents error: " + e);
                res.status(500).json({ ok: false, error: "Failed to list agents" });
            }
        });

        // POST /api/agents — add/register a new agent
        router.post("/api/agents", async (req: Request, res: Response) => {
            try {
                const { url, username, password, name } = req.body;
                if (!url || typeof url !== "string") {
                    res.status(400).json({ ok: false, error: "url is required" });
                    return;
                }

                // Test connectivity, persist to DB, connect both server-level and browser managers
                server.serverAgentManager.connect(url, username || "", password || "");

                const ds = findBrowserSocket(server);
                if (ds) {
                    const manager = ds.instanceManager;
                    await manager.test(url, username || "", password || "");
                    await manager.add(url, username || "", password || "", name || "");
                    manager.connect(url, username || "", password || "");
                    manager.sendAgentList();
                } else {
                    // No browser session — persist via DB directly
                    const { R } = await import("redbean-node");
                    let bean = R.dispense("agent") as Agent;
                    bean.url = url;
                    bean.username = username || "";
                    bean.password = password || "";
                    bean.name = name || "";
                    await R.store(bean);
                }

                res.json({ ok: true, message: "Agent added successfully" });
            } catch (e) {
                log.error("api", "POST /api/agents error: " + e);
                const msg = e instanceof Error ? e.message : "Failed to add agent";
                res.status(500).json({ ok: false, error: msg });
            }
        });

        // GET /api/agents/status — check connectivity of all agents
        router.get("/api/agents/status", async (_req: Request, res: Response) => {
            try {
                const agentList = await Agent.getAgentList();
                const agents: { endpoint: string; name: string; url: string; connected: boolean; version: string | null }[] = [];

                // Master is always "connected"
                agents.push({ endpoint: "", name: "master", url: "", connected: true, version: server.packageJSON.version ?? null });

                for (const url in agentList) {
                    const agent = agentList[url];
                    if (!url || agent.endpoint === "") continue;

                    agents.push({
                        endpoint: agent.endpoint,
                        name: agent.name || agent.endpoint,
                        url: agent.url,
                        connected: server.serverAgentManager.isConnected(agent.endpoint),
                        version: server.serverAgentManager.getVersion(agent.endpoint) ?? null,
                    });
                }

                res.json({ ok: true, agents });
            } catch (e) {
                log.error("api", "GET /api/agents/status error: " + e);
                res.status(500).json({ ok: false, error: "Failed to check agent status" });
            }
        });

        // GET /api/stacks — list stacks from all agents (local + remote)
        router.get("/api/stacks", async (_req: Request, res: Response) => {
            try {
                type ServiceInfo = { name: string; containerName: string; image: string; state: string; status: string; health: string; imageUpdateAvailable: boolean };
                type StackInfo = { name: string; status: string; statusCode: number; isManagedByDockge: boolean; endpoint: string; autoUpdate: boolean; imageUpdatesAvailable: boolean; services: Record<string, ServiceInfo> };
                const stacks: StackInfo[] = [];

                // Local stacks
                const stackList = await Stack.getStackList(server, true);
                for (const [name, stack] of stackList) {
                    const simpleData = stack.getSimpleData("");
                    stacks.push({
                        name,
                        status: STATUS_NAMES[stack.status] || "unknown",
                        statusCode: stack.status,
                        isManagedByDockge: stack.isManagedByDockge,
                        endpoint: "",
                        autoUpdate: Stack.autoUpdateCache.get(Stack.autoUpdateCacheKey(name, "")) ?? false,
                        imageUpdatesAvailable: simpleData.imageUpdatesAvailable,
                        services: Object.fromEntries(stack.services),
                    });
                }

                // Remote agent stacks
                const agentList = await Agent.getAgentList();
                for (const url in agentList) {
                    const agent = agentList[url];
                    if (!url || agent.endpoint === "") {
                        continue; // Skip master
                    }
                    try {
                        const result = await emitToAgent(server, agent.endpoint, "getStackList");
                        if (result.ok && result.stackList) {
                            const agentStacks = result.stackList as Record<string, { name: string; status: number; isManagedByDockge: boolean; endpoint: string; imageUpdatesAvailable?: boolean; services?: Record<string, ServiceInfo> }>;
                            for (const name in agentStacks) {
                                const s = agentStacks[name];
                                stacks.push({
                                    name: s.name || name,
                                    status: STATUS_NAMES[s.status] || "unknown",
                                    statusCode: s.status,
                                    isManagedByDockge: s.isManagedByDockge,
                                    endpoint: agent.endpoint,
                                    autoUpdate: Stack.autoUpdateCache.get(Stack.autoUpdateCacheKey(name, agent.endpoint)) ?? false,
                                    imageUpdatesAvailable: s.imageUpdatesAvailable ?? false,
                                    services: s.services ?? {},
                                });
                            }
                        }
                    } catch (e) {
                        log.warn("api", `Failed to get stacks from agent ${agent.endpoint}: ${e}`);
                    }
                }

                res.json({ ok: true, stacks });
            } catch (e) {
                log.error("api", "GET /api/stacks error: " + e);
                res.status(500).json({ ok: false, error: "Failed to list stacks" });
            }
        });

        // GET /api/stacks/:name/status — detailed stack status
        // Optional query param: ?endpoint= to specify which agent (default: local)
        router.get("/api/stacks/:name/status", validateStackName, async (req: Request, res: Response) => {
            try {
                const endpoint = await resolveEndpoint((req.query.endpoint as string) || "");

                if (!validateEndpoint(endpoint)) {
                    res.status(400).json({ ok: false, error: "Invalid endpoint format" });
                    return;
                }

                if (endpoint && endpoint !== "") {
                    // Proxy to agent
                    const result = await emitToAgent(server, endpoint, "getStack", req.params.name);
                    if (result.ok && result.stack) {
                        const data = result.stack as Record<string, unknown>;
                        res.json({
                            ok: true,
                            stack: {
                                name: data.name,
                                status: STATUS_NAMES[data.status as number] || "unknown",
                                statusCode: data.status,
                                started: data.started,
                                isManagedByDockge: data.isManagedByDockge,
                                imageUpdatesAvailable: data.imageUpdatesAvailable,
                                recreateNecessary: data.recreateNecessary,
                                services: data.services,
                                endpoint,
                            },
                        });
                    } else {
                        res.status(404).json({ ok: false, error: result.msg || "Stack not found on agent" });
                    }
                    return;
                }

                const stack = await Stack.getStack(server, req.params.name, false);
                await stack.updateData();
                const data = await stack.getData("");

                res.json({
                    ok: true,
                    stack: {
                        name: data.name,
                        status: STATUS_NAMES[data.status] || "unknown",
                        statusCode: data.status,
                        started: data.started,
                        isManagedByDockge: data.isManagedByDockge,
                        imageUpdatesAvailable: data.imageUpdatesAvailable,
                        recreateNecessary: data.recreateNecessary,
                        services: data.services,
                        endpoint: "",
                    },
                });
            } catch (e) {
                if (e instanceof ValidationError) {
                    res.status(404).json({ ok: false, error: "Stack not found" });
                } else {
                    log.error("api", `GET /api/stacks/${req.params.name}/status error: ${e}`);
                    res.status(500).json({ ok: false, error: "Failed to get stack status" });
                }
            }
        });

        // POST /api/stacks/:name/update — pull + recreate
        // Optional query param: ?endpoint= to specify which agent (default: local)
        router.post("/api/stacks/:name/update", validateStackName, async (req: Request, res: Response) => {
            try {
                const endpoint = await resolveEndpoint((req.query.endpoint as string) || "");

                if (!validateEndpoint(endpoint)) {
                    res.status(400).json({ ok: false, error: "Invalid endpoint format" });
                    return;
                }

                const pruneAfterUpdate = await Settings.get("defaultPruneAfterUpdate")
                    ?? await Settings.get("schedulerPruneAfterUpdate") ?? true;
                const pruneAllAfterUpdate = await Settings.get("defaultPruneAllAfterUpdate")
                    ?? await Settings.get("schedulerPruneAllAfterUpdate") ?? true;

                const startedAt = new Date().toISOString();
                const startTime = Date.now();

                if (endpoint && endpoint !== "") {
                    // Proxy to agent
                    try {
                        const result = await emitToAgent(server, endpoint, "updateStack", req.params.name, pruneAfterUpdate, pruneAllAfterUpdate);
                        const durationMs = Date.now() - startTime;
                        const success = !!result.ok;
                        await UpdateHistoryService.recordUpdate(req.params.name, endpoint, "api", success, null, success ? null : (result.msg as string) || null, startedAt, new Date().toISOString(), durationMs);
                        if (success) {
                            res.json({ ok: true, message: `Stack '${req.params.name}' updated on ${endpoint}`, endpoint });
                        } else {
                            res.status(500).json({ ok: false, error: result.msg || "Update failed on agent" });
                        }
                    } catch (e) {
                        const durationMs = Date.now() - startTime;
                        const errorMsg = e instanceof Error ? e.message : String(e);
                        await UpdateHistoryService.recordUpdate(req.params.name, endpoint, "api", false, null, errorMsg, startedAt, new Date().toISOString(), durationMs);
                        throw e;
                    }
                    return;
                }

                const stack = await Stack.getStack(server, req.params.name, false);
                await stack.updateData();

                // Self-update detection: if this stack contains Dockge itself, use the sidecar approach
                if (await stack.isSelfStack()) {
                    await stack.selfUpdate(pruneAfterUpdate as boolean, pruneAllAfterUpdate as boolean);
                    const durationMs = Date.now() - startTime;
                    await UpdateHistoryService.recordUpdate(req.params.name, "", "api", true, null, null, startedAt, new Date().toISOString(), durationMs);
                    res.json({
                        ok: true,
                        message: `Stack '${req.params.name}' self-update initiated — Dockge will restart shortly`,
                        endpoint: "",
                    });
                    return;
                }

                const pullResult = await childProcessAsync.spawn("docker", [...stack.composeArgs, "pull"], {
                    cwd: stack.path,
                    encoding: "utf-8",
                });

                let upResult;
                if (stack.isStarted) {
                    upResult = await childProcessAsync.spawn("docker", [...stack.composeArgs, "up", "-d", "--remove-orphans"], {
                        cwd: stack.path,
                        encoding: "utf-8",
                    });
                }

                if (pruneAfterUpdate) {
                    const pruneArgs = ["image", "prune", "-f"];
                    if (pruneAllAfterUpdate) {
                        pruneArgs.push("-a");
                    }
                    await childProcessAsync.spawn("docker", pruneArgs, { encoding: "utf-8" });
                }

                await stack.updateData();
                await stack.updateImageInfos();

                const durationMs = Date.now() - startTime;
                await UpdateHistoryService.recordUpdate(req.params.name, "", "api", true, null, null, startedAt, new Date().toISOString(), durationMs);

                res.json({
                    ok: true,
                    message: `Stack '${req.params.name}' updated`,
                    pullOutput: pullResult?.stdout?.toString() || "",
                    upOutput: upResult?.stdout?.toString() || "",
                    endpoint: "",
                });
            } catch (e) {
                if (e instanceof ValidationError) {
                    res.status(404).json({ ok: false, error: "Stack not found" });
                } else {
                    log.error("api", `POST /api/stacks/${req.params.name}/update error: ${e}`);
                    res.status(500).json({ ok: false, error: "Failed to update stack" });
                }
            }
        });

        // POST /api/stacks/:name/start — start a stack
        // Optional query param: ?endpoint= to specify which agent (default: local)
        router.post("/api/stacks/:name/start", validateStackName, async (req: Request, res: Response) => {
            try {
                const endpoint = await resolveEndpoint((req.query.endpoint as string) || "");

                if (!validateEndpoint(endpoint)) {
                    res.status(400).json({ ok: false, error: "Invalid endpoint format" });
                    return;
                }

                if (endpoint && endpoint !== "") {
                    const result = await emitToAgent(server, endpoint, "startStack", req.params.name);
                    if (result.ok) {
                        res.json({ ok: true, message: `Stack '${req.params.name}' started on ${endpoint}`, endpoint });
                    } else {
                        res.status(500).json({ ok: false, error: result.msg || "Start failed on agent" });
                    }
                    return;
                }

                const stack = await Stack.getStack(server, req.params.name, false);

                await childProcessAsync.spawn("docker", [...stack.composeArgs, "up", "-d", "--remove-orphans"], {
                    cwd: stack.path,
                    encoding: "utf-8",
                });

                res.json({
                    ok: true,
                    message: `Stack '${req.params.name}' started`,
                    endpoint: "",
                });
            } catch (e) {
                if (e instanceof ValidationError) {
                    res.status(404).json({ ok: false, error: "Stack not found" });
                } else {
                    log.error("api", `POST /api/stacks/${req.params.name}/start error: ${e}`);
                    res.status(500).json({ ok: false, error: "Failed to start stack" });
                }
            }
        });

        // POST /api/stacks/:name/stop — stop a stack
        // Optional query param: ?endpoint= to specify which agent (default: local)
        router.post("/api/stacks/:name/stop", validateStackName, async (req: Request, res: Response) => {
            try {
                const endpoint = await resolveEndpoint((req.query.endpoint as string) || "");

                if (!validateEndpoint(endpoint)) {
                    res.status(400).json({ ok: false, error: "Invalid endpoint format" });
                    return;
                }

                if (endpoint && endpoint !== "") {
                    const result = await emitToAgent(server, endpoint, "stopStack", req.params.name);
                    if (result.ok) {
                        res.json({ ok: true, message: `Stack '${req.params.name}' stopped on ${endpoint}`, endpoint });
                    } else {
                        res.status(500).json({ ok: false, error: result.msg || "Stop failed on agent" });
                    }
                    return;
                }

                const stack = await Stack.getStack(server, req.params.name, false);

                if (await stack.isSelfStack()) {
                    res.status(400).json({ ok: false, error: "Cannot stop the stack that contains Dockge itself" });
                    return;
                }

                await childProcessAsync.spawn("docker", [...stack.composeArgs, "stop"], {
                    cwd: stack.path,
                    encoding: "utf-8",
                });

                res.json({
                    ok: true,
                    message: `Stack '${req.params.name}' stopped`,
                    endpoint: "",
                });
            } catch (e) {
                if (e instanceof ValidationError) {
                    res.status(404).json({ ok: false, error: "Stack not found" });
                } else {
                    log.error("api", `POST /api/stacks/${req.params.name}/stop error: ${e}`);
                    res.status(500).json({ ok: false, error: "Failed to stop stack" });
                }
            }
        });

        // POST /api/stacks/:name/restart — restart a stack
        // Optional query param: ?endpoint= to specify which agent (default: local)
        router.post("/api/stacks/:name/restart", validateStackName, async (req: Request, res: Response) => {
            try {
                const endpoint = await resolveEndpoint((req.query.endpoint as string) || "");

                if (!validateEndpoint(endpoint)) {
                    res.status(400).json({ ok: false, error: "Invalid endpoint format" });
                    return;
                }

                if (endpoint && endpoint !== "") {
                    const result = await emitToAgent(server, endpoint, "restartStack", req.params.name);
                    if (result.ok) {
                        res.json({ ok: true, message: `Stack '${req.params.name}' restarted on ${endpoint}`, endpoint });
                    } else {
                        res.status(500).json({ ok: false, error: result.msg || "Restart failed on agent" });
                    }
                    return;
                }

                const stack = await Stack.getStack(server, req.params.name, false);

                await childProcessAsync.spawn("docker", [...stack.composeArgs, "restart"], {
                    cwd: stack.path,
                    encoding: "utf-8",
                });

                res.json({
                    ok: true,
                    message: `Stack '${req.params.name}' restarted`,
                    endpoint: "",
                });
            } catch (e) {
                if (e instanceof ValidationError) {
                    res.status(404).json({ ok: false, error: "Stack not found" });
                } else {
                    log.error("api", `POST /api/stacks/${req.params.name}/restart error: ${e}`);
                    res.status(500).json({ ok: false, error: "Failed to restart stack" });
                }
            }
        });

        // POST /api/system/prune — docker system prune -a -f
        // Optional query param: ?endpoint= to specify which agent (default: local)
        router.post("/api/system/prune", async (req: Request, res: Response) => {
            try {
                const endpoint = await resolveEndpoint((req.query.endpoint as string) || "");

                if (!validateEndpoint(endpoint)) {
                    res.status(400).json({ ok: false, error: "Invalid endpoint format" });
                    return;
                }

                if (endpoint && endpoint !== "") {
                    // Proxy to agent
                    const result = await emitToAgent(server, endpoint, "dockerSystemPrune", true, false);
                    if (result.ok) {
                        res.json({ ok: true, output: result.msg || "", endpoint });
                    } else {
                        res.status(500).json({ ok: false, error: result.msg || "Prune failed on agent" });
                    }
                    return;
                }

                const result = await childProcessAsync.spawn("docker", ["system", "prune", "-a", "-f"], {
                    encoding: "utf-8",
                });

                res.json({
                    ok: true,
                    output: result?.stdout?.toString() || "",
                    endpoint: "",
                });
            } catch (e) {
                log.error("api", "POST /api/system/prune error: " + e);
                res.status(500).json({ ok: false, error: "Failed to prune system" });
            }
        });

        // POST /api/stacks/:name/check-updates — force check for image updates on a stack
        router.post("/api/stacks/:name/check-updates", validateStackName, async (req: Request, res: Response) => {
            try {
                const endpoint = await resolveEndpoint((req.query.endpoint as string) || "");
                if (!validateEndpoint(endpoint)) {
                    res.status(400).json({ ok: false, error: "Invalid endpoint format" });
                    return;
                }

                if (endpoint && endpoint !== "") {
                    // For remote agents, proxy via socket.io
                    try {
                        const result = await emitToAgent(server, endpoint, "checkStackUpdates", req.params.name);
                        res.json({ ok: true, imageUpdatesAvailable: result.imageUpdatesAvailable ?? false, endpoint });
                    } catch (e) {
                        log.error("api", `POST /api/stacks/${req.params.name}/check-updates proxy error: ${e}`);
                        res.status(502).json({ ok: false, error: "Failed to communicate with agent" });
                    }
                    return;
                }

                const stack = await Stack.getStack(server, req.params.name, false);
                await stack.updateData();
                await stack.updateImageInfos();
                await stack.updateData();

                res.json({
                    ok: true,
                    imageUpdatesAvailable: stack.imageUpdatesAvailable,
                    endpoint: "",
                });
            } catch (e) {
                if (e instanceof ValidationError) {
                    res.status(404).json({ ok: false, error: "Stack not found" });
                } else {
                    log.error("api", `POST /api/stacks/${req.params.name}/check-updates error: ${e}`);
                    res.status(500).json({ ok: false, error: "Failed to check for updates" });
                }
            }
        });

        // GET /api/stacks/:name/auto-update — get auto-update status
        router.get("/api/stacks/:name/auto-update", validateStackName, async (req: Request, res: Response) => {
            try {
                const endpoint = await resolveEndpoint((req.query.endpoint as string) || "");
                if (!validateEndpoint(endpoint)) {
                    res.status(400).json({ ok: false, error: "Invalid endpoint format" });
                    return;
                }
                const enabled = await StackSettingsService.getAutoUpdate(req.params.name, endpoint);
                res.json({ ok: true, autoUpdate: enabled });
            } catch (e) {
                log.error("api", `GET /api/stacks/${req.params.name}/auto-update error: ${e}`);
                res.status(500).json({ ok: false, error: "Failed to get auto-update status" });
            }
        });

        // PUT /api/stacks/:name/auto-update — set auto-update status
        router.put("/api/stacks/:name/auto-update", validateStackName, async (req: Request, res: Response) => {
            try {
                const endpoint = await resolveEndpoint((req.query.endpoint as string) || "");
                if (!validateEndpoint(endpoint)) {
                    res.status(400).json({ ok: false, error: "Invalid endpoint format" });
                    return;
                }
                const { enabled } = req.body;
                if (typeof enabled !== "boolean") {
                    res.status(400).json({ ok: false, error: "enabled must be a boolean" });
                    return;
                }
                await StackSettingsService.setAutoUpdate(req.params.name, endpoint, enabled);
                Stack.autoUpdateCache.set(Stack.autoUpdateCacheKey(req.params.name, endpoint), enabled);
                res.json({ ok: true });
            } catch (e) {
                log.error("api", `PUT /api/stacks/${req.params.name}/auto-update error: ${e}`);
                res.status(500).json({ ok: false, error: "Failed to set auto-update status" });
            }
        });

        // POST /api/update-all — update all stacks
        // ?endpoint=X: update only on that agent. No endpoint: update on ALL agents.
        router.post("/api/update-all", async (req: Request, res: Response) => {
            try {
                const rawEndpointFilter = req.query.endpoint as string | undefined;
                if (rawEndpointFilter !== undefined && !validateEndpoint(rawEndpointFilter)) {
                    res.status(400).json({ ok: false, error: "Invalid endpoint format" });
                    return;
                }

                const pruneAfterUpdate = await Settings.get("defaultPruneAfterUpdate")
                    ?? await Settings.get("schedulerPruneAfterUpdate") ?? true;
                const pruneAllAfterUpdate = await Settings.get("defaultPruneAllAfterUpdate")
                    ?? await Settings.get("schedulerPruneAllAfterUpdate") ?? true;

                const results: { name: string; endpoint: string; success: boolean; error?: string }[] = [];

                // Helper to update local stacks
                const updateLocalStacks = async () => {
                    const stackList = await Stack.getStackList(server, true);
                    for (const [name, stack] of stackList) {
                        if (!stack.isManagedByDockge) continue;
                        // Skip stopped/exited stacks in bulk update
                        if (!stack.isStarted) {
                            results.push({ name, endpoint: "", success: true, error: "skipped (not running)" });
                            continue;
                        }
                        const startedAt = new Date().toISOString();
                        const startTime = Date.now();
                        try {
                            // Self-update detection
                            if (await stack.isSelfStack()) {
                                await stack.selfUpdate(pruneAfterUpdate as boolean, pruneAllAfterUpdate as boolean);
                                const durationMs = Date.now() - startTime;
                                await UpdateHistoryService.recordUpdate(name, "", "api", true, null, null, startedAt, new Date().toISOString(), durationMs);
                                results.push({ name, endpoint: "", success: true, error: "self-update initiated" });
                                continue;
                            }

                            await childProcessAsync.spawn("docker", [...stack.composeArgs, "pull"], { cwd: stack.path, encoding: "utf-8" });
                            await stack.updateData();
                            if (stack.isStarted) {
                                await childProcessAsync.spawn("docker", [...stack.composeArgs, "up", "-d", "--remove-orphans"], { cwd: stack.path, encoding: "utf-8" });
                            }
                            if (pruneAfterUpdate) {
                                const pruneArgs = ["image", "prune", "-f"];
                                if (pruneAllAfterUpdate) {
                                    pruneArgs.push("-a");
                                }
                                await childProcessAsync.spawn("docker", pruneArgs, { encoding: "utf-8" });
                            }
                            await stack.updateImageInfos();
                            const durationMs = Date.now() - startTime;
                            await UpdateHistoryService.recordUpdate(name, "", "api", true, null, null, startedAt, new Date().toISOString(), durationMs);
                            results.push({ name, endpoint: "", success: true });
                        } catch (e) {
                            const durationMs = Date.now() - startTime;
                            const errorMsg = e instanceof Error ? e.message : String(e);
                            await UpdateHistoryService.recordUpdate(name, "", "api", false, null, errorMsg, startedAt, new Date().toISOString(), durationMs);
                            results.push({ name, endpoint: "", success: false, error: errorMsg });
                        }
                    }
                };

                // Helper to update stacks on a remote agent
                const updateAgentStacks = async (ep: string) => {
                    try {
                        const listResult = await emitToAgent(server, ep, "getStackList");
                        if (!listResult.ok || !listResult.stackList) return;
                        const agentStacks = listResult.stackList as Record<string, { name: string; isManagedByDockge: boolean }>;
                        for (const name in agentStacks) {
                            if (!agentStacks[name].isManagedByDockge) continue;
                            const startedAt = new Date().toISOString();
                            const startTime = Date.now();
                            try {
                                const updateResult = await emitToAgent(server, ep, "updateStack", name, pruneAfterUpdate, pruneAllAfterUpdate);
                                const durationMs = Date.now() - startTime;
                                const success = !!updateResult.ok;
                                await UpdateHistoryService.recordUpdate(name, ep, "api", success, null, success ? null : (updateResult.msg as string) || null, startedAt, new Date().toISOString(), durationMs);
                                results.push({ name, endpoint: ep, success });
                            } catch (e) {
                                const durationMs = Date.now() - startTime;
                                const errorMsg = e instanceof Error ? e.message : String(e);
                                await UpdateHistoryService.recordUpdate(name, ep, "api", false, null, errorMsg, startedAt, new Date().toISOString(), durationMs);
                                results.push({ name, endpoint: ep, success: false, error: errorMsg });
                            }
                        }
                    } catch (e) {
                        log.warn("api", `Failed to update stacks on agent ${ep}: ${e}`);
                        results.push({ name: "(all)", endpoint: ep, success: false, error: e instanceof Error ? e.message : String(e) });
                    }
                };

                const endpointFilter = rawEndpointFilter !== undefined ? await resolveEndpoint(rawEndpointFilter) : undefined;
                if (endpointFilter !== undefined) {
                    // Specific endpoint
                    if (!endpointFilter || endpointFilter === "") {
                        await updateLocalStacks();
                    } else {
                        await updateAgentStacks(endpointFilter);
                    }
                } else {
                    // All endpoints
                    await updateLocalStacks();
                    const agentList = await Agent.getAgentList();
                    for (const url in agentList) {
                        const agent = agentList[url];
                        if (!url || agent.endpoint === "") continue;
                        await updateAgentStacks(agent.endpoint);
                    }
                }

                res.json({ ok: true, results });
            } catch (e) {
                log.error("api", "POST /api/update-all error: " + e);
                res.status(500).json({ ok: false, error: "Failed to update stacks" });
            }
        });

        // GET /api/update-history — query update history
        router.get("/api/update-history", async (req: Request, res: Response) => {
            try {
                const options: Record<string, unknown> = {};
                if (req.query.limit) options.limit = parseInt(req.query.limit as string, 10);
                if (req.query.offset) options.offset = parseInt(req.query.offset as string, 10);
                if (req.query.stack) options.stackName = req.query.stack as string;
                if (req.query.endpoint !== undefined) options.endpoint = await resolveEndpoint(req.query.endpoint as string);
                if (req.query.trigger) options.triggerType = req.query.trigger as string;
                if (req.query.success !== undefined) options.success = req.query.success === "true";

                const result = await UpdateHistoryService.getHistory(options);
                res.json({ ok: true, ...result });
            } catch (e) {
                log.error("api", "GET /api/update-history error: " + e);
                res.status(500).json({ ok: false, error: "Failed to get update history" });
            }
        });

        // GET /api/scheduler — get scheduler settings
        router.get("/api/scheduler", async (_req: Request, res: Response) => {
            try {
                res.json({
                    ok: true,
                    enabled: await Settings.get("schedulerEnabled") ?? false,
                    cronExpression: await Settings.get("schedulerCron") ?? "0 3 * * *",
                    pruneAfterUpdate: await Settings.get("defaultPruneAfterUpdate")
                        ?? await Settings.get("schedulerPruneAfterUpdate") ?? true,
                    pruneAllAfterUpdate: await Settings.get("defaultPruneAllAfterUpdate")
                        ?? await Settings.get("schedulerPruneAllAfterUpdate") ?? true,
                    nextAutoUpdate: server.autoUpdateScheduler?.getNextRunTime() ?? null,
                    nextImageCheck: server.nextImageCheckTime ?? null,
                });
            } catch (e) {
                log.error("api", "GET /api/scheduler error: " + e);
                res.status(500).json({ ok: false, error: "Failed to get scheduler settings" });
            }
        });

        // PUT /api/scheduler — update scheduler settings
        router.put("/api/scheduler", async (req: Request, res: Response) => {
            try {
                const { enabled, cronExpression, pruneAfterUpdate, pruneAllAfterUpdate } = req.body;
                if (enabled !== undefined) await Settings.set("schedulerEnabled", enabled, "boolean");
                if (typeof cronExpression === "string") {
                    // Validate cron expression before saving
                    try {
                        new Cron(cronExpression, { legacyMode: false });
                    } catch {
                        res.status(400).json({ ok: false, error: "Invalid cron expression" });
                        return;
                    }
                    await Settings.set("schedulerCron", cronExpression, "string");
                }
                if (pruneAfterUpdate !== undefined) await Settings.set("defaultPruneAfterUpdate", pruneAfterUpdate, "boolean");
                if (pruneAllAfterUpdate !== undefined) await Settings.set("defaultPruneAllAfterUpdate", pruneAllAfterUpdate, "boolean");
                server.restartScheduler?.();
                res.json({ ok: true });
            } catch (e) {
                log.error("api", "PUT /api/scheduler error: " + e);
                res.status(500).json({ ok: false, error: "Failed to update scheduler settings" });
            }
        });

        // POST /api/scheduler/trigger — manually trigger auto-update run
        router.post("/api/scheduler/trigger", async (_req: Request, res: Response) => {
            try {
                // Get all auto-update stacks and update them
                const stacks = await StackSettingsService.getAllAutoUpdateStacks();
                const pruneAfterUpdate = await Settings.get("defaultPruneAfterUpdate")
                    ?? await Settings.get("schedulerPruneAfterUpdate") ?? true;
                const pruneAllAfterUpdate = await Settings.get("defaultPruneAllAfterUpdate")
                    ?? await Settings.get("schedulerPruneAllAfterUpdate") ?? true;

                const results: { stackName: string; endpoint: string; success: boolean; error?: string }[] = [];

                for (const { stackName, endpoint } of stacks) {
                    const startedAt = new Date().toISOString();
                    const startTime = Date.now();
                    try {
                        if (endpoint !== "") {
                            // Remote agent
                            const updateResult = await emitToAgent(server, endpoint, "updateStack", stackName, pruneAfterUpdate, pruneAllAfterUpdate);
                            const durationMs = Date.now() - startTime;
                            const success = !!updateResult.ok;
                            await UpdateHistoryService.recordUpdate(stackName, endpoint, "api-trigger", success, null, success ? null : (updateResult.msg as string) || null, startedAt, new Date().toISOString(), durationMs);
                            results.push({ stackName, endpoint, success });
                        } else {
                            // Local
                            const stack = await Stack.getStack(server, stackName, false);

                            // Self-update detection
                            if (await stack.isSelfStack()) {
                                await stack.selfUpdate(pruneAfterUpdate as boolean, pruneAllAfterUpdate as boolean);
                                const durationMs = Date.now() - startTime;
                                await UpdateHistoryService.recordUpdate(stackName, endpoint, "api-trigger", true, null, null, startedAt, new Date().toISOString(), durationMs);
                                results.push({ stackName, endpoint, success: true });
                                continue;
                            }

                            await childProcessAsync.spawn("docker", [...stack.composeArgs, "pull"], { cwd: stack.path, encoding: "utf-8" });
                            await stack.updateData();
                            if (stack.isStarted) {
                                await childProcessAsync.spawn("docker", [...stack.composeArgs, "up", "-d", "--remove-orphans"], { cwd: stack.path, encoding: "utf-8" });
                            }
                            if (pruneAfterUpdate) {
                                const pruneArgs = ["image", "prune", "-f"];
                                if (pruneAllAfterUpdate) pruneArgs.push("-a");
                                await childProcessAsync.spawn("docker", pruneArgs, { encoding: "utf-8" });
                            }
                            const durationMs = Date.now() - startTime;
                            await UpdateHistoryService.recordUpdate(stackName, endpoint, "api-trigger", true, null, null, startedAt, new Date().toISOString(), durationMs);
                            results.push({ stackName, endpoint, success: true });
                        }
                    } catch (e) {
                        const durationMs = Date.now() - startTime;
                        const errorMsg = e instanceof Error ? e.message : String(e);
                        await UpdateHistoryService.recordUpdate(stackName, endpoint, "api-trigger", false, null, errorMsg, startedAt, new Date().toISOString(), durationMs);
                        results.push({ stackName, endpoint, success: false, error: errorMsg });
                    }
                }

                res.json({ ok: true, results });
            } catch (e) {
                log.error("api", "POST /api/scheduler/trigger error: " + e);
                res.status(500).json({ ok: false, error: "Failed to trigger auto-update" });
            }
        });

        return router;
    }
}
