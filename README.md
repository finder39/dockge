<div align="center" width="100%">
    <img src="./frontend/public/icon.svg" width="128" alt="" />
</div>

# Dockge Managed

A fork of [hamphh/dockge](https://github.com/hamphh/dockge), which itself is a fork of the original [Dockge](https://github.com/louislam/dockge) by [@louislam](https://github.com/louislam).

This fork adds automated update management, a REST API, and Home Assistant integration. It is entirely vibecoded with [Claude Code](https://claude.ai/claude-code).

For general information about Dockge, please refer to the [original project](https://github.com/louislam/dockge).

## What's New

### Automated Update Management
- **Per-stack auto-update toggle** — enable automatic updates on a per-stack basis
- **Cron-based scheduler** — configurable schedule (default: 3 AM daily) with over-run protection
- **Image update detection** — uses skopeo to compare local vs remote image digests, with configurable check intervals
- **Force check for updates** — manually trigger image update checks per stack from the UI or API
- **Update history** — full history of all updates (manual, scheduled, API) with output logs, filterable and paginated

### REST API
- API key authentication (generated via Settings UI or `DOCKGE_API_KEY` env var)
- Endpoints for stack management: list, status, update, check-updates, auto-update toggle
- Bulk operations: update-all, system prune
- Scheduler control: get/set settings, manual trigger
- Multi-agent support: all endpoints accept `?endpoint=` to target specific agents

### Multi-Agent Improvements
- Graceful handling of agent timeouts and failures
- Remote agent stack operations via REST API proxy
- Start/stop/restart endpoints for individual stacks

### Self-Update Support
- Stacks containing Dockge itself can be updated (pull + recreate) with safety guards
- Destructive operations blocked on the self-stack, restart shows a warning
- Terminal output displayed during self-update instead of blank screen

### Host Path Resolution
- Auto-detects host stacks directory from container bind mounts at startup
- Ensures relative volume paths in compose files resolve correctly on the host
- No manual `DOCKGE_STACKS_DIR_HOST` env var needed

### UI Enhancements
- Dashboard shows updates available count, next image check time, and next auto-update time per agent
- Compose page shows "Image updates available" badge
- Stack list sidebar shows clock icon for auto-update enabled stacks
- Update history page at `/update-history`
- API key management in Settings

## Usage

```yaml
image: ghcr.io/finder39/dockge:latest
```

Replace the image in your existing Dockge compose file. The image is built for **linux/amd64** and **linux/arm64**.

> **Note:** Back up your Dockge data folder before switching, as this image modifies the database with new tables.

## Home Assistant Integration

A companion [Home Assistant custom component](https://github.com/finder39/ha-dockge-integration) is available that uses this fork's REST API to provide sensors, switches, and buttons for managing your stacks from Home Assistant.
