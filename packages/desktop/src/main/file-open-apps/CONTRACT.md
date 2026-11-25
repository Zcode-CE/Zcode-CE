# 文件关联应用

系统关联是唯一事实源。模块只接受本机真实文件；目录、远端身份和错误路径失败关闭。
查询不写入系统状态；默认标记来自系统，不从顺序推断。不透明应用 ID 不包含命令，打开时再次查询并匹配。
原生适配负责查询和启动；Windows 原生查询批量解析资源路径与带符号索引并返回有界 PNG，失败显式返回无图，不使用普通 EXE 文件图标冒充应用资源。macOS/Linux 仍由 IPC 调用方注入现有应用图标能力。图标失败不隐藏有效应用。
每次调用独立，没有跨工作区、文件或安装状态的持久缓存；不会创建 session、Host 或 Agent。

共享 WPS 启动器的 suite AppID 与当前 ProgID 分开保留；所有格式统一使用该 AppID 在 AppsFolder 登记的真实套件入口图标，保留独立 icon identity，不能回退 Writer 图标。名称与 public launch ID 不变，其它应用取图优先级不变。

## 可执行类文件的打开确认

经系统关联打开会执行文件的组合在启动前询问用户：当前平台的可执行类后缀（darwin 的 `.terminal`/`.command`/`.app` 等，win32 的 `.exe`/`.bat`/`.ps1` 等，linux 的 `.sh`/`.desktop`/`.run`/`.AppImage` 等，命中路径本身或其符号链接真实目标，后缀按 NFKC 归一化并忽略大小写），或 macOS 上把任意文件当脚本执行的终端/脚本编辑器应用（`darwin-bundle` 身份）。普通文档不询问。

判定只看平台后缀与关联应用身份，不看文件模式位：Linux 下 `.txt` 带可执行位仍按普通文件打开，系统不会执行它。用户取消时返回 `{ success: true, cancelled: true }`，不算失败、不启动应用；默认按钮与 Esc 都是取消。确认器由 main 注入，语言跟随当前界面语言。系统默认打开入口（`openPathInDefaultApp` 及其 file: URL 包装 `openFileUrlInDefaultApp`）复用同一判定。
