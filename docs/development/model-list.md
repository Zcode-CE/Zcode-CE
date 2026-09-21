# 模型列表：删除内置模型与从 Provider 拉取

> 状态：已实现
>
> 本文面向在本仓库上工作的开发者，说明「模型列表」的两个用户可见行为：
> **删除内置模型** 与 **从 Provider 拉取模型**。两者都作用于设置页「模型供应商」分区。

## 1. 背景与产品规则

内置供应商配置（`config/provider/zcode-builtin.json`）会为每个 Provider 声明一组
`builtinModelIds`。这些模型随应用版本更新，用户可以：

- 单独启用/禁用某个模型
- 编辑模型的能力参数（上下文窗口、输入输出模态等）

但不能把它们从列表里去掉 —— 过去删除操作对内置模型直接抛错。这带来两个问题：

1. 用户用不到的内置模型永远占着列表和模型选择器。
2. 内置模型没有对应的 API Key 或权益时，它会以「配置不完整」的形态长期报错。

同时，添加模型的唯一路径是**手工输入模型 ID**，逐个填写能力参数。对自建网关、
OpenRouter、本地 Ollama 这类暴露了 `GET {base}/models` 的 Provider 而言，这属于重复劳动。

### 产品规则

| #   | 规则                                                                              |
| --- | --------------------------------------------------------------------------------- |
| R1  | 用户可以「删除」**任意**模型，包括内置模型；删除对用户而言不可区分来源            |
| R2  | 内置模型的删除是**隐藏**（记入个人配置的 `hiddenModelIds`），不是从内置模板中移除 |
| R3  | 被隐藏的模型同时从**设置页列表**和**模型选择器**中消失，即真正的删除语义          |
| R4  | 隐藏状态持久化在个人配置中，**应用升级 / 内置模板 revision 变化后仍然保留**       |
| R5  | 设置页提供「已隐藏的模型」入口，可以**恢复**任意被隐藏的模型                      |
| R6  | 内置模型的**重命名**仍然被拒绝（改名会让内置推荐配置的匹配规则失效）              |
| R7  | 「拉取模型」列出 Provider `models` 端点的返回结果，用户**勾选**后批量添加         |
| R8  | 拉取失败（网络 / 鉴权 / 响应格式）必须给出可读错误，且**不修改现有配置**          |
| R9  | 拉取只读取列表，不写入任何配置；写入仍然走既有的「添加模型」边界                  |

## 2. 状态所有者

隐藏集是**个人配置层**的字段，与 `personalModelIds`、`modelOrder` 同级：

```
config/provider/zcode-builtin.json          ← 内置层（只读模板，随版本更新）
        │  builtinModelIds
        ▼
<用户数据目录>/provider-config.json          ← 个人层（用户覆盖，升级不重置）
        │  hiddenModelIds / personalModelIds / modelOrder
        ▼
ProviderConfigResolver                      ← 唯一投影点
        │  过滤 hiddenModelIds
        ▼
ProviderSettingsView / ProviderRegistryView  ← 设置页与模型选择器消费的只读视图
```

**为什么放在个人层**：内置层由模板提供，任何写在内置层的删除都会在下一次模板加载时被重新注入。
个人层是用户自己的覆盖层，模板 `revision` 变化不会触碰它，因此隐藏集天然跨版本保留。

**唯一写入路径**：`ProviderConfigService.deletePersonalModel`（隐藏）与
`ProviderConfigService.restoreHiddenModel`（恢复）。两者都在同一个 Repository 事务内提交，
不通过「保存 Provider 草稿」这类通用入口，避免整份草稿覆盖其他编辑。

**唯一过滤点**：`ProviderConfigResolver.resolve`。resolver 是设置视图与执行 Registry 的
共同上游，在这一层过滤可以保证隐藏模型不会「从设置里消失但仍在模型选择器里可选」。

## 3. 接口

### 3.1 配置字段

`ProviderConfig` 新增一个稀疏字段：

| 字段             | 类型             | 层           | 语义                              |
| ---------------- | ---------------- | ------------ | --------------------------------- |
| `hiddenModelIds` | `string[]`，可空 | **仅个人层** | 该 Provider 下被用户隐藏的模型 ID |

内置层的 schema 明确排除该字段 —— 隐藏是用户状态，不是模板内容。

### 3.2 领域操作

| 方法                                       | 位置                       | 说明                                                                                          |
| ------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------- |
| `deletePersonalModel(providerId, modelId)` | `ProviderConfigService`    | 内置模型 → 记入 `hiddenModelIds`；个人模型 → 从 `personalModelIds` 移除。两种来源对调用方透明 |
| `restoreHiddenModel(providerId, modelId)`  | `ProviderConfigService`    | 从 `hiddenModelIds` 移除，模型重新出现在列表与选择器中                                        |
| `fetchProviderModels(providerId)`          | `IProviderSettingsService` | 读取 Provider 的 `models` 端点，返回候选模型列表。只读，不写配置                              |

### 3.3 拉取的端点推导

推导逻辑是纯函数，位于 `packages/shared/src/model-catalog.ts`，
**发请求在 Host 进程**（见下节）。三种 API 格式：

| `api.type`                | 端点                                                                       | 说明                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `openai-chat-completions` | `{baseUrl}/models`                                                         | OpenAI 兼容                                                                                          |
| `anthropic-messages`      | baseUrl 路径以 `/v1` 结尾时 `{baseUrl}/models`，否则 `{baseUrl}/v1/models` | Anthropic 的 models 端点在 `/v1` 下，而兼容网关的 baseUrl 通常不带 `/v1`（SDK 自行追加 `/messages`） |
| `openai-responses`        | `{baseUrl}/models`                                                         | Responses API 与 Chat Completions 共用 `/v1/models`                                                  |

用户可能把**完整请求地址**粘进 baseUrl（`.../v1/messages`、`.../chat/completions`、
`.../responses`）。推导前先剥离这些已知后缀，否则会得到 `.../v1/messages/models`。

鉴权头与 Provider 自身的请求保持同一套约定：

- `anthropic-messages`：`x-api-key` + `anthropic-version: 2023-06-01`，
  并额外带 `Authorization: Bearer`（Anthropic 兼容网关只认后者）
- 其余格式：`Authorization: Bearer`
- 用户配置的 `api.headers` 最后合并，可以覆盖默认头

响应解析兼容四种常见形状，统一归一化为 `{ id, displayName?, createdAt? }`：

```jsonc
{ "data":  [ { "id": "gpt-4o" } ] }                          // OpenAI
{ "data":  [ { "id": "claude-sonnet-4", "display_name": "…" } ] } // Anthropic
{ "models": [ { "name": "llama3:8b" } ] }                    // Ollama 等
[ "plain-id" ]                                               // 裸数组
```

### 3.4 为什么发请求在 Host 进程

UI 运行在 renderer（Electron 或浏览器）里，**不能**直接请求 Provider 的 `models` 端点：

1. **CORS**：浏览器会拦截跨域响应。OpenAI 明确不提供浏览器直连，Anthropic 需要额外的
   `anthropic-dangerous-direct-browser-access` 头。
2. **代理与证书**：Host 进程的出口走设置页配置的 `httpProxy` / `httpProxyNoProxy` /
   `httpProxyCaCertPath`，与模型请求同一条链路；renderer 的 `fetch` 走 Electron
   `defaultSession`，是另一套语义，用户在设置页配的代理不会生效。
3. **远程与移动端**：手机远控、远程 workspace 的浏览器不可能直连用户本机的
   `http://127.0.0.1:11434`。必须由**目标 Environment 的 Host** 代发。

因此 `fetchProviderModels` 是 `IProviderSettingsService` 的一个方法，
在 Host 侧用既有的 `ApiClient` 实现。它是纯读操作：不写配置，不进入 Registry 事务。

## 4. UI

设置页「模型供应商 → 某个 Provider → 模型」区域：

| 元素                 | 行为                                               |
| -------------------- | -------------------------------------------------- |
| 模型行的删除按钮     | 对**所有**模型可见（此前内置模型没有按钮）         |
| 「拉取模型」按钮     | 打开对话框，拉取候选列表，可多选，确认后逐个添加   |
| 「已隐藏的模型 (n)」 | 仅当 `hiddenModelIds` 非空时出现；展开后可逐个恢复 |

拉取对话框的交互状态：

- 加载中：显示进度
- 成功：列出候选，**已存在的模型默认不勾选并标注「已存在」**
- 失败：显示可读错误 + 「重试」；不关闭对话框，不写任何配置
- 全部已存在：提示「没有可添加的模型」

界面文案通过 i18n key 提供（`settings.modelProvider.modelCatalog.*`、
`settings.modelProvider.hiddenModels.*`），支持中英文；布局在窄屏下纵向堆叠。

## 5. 验收场景

| #   | 场景                                 | 期望                                         |
| --- | ------------------------------------ | -------------------------------------------- |
| A1  | 删除一个内置模型                     | 该模型从设置列表消失；重启后仍不出现         |
| A2  | 删除一个内置模型后查看模型选择器     | 该模型不可选                                 |
| A3  | 在「已隐藏的模型」中恢复             | 模型重新出现在列表与选择器，且仍可编辑       |
| A4  | 应用升级后（内置模板 revision 变化） | 隐藏集保留，被隐藏的模型仍不出现             |
| A5  | 删除一个个人添加的模型               | 从 `personalModelIds` 移除；不出现在隐藏集中 |
| A6  | 重命名内置模型                       | 仍然被拒绝（R6）                             |
| A7  | 拉取成功                             | 列出模型；勾选后添加成功，列表出现新模型     |
| A8  | 拉取时网络不可达                     | 显示可读错误；现有配置不变                   |
| A9  | 拉取时鉴权失败（401/403）            | 显示可读错误；现有配置不变                   |
| A10 | 拉取返回非预期格式                   | 显示「未返回模型」；现有配置不变             |
| A11 | 拉取结果全部已存在                   | 提示没有可添加的模型；不产生重复条目         |

## 6. 验证

```bash
pnpm typecheck
pnpm lint
pnpm test
```

回归测试覆盖：

- 端点推导：三种 API 格式 × 内置模板的真实 baseUrl × 完整请求地址后缀 × 非法输入
- 响应解析：四种形状 × 去重 × 空/异常输入
- 隐藏语义：删除内置模型写入隐藏集、恢复、模板更新后保留、个人模型走原路径
