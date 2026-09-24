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

### 3.1 镜像体积（本机实测）

本版镜像**不发布到任何 registry**，需要你自己 `docker build`。构建前先知道它有多大：

| 项                                                       | 实测值                                      |
| -------------------------------------------------------- | ------------------------------------------- |
| **最终镜像** `zcode-headless:local`                      | **801 MB**（精确 800,941,581 B）            |
| 其中：基础镜像 `node:24-slim`                            | 330 MB                                      |
| 其中：分发包层（`ADD` 自动解包的 tar.gz，解包后 391 MB） | 391 MB（tar.gz 本身 78,754,447 B ≈ 76 MiB） |
| 其中：非 root 用户与目录初始化                           | 61.4 kB                                     |

**怎么自己量**：

```bash
docker build -f Dockerfile -t zcode-headless:local --build-arg ZCODE_RELEASE=<版本> dist/zcode
docker images zcode-headless:local                      # 看 SIZE 列
docker history zcode-headless:local --format "{{.Size}}\t{{.CreatedBy}}"   # 看逐层构成
```

**为什么这么大**：镜像里装的是**自包含分发包**（Node 运行时依赖 + agent bundle + web 面板资源 + glibc 版 `node-pty`），
不是一份薄薄的胶水层 —— 这是"解包即用、不依赖宿主环境"换来的体积。若在意体积，走 npm 形态（不产生镜像层）。

> 数字是**本机实测快照**（`node:24-slim` + `zcode-3.14.3-ce.2.tar.gz`，Linux x64）。
> 换基础镜像或换分发包版本都会变 —— 按上面的命令自己量，不要把这个数当常量。
> 镜像以 **非 root** 用户（uid 10001）运行；`ENTRYPOINT` 是 `node /opt/zcode/bin/zcode.mjs`，
> `CMD` 默认 `--web --host 0.0.0.0 --no-open --workspace /workspace`。

## 4. 数据在哪（卷）

- `/data`（named volume `zcode-data`）：设置、provider 凭据、任务库。**删卷 = 丢配置**。
- `/workspace`：你自己的工作区（bind mount 到你机器上的目录）。

容器内的数据根是 `ZCODE_DATA_BASE_DIR=/data`（`Dockerfile` 里写死，并带 `VOLUME ["/data"]`）⇒ 业务数据落在 `/data/.zcode/v2`。实测的目录形态：

```text
/data/.zcode/v2/tasks-index.sqlite          # 任务索引（会话列表）
/data/.zcode/v2/provider_config.json       # provider 配置与凭据
/data/.zcode/v2/certs/                     # 自签 CA
/data/.zcode/v2/runtime/                   # 运行时状态
```

不要把宿主机的 `~/.zcode` 直接挂进 `/data`：那会把宿主的凭据交给容器（见 §8）。

### 4.1 备份与恢复（可照做）

备份（先停容器 —— 任务库跑在 WAL 模式，运行中复制会得到撕裂的快照）：

```bash
docker compose stop                      # ① 先停，保证 WAL 已落盘
docker volume inspect zcode-ce_zcode-data   # ② 看卷的实际挂载点（可选，用于核对）
mkdir -p backup
docker run --rm -v zcode-ce_zcode-data:/data -v "$PWD/backup:/backup" alpine \
  tar czf /backup/zcode-data.tgz -C /data .  # ③ 打包整个卷
docker compose start                     # ④ 起回来
```

> 卷名是 `<compose 项目名>_zcode-data`。本项目目录名不是 `zcode-ce` 时卷名会不同 ——
> 用 `docker volume ls` 或 `docker compose config --volumes` 确认，别照抄。

恢复（三步，顺序不能反）：

```bash
docker compose down                      # ① 停掉并移除容器（不要加 -v，那会删卷）
docker volume rm zcode-ce_zcode-data     # ② 删掉旧卷（或先改名留底）
docker volume create zcode-ce_zcode-data
docker run --rm -v zcode-ce_zcode-data:/data -v "$PWD/backup:/backup" alpine \
  tar xzf /backup/zcode-data.tgz -C /data   # ③ 还原
docker compose up -d
```

实测：备份产出 `zcode-data.tgz`（空部署约 24 KB），还原后 `/data/.zcode/v2` 目录结构与权限位完整，服务照常启动、令牌仍有效。

### 4.2 ⚠️ 备份不可移植到另一台机器（真实的坑）

会话与工作区记录里存的是绝对路径。 任务索引库的 `tasks` / `workspace_registry` 表都有 `workspace_path` 列
（`packages/services/src/session/tasksDatabase/schema-v1.ts`），存的是**当时那台机器上的绝对路径**，例如：

```text
/home/alice/projects/api
/home/alice/.zcode/workspace/default
```

把这些记录还原到**另一台机器**上时：

- 路径**可能根本不存在**（用户名不同、目录布局不同、容器里的 `/workspace` 与宿主路径不同）；
- 即使路径存在，也**不保证是同一个项目** —— 服务会把它当成同一个工作区（`workspace_key` 就是路径本身，除非有 `workspaceIdentity`）；
- 表现是：**列表里出现点不开的工作区**，或**打开后看到的不是原来那个项目**。

⇒ **正确用法**：把备份当作同一台机器上的灾难恢复手段（换盘、重装容器、回滚误操作），
而不是迁移工具。跨机器搬数据请连同工作区目录一起搬，并在目标机上用同样的绝对路径挂载。

### 4.3 我们不提供什么（如实声明）

| 不提供                                  | 说明                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **导出 / 导入**（把数据在机器之间搬运） | 没有这样的命令或界面。备份就是"打包卷"，见 §4.1；跨机搬运的坑见 §4.2                                                                                                                                                                                                                 |
| **服务端同步 / 多实例共享数据**         | 没有。一个数据目录对应**一个**服务实例；两个实例同时写同一份任务库会互相破坏（WAL 依赖本机文件锁，见 [数据与配置](data-layout.md)）                                                                                                                                                  |
| **跨版本迁移**                          | 没有迁移工具，也没有降级路径。数据库迁移是**单向**的（`packages/services/src/session/tasksDatabase/migrations.ts` 按 id 显式分派，未知 id 直接抛错），**升级后不要再用旧版本打开同一个数据目录**。跨版本的协议兼容性也未测（见 [网页远控](../development/web-remote-control.md) §8） |

> 与 [数据与配置](data-layout.md) 的口径一致：那里说的"**无需任何迁移**"指的是**改产品身份（ZCode → ZCode-CE）不影响数据路径**，
> 不是说我们提供跨版本/跨机器的迁移能力。两件事不要混读。

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

### 8.1 ⚠️ 容器管不了没挂进去的目录 —— 这是容器边界本身，不是缺陷

最常见的困惑是："agent 在容器里看不到我机器上的某个目录。" 这是**容器的定义**：容器只能看到
**显式挂进去**的路径。不是配置漏了，也不是 bug —— 换成 Docker 就必然如此。

两条替代路径，按需求选：

| 你的需求                      | 该用哪条                                    | 怎么做                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 让 agent 管**几个**特定目录   | **① 显式多挂目录**（仍是容器形态）          | 在 `compose.yaml` 的 `volumes:` 下逐条加 `- /宿主机/路径:/workspace/名字`，然后 `docker compose up -d`。一个项目挂一个目录，保持"写范围 = 挂载"这条可审计的边界                                                       |
| 让 agent 管**主机上任意路径** | **② 用 npm 形态直接在主机上跑**（不要容器） | `npx zcode-ce --web …`（或解包后 `node bin/zcode.mjs --web`，见 [无头服务器](headless-server.md) §3）。它跑在主机上，因此能访问主机的文件系统 —— **代价是失去了容器这层边界**，agent 的写入范围变成服务进程的权限范围 |

**取舍说清**：容器给你的是**可审计的写范围**（= 挂载清单），代价是"没挂的看不见"。
主机形态给你的是**全盘可达**，代价是 agent 与你的其它进程同权限。**不要**为了图方便用 `-v /:/workspace` 把边界抹掉 ——
那等于用容器的复杂度换了一个没有边界的运行环境。

> 这条边界与本版已知限制一致（发版说明里也写了同一句）：**容器形态只能管理挂载进去的目录**。

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
