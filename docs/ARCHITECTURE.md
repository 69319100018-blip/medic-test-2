# Architecture Baseline

## Current runtime

- **Canonical API:** `api/index.js` exports one Express application containing authentication and domain routes.
- **Vercel:** `vercel.json` rewrites API paths to the canonical `api/index.js` entry point.
- **Local development:** `server-local/server.js` loads `server-local/.env`, mounts the same exported API application, and adds a guarded static-file host for the frontend. It does not maintain a separate copy of business routes.
- **Frontend:** `index.html`, `dashboard.html`, and `register.html` use scripts under `js/`.
- **Persistence:** Neon PostgreSQL schema is defined in `schema.sql`.

This arrangement keeps API paths and authorization behavior consistent between local development and Vercel. The local wrapper denies direct access to source, configuration, schema, and documentation files.

## Domain areas

- User accounts, roles, and access flags
- Shift check-in/check-out and monitoring
- Central fund and transaction history
- Equipment stock and withdrawals
- Vehicle registry
- Doctor/member directory
- Device sessions, security events, and administrative bans

## Target module layout

The next refactoring stages should extract the canonical API's route logic into explicit modules:

```text
src/
  config/          validated environment and runtime configuration
  http/            middleware, routes, request schemas
  modules/
    auth/
    users/
    shifts/
    finance/
    inventory/
    vehicles/
    directory/
    security/
  infrastructure/
    database/
    notifications/
  shared/
    errors/
    validation/
tests/
  unit/
  integration/
```

This is the migration target, not the current directory structure.

## Remaining engineering work

- Move route handlers out of the large `api/index.js` entry point into tested modules.
- Retire legacy per-resource handlers under `api/` after route and deployment compatibility checks.
- Make finance and stock mutations atomic and concurrency-safe.
- Validate payload schemas and apply consistent error responses.
- Use shared rate limiting for serverless deployments.
- Split the frontend monolith into maintainable modules.
- Add a production CSP after inline scripts are removed or nonced.
- Add PostgreSQL integration, authorization-matrix, concurrency, accessibility, and security tests.
