# Akiba AR Hackerspace

Mobile AR hint system: residents place styled hints at QR markers, guests discover them, Pokemon-like creatures. Full features unlock onsite only.

## Quick Start (Coolify / Docker)

```bash
cp .env.example .env
# Edit .env: set JWT_SECRET, TELEGRAM_BOT_TOKEN, RESIDENTS_CHAT_ID
docker compose up -d
```

API on http://localhost:3100

## Structure

```
server/          Node backend (Postgres, Express, Telegram auth)
mobile/          React Native mobile app (Expo)
docker-compose.yml  Postgres 17 + API
```

## Coolify Deploy

1. New Resource → Docker Compose
2. Paste `docker-compose.yml`
3. Environment: `JWT_SECRET`, `TELEGRAM_BOT_TOKEN`, `RESIDENTS_CHAT_ID`, `LOCAL_SERVER=1` (onsite) or `0` (cloud)
4. Domain: `akiba.example.com`
5. Deploy

## Telegram Setup

```bash
# 1. Create bot: @BotFather → /newbot → copy token
# 2. Create residents channel, add bot as admin
# 3. Get chat ID:
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
# or use @username if public
```

## Mobile App

```bash
cd mobile
npm install
# Edit src/api.ts: LOCAL_API = your server IP
npm start
```

See `DEPLOY.md` for QR codes, physical testing, production checklist.

## Tests

```bash
cd server
PGUSER=root PGDATABASE=akiba JWT_SECRET=test npm test
# 25/25
```
