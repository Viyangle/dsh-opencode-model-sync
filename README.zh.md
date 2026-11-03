# DSH OpenCode 模型同步

让 DSH 的模型选择器跟上 **线上的** OpenCode Go 模型目录。

DSH 的供应商目录是构建期快照。OpenCode 上线新模型（例如 `kimi-k3.1-pro`）后，模型已经在端点上可用，但选择器要等下一个 DSH 版本才会出现。这个插件补上这段空白：它从 `opencode.ai` 拉取目录，写入 `llm-pi-ai` 的设置节，于是新模型在同步后就能选，而不用等发版。

- 不重新构建 DSH、不改 `app.asar`、不写协议适配代码。
- 启动时同步、定时刷新，并提供手动触发的 agent 工具。
- 只写它自己管理的三条路由；其它 provider 和凭据一律不动。
- 幂等：目录没变化时不产生任何设置写入。

[English](README.md)

## 环境要求

| 要求 | 说明 |
| --- | --- |
| 带 `llm-pi-ai` 的 DSH | 在 DSH Desktop 44.7.0（`@deepseek-ai/dsh-desktop@0.2.1-rc.5`）上构建与验证。 |
| OpenCode API key | 默认读取 `OPENCODE_API_KEY` 环境变量，或 DSH 凭据服务里同名的条目。 |
| `llm-pi-ai` 供应商行 | 默认 profile 中的 `opencode-go` 路由即是。 |

插件不会把 key 写进日志、工具输出或设置文件。

## 安装

Release 由 `npm pack` 生成，附件名为 `dsh-opencode-model-sync-<version>.tgz`。
见[最新 Release](https://github.com/Viyangle/dsh-opencode-model-sync/releases/latest)。

### 通过插件管理器

1. 从最新 Release 下载 `.tgz`。
2. 作为 bundle 安装。在带插件管理器的 agent 会话里，用 `install_bundle` 指向下载文件的绝对路径（或解压后的目录）；DSH 插件页面中接受本地包路径的位置同理。
3. 按提示启用。支持 HMR 时立即生效，否则重启 DSH。

### 从本地目录

```text
install_bundle target: /绝对路径/dsh-opencode-model-sync
```

本地目录以链接方式安装，改动会在下次重新组合/重启时加载。

## 它创建了什么

插件按线上协议把目录分组，维护三条 provider 路由（位于 `llm-pi-ai` 设置节）：

| 路由 | DSH 协议 | 目录给出的端点 |
| --- | --- | --- |
| `opencode-go-chat` | `openai-completions` | `https://opencode.ai/inference/go/openai/v1` |
| `opencode-go-anthropic` | `anthropic-messages` | `https://opencode.ai/inference/go/anthropic/v1` |
| `opencode-go-responses` | `openai-responses` | `https://opencode.ai/inference/go/openai/v1` |

每条路由包含模型列表、上下文/输出上限、图片支持，以及从目录翻译来的推理档位。DSH 不支持的协议（目前是 Gemini 的 `generate-content`）会被跳过。

内置的 `opencode-go` 路由**不会被修改**。DSH 的适配器在路由级固定协议，而同一份线上目录横跨三种协议；把新模型塞进原路由就必须整条换协议，并丢掉会话头和目录兼容细节。保留原路由意味着现有的默认模型选择继续可用，而同步路由负责发现新模型。

## 使用

在模型选择器里选择 **OpenCode Go · Chat Completions**、**OpenCode Go · Messages** 或 **OpenCode Go · Responses** 下的任意模型。新目录条目会在下次同步后出现。

### 用 agent 工具手动同步

插件注册了一个工具：

```text
opencode_model_sync action=status
opencode_model_sync action=sync
opencode_model_sync action=sync dryRun=true
opencode_model_sync action=remove
```

- `status` — 最近一次尝试/成功时间、最近错误，以及每条生成路由当前的实时模型数。
- `sync` — 立即拉取目录；只写有变化的路由。
- `remove` — 从设置中删除三条生成路由。

## 配置

配置写在 bundle 行的 `config` 里，字段全部可选，默认值如下。

```yaml
- id: opencode-model-sync
  name: dsh-opencode-model-sync
  config:
    enabled: true
    syncOnStart: true
    intervalMinutes: 360
    modelsUrl: https://opencode.ai/zen/go/v1/models
    apiKeyEnv: OPENCODE_API_KEY
    routePrefix: opencode-go
    displayNamePrefix: OpenCode Go
    sessionId: 00000000-0000-7000-8000-000000000000
    retiredModels: drop
    excludeModels: []
    timeoutMs: 20000
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关闭后不注册工具、不同步。 |
| `syncOnStart` | `true` | 启动几秒后自动同步一次。 |
| `intervalMinutes` | `360` | 自动刷新间隔；`0` 关闭定时刷新。 |
| `modelsUrl` | `https://opencode.ai/zen/go/v1/models` | 目录端点。聊天 base URL 来自每条模型记录，不来自这个地址。 |
| `apiKeyEnv` | `OPENCODE_API_KEY` | 凭据引用 / 环境变量名。 |
| `routePrefix` | `opencode-go` | 三条路由的前缀（`<prefix>-chat`、`<prefix>-anthropic`、`<prefix>-responses`）。 |
| `displayNamePrefix` | `OpenCode Go` | 选择器里显示的前缀。 |
| `sessionId` | `00000000-0000-7000-8000-000000000000` | 网关要求的 `x-opencode-session` 头的值；生成路由上的所有会话共用。 |
| `retiredModels` | `drop` | `drop` 以线上为准；`keep` 保留从目录消失、但仍属于同一路由的模型。 |
| `excludeModels` | `[]` | 永不参与同步的模型 id。 |
| `timeoutMs` | `20000` | 目录请求超时。 |

请保持 `routePrefix` 稳定：改前缀会创建一组新路由，旧路由留在原地（用 `action=remove` 清理当前前缀）。

## 工作方式

1. 通过 `ctx.credentials` 解析 API key（失败则退回 Host 进程环境变量）。
2. 带 Bearer token 请求 `<modelsUrl>`。
3. 按协议翻译每条 `type: chat` 记录：上限 → `contextWindow`/`maxTokens`，图片模态 → `input: [text, image]`，推理档位 → `reasoningEfforts`（`none` 归一为 `off`）。
4. 按协议分组成路由，补上 `x-opencode-session`，并在 Chat Completions 上加 DSH 的 `thinkingFormat: deepseek` 兼容开关。
5. 与 `llm-pi-ai` 现有 provider 值比较，只有变化时才调用 `ctx.settings.update('llm-pi-ai', …)`。
6. 网络错误、HTTP 429、HTTP 5xx 会重试一次；某条受管路由的协议从目录消失时，在 `retiredModels: drop` 下自动 unset。

两条安全规则保证写入范围足够窄：同名但协议不同的 provider 会被拒绝覆盖；只删除能确认属于自己的路由。

写入走 DSH 的设置服务，因此 profile 补丁保持可读，pi-ai 适配器会在下一次请求前重建。

## 已知限制

- **不同步成本。** DSH 的 provider 配置没有 cost 字段；同步来的模型在用量面板里显示零成本。
- **内置 `opencode-go` 路由仍在。** DSH 自带的快照过期期间，同一个模型可能同时出现在原路由和同步路由下。
- **所有会话共用一个 session id。** 生成路由是手工声明的 provider，只有内置目录 provider 会收到 DSH 的每会话 `x-opencode-session` 头。固定值满足网关要求，但可能降低跨会话的上游缓存亲和性。
- **Gemini `generate-content` 模型被跳过**，因为 DSH 只实现 `openai-completions`、`anthropic-messages` 和 `openai-responses`。
- **只信目录元数据。** 如果 OpenCode 公布的上下文/模态有误，同步路由会继承同样的错误。

## 排障

| 现象 | 检查 |
| --- | --- |
| 状态里出现 `no API key` | 导出 `OPENCODE_API_KEY`，或在 DSH 凭据里以同名保存。 |
| HTTP 401/403 | key 存在但目录端点不接受。`403 unsupported_country_region_territory` 表示该模型在你的地区不可用，不是插件故障。 |
| HTTP 404 | `modelsUrl` 被改离 `https://opencode.ai/zen/go/v1/models`。 |
| 工具报 `llm-pi-ai settings entry is not available` | 当前 profile 的 `llm-pi-ai` 行被禁用或缺失。 |
| 同步后仍看不到新模型 | 先跑 `action=status`，看每条路由的实时模型数是否已更新；部分选择器会缓存到下一个会话。 |
| 设置冲突 | 插件会自动重试一次；持续冲突说明还有别的写入方在同时改同一节。 |

## 卸载

`plugin_manager action=remove_bundle target=dsh-opencode-model-sync`。如果还想删掉生成的 provider，先执行 `opencode_model_sync action=remove`。

## 开发

```bash
npm test          # 目录翻译的纯函数测试（node:test，无依赖）
npm run check     # 解析检查所有模块
npm pack          # 生成发布包
```

没有构建步骤：`index.js` 和 `lib/*.js` 就是发布模块。peer 依赖（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/schemastery`）由 DSH 运行时解析，不从 npm 安装。

## 许可证

MIT，见 [LICENSE](LICENSE)。
