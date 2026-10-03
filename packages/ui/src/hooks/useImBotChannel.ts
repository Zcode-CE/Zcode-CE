/**
 * IM 机器人通道 hook（ce.5）：为远控面板产出 RemoteControlImBotChannel 与 BotsDialog 开闭状态。
 *
 * 为什么独立成文件而不是塞进 useRemoteControlWiring：
 * - wiring 的既有契约是「webService 状态靠 changed 广播回显，不轮询」
 *   （remoteControlPanel.test.ts 的「接线 hook：靠 changed 广播回显，不轮询」钉住）。
 *   而 IBotsService 没有事件/广播面（只有 getStatus() 拉取，BotsDialog 自己也是 2s 轮询），
 *   bot 状态只能轮询。把轮询放进独立 hook，两条纪律各自成立、不会互相污染：
 *   webService 状态仍走广播；bot 状态在面板打开期间轮询（关闭期间不轮询，不为一个徽标常驻开销）。
 *
 * onEnable 的落点是打开 BotsDialog（bot 管理面）——「同意后即可使用」要求同意动作落点是
 * 真实能力（建 bot / 配渠道 / 扫码绑定 / 授权 / 启停），不是空操作。
 *
 * BotsDialog 开闭状态刻意放在宿主层而不是 BotsDialog 组件局部：133 报告 B1 实测过
 * 组件局部状态随 TabsContent/DialogContent 卸载归零、形成「回到确认界面」的闭环。
 */
import { useEffect, useState } from "react";
import { useOptionalServices } from "@/hooks/useServices.js";
import type { RemoteControlImBotChannel } from "@/remoteControlPanelModel.js";
import { logger } from "@/logger.js";

interface UseImBotChannelResult {
  imBot: RemoteControlImBotChannel | null;
  botsDialogOpen: boolean;
  setBotsDialogOpen: (open: boolean) => void;
}

export function useImBotChannel(options?: { active?: boolean }): UseImBotChannelResult {
  // Web/旧 host 不提供 botsService 时为 null ⇒ 「IM 机器人」标签页整块不渲染。
  // 注意断连远端的 services 是 Proxy 兜底（任何 key 都返回拒绝代理），调用会失败而非静默成功。
  const services = useOptionalServices();
  const botsService = services?.botsService;
  const active = options?.active ?? false;

  const [botsDialogOpen, setBotsDialogOpen] = useState(false);
  const [botEnabled, setBotEnabled] = useState(false);

  // 只在远控面板打开时轮询；BotsDialog 打开期间自己以同节奏轮询 getConfig/getStatus。
  useEffect(() => {
    if (!botsService || !active) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const status = await botsService.getStatus();
        if (!disposed) setBotEnabled(status.enabledBotsCount > 0);
      } catch (error) {
        // 读不到状态按「未启用」展示（fail-closed），不谎报已启用。
        logger.warn("[remoteControl] 读取 Bot 状态失败", error);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [active, botsService]);

  const imBot: RemoteControlImBotChannel | null = botsService
    ? {
        status: botEnabled ? "enabled" : "disabled",
        onEnable: () => {
          // 同意动作的落点：打开 Bot 管理面（状态提升到宿主层，切页/关面板不丢）。
          setBotsDialogOpen(true);
        },
      }
    : null;

  return { imBot, botsDialogOpen, setBotsDialogOpen };
}
