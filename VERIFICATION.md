# 验证记录 — dsh-workflow-model-guard

时间：2026-10-14 13:05–13:45（Asia/Shanghai）
环境：macOS，DSH 0.2.0-rc.2（asar 打包），profile `desktop`（live profile，`hmr` 启用），
本会话允许列表（会话投影 `subagentModelSelectionPolicy`）＝

```
- passion8/grok-4.7
- pinaic/deepseek-v4.1-flash
- opencode-go/deepseek-v4.1-flash
```

原始证据文件在 [`verification/`](./verification/)。**「已实测」与「读源码得出」在文中分开标注。**

---

## 0. 前置：复现「路 B 不受白名单管辖」

### 0.1 路 A 拦得住（`subagent` 工具）

```
subagent(provider: "deepseek-official", model: "deepseek-flash", prompt: "Reply with exactly the word: ok…")
```
输出：
```
Error: child LLM route "deepseek-official/deepseek-flash" is not allowed for this Session
```

### 0.2 路 B 不拦（`workflow` 的 `agent()`）——同一个路由

```js
// workflow 调用（meta: { name: "route-probe-gap", … }）
const out = await agent('Reply with exactly the word: ok. Do nothing else.',
  { label: 'route-probe', provider: 'deepseek-official', model: 'deepseek-flash' })
return { got: out === null ? 'null — child failed WITHOUT a policy error' : String(out).slice(0, 120) }
```
输出：
```
workflow "route-probe-gap" completed (1 agent).
Return value:
{
  "got": "null — child failed WITHOUT a policy error"
}
```
→ **洞确认存在**：同一路由，路 A 抛错，路 B 静默失败（`agent()` resolve 成 `null`）。
两条记录同属 `step=29`，原文见 [`verification/00-gap-reproduction.txt`](./verification/00-gap-reproduction.txt)。

---

## 1. 验收 1：软层生效（workflow 可用 → 有指导；不可用 → 注入为空）

### 1.1 正向：真实会话的系统提示词里出现了那段指导

DSH 会把每一步的完整系统提示词记进会话日志的 `system/message` 记录
（`~/.dsh/sessions/--Users-wench-Documents-DS~0020Harness--/session-7856a047-…/session.v4.jsonl.zstd`，
多帧 zstd，需逐帧解压——脚本见 §8.1）。

| 记录 | 时刻 | 系统提示词长度 | 含指导 |
|---|---|---|---|
| `seq=9` `step=1`（插件安装**前**） | 13:12 | 7796 字符 | **否** |
| `seq=413` `step=59`（插件挂载**后**） | 13:26 | 8484 字符 | **是** |

`step=59` 里那段（689 字符，原文见 [`verification/live-system-prompt-step59-guidance.txt`](./verification/live-system-prompt-step59-guidance.txt)）：

```
Workflow subagent model selection: this Session restricts which LLM routes a child agent may be given (the same list the `list_subagent_models` tool reports).
Before you pass `provider` or `model` to a workflow `agent()` call, call `list_subagent_models` and choose only from the routes it returns — a route outside this list is rejected before the run starts, and a route that is merely unavailable fails silently as `null` instead of raising.
If you are unsure, omit both `provider` and `model`: the child then inherits the parent Agent route, which is always allowed.
Allowed routes for this Session:
- passion8/grok-4.7
- pinaic/deepseek-v4.1-flash
- opencode-go/deepseek-v4.1-flash
```

### 1.2 反向：workflow 工具没挂载 → 一个字都不注入

在临时 `DSH_HOME` 里用 headless profile（`hl`）跑一次新进程，并把 `tool-workflow` 这一行 disable：

```bash
printf "\n- id: tool-workflow\n  disabled: true\n" >> $DSH_HOME/profiles/hl/cordis.patch.yml
DSH_HOME=/tmp/wmg-verify/home/.dsh WMG_PROBE_OUT=…prompt-hl-no-workflow.txt \
  "$DSH" --profile hl "Reply with exactly: PONG"
```

用一个一次性探针插件（`@local/wmg-probe`，挂在 `system-prompt/assemble` 上）导出装配结果：

```
$ grep -m1 '^tools=' prompt-hl-no-workflow.txt | tr ',' '\n' | grep -c workflow
0                                   # agent 的工具表里没有 workflow

$ grep -c 'Workflow subagent model selection' prompt-hl-no-workflow.txt
0                                   # 提示词里没有那段指导

$ grep -A1 '^--- section "tool:workflow:model-policy"' prompt-hl-no-workflow.txt
--- section "tool:workflow:model-policy" [0 chars]
```

→ 段落**仍注册**，但按门控渲染成 **0 字符**，被 `renderPrompt` 丢弃：整段不注入，成本为零。
原始导出见 [`verification/fresh-process-no-workflow-prompt.txt`](./verification/fresh-process-no-workflow-prompt.txt)。

### 1.3 门控的三种关闭条件（单元测试，最终代码）

`node tools/self-test.mjs` 里逐条断言：

```
workflow tool not mounted → section renders empty (nothing is injected)
discovery tool not mounted → section renders empty
no Session policy → section renders empty
injectGuidance: false → no section at all
```

---

## 2. 验收 2：硬层拒绝（不在允许列表 → deny，reason 可自助修复）

真实会话里调用 `workflow`（meta `guard-deny-test`，脚本里 `agent()` 指定 `acme/nope`）——
`acme` 是任意第三方，必然不在列表里。工具调用**被 deny，run 从未启动**：

```
Error: Blocked by the Session route policy: a workflow script may only hand a child agent a route from this Session's allowed list.

Not allowed:
- acme/nope — provider "acme" is not in the allowed list (line 1: provider: 'acme')

Allowed routes for this Session:
- passion8/grok-4.7
- pinaic/deepseek-v4.1-flash
- opencode-go/deepseek-v4.1-flash

Two ways to fix this, then call the workflow tool again:
1. Use only a route from the list above (call `list_subagent_models` to see the live list and each model's reasoning efforts).
2. Omit `provider` and `model` from that `agent()` call — the child then inherits the parent Agent route, which is always allowed.
```

原文：[`verification/deny-live-tool-error.txt`](./verification/deny-live-tool-error.txt)（会话日志 `tool/result` `seq=684` `step=104`）。
同一形状用 `deepseek-official/deepseek-flash` 也验过一次（`seq=418` `step=59`）。

**自足性检查**：reason 里同时含
① 点名非法路由（`acme/nope` + 行号 + 原文片段）、
② 允许路由全列表、
③ 两条出路（改用列表里的 / 不传让它继承）——三条断言在 self-test 里也有。

---

## 3. 验收 3：硬层放行（在允许列表里 → 正常执行）

```js
const out = await agent('Reply with exactly the word: ok. Do nothing else.',
  { label: 'in-list-route', provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
return { got: out === null ? 'null — child failed' : String(out).trim().slice(0, 40) }
```
输出：
```
workflow "guard-allow-test" completed (1 agent).
Return value:
{
  "got": "ok"
}
```
→ 子代理真的跑起来了并回了话，说明只是放行、没有把 run 弄坏。

---

## 4. 验收 4：不指定 `provider`/`model` 时不受影响（继承父路由）

```js
const out = await agent('Reply with exactly the word: ok. Do nothing else.', { label: 'inherited-route' })
return { got: out === null ? 'null — child failed' : String(out).trim().slice(0, 40) }
```
输出：
```
workflow "guard-inherit-test" completed (1 agent).
Return value:
{
  "got": "ok"
}
```

---

## 5. 验收 5：不误伤 / 稳健性

### 5.1 `subagent` 工具与其它工具完全不受影响

| 调用 | 结果 | 说明 |
|---|---|---|
| `subagent(opencode-go/deepseek-v4.1-flash)` | `ok` | 路 A 正常放行并跑通 |
| `subagent(deepseek-official/deepseek-flash)` | `Error: child LLM route "…" is not allowed for this Session` | 路 A 自己的报错，本插件没插手 |
| `subagent(pinaic/deepseek-v4.1-flash)` | `Error: no adapter registered for provider "pinaic"` | **关键交叉验证**：报错来自 line 504 的 adapter 预检，说明 line 500 的**策略校验已通过**——即本会话策略里确实有 `pinaic/deepseek-v4.1-flash`，与本插件 deny reason 里列出的 3 条路由**完全一致** |
| bash / read / write / workflow（无路由）等 | 正常 | 本会话全部后续操作都正常 |

### 5.2 字符串/注释/正则里的 `provider: 'x'` 不被误判

```js
// provider: 'deepseek-official', model: 'deepseek-flash'  <- 注释里的散文
const note = "pass provider: 'acme', model: 'nope' to agent() if you want a different route"
const re = /['"]provider['"]\s*:/g
log(note.slice(0, 20) + String(re.test(note)))
const out = await agent('Reply with exactly the word: ok. Do nothing else.', { label: 'no-false-positive' })
return { got: out === null ? 'null — child failed' : String(out).trim().slice(0, 40) }
```
输出：
```
workflow "guard-no-false-positive" completed (1 agent).
Return value:
{
  "got": "ok"
}
```
self-test 里另有 8 条同类断言（字符串 / 行注释 / 块注释 / 正则 / JSON-schema 里的 `provider` 属性 / 字符串拼接 …）全部为「不读成路由」。

### 5.3 插件缺失或抛错时 DSH 仍能正常启动

用一个**故意在 `apply()` 里抛错**的一次性插件 bundle 挂进同一个 profile：

```
dsh: warning: 1 entry did not activate
wmg-broken (@local/wmg-broken): Error: wmg-broken: deliberate plugin failure for the boot-tolerance test
    at new apply (file:///private/tmp/wmg-verify/broken-plugin/index.js:4:9)
    …
PONG
```
→ 失败的 entry 只报 warning，**进程照常启动、任务照常完成**。
原文：[`verification/boot-tolerance-throwing-plugin.txt`](./verification/boot-tolerance-throwing-plugin.txt)。

本插件自身的读全部包在 try/catch 里，失败即退化为「不干预」；self-test 断言了这些退化路径：

```
both authorities unreadable → "unreadable" (the caller decides)
default: an unreadable list does not block anything        # → allow
no authority at all → not governed (fail open)
a non-string script argument is left to the tool itself     # → allow
```

---

## 6. 最终代码的自检与「新进程加载」

```bash
$ cd "/Users/wench/Documents/DS Harness/dsh-workflow-model-guard-plugin"
$ node tools/self-test.mjs
58/58 checks passed
```

覆盖：静态扫描（12 例）→ 判定（含「只给半边」可证明越权 / 不可证明两类）→ 策略来源优先级（6 例：
投影优先、投影 null 不设限、投影抛错回退服务、两边都读不到 → `unreadable`、无权威 → 不干预）→
`apply()` 真实挂载后的两层行为（软层 5 例 + 硬层 10 例，含 `unresolvedRoute: deny|ask`、
`denyWhenPolicyUnreadable`、`enforceRoutes: false`）。

**新进程加载**：在临时 `DSH_HOME` 的 headless profile（`hl`）里，插件作为一个 bundle 被真实加载，
其段落出现在装配结果的正确位置：

```
$ DSH_HOME=… "$DSH" --profile hl --dump-config | grep -A1 dsh-workflow-model-guard
# == @local/dsh-workflow-model-guard
- id: dsh-workflow-model-guard
  name: '@local/dsh-workflow-model-guard'

$ grep -o '^--- section "[^"]*"' verification/fresh-process-prompt.txt
… "tool:workflow" / "tool:workflow:model-policy" / "tool:subagent" …
```
（该组合里 `list_subagent_models` 不可见——headless profile 没有 scoped preset，`tool-subagent` 起不来——
所以门控正确地把它渲染成 0 字符。）

---

## 7. 诚实说明：live 证据对应的代码修订

**已实测**：desktop profile 是 live profile，新增 bundle 与 row 会**当场重组**（无需重启）——
插件在 13:26 于运行中的宿主里挂载，上面 §2–§5 的 live 结果都来自那个实例。
但 **HMR 不重载插件 JS**（Node 的 ESM 缓存按 URL 命中，`hmr` 只监听配置文件），
所以 13:26 之后对 `index.js` 的修改**不会**进入那个实例。实测确认：给 deny 文案加了一个 `[rev-probe]`
标记后再次触发 deny，输出里**没有**该标记。

13:26 之后对 `index.js` 的改动只有三处：

1. `readAllowedRoutes()` 里「投影读取抛错 **且** 没有 Settings 服务」这一条边界，由
   `undefined`（不干预）改为 `'unreadable'`（交给 `denyWhenPolicyUnreadable` 决定）——
   **只在两个权威都读不到时可达**，不影响 §2–§5 任何一条路径；
2. 新增 `export const __test`（仅供 `tools/self-test.mjs`，纯附加）；
3. 删掉一处恒等的三元表达式（`x ? undefined : undefined`）。

为把这条缝隙钉死，用**最终代码**的渲染器重放同一次 deny 的输入，并与 live 输出逐字节比对
（重放脚本已收进插件：`node tools/deny-equivalence.mjs`）：

```bash
$ node tools/deny-equivalence.mjs > /tmp/deny-from-tool.txt
$ python3 …                                            # 从会话日志取 live 的 tool/result 原文
$ diff verification/deny-live-tool-error.txt verification/deny-rendered-by-final-code.txt
1c1
< Error: Blocked by the Session route policy: …
---
> Blocked by the Session route policy: …
```
→ **只差 harness 自己加的前缀 `Error: `**，其后 900 余字符逐字节相同
（断言脚本里写死 `live == 'Error: ' + final`，通过；`tools/deny-equivalence.mjs` 的输出与
`verification/deny-rendered-by-final-code.txt` 亦逐字节相同）。

---

## 8. 复现本记录用到的脚本

### 8.1 读会话日志（多帧 zstd）

```js
// /tmp/zframes.mjs —— 逐帧解压，因为 zstdDecompressSync 只吃第一帧
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
const raw = readFileSync(process.argv[2])
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
let text = ''
for (let i = raw.indexOf(magic); i !== -1; i = raw.indexOf(magic, i + 4)) {
  try { text += zstdDecompressSync(raw.subarray(i)).toString('utf8') } catch {}
}
for (const line of text.split('\n')) if (!process.argv[3] || line.includes(process.argv[3])) console.log(line)
```

### 8.2 临时 headless 验证环境

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
mkdir -p /tmp/wmg-verify/home/.dsh/profiles
ln -s /Users/wench/Documents /tmp/wmg-verify/home/Documents            # 让 profile 里的相对 link: 符号链接可解析
ln -s /Users/wench/.dsh/.credentials.yaml /tmp/wmg-verify/home/.dsh/.credentials.yaml
DSH_HOME=/tmp/wmg-verify/home/.dsh "$DSH" --profile hl --from-default-profile headless --dump-config
```

一次性探针插件（`@local/wmg-probe`）挂在 `system-prompt/assemble` 上，把每个 agent 的装配结果
（section 名 + 文本 + 工具表）写到 `$WMG_PROBE_OUT`。它是**验证用的一次性工具，不属于交付物**，
只存在于 `/tmp/wmg-verify/`，不在插件目录里。

> 注：`--profile desktop` 被 desktop-host CLI 硬拒（`profile "desktop" is managed exclusively by the
> Electron application`），所以 headless 验证只能跑**克隆/另建**的 profile；上面 §1.2 的 profile 即为此用。
