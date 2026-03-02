<template>
    <transition name="slide-fade" appear>
        <div>
            <h1 class="mb-3">{{ $t("updateHistory") }}</h1>

            <!-- Filters -->
            <div class="shadow-box big-padding mb-3">
                <div class="row g-3">
                    <div class="col-md-3">
                        <label class="form-label">{{ $t("stackName") }}</label>
                        <input v-model="filters.stackName" type="text" class="form-control" :placeholder="$t('all')" @input="debouncedLoad">
                    </div>
                    <div class="col-md-3">
                        <label class="form-label">{{ $t("dockgeAgent") }}</label>
                        <select v-model="filters.endpoint" class="form-select" @change="resetAndLoad">
                            <option value="">{{ $t("all") }}</option>
                            <option v-for="(agent, ep) in $root.agentList" :key="ep" :value="ep">
                                {{ $root.getAgentName(ep) }}
                            </option>
                        </select>
                    </div>
                    <div class="col-md-3">
                        <label class="form-label">{{ $t("triggerType") }}</label>
                        <select v-model="filters.triggerType" class="form-select" @change="resetAndLoad">
                            <option value="">{{ $t("all") }}</option>
                            <option value="manual">{{ $t("manual") }}</option>
                            <option value="scheduled">{{ $t("scheduled") }}</option>
                            <option value="api">{{ $t("api") }}</option>
                            <option value="api-trigger">{{ $t("apiTrigger") }}</option>
                        </select>
                    </div>
                    <div class="col-md-3">
                        <label class="form-label">{{ $t("Status") }}</label>
                        <select v-model="filters.success" class="form-select" @change="resetAndLoad">
                            <option value="">{{ $t("all") }}</option>
                            <option value="true">{{ $t("success") }}</option>
                            <option value="false">{{ $t("failed") }}</option>
                        </select>
                    </div>
                </div>
            </div>

            <!-- Table -->
            <div class="shadow-box big-padding">
                <div v-if="loading" class="text-center p-3">
                    {{ $t("loading") }}
                </div>
                <div v-else class="table-responsive">
                <table class="table table-dark table-hover mb-0">
                    <thead>
                        <tr>
                            <th>{{ $t("Datetime") }}</th>
                            <th>{{ $t("stackName") }}</th>
                            <th>{{ $t("dockgeAgent") }}</th>
                            <th>{{ $t("triggerType") }}</th>
                            <th>{{ $t("Status") }}</th>
                            <th>{{ $t("duration") }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <template v-for="entry in entries" :key="entry.id">
                            <tr class="cursor-pointer" @click="toggleExpand(entry.id)">
                                <td>{{ formatDate(entry.startedAt) }}</td>
                                <td>{{ entry.stackName }}</td>
                                <td>{{ $root.getAgentName(entry.endpoint) }}</td>
                                <td>{{ entry.triggerType }}</td>
                                <td>
                                    <span class="badge" :class="entry.success ? 'bg-success' : 'bg-danger'">
                                        {{ entry.success ? $t("success") : $t("failed") }}
                                    </span>
                                </td>
                                <td>{{ entry.durationMs ? (entry.durationMs / 1000).toFixed(1) + 's' : '-' }}</td>
                            </tr>
                            <tr v-if="expandedId === entry.id">
                                <td colspan="6">
                                    <div class="p-2">
                                        <div v-if="entry.output" class="mb-2">
                                            <strong>{{ $t("output") }}:</strong>
                                            <pre class="mt-1 p-2 bg-dark rounded">{{ entry.output }}</pre>
                                        </div>
                                        <div v-if="entry.errorMessage" class="text-danger">
                                            <strong>{{ $t("error") }}:</strong> {{ entry.errorMessage }}
                                        </div>
                                        <div v-if="!entry.output && !entry.errorMessage" class="text-muted">
                                            {{ $t("noDetails") }}
                                        </div>
                                    </div>
                                </td>
                            </tr>
                        </template>
                        <tr v-if="entries.length === 0">
                            <td colspan="6" class="text-center text-muted">{{ $t("noData") }}</td>
                        </tr>
                    </tbody>
                </table>
                </div>

                <!-- Pagination -->
                <div v-if="total > limit" class="d-flex justify-content-between align-items-center mt-3">
                    <div class="text-muted">
                        {{ $t("showingOf", [entries.length, total]) }}
                    </div>
                    <div class="btn-group">
                        <button class="btn btn-sm btn-normal" :disabled="offset === 0" @click="prevPage">
                            <font-awesome-icon icon="chevron-left" />
                        </button>
                        <button class="btn btn-sm btn-normal" :disabled="offset + limit >= total" @click="nextPage">
                            <font-awesome-icon icon="chevron-right" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </transition>
</template>

<script lang="ts">
import { defineComponent } from "vue";

let debounceTimer: ReturnType<typeof setTimeout> | undefined;

export default defineComponent({
    data() {
        return {
            loading: true,
            entries: [] as Array<{
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
            }>,
            total: 0,
            limit: 25,
            offset: 0,
            expandedId: null as number | null,
            filters: {
                stackName: "",
                endpoint: "",
                triggerType: "",
                success: "",
            },
        };
    },

    mounted() {
        this.loadHistory();
    },

    methods: {
        resetAndLoad() {
            this.offset = 0;
            this.loadHistory();
        },

        loadHistory() {
            this.loading = true;
            const options: Record<string, unknown> = {
                limit: this.limit,
                offset: this.offset,
            };

            if (this.filters.stackName) {
                options.stackName = this.filters.stackName;
            }
            if (this.filters.endpoint !== "") {
                options.endpoint = this.filters.endpoint;
            }
            if (this.filters.triggerType) {
                options.triggerType = this.filters.triggerType;
            }
            if (this.filters.success !== "") {
                options.success = this.filters.success === "true";
            }

            this.$root.getSocket().emit("getUpdateHistory", options, (res) => {
                this.loading = false;
                if (res.ok) {
                    this.entries = res.data.entries;
                    this.total = res.data.total;
                }
            });
        },

        debouncedLoad() {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                this.offset = 0;
                this.loadHistory();
            }, 300);
        },

        toggleExpand(id: number) {
            this.expandedId = this.expandedId === id ? null : id;
        },

        formatDate(dateStr: string) {
            return new Date(dateStr).toLocaleString();
        },

        prevPage() {
            this.offset = Math.max(0, this.offset - this.limit);
            this.loadHistory();
        },

        nextPage() {
            this.offset += this.limit;
            this.loadHistory();
        },
    },
});
</script>

<style lang="scss" scoped>
.cursor-pointer {
    cursor: pointer;
}

pre {
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 300px;
    overflow-y: auto;
}
</style>
