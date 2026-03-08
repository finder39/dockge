import { AgentSocketHandler } from "../agent-socket-handler";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket, ValidationError } from "../util-server";
import { Stack } from "../stack";
import { AgentSocket } from "../../common/agent-socket";
import { UpdateHistoryService } from "../update-history-service";
import { getComposeTerminalName } from "../../common/util-common";

export class DockerSocketHandler extends AgentSocketHandler {
    create(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket) {
        // Do not call super.create()

        agentSocket.on("deployStack", async (name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, callback) => {
            try {
                checkLogin(socket);
                const stack = await this.saveStack(server, name, composeYAML, composeENV, isAdd);

                if (await stack.isSelfStack()) {
                    const terminalName = getComposeTerminalName(socket.endpoint, stack.name);
                    socket.emitAgent("terminalWrite", terminalName, "\r\n\x1b[1;33m⚠ Self-deploy detected\x1b[0m\r\n");
                    socket.emitAgent("terminalWrite", terminalName, "This stack contains Dockge itself.\r\n");
                    socket.emitAgent("terminalWrite", terminalName, "Dockge will disconnect briefly and reconnect automatically.\r\n");
                }

                const endpoint = socket.endpoint || "";
                server.sseManager?.broadcast("operation_started", { operation: "deploy", stack: stack.name, endpoint });
                await stack.deploy(socket);
                server.sendStackList();
                callbackResult({
                    ok: true,
                    msg: "Deployed",
                    msgi18n: true,
                }, callback);
                server.sseManager?.broadcast("operation_completed", { operation: "deploy", stack: stack.name, endpoint, success: true });
                stack.joinCombinedTerminal(socket);
            } catch (e) {
                server.sseManager?.broadcast("operation_completed", { operation: "deploy", stack: typeof name === "string" ? name : "", endpoint: socket.endpoint || "", success: false });
                callbackError(e, callback);
            }
        });

        agentSocket.on("saveStack", async (name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, callback) => {
            try {
                checkLogin(socket);
                await this.saveStack(server, name, composeYAML, composeENV, isAdd);
                callbackResult({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("deleteStack", async (name : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(name) !== "string") {
                    throw new ValidationError("Name must be a string");
                }
                const stack = await Stack.getStack(server, name);

                try {
                    await stack.delete(socket);
                } catch (e) {
                    server.sendStackList();
                    throw e;
                }

                server.sendStackList();
                callbackResult({
                    ok: true,
                    msg: "Deleted",
                    msgi18n: true,
                }, callback);

            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("getStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);

                if (stack.isManagedByDockge) {
                    stack.joinCombinedTerminal(socket);
                }

                callbackResult({
                    ok: true,
                    stack: await stack.getData(socket.endpoint),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // requestStackList
        agentSocket.on("requestStackList", async (callback) => {
            try {
                checkLogin(socket);
                server.sendStackList();
                callbackResult({
                    ok: true,
                    msg: "Updated",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // getStackList - returns stack data directly as callback (for REST API proxy)
        agentSocket.on("getStackList", async (callback) => {
            try {
                checkLogin(socket);
                const stackList = await Stack.getStackList(server, true);
                const stacks: Record<string, object> = {};
                for (const [name, stack] of stackList) {
                    stacks[name] = {
                        ...stack.getSimpleData(socket.endpoint),
                        services: Object.fromEntries(stack.services),
                    };
                }
                callbackResult({
                    ok: true,
                    stackList: stacks,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // startStack
        agentSocket.on("startStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);

                if (await stack.isSelfStack()) {
                    const terminalName = getComposeTerminalName(socket.endpoint, stackName);
                    socket.emitAgent("terminalWrite", terminalName, "\r\n\x1b[1;33m⚠ Self-start detected\x1b[0m\r\n");
                    socket.emitAgent("terminalWrite", terminalName, "This stack contains Dockge itself.\r\n");
                    socket.emitAgent("terminalWrite", terminalName, "Dockge will disconnect briefly and reconnect automatically.\r\n");
                }

                const endpoint = socket.endpoint || "";
                server.sseManager?.broadcast("operation_started", { operation: "start", stack: stack.name, endpoint });
                await stack.start(socket);
                callbackResult({
                    ok: true,
                    msg: "Started",
                    msgi18n: true,
                }, callback);
                server.sseManager?.broadcast("operation_completed", { operation: "start", stack: stack.name, endpoint, success: true });
                server.sendStackList();

                stack.joinCombinedTerminal(socket);

            } catch (e) {
                server.sseManager?.broadcast("operation_completed", { operation: "start", stack: typeof stackName === "string" ? stackName : "", endpoint: socket.endpoint || "", success: false });
                callbackError(e, callback);
            }
        });

        // stopStack
        agentSocket.on("stopStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);

                if (await stack.isSelfStack()) {
                    callbackResult({
                        ok: false,
                        msg: "Cannot stop the stack that contains Dockge itself. Use the per-service controls to manage other services in this stack.",
                    }, callback);
                    return;
                }

                const endpoint = socket.endpoint || "";
                server.sseManager?.broadcast("operation_started", { operation: "stop", stack: stack.name, endpoint });
                await stack.stop(socket);
                callbackResult({
                    ok: true,
                    msg: "Stopped",
                    msgi18n: true,
                }, callback);
                server.sseManager?.broadcast("operation_completed", { operation: "stop", stack: stack.name, endpoint, success: true });
                server.sendStackList();
            } catch (e) {
                server.sseManager?.broadcast("operation_completed", { operation: "stop", stack: typeof stackName === "string" ? stackName : "", endpoint: socket.endpoint || "", success: false });
                callbackError(e, callback);
            }
        });

        // restartStack
        agentSocket.on("restartStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);

                if (await stack.isSelfStack()) {
                    const terminalName = getComposeTerminalName(socket.endpoint, stackName);
                    socket.emitAgent("terminalWrite", terminalName, "\r\n\x1b[1;33m⚠ Self-restart detected\x1b[0m\r\n");
                    socket.emitAgent("terminalWrite", terminalName, "This stack contains Dockge itself.\r\n");
                    socket.emitAgent("terminalWrite", terminalName, "Dockge will disconnect briefly and reconnect automatically.\r\n");
                }

                const endpoint = socket.endpoint || "";
                server.sseManager?.broadcast("operation_started", { operation: "restart", stack: stack.name, endpoint });
                await stack.restart(socket);
                callbackResult({
                    ok: true,
                    msg: "Restarted",
                    msgi18n: true,
                }, callback);
                server.sseManager?.broadcast("operation_completed", { operation: "restart", stack: stack.name, endpoint, success: true });
                server.sendStackList();
            } catch (e) {
                server.sseManager?.broadcast("operation_completed", { operation: "restart", stack: typeof stackName === "string" ? stackName : "", endpoint: socket.endpoint || "", success: false });
                callbackError(e, callback);
            }
        });

        // updateStack
        agentSocket.on("updateStack", async (stackName: unknown, pruneAfterUpdate: unknown, pruneAllAfterUpdate: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                if (typeof(pruneAfterUpdate) !== "boolean") {
                    throw new ValidationError("pruneAfterUpdate must be a boolean");
                }

                if (typeof(pruneAllAfterUpdate) !== "boolean") {
                    throw new ValidationError("pruneAllAfterUpdate must be a boolean");
                }

                const startedAt = new Date().toISOString();
                const startTime = Date.now();
                let success = true;
                let errorMessage: string | null = null;

                const stack = await Stack.getStack(server, stackName);
                const endpoint = socket.endpoint || "";
                server.sseManager?.broadcast("operation_started", { operation: "update", stack: stackName, endpoint });

                // Self-update detection: send callback before we die
                if (await stack.isSelfStack()) {
                    // Write status to the terminal so the UI isn't blank
                    const terminalName = getComposeTerminalName(socket.endpoint, stackName);
                    socket.emitAgent("terminalWrite", terminalName, "\r\n\x1b[1;33m⚠ Self-update detected\x1b[0m\r\n");
                    socket.emitAgent("terminalWrite", terminalName, "This stack contains Dockge itself.\r\n");
                    socket.emitAgent("terminalWrite", terminalName, "Launching sidecar container to pull and recreate...\r\n");
                    socket.emitAgent("terminalWrite", terminalName, "The agent will restart momentarily.\r\n");

                    await stack.selfUpdate(pruneAfterUpdate, pruneAllAfterUpdate);
                    const completedAt = new Date().toISOString();
                    const durationMs = Date.now() - startTime;
                    await UpdateHistoryService.recordUpdate(
                        stackName,
                        socket.endpoint || "",
                        "manual",
                        true,
                        "Self-update initiated, agent restarting",
                        null,
                        startedAt,
                        completedAt,
                        durationMs
                    );
                    callbackResult({
                        ok: true,
                        msg: "Self-update initiated, agent restarting",
                        selfUpdate: true,
                    }, callback);
                    server.sseManager?.broadcast("operation_completed", { operation: "update", stack: stackName, endpoint, success: true });
                    server.sendStackList();
                    return;
                }

                try {
                    await stack.update(socket, pruneAfterUpdate, pruneAllAfterUpdate);
                } catch (e) {
                    success = false;
                    errorMessage = e instanceof Error ? e.message : String(e);
                    throw e;
                } finally {
                    const completedAt = new Date().toISOString();
                    const durationMs = Date.now() - startTime;
                    await UpdateHistoryService.recordUpdate(
                        stackName,
                        socket.endpoint || "",
                        "manual",
                        success,
                        null,
                        errorMessage,
                        startedAt,
                        completedAt,
                        durationMs
                    );
                }

                callbackResult({
                    ok: true,
                    msg: "Updated",
                    msgi18n: true,
                }, callback);
                server.sseManager?.broadcast("operation_completed", { operation: "update", stack: stackName, endpoint, success: true });
                server.sendStackList();
            } catch (e) {
                server.sseManager?.broadcast("operation_completed", { operation: "update", stack: typeof stackName === "string" ? stackName : "", endpoint: socket.endpoint || "", success: false });
                callbackError(e, callback);
            }
        });

        // down stack
        agentSocket.on("downStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);

                if (await stack.isSelfStack()) {
                    callbackResult({
                        ok: false,
                        msg: "Cannot take down the stack that contains Dockge itself. Use the per-service controls to manage other services in this stack.",
                    }, callback);
                    return;
                }

                await stack.down(socket);
                callbackResult({
                    ok: true,
                    msg: "Downed",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // stop service
        agentSocket.on("stopService", async (stackName : unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                if (typeof(serviceName) !== "string") {
                    throw new ValidationError("Service name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);

                if (await stack.isSelfService(serviceName)) {
                    callbackResult({
                        ok: false,
                        msg: "Cannot stop the Dockge service itself. Use the Update button to update Dockge.",
                    }, callback);
                    return;
                }

                await stack.stopService(socket, serviceName);
                callbackResult({
                    ok: true,
                    msg: "Stopped",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // start service
        agentSocket.on("startService", async (stackName : unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                if (typeof(serviceName) !== "string") {
                    throw new ValidationError("Service name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.startService(socket, serviceName);
                callbackResult({
                    ok: true,
                    msg: "Started",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // restart service
        agentSocket.on("restartService", async (stackName : unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                if (typeof(serviceName) !== "string") {
                    throw new ValidationError("Service name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);

                if (await stack.isSelfService(serviceName)) {
                    const terminalName = getComposeTerminalName(socket.endpoint, stackName);
                    socket.emitAgent("terminalWrite", terminalName, "\r\n\x1b[1;33m⚠ Restarting Dockge service\x1b[0m\r\n");
                    socket.emitAgent("terminalWrite", terminalName, "Dockge will disconnect briefly and reconnect automatically.\r\n");
                }

                await stack.restartService(socket, serviceName);
                callbackResult({
                    ok: true,
                    msg: "Restarted",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // recreate service
        agentSocket.on("recreateService", async (stackName : unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                if (typeof(serviceName) !== "string") {
                    throw new ValidationError("Service name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);

                if (await stack.isSelfService(serviceName)) {
                    callbackResult({
                        ok: false,
                        msg: "Cannot recreate the Dockge service itself. Use the Update button to update Dockge.",
                    }, callback);
                    return;
                }

                await stack.recreateService(socket, serviceName);
                callbackResult({
                    ok: true,
                    msg: "Recreated",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // restart service
        agentSocket.on("updateService", async (stackName : unknown, serviceName: unknown, pruneAfterUpdate: unknown, pruneAllAfterUpdate: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                if (typeof(serviceName) !== "string") {
                    throw new ValidationError("Service name must be a string");
                }

                if (typeof(pruneAfterUpdate) !== "boolean") {
                    throw new ValidationError("pruneAfterUpdate must be a boolean");
                }

                if (typeof(pruneAllAfterUpdate) !== "boolean") {
                    throw new ValidationError("pruneAllAfterUpdate must be a boolean");
                }

                const stack = await Stack.getStack(server, stackName);

                if (await stack.isSelfService(serviceName)) {
                    callbackResult({
                        ok: false,
                        msg: "Cannot update the Dockge service individually. Use the stack-level Update button instead.",
                    }, callback);
                    return;
                }

                await stack.updateService(socket, serviceName, pruneAfterUpdate, pruneAllAfterUpdate);
                callbackResult({
                    ok: true,
                    msg: "Updated",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Interactive Terminal for containers
        agentSocket.on("joinContainerTerminal", async (stackName : unknown, serviceName : unknown, shell : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string.");
                }

                if (typeof(serviceName) !== "string") {
                    throw new ValidationError("Service name must be a string.");
                }

                if (typeof(shell) !== "string") {
                    throw new ValidationError("Shell must be a string.");
                }

                const stack = await Stack.getStack(server, stackName);
                stack.joinContainerTerminal(socket, serviceName, shell);

                callbackResult({
                    ok: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Container log
        agentSocket.on("joinContainerLog", async (stackName : unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                if (typeof(serviceName) !== "string") {
                    throw new ValidationError("Service name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.joinContainerLog(socket, serviceName);

                callbackResult({
                    ok: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Container inspect
        agentSocket.on("containerInspect", async (containerName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(containerName) !== "string") {
                    throw new ValidationError("Service name must be a string");
                }

                const inspectData = await server.getContainerInspectData(containerName);

                callbackResult({
                    ok: true,
                    inspectData
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Services status
        agentSocket.on("checkStackUpdates", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName, false);
                await stack.updateData();
                await stack.updateImageInfos();
                callbackResult({
                    ok: true,
                    imageUpdatesAvailable: stack.imageUpdatesAvailable,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("updateStackData", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.updateData();
                callbackResult({
                    ok: true,
                    stack: await stack.getData(socket.endpoint)
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Service stats
        agentSocket.on("updateServiceStats", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                callbackResult({
                    ok: true,
                    serviceStats: Object.fromEntries(await stack.getServiceStats())
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // getExternalNetworkList
        agentSocket.on("getDockerNetworkList", async (callback) => {
            try {
                checkLogin(socket);
                const dockerNetworkList = await server.getDockerNetworkList();
                callbackResult({
                    ok: true,
                    dockerNetworkList,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }

    async saveStack(server : DockgeServer, name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown) : Promise<Stack> {
        // Check types
        if (typeof(name) !== "string") {
            throw new ValidationError("Name must be a string");
        }
        if (typeof(composeYAML) !== "string") {
            throw new ValidationError("Compose YAML must be a string");
        }
        if (typeof(composeENV) !== "string") {
            throw new ValidationError("Compose ENV must be a string");
        }
        if (typeof(isAdd) !== "boolean") {
            throw new ValidationError("isAdd must be a boolean");
        }

        const stack = new Stack(server, name, composeYAML, composeENV);
        await stack.save(isAdd);
        return stack;
    }

}

