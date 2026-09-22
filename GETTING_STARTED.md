# Getting Started with claude-code-jev-prune

## Quick Start (5 minutes)

### 1. Get a Jev API Key

Visit [TypeSafe AI](https://typesafe.ai) and get an API key. It's free to start.

### 2. Clone & Install

```bash
git clone https://github.com/j-ctang/claude-code-jev-prune
cd claude-code-jev-prune
npm install
```

### 3. Configure

```bash
# Copy example env file
cp .env.example .env

# Edit with your Jev API key
nano .env
# Or on macOS:
# open .env
```

Your `.env` should look like:
```
TYPESAFE_API_KEY=sk-typesafe-abc123def456
JEV_PRUNE_ENABLED=true
PORT=5590
```

### 4. Build & Run

```bash
# Build TypeScript
npm run build

# Start the proxy
npm start
```

You should see:
```
[info]: jev-prune proxy listening on port 5590
[info]: Claude Code: export ANTHROPIC_BASE_URL=http://localhost:5590
[info]: Jev pruning: enabled
```

### 5. Point Claude Code to the Proxy

In a **separate terminal**:

```bash
export ANTHROPIC_BASE_URL=http://localhost:5590
export ANTHROPIC_API_KEY=your-existing-anthropic-key  # unchanged

# Now use Claude Code normally
claude --help
```

**That's it!** Every Claude Code request now goes through intelligent context pruning.

---

## What's Happening?

1. Claude Code sends requests to `http://localhost:5590` instead of Anthropic directly
2. The proxy intercepts the request
3. When tokens exceed 100K (configurable), it asks Jev: "Which old tool results are still useful?"
4. Jev evaluates each one (~300ms total)
5. The proxy deletes irrelevant results (keeping everything else verbatim)
6. Cleaned request goes to Anthropic API
7. Response flows back to Claude Code unchanged

---

## Verify It's Working

### Check Health

```bash
curl http://localhost:5590/health | jq
```

Response:
```json
{
  "status": "ok",
  "proxy_version": "1.0.0",
  "jev_connected": true,
  "pruning_enabled": true,
  "cache_size": 0,
  "uptime_seconds": 42
}
```

### Watch Pruning Happen

```bash
# In a terminal, watch the log file
tail -f ~/.claude/jev-prune.log

# Then run a long Claude Code session in another terminal
claude
```

You should see entries like:
```
[2026-09-22T14:32:15Z] [info]: Context pruned
{
  "before": 152000,
  "after": 118000,
  "reduction": "22%",
  "messagesKept": 47
}
```

---

## Configuration Guide

### Token Thresholds

Default behavior:
- **100K tokens**: Start evaluating for pruning
- **150K tokens**: Force prune immediately (can't grow beyond this)

Adjust for your needs:

```bash
# Prune earlier (save more tokens, costs more Jev API calls)
JEV_PRUNE_THRESHOLD=50000

# Prune more aggressively (keep fewer old messages)
JEV_PRUNE_TRIGGER_TOKENS=120000

# Always keep last 10 messages (more context, fewer tokens saved)
JEV_PRUNE_KEEP_RECENT=10
```

### Disable Pruning for Specific Tools

Some tool results are always useful (like test output). Never prune them:

```bash
JEV_PRUNE_EXCLUDE_TOOLS=test,package_manager,debug
```

### Enable Debug Mode

See every decision Jev makes:

```bash
JEV_PRUNE_DEBUG=true
npm start
```

---

## Advanced: Custom CLAUDE.md Rules

Add to your project's `CLAUDE.md` to guide pruning:

```markdown
# Pruning Strategy

When compacting conversation history:
- Always preserve: Error resolution discussions, test failures and fixes
- Prune aggressively: File listings (ls), grep results without context
- Custom: Focus on keeping implementation details, architecture decisions

This is a hint, not a requirement—Jev makes final decisions.
```

---

## Troubleshooting

### "TYPESAFE_API_KEY not set"

```bash
export TYPESAFE_API_KEY=sk-typesafe-xxx
npm start
```

### Claude Code not using proxy

Verify you set `ANTHROPIC_BASE_URL`:
```bash
echo $ANTHROPIC_BASE_URL
# Should print: http://localhost:5590
```

If not set, do it again:
```bash
export ANTHROPIC_BASE_URL=http://localhost:5590
```

### Proxy starts but Claude Code uses direct API

The `export` might not have persisted. Check:
```bash
# In the same terminal where you run claude:
env | grep ANTHROPIC
```

If you don't see it, re-export:
```bash
export ANTHROPIC_BASE_URL=http://localhost:5590
export ANTHROPIC_API_KEY=your-key
claude
```

### Context still getting summarized

Jev pruning removes context, but Claude Code's built-in `/compact` still works. You'll see two types:
- **Jev pruning** (automatic): Removes irrelevant tool calls
- **Claude Code /compact** (manual): Summarizes if you hit the hard limit

This is fine—they complement each other.

### High latency or slow responses

Jev evaluation takes ~300ms per pruning decision. If you see slowness:

1. Disable pruning temporarily:
   ```bash
   JEV_PRUNE_ENABLED=false npm start
   ```

2. Increase the threshold so pruning happens less often:
   ```bash
   JEV_PRUNE_THRESHOLD=150000  # Don't prune until 150K tokens
   ```

3. Check Jev API status at https://status.typesafe.ai

---

## Next Steps

- Read [ARCHITECTURE.md](./ARCHITECTURE.md) to understand how it works
- Check [examples/](./examples/) for sample workflows
- Join the community at https://github.com/j-ctang/claude-code-jev-prune/discussions

---

## Need Help?

- 🐛 Found a bug? [Open an issue](https://github.com/j-ctang/claude-code-jev-prune/issues)
- 💬 Have a question? [Start a discussion](https://github.com/j-ctang/claude-code-jev-prune/discussions)
- 📖 Want to contribute? See [CONTRIBUTING.md](./CONTRIBUTING.md)
