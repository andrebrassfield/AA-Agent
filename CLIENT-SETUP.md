# On-Site Client Setup Checklist (`CLIENT-SETUP.md`)

Follow these steps **in order** when setting up AA Book on a client's shop computer (Mac Mini or Linux mini-PC). Every step ends with a **Verify** check—do not move to the next item until the check passes.

---

## 1. Prepare the Machine & Install Bun

1. Plug the machine into Ethernet (preferred) or shop Wi-Fi, and set system power settings so the computer **never sleeps** when the display turns off.
2. Open **Terminal** and check whether Bun (`v1.1.0+`) is installed. If not, install it:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```
   Close and reopen Terminal if you just installed Bun.

**Verify:**
```bash
bun --version
```
Expected: Prints `1.1.0` or higher (for example `1.4.0`).

---

## 2. Clone the AA Book Repository

Clone AA Book into a permanent folder under the shop user's home directory:

```bash
mkdir -p ~/Apps
cd ~/Apps
git clone git@github.com:andrebrassfield/AA-Agent.git aabook
cd aabook
```

**Verify:**
```bash
ls -la SPEC.md bin/aabook.js
```
Expected: Both `SPEC.md` and `bin/aabook.js` are listed without errors.

---

## 3. Run the One-Command Installer

Run the installer from inside `~/Apps/aabook`:

```bash
./bin/aabook.js install
```

**Verify (idempotency + CLI link):**
```bash
aabook --version && aabook install
```
Expected: Prints `aabook v0.1.0`, followed by `Already installed — nothing changed.`

---

## 4. Run the Offline Demo Pass

Confirm the engine, SQLite database, workflows, and local webhook server all work on this machine before entering client details:

```bash
aabook demo
```

**Verify:**
Expected: Output ends with `DEMO COMPLETE. All 4 SPEC workflows + Local Webhook Channels Pass verified.` and exits with code `0` (`echo $?` prints `0`).

---

## 5. Build the Shop Configuration

Run the interactive setup wizard and enter the client's real business name, trade, timezone, main phone number, address, lead service, lead technician, greeting, AI disclosure wording, cancellation policy, zip codes, and voice provider:

```bash
aabook setup
```

If the shop offers multiple services, multiple technicians, or Saturday hours, open `client/services.json`, `client/staff.json`, and `client/business.json` in any text editor and add the remaining entries. Do **not** put any API keys or secrets inside `client/*.json`.

**Verify:**
```bash
aabook status
```
Expected: Shows `✅ Client Configuration: OK` with the client's business name, main phone number, service count, and staff count, plus `✅ Local Data Store (SQLite): OK`.

---

## 6. Configure Secrets in `.env`

Generate a strong random `WEBHOOK_SECRET` and edit `.env` in `~/Apps/aabook/.env`:

```bash
openssl rand -hex 32
```

Open `.env` and fill in `WEBHOOK_SECRET=<paste-generated-secret>`, set `DAILY_SPEND_CAP_USD=5.00` (or the agreed daily cap), and add Google Calendar credentials (`GOOGLE_CALENDAR_ID`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`) if connecting a live Google Calendar. Save a copy of `.env` values in your password vault—`.env` is intentionally excluded from git and all AA Book backups.

**Verify (without printing secret values to the screen):**
```bash
grep -q '^WEBHOOK_SECRET=.\+' .env && echo "WEBHOOK_SECRET is set" && git status --short
```
Expected: Prints `WEBHOOK_SECRET is set` and `git status --short` outputs nothing (confirming `.env` and `client/` are gitignored).

---

## 7. Smoke-Test the Local Webhook Server

Start `aabook serve` in the foreground first to confirm authentication and config loading:

```bash
aabook serve --port 3000
```

In a **second** Terminal window, test both unauthenticated rejection and authenticated health:

**Verify:**
```bash
# 1. Must return 401 Unauthorized without secret:
curl -i http://127.0.0.1:3000/health

# 2. Must return 200 OK with {"ok":true,...} when passing WEBHOOK_SECRET from .env:
SECRET=$(grep '^WEBHOOK_SECRET=' ~/Apps/aabook/.env | cut -d= -f2-)
curl -s -H "x-webhook-secret: $SECRET" http://127.0.0.1:3000/health
```
Expected: First command returns `HTTP/1.1 401 Unauthorized`; second returns JSON containing `"ok":true`. Press `Ctrl+C` in the first Terminal window to stop the foreground server cleanly.

---

## 8. Install and Start the Always-On Background Service

Generate the OS service file named for this client (`launchd` plist on macOS or `systemd` user unit on Linux):

```bash
cd ~/Apps/aabook
aabook install --service
```

Copy and run the exact **Start** command printed in the terminal:
- **macOS:** `launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.arkansasautomated.aabook.<client-slug>.plist"`
- **Linux:** `systemctl --user daemon-reload && systemctl --user enable --now aabook-<client-slug>.service` *(on headless Linux servers, also run `sudo loginctl enable-linger $USER` once so user services stay up after logout).*

**Verify:**
```bash
SECRET=$(grep '^WEBHOOK_SECRET=' ~/Apps/aabook/.env | cut -d= -f2-)
curl -s -H "x-webhook-secret: $SECRET" http://127.0.0.1:3000/health
```
Expected: Returns `200 OK` JSON (`{"ok":true,"provider":"retell","smsProvider":"stub"}`) with no foreground terminal running `aabook serve`.

---

## 9. Take the Baseline Backup

Create an initial timestamped backup archive of the client configuration, SQLite store, and audit log:

```bash
cd ~/Apps/aabook
aabook backup
```

Copy the generated `.tar.gz` file from `~/Apps/aabook/backups/` onto your setup drive or off-machine backup folder.

**Verify:**
```bash
ls -lh ~/Apps/aabook/backups/
tar -tzf ~/Apps/aabook/backups/aabook-backup-*.tar.gz
```
Expected: Lists `client/*.json`, `audit/audit-log.jsonl`, and `manifest.json` (plus `data/aabook.sqlite` once initialized), and lists **zero** `.env` files.
