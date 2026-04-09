# tenant-server

Separate Rust backend for white-label tenant services.

Initial scope:

- workspace-scoped API key auth
- tenant-isolated agent configuration
- tenant-isolated conversation history
- usage reporting and limits
- branding/domain configuration

This service is intentionally separate from the KasiTek core `server/` deployment.
