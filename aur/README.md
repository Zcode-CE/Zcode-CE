# AUR 包

Arch 系发行版的安装包定义。包名 `zcode-ce-bin`，发布到 [AUR](https://aur.archlinux.org/packages/zcode-ce-bin)。

## 为什么是 `-bin`

上游的 `zcode-bin` 走「下载 .deb + 解包 + 用系统 Electron 启动」的路线，体积小，但把
Electron 版本耦合给了发行版 —— Electron 大版本升级时应用可能起不来。

本包直接安装 CI 产出的 `.pkg.tar.zst`：它由 electron-builder 生成、**自带 Electron**，
与 Release 里的产物完全一致，用户装到的就是我们构建并测试过的那一份。

## 文件

| 文件                   | 用途                                                       |
| ---------------------- | ---------------------------------------------------------- |
| `PKGBUILD`             | 包定义                                                     |
| `.SRCINFO`             | AUR 元数据，由 `makepkg --printsrcinfo` 生成，**不要手改** |
| `zcode-ce-bin.install` | 安装后脚本：处理 chrome-sandbox 权限与桌面数据库刷新       |

## 更新流程

发布新版本后：

1. 改 `PKGBUILD` 的 `pkgver` / `_upstream_ver` / `_upstream_tag`
2. 下载新的 `.pkg.tar.zst` 并更新 `sha256sums`
   ```bash
   gh release download v<新版本> --repo Zcode-CE/Zcode-CE \
     --pattern "*linux-x64.pkg.tar.zst" --dir /tmp
   sha256sum /tmp/*.pkg.tar.zst
   ```
3. 重新生成 `.SRCINFO`：`makepkg --printsrcinfo > .SRCINFO`
4. 本地验证：`makepkg -f`
5. 推送：`git push aur master`（AUR 的主分支是 `master`）

## 本地验证

```bash
makepkg -f                    # 构建
sudo pacman -U zcode-ce-bin-*.pkg.tar.zst   # 安装
zcode-ce                      # 启动
```

## 注意

- **chrome-sandbox 的 setuid 位**必须在 `post_install` 里设，不能在 `package()` 里 `chmod`：
  makepkg 打包时会规范化权限并剥离 setuid，写进包里的位会丢失（实测确认）。
