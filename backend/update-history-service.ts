import { R } from "redbean-node";

export interface UpdateHistoryEntry {
    id: number;
    stackName: string;
    endpoint: string;
    triggerType: string;
    success: boolean;
    output: string | null;
    errorMessage: string | null;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
}

export interface GetHistoryOptions {
    limit?: number;
    offset?: number;
    stackName?: string;
    endpoint?: string;
    triggerType?: string;
    success?: boolean;
}

export class UpdateHistoryService {

    static async recordUpdate(
        stackName: string,
        endpoint: string,
        triggerType: string,
        success: boolean,
        output: string | null,
        errorMessage: string | null,
        startedAt: string,
        completedAt: string | null,
        durationMs: number | null,
    ): Promise<void> {
        await R.exec(
            `INSERT INTO update_history (stack_name, endpoint, trigger_type, success, output, error_message, started_at, completed_at, duration_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [stackName, endpoint, triggerType, success ? 1 : 0, output, errorMessage, startedAt, completedAt, durationMs]
        );
    }

    static async getHistory(options: GetHistoryOptions = {}): Promise<{ entries: UpdateHistoryEntry[]; total: number }> {
        const limit = options.limit ?? 50;
        const offset = options.offset ?? 0;
        const conditions: string[] = [];
        const params: unknown[] = [];

        if (options.stackName) {
            conditions.push("stack_name = ?");
            params.push(options.stackName);
        }
        if (options.endpoint !== undefined) {
            conditions.push("endpoint = ?");
            params.push(options.endpoint);
        }
        if (options.triggerType) {
            conditions.push("trigger_type = ?");
            params.push(options.triggerType);
        }
        if (options.success !== undefined) {
            conditions.push("success = ?");
            params.push(options.success ? 1 : 0);
        }

        const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

        const totalRow = await R.getRow(`SELECT COUNT(*) as cnt FROM update_history ${where}`, params);
        const total = totalRow?.cnt ?? 0;

        const rows = await R.getAll(
            `SELECT * FROM update_history ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        const entries: UpdateHistoryEntry[] = rows.map((row: Record<string, unknown>) => ({
            id: row.id as number,
            stackName: row.stack_name as string,
            endpoint: row.endpoint as string,
            triggerType: row.trigger_type as string,
            success: !!row.success,
            output: row.output as string | null,
            errorMessage: row.error_message as string | null,
            startedAt: row.started_at as string,
            completedAt: row.completed_at as string | null,
            durationMs: row.duration_ms as number | null,
        }));

        return { entries, total };
    }

    static async cleanupOldEntries(retentionDays: number = 90): Promise<number> {
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
        const before = await R.getRow("SELECT COUNT(*) as cnt FROM update_history WHERE started_at < ?", [cutoff]);
        await R.exec("DELETE FROM update_history WHERE started_at < ?", [cutoff]);
        return before?.cnt ?? 0;
    }
}
