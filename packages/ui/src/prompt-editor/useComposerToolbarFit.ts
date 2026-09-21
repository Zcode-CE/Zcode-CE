import { useLayoutEffect, useRef } from "react";

/**
 * 折叠阶梯：值越小越先被折叠（0 最先，3 最后）。
 *
 * 折叠是"按溢出量分档"而不是"逐个试到刚好放得下"——同一档里的控件一起折，
 * 保证同样的宽度永远得到同样的形态，不会因为测量顺序抖动。
 */
const COLLAPSE_STEPS = ["0", "1", "2", "3"] as const;

/**
 * 计算当前溢出量（px）。
 *
 * 两个来源取最大：
 * 1. leading-content 超出 leading-actions 容器 —— 左侧控件自己放不下；
 * 2. leading-content + trailing-actions + gap 超出整个 toolbar —— 左侧挤到了右侧
 *    发送按钮的地盘。只看 (1) 会漏掉这种情形：左侧内容还没超出自己的 flex 容器，
 *    但整行已经容不下它和发送按钮了。
 */
function measureOverflow(
  root: HTMLElement,
  available: HTMLElement,
  content: HTMLElement,
  trailing: HTMLElement | null,
  gap: number,
): number {
  const contentWidth = content.getBoundingClientRect().width;
  return Math.max(
    0,
    contentWidth - available.getBoundingClientRect().width,
    trailing
      ? contentWidth +
          trailing.getBoundingClientRect().width +
          gap -
          root.getBoundingClientRect().width
      : 0,
  );
}

/** 仅拥有 DOM 布局投影；权限、Plan 和 CUA 业务状态仍由原有 hooks 管理。 */
function fitComposerToolbar(root: HTMLElement) {
  const available = root.querySelector<HTMLElement>("[data-composer-leading-actions]");
  const content = root.querySelector<HTMLElement>("[data-composer-leading-content]");
  if (!available || !content) return;
  const controls = root.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]");
  if (!controls.length) return;
  // 每次从完整布局测量，避免各按钮独立 observer 互相抢空间，也覆盖语言与异步入口变化。
  delete root.dataset.composerModelIcon;
  delete root.dataset.composerProviderCompact;
  for (const control of controls) delete control.dataset.composerCompact;
  const trailing = root.querySelector<HTMLElement>("[data-composer-trailing-actions]");
  const gap = Number.parseFloat(getComputedStyle(root).columnGap) || 12;
  const overflow = () => measureOverflow(root, available, content, trailing, gap);
  // 阶梯：每档先看还溢不溢出，不溢出就停在上一档的形态。
  for (const step of COLLAPSE_STEPS) {
    if (overflow() <= 0) return;
    for (const control of controls) {
      if (control.dataset.composerCollapsePriority === step) {
        control.dataset.composerCompact = "true";
      }
    }
  }
  // 所有档都折完还放不下：模型按钮的 provider 前缀让位。
  if (overflow() <= 0) return;
  if (root.querySelector(".composer-provider-prefix")) {
    root.dataset.composerProviderCompact = "true";
  }
  if (overflow() <= 0) return;
  // 最后一级：思考档位退成图标，模型按钮再退成纯图标。
  const thought = root.querySelector<HTMLElement>("[data-composer-thought-control]");
  if (thought) thought.dataset.composerCompact = "icon";
  if (overflow() > 0) root.dataset.composerModelIcon = "true";
}

export function useComposerToolbarFit() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const update = () => {
      if (!root.parentElement || root.getBoundingClientRect().width <= 0) return;
      // 在不可见副本上尝试展开，避免真实按钮测量时来回移动、丢失 hover 或关闭 Tooltip。
      const probe = root.cloneNode(true) as HTMLElement;
      probe.setAttribute("aria-hidden", "true");
      probe.inert = true;
      Object.assign(probe.style, {
        position: "absolute",
        visibility: "hidden",
        pointerEvents: "none",
        width: `${root.getBoundingClientRect().width}px`,
        left: "0",
        top: "0",
      });
      root.parentElement.append(probe);
      try {
        fitComposerToolbar(probe);
        for (const key of ["composerModelIcon", "composerProviderCompact"]) {
          if (probe.dataset[key]) root.dataset[key] = probe.dataset[key];
          else delete root.dataset[key];
        }
        // 折叠态是 data-* 而不是宽度变量：逐个同步到真实节点，测量与渲染不会再分裂。
        const live = root.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]");
        const measured = probe.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]");
        live.forEach((control, index) => {
          const next = measured[index]?.dataset.composerCompact;
          if (next) control.dataset.composerCompact = next;
          else delete control.dataset.composerCompact;
        });
        const liveThought = root.querySelector<HTMLElement>("[data-composer-thought-control]");
        if (liveThought) {
          const next = probe.querySelector<HTMLElement>("[data-composer-thought-control]")?.dataset
            .composerCompact;
          if (next) liveThought.dataset.composerCompact = next;
          else delete liveThought.dataset.composerCompact;
        }
      } finally {
        probe.remove();
      }
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    const observe = () => {
      resize?.disconnect();
      resize?.observe(root);
      for (const element of root.querySelectorAll<HTMLElement>(
        "[data-composer-leading-actions], [data-composer-leading-content], [data-composer-trailing-actions]",
      ))
        resize?.observe(element);
      update();
    };
    // 不观察布局属性自身，防止写 data-composer-compact 引起递归测量。
    const mutations = new MutationObserver(observe);
    mutations.observe(root, { childList: true, subtree: true, characterData: true });
    observe();
    return () => {
      resize?.disconnect();
      mutations.disconnect();
    };
  }, []);
  return ref;
}
