# ZCode-CE v3.14.3-ce.3.fix.1

## 问题修复

- **官方赠送额度（Start Plan）渠道无法使用**：使用该渠道时模型请求必然失败并报网关错误（错误码 3007），只能改用其它渠道或另开会话。根因是该渠道的模型请求经平台网关转发时会触发验证码校验，而客户端缺少「取得校验凭据并随请求发送」的完整链路；同时该错误被误判为鉴权失败，导致失败后无法自愈。现在补齐了这条链路：发起请求前取得校验凭据，被校验拦截时自动重新取得并重试一次。**校验过程需要你在界面上完成一次验证**（与官方客户端一致），桌面端与浏览器界面都支持。
- **切渠道后当前会话仍报错，只能新开会话**：上一轮失败会把会话的输入队列置为暂停态，而切换模型不会恢复它，于是同一会话里换渠道也不生效。现在切换模型会一并恢复队列。
- **无界面场景的失败方式**：IM 机器人等没有界面的场景无法完成验证，此前会静默等待到超时；现在会立即失败并给出明确原因。

## 已知限制

- **IM 机器人（Bot Channel）不支持 Start Plan 渠道**：验证码需要有人在界面上完成，机器人场景无法满足。官方闭源包同样不提供该能力。使用 Start Plan 时请用桌面端或浏览器界面。

## 本版尚未验证

- **浏览器界面的验证码求解未做真机验证**：加载路径与页面安全策略已按源码与官方实现核对（当前页面策略不限制脚本来源，不构成阻碍），但未在真实浏览器上完整走通一次求解。若你在浏览器里遇到该渠道的验证环节异常，请反馈。

# English

## Fixes

- **The official free-credit (Start Plan) channel was unusable**: every model request on that channel failed with a gateway error (code 3007), leaving you to switch channels or open a new session. The channel's requests are forwarded through a platform gateway that enforces a captcha check, and the client was missing the whole "obtain the verification credential and send it with the request" chain; on top of that, the error was misclassified as an authentication failure, so it could not self-heal. That chain is now in place: a credential is obtained before the request, and when the check rejects it the client obtains a fresh one and retries once. **The verification itself needs to be completed by you once in the UI** (same as the official client), and it works in both the desktop app and the browser UI.
- **Switching channels did not help within the same session — only a new session did**: a failed turn left the session's input queue paused, and switching models did not resume it. Switching models now resumes the queue as well.
- **How headless scenarios fail**: scenarios without a UI (such as IM bots) cannot complete the verification; previously they waited silently until timeout, and now they fail immediately with a clear reason.

## Known limitations

- **IM bots (Bot Channel) do not support the Start Plan channel**: the verification requires a person in a UI, which a bot cannot provide. The official closed-source package does not offer this capability either. Use the desktop app or the browser UI with Start Plan.

## Not verified in this release

- **The browser UI's captcha solving has not been verified on a real browser**: the loading path and the page security policy were checked against the source and the official implementation (the current policy does not restrict script origins, so it is not a blocker), but a full solve has not been walked through in a real browser. Please report it if you hit an issue with the verification step on this channel in a browser.
