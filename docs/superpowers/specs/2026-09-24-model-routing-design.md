# Model Routing Design

Date: 2026-09-24
Status: Draft for review

## Goal

Answer hard prompts with a stronger model. The proxy switches a conversation to a
configured "hard" model when the user sends a hard prompt, and switches back to
the default model at the next task boundary.

Quality must never drop because of routing. Routing does not exist to save
tokens or plan usage. Most users are on the $100 and $200 Max plans.

## Non-goals

- Changing `effort`, `thinking`, or any other request parameter. Only `model` changes.
- Routing to Haiku 4.5. It rejects `effort` and adaptive thinking, so Claude
  Code's requests would fail without parameter changes.
- Switching down to save usage (this may come later, only if measurements show
  quality holds).
- `--stats` reporting for routing. Routing is logged; stats can come later.

## Background: what a model switch costs

From the Claude API documentation:

1. **Cache refill.** The prompt cache is scoped to one model. The first request
   after a switch reads the whole conversation again without the cache. That
   response is slower and counts the full conversation against the plan's
   usage. Later requests are cached again.
2. **Reasoning loss depends on direction.** Thinking blocks are bound to the
   model that wrote them.
   - Opus 5.5 → Fable 5.1: kept. Fable 5.1 reads Opus 5.5 blocks.
   - Fable 5.1 → Opus 5.5: lost. Only Mythos 5.1 reads Fable 5.1 blocks.
   - The API drops unreadable blocks silently. They are not billed, but the new
     model has to re-plan without them.
3. **Preserved thinking.** Opus 5.5 and Fable 5.1 bind each thinking block to
   the exact conversation before it. Editing earlier history makes later blocks
   invalid. Accounts created on or after 2026-08-31 get a 400 for this.

The routing policy below keeps switches rare and puts them where they cost the
least.

## User experience

1. The user runs Claude Code on the default model (for example Opus 5.5).
2. **First hard prompt (asked until answered).** The proxy tells Claude to stop and
   ask the user in one line: "This looks like a hard prompt. jev-prune can move
   hard prompts to Fable 5.1 automatically. Run `/jev-route-auto` to turn it on,
   or `/jev-route-off` to never be asked again."
   - `/jev-route-auto`: routing turns on, and this conversation switches up at
     once. Claude continues the original prompt on the hard model.
   - `/jev-route-off`: routing turns off. Claude continues the original prompt
     on the current model.
   - If the user ignores the question, the next hard prompt asks again. Once
     the user answers, the choice is saved and the question never returns.
   - With `JEV_PRUNE_NOTIFY=false`, the question can't reach Claude, so `ask`
     mode never switches. `auto` mode still switches, silently.
3. **After opting in.** Switches happen automatically. Each switch adds a notice
   so Claude tells the user in one short line, for example
   "[jev-prune] Switched to claude-fable-5-1 for a hard prompt."
4. Users can change their choice later with `/jev-route-auto` and
   `/jev-route-off`.

## Routing policy

Routing only decides on a **new user turn** (`readTurn().newUserTurn`). Tool-loop
requests reuse the conversation's current model, so a model never changes in the
middle of a task.

On each new user turn, Jev answers two `noul` questions in one request:

- **hard**: "Does the newest user request need deep, multi-step reasoning to do
  well?"
- **continues**: "Is the newest user request a follow-up that depends on the
  work just done?"

| Current model | Rule | Action |
| --- | --- | --- |
| Default | `hard >= upThreshold` | Switch up, notify |
| Default | otherwise | Stay |
| Hard | `continues >= 0.5` | Stay up (the follow-up needs the hard model's reasoning) |
| Hard | `hard <= downThreshold` and `continues < 0.5` | Switch down, notify |
| Hard | otherwise | Stay up |

Defaults: `upThreshold = 0.7`, `downThreshold = 0.4`. The gap between them stops
scores near one line from flipping the model back and forth.

Switching down only at a task boundary (a new, unrelated, easy prompt) keeps the
Fable → Opus reasoning loss to work that is already finished.

## Which requests are routed

A request is eligible only when all are true:

- It is `POST /v1/messages` and passes `isAnthropicRequest`.
- Routing mode is `auto` (or `ask`, for the one-time question).
- `body.model` equals the configured default model. Claude Code keeps sending
  the default model even after the proxy switches a conversation up, so every
  request in a routed conversation stays eligible. Any other model is left
  alone. This covers subagents that use their own model (for example Haiku),
  and a user who picked a model with `/model`, including the hard model
  itself. The router never moves a user off a model they chose.
- `tool_choice` is absent or `{ "type": "auto" }`. Fable 5.1 and Opus 5.5 reject
  forced tool choice, so the router never moves such a request.

Routing state is kept per **conversation**, not per Claude Code session. A
subagent shares its parent's session header but sends its own
`x-claude-code-agent-id` header; the main thread never sends one. The
conversation key is the session header plus the agent ID, or `main`, so it
survives `/compact`. Without a session header, the key is a hash of the first
user message's text. Claude Code's session setup request (no tools, prompt
wrapped in `<session>`) is never routed.
Claude Code's `/compact` summary request keeps the thread's current model and
never calls Jev: its cache is warm there, and it is not a prompt from the user.

State is in memory. A proxy restart forgets it; the next request then uses
whatever model Claude Code sends, which is the default model. Restarts are rare
because the proxy is shared and reused.

## Fallback when the hard model is unavailable

A Pro account, or a Max account without Fable credit, can't use Fable 5.1. When a
routed request gets an upstream 400, 403, or 404, or a 429 with
`x-should-retry: false`, before any body is streamed. A Max account without Fable
credit gets that 429: `rate_limit_error`, "Usage credits are required for this
model.", `error_code: credits_required` (verified live 2026-09-26). A plain 429
rate limit is not resent.

1. Discard the response body.
2. Resend the same request with the original model, with a notice:
   "[jev-prune] claude-fable-5-1 rejected this request, so this conversation
   stays on claude-opus-5-5."
3. If the resend succeeds, the routed model caused the rejection: mark the
   conversation as `unavailable`. It is never routed again. After a 403, 404,
   or non-retryable 429 the account can't use the model at all, so no
   conversation is routed or asked about routing until the proxy restarts.
4. If the resend fails too, the request itself was bad (for example, "prompt
   is too long"). Return that error and keep routing.

The user always gets an answer, and never on a worse model than the one they
chose.

## Jev failures

If Jev fails or times out, the conversation keeps its current model. The failure
is logged as `route_fail_open`. Routing never blocks or fails a request.

## Settings

New environment variables, parsed in `src/config.ts`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `JEV_ROUTE_DEFAULT_MODEL` | `claude-opus-5-5` | Model that easy prompts use. |
| `JEV_ROUTE_HARD_MODEL` | `claude-fable-5-1` | Model that hard prompts use. |
| `JEV_ROUTE_UP_THRESHOLD` | `0.7` | `hard` score needed to switch up. |
| `JEV_ROUTE_DOWN_THRESHOLD` | `0.4` | `hard` score at or below which a new task switches down. |

The mode (`ask`, `auto`, `off`) is a saved choice, like the canary mode. It is
stored in `${statePath}.route-mode.json`, starts as `ask`, and changes through
the slash commands. Routing uses Jev, so without `TYPESAFE_API_KEY` it is off
and every request keeps its model.

For testing without Fable credit: `JEV_ROUTE_DEFAULT_MODEL=claude-sonnet-5` and
`JEV_ROUTE_HARD_MODEL=claude-opus-5-5`.

## Components

| Unit | Responsibility |
| --- | --- |
| `src/services/jevService.ts` | Add a generic `ask(state, questions)` that sends `noul` questions and validates answers. `score()` uses it. |
| `src/services/savedChoice.ts` | Load and save a slash-command choice; `routeChoice()` in the router holds `ask` / `auto` / `off`. |
| `src/services/modelRouter.ts` | Keep per-conversation state, handle the route commands, call Jev, apply the policy table, and return the model to send plus an optional notice. |
| `src/services/turn.ts` | Add `previousGoal` (the user text before the newest one) for the `continues` question. |
| `src/services/messagePreparer.ts` | Check the canary, prune and route at the same time, add every notice, and send with the router's fallback. |
| `src/middleware/proxy.ts` | Hand `/v1/messages` requests to the preparer and stream the response. |
| `commands/jev-route-auto.md`, `commands/jev-route-off.md` | Slash commands. The proxy recognizes them. |
| `src/installation.ts` | Install the two new slash commands. |

## Logging

- `model_route`: conversation key, from, to, `hard`, `continues`, reason.
- `route_fail_open`: Jev error.
- `route_model_unavailable`: upstream status and the model that failed.

## Step 1: verification before building

These facts decide details of the build. Check them first with real Claude Code
traffic:

1. **Request shape.** Which `model` strings Claude Code sends (for example with
   or without a `[1m]` suffix), which beta headers, whether it ever sends a
   forced `tool_choice`, and whether subagent requests share the session header.
2. **Preserved thinking vs pruning.** Pruning removes tool pairs from the middle
   of history, and notices are appended to a user message that Claude Code later
   resends without them. Both may invalidate Opus 5.5 / Fable 5.1 thinking blocks.
   Test by sending `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`
   with the `thinking-binding-controls-2026-08-01` beta and reading
   `input_transformations`. If blocks are dropped, fixing pruning comes before
   routing, because routing moves conversations onto a model that enforces the
   check.
3. **Opt-in resume.** Check that, after `/jev-route-auto`, Claude continues the
   original prompt rather than only acknowledging the command.

## Testing

- Policy table: every row, with a fake scorer.
- Tool-loop requests keep the conversation's model.
- Different model, forced `tool_choice`, and mode `off` are never routed.
- Two conversations in one session keep separate state.
- Jev failure keeps the current model.
- Unavailable hard model: the proxy resends on the original model, marks the
  conversation `unavailable`, and adds a notice. A 403, 404, or credits-required
  429 stops routing in every conversation.
- `ask` mode: the question is asked once, `/jev-route-auto` switches up at once,
  and `/jev-route-off` stops routing.
- `ask()` in `JevService`: batching and answer validation, same as `score()`.
