# Security Remediation — Required Before Production

## Confirmed finding
The public repository tracked `api/env` and `server-local/env`. Both contained configured `DATABASE_URL` and `JWT_SECRET` values and were identical. The values are intentionally not reproduced.

This branch removes the tracked copies and adds a root `.gitignore`. **Removal in a later commit does not erase credentials from earlier commits, forks, or existing clones. Treat them as compromised.**

## Owner actions
1. Rotate the Neon database password/connection string. Update Vercel Production, Preview and Development variables, plus private local secret stores.
2. Generate a new random `JWT_SECRET` of at least 32 characters and update every runtime. This invalidates tokens signed with the old key.
3. Review and rotate any webhook or third-party token that may have been stored in environment files or deployment settings.
4. Review Neon connection logs, Vercel deployment logs and repository access history.
5. Change or remove development seed-account passwords before production access.

Generate a new key locally (never commit its output):
```bash
openssl rand -hex 32
```

## Git history
After credential rotation, the owner may choose to rewrite history with `git filter-repo` and coordinate a force-push with collaborators and deployment integrations. This is disruptive and does not replace credential rotation; forks, caches and clones may retain old data.

## Production gate
Do not declare production readiness until credentials are rotated, seed accounts are addressed, exact production origins are configured and integration/security tests pass.
