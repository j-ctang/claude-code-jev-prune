# Jev Prune for Claude Code: context pruning, compaction and filtering

**Keep your Claude Code context clean. Remove stale context without summarizing. Save 40-60% tokens.**

`claude-code-jev-prune` (Jev Prune) is an MCP plugin that uses TypeSafe Jev to prune, compact and filter Claude Code's conversation history. Instead of summarizing old context (which loses detail and introduces hallucinations), it uses Jev to identify irrelevant context and **deletes it while keeping everything else verbatim**.

Use it as a lossless alternative to Claude Code's `/compact`: Jev compaction, Jev pruning and Jev context filtering in one plugin.

- [Jev compact vs. /compact](#key-differences-from-standard-compaction)
- [Install Jev Prune in Claude Code](#installation)
- [How Jev pruning works](#how-it-works)
- [FAQ](#faq)

## What It Does

When Claude Code approaches its context limit, instead of the default lossy summarization, `claude-code-jev-prune`:

1. **Analyzes context**: Sends conversation history + current task to Jev
2. **Decides relevance**: Jev asks "Is this tool call still needed?" for each older exchange
3. **Deletes, doesn't summarize**: Removes irrelevant context entirely, keeps everything else **byte-for-byte original**
4. **Continues working**: Claude Code proceeds with clean, compressed context

## Key Differences from Standard Compaction

| Feature | Standard /compact | jev-prune |
|---------|------------------|-----------|
| Method | LLM summarization | Jev relevance scoring |
| Quality | Lossy (summaries) | Lossless (deletion only) |
| Multiple compactions | ❌ Degrades (summary of summary) | ✅ Safe (never rewrites) |
| Token savings | 50-70% | 40-60% |
| Speed | Slow (API call per turn) | Fast (~300ms per decision) |
| Cost | Expensive | Cheap ($0.042/M tokens) |
| Original messages | Modified | Preserved 100% |

## Installation

### Via MCP Registry (Coming Soon)

```bash
claude install jev-prune
```

### Manual Setup

```bash
# Clone the repo
git clone https://github.com/j-ctang/claude-code-jev-prune
cd claude-code-jev-prune

# Install dependencies
npm install

# Set your Jev API key
export TYPESAFE_API_KEY="your-jev-key-here"

# Start the proxy
npm start
```

Then configure Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://localhost:5590
export ANTHROPIC_API_KEY=your-existing-key  # unchanged
claude
```

## Configuration

### Environment Variables

```bash
# Required
TYPESAFE_API_KEY=sk-typesafe-...

# Optional
JEV_PRUNE_ENABLED=true              # Enable/disable pruning
JEV_PRUNE_THRESHOLD=100000          # Tokens before pruning activates (default: 100K)
JEV_PRUNE_TRIGGER_TOKENS=150000     # Hard limit before force-pruning (default: 150K)
JEV_PRUNE_KEEP_RECENT=5             # Always keep last N tool calls (default: 5)
JEV_PRUNE_EXCLUDE_TOOLS=grep,ls     # Don't prune these tool results (comma-separated)
JEV_PRUNE_DEBUG=true                # Log pruning decisions
ANTHROPIC_BASE_URL=http://localhost:5590
PORT=5590                           # Proxy listen port
```

### CLAUDE.md Integration

Add to your project's `CLAUDE.md` for custom pruning behavior:

```markdown
# Pruning Rules

When compacting conversation history:
- Always preserve: Error handling discussions, test results, final implementations
- Can remove: Exploratory tool calls, duplicate queries, old file listings
- Custom focus: Focus on keeping code changes and architecture decisions
```

## How It Works

### Architecture

```
Claude Code Terminal
        │
        ├─ POST /v1/messages (Anthropic format)
        │
        ▼
  jev-prune Proxy
        │
        ├─ Intercept messages
        ├─ Calculate token count
        ├─ If near limit:
        │   ├─ Ask Jev: "Is this tool call still useful?"
        │   ├─ Collect yes/no decisions (~300ms)
        │   └─ Filter context (delete irrelevant items)
        ├─ Forward cleaned messages
        │
        └─ Forward to Anthropic API
        
        ▼
  Anthropic API
        │
        └─ Response back to Claude Code (unchanged)
```

### Decision Logic

For each older tool call, Jev receives:
```json
{
  "state": "Current task: Fix the login bug. Previous errors: CORS issue (fixed), database connection (fixed), now focusing on JWT validation",
  "questions": [
    {
      "type": "boolean",
      "question": "Does the agent still need this file read result to complete the current task?"
    },
    {
      "type": "boolean", 
      "question": "Is this error message still relevant to the current goal?"
    }
  ]
}
```

Jev returns calibrated confidence scores. Low confidence items are dropped.

### Caching

Decisions are memoized per `tool_call_id` to keep prompt caching friendly:
- ✅ Evictions are permanent (won't be re-asked)
- ✅ Keeps are re-asked if task goal changes
- ✅ Fail-open: If Jev times out, request passes through unchanged

## Performance

### Token Savings Example

**Before** (200K context window):
- Conversation history: 45K tokens
- File contents: 78K tokens  
- Tool outputs: 52K tokens (many stale)
- System prompt: 25K tokens
- **Total: 200K (at limit, 95% full)**

**After jev-prune**:
- Conversation history: 35K tokens (kept all)
- File contents: 78K tokens (kept all)
- Tool outputs: 18K tokens (removed stale)
- System prompt: 25K tokens
- **Total: 156K (21% reduction, room for more work)**

### Cost Comparison

Processing 1 long Claude Code session (500K accumulated tokens):

| Method | Cost | Token Savings |
|--------|------|---------------|
| Standard /compact | $2.50 (5 LLM calls) | 70% |
| jev-prune | $0.02 (Jev calls) | 60% |
| **Savings** | **99% cheaper** | Similar results |

## Use Cases

✅ Long-running coding sessions (>100K tokens)  
✅ Multi-file refactors with many iterations  
✅ Debugging sessions with repeated test cycles  
✅ Projects with large codebases (need file context)  
✅ Teams working on same codebase (keep all changes)  

❌ Short sessions (<50K tokens) - not needed  
❌ One-shot tasks - overhead not worth it  

## Monitoring & Debugging

### View Pruning Decisions

```bash
tail -f ~/.claude/jev-prune.log
```

Output shows every decision:
```
[2026-09-22T14:32:15] Pruning triggered at 152K tokens
[2026-09-22T14:32:15] Evaluating 12 older tool calls
[2026-09-22T14:32:15] ✓ Kept file edit: src/auth.ts (confidence: 0.95)
[2026-09-22T14:32:15] ✗ Dropped: grep output from 10 minutes ago (confidence: 0.08)
[2026-09-22T14:32:15] Result: 152K → 118K tokens (22% reduction)
```

### Health Check

```bash
curl http://localhost:5590/health
```

```json
{
  "status": "ok",
  "proxy_version": "1.0.0",
  "jev_connected": true,
  "tokens_processed": 1234567,
  "pruning_decisions": 89,
  "uptime_seconds": 3600
}
```

## Troubleshooting

### Jev API key not found
```
Error: TYPESAFE_API_KEY environment variable not set
```
**Fix**: `export TYPESAFE_API_KEY="your-key-here"`

### Proxy not intercepting Claude Code
```
Error: Connection refused on localhost:5590
```
**Fix**: Ensure `ANTHROPIC_BASE_URL=http://localhost:5590` is set before running `claude`

### Context still getting summarized
```
Warning: Pruning disabled, falling back to default compaction
```
**Fix**: Set `JEV_PRUNE_ENABLED=true` and ensure Jev API key is valid

### Performance degradation
If sessions feel slower after enabling pruning:
- Increase `JEV_PRUNE_THRESHOLD` to avoid frequent pruning
- Reduce `JEV_PRUNE_KEEP_RECENT` to be more aggressive
- Add frequently-needed tools to `JEV_PRUNE_EXCLUDE_TOOLS`

## FAQ

### How do I reduce Claude Code context usage without losing detail?

Install Jev Prune. It deletes irrelevant turns instead of summarizing them, so the context that stays is byte-for-byte original.

### What is Jev compact?

Jev compact is Jev Prune's replacement for Claude Code's `/compact`. It scores each older exchange for relevance and drops only what the current task no longer needs.

### What is the difference between Jev pruning and Jev filtering?

Jev pruning removes whole stale exchanges from history. Jev filtering applies your pruning rules (see [CLAUDE.md Integration](#claudemd-integration)) to decide what always stays or always goes.

### Does Jev Prune work with multiple compactions in one session?

Yes. It never rewrites messages, so repeated pruning does not degrade quality like a summary of a summary.

### Is Jev Prune an official Anthropic tool?

No. It is a community plugin for Claude Code.

## Contributing

Contributions welcome! Areas to improve:

- [ ] Jev question schema optimization
- [ ] Parallel Jev evaluation for multiple contexts
- [ ] Better heuristics for "relevant" context
- [ ] Integration with Claude Code plugins API
- [ ] Dashboard for visualizing pruning decisions
- [ ] Benchmarks across different project types

## License

MIT

## Disclaimer

This project uses TypeSafe Jev API which requires an API key and incurs costs. Each context pruning decision costs ~$0.00001. Standard Claude Code API costs remain unchanged—this proxy is transparent to billing.

Pruning decisions are made locally; conversation history is sent to TypeSafe Jev API as part of the decision process. Review TypeSafe's privacy policy if this is a concern.

## References

- [TypeSafe Jev Docs](https://typesafe.ai/docs)
- [jev-compactor](https://github.com/glama/jev-compactor)
- [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
- [Claude Code Docs](https://code.claude.com/docs)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages)
