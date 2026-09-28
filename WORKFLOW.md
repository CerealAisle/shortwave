# Working on Shortwave

Three places matter, and it helps to be clear about what each one is for:

| | Where | Role |
|---|---|---|
| **Dev** | WSL Debian, `~/shortwave` | Where you edit and run tests. Nothing here is live. |
| **Source of truth** | GitHub, `main` | What CI checks. The only thing production pulls from. |
| **Production** | Ubuntu VM, `/opt/lovense-bot` | Runs the bot. Never edited by hand. |

The rule that keeps this simple: **changes flow one way.** Edit in WSL, push
to GitHub, deploy to the VM. Editing files directly on the VM works right up
until the next deploy silently reverts them.

---

## One-time setup

### 1. Node in WSL

You need it to run the tests locally. Same version as production:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v          # v22.x
```

Then install the project's dependencies:

```bash
cd ~/shortwave
npm ci
npm run check    # typecheck + tests — should pass
```

### 2. VS Code talking to WSL

VS Code runs on Windows but edits files *inside* WSL, which avoids the file
permission and line-ending problems you get from editing `\\wsl$\...` paths
directly.

1. In VS Code on Windows: Extensions (`Ctrl+Shift+X`) → search **WSL** →
   install `ms-vscode-remote.remote-wsl`.
2. From your WSL terminal:

   ```bash
   cd ~/shortwave
   code .
   ```

   The first run installs a small VS Code server into WSL. The bottom-left
   corner should then read **WSL: Debian**.
3. VS Code will offer the extensions in `.vscode/extensions.json` — accept
   them. They install into WSL, not Windows.

Git already works: your name, email and SSH key are configured in WSL, so the
Source Control panel (`Ctrl+Shift+G`) will stage, commit and push without
further setup.

### 3. Make the VM a git checkout

Right now `/opt/lovense-bot` holds files you copied from a tarball. Converting
it to a checkout is what makes `deploy/update.sh` work. Run once on the VM:

```bash
cd /opt/lovense-bot
sudo -u lovensebot git init -b main
sudo -u lovensebot git remote add origin https://github.com/<you>/shortwave.git
sudo -u lovensebot git fetch origin
sudo -u lovensebot git checkout --detach origin/main --force
```

Use the **HTTPS** URL, not SSH. The repo is public, so the VM can pull
anonymously and needs no key of its own. (If you make the repo private later,
add a read-only [deploy key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)
and switch the remote to SSH.)

`.env`, `data/` and `node_modules/` are gitignored, so the checkout leaves
them alone — verified, not assumed. Confirm afterwards:

```bash
sudo -u lovensebot head -1 /opt/lovense-bot/.env    # still your real config
sudo -u lovensebot git log --oneline -1             # now tracking main
```

Finally, make the deploy script executable:

```bash
sudo chmod +x /opt/lovense-bot/deploy/update.sh
```

---

## Which user to use on the VM

Short answer: **root**, via `sudo -i`. That's what you've been doing and it's
correct.

`/opt/lovense-bot` is mode `750` owned by `lovensebot`, so your own account
can't `cd` into it. That's deliberate — the bot's files and its `.env` belong
to the service account, not to you. Admin work (systemctl, editing `.env`,
running the deploy script) needs root anyway.

The one rule that matters: **never run `git` as root inside that directory.**
Git refuses to operate on a repository owned by someone else and fails with
`detected dubious ownership`. Always drop to the owner:

```bash
sudo -u lovensebot git -C /opt/lovense-bot status
sudo -u lovensebot git -C /opt/lovense-bot log --oneline -5
```

`deploy/update.sh` does this internally for every git call, so running it with
`sudo` is right.

If you'd like to browse the directory as yourself, add your account to the
group. You get read access to the tracked files; `.env` stays `600` so it
remains owner-only, and you still can't write:

```bash
sudo usermod -aG lovensebot $USER    # log out and back in
```

What you should *not* do is `git config --global --add safe.directory`, which
git suggests in its error message. That silences the guard rather than fixing
the cause, and the cause here is simply running git as the wrong user.

---

## The loop

### Small, low-risk change (docs, a config default, a message string)

```bash
cd ~/shortwave
git pull                     # start from current main
# ...edit...
npm run check                # typecheck + tests
git add -A
git commit -m "Shorten the pause notice"
git push
```

Watch CI go green on GitHub, then deploy.

### Anything touching trigger, session or Lovense logic

Use a branch, so CI verifies it *before* it can reach `main` — and therefore
before it can reach production.

```bash
git switch -c fix/heartbeat-window
# ...edit...
npm run check
git commit -am "Widen the heartbeat window for iOS"
git push -u origin HEAD
```

Then open a pull request on GitHub, wait for the green check, and merge. Back
on your machine:

```bash
git switch main && git pull
git branch -d fix/heartbeat-window
```

The line between the two is: *if this broke, would a session misbehave?* If
yes, branch.

### Deploy

Running a staging instance too? Deploy the branch there first — see
[STAGING.md](STAGING.md).

On the VM:

```bash
sudo /opt/lovense-bot/deploy/update.sh
```

It fetches, shows you which commits are about to land, warns that restarting
disarms any running session, installs, builds, **runs the tests**, and only
then restarts. If the build or tests fail it stops without touching the
running bot.

Useful flags:

```bash
sudo deploy/update.sh --yes          # no confirmation prompt
sudo deploy/update.sh --ref v1.3.0   # deploy a tag instead of main
```

Afterwards the bot is **disarmed** — restarts always are. Run `/on` again.

### Roll back

The script prints the previous commit when it finishes. To go back:

```bash
sudo /opt/lovense-bot/deploy/update.sh --ref <that-sha> --yes
```

Because that path runs the same install-build-test sequence, a rollback is as
safe as a deploy.

---

## Common tasks

**Adding a slash command.** Copy `src/discord/commands/buzz.ts`, edit, then:

```bash
npm run check
git commit -am "Add /wave"
git push
# on the VM, after deploying:
cd /opt/lovense-bot && sudo -u lovensebot npm run deploy-commands
```

New or renamed commands need `deploy-commands` — the deploy script doesn't run
it, because re-registering commands is a Discord API write and shouldn't
happen on every routine deploy.

**Changing a setting.** `.env` lives only on the VM and is never in git. Edit
it there and restart:

```bash
sudo -u lovensebot nano /opt/lovense-bot/.env
sudo systemctl restart lovense-bot
```

If it's a setting worth having a sensible default for, also update
`.env.example` and the table in README.md, and commit that.

**Bumping the version.** Don't hand-edit `package.json`:

```bash
npm version patch     # or minor / major
git push --follow-tags
```

That updates `package.json` and `package-lock.json` together and tags the
commit, so the two files can't drift apart.

**Updating dependencies.**

```bash
npm outdated
npm update            # within the existing semver ranges
npm run check
git commit -am "Update dependencies"
```

Do this in WSL, never on the VM — the VM installs from the committed lockfile.

---

## Checking on production

```bash
systemctl status lovense-bot
journalctl -u lovense-bot -f
journalctl -u lovense-bot -p warning --since today

# What commit is actually running?
sudo -u lovensebot git -C /opt/lovense-bot log --oneline -1

# What has the bot been sending?
sudo sqlite3 /opt/lovense-bot/data/bot.db \
  'SELECT datetime(created_at/1000,"unixepoch","localtime"), description, source, ok, error
     FROM command_log ORDER BY id DESC LIMIT 20;'
```

---

## Things that will bite you eventually

**Editing on the VM.** It works until the next deploy overwrites it. If you
fix something live because it's urgent, make the same change in WSL and push
it the same day, or you will lose it and not notice.

**Forgetting `deploy-commands`.** The bot restarts fine, the new command
exists in the code, and Discord simply doesn't show it. Nothing errors.

**Deploying mid-session.** The restart disarms. The script prompts, but
`--yes` skips the prompt, so don't make `--yes` a habit.

**A green CI and a broken bot.** The tests cover pure logic and state
machines; they do not talk to Discord or Lovense. CI passing means you didn't
break the maths, not that the bot connects. The test server is what checks
that — see [TESTING.md](TESTING.md).
