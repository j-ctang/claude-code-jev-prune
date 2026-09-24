# Jev Prune for Claude Code

Jev Prune keeps long Claude Code sessions sharp. It removes old tool results (big file reads, long terminal output) that no longer matter to what you are doing now. Your chat history in the terminal stays the same; only the context sent to Claude gets smaller.

It runs on your machine as a small proxy between Claude Code and Anthropic.

## Install

You need Node.js 20+, [Claude Code](https://docs.claude.com/en/docs/claude-code), and a TypeSafe API key.

```bash
git clone https://github.com/j-ctang/claude-code-jev-prune
cd claude-code-jev-prune
npm link
```

`npm link` adds a `jev-prune` command you can run from any folder. To skip it, run `./jev-prune` from this folder instead.

## Use

Use `jev-prune` wherever you used `claude`:

```bash
cd ~/my-project
jev-prune
```

The first run asks for your TypeSafe key, then opens Claude Code. After that it opens Claude Code right away.

Claude Code options work the same way:

```bash
jev-prune --continue
jev-prune --resume
jev-prune ~/other-project
```

You can run it in several terminals at once. The proxy stops when the last one closes, and restarts itself if it crashes. When a session ends, Jev Prune prints how much it pruned.

Other commands:

```bash
jev-prune --stats    # how much stale context has been pruned so far
jev-prune --doctor   # check the install and explain any problem
jev-prune --update   # download the latest version
jev-prune --setup    # answer the setup questions again
```

## What happens during a session

- **Automatic:** When the context reaches about 120K tokens, Jev Prune removes stale tool results the next time you send a prompt. It never prunes while Claude is in the middle of a task.
- **Manual:** Type `/jev-prune` to prune now.
- Recent tool results and all normal conversation text are kept.
- If TypeSafe is slow or down, your request goes through unchanged.
- MCP tools still load on demand. Claude Code normally turns this off behind a proxy; `jev-prune` turns it back on (`ENABLE_TOOL_SEARCH=true`) and never prunes the results that load tools.

## Canary (optional)

If your `CLAUDE.md` tells Claude to start every reply with a fixed word, setup can use it as a canary. When Claude stops using it, Jev Prune suggests `/jev-prune`. Type `/jev-prune-auto` to prune on those misses automatically, or `/jev-prune-auto-off` to go back to suggestions.

## Settings

Settings are in `.env` in this folder. The useful ones:

| Setting | Default | What it does |
| --- | --- | --- |
| `JEV_PRUNE_THRESHOLD` | `120000` | Context size that starts automatic pruning |
| `JEV_PRUNE_KEEP_RECENT` | `5` | Newest tool results that are never pruned |
| `JEV_PRUNE_ENABLED` | `true` | `false` passes everything through untouched |
| `PORT` | `5590` | Local port for the proxy |

All settings are listed in [.env.example](./.env.example).

## Troubleshooting

Run `jev-prune --doctor` first. It checks Node.js, Claude Code, your key, TypeSafe, the port, and settings that bypass the proxy.

- **Logs:** `~/.claude/jev-prune.log`
- **"Port 5590 is used by another program":** set a different `PORT` in `.env`.
- **"`claude` was not found":** install Claude Code and check that `claude` runs in your terminal.
- **Skip Jev Prune for a session:** run `claude` as usual.
- **Using a custom `ANTHROPIC_BASE_URL`:** Jev Prune sends traffic on to it instead of the Anthropic API. If it is set in `~/.claude/settings.json`, Claude Code skips the proxy; move it to `ANTHROPIC_UPSTREAM_URL` in `.env`.
- **Bedrock or Vertex:** not supported. Claude Code skips the proxy when `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX` is set.
- **"Jev Prune was updated":** close all `jev-prune` sessions so the proxy restarts on the new version.

## Uninstall

```bash
npm unlink -g claude-code-jev-prune
rm -rf ~/.claude/commands/jev-prune*.md ~/.claude/jev-prune*
```

Then delete this folder.

## More

How pruning decides what to remove: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md). Run `npm run check` to lint, build, and test.

## License

MIT
