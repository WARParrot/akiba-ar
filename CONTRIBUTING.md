# Contributing to Akiba AR

Quick guide to the contribution workflow. All changes land on `master` via pull requests — direct pushes to `master` are blocked by a repository ruleset (active enforcement, verified by rejected push).

## Workflow

1. **Branch** from `master`:
   ```bash
   git checkout master && git pull
   git checkout -b feature/my-change   # or fix/..., docs/...
   ```
2. **Commit** your changes. Keep commits small and described (`fix: ...`, `feat: ...`, `docs: ...`).
3. **Push** the branch:
   ```bash
   git push origin feature/my-change
   ```
4. **Open a PR** against `master` (via GitHub web, or `gh pr create` / the REST API).
5. After review, **merge** in the GitHub UI (or via API with Pull requests: write).

## Branch rules (verified 2026-09-19)

| Action | Allowed? |
|---|---|
| Push to `master` | ❌ rejected — `push declined due to repository rule violations` |
| Push to any other branch (`test/push-access`, `feature/*`, ...) | ✅ works |
| PRs targeting `master` | ✅ via web or API |
| Read branch-protection details via API | ❌ needs a token with Administration scope |

Ruleset: `master` (id 23676600), target branch, enforcement **active**.

## Environment & credentials

- Deploy/local run: see [README.md](README.md) (Coolify / `docker compose up -d`, `.env` with `JWT_SECRET`, `TELEGRAM_BOT_TOKEN`, `RESIDENTS_CHAT_ID`).
- Agent/CI credentials: a fine-grained PAT scoped to this repo with **Contents: Read and write** + **Pull requests: Read and write** (Metadata auto). No fork needed — feature branches are pushed in-repo. Administration scope is *not* needed for contributing.
- The network to github.com from some environments is flaky (timeouts on connect); retry pushes before assuming failure.

## Project structure

```
server/          Node backend (Postgres, Express, Telegram auth)
mobile/          React Native mobile app (Expo)
docker-compose.yml  Postgres 17 + API
```

See [DEPLOY.md](DEPLOY.md) for deployment details.
