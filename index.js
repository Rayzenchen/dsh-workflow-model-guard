/**
 * Host half of `@local/dsh-workflow-model-guard`.
 *
 * Purpose: extend the "subagent model selection" allow-list — the Settings
 * list that governs which LLM routes a parent Agent may hand to a child — to
 * the SECOND delegation path a parent has: the `workflow` tool's `agent()`
 * hook.
 *
 * ## The hole this closes (reproduced, not inferred)
 *
 * DSH has two layer-0 "parent delegates to child" paths, and only one of them
 * is policed:
 *
 *   - path A, the `subagent` tool. `@deepseek-ai/dsh-tool-subagent` captures a
 *     per-Session route policy (`subagent/model-selection-policy` event → the
 *     `subagentModelSelectionPolicy` session projection), hands it to
 *     `list_subagent_models`, and calls `assertAllowedModelSelection` before
 *     the child is created. An off-list route dies with
 *     `child LLM route "P/M" is not allowed for this Session`.
 *   - path B, the `workflow` tool. `@deepseek-ai/dsh-workflow-ptc` runs the
 *     script in a confined Node process; its `agent(prompt, {provider, model})`
 *     hook forwards `provider`/`model` through `startChild()` →
 *     `ctx.subagents.start(provider, { agentOptions })` with **no policy check
 *     anywhere in between**. Grepping `allowedModels` / `modelSelectionPolicy`
 *     / `not allowed for this Session` across `dsh-workflow-ptc` and
 *     `dsh-tool-workflow` returns nothing.
 *
 * Path B is also the path that *fails quietly*: a child that cannot start or
 * cannot answer resolves `agent()` to `null`, and `parallel()`/`pipeline()`
 * turn that `null` into a per-item `null`. A run that names an unavailable
 * route therefore reports `completed` with N null results — the failure mode
 * that let one bad route silently kill a hundred children.
 *
 * Verified in this workspace before the plugin existed:
 *
 *   subagent(provider: 'deepseek-official', model: 'deepseek-flash')
 *     → Error: child LLM route "deepseek-official/deepseek-flash" is not allowed for this Session
 *   workflow: agent('…', { provider: 'deepseek-official', model: 'deepseek-flash' })
 *     → workflow "route-probe-gap" completed (1 agent). { "got": "null — child failed WITHOUT a policy error" }
 *
 * ## The two layers
 *
 * Soft — a system-prompt section. `systemPrompt.section({ text })` accepts a
 * *function* of the assembly context (`{ agent, scope, signal }`), and
 * `renderPrompt` drops every section that renders to `''`. That makes the
 * "only when the workflow tool is actually mounted" requirement free: the
 * section returns text only when `ctx.tools.get('workflow', agent)` resolves
 * for the agent being assembled, so a composition without the workflow tool
 * pays nothing — not one character, not one lookup after the first.
 *
 * Hard — `tools/pre-execute`. A waterfall listener on the tool-call gate; it
 * inspects `exec.name === 'workflow'`, statically reads the routes the script
 * asks for, and returns `{ kind: 'deny', reason }` when one of them is not in
 * the Session's allowed list. The reason names the offending route, lists the
 * allowed routes, and gives the two ways out, because a denial the model
 * cannot act on is just a stall.
 *
 * ## What the hard layer honestly is, and is not
 *
 * It is a *heuristic*. The script is JavaScript; routes may be computed at
 * runtime, and no static reader can be complete. This plugin does not pretend
 * to evaluate the script: it tokenizes it (strings, template literals,
 * comments and regex literals are recognised so their contents are never
 * mistaken for code) and reads `provider` / `model` properties of object
 * literals. That catches the shape that caused the incident — a literal route
 * written into the script — and it is sound in the direction that matters:
 * a denial is only issued when a literal is *provably* outside the allow-list,
 * or when the deployment explicitly opted into strictness for unresolved
 * routes (`unresolvedRoute: 'deny' | 'ask'`). A route assembled at runtime
 * from variables is invisible to it, and the README says so.
 *
 * ## Where the allowed list comes from, and why that order
 *
 * The authority is the same one path A uses: the `subagentModelSelectionPolicy`
 * session projection — the per-Session snapshot, inherited by child Sessions,
 * that `list_subagent_models` itself filters against. It is read first, so the
 * two paths cannot disagree. Only when that projection cannot be read at all
 * (no `sessionProjections` service, no Session, a throwing read) does the
 * plugin fall back to the live Settings service
 * `ctx.get('subagentModelSelection').current()`, whose `current()` throws by
 * design when the list is enabled but empty.
 *
 * A projection that reads as `null` means "this Session captured no policy",
 * and path A does not restrict such a Session either — so neither does this
 * plugin. That is deliberate: the point is parity with path A, not a second,
 * stricter policy.
 *
 * ## Why this file imports nothing
 *
 * A profile bundle is symlinked into the profile from this workspace, so Node
 * resolves the plugin's own bare imports from the workspace upward — where no
 * `@deepseek-ai/*` package exists (the profile's `node_modules` holds only the
 * `@local/*` links). A bare import of a shipped package would therefore fail
 * to load at runtime. Nothing here needs one: the only shape this plugin
 * *produces* is the `tools/pre-execute` decision object, and the only ones it
 * *consumes* are plain data (`exec.name`, `exec.arguments`, `exec.agent`,
 * `ctx.tools.get`, `ctx.sessionProjections.stateOf`, `ctx.systemPrompt.section`),
 * all reached through the live context.
 *
 * `Config` is a Standard Schema object — the interface cordis's `resolveConfig`
 * actually calls (`Config['~standard'].validate(value)`, synchronous,
 * `{ value }` or `{ issues }`). It is deliberately NOT a Schemastery graph, so
 * DSH's config-schema projector reports this row's schema as `unsupported`; the
 * only effect is that the Settings UI renders no generated form for these
 * knobs. They are still read from `cordis.patch.yml` and validated fail-loud
 * below.
 *
 * ## Failure discipline
 *
 * Nothing in this plugin may take the profile down or wedge a Session. Every
 * read that can throw (missing service, missing projection, disabled Settings
 * list, a hostile `exec.arguments`) is caught; a failed read degrades to "not
 * governed", i.e. the plugin stays silent and DSH behaves exactly as it did
 * before it was installed. `denyWhenPolicyUnreadable` is the one opt-in that
 * flips that default.
 */

/** Cordis plugin name; also the Loader row id in `cordis.patch.yml`. */
export const name = 'dsh-workflow-model-guard'

/**
 * The two services this plugin registers against. Without a tool registry
 * there is nothing to gate, and without the prompt registry there is nothing
 * to advise, so the plugin stays inactive rather than half-alive. Everything
 * else (`sessionProjections`, `subagentModelSelection`) is read optionally.
 */
export const inject = ['tools', 'systemPrompt']

/** Producer label used in log lines. */
const LOG = name

/** The session projection that carries path A's per-Session route policy. */
const POLICY_PROJECTION = 'subagentModelSelectionPolicy'

/** Standard Schema interface key, read by cordis `resolveConfig`. */
const STANDARD_SCHEMA = '~standard'

/** The object properties the static scanner treats as a requested route. */
const ROUTE_KEYS = ['provider', 'model']

/** How many characters of the offending source to quote back in a denial. */
const SNIPPET_MAX_CHARS = 60

/** Placement of the guidance section: immediately after the workflow tool's own section. */
const WORKFLOW_SECTION_FALLBACK_ORDER = 2601

/**
 * The tunable surface, with the default each field falls back to when the
 * row's `config` omits it. `kind` selects the check; `min` is the inclusive
 * lower bound for the numeric kinds; `values` is the closed set for `enum`.
 */
const FIELDS = {
  /** Master switch: `false` removes both layers without unloading the row. */
  enabled: { kind: 'boolean', fallback: true },
  /** The workflow tool's registered name (its own config calls it `toolName`). */
  toolName: { kind: 'string', fallback: 'workflow' },
  /** The discovery tool path A registers; the guidance only claims it exists when it is visible. */
  discoveryToolName: { kind: 'string', fallback: 'list_subagent_models' },
  /** Soft layer: advise the model before it writes a script. */
  injectGuidance: { kind: 'boolean', fallback: true },
  /** Hard layer: deny a workflow call whose script asks for an off-list route. */
  enforceRoutes: { kind: 'boolean', fallback: true },
  /**
   * What to do when a route cannot be read statically: a non-literal value, a
   * template with substitutions, or only one half of the pair. `allow` keeps
   * the plugin to provable violations; `deny`/`ask` make it strict at the cost
   * of flagging scripts whose routes are legitimately computed.
   */
  unresolvedRoute: { kind: 'enum', fallback: 'allow', values: ['allow', 'deny', 'ask'] },
  /**
   * Whether an unreadable policy (no projection AND no Settings service) is
   * treated as a denial. Off by default: an unreadable list means the plugin
   * cannot know, and guessing "deny" would break sessions the plugin cannot
   * see into.
   */
  denyWhenPolicyUnreadable: { kind: 'boolean', fallback: false },
}

/** Field names, for the unknown-key check. */
const FIELD_NAMES = new Set(Object.keys(FIELDS))

/**
 * Validate one row's `config` against {@link FIELDS}, applying every default.
 *
 * Fail-loud, per the Harness convention: an unknown key or a wrongly typed
 * value is reported as an issue rather than silently ignored, because a typo in
 * `cordis.patch.yml` that quietly does nothing is the expensive failure.
 * @param input - the row's raw `config` value, possibly `undefined`.
 * @returns `{ value }` with every field defaulted, or `{ issues }`.
 */
function validateConfig(input) {
  const raw = input === undefined || input === null ? {} : input
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ message: 'config must be a mapping', path: [] }] }
  }
  const issues = []
  for (const key of Object.keys(raw)) {
    if (!FIELD_NAMES.has(key)) issues.push({ message: `unknown config key "${key}"`, path: [key] })
  }
  const value = {}
  for (const [key, spec] of Object.entries(FIELDS)) {
    const given = Object.hasOwn(raw, key) ? raw[key] : spec.fallback
    if (spec.kind === 'boolean') {
      if (typeof given !== 'boolean') issues.push({ message: `\`${key}\` must be a boolean`, path: [key] })
      else value[key] = given
      continue
    }
    if (spec.kind === 'string') {
      if (typeof given !== 'string' || given.length === 0) issues.push({ message: `\`${key}\` must be a non-empty string`, path: [key] })
      else value[key] = given
      continue
    }
    if (spec.kind === 'enum') {
      if (!spec.values.includes(given)) issues.push({ message: `\`${key}\` must be one of ${spec.values.join(' | ')}`, path: [key] })
      else value[key] = given
      continue
    }
    issues.push({ message: `\`${key}\` has an unsupported kind`, path: [key] })
  }
  return issues.length > 0 ? { issues } : { value }
}

/** The row's Config, in the Standard Schema shape cordis reads. */
export const Config = {
  [STANDARD_SCHEMA]: {
    version: 1,
    vendor: 'dsh-workflow-model-guard',
    validate: validateConfig,
  },
}

// #region reading the Session's allowed routes

/** Normalize one route list to detached `{provider, model}` pairs. */
function normalizeRoutes(routes) {
  const out = []
  for (const route of routes) {
    if (route === null || typeof route !== 'object') continue
    const { provider, model } = route
    if (typeof provider !== 'string' || provider.length === 0) continue
    if (typeof model !== 'string' || model.length === 0) continue
    out.push({ provider, model })
  }
  return out
}

/**
 * Contexts already warned about a missing route authority. A composition whose
 * subagent plugin is absent or disabled still loads this plugin (its own two
 * services are injected), so the first enforcement read reports the gap once
 * instead of silently allowing every route forever.
 */
const warnedMissingAuthority = new WeakSet()

/**
 * Read the route policy that governs one Session, the way path A reads it.
 *
 * @param ctx - plugin context.
 * @param agent - the Agent whose Session is asking, when the caller has one.
 * @returns the allowed routes, or `undefined` when this Session is not
 *   governed (no policy captured, or no readable authority), or the string
 *   `'unreadable'` when an authority exists but the read failed — callers
 *   decide what an unreadable policy means via `denyWhenPolicyUnreadable`.
 */
function readAllowedRoutes(ctx, agent) {
  // 1. The per-Session snapshot path A enforces and `list_subagent_models` filters against.
  let projectionRead = false
  let projectionFailed = false
  try {
    const projections = ctx.get('sessionProjections')
    const session = agent?.session
    if (projections !== undefined && session !== undefined && typeof projections.stateOf === 'function') {
      // Host-only unit: it carries no wire view, so the registry's (deprecated)
      // stateOf is still the supported read. An unregistered unit answers
      // `undefined`; a registered-but-unset unit answers `null`.
      const state = projections.stateOf(session, POLICY_PROJECTION)
      projectionRead = true
      if (state === null) return undefined
      if (Array.isArray(state) && state.length > 0) return normalizeRoutes(state)
      // Unregistered or empty: keep looking, path A may still be governed by Settings.
    }
  } catch (error) {
    projectionFailed = true
    ctx.logger?.warn?.(`${LOG}: reading the ${POLICY_PROJECTION} projection failed: ${String(error)}`)
  }

  // 2. Fallback: the live Settings service, used when the projection could not
  // be read or is not registered at all.
  try {
    const service = ctx.get('subagentModelSelection')
    if (service === undefined) {
      // No Settings authority either. Only an actual read failure is
      // "unreadable"; a missing authority is still fail-open, but it is a
      // configuration gap worth reporting once per composition.
      if (!projectionRead && !projectionFailed && !warnedMissingAuthority.has(ctx)) {
        warnedMissingAuthority.add(ctx)
        ctx.logger?.warn?.(
          `${LOG}: no route authority is available (session projection "${POLICY_PROJECTION}" is not registered and subagentModelSelection is absent); every workflow route is allowed until the subagent plugin is mounted`,
        )
      }
      return projectionFailed ? 'unreadable' : undefined
    }
    const current = service.current?.()
    if (current !== undefined && current.enabled === true && Array.isArray(current.allowedModels)) {
      const routes = normalizeRoutes(current.allowedModels)
      if (routes.length > 0) return routes
    }
    // A readable, disabled or empty Settings list governs nothing.
    return undefined
  } catch (error) {
    ctx.logger?.warn?.(`${LOG}: reading the subagentModelSelection service failed: ${String(error)}`)
    return 'unreadable'
  }
}

/** Render a route list for a model-facing message. */
function renderRoutes(routes) {
  return routes.map((route) => `- ${route.provider}/${route.model}`).join('\n')
}

/** Whether one provider/model pair is exactly an allowed route. */
function isAllowedPair(routes, provider, model) {
  return routes.some((route) => route.provider === provider && route.model === model)
}

// #endregion

// #region static route extraction

/** Whether a character can start a JavaScript identifier. */
function isIdentStart(char) {
  return char !== undefined && /[A-Za-z_$]/.test(char)
}

/** Whether a character can continue a JavaScript identifier. */
function isIdentPart(char) {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char)
}

/** 1-based line number of one source offset. */
function lineOf(source, index) {
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === '\n') line += 1
  return line
}

/** Collapse one source slice to a single-line, length-bounded snippet. */
function snippetOf(source, start, end) {
  const text = source.slice(start, Math.min(end, start + SNIPPET_MAX_CHARS * 2)).replace(/\s+/g, ' ').trim()
  return text.length <= SNIPPET_MAX_CHARS ? text : `${text.slice(0, SNIPPET_MAX_CHARS - 1)}…`
}

/**
 * Read a quoted string literal starting at its opening quote.
 * @returns `{ end, value, literal }`; `literal` is false when the literal is
 *   unterminated or contains an escape, because decoding escapes is not worth
 *   the risk of mis-reading a route id.
 */
function readQuoted(source, start, quote) {
  let i = start + 1
  let escaped = false
  while (i < source.length) {
    const char = source[i]
    if (char === '\\') {
      escaped = true
      i += 2
      continue
    }
    if (char === quote) {
      return { end: i + 1, value: escaped ? '' : source.slice(start + 1, i), literal: !escaped }
    }
    if (char === '\n') return { end: i, value: '', literal: false }
    i += 1
  }
  return { end: i, value: '', literal: false }
}

/**
 * Read a template literal starting at its opening backtick, stepping over any
 * `${…}` substitution (including nested strings and templates) so the closing
 * backtick is found correctly. A template with substitutions is not a literal.
 */
function readTemplate(source, start) {
  let i = start + 1
  let substituted = false
  while (i < source.length) {
    const char = source[i]
    if (char === '\\') {
      i += 2
      continue
    }
    if (char === '`') {
      return substituted
        ? { end: i + 1, value: '', literal: false }
        : { end: i + 1, value: source.slice(start + 1, i), literal: true }
    }
    if (char === '$' && source[i + 1] === '{') {
      substituted = true
      i += 2
      let depth = 1
      while (i < source.length && depth > 0) {
        const inner = source[i]
        if (inner === '\\') {
          i += 2
          continue
        }
        if (inner === '"' || inner === "'") {
          i = readQuoted(source, i, inner).end
          continue
        }
        if (inner === '`') {
          i = readTemplate(source, i).end
          continue
        }
        if (inner === '{') depth += 1
        else if (inner === '}') depth -= 1
        i += 1
      }
      continue
    }
    i += 1
  }
  return { end: i, value: '', literal: false }
}

/** Read a regular-expression literal starting at its opening slash. */
function readRegex(source, start) {
  let i = start + 1
  let inClass = false
  while (i < source.length) {
    const char = source[i]
    if (char === '\\') {
      i += 2
      continue
    }
    if (char === '\n') return i
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    else if (char === '/' && !inClass) return i + 1
    i += 1
  }
  return i
}

/** Whether a `/` at this position starts a regex literal rather than a division. */
function regexAllowed(lastToken) {
  if (lastToken === '') return true
  if (lastToken === ')' || lastToken === ']' || lastToken === '}') return false
  if (lastToken === 'string' || lastToken === 'regex') return false
  if (/^[A-Za-z0-9_$]+$/.test(lastToken)) return false
  return true
}

/**
 * Statically collect every `provider` / `model` object property in a script.
 *
 * The script is never evaluated. Strings, template literals, comments and
 * regex literals are skipped as such, so prose that merely *mentions*
 * `provider: 'x'` is not read as a route. Every object literal is a candidate
 * — a route table the script builds before calling `agent()` is a requested
 * route too.
 *
 * @param source - the workflow script body.
 * @returns `{ props, start }` per object literal that named a route property,
 *   where each property is `{ key, value, line, snippet }` and `value` is
 *   `undefined` when the value is not a plain string literal.
 */
function scanRouteProperties(source) {
  const candidates = []
  const stack = []
  let i = 0
  let lastToken = ''

  const push = (prop) => {
    const top = stack[stack.length - 1]
    if (top !== undefined) top.props.push(prop)
  }

  while (i < source.length) {
    const char = source[i]

    if (char === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i)
      i = newline === -1 ? source.length : newline + 1
      continue
    }
    if (char === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2)
      i = close === -1 ? source.length : close + 2
      continue
    }
    if (char === '"' || char === "'") {
      i = readQuoted(source, i, char).end
      lastToken = 'string'
      continue
    }
    if (char === '`') {
      i = readTemplate(source, i).end
      lastToken = 'string'
      continue
    }
    if (char === '/' && regexAllowed(lastToken)) {
      i = readRegex(source, i)
      lastToken = 'regex'
      continue
    }
    if (char === '{') {
      stack.push({ props: [], start: i })
      lastToken = '{'
      i += 1
      continue
    }
    if (char === '}') {
      const object = stack.pop()
      if (object !== undefined && object.props.length > 0) candidates.push(object)
      lastToken = '}'
      i += 1
      continue
    }
    if (isIdentStart(char)) {
      const start = i
      while (i < source.length && isIdentPart(source[i])) i += 1
      const word = source.slice(start, i)
      if (stack.length > 0 && ROUTE_KEYS.includes(word)) {
        const afterWord = i
        while (i < source.length && /\s/.test(source[i])) i += 1
        if (source[i] === ':' && source[i + 1] !== ':') {
          i += 1
          while (i < source.length && /\s/.test(source[i])) i += 1
          const valueChar = source[i]
          if (valueChar === '"' || valueChar === "'" || valueChar === '`') {
            const read = valueChar === '`' ? readTemplate(source, i) : readQuoted(source, i, valueChar)
            let after = read.end
            while (after < source.length && /\s/.test(source[after])) after += 1
            // Only object-property syntax counts: `provider: 'x'` followed by `,` or `}`.
            if (source[after] === ',' || source[after] === '}') {
              push({
                key: word,
                value: read.literal ? read.value : undefined,
                line: lineOf(source, start),
                snippet: snippetOf(source, start, read.end),
              })
            }
            i = read.end
            lastToken = 'string'
            continue
          }
          // A non-literal value: recorded as unresolved, never guessed — except
          // when the value cannot be a route at all (`{…}`/`[…]`), which is how
          // a structured-output schema's own `provider` property reads.
          if (source[i] !== '{' && source[i] !== '[') {
            push({
              key: word,
              value: undefined,
              line: lineOf(source, start),
              snippet: snippetOf(source, start, Math.min(source.length, i + 40)),
            })
          }
          lastToken = word
          continue
        }
        i = afterWord
      }
      lastToken = word
      continue
    }
    if (!/\s/.test(char)) lastToken = char
    i += 1
  }

  return candidates
}

/**
 * Judge one object literal's route properties against the allowed list.
 *
 * Soundness rule: a denial needs proof. A literal half that matches no allowed
 * route proves the effective route cannot be allowed, whatever the other half
 * turns out to be. Anything else — a missing half, a computed value, a
 * template with substitutions — is `unknown` and is left to
 * `unresolvedRoute`.
 *
 * @param candidate - one scanned object literal.
 * @param allowed - the Session's allowed routes.
 * @returns `{ verdict: 'ok' | 'violation' | 'unknown', route?, why?, line?, snippet? }`.
 */
function judgeCandidate(candidate, allowed) {
  const providerProp = candidate.props.find((prop) => prop.key === 'provider')
  const modelProp = candidate.props.find((prop) => prop.key === 'model')
  const provider = providerProp?.value
  const model = modelProp?.value
  const label =
    provider !== undefined && model !== undefined
      ? `${provider}/${model}`
      : provider !== undefined
        ? `${provider}/<inherited model>`
        : model !== undefined
          ? `<inherited provider>/${model}`
          : '(route not readable statically)'

  if (provider !== undefined && !allowed.some((route) => route.provider === provider)) {
    return { verdict: 'violation', route: label, why: `provider "${provider}" is not in the allowed list`, line: providerProp.line, snippet: providerProp.snippet }
  }
  if (model !== undefined && !allowed.some((route) => route.model === model)) {
    return { verdict: 'violation', route: label, why: `model "${model}" is not in the allowed list`, line: modelProp.line, snippet: modelProp.snippet }
  }
  if (provider !== undefined && model !== undefined) {
    if (isAllowedPair(allowed, provider, model)) return { verdict: 'ok' }
    // Unreachable by construction: both halves matched, so the pair must match.
    return { verdict: 'unknown', route: label, why: 'the pair could not be confirmed', line: providerProp.line, snippet: providerProp.snippet }
  }
  const half = providerProp ?? modelProp
  return {
    verdict: 'unknown',
    route: label,
    why: half === undefined
      ? 'the route could not be read statically'
      : `only \`${half.key}\` was given (${half.snippet}); the effective route also depends on the parent Agent`,
    line: half?.line,
    snippet: half?.snippet,
  }
}

// #endregion

// #region model-facing text

/**
 * The soft layer's text. Rendered per request, and only for an Agent that can
 * actually see both tools, so an Agent without the workflow tool pays nothing.
 */
function guidanceText(config, routes) {
  return [
    `Workflow subagent model selection: this Session restricts which LLM routes a child agent may be given (the same list the \`${config.discoveryToolName}\` tool reports).`,
    `Before you pass \`provider\` or \`model\` to a workflow \`agent()\` call, call \`${config.discoveryToolName}\` and choose only from the routes it returns — a route outside this list is rejected before the run starts, and a route that is merely unavailable fails silently as \`null\` instead of raising.`,
    `If you are unsure, omit both \`provider\` and \`model\`: the child then inherits the parent Agent route, which is always allowed.`,
    `Allowed routes for this Session:`,
    renderRoutes(routes),
  ].join('\n')
}

/** The discovery-tool clause, omitted when that tool is not mounted for this Agent. */
function discoveryClause(config, suffix) {
  const toolName = config.discoveryToolName
  return typeof toolName === 'string' && toolName.length > 0 ? ` (call \`${toolName}\`${suffix})` : ''
}

/** The hard layer's reason: name the route, list the alternatives, give the two ways out. */
function denyReason(config, violations, allowed) {
  const lines = [
    'Blocked by the Session route policy: a workflow script may only hand a child agent a route from this Session\'s allowed list.',
    '',
    'Not allowed:',
  ]
  for (const violation of violations) {
    lines.push(`- ${violation.route} — ${violation.why}${violation.line === undefined ? '' : ` (line ${violation.line}: ${violation.snippet})`}`)
  }
  lines.push('', 'Allowed routes for this Session:', renderRoutes(allowed), '')
  lines.push('Two ways to fix this, then call the workflow tool again:')
  lines.push(`1. Use only a route from the list above${discoveryClause(config, " to see the live list and each model's reasoning efforts")}.`)
  lines.push('2. Omit `provider` and `model` from that `agent()` call — the child then inherits the parent Agent route, which is always allowed.')
  return lines.join('\n')
}

/** The hard layer's reason for a route that could not be read statically. */
function unresolvedReason(config, unknown, allowed) {
  const lines = [
    'Blocked by the Session route policy: this workflow script names a child route that cannot be verified before the run starts, and this deployment asks for unresolved routes to be rejected (`unresolvedRoute`).',
    '',
    'Could not verify:',
  ]
  for (const item of unknown) {
    lines.push(`- ${item.route} — ${item.why}${item.line === undefined ? '' : ` (line ${item.line}: ${item.snippet})`}`)
  }
  lines.push('', 'Allowed routes for this Session:', renderRoutes(allowed), '')
  lines.push('Two ways to fix this, then call the workflow tool again:')
  lines.push(`1. Write the route as two plain string literals from the list above, so it is checkable${discoveryClause(config, ' for the live list')}.`)
  lines.push('2. Omit `provider` and `model` from that `agent()` call — the child then inherits the parent Agent route, which is always allowed.')
  return lines.join('\n')
}

// #endregion

/**
 * Install the two layers.
 * @param ctx - plugin context; listeners and sections are scoped to it and disposed with it.
 * @param config - the row's config, already validated and defaulted by {@link Config}.
 */
export function apply(ctx, config) {
  if (!config.enabled) return

  /** Resolve the placement of the guidance section, tolerating an older prompt registry. */
  function guidanceOrder() {
    try {
      const order = ctx.systemPrompt.getSectionOrder?.('TOOL_WORKFLOW')
      if (Number.isFinite(order)) return order + 1
    } catch (error) {
      ctx.logger?.warn?.(`${LOG}: resolving the TOOL_WORKFLOW section order failed: ${String(error)}`)
    }
    return WORKFLOW_SECTION_FALLBACK_ORDER
  }

  /** Whether one tool is callable by the given scope, per the registry's own view. */
  function toolVisible(toolName, agent) {
    try {
      return ctx.tools.get(toolName, agent) !== undefined
    } catch (error) {
      ctx.logger?.warn?.(`${LOG}: reading the tool registry for "${toolName}" failed: ${String(error)}`)
      return false
    }
  }

  if (config.injectGuidance) {
    // A function `text` is evaluated per assembly (every model request) and an
    // empty render is dropped, so the section costs nothing when the workflow
    // tool — or the discovery tool that gives the advice its meaning — is not
    // mounted for this Agent.
    ctx.systemPrompt.section({
      name: `tool:${config.toolName}:model-policy`,
      order: guidanceOrder(),
      text: (context) => {
        const agent = context?.agent ?? context?.scope
        if (!toolVisible(config.toolName, agent)) return ''
        if (!toolVisible(config.discoveryToolName, agent)) return ''
        const routes = readAllowedRoutes(ctx, agent)
        if (!Array.isArray(routes) || routes.length === 0) return ''
        return guidanceText(config, routes)
      },
    })
  }

  if (config.enforceRoutes) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (exec?.name !== config.toolName) return await next()
        const script = exec.arguments?.script
        if (typeof script !== 'string' || script.length === 0) return await next()

        const agent = exec.agent
        const routes = readAllowedRoutes(ctx, agent)
        if (routes === 'unreadable') {
          if (!config.denyWhenPolicyUnreadable) return await next()
          return {
            kind: 'deny',
            reason: [
              'Blocked by the Session route policy: this Session\'s allowed-route list could not be read, and this deployment denies workflow delegation when the list is unreadable (`denyWhenPolicyUnreadable`).',
              '',
              `Omit \`provider\` and \`model\` from every \`agent()\` call in this script — an inherited route needs no policy check — or fix the model-selection setting and try again.`,
            ].join('\n'),
          }
        }
        if (!Array.isArray(routes) || routes.length === 0) return await next()

        const judged = scanRouteProperties(script).map((candidate) => judgeCandidate(candidate, routes))
        const violations = judged.filter((item) => item.verdict === 'violation')
        const reasonConfig = toolVisible(config.discoveryToolName, agent) ? config : { ...config, discoveryToolName: undefined }
        if (violations.length > 0) return { kind: 'deny', reason: denyReason(reasonConfig, violations, routes) }

        const unknown = judged.filter((item) => item.verdict === 'unknown')
        if (unknown.length > 0 && config.unresolvedRoute !== 'allow') {
          const reason = unresolvedReason(reasonConfig, unknown, routes)
          return config.unresolvedRoute === 'ask' ? { kind: 'ask', reason } : { kind: 'deny', reason }
        }
        return await next()
      } catch (error) {
        // Never wedge a Session on this plugin's own bug: report and step aside.
        ctx.logger?.warn?.(`${LOG}: workflow route check failed, allowing the call: ${String(error)}`)
        return await next()
      }
    })
  }
}

/**
 * Test surface for `tools/self-test.mjs`. Not part of the plugin contract — the
 * Loader reads only `name`, `inject`, `Config` and `apply` — but the static
 * scanner and the policy reader are the parts worth exercising without a live
 * Harness, so they are reachable from a plain `node tools/self-test.mjs`.
 */
export const __test = {
  validateConfig,
  normalizeRoutes,
  readAllowedRoutes,
  scanRouteProperties,
  judgeCandidate,
  guidanceText,
  denyReason,
  unresolvedReason,
}
