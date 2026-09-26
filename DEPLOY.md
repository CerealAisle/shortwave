# Shortwave — deployment walkthrough

Follow this top to bottom. Every command is copy-pasteable. Where you need to
substitute a value it looks like `<THIS>`.

**Target host:** Ubuntu Server 24.04 LTS (amd64) in a Hyper-V VM on an
always-on Windows machine. Deploying to a Raspberry Pi instead? Everything
here applies except Part 4 and Part 5 — see [DEPLOY-PI.md](DEPLOY-PI.md) for
those two.

**Already built the VM and can log in?** Skip to [Part 5](#part-5--provision-the-host).

Keep a scratch file open. You'll collect eight values along the way and enter
them into `.env` in Part 7.

| # | Value | From |
|---|---|---|
| 1 | `DISCORD_TOKEN` | Part 1 |
| 2 | `DISCORD_CLIENT_ID` | Part 1 |
| 3 | `DISCORD_GUILD_ID` | Part 2 |
| 4 | `TRIGGER_CHANNEL_ID` | Part 2 |
| 5 | `LOVENSE_TOKEN` | Part 3 |
| 6 | VM IP address | Part 4 |
| 7 | tunnel hostname | Part 6 |
| 8 | `USER_TOKEN_SALT` | Part 7 |

---

## Part 1 — Create the Discord application

1. Go to <https://discord.com/developers/applications> → **New Application**.
   Name it `Shortwave`. Accept the terms, click **Create**.

2. On **General Information**, copy **Application ID**.
   → save as `DISCORD_CLIENT_ID`

3. Click **Bot** in the left sidebar.
   - Click **Reset Token** → **Yes, do it** → **Copy**.
     → save as `DISCORD_TOKEN`. *It is shown exactly once.*
   - Scroll to **Authorization Flow** and turn **Public Bot** **off**.
   - Leave all three **Privileged Gateway Intents** **off**. The bot reacts to
     the fact a message was sent, not its text, so it needs none of them.
   - Click **Save Changes**.

4. Click **OAuth2** → **URL Generator**.
   - **Scopes:** check `bot` and `applications.commands`
   - **Bot Permissions:** check `View Channels`, `Send Messages`, `Embed Links`
   - Copy the **Generated URL** at the bottom.

5. Paste that URL into a browser, pick your private server, **Authorize**.

---

## Part 2 — Get your Discord IDs

1. In the Discord app: **User Settings** (gear, bottom-left) → **Advanced** →
   turn on **Developer Mode**.

2. Right-click your server icon → **Copy Server ID**.
   → save as `DISCORD_GUILD_ID`

3. Decide which channel triggers buzzes. Right-click it → **Copy Channel ID**.
   → save as `TRIGGER_CHANNEL_ID`

---

## Part 3 — Configure the Lovense dashboard

Once your developer application is approved, this is just settings.

1. Go to <https://www.lovense.com/user/developer/info> and sign in.

2. Copy your **Developer Token**.
   → save as `LOVENSE_TOKEN`

3. Leave this tab open. You'll come back in Part 6 to set the callback URL,
   once your tunnel hostname exists.

4. Find the **heartbeat** setting and **enable it**. This is not optional for
   long sessions: heartbeats are the only way the bot can tell that a phone
   has gone to sleep mid-session. Note the interval — if it's configurable,
   60 seconds is a good choice.

---

## Part 4 — Build the Ubuntu VM

Skip this part if your VM already exists and you can SSH into it.

### 4.1 Configure Windows so the host stays up

Do this first. It's the part that actually decides whether long sessions
survive — if the host sleeps, the VM is suspended and the bot dies mid-session.

In an **admin** PowerShell:

```powershell
# Never sleep, never hibernate, on AC power
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

# Confirm
powercfg /query SCHEME_CURRENT SUB_SLEEP
```

Turning off the display is fine — that doesn't suspend anything.

Also, in **Settings → Windows Update → Advanced options**:
- set **Active hours** to cover the times you'd actually use this
- turn **Restart this device as soon as possible…** **off**

Windows Update reboots are the main cause of unplanned downtime here. The VM
comes back automatically (4.4), but not mid-session.

### 4.2 Create the VM

Enable Hyper-V if you haven't (admin PowerShell, reboots afterwards):

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All
```

**Which OS.** Ubuntu Server 24.04 LTS — supported to April 2029, and
NodeSource has shipped packages for it for years. Ubuntu 26.04 LTS works too;
the only thing to check is that NodeSource publishes for it yet (if
`setup_22.x` complains about an unsupported distribution, that's what
happened, and the provisioning script's tarball path is the fallback). Debian
13 is equally fine and marginally leaner. All are apt + systemd and the
provisioning script treats them identically.

Download: <https://ubuntu.com/download/server>

**Use a VM of its own**, not one already running something else. `.env` holds
a Lovense token that can command the toy and a Discord bot token, so it
shouldn't share a host with an internet-exposed service like a game server.
A second VM also means restarts and OOM kills on the other service can't
interrupt a session. The cost is 2 GB of RAM and 20 GB of disk.

**Generation 2**, always: UEFI boot, SCSI boot disk, no legacy emulation.
Gen 1 is only for 32-bit guests and very old distros.

Create it — adjust the paths, and quote `$vm` everywhere if your VM name has
spaces in it:

```powershell
$vm   = "shortwave"
$vhd  = "C:\Hyper-V\shortwave\shortwave.vhdx"
$iso  = "C:\Users\<YOU>\Downloads\ubuntu-24.04.4-live-server-amd64.iso"

New-VM -Name $vm -Generation 2 -MemoryStartupBytes 2GB `
       -NewVHDPath $vhd -NewVHDSizeBytes 20GB

# 2 vCPUs is plenty; the bot is idle almost all the time
Set-VMProcessor -VMName $vm -Count 2

# Fixed memory. Dynamic memory plus a long-lived Node process is a needless
# source of odd behaviour, and you are not short on RAM.
Set-VMMemory -VMName $vm -DynamicMemoryEnabled $false -StartupBytes 2GB

Add-VMDvdDrive -VMName $vm -Path $iso

# REQUIRED. The Linux bootloader is signed by Microsoft's UEFI CA, which a
# Gen-2 VM does not trust under the default template. Without this the VM
# fails to boot in a way that looks like a corrupt ISO.
Set-VMFirmware -VMName $vm -SecureBootTemplate MicrosoftUEFICertificateAuthority

# Boot from the DVD for the install
$dvd = Get-VMDvdDrive -VMName $vm
Set-VMFirmware -VMName $vm -FirstBootDevice $dvd
```

Firmware and memory changes are rejected on a running VM, so do all of this
before the first boot.

**Networking.** Gen 2 has exactly one adapter type, the synthetic one, and
Ubuntu has the `hv_netvsc` driver built in — nothing to choose. The only
decision is which virtual switch:

*External switch (preferred, if the PC is on Ethernet).* The VM gets an
address from your router, so you can SSH to it directly and pin it with a
DHCP reservation.

```powershell
Get-NetAdapter | Where-Object Status -eq 'Up'   # find your wired adapter
New-VMSwitch -Name "LAN" -NetAdapterName "<ADAPTER NAME>" -AllowManagementOS $true
Connect-VMNetworkAdapter -VMName $vm -SwitchName "LAN"
```

*Default Switch.* NAT, works everywhere including Wi-Fi, no setup. The VM's IP
can change across host reboots, so you'd administer it through the Hyper-V
console rather than SSH. Functionally the bot doesn't care: the Discord
gateway connection and the Cloudflare tunnel are both outbound-only, so
nothing needs an inbound route.

```powershell
Connect-VMNetworkAdapter -VMName $vm -SwitchName "Default Switch"
```

### 4.3 Install Ubuntu

```powershell
Start-VM -Name $vm
vmconnect.exe localhost $vm
```

Walk the installer. Four things matter:

**Storage — the one place to slow down.** The guided install defaults to LVM
and then allocates only ~10 GB to the root volume regardless of disk size,
leaving the rest of the volume group unused. Watch the summary screen: if `/`
reads 10.000G while `ubuntu-vg` shows free space, that's the trap. Either
untick **Set up this disk as an LVM group**, or edit `ubuntu-lv` and raise its
size to the full volume group. To fix it after install instead:

```bash
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
df -h /
```

**Profile.** The hostname (`shortwave` is what the rest of this guide assumes)
is separate from the Hyper-V VM name — that name is only a label in Hyper-V
Manager. The username here is *your* admin account, not the bot's; the bot
gets its own `lovensebot` system user in Part 5, so don't name this one
`lovensebot`. On Ubuntu this account lands in the `sudo` group automatically.

**Install OpenSSH server: yes.** Import your GitHub SSH keys here if you want
key auth; a strong password is fine too.

**Featured server snaps: select none.** Not Docker, not anything. And choose
the normal Ubuntu Server, not "minimized" — minimized strips tooling you'll
want when debugging.

When it finishes, remove the ISO and boot from disk:

```powershell
Set-VMDvdDrive -VMName $vm -Path $null
$hd = Get-VMHardDiskDrive -VMName $vm
Set-VMFirmware -VMName $vm -FirstBootDevice $hd
```

**On disk encryption:** don't. LUKS prompts for a passphrase at boot, before
the network comes up, so after a Windows Update reboot the VM would sit at
that prompt until you noticed — exactly the failure mode 4.4 exists to
prevent. Use BitLocker on the Windows host instead; it covers the `.vhdx`,
unlocks from the TPM, and the guest never knows.

### 4.4 Make the VM start itself

```powershell
# Start with the host, and come back after an unexpected host shutdown
Set-VM -Name $vm -AutomaticStartAction Start -AutomaticStartDelay 20

# Shut down cleanly rather than freezing. This is what lets the bot's SIGTERM
# handler stop the toy before the process exits.
Set-VM -Name $vm -AutomaticStopAction ShutDown
```

`AutomaticStopAction ShutDown` matters more than it looks. The Hyper-V default
is `Save`, which freezes the VM mid-flight on a host reboot — systemd never
gets to send SIGTERM, so a running session never receives its Stop command.

Verify the whole configuration before moving on:

```powershell
Get-VM -Name $vm | Format-List Name, Generation, ProcessorCount, `
  DynamicMemoryEnabled, AutomaticStartAction, AutomaticStopAction
Get-VMFirmware -VMName $vm | Select-Object SecureBoot, SecureBootTemplate
```

Then reboot Windows once and confirm the VM comes back on its own.

### 4.5 Find the VM's address

In the VM console:

```bash
hostname -I
```

Or from Windows, without touching the console:

```powershell
Get-VMNetworkAdapter -VMName $vm | Select-Object -ExpandProperty IPAddresses
```

→ save as your **VM IP**

A `172.x.x.x` address means the Default Switch, and it can change across host
reboots. An address on your LAN range means the external switch — add a DHCP
reservation for that MAC in your router now, so it stops moving.

`shortwave.local` won't resolve yet; Ubuntu Server doesn't ship avahi. If you
want the hostname instead of a bare IP:

```bash
sudo apt install -y avahi-daemon
```

Confirm SSH works from your workstation before continuing:

```bash
ssh <YOUR_USER>@<VM-IP>
```

---

## Part 5 — Provision the host

### 5.1 Copy the project across

From WSL or any shell on your workstation, where you unpacked `shortwave.tar.gz`:

```bash
scp shortwave.tar.gz <YOUR_USER>@<VM-IP>:/tmp/
```

Then on the VM:

```bash
tar xzf /tmp/shortwave.tar.gz -C /tmp
sudo mkdir -p /opt/lovense-bot
sudo cp -r /tmp/shortwave/. /opt/lovense-bot/
sudo chmod +x /opt/lovense-bot/deploy/setup-host.sh
```

If you're working from a git clone instead, use rsync and skip the build
artifacts — copying `node_modules` across is actively harmful, since native
modules built elsewhere won't run here:

```bash
rsync -av --exclude node_modules --exclude dist --exclude .env \
  ./ <YOUR_USER>@<VM-IP>:/tmp/shortwave/
```

Either way, `chmod +x` the script: files that cross from NTFS lose the
executable bit.

### 5.2 Run the provisioning script

```bash
sudo apt update && sudo apt full-upgrade -y
less /opt/lovense-bot/deploy/setup-host.sh     # read it before running as root
sudo /opt/lovense-bot/deploy/setup-host.sh
```

Two to three minutes on a VM. It:

- installs Node 22 from NodeSource (amd64), plus git and sqlite3
- creates the `lovensebot` system user — no password, no login shell
- creates `/opt/lovense-bot` with a `700` data directory
- enables unattended security updates but **disables automatic reboots**,
  since Ubuntu would otherwise reboot itself once a patch asks for it and end
  a session with no warning
- skips the swap tuning, which only applies to low-memory Pi hosts

Confirm:

```bash
dpkg --print-architecture   # amd64
node -v                     # v22.x
ls -l /usr/local/bin/node   # the stable symlink the service uses
id lovensebot
```

The systemd unit runs `/usr/local/bin/node`. If that symlink is missing the
service won't start.

Since automatic reboots are off, check for pending ones yourself now and then:

```bash
ls /var/run/reboot-required
```

---

## Part 6 — Expose the callback URL

Lovense needs to POST toy status to the bot. A Cloudflare Tunnel makes an
outbound connection, so nothing on your network is exposed and you get HTTPS
without forwarding a port.

You need a domain on Cloudflare. If you don't have one, skip to
[6B](#6b--quick-tunnel-testing-only).

### 6A — Named tunnel (recommended)

On the VM:

```bash
curl -fsSLo cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
cloudflared --version

cloudflared tunnel login
```

That prints a URL. Open it in a browser, pick your domain, authorize. Then:

```bash
cloudflared tunnel create shortwave
```

Note the **tunnel UUID** it prints, then route a hostname to it:

```bash
cloudflared tunnel route dns shortwave lovense.<YOUR-DOMAIN>
```

→ save `https://lovense.<YOUR-DOMAIN>` as your **tunnel hostname**

Put the credentials and config where the root-run service will find them:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<TUNNEL-UUID>.json /etc/cloudflared/
sudo cp /opt/lovense-bot/deploy/cloudflared-config.example.yml /etc/cloudflared/config.yml
sudo nano /etc/cloudflared/config.yml    # set <TUNNEL-UUID> and the hostname
```

The example config exposes only `/lovense/callback` and `/healthz`, and 404s
everything else. Don't widen that to a catch-all `service:`. Then:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
systemctl status cloudflared --no-pager
```

### 6B — Quick tunnel (testing only)

```bash
cloudflared tunnel --url http://localhost:4000
```

Prints a random `*.trycloudflare.com` hostname, no account needed. The
hostname changes on every restart and you'd have to update the Lovense
dashboard each time — fine for one end-to-end test, not for real use.

### 6C — Set the callback URL

Back in the Lovense dashboard tab from Part 3, set **Callback URL** to:

```
https://lovense.<YOUR-DOMAIN>/lovense/callback
```

Save. Confirm heartbeat is still enabled while you're there.

---

## Part 7 — Install and start the bot

Generate the salt and keep the output:

```bash
openssl rand -hex 32
```

→ save as `USER_TOKEN_SALT`

Hand the project to the bot user and write the config:

```bash
cd /opt/lovense-bot
sudo chown -R lovensebot:lovensebot /opt/lovense-bot
sudo -u lovensebot cp .env.example .env
sudo -u lovensebot nano .env
```

**A note on that directory.** It's mode `750` owned by `lovensebot`, so your
own account can't `cd` into it — that's deliberate. Work as root for this
part (`sudo -i`, then `cd /opt/lovense-bot`) and use `sudo -u lovensebot` for
the commands that write files, so everything stays owned by the bot user.

If you'd rather browse it as yourself, add your account to the group. You'll
get read access, not write — `.env` stays `600`, owner-only:

```bash
sudo usermod -aG lovensebot $USER     # log out and back in to take effect
```

Fill in the six credentials you collected. Everything below them is already
tuned for long iOS sessions — leave it alone until Part 10.

No quoting is needed around the values — `DISCORD_TOKEN=abc123` is correct,
not `DISCORD_TOKEN="abc123"`. Quote only if a value contains a `#`, which
would otherwise start a comment. None of these credentials do.

Then lock it down, because it now holds two API tokens:

```bash
sudo chown lovensebot:lovensebot .env
sudo chmod 600 .env
ls -l .env      # want: -rw------- 1 lovensebot lovensebot
```

**That `chown` matters.** Mode `600` means *owner only*, so if you created or
edited `.env` as root, the bot cannot read it — and `dotenv` fails silently,
so every credential reports as "Required" and it looks like the file is
malformed rather than unreadable. Confirm the bot can actually read it:

```bash
sudo -u lovensebot head -1 .env
```

Build. Use `npm install` here, not `npm ci`: the project ships without a
`package-lock.json`, and `npm ci` requires one. This first install resolves
the dependency tree and writes that lockfile. On amd64 `better-sqlite3` has
prebuilds, so it takes well under a minute and compiles nothing.

**Run these from `/opt/lovense-bot`, not from a home directory.** `sudo`
keeps the current working directory, so if you launch npm from `~` or
`/root` — which `lovensebot` has no permission to read — npm can't locate
the project and dies with a confusing `ERR_INVALID_ARG_TYPE ... Received
null`. The `cd` is part of the command, not scene-setting:

```bash
cd /opt/lovense-bot
sudo -u lovensebot npm install
sudo -u lovensebot npm run build
sudo -u lovensebot npm run deploy-commands
```

That last command should print `Registered 7 commands to guild ...`. If it
errors, `DISCORD_TOKEN` or `DISCORD_CLIENT_ID` is wrong.

**Keep the lockfile.** `npm install` just created
`/opt/lovense-bot/package-lock.json`, pinning every transitive dependency to
an exact version. Copy it back into your repo and commit it:

```bash
sudo cp /opt/lovense-bot/package-lock.json ~/package-lock.json
sudo chown $USER ~/package-lock.json
```

From then on use `npm ci` everywhere — it installs exactly what the lockfile
says, so a rebuild months from now gets the same tree rather than whatever
has since been published.

Install the service:

```bash
sudo cp deploy/lovense-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lovense-bot
journalctl -u lovense-bot -f
```

You want five lines: `Database ready`, `Callback server listening`,
`Presence monitor running`, `Message trigger active`, and `Logged in as
Shortwave#...`. `Ctrl-C` stops following the log; the service keeps running.

Verify the tunnel reaches the bot, from any machine:

```bash
curl https://lovense.<YOUR-DOMAIN>/healthz
# {"ok":true,"at":"..."}
```

If that returns anything else, stop and fix it — QR pairing will not work
until it does.

---

## Part 8 — Set up her iPhone

This decides whether multi-hour sessions actually work. iOS is far more
aggressive about suspending background apps than anything on the server side.

1. Install **Lovense Remote** from the App Store. Pair the toy over Bluetooth
   and confirm manual control works in the app.

2. **Settings → General → Background App Refresh** → the top-level toggle
   **on** (Wi-Fi & Cellular Data), and **Lovense Remote** **on** in the list.

3. **Settings → Battery → Low Power Mode** → **off**. It throttles background
   refresh and will end sessions early.

4. **Settings → Notifications → Lovense Remote** → **Allow Notifications on**.
   Lovense likely relies on push to wake a suspended app, so blocking
   notifications can block the wake path.

5. **Settings → Screen Time → App Limits** → no limit covering Lovense Remote;
   add it to **Always Allowed**.

6. **Never swipe the app closed.** This is the big one. Force-quitting an iOS
   app from the app switcher stops it being woken in the background until it's
   manually reopened, and no amount of configuration overrides that.
   Backgrounding it normally (home gesture) is fine; swiping it away is not.

   The exception is recovery: once the bot reports the toy offline, a
   force-quit and reopen is exactly what's needed. Reopening from the
   background restores the app's own controls without re-registering it with
   Lovense's servers, so the bot still can't reach it. Cold launch, always.

7. Keep the phone on a charger for long sessions. Holding a BLE link plus a
   network path for hours is not cheap.

8. **For a long session, consider Guided Access** (Settings → Accessibility →
   Guided Access). Triple-click the side button with Lovense Remote open and
   iOS pins it in the foreground, which is the most reliable state there is.
   Overkill for a short session, worth it for hours.

9. **Let the bot's DMs through.** When the toy drops, the bot sends her a
   direct message telling her to force-quit and reopen Lovense Remote — that
   is the recovery path, and iOS offers no way to automate it. For the
   notification to actually arrive: Discord must be allowed to notify (iOS
   Settings → Notifications → Discord), the DM conversation must not be muted,
   and Discord should be in the allow list of any Focus mode she uses. In
   Discord, opening the bot's DM and setting notifications to **All Messages**
   is worth doing once.

   Set `DM_ON_DISCONNECT=false` in `.env` if you would rather have only the
   channel message.

**Reliability, most to least:** app in the foreground with the screen locked →
app backgrounded while using light apps → app backgrounded while playing a
demanding game. That last case risks eviction under memory pressure, which
looks identical to a dead session.

---

## Part 9 — First run

In your Discord server, in the trigger channel:

1. `/status` → should say no toys are linked.

2. She runs `/connect`. She gets an ephemeral QR code (only she can see it).
   In Lovense Remote: **Me → Scan QR code**, scan, confirm.

   Within a few seconds the channel should show *"… connected successfully
   (…)"*. If nothing appears the callback isn't arriving — check
   `journalctl -u lovense-bot -n 50` and `curl https://.../healthz`.

3. `/status` again, then once more after 2–3 minutes. The presence line should
   go from ⚪ Unknown to 🟢 **Online** once the second heartbeat lands. If it's
   still ⚪ after five minutes, heartbeat isn't enabled in the Lovense
   dashboard — back to Part 3, step 4.

4. `/buzz intensity:30 seconds:2` — confirms the outbound command path.

5. She runs `/on`. You post in the trigger channel. She should feel a buzz
   within a second or so. She runs `/off`.

6. Test the safeword: she runs `/on`, then **you** run `/stop`. Everything
   should halt immediately.

---

## Part 10 — The long-session shakedown

Before relying on this, run one deliberately boring test:

```bash
sudo -u lovensebot sed -i 's/^LOG_LEVEL=.*/LOG_LEVEL=debug/' /opt/lovense-bot/.env
sudo systemctl restart lovense-bot
```

She arms a session with `/on timeout:480` and then uses her phone completely
normally for a few hours. Meanwhile:

```bash
journalctl -u lovense-bot -f | grep -E "heartbeat|Presence|suspend|resume"
```

What you're measuring is the real gap between heartbeats on *her* phone and
iOS version — the one number none of this can predict for you.

- **Gaps comfortably under 300s** → defaults are right, you're done.
- **Regular gaps over 300s**, with the session pausing and resuming → raise
  `HEARTBEAT_TIMEOUT_SEC` to roughly 3× the largest normal gap.
- **Frequent pause/resume cycles** → raise `OFFLINE_GRACE_SEC` so brief
  dropouts never reach the grace deadline.

Set `LOG_LEVEL=info` again afterwards; debug logging over many hours fills the
journal.

Review what actually happened:

```bash
sudo sqlite3 /opt/lovense-bot/data/bot.db \
  'SELECT datetime(created_at/1000,"unixepoch","localtime") AS t, description, source, ok, error
     FROM command_log ORDER BY id DESC LIMIT 40;'
```

The `source` column separates a first-attempt send from `:retry1` / `:retry2`,
so you can see how often iOS needed a nudge to wake up.

---

## Everyday operations

```bash
sudo systemctl restart lovense-bot        # after a config change
sudo systemctl stop lovense-bot           # stops toys first, then exits
journalctl -u lovense-bot -f              # follow logs
journalctl -u lovense-bot -p warning --since today
```

After editing `.env`, restart. After adding or changing a command, run
`npm run build && npm run deploy-commands`, then restart.

Updating the code:

```bash
cd /opt/lovense-bot
sudo -u lovensebot git pull
sudo -u lovensebot npm ci      # npm install, if no package-lock.json yet
sudo -u lovensebot npm run build
sudo systemctl restart lovense-bot
```

A restart always comes back **disarmed**. That's deliberate, not a bug.

### Snapshots

The one real advantage of the VM over bare metal:

```powershell
Checkpoint-VM -Name $vm -SnapshotName "working-baseline"
```

Take one once the bot is confirmed working, and again before any upgrade.
Don't leave checkpoints around permanently — they grow.

### If sessions end at suspiciously consistent times

Check whether Windows is sleeping despite Part 4.1:

```powershell
powercfg /requests        # what is keeping the machine awake
powercfg /sleepstudy      # writes an HTML report
```

### Developing in WSL

WSL is a good place to edit and typecheck, and a poor place to host — it shuts
down when its last process exits and doesn't start on boot. Build there, push
or rsync into the VM, and run `npm ci` there: native modules must be built on
the machine that runs them, even though both are amd64.

```bash
npm ci && npm run typecheck   # npm install, if no package-lock.json yet
rsync -av --exclude node_modules --exclude dist --exclude .env \
  ./ <YOUR_USER>@<VM-IP>:/tmp/shortwave/
```

Do let `package-lock.json` rsync across — it's the point of having one.

If you push to a git remote, check `git status` before the first commit and
confirm `.env` isn't staged. It's in `.gitignore`, but it holds both tokens.
