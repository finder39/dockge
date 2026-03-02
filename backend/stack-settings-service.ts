import { R } from "redbean-node";

export class StackSettingsService {

    static async getAutoUpdate(stackName: string, endpoint: string = ""): Promise<boolean> {
        const row = await R.getRow(
            "SELECT auto_update FROM stack_setting WHERE stack_name = ? AND endpoint = ?",
            [stackName, endpoint]
        );
        return row ? !!row.auto_update : false;
    }

    static async setAutoUpdate(stackName: string, endpoint: string = "", enabled: boolean): Promise<void> {
        const existing = await R.getRow(
            "SELECT rowid FROM stack_setting WHERE stack_name = ? AND endpoint = ?",
            [stackName, endpoint]
        );

        if (existing) {
            await R.exec(
                "UPDATE stack_setting SET auto_update = ? WHERE stack_name = ? AND endpoint = ?",
                [enabled ? 1 : 0, stackName, endpoint]
            );
        } else {
            await R.exec(
                "INSERT INTO stack_setting (stack_name, endpoint, auto_update) VALUES (?, ?, ?)",
                [stackName, endpoint, enabled ? 1 : 0]
            );
        }
    }

    static async getAllAutoUpdateStacks(): Promise<{ stackName: string; endpoint: string }[]> {
        const rows = await R.getAll(
            "SELECT stack_name, endpoint FROM stack_setting WHERE auto_update = 1"
        );
        return rows.map((row: { stack_name: string; endpoint: string }) => ({
            stackName: row.stack_name,
            endpoint: row.endpoint,
        }));
    }
}
