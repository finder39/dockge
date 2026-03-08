import { Response } from "express";
import { log } from "./log";

export class SSEManager {

    private clients : Set<Response> = new Set();
    private heartbeatTimer? : NodeJS.Timeout;

    /**
     * Get the number of connected SSE clients
     */
    get clientCount() : number {
        return this.clients.size;
    }

    /**
     * Start sending heartbeat events at the given interval
     * @param intervalMs Heartbeat interval in milliseconds (default: 30000)
     */
    startHeartbeat(intervalMs : number = 30000) {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            this.broadcast("heartbeat", { timestamp: new Date().toISOString() });
        }, intervalMs);
    }

    /**
     * Stop the heartbeat timer
     */
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }

    /**
     * Add a new SSE client connection
     * @param res Express response object
     */
    addClient(res : Response) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        this.clients.add(res);
        this.sendToClient(res, "connected", { clientCount: this.clientCount });
        log.info("sse", `Client connected (${this.clientCount} total)`);

        res.on("close", () => {
            this.clients.delete(res);
            log.info("sse", `Client disconnected (${this.clientCount} total)`);
        });
    }

    /**
     * Broadcast an event to all connected clients
     * @param event Event name
     * @param data Event data
     */
    broadcast(event : string, data : Record<string, unknown>) {
        if (this.clients.size === 0) {
            return;
        }

        for (const client of this.clients) {
            this.sendToClient(client, event, data);
        }
    }

    /**
     * Send an event to a single client
     * @param res Express response object
     * @param event Event name
     * @param data Event data
     */
    private sendToClient(res : Response, event : string, data : Record<string, unknown>) {
        try {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch (e) {
            log.warn("sse", `Failed to send to client, removing: ${e}`);
            this.clients.delete(res);
        }
    }
}
