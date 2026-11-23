/**
 * Replay one denial through the CURRENT code and print it, so a recorded
 * live denial can be byte-compared against what this revision renders.
 *
 * Run: `node tools/deny-equivalence.mjs`
 *
 * Why this exists: the desktop profile is a live profile, so a bundle added at
 * runtime mounts without a restart — but Node caches the plugin module by URL,
 * so later edits to `index.js` do NOT reach the already-running instance. When
 * the live evidence was captured, this is how the recorded output was tied back
 * to the current revision: same script, same Session routes, same renderer.
 *
 * The script below is the one used in the acceptance run; the live tool error
 * recorded in `verification/deny-live-tool-error.txt` is this output prefixed
 * with the harness's own `Error: `.
 */
import { __test } from '../index.js'

const allowed = [
  { provider: 'passion8', model: 'grok-4.7' },
  { provider: 'pinaic', model: 'deepseek-v4.1-flash' },
  { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
]

const script = `const out = await agent('Reply with exactly: ok.', { provider: 'acme', model: 'nope' })\nreturn { got: out }`

const config = __test.validateConfig({}).value
const judged = __test.scanRouteProperties(script).map((candidate) => __test.judgeCandidate(candidate, allowed))
const violations = judged.filter((item) => item.verdict === 'violation')

if (violations.length === 0) {
  console.error('expected a violation for acme/nope; got', JSON.stringify(judged))
  process.exit(1)
}
console.log(__test.denyReason(config, violations, allowed))
