# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| main (latest) | ✅ |

## Reporting a Vulnerability

**Please do NOT open a public issue for security vulnerabilities.**

Instead, email **security@karefined.com** or use GitHub's private vulnerability reporting:

1. Go to the **Security** tab in this repository
2. Click **Report a vulnerability**
3. Fill in the details

We will:
- Acknowledge within 48 hours
- Provide a fix timeline within 7 days
- Credit you (if desired) in the fix release

## What We Consider Security Issues

- Telegram bot token exposure
- Webhook secret leakage
- D1 data access bypass
- Queue message tampering
- Container escape / RCE
- User data leakage across allowlist boundaries
- Token leakage in logs/errors

## What We Don't Consider Security Issues

- Static audit false positives/negatives
- SEOmator engine differences vs. static engine
- Rate limiting / DoS (Cloudflare handles this)
- Telegram API rate limits

## Secrets Management

- **Never commit** `.dev.vars`, `.dev.vars.production`, or any `.env` files
- Use Cloudflare Workers secrets for production
- Use `.dev.vars` (gitignored) for local development
- Rotate secrets immediately if exposed

## Dependency Security

- `npm audit` runs in CI
- Dependabot alerts enabled
- Pin versions in `package.json`
- Review `package-lock.json` changes in PRs