# syntax=docker/dockerfile:1
#
# ZCode 无头服务端（headless server）本地镜像。
#
# 构建上下文是 **dist/zcode/**（不是仓库根）：那里由 `pnpm build:zcode` 产出
# `releases/<版本>/zcode-<版本>.tar.gz` —— 它就是无头/npm 形态的自包含分发包
# （bin/zcode.mjs、server/、web/、agent/、node_modules/ 全在里面）。
#
#   docker build -f Dockerfile -t zcode-headless:local \
#     --build-arg ZCODE_RELEASE=3.14.3-ce.2 dist/zcode
#
# 基础镜像必须是 **glibc**（Debian 系）。Alpine 是 musl，而本版内置的 node-pty 是 glibc 构建：
# 在 musl 上它能被装载，但创建终端时原生 fork() 会段错误（exit 139）并杀掉整个进程。
# 我们已在「创建终端之前」加了 libc 拦断并给出可操作错误（见 docs/operations/headless-server.md §10），
# 但终端功能在 musl 上因此不可用 —— 所以这里默认 Debian 系基础镜像。
ARG NODE_IMAGE=node:24-slim

FROM ${NODE_IMAGE}

ARG ZCODE_RELEASE=3.14.3-ce.2

# ADD 会自动解包 tar.gz ⇒ /opt/zcode/{bin,server,web,agent,node_modules}
ADD releases/${ZCODE_RELEASE}/zcode-${ZCODE_RELEASE}.tar.gz /opt/

# 非 root 运行；数据目录与工作区都留给挂载点。
# slim 镜像不带 passwd 的 useradd 时补装（保持镜像仍然精简）。
RUN set -eux; \
    if ! command -v useradd >/dev/null 2>&1; then \
      apt-get update; \
      apt-get install -y --no-install-recommends passwd; \
      rm -rf /var/lib/apt/lists/*; \
    fi; \
    useradd --uid 10001 --create-home --shell /usr/sbin/nologin zcode; \
    mkdir -p /data /workspace; \
    chown -R zcode:zcode /data /workspace

ENV ZCODE_DATA_BASE_DIR=/data \
    NODE_ENV=production

WORKDIR /workspace
USER zcode
EXPOSE 3030
VOLUME ["/data"]

# 健康检查：服务在听即算健康 —— 未带令牌访问 /api/server-info 应当是 401，带令牌应是 200。
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3030/api/server-info').then(r=>process.exit([200,401].includes(r.status)?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/opt/zcode/bin/zcode.mjs"]
# 默认对外监听（容器里绑回环 = 容器外连不上）。令牌必须由运行方注入：
#   命令行 --token=<值>（compose 会从 .env 插值）或令牌文件 ZCODE_SERVER_AUTH_TOKENS_FILE。
CMD ["--web", "--host", "0.0.0.0", "--no-open", "--workspace", "/workspace"]
