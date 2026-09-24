# 无头服务端：Docker（本地构建，不推镜像）

> 本页讲**把无头服务端跑在 Docker 容器里**这条形态（ce.3 起提供本地资产）。
> 本版**不发布镜像到任何 registry**：镜像由你在本地 `docker build` 出来。
> 平台能力矩阵与「为什么必须 glibc」见 [headless-server.md](./headless-server.md) §10；本页只讲容器形态与实测。

## 1. 快速开始（compose，推荐）

```bash
# 1) 准备令牌（compose 会读同目录 .env）
printf "ZCODE_SERVER_TOKEN=%s\n" "$(openssl rand -hex 16)" > .env
: > tokens.txt        # compose 会把它挂成令牌文件（追加即可轮换，见 §6）

# 2) 构建 + 启动（首次会构建镜像，约几分钟）
docker compose up -d --build

# 3) 探活（本机）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3030/                                   # 200
TOKEN=$(grep -o "[0-9a-f]\{32\}" .env)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3030/api/server-info                   # 401（无令牌）
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3030/api/server-info?token=$TOKEN"    # 200
```

然后浏览器打开 `http://127.0.0.1:3030/?token=<令牌>`（首次访问带 `?token=` 即可，之后由 Cookie 记住）。

`compose.yaml` 的默认值是**保守的**：端口只发布到宿主回环（`127.0.0.1:3030:3030`）。

## 2. 手工构建与运行（不用 compose）

```bash
# 构建上下文是 dist/zcode/（`pnpm build:zcode` 的产物目录）
docker build -f Dockerfile -t zcode-headless:local \
  --build-arg ZCODE_RELEASE=3.14.3-ce.2 dist/zcode

docker run -d --name zcode \
  -p 127.0.0.1:3030:3030 \
  -v "$PWD/workspace:/workspace" \
  -v zcode-data:/data \
  zcode-headless:local \
  --web --host 0.0.0.0 --no-open --workspace /workspace --token="$(openssl rand -hex 16)"
```

第一次启动会在日志里打印访问地址（含令牌）：`docker logs zcode | head`。

## 3. 容器里有什么

| 路径                       | 内容                                                           |
| -------------------------- | -------------------------------------------------------------- |
| `/opt/zcode/bin/zcode.mjs` | 入口（runner）：解析参数、起服务、转发日志与信号               |
| `/opt/zcode/server/`       | 服务端（`entry-http.js` + 原生载荷 `node-pty`）                |
| `/opt/zcode/web/`          | 面板静态资源                                                   |
| `/opt/zcode/agent/`        | 内置 agent CLI（`zcode.cjs`，版本随包）                        |
| `/workspace`               | 工作区（默认工作目录，**挂进来**）                             |
| `/data`                    | 数据目录（= 容器内的 `~/.zcode`：设置、provider 凭据、任务库） |

镜像以 **非 root** 用户（uid 10001）运行；`ENTRYPOINT` 是 `node /opt/zcode/bin/zcode.mjs`，
`CMD` 默认 `--web --host 0.0.0.0 --no-open --workspace /workspace`。

## 4. 数据在哪（卷）

- **`/data`（named volume `zcode-data`）**：设置、provider 凭据、任务库。**删卷 = 丢配置**。
- **`/workspace`**：你自己的工作区（bind mount 到你机器上的目录）。

```bash
docker volume inspect zcode-ce_zcode-data      # 卷的实际位置（用于备份）
docker run --rm -v zcode-ce_zcode-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/zcode-data.tgz -C /data .    # 备份
```

**不要**把宿主机的 `~/.zcode` 直接挂进 `/data`：那会把宿主的凭据交给容器（见 §8）。

## 5. 从局域网 / 其它机器访问

两个条件缺一不可：

1. **容器内必须绑非回环地址**：`--host 0.0.0.0`。容器里绑 `127.0.0.1` 只对**容器自己**可见，
   宿主机与局域网都连不上 —— 这是最常见的"起了但打不开"原因。
2. **宿主端口要发布到非回环**：把 compose 的 `127.0.0.1:3030:3030` 改成 `"3030:3030"`（或指定网卡 IP）。

```bash
# 改了端口发布后
docker compose up -d
ss -ltnp | grep 3030            # 确认监听在 0.0.0.0 而不是 127.0.0.1
```

**明文 HTTP 的风险**：我们的暴露面提醒会警告"非回环 + 明文"（下发的 Cookie 不带 `Secure`，同网段可嗅探）。
跨网络请走 TLS 终结的反向代理/隧道，并透传 `X-Forwarded-Proto: https`。

## 6. 令牌与轮换

- **非回环必须带令牌**：不设 `--token` 又绑 `0.0.0.0` 时，runner 会在**解析参数阶段**就拒绝启动（fail-closed），
  因为服务端的 `/api/*`、`/ws`、`/ws/host` 对能访问该地址的人全部开放。
- **令牌来源**：`--token=<值>`（compose 用 `.env` 插值）、或令牌文件 `ZCODE_SERVER_AUTH_TOKENS_FILE`（与前者**取并集**）。
- **别把令牌打进镜像**：本页的两个示例都由运行方注入。

**轮换（实测）**：

```bash
# 方式 A（推荐，实测有效）：只改文件 + 把 HUP 送给 server 进程
printf "%s\n" "$NEW" >> tokens.txt      # 追加（见下方"陷阱"）
docker exec zcode sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < $p/cmdline | grep -q entry-http.js && kill -HUP ${p#/proc/} && break; done'
docker logs --tail 5 zcode | grep token-reload     # 审计事件 + "令牌文件已重载"
```

两个实测过的陷阱：

1. **`docker kill --signal=HUP <容器>` 到不了 server**：容器 PID 1 是 runner（`bin/zcode.mjs`），server 是它的子进程；
   PID 1 对未注册的信号按约定忽略 ⇒ 文件不会重载。要么用上面那条把 HUP 直接送给 `entry-http.js` 进程，
   要么**改 `--token` 重建容器**（`docker compose up -d --force-recreate`）。
2. **单文件 bind mount 会钉住 inode**：`printf "%s" > tokens.txt`（覆盖式）会新建 inode，容器里看到的仍是旧文件；
   必须**追加**（`>>`）或用目录挂载。

另外：`--token` 注入的令牌不受文件重载影响（它由命令行给出）；要一次性作废旧令牌，重建容器最干净。

## 7. 日志、健康检查、升级

```bash
docker compose logs -f --tail 100          # 服务日志（含审计事件）
docker inspect -f "{{.State.Health.Status}}" zcode-ce-zcode-1   # healthy
```

- 健康检查探的是 `/api/server-info`：**200 或 401 都算健康**（服务在听；无令牌本来就该 401）。
- **升级**：`docker compose build --no-cache --build-arg ZCODE_RELEASE=<新版本>` 后 `up -d`；`/data` 卷保留。
- **停止**：`docker stop` → 实测退出码 **0**、约 1 秒（runner 会优雅收尾）。

## 8. 安全边界（"更安全的 AI 编写环境"成立的前提）

**容器是外层边界**：宿主只把**你挂进去的目录**暴露给容器；容器里的 agent 的写入范围 = 这些挂载 + 容器内可写层。
这确实比"直接在宿主机上跑 agent"更有边界。

但**容器内没有沙箱**，请按事实理解：

1. agent 能**读写挂载进来的所有路径**（`/workspace` 与 `/data` 都算）；
2. agent 能**出网**（容器默认有网络）；
3. agent 能读到**挂载进来的凭据**：`/data` 里的 provider key、令牌文件等；
4. 因此 **`-v $HOME:/workspace` 这类整盘挂载会把"边界"直接抹掉** —— 只挂你愿意让 agent 改的那一个目录。

推荐做法：一个项目一个工作区目录；需要更大权限时显式再加一个挂载，而不是整盘挂家目录。

## 9. 为什么基础镜像必须是 glibc（不能用 Alpine）

本版内置的原生载荷（`node-pty`）是 **glibc 构建**。在 musl（Alpine）上：

- 服务与面板**能起来**（需自带满足 `engines` 的 Node，见 [headless-server.md](./headless-server.md) §10）；
- 但**终端功能不可用**：`pty.node` 在 musl 上能被装载，创建终端时原生 `fork()` 会**段错误（exit 139）**并杀掉整个进程；
  我们已在"创建终端之前"加了 libc 拦断并给出可操作错误（不会段错误），但这意味着**终端功能在这一形态下没有**。

所以 `Dockerfile` 默认 `node:24-slim`（Debian/glibc）。若你坚持用 Alpine：需要自装 Node ≥24、接受终端不可用，
并且该组合**不是本版承诺的形态**（详见 §10 的矩阵）。

## 10. 本页结论的实测证据（2026-09-24，Linux x64，Docker 29.8.0 rootless）

镜像：`node:24-slim` + `zcode-3.14.3-ce.2.tar.gz`（单阶段，非 root uid 10001），容器命令 `--web --host 0.0.0.0 --no-open --workspace /workspace --token=…`。

| #   | 实测项                     | 结果                                                                                                                                                                                        |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `GET /`                    | **200**（面板外壳）；面板资源 `assets/index-*.js` **200**                                                                                                                                   |
| 2   | `GET /api/server-info`     | 无令牌 **401**；带令牌 **200**（返回 `workspaces`/`capabilities`）                                                                                                                          |
| 3   | `GET /ws`                  | 无令牌 **401**                                                                                                                                                                              |
| 4   | 容器内终端                 | **可用**：以 uid 10001 在容器内 `pty.spawn("/bin/sh", …)` ⇒ `terminal-exit=0 output="PTY-HELLO\r\n10001\r\n/workspace"`                                                                     |
| 5   | 卷持久化                   | 在 `/data` 写标记 → `docker restart` → 标记仍在、服务 200、令牌仍有效                                                                                                                       |
| 6   | `SIGTERM`（`docker stop`） | **exit=0**，约 **1 s**                                                                                                                                                                      |
| 7   | 令牌轮换                   | 把 HUP 送给 `entry-http.js` 子进程 ⇒ 日志 `令牌文件已重载：/run/zcode-tokens ⇒ 3 条` + 审计 `token-reload`，新令牌 **200**；同一时刻 `docker kill -s HUP <容器>` **无效果**（见 §6 陷阱 1） |
| 8   | `compose` 路径             | `docker compose config/build/up` 全通；`/` 200、无令牌 401、带令牌 200；`down -v` 清理干净                                                                                                  |
| 9   | 健康检查                   | `healthy`（`start_period` 之后）                                                                                                                                                            |

## 11. 未验证 / 边界

- **未做**：把面板终端**经 `/ws` RPC 真点开**（需要客户端驱动 RPC）—— 第 4 项验证的是"容器内 pty 能开"，不是"面板上的终端面板点开过"。
- **未做**：镜像推送到 registry（本版明确不推）、多架构（arm64）镜像、GPU/CUA 相关形态。
- **未验证**：WSL 作为承载环境。
- 本页所有"✅ 已实测"都指上面的容器与版本组合；换基础镜像/换宿主后请自行复测。
