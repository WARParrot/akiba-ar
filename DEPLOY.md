# Akiba AR: Physical Deployment Guide

You've built the backend and mobile app. This guide walks through deploying to a real server + testing on a physical phone.

## 1. Server Setup (On-Site Box)

### Hardware

Any Linux box inside the hackerspace network. Raspberry Pi 4 / NUC / old laptop works.

### Install

```bash
# Unpack
cd /opt
tar xzf akiba-ar.tar.gz
cd akiba-ar/server
npm install --omit=dev

# Postgres
apt install postgresql postgresql-contrib
sudo -u postgres psql -c "CREATE DATABASE akiba"
sudo -u postgres psql -c "CREATE USER akiba WITH PASSWORD 'change-me' SUPERUSER"
```

### Config

```bash
cat > /opt/akiba-ar/server/.env <<'EOF'
PGUSER=akiba
PGPASSWORD=change-me
PGDATABASE=akiba
PGHOST=/var/run/postgresql
JWT_SECRET=$(openssl rand -base64 32)
TELEGRAM_BOT_TOKEN=123456:your-bot-token-from-@BotFather
RESIDENTS_CHAT_ID=@your_residents_channel
LOCAL_SERVER=1
PORT=3100
EOF
```

Get `TELEGRAM_BOT_TOKEN`: talk to [@BotFather](https://t.me/BotFather), `/newbot`.  
Get `RESIDENTS_CHAT_ID`: create a public channel, invite the bot as admin, use `@channel_username` or numeric ID.

### Systemd Service

```bash
cat > /etc/systemd/system/akiba-ar.service <<'EOF'
[Unit]
Description=Akiba AR Backend
After=network.target postgresql.service

[Service]
Type=simple
User=akiba-ar
WorkingDirectory=/opt/akiba-ar/server
EnvironmentFile=/opt/akiba-ar/server/.env
ExecStart=/usr/bin/npm start
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

useradd -r -s /bin/false akiba-ar
chown -R akiba-ar:akiba-ar /opt/akiba-ar
systemctl daemon-reload
systemctl enable --now akiba-ar
systemctl status akiba-ar
```

### Verify

```bash
curl http://127.0.0.1:3100/health
# {"ok":true,"onsite":true}
```

### Firewall

Open 3100 only to the local subnet:

```bash
ufw allow from 192.168.1.0/24 to any port 3100
```

### Find the Server IP

```bash
ip -4 addr show | grep inet
# Note the 192.168.x.x address on your LAN interface
```

You'll give this IP to the mobile app.

---

## 2. Mobile App Setup

### Edit API URLs

On your dev machine:

```bash
cd /root/akiba-ar/mobile/src
nano api.ts
```

Change:

```typescript
const LOCAL_API = 'http://192.168.1.50:3100';  // your on-site box IP
const REMOTE_API = 'https://akiba.example.com'; // cloud instance if you deploy one
```

### Build APK (Android)

```bash
cd /root/akiba-ar/mobile
npm install -g eas-cli
eas login
eas build:configure
eas build --platform android --profile preview
```

Download the APK from the build URL, transfer to your phone via USB or Telegram.

### iOS (TestFlight or Expo Go)

For quick testing: install [Expo Go](https://expo.dev/go) on your iPhone, run `npm start` from your dev machine (must be on same WiFi as the phone), scan the QR.

For production: `eas build --platform ios`, enroll in Apple Developer, submit to TestFlight.

---

## 3. Physical Testing Workflow

### A. Seed the Database

SSH to the on-site box:

```bash
psql -U akiba -d akiba <<'SQL'
INSERT INTO zones (name) VALUES ('Workshop'), ('Kitchen'), ('Lounge');

INSERT INTO markers (id, zone_id) 
VALUES ('qr-workshop-3dprinter', 1),
       ('qr-kitchen-fridge', 2),
       ('qr-lounge-couch', 3);

INSERT INTO creature_species (id, name, rarity, onsite_only)
VALUES ('transistorat', 'Transistorat', 2, true),
       ('bytedragon', 'Byte Dragon', 3, true),
       ('quantumduck', 'Quantum Duck', 5, true);
SQL
```

### B. Print QR Codes

Generate QR codes for marker IDs:

```bash
# Use any QR generator or:
npm install -g qrcode
qrcode -o /tmp/qr-workshop-3dprinter.png 'qr-workshop-3dprinter'
qrcode -o /tmp/qr-kitchen-fridge.png 'qr-kitchen-fridge'
qrcode -o /tmp/qr-lounge-couch.png 'qr-lounge-couch'
```

Print them, stick on equipment/walls.

### C. Admin: Spawn a Creature

```bash
curl -X POST http://192.168.1.50:3100/admin/spawns \
  -H 'authorization: Bearer YOUR_ADMIN_JWT' \
  -H 'content-type: application/json' \
  -d '{"marker_id":"qr-workshop-3dprinter","species_id":"transistorat","ttl_minutes":60}'
```

(Get an admin JWT: manually `UPDATE users SET role='admin' WHERE telegram_id=YOUR_TG_ID` in psql, then login in the app.)

### D. Test on Phone

1. **Connect to hackerspace WiFi** (`LOCAL_SERVER=1` means full features unlock).
2. Open the Akiba AR app (APK installed or Expo Go).
3. **Login** — tap "Login (mock)". (Real: implement Telegram Login Widget WebView.)
4. **AR Camera** — grant camera permission, scan the QR sticker on the 3D printer.
5. **See creature spawn** — "Transistorat (rarity 2)" appears, tap "Catch".
6. **Add a hint** (if you're a resident):
   - Tap "+ Add Hint"
   - Text: "Bed needs leveling after every 10 prints"
   - HTML: `<div style="color:#0ff;border:2px solid #0ff;padding:10px">⚠️ HOT NOZZLE</div>`
   - Type: practical, Visibility: public
   - Submit
7. **Scan again** — hint appears with the styled HTML rendered in a WebView.
8. **Switch to Feed tab** — see all public lore/joke hints.
9. **Switch to Collection tab** — see your caught Transistorat + leaderboard.

### E. Test Offsite Mode

1. Disconnect from hackerspace WiFi (use mobile data or home WiFi).
2. Reopen app — banner says "🔴 remote".
3. AR camera now shows "onsite_only" error when you try to scan.
4. Feed and Collection still work (read-only remote mode).

### F. Test Visibility Enforcement

1. Create a hint with visibility="residents".
2. Login as a guest (new Telegram account not in the residents channel).
3. Scan the same marker — the residents-only hint is hidden (server-side filter).

---

## 4. Common Issues

### "Login failed (backend needs TELEGRAM_BOT_TOKEN)"

The mock login in `App.tsx` sends a fake hash. Backend rejects it when `TELEGRAM_BOT_TOKEN` is set. Options:

- Real: implement Telegram Login Widget WebView (see [docs](https://core.telegram.org/widgets/login))
- Dev: comment out `verifyLogin` check in `server/src/app.ts` line 18 for local testing

### Camera not working in Expo Go

Expo Go has limited camera access on some Android ROMs. Build a standalone APK: `eas build --platform android`.

### QR won't scan

- Ensure good lighting
- Print QR at least 5x5 cm
- Check `expo-camera` has permission: Settings → Akiba AR → Camera

### Hints don't appear

Check server logs: `journalctl -u akiba-ar -f`  
Common: marker ID in QR doesn't match `markers.id` in DB.

### Creature catch fails

- Must be onsite (`LOCAL_SERVER=1` on the server you're reaching)
- Spawn may have expired (`expires_at < now()`)
- Already caught by someone else (single UPDATE, first writer wins)

### HTML hint renders blank

Sanitiser stripped everything. Check `{sanitized: true}` in the create response. Allowed: inline CSS (color, border, padding), no `url()`, no `javascript:`, no `<script>`.

---

## 5. Production Checklist

- [ ] `JWT_SECRET` is 32+ random bytes, not "test-secret"
- [ ] Postgres password changed from default
- [ ] Firewall limits port 3100 to LAN
- [ ] SSL termination via nginx if exposing to internet (don't; onsite-only is the feature)
- [ ] Telegram bot token kept secret (never commit `.env`)
- [ ] Admin role manually assigned, not auto-granted
- [ ] Backup `akiba` database daily: `pg_dump akiba > /backups/akiba-$(date +%F).sql`
- [ ] Monitor disk: hints with HTML can grow; archive old hints or move to S3
- [ ] Rate-limit `/auth/telegram` to avoid brute-force (nginx `limit_req`)

---

## 6. Cloud Backend (Optional)

For remote mode (users away from the space can still see their collection), deploy a second instance without `LOCAL_SERVER=1`:

```bash
# On a VPS
git clone ... && cd server && npm install --omit=dev
export DATABASE_URL=postgres://user:pass@your-cloud-pg/akiba
export JWT_SECRET=same-as-onsite
export TELEGRAM_BOT_TOKEN=same
export RESIDENTS_CHAT_ID=same
# LOCAL_SERVER unset
export PORT=3100
npm start
```

Update mobile `REMOTE_API` to `https://your-vps.com:3100`. Now offsite users hit the cloud, onsite users hit the local box (faster).

---

## 7. Next Steps

- Wire real Telegram Login Widget (WebView + `postMessage`)
- Add WebSockets for live creature spawn push
- BLE beacon scanner for indoor positioning (no QR scan needed)
- Admin web UI (React dashboard calling the admin endpoints)
- Move HTML hints to S3 when they outgrow the column (32KB cap)
- Trading/battles (schema ready, game logic stubbed)
- FCM/APNs push via `telegram.ts` `sendBotMessage`

---

This guide assumes you're the hacker who built it. If you're onboarding another dev, pair with them for the first deploy — Telegram bot setup and Postgres permissions trip everyone once.
