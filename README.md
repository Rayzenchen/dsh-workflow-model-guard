# dsh-workflow-model-guard

> **工作流子智能体模型护栏** · [English](README.en.md)

让「子智能体」插件里那份**「允许选择的模型」白名单**，也管到 `workflow` 这条派子代理的路上。

Host 半边、无 Client 半边。**零配置即可用**；所有旋钮都有默认值。实测 DSH 版本：`0.2.2-rc.5`。

## 安装

从 GitHub 安装（设置 → 插件，填入安装 spec）：

```
github:Rayzenchen/dsh-workflow-model-guard
```

已经用 `link:` 装在本地 profile 里的，**不要**再装 GitHub 这一份。本地开发装法：把插件目录以
`link:/绝对路径` 加进 profile 的 `dsh.profile.bundles` 与 `dependencies`，在 profile 目录执行 `pnpm install`，
然后重启 DSH（Host 侧代码在启动时加载）。

白名单本身仍在官方「子智能体」设置页（允许选择的模型）里维护；本插件只负责把它延伸到 workflow 这条路上。

一句话：DSH 有两条「父代理派子代理」的路，白名单原来只管其中一条；本插件把另一条也补上——
软层让模型**先查再选**，硬层在它没查就写错时**当场拦下并告诉它怎么改**。

---

## 1. 痛点与诊断

### 症状

某轮任务里，主管代理用 `workflow` 指定 `deepseek-official/deepseek-flash` 派子代理，而这条 LLM
通道当时不可用——**上百个子代理静默失败**。白名单本来能拦住这种错误选项，但它管不到这条路。

### 诊断：两条路，只有一个关卡

| | 路 A：`subagent` 工具 | 路 B：`workflow` 工具的 `agent()` |
|---|---|---|
| 谁实现 | `@deepseek-ai/dsh-tool-subagent` | `@deepseek-ai/dsh-workflow-ptc` |
| 白名单 | **有**：`assertAllowedModelSelection()`，越权报 `child LLM route "P/M" is not allowed for this Session` | **没有**：grep `allowedModels` / `modelSelectionPolicy` / `not allowed for this Session` 在 `dsh-workflow-ptc` + `dsh-tool-workflow` 命中 **0 次** |
| 路由怎么传下去 | 校验后才建子代理 | `agent()` 收下 `provider`/`model` → `startChild()` → `ctx.subagents.start(provider, { agentOptions: { provider, model } })`，**中间没有任何策略校验** |
| 出错表现 | 抛错，模型看得见 | `agent()` **resolve 成 `null`**，`parallel()`/`pipeline()` 再把 `null` 变成该条目的 `null`——整个 run 报 `completed` |

本插件落地前实测（原样记录，见 §6）：

```
subagent(provider: 'deepseek-official', model: 'deepseek-flash')
  → Error: child LLM route "deepseek-official/deepseek-flash" is not allowed for this Session

workflow: agent('…', { provider: 'deepseek-official', model: 'deepseek-flash' })
  → workflow "route-probe-gap" completed (1 agent).  { "got": "null — child failed WITHOUT a policy error" }
```

同一个路由，路 A 拦、路 B 放——这就是那个洞。

### 白名单到底存在哪（两条路必须读同一份）

| 位置 | 内容 | 谁在用 |
|---|---|---|
| 设置插件 `@deepseek-ai/dsh-tool-subagent/model-selection-settings`，Host 服务名 `subagentModelSelection` | `current()` → `{ enabled, allowedModels }`；`enabled && 空列表` 时**故意抛错** | Settings UI / 新会话组装的取值来源 |
| **会话投影 `subagentModelSelectionPolicy`** | `[{provider, model}]`（**没有 enabled 字段，有值即启用**）；子会话继承；改设置不影响它 | `list_subagent_models` 过滤的就是它，路 A 校验的也是它 |

→ 本插件的读取顺序：**先读投影，读不到才回退服务**。两者不一致时以投影为准，因为它才是模型在
`list_subagent_models` 里看到的同一份。

投影为 `null`（本会话没捕获策略）时**不设限**——因为路 A 在这种会话里同样不限制。本插件的目标是
**与路 A 对齐**，不是另立一套更严的规矩。

---

## 2. 两层机制（都用官方现成扩展点）

| 强度 | 扩展点 | 模式 | 本插件做什么 | 官方先例 |
|---|---|---|---|---|
| 软 | `ctx.systemPrompt.section({ name, order, text })` | 有序段落，`text` **可以是函数**（按 agent 作用域、每请求求值），渲染为空串的段落会被 `renderPrompt` 丢掉 | 注入一段指导：要指定 `provider`/`model` 就**先调 `list_subagent_models`**、只从它返回的路由里选；不确定就不传，留空即继承父路由。并附上本会话当前允许的路由 | `dsh-tool-workflow` 自己（`tool:workflow` 段）、`dsh-agent-instructions`、`dsh-plan-mode`、`dsh-todo-discipline` |
| 硬 | `ctx.on('tools/pre-execute', (exec, next) => …)` | **waterfall**，默认 `{kind:'allow'}`；可返回 `{kind:'deny', reason}` / `{kind:'ask', reason}` / `{kind:'cancel'}` | 拦 `exec.name === 'workflow'`，静态读出脚本里 `agent()` 要的 `provider`/`model`，不在允许列表就 `deny`，reason 里点名非法路由、列出允许路由、给出两条出路 | `dsh-hooks-claude-code`（PreToolUse）、`dsh-experimental-auto-review`、`dsh-workspace-changes` |

**软层「只在 workflow 挂载时注入」怎么做到零成本**：段落的 `text` 是个函数，里面用
`ctx.tools.get('workflow', agent)`（agent 作用域查询，官方 `Tools.get(name, scope)`）判断这个 agent
能不能看见 workflow 工具；看不见就返回 `''`，整段从提示词里消失。所以**没装 workflow 的组合一个字都不付**。

同理，指导里点名了 `list_subagent_models`，所以只有在**该工具真的可调**时才注入——不会教模型去调一个不存在的工具。

### 硬层的 reason 长什么样（真实输出）

```
Blocked by the Session route policy: a workflow script may only hand a child agent a route from this Session's allowed list.

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

三件事齐了：**点名哪条不合法**（含行号与原文片段）、**列出允许的**、**给出两条可执行的出路**。
拦下来却不说怎么改，只会变成一次卡顿。

---

## 3. 硬层的边界与局限（请如实理解）

**这是一层启发式，不是保证。** 脚本是 JavaScript，路由可以在运行时算出来；任何静态读法都不完备。
本插件**从不求值**脚本，它只做词法扫描（识别字符串 / 模板串 / 注释 / 正则字面量，所以**字符串或注释里
写的 `provider: 'x'` 不会被误判成代码**），然后读**对象字面量**里的 `provider` / `model` 属性。

| 情形 | 行为 |
|---|---|
| `agent(p, { provider: 'a', model: 'b' })` 两个字面量 | **精确判定**：不在列表 → deny |
| 只给 `provider`（或只给 `model`），且这半边在任何允许路由里都不存在 | **可证明越权** → deny |
| 只给半边且这半边匹配某条允许路由 | 有效路由还取决于继承来的另一半 → **判定不了**（见下 `unresolvedRoute`） |
| 值是变量 / 带 `${}` 的模板串 / 条件表达式 | 静态读不出 → **判定不了**（见下 `unresolvedRoute`） |
| 路由写在脚本外（`args`、外部传入） | **完全看不见** |
| 脚本通过字符串拼接构造 `agent` 调用 | **看不见**（不是 `provider:` 属性语法） |

判定不了时默认 `unresolvedRoute: allow`，即**只拦能证明的**（宁可漏、不误伤）。想更严可以设成
`deny` 或 `ask`，代价是：用变量拼路由的合法脚本也会被拦/被问。

**真正的完备方案**是替换/包装 workflow 引擎（`ctx.workflowEngine`，官方 README 明说
"a hardened engine swaps in without touching what the model sees"），在 `startChild` 处对
`agentOptions` 做真正的校验——那里拿到的是**求值后的**最终 `provider`/`model`，且能连"只给半边"的
情况一起算清。本插件**没做**这件事，原因：引擎在 PTC 沙箱进程里派发子代理，替换它等于接管
run 生命周期、进度事件、取消与子代理回收，风险和体量都远大于一个护栏该付的成本。**记为后续工作**（§7）。

另外：硬层只拦**模型主动写出来的**路由。继承父路由（不传 `provider`/`model`）永远放行——那本来就不经过任何策略。

---

## 4. 本地开发装法（link:）

```bash
# 1) 插件目录（与其它 @local 插件同构）
#    /Users/wench/Documents/DS Harness/dsh-workflow-model-guard-plugin/
#      package.json  index.js  cordis.patch.yml  locale/{zh,en}.json  tools/self-test.mjs  README.md

# 2) 注册进 profile：~/.dsh/profiles/desktop/package.json 两处
#    dsh.profile.bundles   += "@local/dsh-workflow-model-guard"
#    dependencies          += "@local/dsh-workflow-model-guard": "link:/Users/wench/Documents/DS Harness/dsh-workflow-model-guard-plugin"

# 3) 链接进 profile
cd /Users/wench/.dsh/profiles/desktop && pnpm install
```

**不需要**在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里再写一条 `insert`：插件是 bundle，
它自带的 `cordis.patch.yml` 就会插入 `id: dsh-workflow-model-guard` 这一行（与 `index.js` 的
`name` 导出同名，这是硬性要求）。该文件里只留了一段说明注释；重复 insert 会让 composition 出现两条同名
row（不报错但冗余，与其它 5 个 `@local` 插件的约定不一致）。

**为什么挂在 profile 根、不塞进 `standard` 预设**：

1. 根级 row 的 context 是 untagged，`scopeTarget` 的过滤器（`if (tag === undefined) return true`）
   才会把 **agent 作用域**的 `tools/pre-execute` 事件送给它；塞进预设里拿不到。
2. `applyEntryPatches` 只能往带 `group: true` 的 row 里插，而 `preset-standard` 没有该标记，本来也塞不进去。

**生效时机**：desktop profile 是 live profile（`hmr` 行启用），bundle 选择与 row 变更会**当场重组**、
无需重启；但**插件 JS 代码的替换仍需重启进程**（HMR 只监听配置文件，Node 的 ESM 缓存按 URL 命中）。

---

## 5. 配置项

默认值即下表；要改就在插件目录的 `cordis.patch.yml` 里给那一行加 `config:`（**整个 config 会被替换，不是深合并**）。

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时两层都不挂 |
| `toolName` | `workflow` | 要管的工具名（workflow 工具自己的 config 也叫 `toolName`，改名时两边要一致） |
| `discoveryToolName` | `list_subagent_models` | 路 A 注册的发现工具名；指导只在它可见时才注入 |
| `injectGuidance` | `true` | 软层开关 |
| `enforceRoutes` | `true` | 硬层开关 |
| `unresolvedRoute` | `allow` | 读不出静态路由时怎么办：`allow` / `deny` / `ask` |
| `denyWhenPolicyUnreadable` | `false` | 允许列表**完全读不到**时是否 deny（默认放行：读不到就不猜） |

配置校验是 fail-loud 的：未知键、类型不对、枚举越界都会在加载时报 issue，而不是静默失效。

---

## 6. 验证方法

### 快循环（无需 Harness、无网络）

```bash
node tools/self-test.mjs     # 58 checks：静态扫描 / 判定 / 策略来源优先级 / apply() 两层行为
```

### 验收（在真实会话里）

1. **软层**：新会话里，当 workflow 工具可见时，系统提示词里应出现 `Workflow subagent model selection…`
   一段（含本会话允许路由）；workflow 工具不可见时该段渲染为空、整段不注入。
   *取证据*：会话日志的 `system/message` 记录里就是每步的完整系统提示词（`~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`，
   多帧 zstd，需逐帧解压）。
2. **硬层拒绝**：`workflow` 脚本里 `agent(p, { provider: 'X', model: 'Y' })` 的 `X/Y` 不在本会话允许列表
   → 该调用被 deny，reason 里点名 `X/Y` 并列出允许路由。
3. **硬层放行**：指定一条**在**列表里的路由 → 正常执行，子代理真的回话。
4. **不指定不受影响**：脚本完全不传 `provider`/`model` → 正常执行（继承父路由）。
5. **不误伤**：`subagent` 与其它工具不受影响；字符串/注释里的 `provider: 'x'` 不被误判；插件缺失或抛错时 DSH 仍正常启动。

逐条实际命令与原始输出见 **[VERIFICATION.md](./VERIFICATION.md)**。

---

## 7. 后续工作

1. **引擎级硬化（完备解）**：换掉/包一层 `ctx.workflowEngine`，在 `startChild(request)` 处对
   `request.provider`/`request.model` 与父路由合并后的**有效路由**做校验。这样"只给半边"、变量拼接、
   外部传入的路由全都拦得住，也能把 `unresolvedRoute` 这套妥协去掉。
   代价：接管 run 生命周期与 PTC 沙箱子代理的创建/回收，见 §3 末。
2. **把 `reasoning_effort` 也纳入**：workflow 引擎目前直接拒绝 `reasoning_effort` 选项
   （`agent() option "reasoning_effort" is not recognized`），等它支持后，白名单里的 effort 校验也该跟上。
3. **段落文案按语言本地化**：模型面向的系统提示词目前统一英文（与其它段落一致），
   如果将来 DSH 支持按语言渲染提示词，这里可以接上 `locale/`。

---

## 8. 许可证

MIT © 2026 Rayzenchen，见 [LICENSE](LICENSE)。
