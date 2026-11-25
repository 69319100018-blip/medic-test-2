# Architecture Baseline

## Current runtime
- **Vercel:** `api/index.js` exports the Express application; `vercel.json` rewrites API paths to this entry point.
- **Local:** `server-local/server.js` serves frontend assets and a local Express API. `api/server.js` is a duplicate.
- **Frontend:** `index.html`, `dashboard.html`, and `register.html` use scripts under `js/`.
- **Persistence:** Neon PostgreSQL schema is in `schema.sql`.

The secure frontend integration uses `js/api-client.js` for Bearer-token requests and `js/neon-bridge.js` for API-backed dashboard actions. The entry pages now load these scripts; local-only login was removed.

## Domain modules
Accounts/roles, shifts, central fund, inventory, vehicles, doctor directory, device sessions and security events.

## Target architecture
```text
src/
  config/       validated environment and runtime configuration
  http/         middleware, routes, request schemas
  modules/      auth, users, shifts, finance, inventory, vehicles, directory, security
  infrastructure/database/notifications
  shared/       errors and validation
tests/          unit and integration
```
This is the migration target, not the current directory structure.

## Remaining work
- Consolidate Vercel and local API implementations and retire legacy route files.
- Use PostgreSQL transactions and concurrency-safe updates for finance and stock.
- Use shared rate limiting in serverless deployments.
- Split the browser monolith into maintainable modules.
- Add a production CSP after inline scripts are removed or nonced.
- Add PostgreSQL integration, authorization-matrix, concurrency, accessibility and security tests.
