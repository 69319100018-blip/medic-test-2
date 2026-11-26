# Security Policy
Do not disclose credentials, personal data, or exploit details in public issues. Report vulnerabilities privately to the repository owner. Redact tokens, connection strings, and user data.

## Secret handling
- Store production values only in encrypted deployment environment variables.
- Never commit `.env`, files named `env`, database URLs, JWT secrets, webhook URLs, or private keys.
- Treat every credential ever committed as compromised. Removing a later copy does not erase Git history.
- Rotate exposed credentials before deploying cleanup.
- Use separate credentials and least-privilege database roles per environment.

## Authentication
- New passwords must be at least 12 characters.
- JWT keys must contain at least 32 characters and be randomly generated.
- Authorization attributes are loaded by the API; browser checks are not access control.
- Anti-inspection scripts are not a security boundary.


## Application hardening
- API authorization is enforced server-side on every request. Browser DevTools state, hidden buttons and device fingerprints are never authorization credentials.
- Access tokens are short-lived, issuer/audience-bound and tracked in the security event ledger for immediate logout/revocation.
- Every API request rechecks the account, active session, current role and active account/device/IP bans.
- Login failures are counted in the shared database ledger by username and source IP; per-instance API throttles add another layer.
- API responses are not cacheable. Static pages use a restrictive Content Security Policy, HSTS, frame denial, a restrictive referrer policy and a Permissions Policy.
- Client-reported browser events are audit telemetry only. They can never create bans automatically.
- DevTools cannot be reliably blocked from a browser page. Keep secrets and authorization decisions on the server.
- Production secrets previously committed to repository history must be rotated; deleting a later copy does not erase history.
