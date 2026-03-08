import { SocketHandler } from "../socket-handler";
import { DockgeServer } from "../dockge-server";
import { log } from "../log";
import { callbackError, checkLogin, DockgeSocket, ValidationError } from "../util-server";
import { StackSettingsService } from "../stack-settings-service";
import { UpdateHistoryService } from "../update-history-service";
import { Stack } from "../stack";
import { Settings } from "../settings";
import crypto from "crypto";
import { Cron } from "croner";

export class UpdateManagementSocketHandler extends SocketHandler {
    create(socket: DockgeSocket, server: DockgeServer) {

        socket.on("setAutoUpdate", async (stackName: unknown, endpoint: unknown, enabled: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof stackName !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof endpoint !== "string") {
                    throw new ValidationError("Endpoint must be a string");
                }
                if (typeof enabled !== "boolean") {
                    throw new ValidationError("Enabled must be a boolean");
                }

                await StackSettingsService.setAutoUpdate(stackName, endpoint, enabled);
                Stack.autoUpdateCache.set(Stack.autoUpdateCacheKey(stackName, endpoint), enabled);

                callback({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                });

                server.sseManager?.broadcast("auto_update_changed", {
                    stack: stackName,
                    endpoint: endpoint,
                    enabled: enabled,
                });

                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("getUpdateHistory", async (options: unknown, callback) => {
            try {
                checkLogin(socket);

                const opts = (typeof options === "object" && options !== null) ? options as Record<string, unknown> : {};
                const result = await UpdateHistoryService.getHistory({
                    limit: typeof opts.limit === "number" ? opts.limit : undefined,
                    offset: typeof opts.offset === "number" ? opts.offset : undefined,
                    stackName: typeof opts.stackName === "string" ? opts.stackName : undefined,
                    endpoint: typeof opts.endpoint === "string" ? opts.endpoint : undefined,
                    triggerType: typeof opts.triggerType === "string" ? opts.triggerType : undefined,
                    success: typeof opts.success === "boolean" ? opts.success : undefined,
                });

                callback({
                    ok: true,
                    data: result,
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("getUpdateDefaults", async (callback) => {
            try {
                checkLogin(socket);

                // Fall back to old scheduler keys for migration
                const pruneAfterUpdate = await Settings.get("defaultPruneAfterUpdate")
                    ?? await Settings.get("schedulerPruneAfterUpdate") ?? true;
                const pruneAllAfterUpdate = await Settings.get("defaultPruneAllAfterUpdate")
                    ?? await Settings.get("schedulerPruneAllAfterUpdate") ?? true;

                callback({
                    ok: true,
                    data: {
                        pruneAfterUpdate,
                        pruneAllAfterUpdate,
                    },
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("setUpdateDefaults", async (data: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof data !== "object" || data === null) {
                    throw new ValidationError("Data must be an object");
                }

                const d = data as Record<string, unknown>;

                if (d.pruneAfterUpdate !== undefined) {
                    await Settings.set("defaultPruneAfterUpdate", d.pruneAfterUpdate, "boolean");
                }
                if (d.pruneAllAfterUpdate !== undefined) {
                    await Settings.set("defaultPruneAllAfterUpdate", d.pruneAllAfterUpdate, "boolean");
                }

                callback({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("getSchedulerSettings", async (callback) => {
            try {
                checkLogin(socket);

                const enabled = await Settings.get("schedulerEnabled") ?? false;
                const cronExpression = await Settings.get("schedulerCron") ?? "0 3 * * *";

                callback({
                    ok: true,
                    data: {
                        enabled,
                        cronExpression,
                        nextAutoUpdate: server.autoUpdateScheduler?.getNextRunTime() ?? null,
                        nextImageCheck: server.nextImageCheckTime ?? null,
                    },
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("setSchedulerSettings", async (data: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof data !== "object" || data === null) {
                    throw new ValidationError("Data must be an object");
                }

                const d = data as Record<string, unknown>;

                if (d.enabled !== undefined) {
                    await Settings.set("schedulerEnabled", d.enabled, "boolean");
                }
                if (typeof d.cronExpression === "string") {
                    // Validate cron expression before saving
                    try {
                        new Cron(d.cronExpression, { legacyMode: false });
                    } catch {
                        throw new ValidationError("Invalid cron expression");
                    }
                    await Settings.set("schedulerCron", d.cronExpression, "string");
                }

                // Restart scheduler with new settings
                server.restartScheduler?.();

                callback({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("checkStackUpdates", async (stackName: unknown, endpoint: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof stackName !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof endpoint !== "string") {
                    throw new ValidationError("Endpoint must be a string");
                }

                // Respond immediately, run check in background
                callback({
                    ok: true,
                    msg: "checkStarted",
                    msgi18n: true,
                });

                server.sseManager?.broadcastOperationStarted(stackName, endpoint, "check-updates");

                if (endpoint !== "" && endpoint !== socket.endpoint) {
                    // Proxy to agent — fire and forget, agent will update its stack list
                    socket.instanceManager.emitToEndpoint(endpoint, "checkStackUpdates", stackName, () => {
                        server.sseManager?.broadcastOperationCompleted(stackName, endpoint, "check-updates", true);
                        server.sendStackList();
                    }).catch((e: unknown) => {
                        server.sseManager?.broadcastOperationCompleted(stackName, endpoint, "check-updates", false);
                        log.warn("checkStackUpdates", `Agent check failed for ${stackName} on ${endpoint}: ${e}`);
                    });
                } else {
                    // Local — run in background
                    (async () => {
                        try {
                            const stack = await Stack.getStack(server, stackName, false);
                            await stack.updateData();
                            await stack.updateImageInfos();
                            await stack.updateData();
                            server.sseManager?.broadcastOperationCompleted(stackName, endpoint, "check-updates", true);
                            server.sendStackList();
                        } catch (e) {
                            server.sseManager?.broadcastOperationCompleted(stackName, endpoint, "check-updates", false);
                            log.warn("checkStackUpdates", `Check failed for ${stackName}: ${e}`);
                        }
                    })();
                }
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("generateApiKey", async (callback) => {
            try {
                checkLogin(socket);

                const apiKey = crypto.randomBytes(32).toString("hex");
                await Settings.set("apiKey", apiKey, "string");

                callback({
                    ok: true,
                    apiKey,
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("getApiKey", async (callback) => {
            try {
                checkLogin(socket);

                const apiKey = await Settings.get("apiKey");

                callback({
                    ok: true,
                    apiKey: apiKey || null,
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }
}
