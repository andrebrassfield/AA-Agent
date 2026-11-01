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

If the shop offers multiple services, multiple technicians, or Saturday hours, open `client/services.json`, `client/staff.json`, and `client/business.json` in any text editor and add the remaining entries. *(For a home inspection pilot or manual file setup, you can instead copy `cp -R templates/home-inspection/. client/` or `cp -R templates/blank/. client/` and replace every `TODO:` value using answers directly from the owner—never from scraping their website.)* Do **not** put any API keys or secrets inside `client/*.json`.

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

---

## SMS Carrier Go-Live Checklist (Twilio + A2P 10DLC)

AA Book ships with SMS set to `"stub"` by default so you can install, demo, and test on the shop computer without sending real text messages. Complete the six steps below **in order** when you are ready for the client's AA Book machine to send and receive real customer texts through Twilio. Every step ends with a **Verify** check.

### SMS Step 1. Create and Upgrade the Twilio Account

1. Go to [https://www.twilio.com/try-twilio](https://www.twilio.com/try-twilio) and create a dedicated Twilio account for the shop (or an isolated Subaccount under your agency account), then complete email and phone verification.
2. Click **Upgrade** at the top of the Twilio Console, add the billing card, and turn on **Auto Recharge** so texts never stop on a busy weekend. *(Trial accounts cannot text regular customer phone numbers.)*
3. On the main **Twilio Console Dashboard**, locate the **Account Info** box containing your **Account SID** and **Auth Token**. Keep this browser tab open—do **not** paste either value into any `client/*.json` file.

**Verify:**
Look at the top bar of the Twilio Console: confirm the **Trial** banner is gone, billing shows an active positive balance, and both **Account SID** and **Auth Token** are visible under **Account Info**.

---

### SMS Step 2. Buy a Local SMS Phone Number

1. In the Twilio Console left sidebar, click **Phone Numbers -> Manage -> Buy a number**.
2. Enter the shop's local area code (for example `479` for Fort Smith), check **SMS** (and **Voice** if calls will also route through this number), and click **Search**.
3. Pick a clean local number, click **Buy**, and confirm the purchase. Write down the full number in `+1` format with no spaces or dashes (for example `+14795550199`).

**Verify:**
In Twilio Console, open **Phone Numbers -> Manage -> Active numbers**: confirm the new `+1...` number appears in the list with the **SMS** capability icon enabled.

---

### SMS Step 3. Complete A2P 10DLC Brand and Campaign Registration

US wireless carriers (AT&T, T-Mobile, Verizon) block business text messages from regular 10-digit numbers until the business is registered for **A2P 10DLC**. Do not flip the client live until registration is approved:

1. In the Twilio Console left sidebar, open **Messaging -> Regulatory Compliance -> Onboarding (A2P 10DLC)**.
2. **Register the Business Profile & Brand:** Enter the client's exact legal business name, federal **EIN** (matching their IRS SS-4 / tax return letter-for-letter), business street address, website, and contact info, then submit the **Low-Volume Standard** (or **Standard**) Brand.
3. **Create a Messaging Service & Register the Campaign:** Choose a transactional/customer-care use case, describe the messages plainly (*"1-to-1 missed-call text-backs, appointment confirmations, appointment reminders, open estimate follow-ups, and post-service review links for customers who call or request service"*), include sample messages, and confirm `STOP`, `START`, and `HELP` keyword handling.
4. Once Campaign status reaches **Verified**, open **Messaging -> Services -> [Your Service] -> Sender Pool** and attach the `+1...` phone number you bought in SMS Step 2.

**Verify:**
In Twilio Console under **Messaging -> Regulatory Compliance -> Campaigns**, confirm the Campaign status reads **Verified** (not *In Progress* or *Failed*) and the purchased `+1...` number is listed inside that Messaging Service's **Sender Pool**.

---

### SMS Step 4. Save Twilio Credentials in `.env`

Open `~/Apps/aabook/.env` in a text editor on the shop computer and add the three Twilio lines using values from SMS Steps 1 and 2 (plus `TWILIO_WEBHOOK_URL` set to the exact public HTTPS URL you will point Twilio to in SMS Step 5):

```ini
TWILIO_ACCOUNT_SID=<paste-your-account-sid>
TWILIO_AUTH_TOKEN=<paste-your-auth-token>
TWILIO_PHONE_NUMBER=+14795550199
TWILIO_WEBHOOK_URL=https://<your-shop-tunnel-domain>/webhooks/twilio/sms
```

Save the file and update your password vault copy. Never put `TWILIO_ACCOUNT_SID` or `TWILIO_AUTH_TOKEN` inside `client/*.json`.

**Verify (without printing secrets on screen):**
```bash
cd ~/Apps/aabook
grep -q '^TWILIO_ACCOUNT_SID=.\+' .env && \
grep -q '^TWILIO_AUTH_TOKEN=.\+' .env && \
grep -q '^TWILIO_PHONE_NUMBER=+1[0-9]\{10\}$' .env && \
echo "Twilio .env keys are set" && git status --short
```
Expected: Prints `Twilio .env keys are set` and `git status --short` prints nothing.

---

### SMS Step 5. Point the Twilio Number's Webhook at the AA Book Server

1. Expose local port `3000` over HTTPS using your shop tunnel (for example **Cloudflare Tunnel** or **Tailscale Funnel**) so `https://<your-shop-tunnel-domain>` forwards to `http://127.0.0.1:3000`.
2. In the Twilio Console, go to **Phone Numbers -> Manage -> Active numbers**, click the client's `+1...` number, and scroll down to **Messaging Configuration**.
3. Next to **A message comes in**, set:
   - **Source:** `Webhook`
   - **URL:** `https://<your-shop-tunnel-domain>/webhooks/twilio/sms`
   - **HTTP:** `HTTP POST`
4. Click **Save configuration**.

**Verify:**
From Terminal, send an unsigned test request to your public webhook URL to confirm the tunnel reaches AA Book and AA Book's Twilio signature guard blocks forged requests:
```bash
curl -i -X POST https://<your-shop-tunnel-domain>/webhooks/twilio/sms -d "From=%2B14795550100&Body=test"
```
Expected: Returns `HTTP/2 403` (or `HTTP/1.1 403 Forbidden`) with `{"error":"Forbidden: missing X-Twilio-Signature"}`.

---

### SMS Step 6. Flip `client/channels.json` from `stub` to `twilio` and Go Live

1. Open `~/Apps/aabook/client/channels.json` in a text editor and change `"stub"` to `"twilio"`:
   ```json
   {
     "voice": {
       "provider": "retell"
     },
     "sms": {
       "provider": "twilio"
     }
   }
   ```
   *(Optional: if the shop wants outbound texts sent from a specific number recorded in config, also set `"sms": "+14795550199"` under `phoneNumbers` in `client/business.json`.)*
2. Restart the background service so AA Book reloads `.env` and `client/channels.json`:
   - **macOS:** `launchctl kickstart -k gui/$(id -u)/com.arkansasautomated.aabook.<client-slug>`
   - **Linux:** `systemctl --user restart aabook-<client-slug>.service`
3. Take a fresh config backup with `aabook backup`.

**Verify:**
1. Confirm CLI and `/health` both report `"twilio"`:
   ```bash
   cd ~/Apps/aabook
   aabook status
   SECRET=$(grep '^WEBHOOK_SECRET=' ~/Apps/aabook/.env | cut -d= -f2-)
   curl -s -H "x-webhook-secret: $SECRET" http://127.0.0.1:3000/health
   ```
   Expected: `aabook status` shows `SMS: Provider: twilio` and `/health` returns `{"ok":true,"provider":"retell","smsProvider":"twilio"}`.
2. From your personal cell phone, text `HELP` to the shop's Twilio number, then text `STOP`, then text `START`:
   - Expected on `HELP`: Your phone receives the shop's informational reply within a few seconds.
   - Expected on `STOP` then `START`: Opt-out stops texts and `START` sends the opt-in confirmation reply (`You are opted back in to text messages...`).
