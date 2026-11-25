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
