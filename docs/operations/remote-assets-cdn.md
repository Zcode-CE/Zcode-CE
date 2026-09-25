# 远程资产 CDN 运维手册

> 面向对象：维护本项目**公共发布点**的人。本文只讲**怎么管**（认证、日常操作、发布、排障）；
> 「为什么要这样设计、客户端怎么消费资产」见[远程工作区](../development/remote-workspace.md)。
> 本文出现的 `<bucket>`、`<域名>` 是占位符：**本项目的具体值不在仓库里**（见 §12）。
> 任何自建静态托管（对象存储 + 自定义域名、或任意静态服务器）都可以按本文操作。

---

## 1. 资产清单（这套东西由哪些部分组成）

| 项                         | 值 / 约定                                                                        |
| -------------------------- | -------------------------------------------------------------------------------- |
| 装配脚本                   | `scripts/assemble-remote-assets.mjs`（仓库内，产出**发布根**）                   |
| 上传脚本                   | `scripts/upload-remote-assets-r2.mjs`（仓库内；当前实现走 Cloudflare R2）        |
| 上传脚本（无头服务器载荷） | `scripts/upload-headless-release-r2.mjs`（同一桶/域名，另一套 key 布局，见 §14） |
| 上传公共机制               | `scripts/r2-upload-lib.mjs`（put/delete/列举/重试/缓存头口径，两个上传脚本共用） |
| 校验脚本                   | `scripts/verify-remote-assets.mjs`（仓库内，端到端，不需要真实 CDN）             |
| 装配暂存目录               | 仓库根 `.tmp/`（`.gitignore` 已忽略，可随时删除重装配）                          |
| R2 bucket                  | `<bucket>`（**不可列举、仅 GET**；不要开 `r2.dev` 公开访问）                     |
| 公开域名                   | `https://<域名>`（对象存储的自定义域名，走 CDN 边缘缓存）                        |
| 客户端基址                 | `https://<域名>` —— **= 发布根**（不要把版本号写进基址）                         |

请求链路：客户端 → `<域名>`（CDN 边缘，自带缓存）→ 对象存储 `<bucket>`。

**对象 key = 发布根内的相对路径**（这条是契约，客户端按它探测）：

```text
<appVersion>/manifest-<平台架构>.json      # manifest，客户端先探「基址/版本/」
<appVersion>/publish.json                  # 该版本的发布记录
components/<平台架构>/<组件>/v<版本>+<sha12>.tar.gz   # 内容寻址，跨版本共享
```

---

## 2. 认证与权限

当前实现（Cloudflare R2）**唯一必需的凭据是 wrangler 的 OAuth 登录**，不需要创建 S3 API token：

```bash
wrangler login      # 浏览器授权（首次或换人时）
wrangler whoami     # 确认账户与 Account ID 是否正确
```

- OAuth token 只留在本机的 wrangler 配置里（路径见 §12），**绝不要**把它复制进任何仓库文件、脚本或聊天记录。
- 已知限制：该 OAuth token **没有 cache purge 权限** —— 不能主动清 CDN 缓存，热修复依赖 manifest 的
  `max-age=300`（见 §6）。不要去找 purge 命令。
- **踩过的坑**：工作目录下 `.wrangler/cache/wrangler-account.json` 会缓存「上次用的账户」。
  换过账户/换人登录后，若 R2 命令报 `Authentication error [code: 10000]`，先检查这个文件里的 account id，
  不对就改成正确的（或删掉它让 wrangler 重新探测）。

---

## 3. 日常操作速查

```bash
# 身份
wrangler whoami

# bucket 列表 / 域名绑定状态
wrangler r2 bucket list
wrangler r2 bucket domain list <bucket>

# 对象：上传 / 下载 / 删除（<key> = 发布根内相对路径）
wrangler r2 object put <bucket>/<key> --file <本地路径> --remote \
  --content-type application/json --cache-control "public, max-age=300"
wrangler r2 object get <bucket>/<key> --remote --file /tmp/out.bin
wrangler r2 object delete <bucket>/<key> --remote -y
```

- **列举对象**需要 REST API（wrangler 4.x 没有 `r2 object list`），且要从本机凭据文件取 token ——
  具体命令见 §12 指向的本地私密笔记，**不要**把它写进脚本或 CI。
- 手工 `put` 只用于救急单文件；**正式发布一律走上传脚本**（它统一设置 Content-Type 与 Cache-Control，
  并在上传后自检）。

---

## 4. 发布新版本（标准流程）

前提：本机能跑 `wrangler whoami`；命令都在仓库根执行。

```bash
pnpm prepare:remote-assets                                   # 1. 生成（需外网一次；产物在 packages/desktop/mock-cdn/）
node scripts/assemble-remote-assets.mjs --out .tmp/r2-publish # 2. 装配发布根（自带 sha256 自检，失败即中止）
node scripts/upload-remote-assets-r2.mjs --root .tmp/r2-publish \
  --bucket <bucket> --public-base-url https://<域名>   # 3. 上传（4 并发 + 每对象 3 次重试 + 上传后逐个 HEAD 自检）
```

- 发**历史版本**（给旧客户端补托管）：加 `--version <版本号>` 逐个装配到同一 `--out` 根再上传；
  `components/` 内容寻址会自动去重复用，不必重复上传已存在的制品。
- **顺序很重要**：客户端指向该 CDN 后，用户拿到新版本就会立刻去取新资产 ⇒
  **先发布资产、再发版**。反过来会出现「版本已分发但资产还没有」的窗口期。
  上传失败**不应阻塞发版**（它是独立步骤，不是 CI 的发布门禁）。

发布后验收（可直接粘贴，`<域名>` 换成本项目域名）：

```bash
cd .tmp/r2-publish
# 全部 URL 探活：逐行列出文件路径并要求 200（< <(...) 写法让 fail 变量不丢在子 shell 里）
fail=0
while read -r u; do
  code=$(curl -sSI -o /dev/null -w "%{http_code}" --max-time 20 "https://<域名>/$u")
  if [ "$code" != 200 ]; then echo "BAD $code $u"; fail=1; fi
done < <(find . -type f | sed 's|^\./||')
[ $fail = 0 ] && echo "ALL_OK"
```

再加一次 sha256 抽查（下载远端组件与 manifest 声明比对）就完整了；本地端到端版本可以直接跑
`pnpm exec tsx scripts/verify-remote-assets.mjs`（不需要真实 CDN）。

---

## 5. 热修复与回滚

| 场景                     | 做法                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 同版本 manifest 有错     | 本地修正后重跑装配 + 重传。manifest 是 `max-age=300`，**最多 5 分钟**全球生效，无需 purge                                  |
| 某个组件制品损坏（罕见） | **不能**原地改写同 key（见 §10 红线）；正确做法：修正后重新装配出**新 sha12** 的新 key，manifest 指向新制品后重传 manifest |
| 整个版本作废             | 客户端侧靠发新版本号推进；桶里可保留旧版本（存储成本可忽略），确要清理用 `object delete` 逐个删                            |

---

## 6. 缓存与响应头约定（上传脚本已内置，勿手工偏离）

| 路径                                     | Content-Type               | Cache-Control                         | 同 key 可否改写 |
| ---------------------------------------- | -------------------------- | ------------------------------------- | --------------- |
| `components/**`（内容寻址）              | `application/octet-stream` | `public, max-age=31536000, immutable` | ❌ 绝不可以     |
| `<版本>/manifest-*.json`、`publish.json` | `application/json`         | `public, max-age=300`                 | ✅（热修复）    |

- 客户端按「**父级发布根 → 版本化路径**」的顺序探测组件，依赖**干净的 404**；
  不要在域名前加 Worker 重写/重定向，也不要把组件塞进版本目录（会导致每次连接先白跑一轮 404）。
- 新增别的文件类型时默认 `application/octet-stream`，缓存头按「是否内容寻址」同表判断。

---

## 7. 健康检查（日常巡检）

```bash
# 1) manifest 应 200
curl -sSI "https://<域名>/<版本>/manifest-linux-x64.json" | head -1

# 2) 缓存命中：组件应出现 cf-cache-status: HIT
curl -sSI "https://<域名>/components/linux-x64/node-runtime/v<版本>+<sha12>.tar.gz" \
  | grep -iE "^HTTP|cf-cache-status|^cache-control"

# 3) 404 行为：不存在路径必须返回纯 404（客户端探测依赖）
curl -sS -o /dev/null -w "%{http_code}\n" "https://<域名>/no-such-file.json"
```

若本机在用 fake-ip 代理，`dig` 会给出 198.18.x.x 之类的假地址，判断真实 DNS 时用 DNS-over-HTTPS 查询。

---

## 8. 故障排查（按症状）

| 症状                                             | 原因与处理                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| wrangler 报 `Authentication error [code: 10000]` | 账户缓存了别的账户（§2）→ 修正/删除该缓存文件；也可能是没登录 → `wrangler login`                                                      |
| `fetch failed` / `TLS unexpected eof`、时通时断  | 本机代理瞬断。重试即可（上传脚本已内置每对象 3 次重试）；持续不通则先换代理节点，再查 `https://api.cloudflare.com/client/v4` 是否可达 |
| 上传成功但客户端报 `manifest not found`          | key 层级错了：`<版本>/manifest-*.json` 必须在发布根第一层；用 §3 的列举方式对比本地 `find .tmp/r2-publish -type f`                    |
| 客户端报 manifest 无效（appVersion mismatch）    | 清单里的 `appVersion` 必须与客户端版本**逐字符相等**（含 `-ce.N` 后缀）；装配脚本已强校验，绕过脚本手传才会踩                         |
| 每次连接都先出现一轮 404 再成功                  | `components/` 被塞进了版本目录 → 它必须在**发布根**（客户端先探测父级 root）；重新装配                                                |
| 上传后改了文件但远端「没变」                     | manifest 受 5 分钟 `max-age=300` 限制，等 5 分钟或换网络验证；组件同 key 本就不允许改（§6）                                           |

---

## 9. 费用（以 Cloudflare R2 为例）

存储与**下载出流量免费**、按存储量 + Class A/B 操作计数计费：当前用量（数百 MB 存储、每版几十次写操作）
完全落在免费额度内（10 GB 存储 / 每月 1M 次 Class A / 10M 次 Class B）。按每版约 60 MB 增量估算，
免费额度大约够托管上百个版本。具体额度以 [R2 定价页](https://developers.cloudflare.com/r2/pricing/) 为准；
换别的托管商请自行核对出流量与请求计费。

---

## 10. 红线（交接必读）

> 无头服务器载荷（`latest.json` + `releases/<版本>/**`）与本节第 2 条**不同**：那批是
> **按版本号寻址**、允许同 key 覆盖重传的，口径见 §14。本节第 2 条只约束 `components/**`。

1. **域名一旦被写进已分发客户端的默认基址，就不可更换** —— 换域名 = 所有存量用户的远程功能瞬间失效。
   在把它设为默认之前，先确认你愿意长期维护这个域名（见 §11）。
2. **`components/**`同 key 永不改写**：key 内容寻址 +`immutable` + CDN 长缓存 + manifest 内 sha256
   三重依赖这个不变式；要换内容就换 key（新 sha12）。
3. **任何凭据不进仓库**：token 只留在本机凭据文件里；仓库内只允许出现 `<bucket>`、`<域名>` 这类占位符。
4. **正式发布只走脚本**（`assemble` + `upload`），它们保证布局自检、Content-Type、Cache-Control 与上传后自检；
   手工 `put` 只用于救急单文件，且必须带上与 §6 一致的头。
5. **不开对象存储的「公开测试域名」**（如 R2 的 `r2.dev`）：它限速且面向测试；对外只走自定义域名。

---

## 11. 它已经是客户端的**默认**基址（已决定：路线 A）

**决定（2026-09-23）**：走路线 A —— 在发布流水线里注入构建期默认基址，
**本仓库发布的安装包默认指向本社区 CDN、开箱可用**；源码里的常量默认值仍是官方 CDN，自建者行为不变。

语义已修正为「**值就是发布根**」：`ZCODE_CDN_BASE_URL`（构建期 define）与
`ZCODE_REMOTE_ASSET_CDN_BASE_URL`（运行期）都**按字面值**使用（`<值>/<版本>/manifest-*.json` +
`<值>/components/…`）；只有官方默认值保留它自己的 `/zcode/electron/releases/<版本>` 前缀。
（修正前构建期旋钮会被当父目录并追加前缀，与"发布根"契约矛盾；契约测试见
`packages/desktop/test/remoteCdnBaseUrl.test.ts`。）

配好方式：仓库 variable `ZCODE_CDN_BASE_URL` = 发布根（见 §12 的 CI 自动发布）。

历史备选（保留供参考）：

| 路线                        | 做法                                                                        | 代价                                                                             |
| --------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **A. 只在发布产物里设默认** | 在 release workflow 里设 `ZCODE_CDN_BASE_URL`（构建期注入），源码默认值不动 | 使用我们发布包的人开箱可用；自建者仍是官方默认。**域名会随产物公开**（不可避免） |
| **B. 用户自行指向**         | 文档教用户设 `ZCODE_REMOTE_ASSET_CDN_BASE_URL=https://<域名>`               | 零公开承诺、零可用性责任；但用户要自己动手，等于「功能存在但默认不可用」         |

选择 A 时同时接受：① 域名长期可用（红线 1）；② 资产必须先于版本发布；③ 上传失败不阻塞发版（§4）。
**不要把域名写死进源码**：源码里的默认值应当是「官方 CDN」，具体部署点在构建/运行期注入。

---

## 12. CI 自动发布（GitHub Actions，手动触发）

仓库发布流水线里有一个 **`upload-remote-assets`** job（`.github/workflows/release.yml`）：
生成 → 装配 → 上传（走本仓 `scripts/upload-remote-assets-r2.mjs`）→ 上传后逐个 HEAD 自检。

**部署方需要做的三件事**：

1. **建一个 R2 的 API token**（Cloudflare Dashboard → R2 → Manage API Tokens）：权限只需要
   **对象读写到目标桶**（`Object Read & Write`，作用域限定该桶；不要给账户级全权）。
2. **设三个仓库 secret**（Settings → Secrets and variables → Actions → **Secrets**）：
   `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`ZCODE_R2_BUCKET`。
3. **设一个仓库 variable**（同页 **Variables**）：`ZCODE_CDN_BASE_URL` = 发布根，**必须带协议**（如 `https://cdn.example.com`）。
   它同时被两条链路消费：**安装包的构建期默认基址**与**上传脚本的 HEAD 自检目标**。
   ⚠️ **只写域名（`cdn.example.com`）不算对**：构建期基址解析会**直接抛错**（`Invalid URL`），上传 job 的
   「上传后逐个 HEAD 自检」也会因 URL 非法而**全部失败** —— 结果是**上传已成功，但自检报失败**，
   这是最难排查的一类假信号。（上传脚本现在会在**上传前**就校验格式并明确报错，不再走到那一步。）

**为什么账号/桶名走 secret、发布根走 variable**：域名是公开信息（客户端要访问它）；
账户 ID 与桶名是**部署方私有标识**，写进仓库等于随公开仓库分发。本仓库任何文件都不出现它们。

**触发**：Actions → Release → **Run workflow**（只手动触发）。本地更快的方式（不跑 CI 构建矩阵）：
`pnpm prepare:remote-assets` → `node scripts/assemble-remote-assets.mjs --out <目录>` →
`node scripts/upload-remote-assets-r2.mjs --root <目录> --bucket <桶名> --public-base-url <发布根>`
（本机需先 `wrangler login`）。

**失败后果：不阻塞发版。** 该 job 只在手动触发时运行，tag 发版完全跳过它；资产也可随时补传
（客户端每次连接都会重新取清单）。顺序仍是「**先发资产、再发版**」——反过来用户第一次连远程工作区会因取不到清单而失败。

> 无 TTY 的 CI 里 wrangler 需要 `CLOUDFLARE_ACCOUNT_ID` 非交互解析账户；job 已设该环境变量，
> 并在上传前自检四个输入是否齐备（只打印缺失项**名称**，不打印值）。

---

## 13. 本项目的具体值在哪里

账户 ID、zone ID、bucket 名、客户端基址、本机凭据路径、列举对象的命令 —— **全部只写在本地私密笔记里**
（`.reverse/41-remote-cdn/PRIVATE-ACCOUNT.md`，该目录被 `.git/info/exclude` 忽略，不入库、不推送）。
本文刻意只用占位符，是为了让这份文档可以公开、也为了让别人照着它自建发布点。

---

## 14. 无头服务器载荷（`latest.json` + `releases/<版本>/**`）

**这是与 §1 并列的第二套布局**：同一个桶、同一个域名，但 key 的层级完全不同 ——
它服务的是 `install.sh`（无头服务器的一行安装脚本），不是远程工作区资产。

```text
latest.json                              # 版本索引（version + tarball + sha256）
releases/<版本>/zcode-<版本>.tar.gz      # 运行包
releases/<版本>/sha256.txt               # 校验摘要
```

`install.sh` 先取 `<BASE>/latest.json` 拿到 `version` 与 `tarball`，再取
`<BASE>/releases/<version>/<tarball>`（见 `scripts/zcode-distribution/installer.mjs`）。
所以 **`latest.json` 必须在运行包之后上传** —— 顺序反了会出现「索引指向一个还取不到的包」的窗口期。

### 14.1 与 `components/**` 的关键差异：寻址方式决定缓存头

| 路径                     | 寻址方式 | 同 key 可否改写 | Cache-Control                         |
| ------------------------ | -------- | --------------- | ------------------------------------- |
| `components/**`          | 内容寻址 | ❌ 绝不可以     | `public, max-age=31536000, immutable` |
| `<版本>/manifest-*.json` | 按版本号 | ✅（热修复）    | `public, max-age=300`                 |
| `latest.json`            | 按名字   | ✅（换版本）    | `public, max-age=300`                 |
| `releases/<版本>/**`     | 按版本号 | ✅（重新构建）  | `public, max-age=300`                 |

**`releases/<版本>/**`虽然带版本号，但绝不能用`immutable`**：同一个版本号重新构建后
内容会变（修复打包缺陷、补依赖），`immutable` 会让改过的包在 CDN 边缘永远取不到，
表现为「本地 sha256 对、用户装到的还是旧包」。

### 14.2 覆盖语义：不需要 `--clobber`

核实结论（wrangler 4.124）：`wrangler r2 object put` **没有** `--clobber` 开关
（它的 `--force`/`-y` 是数据目录校验提示，与覆盖无关），但 **put 本身就是覆盖语义** ——
实测同一 key 连传两次，第二次的内容生效。所以同版本重传不需要额外参数，
真正要守住的是上面那条缓存头口径。上传脚本默认按"允许覆盖"工作；
`--no-clobber` 可以改成"已存在就报错"（只想补传缺失对象时用）。

### 14.3 上传与保留最近 N 个版本

```bash
# 先看要传什么、要删什么（不写桶）
node scripts/upload-headless-release-r2.mjs --dist dist/zcode \
  --bucket <bucket> --public-base-url https://<域名> --keep-versions 10 --dry-run

# 真上传（自检通过后才动清理；清理需要 --yes）
node scripts/upload-headless-release-r2.mjs --dist dist/zcode \
  --bucket <bucket> --public-base-url https://<域名> --keep-versions 10 --yes
```

**上传后自检**（`--public-base-url` 必填，除非 `--dry-run`）：逐个 HEAD 确认可取，
再按类型 GET 校验内容 —— tar 走**流式 sha256**（不整份落盘）并与本地比对，
`latest.json` 比对 `version`/`tarball`/`sha256`，`sha256.txt` 逐字节比对。
只 HEAD 是不够的：HEAD 只证明"这个 key 上有东西"，证明不了内容是我们刚传的那份。

**保留最近 N 个版本**（`--keep-versions`，默认 10）：只删 `releases/<版本>/**`，
且**先列完整清单、再删**（dry-run 直接打印；真删需要 `--yes`）。三条不变式：

1. **`components/**`永不进候选** —— 那是内容寻址、跨版本共享的资产，删掉旧客户端直接连不上
远程工作区，且**无法恢复**。判定是纯函数`planVersionRetention`（在 `scripts/r2-upload-lib.mjs`），
由 `scripts/test/uploadHeadlessReleaseRetention.test.mjs` 用合成数据钉住。
2. **当前正在上传的版本无条件保留** —— 补传一个老版本时不会把自己删掉。
3. **只删远端确实存在的 key**（用列举结果，不是本地目录）；版本号按**数字分段**排序
   （`ce.10` 比 `ce.2` 新，字符串排序会排反 ⇒ 删掉最新的几个）。

`install.sh` 默认**不**上传（它是给用户自取的脚本，传上去会让"哪个 install.sh 是权威版本"
变成两个来源）；确需上传时加 `--include-install-sh`。

### 14.4 凭据

与 §2 同口径：只用本机 `wrangler login` 的登录态，**不需要** S3 API token。
脚本内部为"列举对象"读一次 `wrangler auth token`（wrangler 4.124 没有
`r2 object list` 子命令，只能走 REST API），但该值**从不落到 stdout/stderr、也不进 argv**；
脚本不读、不打印任何凭据。
