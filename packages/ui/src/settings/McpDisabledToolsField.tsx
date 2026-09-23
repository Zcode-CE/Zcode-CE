import { useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";

/**
 * MCP server 的工具级启停输入（`disabledTools`）。产品规则见
 * `docs/development/tool-policy.md`。
 *
 * 为什么单独一个文件：它是**低频**配置（绝大多数用户一个工具都不关），在表单里必须是折叠区；
 * 而 `McpServerForm.tsx` 已顶到 oxlint 的 max-lines 门禁（400 行），
 * 内联这段会让门禁失败 —— 与仓库既有的「拆分而不是加 disable」做法一致。
 *
 * 为什么工具名必须**手输**：关闭某个工具时用户往往连不上那个 server，而工具清单只能从活连接
 * `tools/list` 枚举。这个取舍与后续 UI 方案（快照 / 连接后枚举 / 手输 + 校验）记在
 * `docs/development/tool-policy.md` §6.1；提示文案必须让用户知道「名字要写成 server 报的那个」，
 * 否则拼错会静默不生效。
 */
export function McpDisabledToolsField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { intl } = useZCodeIntl();

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        className="flex items-center gap-1 text-ui-base text-foreground-subtle hover:text-foreground"
        aria-expanded={expanded}
        onClick={() => setExpanded((previous) => !previous)}
      >
        {intl.formatMessage({ id: "settings.mcp.form.disabledTools" })}
      </button>
      {expanded && (
        <div className="space-y-1.5">
          <SettingsFormTextarea
            rows={4}
            className="font-mono text-ui-base"
            placeholder={"get_issue\nlist_pull_requests"}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.mcp.form.disabledToolsHint" })}
          </p>
        </div>
      )}
    </div>
  );
}
