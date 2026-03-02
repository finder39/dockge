import { SocketHandler } from "../socket-handler";
import { DockgeServer } from "../dockge-server";
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

        socket.on("getSchedulerSettings", async (callback) => {
            try {
                checkLogin(socket);

                const enabled = await Settings.get("schedulerEnabled") ?? false;
                const cronExpression = await Settings.get("schedulerCron") ?? "0 3 * * *";
                const pruneAfterUpdate = await Settings.get("schedulerPruneAfterUpdate") ?? false;
                const pruneAllAfterUpdate = await Settings.get("schedulerPruneAllAfterUpdate") ?? false;

                callback({
                    ok: true,
                    data: {
                        enabled,
                        cronExpression,
                        pruneAfterUpdate,
                        pruneAllAfterUpdate,
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
                if (d.pruneAfterUpdate !== undefined) {
                    await Settings.set("schedulerPruneAfterUpdate", d.pruneAfterUpdate, "boolean");
                }
                if (d.pruneAllAfterUpdate !== undefined) {
                    await Settings.set("schedulerPruneAllAfterUpdate", d.pruneAllAfterUpdate, "boolean");
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

                if (endpoint !== "" && endpoint !== socket.endpoint) {
                    // Proxy to agent — emit checkStackUpdates on the agent
                    // For now, only local stacks support force check
                    throw new ValidationError("Force check on remote agents is not yet supported via socket");
                }

                const stack = await Stack.getStack(server, stackName, false);
                await stack.updateData();
                await stack.updateImageInfos();
                // Re-read data after image info update
                await stack.updateData();

                server.sendStackList();

                callback({
                    ok: true,
                    msg: "checkCompleted",
                    msgi18n: true,
                    imageUpdatesAvailable: stack.imageUpdatesAvailable,
                });
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
