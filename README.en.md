# ZCode-CE

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode-CE" width="128" height="128" />
</div>
<p align="center">
  <a href="https://github.com/Zcode-CE/Zcode-CE/issues">Issues</a> ·
  <a href="https://github.com/Zcode-CE/Zcode-CE/discussions">Discussions</a> ·
  <a href="https://github.com/zai-org/ZCode">Upstream</a>
</p>
<p align="center">
  <a href="README.md">简体中文</a> | English
</p>

ZCode-CE is the **open-source community edition** of the ZCode AI coding workbench, offering a desktop application, a browser interface, and a terminal agent. This repository contains the client, backend services, shared UI, and the Agent CLI and runtime source.

## About this project

ZCode-CE is built on [zai-org/ZCode](https://github.com/zai-org/ZCode) (Apache-2.0), for users who want **full control over their own development environment**. **Community contributions are welcome** — whether it's feature development, issue reports, or documentation improvements.

Five differences from the official distribution:

| Area                       | Description                                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No telemetry**           | Telemetry and monitoring components from the official distribution are removed. With a self-hosted API, no background reporting to official services occurs                                                                         |
| **Entitlements preserved** | Official service entitlements (plan quotas, limited-time bonuses) are fully retained. The client ships every capability needed to claim and bill them                                                                               |
| **Community feedback**     | Feedback goes to this project's GitHub Issues by default, not the official ticket system. The channel is configurable or can be disabled                                                                                            |
| **Open document skills**   | Office document capabilities (Word / PowerPoint / Excel) come from MIT-licensed open implementations, not official closed-source plugins                                                                                            |
| **Desktop automation**     | Computer Use comes from an MIT-licensed open implementation ([trycua/cua](https://github.com/trycua/cua)), not the official unlicensed closed-source helper. **Windows is fully supported; Linux is experimental** (off by default) |

### What this is not

- **Not an official distribution.** ZCode-CE is community-maintained and does not represent Z.ai or Zhipu.
- **No account services.** Model access, plans, and billing remain with the official service. This project does not proxy or resell them.
- **Platform support for Computer Use differs.** Windows is fully supported; **Linux is experimental** (off by default, enable it in settings). The official distribution does not support Linux desktop automation at all; this build provides it through an open implementation, within the limits of upstream validation: verified on X11 / Sway / KDE Wayland, **screenshots are unavailable on Wayland** (element actions are unaffected), GNOME is not fully verified. See the [desktop automation docs](docs/development/computer-use.md).

### Roadmap

The official distribution ships the following capabilities without their source. This build does not provide them yet; they are planned for later releases:

| Capability         | Status                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **PDF generation** | Planned. The official implementation has both LaTeX and HTML pipelines; this project will reimplement it on an open typesetting toolchain |

For every capability this build does not provide, and why, see [Differences from the official distribution](docs/development/official-diff.md).

## Install

Download the installer for your platform from [Releases](https://github.com/Zcode-CE/Zcode-CE/releases).

| Platform    | Format                                         | Notes                                                                                                                   |
| ----------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Windows** | `.exe` (NSIS)                                  | Run the installer. Currently **unsigned**, so the first launch requires choosing "Run anyway" in the SmartScreen prompt |
| **Linux**   | `.AppImage` / `.deb` / `.rpm` / `.pkg.tar.zst` | AppImage needs `chmod +x` before running                                                                                |

**Data directory**: shared with the official ZCode at `~/.zcode/v2`. Both can be installed side by side (separate install identities), but running them simultaneously is not recommended.

> **About Windows signing**: the official distribution is signed with a DigiCert organization-validated (OV) certificate. As a community project we cannot obtain that class of certificate, and are applying for free open-source code signing from [SignPath Foundation](https://signpath.org/) (the certificate is issued to SignPath Foundation, not to this project). Once approved, the SmartScreen prompt goes away. See the [Code signing policy](docs/operations/code-signing-policy.md).

Prefer to build from source or contribute? See [Setup](#setup) and [Development](#development) below.

## Entry points

| Entry           | Purpose                                                                                         | Command                        |
| --------------- | ----------------------------------------------------------------------------------------------- | ------------------------------ |
| Desktop         | Electron desktop app                                                                            | `pnpm dev:desktop`             |
| Web / ZCode CLI | Terminal and browser workbench; assembles TUI, Web, backend and Agent into a standalone package | `pnpm dev:web`                 |
| Agent CLI       | Use `zcode` in a terminal; also provides the Agent runtime for Desktop and Web                  | `pnpm --filter @zcode/cli dev` |

## Setup

Prepare Git, Node.js **24.14.0**, and pnpm **10.33.2**; versions follow [mise.toml](mise.toml). All commands below run from the repository root.

```bash
pnpm bootstrap
```

`pnpm bootstrap` installs workspace dependencies, prepares desktop runtime assets, then runs `build:bootstrap`.

The Agent CLI and runtime source live in [apps/zcode-cli/](apps/zcode-cli/) as a regular directory cloned with this repository — no separate checkout or Git submodule initialization is needed.

Other initialization and build entry points:

| Command                        | Purpose                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `pnpm install`                 | Install dependencies                                                                                     |
| `pnpm prepare:desktop-runtime` | Prepare desktop runtime assets, including remote assets by default                                       |
| `pnpm prepare:remote-assets`   | Prepare remote runtime assets only                                                                       |
| `pnpm bootstrap:with-remote`   | Install dependencies plus local and remote assets, then build related packages; skips the desktop bundle |
| `pnpm build`                   | Recursively run each workspace package's build script                                                    |

By default `bootstrap` skips remote asset preparation, which suits local desktop development. Run the corresponding preparation command when working with remote workspaces or validating remote release assets.

## Development

### Desktop

```bash
pnpm dev:desktop

# Against the test environment
pnpm dev:desktop:test
```

`pnpm dev:desktop` equals `pnpm dev:desktop:prod` and uses production service configuration. The startup script prepares local runtime assets, builds the desktop agent, then launches Electron with source watching.

To use a separate development data directory, set `ZCODE_DATA_BASE_DIR`:

```bash
ZCODE_DATA_BASE_DIR="$HOME/.zcode-dev-home" pnpm dev:desktop:test
```

### Web

```bash
pnpm dev:web
```

This starts the Web development server and the backend together; open the former in a browser.

## Verification

| Purpose            | Command                             |
| ------------------ | ----------------------------------- |
| Type check         | `pnpm typecheck`                    |
| Lint               | `pnpm lint`                         |
| Tests              | `pnpm test`                         |
| Architecture check | `pnpm architecture:check --changed` |
| Pre-push check     | `pnpm verify:pre-push`              |

When changing desktop main/renderer code, additionally run `bash scripts/desktop-typecheck-baseline.sh diff` — the `pnpm typecheck` project list does not cover those two sub-projects.

## Data and configuration

| Path                          | Contents                                    |
| ----------------------------- | ------------------------------------------- |
| `~/.zcode/v2/`                | Sessions, credentials, task index, settings |
| `~/.config/ZCode-CE/` (Linux) | Electron runtime state                      |

ZCode-CE and the official ZCode use **separate installation identities** and can coexist. They share the `~/.zcode/v2/` data directory, so running both against the same workspace simultaneously is not recommended.

## Documentation

Developer documentation lives in [docs/](docs/):

- [Architecture and module boundaries](docs/development/architecture.md)
- [Differences from upstream](docs/development/upstream-diff.md)
- [Differences from the official release](docs/development/official-diff.md)
- [Local setup](docs/development/local-setup.md)
- [Telemetry and privacy](docs/development/telemetry.md)
- [Contributing](docs/community/contributing.md)
- [Release process](docs/operations/release.md)

## Open source references and acknowledgements

ZCode-CE stands on the shoulders of many open source projects. Below they are grouped by how we use them.

### Reused code components

Code from these projects is vendored into this repository. The complete list and license snapshots live in [third-party/copied-components.json](third-party/copied-components.json).

| Project                                                                                                             | License    | Use                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------- |
| [zai-org/ZCode](https://github.com/zai-org/ZCode)                                                                   | Apache-2.0 | Upstream of this repository                                                             |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)                                     | MIT        | Office document capabilities (`skill-office`); architectural reference for Computer Use |
| [vercel/ai-elements](https://github.com/vercel/ai-elements)                                                         | Apache-2.0 | AI chat interface components                                                            |
| [shadcn-ui/ui](https://github.com/shadcn-ui/ui)                                                                     | MIT        | Base UI components                                                                      |
| [microsoft/vscode](https://github.com/microsoft/vscode)                                                             | MIT        | Editor-related implementations                                                          |
| [withfig/autocomplete](https://github.com/withfig/autocomplete)                                                     | MIT        | Command completion data                                                                 |
| [material-extensions/vscode-material-icon-theme](https://github.com/material-extensions/vscode-material-icon-theme) | MIT        | File icon theme                                                                         |
| [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)                                           | Apache-2.0 | Browser automation                                                                      |
| [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills)                                             | MIT        | Agent skill definitions                                                                 |
| [obra/superpowers](https://github.com/obra/superpowers)                                                             | MIT        | Agent skill implementations                                                             |

### Runtime dependencies

| Project                                     | License       | Use                                                    |
| ------------------------------------------- | ------------- | ------------------------------------------------------ |
| [trycua/cua](https://github.com/trycua/cua) | MIT / MPL-2.0 | Desktop driver for Computer Use (`@trycua/cua-driver`) |

The full npm dependency license list is in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

### Design references

No code is reused from these projects, but their designs and interface conventions informed this implementation.

| Project                                              | What we referenced                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [zcode-api](https://github.com/LX2000WASD/zcode-api) | Protocol reconstruction of the official service APIs, used for entitlement capabilities (plan quotas, claiming, billing) |
| [openai/codex](https://github.com/openai/codex)      | Application-level access control design for Computer Use                                                                 |
| [trycua/cua](https://github.com/trycua/cua)          | Platform behaviour ledger and safety semantics (`possibly_sent` anti-replay, `controller lease`, kill switch)            |

### Third-party services

Model access, plans, and billing are provided by [Z.ai / Zhipu](https://z.ai/). This project does not proxy or resell them.

---

Thanks to the authors and maintainers of all the projects above. If your project appears here with an incorrect attribution, please open an issue.

## License

Built on [zai-org/ZCode](https://github.com/zai-org/ZCode), licensed under [Apache-2.0](LICENSE).

Third-party notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md); feature notes and risk disclosures are in [NOTICE.md](NOTICE.md).
