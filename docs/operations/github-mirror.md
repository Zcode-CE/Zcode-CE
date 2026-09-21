# GitHub 加速配置（国内镜像）

> 状态：**已实施** · 面向使用与二次开发的说明

## 一、这个配置解决什么问题

部分网络环境直连 `github.com` 不稳定。受影响的是两类功能：

| 功能                         | 访问的 GitHub 端点       |
| ---------------------------- | ------------------------ |
| 插件市场安装（zipball 下载） | `api.github.com`         |
| 插件市场安装（Git 克隆回退） | `github.com`             |
| 更新检查                     | 由更新源决定（见第四节） |

配置「国内加速」后，上述 GitHub 请求会先经过你填写的镜像站。

**默认关闭。** 留空即直连 GitHub，不替用户选择第三方镜像站。

## 二、怎么配

设置 → 通用 → **国内加速**，填写前缀后保存，**重启应用生效**。

前缀格式为「路径前缀」，即镜像站地址直接拼在原始 GitHub URL 前面：

```
前缀：  https://ghfast.top/
原始：  https://github.com/owner/repo.git
结果：  https://ghfast.top/https://github.com/owner/repo.git
```

这是 ghproxy 系镜像站的通用格式。填写时注意：

- 必须以 `https://` 开头（`http://` 会被拒绝，避免仓库内容走明文链路）；
- 可以带子路径，例如 `https://mirror.example.com/github`；
- 结尾斜杠可有可无，保存时会自动归一化；
- 不要带查询串、`#` 片段或用户名/口令。

### 为什么只支持路径前缀

主流镜像站都是这种形态。域名替换方案需要镜像站自行实现 GitHub 的路由语义，且无法覆盖 `api.github.com` 这类子域，无法据此构造稳定 URL。

## 三、作用范围

**只改写 GitHub 自有域名的请求：**

| 域名                           | 是否套前缀 |
| ------------------------------ | ---------- |
| `github.com`、`www.github.com` | 是         |
| `api.github.com`               | 是         |
| 其它任何域名                   | **否**     |

非 GitHub 域名一律不受影响——配置加速不会把你的模型请求、字体 CDN 或自建服务流量导向镜像站。域名白名单是显式枚举而非 `*.github.com` 通配，避免未来新增的 GitHub 子域被自动导向第三方站点。

## 四、更新检查

更新链路的加速方式与插件市场不同。

插件市场是「固定 URL + 前缀」，而 electron-updater 的 GitHub provider 只接受 `{ owner, repo, host }` 三元组，**会丢弃 URL 的路径部分**，因此路径前缀对它无效。

更新链路改为支持覆盖更新源地址：

| 方式     | 示例                                                          |
| -------- | ------------------------------------------------------------- |
| 环境变量 | `ZCODE_UPDATE_FEED_URL=https://mirror.example.com/updates/`   |
| 启动参数 | `--zcode-update-feed-url https://mirror.example.com/updates/` |

**约束：正式包只接受 `https` 地址。** 更新产物会被下载并执行，允许明文链路等于让更新过程可被中间人替换。非 https 的取值会被忽略并在日志中记录一条 `warn`。

## 五、安全约束汇总

| 约束                     | 原因                                        |
| ------------------------ | ------------------------------------------- |
| 前缀必须为 `https`       | 避免仓库内容与更新产物走明文                |
| 前缀不得含用户名/口令    | 防止拼接结果被凭据段劫持                    |
| 前缀不得含查询串或片段   | 查询串会被拼到目标 URL 中间，破坏镜像站路由 |
| 只改写 GitHub 自有域名   | 避免把非 GitHub 流量导向第三方              |
| 非法值在保存时被拒绝     | 给出可读原因，而不是静默生效                |
| 非法值在运行时退化为直连 | 配置写错不应中断插件安装与更新检查          |

校验规则在设置页与配置 schema 中共用同一份实现，判定不会分叉；配置 schema 是最后一道闸，手工编辑配置文件同样拦得住非法值。

## 六、相关实现

| 位置                                                                    | 职责                               |
| ----------------------------------------------------------------------- | ---------------------------------- |
| `packages/shared/src/githubMirror.ts`                                   | 前缀校验、规范化与改写（唯一实现） |
| `packages/shared/src/validationAppSettings.ts`                          | 配置 schema 侧校验                 |
| `apps/zcode-cli/packages/adapters/src/plugins/github-archive-source.ts` | zipball 下载套前缀                 |
| `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts`           | Git 克隆套前缀                     |
| `apps/zcode-cli/packages/adapters/src/plugins/github-mirror-env.ts`     | 从子进程环境读取前缀               |
| `packages/ui/src/settings/GithubMirrorSetting.tsx`                      | 设置项与保存前校验                 |

## 七、与字体下载的关系

CJK 字体供给方案（见 [font-provisioning.md](./font-provisioning.md)）尚未实施。字体实现时应复用本节的 `applyGithubMirrorPrefix`：若字体从 GitHub Release 托管，前缀即可直接生效；从其它上游下载则不受影响。
