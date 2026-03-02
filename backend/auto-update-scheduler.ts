import { Cron } from "croner";
import { DockgeServer } from "./dockge-server";
import { StackSettingsService } from "./stack-settings-service";
import { UpdateHistoryService } from "./update-history-service";
import { Stack } from "./stack";
import { Settings } from "./settings";
import { log } from "./log";
import childProcessAsync from "promisify-child-process";

export class AutoUpdateScheduler {
    private cron: Cron | null = null;
    private server: DockgeServer;
    private running = false;

    constructor(server: DockgeServer) {
        this.server = server;
        server.restartScheduler = () => this.restart();
    }

    async start() {
        const enabled = await Settings.get("schedulerEnabled");
        if (!enabled) {
            log.info("scheduler", "Auto-update scheduler is disabled");
            return;
        }

        const cronExpression = await Settings.get("schedulerCron") ?? "0 3 * * *";
        log.info("scheduler", `Starting auto-update scheduler with cron: ${cronExpression}`);

        this.cron = new Cron(cronExpression, {
            protect: true,
        }, async () => {
            await this.run();
        });
    }

    stop() {
        if (this.cron) {
            this.cron.stop();
            this.cron = null;
        }
    }

    async restart() {
        this.stop();
        await this.start();
    }

    /**
     * Get the next scheduled auto-update run time as ISO string, or null if not scheduled.
     */
    getNextRunTime(): string | null {
        if (!this.cron) {
            return null;
        }
        const next = this.cron.nextRun();
        return next ? next.toISOString() : null;
    }

    async run() {
        if (this.running) {
            log.info("scheduler", "Skipping auto-update run, previous run still in progress");
            return;
        }

        this.running = true;
        log.info("scheduler", "Starting auto-update run");

        try {
            const pruneAfterUpdate = await Settings.get("schedulerPruneAfterUpdate") ?? false;
            const pruneAllAfterUpdate = await Settings.get("schedulerPruneAllAfterUpdate") ?? false;
            const stacks = await StackSettingsService.getAllAutoUpdateStacks();

            // Group by endpoint
            const localStacks = stacks.filter(s => s.endpoint === "");
            const remoteStacks = stacks.filter(s => s.endpoint !== "");

            // Update local stacks
            for (const { stackName } of localStacks) {
                await this.updateStack(stackName, "", pruneAfterUpdate, pruneAllAfterUpdate);
            }

            // Update remote stacks via agent socket
            // Group by endpoint
            const byEndpoint = new Map<string, string[]>();
            for (const { stackName, endpoint } of remoteStacks) {
                const list = byEndpoint.get(endpoint) ?? [];
                list.push(stackName);
                byEndpoint.set(endpoint, list);
            }

            for (const [endpoint, stackNames] of byEndpoint) {
                for (const stackName of stackNames) {
                    await this.updateStackViaAgent(stackName, endpoint, pruneAfterUpdate, pruneAllAfterUpdate);
                }
            }

            // Cleanup old history entries
            const deleted = await UpdateHistoryService.cleanupOldEntries(90);
            if (deleted > 0) {
                log.info("scheduler", `Cleaned up ${deleted} old update history entries`);
            }

        } catch (e) {
            log.error("scheduler", "Auto-update run failed: " + (e instanceof Error ? e.message : String(e)));
        } finally {
            this.running = false;
            log.info("scheduler", "Auto-update run completed");
        }
    }

    private async updateStack(stackName: string, endpoint: string, pruneAfterUpdate: boolean, pruneAllAfterUpdate: boolean) {
        const startedAt = new Date().toISOString();
        const startTime = Date.now();
        let success = true;
        let errorMessage: string | null = null;

        let output = "";
        try {
            const stack = await Stack.getStack(this.server, stackName);

            // Run docker compose pull && up -d directly (no terminal/socket needed)
            const pullResult = await childProcessAsync.spawn("docker", ["compose", "pull"], {
                cwd: stack.path,
                encoding: "utf-8",
            });
            output += (pullResult.stdout || "") + (pullResult.stderr || "");

            await stack.updateData();
            if (stack.isStarted) {
                const upResult = await childProcessAsync.spawn("docker", ["compose", "up", "-d", "--remove-orphans"], {
                    cwd: stack.path,
                    encoding: "utf-8",
                });
                output += (upResult.stdout || "") + (upResult.stderr || "");
            }

            if (pruneAfterUpdate) {
                const pruneArgs = ["image", "prune", "-f"];
                if (pruneAllAfterUpdate) {
                    pruneArgs.push("-a");
                }
                const pruneResult = await childProcessAsync.spawn("docker", pruneArgs, {
                    encoding: "utf-8",
                });
                output += (pruneResult.stdout || "") + (pruneResult.stderr || "");
            }

            log.info("scheduler", `Updated stack ${stackName}`);
        } catch (e) {
            success = false;
            errorMessage = e instanceof Error ? e.message : String(e);
            log.error("scheduler", `Failed to update stack ${stackName}: ${errorMessage}`);
        }

        const completedAt = new Date().toISOString();
        const durationMs = Date.now() - startTime;
        await UpdateHistoryService.recordUpdate(
            stackName, endpoint, "scheduled", success, output || null, errorMessage,
            startedAt, completedAt, durationMs
        );
    }

    private async updateStackViaAgent(stackName: string, endpoint: string, pruneAfterUpdate: boolean, pruneAllAfterUpdate: boolean) {
        const startedAt = new Date().toISOString();
        const startTime = Date.now();
        let success = true;
        let errorMessage: string | null = null;

        try {
            // Find a connected socket to proxy through
            const sockets = await this.server.io.fetchSockets();
            let proxied = false;

            for (const s of sockets) {
                const ds = s as unknown as { instanceManager?: { emitToEndpoint: (endpoint: string, event: string, ...args: unknown[]) => Promise<unknown> } };
                if (ds.instanceManager) {
                    await new Promise<void>((resolve, reject) => {
                        ds.instanceManager!.emitToEndpoint(endpoint, "updateStack", stackName, pruneAfterUpdate, pruneAllAfterUpdate, (result: { ok?: boolean; msg?: string }) => {
                            if (result?.ok) {
                                resolve();
                            } else {
                                reject(new Error(result?.msg ?? "Update failed"));
                            }
                        });
                    });
                    proxied = true;
                    break;
                }
            }

            if (!proxied) {
                throw new Error(`No connected socket available to proxy to endpoint ${endpoint}`);
            }

            log.info("scheduler", `Updated stack ${stackName} on endpoint ${endpoint}`);
        } catch (e) {
            success = false;
            errorMessage = e instanceof Error ? e.message : String(e);
            log.error("scheduler", `Failed to update stack ${stackName} on ${endpoint}: ${errorMessage}`);
        }

        const completedAt = new Date().toISOString();
        const durationMs = Date.now() - startTime;
        await UpdateHistoryService.recordUpdate(
            stackName, endpoint, "scheduled", success, null, errorMessage,
            startedAt, completedAt, durationMs
        );
    }
}
