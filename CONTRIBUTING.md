# Contributing
1. Create a focused branch from the default branch.
2. Keep changes scoped and preserve API contracts unless a migration is included.
3. Add automated tests for behavior changes.
4. Run `npm ci` and `npm run verify` before opening a pull request.
5. Document environment, schema, deployment, and compatibility changes.

## Conventions
- Validate untrusted input on the server.
- Enforce authorization in API handlers; hiding UI controls is not access control.
- Use parameterized SQL and transactions for multi-step finance/inventory writes.
- Never log passwords, bearer tokens, connection strings, webhook URLs, or personal data.
- Pull requests must describe design, risks, migration steps, and test results.
