import { useCallback, useMemo, useState } from "react";
import { Bot as BotIcon, GlobeIcon, RefreshCwIcon, SquareIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { cn } from "@/components/lib/utils.js";
import { RemoteControlConnectionSection } from "@/RemoteControlConnectionSection.js";
import { RemoteControlDevicesSection } from "@/RemoteControlDevicesSection.js";
import { RemoteControlServiceSection } from "@/RemoteControlServiceSection.js";
import { RemoteControlImBotTab } from "@/RemoteControlImBotTab.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  REMOTE_CONTROL_DEFAULT_TAB,
  REMOTE_CONTROL_FIRST_RUN_CONFIRM_TEST_ID,
  REMOTE_CONTROL_PANEL_BADGE_TEST_ID,
  REMOTE_CONTROL_PANEL_SAFETY_TEST_ID,
  REMOTE_CONTROL_PANEL_SERVICE_PLANE_TEST_ID,
  REMOTE_CONTROL_PANEL_START_TEST_ID,
  REMOTE_CONTROL_PORT_INVALID_TEST_ID,
  REMOTE_CONTROL_PANEL_STOP_TEST_ID,
  REMOTE_CONTROL_PANEL_TABS_TEST_ID,
  REMOTE_CONTROL_PANEL_TAB_IM_BOT_TEST_ID,
  REMOTE_CONTROL_PANEL_TAB_WEB_TEST_ID,
  REMOTE_CONTROL_PANEL_TEST_ID,
  DEFAULT_REMOTE_CONTROL_START_SCOPE,
  canRenderRemoteControlImBotTab,
  parseRemoteControlPort,
  resolveRemoteControlPanelView,
  shouldConfirmBeforeStart,
  withRemoteControlInFlight,
  type RemoteControlConnectionInfo,
  type RemoteControlConnectionsSnapshotOrUnknown,
  type RemoteControlImBotChannel,
  type RemoteControlPanelBranch,
  type RemoteControlPanelStatus,
  type RemoteControlPanelTab,
  type RemoteControlStartScope,
} from "@/remoteControlPanelModel.js";

/**
 * 远程控制面板（ce.3 · 切片 3）。
 *
 * 措辞红线（用户已纠正，不得回退）：面板说的是「在这台机器上开一个可被浏览器访问的
 * 工作台」，手机/另一台设备用浏览器操作这台机器上的工作台。不得写成
 * 「控制桌面端 / 接管桌面会话」—— 桌面端已连的远端 SSH/Docker 目标不会共享给浏览器
 * （那是窗口内连接注册表），承诺它是承诺一个不存在的能力。
 *
 * 三个结构性约束：
 * - 纯 props 驱动：本组件不读任何服务、不订阅 IPC、不拼令牌。带令牌的链接只从
 *   `connection` 进来（切片 4 接 `webService:connectionInfo`），因此能在真浏览器里
 *   用注入态渲染并做 DOM 断言（切片 1 已用同一办法）。
 * - 能力缺失 ⇒ 不渲染：由调用方用 `canRenderRemoteControlPanel` 门控整块；
 *   本组件没有 "disabled" 分支 —— 禁用按钮会承诺一个不存在的动作。
 * - 二维码只在有链接时出现：没拿到 `linkWithToken` 就不渲染二维码区域。
 */
export interface RemoteControlPanelProps {
  status: RemoteControlPanelStatus;
  /** 带令牌的链接；`null` = 当前没有可派发的链接（此时不渲染二维码）。 */
  connection?: RemoteControlConnectionInfo | null;
  /** 契约 §5 `webService:start`。首次确认弹窗由本组件负责（决策①）。 */
  onStart: (options: {
    scope: RemoteControlStartScope;
    /** 缺省 = 自动选空闲端口（spec §3.3 的默认）。 */
    port?: number;
  }) => void | Promise<void>;
  /** 契约 §5 `webService:stop`。 */
  onStop: () => void | Promise<void>;
  /**
   * 已连设备读面（ce.4）。`null` = 读不到（与「空数组 = 暂无设备」严格区分，
   * 见 remoteControlPanelModel.ts 的 RemoteControlConnectionsSnapshotOrUnknown）。
   */
  connections?: RemoteControlConnectionsSnapshotOrUnknown;
  /**
   * 断开动作（spec §6.4）。不传 ⇒ 断开按钮不渲染（能力缺失 ⇒ 不渲染）。
   */
  onRevokeConnection?: (input: { id: string } | { all: true }) => void | Promise<void>;
  /**
   * 令牌轮换（spec §6.4）。桌面专属：不传 ⇒ 整块不渲染。
   * 这是"Web 面板不暴露轮换入口"（决策④）的可执行形式。
   */
  onRotateToken?: () => void | Promise<void>;
  /** 用户已确认过「对局域网开放」的后果（决策①：只确认一次）。 */
  lanExposureConfirmed?: boolean;
  onLanExposureConfirmed?: () => void;
  /** 关闭面板；不传则不渲染关闭入口。 */
  onClose?: () => void;
  /**
   * IM 机器人通道（task-93）。可选，不传 ⇒ 「IM 机器人」标签页整块不渲染
   * （标签触发器与内容一起消失，不是渲染成一个点了没反应的按钮）。
   *
   * 为什么可选而不是必填：现有契约是纯注入式的，桌面宿主今天还没有这条通道；
   * 做成必填会逼调用方编一个假的 `onEnable`（切片 1 的教训：空动作必须如实标注，
   * 不能靠一个永远成功的回调掩盖）。
   *
   * fix.2 修订：上面这条"可选"的呈现方式变了。原先是"未注入也渲染启用按钮 +
   * 一句说明"，实测用户点「继续启用」后没有任何下一步（`channel?.onEnable()` 是空操作），
   * 关掉面板重开又回到同一个确认弹窗。改为按本仓既有纪律整块不渲染 ——
   * 判据见 {@link canRenderRemoteControlImBotTab}。
   */
  imBot?: RemoteControlImBotChannel | null;
  /**
   * 是否渲染面板内部的标题区（默认 true）。
   *
   * 宿主弹窗（`RemoteControlPanelHost`）自己渲染标题，传 false 避免同一个标题渲染两遍。
   * 默认 true 是为了不改变切片 3 验收壳的既有形态（它只渲染面板本体）。
   */
  showHeader?: boolean;
  className?: string;
}

export function RemoteControlPanel({
  status,
  connection,
  onStart,
  onStop,
  connections,
  onRevokeConnection,
  onRotateToken,
  lanExposureConfirmed = false,
  onLanExposureConfirmed,
  onClose,
  imBot,
  showHeader = true,
  className,
}: RemoteControlPanelProps) {
  const { intl } = useZCodeIntl();
  const t = useCallback((id: string) => intl.formatMessage({ id }), [intl]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 在途标记是渲染进程本地状态：start 最长可等 15s（WEB_SERVICE_READY_TIMEOUT_MS），
  // 期间必须让用户看出"正在开启"，而不是停在一个禁用的"开启"按钮上。
  const [inFlight, setInFlight] = useState<"starting" | "stopping" | null>(null);
  // 标签页是面板本地状态：它不是服务端事实，也不该被当成"用户在设置里选了哪条路径"。
  // 默认值来自 model 的唯一常量（"Web 控制默认开启" = 默认选中这一页）。
  const [activeTab, setActiveTab] = useState<RemoteControlPanelTab>(REMOTE_CONTROL_DEFAULT_TAB);
  // fix.2：没有真实通道实现 ⇒ 「IM 机器人」这一页整块不渲染（标签与内容一起消失）。
  // 判据由 model 的唯一所有者给出，组件不自己判一次 —— 两处判定会分家。
  const showImBotTab = canRenderRemoteControlImBotTab(imBot);
  const view = useMemo(
    () => withRemoteControlInFlight(resolveRemoteControlPanelView(status), inFlight),
    [inFlight, status],
  );

  // 监听范围与端口是面板本地状态（不是服务端事实）：它们表达"下次开启用什么"。
  // 运行中改它们不会生效（服务已在跑），因此 RemoteControlServiceSection 在运行中把两者锁定，
  // 只留"一键切回环"这一个真能生效的动作 —— 见该组件注释。
  const [scope, setScope] = useState<RemoteControlStartScope>(DEFAULT_REMOTE_CONTROL_START_SCOPE);
  const [port, setPort] = useState("");
  // 端口非法时拒绝启动（fail-closed）：静默退回自动选端口会让用户以为指定生效了，
  // 而复制出去的链接与他预期不符。
  const [portInvalid, setPortInvalid] = useState(false);

  const startService = useCallback(
    async (overrideScope?: RemoteControlStartScope) => {
      const requestedScope = overrideScope ?? scope;
      const parsedPort = parseRemoteControlPort(port);
      if (parsedPort === null) {
        setPortInvalid(true);
        return;
      }
      setPortInvalid(false);
      setInFlight("starting");
      try {
        await onStart({
          scope: requestedScope,
          ...(parsedPort === undefined ? {} : { port: parsedPort }),
        });
      } finally {
        setInFlight(null);
      }
    },
    [onStart, port, scope],
  );

  // 一键切回环：明确地"用回环重开"，而不是改一个不生效的下拉框。
  const switchToLoopback = useCallback(async () => {
    setScope("loopback");
    await onStop();
    await startService("loopback");
  }, [onStop, startService]);

  const runPrimaryAction = useCallback(async () => {
    if (view.primaryAction === "stop") {
      setInFlight("stopping");
      try {
        await onStop();
      } finally {
        setInFlight(null);
      }
      return;
    }
    // start / retry 共用同一条路：先过决策①的确认门（只在首次对局域网开放时弹）。
    // 判据读的是用户实际选的 scope，不是常量 —— 用户切到"仅本机"后不该再被拦一次。
    if (shouldConfirmBeforeStart(scope, lanExposureConfirmed)) {
      setConfirmOpen(true);
      return;
    }
    await startService();
  }, [lanExposureConfirmed, onStop, scope, startService, view.primaryAction]);

  const confirmStart = useCallback(async () => {
    setConfirmOpen(false);
    onLanExposureConfirmed?.();
    await startService();
  }, [onLanExposureConfirmed, startService]);

  return (
    <div
      data-testid={REMOTE_CONTROL_PANEL_TEST_ID}
      data-remote-control-branch={view.branch}
      data-remote-control-loopback={status.loopback ? "true" : "false"}
      className={cn("flex min-h-0 flex-col gap-4", className)}
    >
      {showHeader ? (
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-ui-lg font-semibold text-foreground">{t("remotePanel.title")}</h2>
            <p className="text-ui-base text-foreground-subtle">{t("remotePanel.subtitle")}</p>
          </div>
          {onClose ? (
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {t("common.close")}
            </Button>
          ) : null}
        </header>
      ) : null}

      {/*
        一个入口 + 两个标签页（task-93）：两条路径的问题不同、可执行的层面也不同，
        因此并列而不是合并。伞名仍是「远程控制」，两个页各自叫「Web 控制」/「IM 机器人」。
      */}
      <Tabs
        value={activeTab}
        onValueChange={(next) => setActiveTab(next as RemoteControlPanelTab)}
        data-testid={REMOTE_CONTROL_PANEL_TABS_TEST_ID}
        className="min-h-0 gap-3"
      >
        <TabsList variant="line" className="w-full justify-start">
          <TabsTrigger
            value="web"
            data-testid={REMOTE_CONTROL_PANEL_TAB_WEB_TEST_ID}
            className="flex-none gap-1.5"
          >
            <GlobeIcon aria-hidden="true" className="size-3.5" />
            <span>{t("remotePanel.tab.web")}</span>
          </TabsTrigger>
          {/* 能力缺失 ⇒ 连标签触发器都不渲染：留一个点进去空的页签同样是"承诺了不存在的东西"。 */}
          {showImBotTab ? (
            <TabsTrigger
              value="imBot"
              data-testid={REMOTE_CONTROL_PANEL_TAB_IM_BOT_TEST_ID}
              className="flex-none gap-1.5"
            >
              <BotIcon aria-hidden="true" className="size-3.5" />
              <span>{t("remotePanel.tab.imBot")}</span>
            </TabsTrigger>
          ) : null}
        </TabsList>

        {/*
          Web 控制页：现有面板内容原样搬进来，一个元素都没改。
          这是"不能少东西"的可执行证据 —— 切片 3 的全部 data-testid 与根属性保持原值，
          旧探针不重写一行也应仍全绿（实测见回传）。
        */}
        <TabsContent value="web" className="flex min-h-0 flex-col gap-4">
          {/* 服务面：启停 + 状态徽标。 */}
          <section
            data-testid={REMOTE_CONTROL_PANEL_SERVICE_PLANE_TEST_ID}
            className="flex flex-wrap items-center gap-2"
          >
            <Badge
              data-testid={REMOTE_CONTROL_PANEL_BADGE_TEST_ID}
              data-remote-control-badge={view.branch}
              variant={badgeVariant(view.branch)}
            >
              {t(view.badgeMessageId)}
            </Badge>
            <p className="min-w-0 flex-1 text-ui-base text-foreground-subtle">
              {t(view.adviceMessageId)}
            </p>
            <PrimaryActionButton
              view={view}
              label={t(view.primaryActionMessageId)}
              onClick={() => void runPrimaryAction()}
            />
          </section>

          {/*
            服务面控件（监听范围 / 端口 / 令牌轮换，ce.4）。running 时监听范围与端口被锁定
            （改了不生效，允许改就是承诺一个不存在的动作），只留"一键切回环"。
            令牌轮换不在此限：它是运行中才有意义的动作。
          */}
          <RemoteControlServiceSection
            scope={scope}
            onScopeChange={setScope}
            port={port}
            onPortChange={setPort}
            running={view.branch === "running"}
            loopback={status.loopback}
            onRotateToken={onRotateToken}
            onSwitchToLoopback={switchToLoopback}
          />

          {/*
            端口非法时如实说清并停在这里（fail-closed）：静默退回"自动选端口"会让用户
            以为指定生效了，而实际起的端口与他预期不符 —— 复制出去的链接也就是错的。
          */}
          {portInvalid ? (
            <p
              data-testid={REMOTE_CONTROL_PORT_INVALID_TEST_ID}
              className="text-ui-base text-destructive"
            >
              {t("remotePanel.listen.portInvalid")}
            </p>
          ) : null}

          {/* 失败块与连接面（地址/链接/二维码/复制）原样搬进 RemoteControlConnectionSection。 */}
          <RemoteControlConnectionSection view={view} connection={connection} />

          {/*
            已连设备（ce.4）。放在连接面之后、安全提示之前：它回答的是
            "现在谁连着"，紧接着"怎么让别人连进来"读下来最顺。
            读不到（null）与空数组由该组件自己区分，面板不替它判一次（两个所有者会分家）。
          */}
          {view.showConnection ? (
            <RemoteControlDevicesSection
              connections={connections ?? null}
              onRevoke={onRevokeConnection}
            />
          ) : null}

          {/* 常驻安全提示：不可关闭（spec §3.6 / §3.5 危险品口径）。 */}
          <section
            data-testid={REMOTE_CONTROL_PANEL_SAFETY_TEST_ID}
            className="flex flex-col gap-1 rounded-lg border border-border bg-surface px-3 py-2"
          >
            <span className="text-ui-base font-medium text-foreground">
              {t("remotePanel.safety.title")}
            </span>
            {/* 非回环运行时把「同网段可尝试连接」提到最前并加重 —— 这是本面板最要紧的后果。 */}
            {view.emphasizeLanExposure ? (
              <p
                data-remote-control-lan-warning="true"
                className="text-ui-base text-foreground-subtle"
              >
                {t("remotePanel.safety.lanExposure")}
              </p>
            ) : null}
            <p className="text-ui-base text-foreground-subtle">
              {t("remotePanel.safety.tokenIsTheOnlyBarrier")}
            </p>
            <p className="text-ui-base text-foreground-subtle">
              {t("remotePanel.safety.linkIsCredential")}
            </p>
          </section>
        </TabsContent>

        {/*
          IM 机器人页：默认关闭，启用前必须过确认弹窗（三条事实）。
          fix.2：只在通道真实存在时渲染。showImBotTab 为假时连 TabsContent 都不挂载 ——
          channel 传进去只会渲染一个没有宿主的「启用」按钮（点击是空操作，见 props 注释）。
          showImBotTab 为真时 TypeScript 已由类型谓词收窄 imBot，无需再写 ?? null。
        */}
        {showImBotTab ? (
          <TabsContent value="imBot" className="min-h-0">
            <RemoteControlImBotTab channel={imBot} />
          </TabsContent>
        ) : null}
      </Tabs>

      <FirstRunConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => void confirmStart()}
      />
    </div>
  );
}

function badgeVariant(branch: RemoteControlPanelBranch) {
  switch (branch) {
    case "running":
      return "secondary" as const;
    case "failed":
    case "untrusted":
      return "destructive" as const;
    default:
      return "outline" as const;
  }
}

function PrimaryActionButton({
  view,
  label,
  onClick,
}: {
  view: ReturnType<typeof resolveRemoteControlPanelView>;
  label: string;
  onClick: () => void;
}) {
  if (view.primaryAction === "none") return null;
  const isStop = view.primaryAction === "stop";
  return (
    <Button
      type="button"
      variant={isStop ? "outline" : "default"}
      size="lg"
      data-testid={isStop ? REMOTE_CONTROL_PANEL_STOP_TEST_ID : REMOTE_CONTROL_PANEL_START_TEST_ID}
      data-remote-control-primary-action={view.primaryAction}
      // 在途期间禁用：避免连点触发第二次 start/stop（阶段一不做取消）。
      disabled={view.inFlight !== null}
      // 粗指针（手机/平板）命中区 ≥44：与切片 1 入口同一机制。
      className="[@media(pointer:coarse)]:min-h-11"
      onClick={onClick}
    >
      {isStop ? <SquareIcon className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
      {label}
    </Button>
  );
}

/**
 * 首次启动确认弹窗（决策①）。
 *
 * 复用既有 `Dialog` 原语（与 `ConfirmDialog` 同一套），但不走 `confirmDialogStore`：
 * 那个 store 是全局单例、同时只允许一个待决请求，而面板自己需要持有"确认后要做什么"的
 * 局部状态。两者混用会让面板的确认在别处弹窗打开时被静默 dismiss。
 */
function FirstRunConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={REMOTE_CONTROL_FIRST_RUN_CONFIRM_TEST_ID}
        showCloseButton={false}
        className="sm:max-w-md"
      >
        <DialogHeader className="gap-2">
          <DialogTitle className="text-ui-lg font-semibold text-foreground">
            {t("remotePanel.confirm.startLan.title")}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-line pt-0.5 text-ui-base leading-6 text-foreground-subtle">
            {t("remotePanel.confirm.startLan.body")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-end">
          <Button type="button" variant="secondary" size="lg" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="button" size="lg" onClick={onConfirm}>
            {t("remotePanel.confirm.startLan.continue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
