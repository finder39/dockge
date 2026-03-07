import { io, Socket as SocketClient } from "socket.io-client";
import { log } from "./log";
import { Agent } from "./models/agent";
import { LooseObject, sleep } from "../common/util-common";
import dayjs, { Dayjs } from "dayjs";

/**
 * Server-level AgentManager that maintains persistent socket.io connections
 * to all remote agents, independent of any browser session.
 *
 * Unlike the per-browser AgentManager, this does not emit status events
 * to a browser socket — it just logs.
 */
export class ServerAgentManager {

    protected agentSocketList: Record<string, SocketClient> = {};
    protected agentLoggedInList: Record<string, boolean> = {};
    protected _firstConnectTime: Dayjs = dayjs();

    get firstConnectTime(): Dayjs {
        return this._firstConnectTime;
    }

    connect(url: string, username: string, password: string) {
        let obj = new URL(url);
        let endpoint = obj.host;

        if (!endpoint) {
            log.error("server-agent-manager", "Invalid endpoint: " + endpoint + " URL: " + url);
            return;
        }

        if (this.agentSocketList[endpoint]) {
            log.debug("server-agent-manager", "Already connected to the socket server: " + endpoint);
            return;
        }

        log.info("server-agent-manager", "Connecting to the socket server: " + endpoint);
        let client = io(url, {
            extraHeaders: {
                endpoint,
            },
            // socket.io-client reconnects automatically by default
        });

        client.on("connect", () => {
            log.info("server-agent-manager", "Connected to the socket server: " + endpoint);

            client.emit("login", {
                username: username,
                password: password,
            }, (res: LooseObject) => {
                if (res.ok) {
                    log.info("server-agent-manager", "Logged in to the socket server: " + endpoint);
                    this.agentLoggedInList[endpoint] = true;
                } else {
                    log.error("server-agent-manager", "Failed to login to the socket server: " + endpoint);
                    this.agentLoggedInList[endpoint] = false;
                }
            });
        });

        client.on("connect_error", (err) => {
            log.error("server-agent-manager", "Error from the socket server: " + endpoint + ": " + err.message);
        });

        client.on("disconnect", () => {
            log.info("server-agent-manager", "Disconnected from the socket server: " + endpoint);
            this.agentLoggedInList[endpoint] = false;
        });

        this.agentSocketList[endpoint] = client;
    }

    disconnect(endpoint: string) {
        let client = this.agentSocketList[endpoint];
        client?.disconnect();
    }

    async connectAll() {
        this._firstConnectTime = dayjs();

        let list: Record<string, Agent> = await Agent.getAgentList();

        const urls = Object.keys(list).filter(url => url !== "");
        if (urls.length !== 0) {
            log.info("server-agent-manager", "Connecting to all agent socket server(s)...");
        }

        for (let url of urls) {
            let agent = list[url];
            this.connect(agent.url, agent.username, agent.password);
        }
    }

    disconnectAll() {
        for (let endpoint in this.agentSocketList) {
            this.disconnect(endpoint);
        }
    }

    async emitToEndpoint(endpoint: string, eventName: string, ...args: unknown[]) {
        log.debug("server-agent-manager", "Emitting event to endpoint: " + endpoint);
        let client = this.agentSocketList[endpoint];

        if (!client) {
            log.error("server-agent-manager", "Socket client not found for endpoint: " + endpoint);
            throw new Error("Socket client not found for endpoint: " + endpoint);
        }

        if (!client.connected || !this.agentLoggedInList[endpoint]) {
            let diff = dayjs().diff(this.firstConnectTime, "second");
            log.debug("server-agent-manager", endpoint + ": diff: " + diff);
            let ok = false;
            while (diff < 10) {
                if (client.connected && this.agentLoggedInList[endpoint]) {
                    log.debug("server-agent-manager", `${endpoint}: Connected & Logged in`);
                    ok = true;
                    break;
                }
                log.debug("server-agent-manager", endpoint + ": not ready yet, retrying in 1 second...");
                await sleep(1000);
                diff = dayjs().diff(this.firstConnectTime, "second");
            }

            if (!ok) {
                log.error("server-agent-manager", `${endpoint}: Socket client not connected`);
                throw new Error("Socket client not connected for endpoint: " + endpoint);
            }
        }

        client.emit("agent", endpoint, eventName, ...args);
    }

    /**
     * Check if a specific agent endpoint is connected and logged in.
     */
    isConnected(endpoint: string): boolean {
        const client = this.agentSocketList[endpoint];
        return !!(client && client.connected && this.agentLoggedInList[endpoint]);
    }
}
