# MacroSync reliability checklist

This update adds an application health endpoint, graceful shutdown, bounded public API rate limiting, database-side account deletion, RLS/RPC enforcement, and moderation audit records.

For production: enable Supabase Point-in-Time Recovery/backups on the paid plan you choose, test restores, monitor database size and API errors, keep secrets server-side, use HTTPS, configure a production process manager, and use a shared rate-limit store if more than one server instance is deployed.

The `/api/health` endpoint reports server and configuration state but does not expose secrets.
