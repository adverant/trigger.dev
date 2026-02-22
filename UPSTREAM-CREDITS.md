# Upstream Credits

## Trigger.dev

This repository is a fork of [Trigger.dev](https://github.com/triggerdotdev/trigger.dev), an open-source platform for creating durable background tasks, AI agent workflows, and reliable automation.

### Original Authors

Trigger.dev is created and maintained by the [Trigger.dev team](https://trigger.dev/about).

- **Repository:** https://github.com/triggerdotdev/trigger.dev
- **Website:** https://trigger.dev
- **License:** Apache License 2.0

### License Preservation

The original Trigger.dev codebase is licensed under the **Apache License 2.0**. This fork preserves that license in its entirety for all original code. All files outside of the `nexus-plugin/` directory remain under the original Apache 2.0 license terms.

The full license text is available in the [LICENSE](./LICENSE) file at the root of this repository.

### What This Fork Adds

This fork adds the `nexus-plugin/` directory, which contains the **Adverant Nexus marketplace plugin** for Trigger.dev. This plugin provides:

- A Nexus-compatible REST API wrapper around Trigger.dev functionality
- WebSocket real-time event streaming for task run monitoring
- Deep integration with Nexus platform services (GraphRAG, MageAgent, FileProcess, LearningAgent, GeoAgent, Jupyter, CVAT, GPU Bridge, Sandbox)
- A dashboard UI for managing tasks, runs, schedules, workflows, and integrations
- Kubernetes deployment manifests for self-hosted Trigger.dev alongside the Nexus stack
- MCP (Model Context Protocol) tool definitions for AI agent interaction
- CI/CD workflows for building and publishing the plugin container image
- An upstream sync workflow to keep this fork up to date with the official Trigger.dev repository

### Additional Workflows

The following GitHub Actions workflows are added by this fork:

- `.github/workflows/nexus-plugin-ci.yml` - CI pipeline for the Nexus plugin
- `.github/workflows/upstream-sync.yml` - Automated weekly sync with the upstream Trigger.dev repository

### No Upstream Code Modified

This fork does **not** modify any original Trigger.dev source code. All additions are isolated in:

- `nexus-plugin/` - The Nexus marketplace plugin
- `.github/workflows/upstream-sync.yml` - Upstream sync automation
- `.github/workflows/nexus-plugin-ci.yml` - Plugin CI pipeline
- `UPSTREAM-CREDITS.md` - This file

This isolation ensures clean upstream merges and preserves the integrity of the original codebase.
