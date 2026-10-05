# Patterns

Each `.json` file in this folder is one pattern for `/pattern`. The filename
is its name: `slow-build.json` is played with `/pattern name:slow-build`.

## Adding one

1. Copy `_template.json` to a new file, for example `my-pattern.json`.
   Names are lowercase letters, digits, `-` and `_`, up to 32 characters.
2. Edit the values (below).
3. Run `npm test`. It checks every file in this folder, so a mistake shows
   up here rather than as an error in Discord.
4. Commit, push and deploy as usual. No restart or `deploy-commands` is
   needed — the bot reads this folder each time `/pattern` runs, and the new
   name appears in the command's suggestions straight away.

Files starting with `_`, like the template, are ignored.

## The fields

```json
{
  "description": "One line shown in the /pattern menu",
  "intervalMs": 500,
  "steps": [20, 40, 60, 80, 60, 40],
  "durationSec": 20
}
```

| Field | Required | Meaning |
|---|---|---|
| `steps` | yes | Strength of each step as a percentage, `0`–`100`. Up to 50 steps. `0` is a pause. |
| `intervalMs` | yes | How long each step lasts, in milliseconds. At least `100`. |
| `durationSec` | no | How long the whole pattern plays. The steps **loop** until this runs out. Leave it out to play the steps once. At most `3600`. |
| `description` | no | Shown next to the name in Discord's suggestions. Up to 80 characters. |

`/pattern name:<name> minutes:<n>` overrides `durationSec` for one play, up
to 60 minutes — the steps loop for that long. That's the way to run a short
pattern continuously.

So the template plays six half-second steps — three seconds per loop — over
and over for 20 seconds.

## Things worth knowing

- **`MAX_INTENSITY_PERCENT` still applies.** A step of `100` is capped like
  any other command.
- **`/stop` ends a pattern at once**, whoever started it.
- A pattern replaces whatever was already running on the toy, including a
  tease buzz in progress.
- It plays on all of the target's toys.
