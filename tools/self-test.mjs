/**
 * Self-test for `@local/dsh-workflow-model-guard`'s static route reader.
 *
 * Run: `node tools/self-test.mjs`
 *
 * This exercises the two pieces that are pure functions of their input — the
 * script scanner (`scanRouteProperties` + `judgeCandidate`) and the config
 * validator — against the shapes a workflow script actually takes, including
 * the ones that must NOT be flagged. It needs no Harness, no network and no
 * profile; it is the fast loop, not the acceptance test.
 *
 * The acceptance test (a real Session, a real `workflow` call, a real deny) is
 * recorded in README.md §6.
 */
import { __test, apply } from '../index.js'

const ALLOWED = [
  { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  { provider: 'deepseek-official', model: 'deepseek-chat' },
]

let failures = 0
let checks = 0

/** Assert one judged verdict for one script. */
function verdictOf(script, allowed = ALLOWED) {
  const candidates = __test.scanRouteProperties(script)
  return candidates.flatMap((candidate) => __test.judgeCandidate(candidate, allowed)).map((item) => item.verdict)
}

/** Assert deep equality with a readable diff. */
function equal(actual, expected, label) {
  checks += 1
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) return
  failures += 1
  console.error(`✗ ${label}\n    expected ${b}\n    actual   ${a}`)
}

/** Assert a boolean condition. */
function ok(condition, label) {
  checks += 1
  if (condition) return
  failures += 1
  console.error(`✗ ${label}`)
}

// #region the script shapes that must be judged

equal(
  verdictOf(`const r = await agent('do it', { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })\nreturn r`),
  ['ok'],
  'allowed pair → ok',
)

equal(
  verdictOf(`const r = await agent('do it', { label: 'x', provider: 'deepseek-official', model: 'deepseek-flash' })\nreturn r`),
  ['violation'],
  'off-list pair → violation',
)

equal(
  verdictOf(`await pipeline(items, async (item) => agent(item, { model: 'deepseek-v4.1-flash' }))`),
  ['unknown'],
  'model-only, model is allowed for some provider → unknown (cannot know the parent provider)',
)

equal(
  verdictOf(`await pipeline(items, async (item) => agent(item, { model: 'deepseek-flash' }))`),
  ['violation'],
  'model-only, model in no allowed route → violation (provable)',
)

equal(
  verdictOf(`await agent('x', { provider: 'deepseek-official' })`),
  ['unknown'],
  'provider-only, provider allowed → unknown (the model half is inherited)',
)

equal(
  verdictOf(`await agent('x', { provider: 'acme' })`),
  ['violation'],
  'provider-only, provider in no allowed route → violation (provable)',
)

equal(
  verdictOf('const p = pick()\nawait agent(\'x\', { provider: p, model: `d-${n}` })'),
  ['unknown'],
  'computed provider and substituted template model → unknown, never guessed',
)

equal(
  verdictOf(`const cfg = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }\nconst r = await parallel(items.map((i) => () => agent(i, cfg)))\nreturn r`),
  ['ok'],
  'route held in a variable object literal → still read',
)

equal(
  verdictOf(`const nested = { a: { provider: 'acme', model: 'nope' } }`),
  ['violation'],
  'nested object literal → violation',
)

// #region shapes that must NOT be read as a route

equal(verdictOf(`log("pass provider: 'acme', model: 'nope' to agent()")`), [], 'route-looking text inside a string → not a route')

equal(verdictOf(`// provider: 'acme', model: 'nope'\nawait agent('x')`), [], 'route-looking text inside a line comment → not a route')

equal(verdictOf(`/* provider: 'acme', model: 'nope' */\nawait agent('x')`), [], 'route-looking text inside a block comment → not a route')

equal(verdictOf(`const re = /['"]provider['"]\\s*:/g\nawait agent('x')`), [], 'quotes inside a regex literal → not a route')

equal(verdictOf(`await agent('x', { schema: { type: 'object', properties: { provider: { type: 'string' } } } })`), [], 'a JSON-schema `provider` property (object, not string) → not read as a route')

equal(verdictOf(`await agent('x')`), [], 'no route at all → nothing to judge')

equal(verdictOf(`await agent('x', { reasoning_effort: 'high' })`), [], 'unrelated agent() option → nothing to judge')

equal(verdictOf(`const s = 'model: ' + name\nawait agent('x')`), [], 'concatenated string (not object-property syntax) → nothing to judge')

// #endregion

// #region the config validator

equal(__test.validateConfig(undefined).value, {
  enabled: true,
  toolName: 'workflow',
  discoveryToolName: 'list_subagent_models',
  injectGuidance: true,
  enforceRoutes: true,
  unresolvedRoute: 'allow',
  denyWhenPolicyUnreadable: false,
}, 'config defaults')

ok(__test.validateConfig({ nope: 1 }).issues !== undefined, 'unknown config key → issue (fail loud)')
ok(__test.validateConfig({ unresolvedRoute: 'maybe' }).issues !== undefined, 'bad enum value → issue')
ok(__test.validateConfig({ toolName: '' }).issues !== undefined, 'empty toolName → issue')
ok(__test.validateConfig({ enforceRoutes: 'yes' }).issues !== undefined, 'non-boolean flag → issue')
equal(__test.validateConfig({ enforceRoutes: false, unresolvedRoute: 'deny' }).value.enforceRoutes, false, 'overrides are applied')

// #endregion

// #region message shape: a denial must be actionable

const reason = __test.denyReason({ discoveryToolName: 'list_subagent_models' }, [
  { verdict: 'violation', route: 'deepseek-official/deepseek-flash', why: 'model "deepseek-flash" is not in the allowed list', line: 1, snippet: "model: 'deepseek-flash'" },
], ALLOWED)
ok(reason.includes('deepseek-official/deepseek-flash'), 'reason names the offending route')
ok(reason.includes('- opencode-go/deepseek-v4.1-flash'), 'reason lists the allowed routes')
ok(reason.includes('list_subagent_models'), 'reason points at the discovery tool')
ok(reason.includes('Omit `provider` and `model`'), 'reason offers the inherit-the-parent route')
ok(reason.includes('line 1'), 'reason points at the offending line')

const soft = __test.guidanceText({ discoveryToolName: 'list_subagent_models' }, ALLOWED)
ok(soft.includes('list_subagent_models'), 'guidance tells the model to call the discovery tool')
ok(soft.includes('- deepseek-official/deepseek-chat'), 'guidance embeds the allowed routes')

// #endregion

// #region which authority the allowed list comes from (path A's precedence)

/** Build a stub plugin context with only the surfaces this plugin touches. */
function stubContext({ projection = 'absent', projectionUnregistered = false, projectionThrows = false, service = 'absent', serviceThrows = false, tools = {} } = {}) {
  const sections = []
  const listeners = new Map()
  const ctx = {
    logger: { warn: () => {} },
    get: (key) => {
      if (key === 'sessionProjections') {
        if (projection === 'absent') return undefined
        return {
          stateOf: () => {
            if (projectionThrows) throw new Error('projection boom')
            if (projectionUnregistered) return undefined
            return projection
          },
        }
      }
      if (key === 'subagentModelSelection') {
        if (serviceThrows) {
          return {
            current: () => {
              throw new Error('service boom')
            },
          }
        }
        if (service === 'absent') return undefined
        return { current: () => service }
      }
      return undefined
    },
    tools: { get: (name) => tools[name] },
    systemPrompt: {
      getSectionOrder: (name) => (name === 'TOOL_WORKFLOW' ? 2600 : undefined),
      section: (definition) => {
        sections.push(definition)
        return () => {}
      },
    },
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => {}
    },
  }
  return { ctx, sections, listeners }
}

const AGENT = { session: { id: 'session-under-test' } }
const PROJECTION_ROUTES = [{ provider: 'proj', model: 'only' }]
const SERVICE_ROUTES = { enabled: true, allowedModels: [{ provider: 'svc', model: 'other' }] }

equal(
  __test.readAllowedRoutes(stubContext({ projection: PROJECTION_ROUTES, service: SERVICE_ROUTES }).ctx, AGENT),
  PROJECTION_ROUTES,
  'projection and Settings disagree → the projection wins (the list list_subagent_models shows)',
)

equal(
  __test.readAllowedRoutes(stubContext({ projection: null, service: SERVICE_ROUTES }).ctx, AGENT),
  undefined,
  'projection is null → not governed, exactly like path A (the Settings fallback is not consulted)',
)

equal(
  __test.readAllowedRoutes(stubContext({ projectionThrows: true, service: SERVICE_ROUTES }).ctx, AGENT),
  SERVICE_ROUTES.allowedModels,
  'projection unreadable → falls back to the live Settings service',
)

equal(
  __test.readAllowedRoutes(stubContext({ projectionThrows: true, serviceThrows: true }).ctx, AGENT),
  'unreadable',
  'both authorities unreadable → "unreadable" (the caller decides)',
)

equal(
  __test.readAllowedRoutes(stubContext({ projectionThrows: true, service: { enabled: false, allowedModels: [] } }).ctx, AGENT),
  undefined,
  'Settings present but disabled → not governed',
)

equal(
  __test.readAllowedRoutes(stubContext({ projectionUnregistered: true, service: SERVICE_ROUTES }).ctx, AGENT),
  SERVICE_ROUTES.allowedModels,
  'projection unit not registered → Settings is consulted (a disabled subagent plugin must not hide the live list)',
)

equal(
  __test.readAllowedRoutes(stubContext({}).ctx, AGENT),
  undefined,
  'no authority at all → not governed (fail open, with one warning per composition)',
)

// #endregion

// #region the assembled plugin: soft-layer gate and hard-layer decision

const WORKFLOW_TOOL = { name: 'workflow' }
const DISCOVERY_TOOL = { name: 'list_subagent_models' }

/** Install the plugin over a stub context and return its registrations. */
function install(overrides = {}, stub = {}) {
  const built = stubContext({
    projection: PROJECTION_ROUTES,
    tools: { workflow: WORKFLOW_TOOL, list_subagent_models: DISCOVERY_TOOL },
    ...stub,
  })
  apply(built.ctx, __test.validateConfig(overrides).value)
  return built
}

const softLayer = install()
equal(softLayer.sections.length, 1, 'soft layer registers exactly one prompt section')
const softText = softLayer.sections[0].text({ agent: AGENT, scope: AGENT })
ok(softText.includes('list_subagent_models'), 'soft layer text tells the model to call the discovery tool')
ok(softText.includes('- proj/only'), 'soft layer text embeds the Session routes')
equal(softLayer.sections[0].order, 2601, 'soft layer sits just after the workflow tool section')

const withoutWorkflow = install({}, { tools: { list_subagent_models: DISCOVERY_TOOL } })
equal(withoutWorkflow.sections[0].text({ agent: AGENT, scope: AGENT }), '', 'workflow tool not mounted → section renders empty (nothing is injected)')

const withoutDiscovery = install({}, { tools: { workflow: WORKFLOW_TOOL } })
equal(withoutDiscovery.sections[0].text({ agent: AGENT, scope: AGENT }), '', 'discovery tool not mounted → section renders empty')

const withoutPolicy = install({}, { projection: null })
equal(withoutPolicy.sections[0].text({ agent: AGENT, scope: AGENT }), '', 'no Session policy → section renders empty')

const noGuidance = install({ injectGuidance: false })
equal(noGuidance.sections.length, 0, 'injectGuidance: false → no section at all')

/** Drive the captured tools/pre-execute listener once. */
async function callGate(installed, exec) {
  const handler = installed.listeners.get('tools/pre-execute')
  let passedThrough = false
  const decision = await handler(exec, async () => {
    passedThrough = true
    return { kind: 'allow' }
  })
  return { decision, passedThrough }
}

const gate = install()
const denied = await callGate(gate, { name: 'workflow', arguments: { script: `await agent('x', { provider: 'acme', model: 'nope' })` }, agent: AGENT })
equal(denied.decision.kind, 'deny', 'hard layer denies an off-list route')
ok(denied.decision.reason.includes('acme/nope'), 'denial names the offending route')
ok(denied.decision.reason.includes('- proj/only'), 'denial lists the allowed routes')
ok(denied.passedThrough === false, 'a denied call never reaches the next stage')

const allowed = await callGate(gate, { name: 'workflow', arguments: { script: `await agent('x', { provider: 'proj', model: 'only' })` }, agent: AGENT })
equal([allowed.decision.kind, allowed.passedThrough], ['allow', true], 'hard layer allows an in-list route')

const inherited = await callGate(gate, { name: 'workflow', arguments: { script: `await agent('x')` }, agent: AGENT })
equal([inherited.decision.kind, inherited.passedThrough], ['allow', true], 'hard layer allows a script that names no route')

const otherTool = await callGate(gate, { name: 'subagent', arguments: { provider: 'acme', model: 'nope' }, agent: AGENT })
equal([otherTool.decision.kind, otherTool.passedThrough], ['allow', true], 'hard layer ignores every other tool')

const ungoverned = await callGate(install({}, { projection: null }), { name: 'workflow', arguments: { script: `await agent('x', { provider: 'acme', model: 'nope' })` }, agent: AGENT })
equal([ungoverned.decision.kind, ungoverned.passedThrough], ['allow', true], 'no Session policy → the guard steps aside')

const strict = install({ unresolvedRoute: 'deny' })
const strictDecision = await callGate(strict, { name: 'workflow', arguments: { script: `await agent('x', { provider: someVar })` }, agent: AGENT })
equal(strictDecision.decision.kind, 'deny', 'unresolvedRoute: deny → a computed route is rejected')

const asking = install({ unresolvedRoute: 'ask' })
const askDecision = await callGate(asking, { name: 'workflow', arguments: { script: `await agent('x', { model: someVar })` }, agent: AGENT })
equal(askDecision.decision.kind, 'ask', 'unresolvedRoute: ask → the user is asked instead')

const failClosed = install({ denyWhenPolicyUnreadable: true }, { projectionThrows: true, serviceThrows: true })
const closedDecision = await callGate(failClosed, { name: 'workflow', arguments: { script: `await agent('x')` }, agent: AGENT })
equal(closedDecision.decision.kind, 'deny', 'denyWhenPolicyUnreadable: true → an unreadable list denies')

const failOpen = install({}, { projectionThrows: true, serviceThrows: true })
const openDecision = await callGate(failOpen, { name: 'workflow', arguments: { script: `await agent('x')` }, agent: AGENT })
equal([openDecision.decision.kind, openDecision.passedThrough], ['allow', true], 'default: an unreadable list does not block anything')

const noEnforcement = install({ enforceRoutes: false })
equal(noEnforcement.listeners.has('tools/pre-execute'), false, 'enforceRoutes: false → no gate at all')

const malformed = await callGate(gate, { name: 'workflow', arguments: { script: 42 }, agent: AGENT })
equal([malformed.decision.kind, malformed.passedThrough], ['allow', true], 'a non-string script argument is left to the tool itself')

// #endregion

console.log(`${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exit(1)
