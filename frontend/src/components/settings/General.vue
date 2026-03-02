<template>
    <div>
        <form class="my-4" autocomplete="off" @submit.prevent="saveGeneral">
            <!-- Client side Timezone -->
            <div v-if="false" class="mb-4">
                <label for="timezone" class="form-label">
                    {{ $t("Display Timezone") }}
                </label>
                <select id="timezone" v-model="$root.userTimezone" class="form-select">
                    <option value="auto">
                        {{ $t("Auto") }}: {{ guessTimezone }}
                    </option>
                    <option
                        v-for="(timezone, index) in timezoneList"
                        :key="index"
                        :value="timezone.value"
                    >
                        {{ timezone.name }}
                    </option>
                </select>
            </div>

            <!-- Server Timezone -->
            <div v-if="false" class="mb-4">
                <label for="timezone" class="form-label">
                    {{ $t("Server Timezone") }}
                </label>
                <select id="timezone" v-model="settings.serverTimezone" class="form-select">
                    <option value="UTC">UTC</option>
                    <option
                        v-for="(timezone, index) in timezoneList"
                        :key="index"
                        :value="timezone.value"
                    >
                        {{ timezone.name }}
                    </option>
                </select>
            </div>

            <!-- Primary Hostname -->
            <div class="mb-4">
                <label class="form-label" for="primaryBaseURL">
                    {{ $t("primaryHostname") }}
                </label>

                <div class="input-group mb-3">
                    <input
                        v-model="settings.primaryHostname"
                        class="form-control"
                        :placeholder="$t(`CurrentHostname`)"
                    />
                    <button class="btn btn-outline-primary" type="button" @click="autoGetPrimaryHostname">
                        {{ $t("autoGet") }}
                    </button>
                </div>

                <div class="form-text"></div>
            </div>

            <!-- Save Button -->
            <div>
                <button class="btn btn-primary" type="submit">
                    {{ $t("Save") }}
                </button>
            </div>
        </form>

        <!-- Scheduler Settings -->
        <h4 class="mt-5 mb-3">{{ $t("schedulerSettings") }}</h4>
        <div class="shadow-box big-padding mb-4">
            <div class="mb-3">
                <BFormCheckbox v-model="scheduler.enabled" switch @change="saveScheduler">
                    {{ $t("enableAutoUpdateScheduler") }}
                </BFormCheckbox>
            </div>

            <div class="mb-3">
                <label class="form-label">{{ $t("cronExpression") }}</label>
                <input v-model="scheduler.cronExpression" type="text" class="form-control" placeholder="0 3 * * *" :disabled="!scheduler.enabled">
                <div class="form-text">{{ $t("cronHelp") }}</div>
            </div>

            <div class="mb-3">
                <BFormCheckbox v-model="scheduler.pruneAfterUpdate" switch :disabled="!scheduler.enabled">
                    {{ $t("pruneAfterUpdate") }}
                </BFormCheckbox>
            </div>

            <div class="mb-3" style="margin-left: 2.5rem;">
                <BFormCheckbox v-model="scheduler.pruneAllAfterUpdate" switch :disabled="!scheduler.enabled || !scheduler.pruneAfterUpdate">
                    {{ $t("pruneAllAfterUpdate") }}
                </BFormCheckbox>
            </div>

            <button class="btn btn-primary" :disabled="!scheduler.enabled" @click="saveScheduler">
                {{ $t("Save") }}
            </button>
        </div>

    </div>
</template>

<script lang="ts">

import dayjs from "dayjs";
import { timezoneList } from "../../util-frontend";

export default {
    components: {

    },

    data() {
        return {
            timezoneList: timezoneList(),
            scheduler: {
                enabled: false,
                cronExpression: "0 3 * * *",
                pruneAfterUpdate: false,
                pruneAllAfterUpdate: false,
            },
        };
    },

    computed: {
        settings() {
            return this.$parent.$parent.$parent.settings;
        },
        saveSettings() {
            return this.$parent.$parent.$parent.saveSettings;
        },
        settingsLoaded() {
            return this.$parent.$parent.$parent.settingsLoaded;
        },
        guessTimezone() {
            return dayjs.tz.guess();
        },
    },

    mounted() {
        this.loadSchedulerSettings();
    },

    methods: {
        /** Save the settings */
        saveGeneral() {
            localStorage.timezone = this.$root.userTimezone;
            this.saveSettings();
        },
        /** Get the base URL of the application */
        autoGetPrimaryHostname() {
            this.settings.primaryHostname = location.hostname;
        },

        loadSchedulerSettings() {
            this.$root.getSocket().emit("getSchedulerSettings", (res) => {
                if (res.ok) {
                    this.scheduler = res.data;
                }
            });
        },

        saveScheduler() {
            this.$root.getSocket().emit("setSchedulerSettings", this.scheduler, (res) => {
                this.$root.toastRes(res);
            });
        },

    },
};
</script>

