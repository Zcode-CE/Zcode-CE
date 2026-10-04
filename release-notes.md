# ZCode-CE

## 与官方 3.14.4 的关系（本版基线）

官方 3.14.4 与 3.14.3 之间的差异只集中在阿里云验证码的健壮性处理，协议、机器人、工作流与远程控制全部一致（分发包逐文件比对，新增差异为零）。本版据此把上游基线推进到 3.14.4，并落了其中两项与验证码相关的处理：

- **验证码初始化超时有了明确分类与可操作提示**（见「体验优化」）。
- **另一项只在配置合并路径出现的验证码头处理**：判定后确认本项目的配置结构不存在该路径，未做改动；同样的判定结论已写进维护者文档，避免后人重做分析。

官方另外两项验证码处理（初始化期排空排队请求、二十分钟新鲜度守卫）在本项目里没有对应的失效形态（本项目的请求处理是串行逐个应答、每次使用都重新加载），未引入。

## 新增功能

- **聊天输入栏左下角现在会提示「有可领取的额度」**：此前可领取的赠送额度只在设置页深处，用户往往不知道有活动可领。现在左下角在有可领取活动时出现入口，点开可以看到活动名称（例如「ZCode Trust Build」）、权益内容、有效期与领取按钮；领取需要验证码时在面板内直接完成；领取成功后界面立即显示新增的票券，无需重开页面。识别活动靠权益标识而非显示名，官方改活动的名字也不影响领取。
- **开始计划面板的余额旁边新增刷新按钮**：此前余额只在鼠标悬停时才会重新获取，现在可以随时点一下刷新。
- **新增 IM 机器人管理面板**：可以在桌面端创建机器人、绑定 IM 渠道（企业微信、钉钉、飞书、Lark、Telegram、Discord 等）、扫码完成账号绑定、给机器人授权可访问的工作区、配置允许使用的命令、以及启停或删除机器人。此前服务的开关只能改文件，现在同意使用的动作落在真实的界面上。机器人服务默认仍不开启，需要手动创建并启用。

## 体验优化

- **工作流的所有步骤完成后能正常结束了**：此前当本地数据写入失败（例如磁盘空间不足或文件被占用）时，即使全部步骤都已结束，整条运行也会一直显示「进行中」。现在写入失败会让该步骤如实显示失败，运行可以收尾。
- **验证码初始化卡住时给出明确提示**：领取额度的验证码如果初始化超时（页面或输入框一直不出现），现在会提示「验证码初始化超时，请重启应用或重载页面后重试」。此前这类超时被归为「挑战被拒」，提示内容会误导用户。

## 问题修复

- **本地储存的主题被外部修改后界面不再异常**：如果本地的主题条目被其他程序改成无效值，界面会掉到无样式的默认亮色。现在所有读取主题的地方都会校验，异常时回退到内置深色主题。
- **领取额度时不再偶发报「The WebView must be attached」**：此前在网页容器还没准备好的时刻发起领取，验证码求解会因为时序竞争而报错，重试通常要碰运气。现在求解会先确认页面就绪再开始。
- **macOS 版不再每次启动都报更新失败**：macOS 打包版此前每次启动都会去请求更新清单并收到 404。发版线暂不产出 macOS 安装包（没有代码签名），所以这个请求永远不可能成功。现在 macOS 正式包会跳过更新检查，改为明确提示「macOS 暂不支持自动更新，请拉取仓库源码本地构建（步骤见 README）」。
- **musl 系统上使用电脑控制时会明确告知不可用**：此前在 musl Linux（Alpine 系）上电脑控制能力会静默缺失。现在会直接说明该能力在 musl 环境下不可用，而不是表现为功能消失。
- **单文件可执行版现在带上了完整的内置技能与内容插件**：此前以单文件可执行形式运行时，内置技能包、computer-use 与 pdf 插件不在其中。现在这些内容随单文件可执行版一起提供。

## 升级须知（行为变化）

- **macOS 用户需要手动构建更新**：macOS 打包客户端不再自动检查更新。点「检查更新」会看到确定性提示，引导拉取仓库源码本地构建（README 有步骤）。配置了自建更新源的企业部署不受影响。
- **工作流在本地数据写入失败时现在会显示该步骤失败**：而不是一直显示「进行中」。如果你依赖「一直进行中 = 还在跑」这个现象，注意它现在会变成明确的失败结果。
- **左下角新增了领取入口**：没有可领取活动时不显示任何东西，有活动时出现。

## 已知限制

- **macOS 没有自动更新**：发版线暂不产 macOS 安装包，客户端侧的更新检查已关闭；每次新版本需要拉取仓库源码本地构建（README 有步骤）。
- **浏览器与手机网页版不能领取需要验证码的额度**：领取的验证码求解依赖客户端内嵌的网页容器，手机网页版与纯浏览器构建里没有它，会提示该操作不支持（不需要验证码的领取不受影响）。

## 本版尚未验证

- **macOS 的更新提示未在真实 macOS 客户端运行过**：本机没有 macOS 打包环境。可验证的点：macOS 打包版点「检查更新」能看到提示且日志里没有请求失败。
- **领取入口与验证码链路未在真实桌面窗口里完整走一遍**：界面与逻辑层都有覆盖，但没有在真实桌面应用窗口里从打开到领取成功逐屏操作过。
- **主题回退同样未在真实桌面窗口里看过**：只在界面层与逻辑层验证。
- **工作流写入失败的处理是注入式构造的**：真实长运行中的写入失败（磁盘满、文件锁）没有自然触发过验证。
- **单文件可执行版的插件载荷在打包环节逐项核对过**：但没有在真正打好包的单文件可执行程序里运行技能。

---

# English

## Relation to official 3.14.4 (the baseline of this version)

The difference between official 3.14.4 and 3.14.3 is confined to robustness handling for the Aliyun captcha; the protocol, bots, workflows and remote control are identical (file-by-file comparison of the distribution package showed zero new differences). This version therefore advances the upstream baseline to 3.14.4 and ports two captcha-related pieces of handling:

- **Captcha initialization timeouts now have an explicit classification and an actionable message** (see "Improvements").
- **A captcha-header handling that applies on the configuration-merge path**: after checking, this project's configuration structure has no such path, so no change was made; the same conclusion is recorded in the maintainer docs so nobody re-does the analysis.

Two further captcha handling pieces from upstream (draining queued requests during initialization, and a twenty-minute freshness guard) have no corresponding failure mode in this project (requests are handled serially with each one answered, and the SDK is reloaded on each use), so they were not introduced.

## New features

- **The chat input area now tells you when free quota can be claimed**: previously claimable promotional quota was buried deep in the settings page. When a claimable activity exists, an entry appears in the bottom-left corner; opening it shows the activity name (for example "ZCode Trust Build"), the entitlement, its validity period, and a claim button. Verification codes are completed in the same panel, and the new coupon shows up immediately afterwards without reopening anything. Activities are matched by entitlement identifier rather than display name, so renaming an activity does not break claiming.
- **A refresh button next to the balance in the start-plan panel**: the balance was only refetched on hover; now it can be refreshed on demand.
- **An IM bot management panel is now available**: create bots, bind IM channels (WeCom, DingTalk, Feishu, Lark, Telegram, Discord, etc.), complete account pairing by scanning a code, grant a bot access to workspaces, configure allowed commands, and start, stop, or delete bots. The "enable after consent" action now lives in a real interface instead of a config file. The bot service stays off by default until you create and enable one.

## Improvements

- **A workflow can finish once all of its steps are done**: previously, when local data writes failed (for example a full disk or a locked file), the whole run stayed "in progress" forever even after every step had ended. A failed write now marks that step as failed so the run can conclude.
- **Captcha initialization hangs now give a clear message**: when the verification code fails to initialize in time (the panel never appears), you get "Captcha initialization timed out. Please restart the app or reload the page and try again." Previously this was classified as a rejected challenge, which was misleading.

## Fixes

- **The interface no longer breaks when the locally stored theme is tampered with**: if another program writes an invalid theme entry, the UI used to fall back to an unstyled default light theme. Every place that reads the theme now validates it and falls back to the built-in dark theme.
- **Claiming quota no longer intermittently reports "The WebView must be attached"**: when a claim started in the moment before the embedded page was ready, the captcha solver failed due to a race; retrying usually succeeded by luck. The solver now waits for the page to be ready before starting.
- **The macOS build no longer fails the update check on every launch**: packaged macOS clients requested an update manifest and got a 404 every startup. The release pipeline does not produce macOS installers yet (no code-signing setup), so that request could never succeed. The packaged macOS app now skips the update check and states plainly that automatic updates are not supported on macOS and to build new versions from the repo source locally (steps in the README).
- **Computer use on musl systems now says it is unavailable**: previously the capability silently went missing on musl Linux (Alpine family). It now reports that it is not supported in musl environments instead of just disappearing.
- **The single-file executable now ships the built-in skills and content plugins**: built-in skills, computer-use, and the pdf plugin were absent when running as a single-file executable. They are now included.

## Upgrade notes (behavior changes)

- **macOS users need to build updates from source**: packaged macOS clients no longer check for updates. "Check for updates" shows a plain message pointing to the repo README's build steps. Deployments with a self-hosted update feed are unaffected.
- **A workflow now shows a failed step when local data writes fail**: instead of staying "in progress" forever. If you relied on "still in progress means still running", note that this now becomes an explicit failure.
- **A claim entry now exists in the bottom-left corner**: nothing is shown when there is nothing to claim; the entry appears when an activity is available.

## Known limitations

- **No automatic updates on macOS**: the release pipeline does not produce macOS installers yet and the client-side update check is off; each new version must be built from the repo source locally (steps in the README).
- **Quota claims that need a verification code are not possible in the browser or mobile web**: the claim captcha solver relies on the embedded page container, which the mobile web and plain browser builds do not have; they state that the operation is unsupported. Claims that need no verification code are unaffected.

## Not yet verified in this version

- **The macOS update message has not been run on a real macOS client**: no macOS packaging environment is available here. The checkable point: on a packaged macOS build, "Check for updates" shows the message and the log contains no failed request.
- **The claim entry and captcha path have not been walked through in a real desktop window**: interface and logic layers are covered, but not a full from-open-to-claimed pass in the real desktop app.
- **The theme fallback has likewise not been seen in a real desktop window**: verified at the interface and logic layers only.
- **The workflow write-failure handling was constructed by injecting failures**: a naturally occurring write failure during a long run (full disk, locked file) has not been triggered and verified.
- **The single-file executable plugin payloads were verified at the packaging step**: but skills were not exercised inside a truly packaged single-file executable program.
