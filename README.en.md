# dsh-workflow-model-guard

[![test](https://github.com/Rayzenchen/dsh-workflow-model-guard/actions/workflows/test.yml/badge.svg)](https://github.com/Rayzenchen/dsh-workflow-model-guard/actions/workflows/test.yml)

> **Workflow subagent model guard** · [中文](README.md)

Makes the subagent model-selection allow-list govern the `workflow` tool too.

A DeepSeek Harness (`dsh`) plugin. Host-only bundle: no client code, no UI.

---

## The hole

DSH has two "parent delegates to a child" paths, and only one of them is policed:

| | Path A: the `subagent` tool | Path B: the `workflow` tool's `agent()` |
|---|---|---|
| Who implements it | `@deepseek-ai/dsh-tool-subagent` | `@deepseek-ai/dsh-workflow-ptc` |
| Allow-list | **yes** — `child LLM route "P/M" is not allowed for this Session` | **no** policy check anywhere in between |
| Failure shape | throws, the model sees it | `agent()` resolves to `null`, `parallel()`/`pipeline()` turn that into a `null` item, and the run still reports `completed` |

One bad route therefore used to be able to kill a hundred children silently, while the allow-list that
would have caught it never saw the call.

## Two layers

| Layer | Extension point | What it does |
|---|---|---|
| Soft | `ctx.systemPrompt.section({ text })` | While the `workflow` tool *and* `list_subagent_models` are actually visible to the agent being assembled, adds a short instruction: check the live route list first, choose only from it, and omit `provider`/`model` when unsure. Includes this Session's allowed routes. The section's text is a function, so a composition without the workflow tool pays nothing. |
| Hard | `tools/pre-execute` (waterfall) | On `exec.name === 'workflow'`, tokenizes the script (strings, template literals, comments and regex literals are recognised, so prose mentioning `provider: 'x'` is never read as code) and reads the `provider`/`model` object properties. An off-list literal route is denied with a reason that names it, lists the allowed routes, and gives the two ways to fix the script. |

The allowed list is the same authority path A enforces: the `subagentModelSelectionPolicy` session
projection, with the live `subagentModelSelection` Settings service as a fallback. A Session that captured
no policy is not restricted here either — the goal is parity with path A, not a second, stricter policy.

## What the hard layer honestly is

**A heuristic, not a guarantee.** The script is JavaScript; routes can be computed at runtime, and no
static reader can be complete. It never evaluates the script. A denial is issued only when a literal is
*provably* outside the allow-list (or when a deployment opts into strictness for unresolved routes):

| Case | Behaviour |
|---|---|
| `agent(p, { provider: 'a', model: 'b' })`, both literals | exact verdict |
| only one half, matching no allowed route | provable violation → deny |
| only one half that matches some route | unknown (the other half is inherited) |
| value is a variable, `${}` template, or conditional | unknown |
| route passed in from outside the script (`args`) | invisible |

Unknown cases follow `unresolvedRoute` (`allow` by default — catch only what can be proven).

## Install

From GitHub, in **Settings → Plugins** use the install spec:

```
github:Rayzenchen/dsh-workflow-model-guard
```

If the plugin is already installed from this checkout with a `link:` dependency, do **not** install the
GitHub copy as well. For local development, add it to a profile's `dsh.profile.bundles` and
`dependencies` as `link:/absolute/path/to/dsh-workflow-model-guard-plugin`, then run `pnpm install` in
the profile, and restart DSH (Host-side code is loaded at boot).

Note that the allow-list itself lives in the official subagent plugin: **Settings → Subagents → allowed
models**. This plugin only extends where that list is enforced.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch for both layers. |
| `toolName` | `workflow` | The tool to police. |
| `discoveryToolName` | `list_subagent_models` | The discovery tool path A registers. |
| `injectGuidance` | `true` | Soft layer. |
| `enforceRoutes` | `true` | Hard layer. |
| `unresolvedRoute` | `allow` | What to do when a route cannot be read statically: `allow` / `deny` / `ask`. |
| `denyWhenPolicyUnreadable` | `false` | Deny when the allowed list cannot be read at all. |

Configuration fails loudly: unknown keys, wrong types and out-of-range enum values are reported at load
time rather than silently ignored.

## Known limits

- It only sees routes the model *wrote into the script*. An inherited route (no `provider`/`model`) always
  passes — it never went through a policy in the first place.
- The complete fix belongs in the workflow engine (`ctx.workflowEngine.startChild`), where the *evaluated*
  final route is available. This plugin deliberately does not take over the engine's run lifecycle.
- Depends on internal shapes (`tools/pre-execute` decisions, `ctx.tools.get(name, agent)`, the
  `subagentModelSelectionPolicy` projection). Re-run the self-test and check those with Inspect after
  every DSH upgrade.
- `reasoning_effort` is not covered: the workflow engine currently rejects that option outright.

## Compatibility

Built and verified against **DSH `0.2.2-rc.5`** (macOS desktop profile).

## Tests

```bash
node --check index.js
node tools/self-test.mjs        # 59 checks: scanner, verdicts, policy sources, both layers
node tools/deny-equivalence.mjs # renders the denial reason
```

[VERIFICATION.md](VERIFICATION.md) records the live checks and their raw output.

## License

MIT © 2026 Rayzenchen — see [LICENSE](LICENSE).
