# Contributing to Kaseobot

Thank you for considering a contribution! This document outlines the process and standards.

## Quick Start

```bash
git clone https://github.com/karefined-eng/kaseobot.git
cd kaseobot
npm ci
npm run check  # runs typecheck + tests
```

## Development Workflow

1. **Fork** the repository
2. **Create a feature branch**: `git checkout -b feat/your-feature-name`
3. **Make changes** with tests
4. **Run checks**: `npm run check` (must pass)
4. **Commit** with conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`
5. **Push** and open a Pull Request

## Code Standards

- **TypeScript strict mode** — no `any`, explicit types
- **Conventional Commits** — `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`
- **Tests required** for new features — see `test/` for patterns
- **No secrets in code** — use `.dev.vars` (gitignored) for local config

## Project Structure

```
src/
  index.ts          # Worker entry, Telegram webhook, command routing
  jobs.ts           # D1 job CRUD, queue production, limits
  queue-consumer.ts # Audit execution, retries, dead-letter
  audits/           # Static engine, GEO, storage, types
  ai/               # Kimi client, prompts, markdown formatting
  history.ts        # /history, /forget, cleanup
  telegram-ui.ts    # Inline keyboards, formatting
test/
  fakes.ts          # Fake D1/Queue for unit tests
  *.test.ts         # Vitest suites
container-seomator/ # SEOmator Container (Docker + Playwright)
```

## Testing

```bash
npm run test       # run all tests
npm run test:watch # watch mode
```

Tests use `FakeD1` and `FakeQueue` — no external dependencies.

## Code Style

- **Prettier** (via `npm run format` if configured)
- **ESLint** (via `npm run lint` if configured)
- **TypeScript strict** — `tsc --noEmit` must pass

## Reporting Issues

- **Bugs**: Use GitHub Issues with reproduction steps
- **Security**: See [SECURITY.md](SECURITY.md)
- **Feature requests**: GitHub Discussions preferred

## Code of Conduct

Be respectful, constructive, and inclusive. This project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

---

**First-time contributors welcome!** Look for `good first issue` labels.