# @zcode/zcode-cua

Computer Use runtime for ZCode. Ships an adapter over the MIT-licensed
`@trycua/cua-driver` (Linux, macOS, Windows).

- **Runtime path**: the open-source driver, selected by default in `index.js`.
  It does **not** need an official Helper — the spawn env carries the broker
  socket and pluginAuthority contract directly
  (`packages/services/src/cua-permission-broker/cuaProductHelperSpawnEnv.ts`).
- **Placeholders, still failing closed**: broker RPC, Helper install/launch/
  verify, PiP session client and the native addon loader stay API-compatible
  stubs, because no official Helper binary ships on any platform
  (`packages/desktop/electron-builder.config.js` stages no `cua-helper`).
- Predicates about official CUA frames are `false`, and permission ports keep
  their privacy fail-closed semantics.

Feature state in the desktop build: **off by default** (see
`packages/shared/src/plugin-marketplaces.ts`); enable it in Settings → Computer
Use. Windows is packaged by CI but **not tested on real hardware**; Linux is
**experimental** (X11/Wayland coverage unverified); remote workspaces and Web do
not carry Computer Use.

License: Apache-2.0.
