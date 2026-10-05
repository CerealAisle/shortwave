# Running a staging instance

Two checkouts on one VM at independent commits, so you can put a change in
front of a real toy before it touches the real server.

```
  Lovense dashboard — ONE callback URL, you choose which:

     https://your-domain/lovense/callback   ──▶ :4000  /opt/lovense-bot
     https://your-domain/staging/callback   ──▶ :4001  /opt/lovense-bot-staging
                                                        ▲
                         both routes always live in the tunnel;
                         the dashboard decides which one is fed
```

Lovense allows exactly one callback URL per developer account. Rather than
building machinery to work around that, this setup leans on the fact that
**you are never testing and playing at the same time** — switching is one
field in the Lovense dashboard, and nothing on the VM changes.

Both instances run continuously. Only the one named in the dashboard receives
pairing callbacks and heartbeats; the other still responds to slash commands
and can still send commands to an already-paired toy, it just can't observe
presence.

---

## What is separate

| | Separate? | Why |
|---|---|---|
| Directory | **Yes** | Each its own git checkout, at its own commit |
| systemd unit | **Yes** | Restart one without the other |
| `.env` | **Yes** | Different guild, channel, port, path, salt |
| SQLite database | **Yes** | Falls out of separate directories |
| **Discord application** | **Yes** | Two processes cannot share one bot token |
| Callback port + path | **Yes** | `:4000 /lovense/callback` and `:4001 /staging/callback` |
| Lovense developer account | No | One is all you get, and it's enough |
| Cloudflare tunnel | No | One tunnel, two ingress rules |

**The second Discord application is the non-negotiable one.** Two processes
connecting to the gateway with the same bot token fight over the session and
behave erratically. It also gives a useful tell: the staging bot appears in
Discord as a distinct user, so you always know which answered.

---

## Setup

All on the VM as root (`sudo -i`). Roughly twenty minutes.

### 1. A second Discord application

Follow [DEPLOY.md](DEPLOY.md) Parts 1–2 again, with two differences: name it
`Shortwave Staging`, and invite it **only to your test server**.

Collect its `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`, plus the test server's
guild ID and two channel IDs from it (main and command).

### 2. The staging checkout

```bash
git clone https://github.com/<you>/shortwave.git /opt/lovense-bot-staging
cd /opt/lovense-bot-staging
mkdir -p data
chown -R lovensebot:lovensebot /opt/lovense-bot-staging
chmod 750 /opt/lovense-bot-staging
chmod 700 /opt/lovense-bot-staging/data
chmod +x /opt/lovense-bot-staging/deploy/update.sh
```

### 3. The staging `.env`

```bash
cd /opt/lovense-bot-staging
sudo -u lovensebot cp .env.example .env
sudo -u lovensebot nano .env
```

What differs from production:

| Setting | Staging value |
|---|---|
| `DISCORD_TOKEN` | the **staging** app's token |
| `DISCORD_CLIENT_ID` | the staging app's ID |
| `DISCORD_GUILD_ID` | your test server |
| `MAIN_CHANNEL_ID` | e.g. `test-channel` in the test server |
| `COMMAND_CHANNEL_ID` | e.g. `test-bot-commands` in the test server |
| `TARGET_USER_ID` | the person standing in for her in the test server (E) |
| `LOVENSE_TOKEN` | **same as production** — one developer account |
| `USER_TOKEN_SALT` | a fresh `openssl rand -hex 32` |
| `CALLBACK_PORT` | `4001` |
| `CALLBACK_PATH` | `/staging/callback` |
| `LOG_LEVEL` | `debug` is reasonable here |

Then the step that has bitten you twice — ownership, not just mode:

```bash
sudo chown lovensebot:lovensebot .env
sudo chmod 600 .env
sudo -u lovensebot head -1 .env     # must succeed AS lovensebot
```

### 4. Add the staging route to the tunnel

```bash
sudo nano /etc/cloudflared/config.yml
```

Add a rule above the catch-all, matching `deploy/cloudflared-config.example.yml`:

```yaml
  - hostname: lovense.<YOUR-DOMAIN>
    path: ^/staging/callback$
    service: http://127.0.0.1:4001
```

```bash
sudo systemctl restart cloudflared
```

This route stays in place permanently. It only carries traffic when the
Lovense dashboard is pointed at it.

### 5. Install and start the staging service

```bash
cp /opt/lovense-bot-staging/deploy/lovense-bot-staging.service /etc/systemd/system/
systemctl daemon-reload

cd /opt/lovense-bot-staging
sudo -u lovensebot npm ci
sudo -u lovensebot npm run build
sudo -u lovensebot npm run deploy-commands     # registers to the TEST guild
systemctl start lovense-bot-staging
```

Deliberately not `enable`d — staging should be something you start on purpose
rather than something that returns on every reboot. `systemctl enable
lovense-bot-staging` if you'd rather it did.

### 6. Verify

```bash
curl -fsS http://127.0.0.1:4000/healthz     # production
curl -fsS http://127.0.0.1:4001/healthz     # staging
systemctl is-active lovense-bot lovense-bot-staging
```

---

## Switching which instance gets callbacks

One field, in the Lovense dashboard at
<https://www.lovense.com/user/developer/info>:

| Working on | Callback URL |
|---|---|
| Production (normal) | `https://lovense.<YOUR-DOMAIN>/lovense/callback` |
| Staging (testing) | `https://lovense.<YOUR-DOMAIN>/staging/callback` |

Change it, save, and the next heartbeat lands on the other instance. Nothing
to restart.

**When you point it at staging, she needs to re-pair there** — `/connect` in
the test server, scan, done. Her production pairing is untouched and resumes
working the moment you point the URL back.

### Putting it back

This is the one thing to be disciplined about. Make it the last step of any
testing session, the same way you'd put a tool back.

The symptom of forgetting: production `/status` shows ⚪ Unknown or a
heartbeat that keeps getting older, `/tease` refuses the toy, and the log fills
with:

```
Callback for unknown uid <guild>:<user>. If you run a staging instance,
the Lovense callback URL may be pointed at the wrong one.
```

That message exists precisely for this mistake. Check for it with:

```bash
journalctl -u lovense-bot --since "1 hour ago" | grep "unknown uid"
```

---

## The workflow

```bash
# 1. Push a branch from WSL
git switch -c fix/something
# ...edit, npm run check...
git push -u origin HEAD

# 2. Point the Lovense callback URL at /staging/callback

# 3. Deploy the branch to staging only
sudo /opt/lovense-bot-staging/deploy/update.sh --ref origin/fix/something

# 4. Re-pair in the test server, exercise it

# 5. Merge to main, promote to production
sudo /opt/lovense-bot/deploy/update.sh

# 6. Point the callback URL back at /lovense/callback
```

`update.sh` derives its target from its own path, so the copy inside
`/opt/lovense-bot-staging` can only ever touch staging. There's no flag to get
wrong.

See what each is running:

```bash
for d in /opt/lovense-bot /opt/lovense-bot-staging; do
  printf '%-30s %s\n' "$d" "$(sudo -u lovensebot git -C $d log --oneline -1)"
done
```

---

## Gotchas

**Staging needs its own `deploy-commands`.** Slash commands register per
application, per guild. A new command means running it in both.

**One toy, one instance at a time.** A toy pairs with one app session. Use
your test toy with staging and leave hers on production, or accept that
whichever you re-pair is the one that works.

**Memory.** Production is capped at 1 GB, staging at 512 MB. Comfortable on a
2 GB VM while both idle, but `npm ci` during a staging deploy briefly wants
more — don't deploy staging mid-session.

**Staging is not isolated at the Lovense layer.** Both instances use the same
developer token, so a command sent from staging reaches a real toy. That's the
point, but it means "it's only staging" is not a reason to be careless with
intensity values.

---

## If you stop wanting staging

Nothing to undo in the code — production is unaffected by staging's existence.

```bash
systemctl stop lovense-bot-staging
systemctl disable lovense-bot-staging 2>/dev/null
rm /etc/systemd/system/lovense-bot-staging.service
systemctl daemon-reload
rm -rf /opt/lovense-bot-staging
```

Leave the tunnel's `/staging/callback` rule in place or remove it; an ingress
rule pointing at a closed port is harmless. Make sure the Lovense dashboard is
pointed back at `/lovense/callback` before you delete anything.
