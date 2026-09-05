# Desktop Release（Tauri）

TeamClu 桌面端通过 **Git tag 触发 GitHub Actions**，自动构建 macOS / Windows 安装包并发布到 GitHub Releases，同时镜像到国内 OSS CDN。

## 版本号来源

以下四处必须保持一致（可用脚本校验 / 批量 bump）：

| 文件 | 字段 |
|------|------|
| `package.json` | `version` |
| `apps/desktop/Cargo.toml` | `version` |
| `apps/desktop/tauri.conf.json` | `version` |
| `apps/daemon/Cargo.toml` | `version`（随 Desktop 打包的 `amuxd` sidecar） |

```bash
# 查看是否一致
pnpm release:check

# 批量 bump（会先检查当前四处一致）
pnpm release:bump 0.2.1
# bump 后务必同步 lockfile（一键脚本会自动做）：
./scripts/sync-cargo-lock-version.sh

# 发布前门禁
pnpm release:preflight
```

## 一键发布（推荐）

从干净的 `main` 工作区运行，自动完成：**patch bump → Cargo.lock 同步 → 本地 build 校验 → 开 PR 合入 → 打 tag 触发 Release CI**。

```bash
# 自动 patch +1（0.2.9 → 0.2.10），每步确认
pnpm release:desktop -- --patch

# 指定版本
pnpm release:desktop -- 0.2.10

# 跳过确认（CI 已绿、你清楚在做什么时）
pnpm release:desktop -- --patch --yes

# 只看会做什么
pnpm release:desktop -- --patch --dry-run

# main 已是目标版本，只打 tag（或失败重打）
pnpm release:desktop -- --tag-only
pnpm release:desktop -- --tag-only --retag --yes

# 只 bump + 开 PR，手动打 tag
pnpm release:desktop -- --patch --no-tag
```

脚本：`scripts/release-desktop.sh`（`Cargo.lock` 同步：`scripts/sync-cargo-lock-version.sh`）。

## 发布流程

### 1. 准备

- `main` 上 CI 全绿（lint / typecheck / unit / rust clippy）
- 如需验证本地包：`pnpm verify-release`（单架构 Tauri build，不生成 updater 签名产物）
- 若本次 release 依赖 Cloud API 变更，先确保 `services/fc/**` 已合入 `main`，并按当前后端发布流程完成 Cloud API 部署验证

### 2. Bump 版本并合入 main

```bash
pnpm release:bump 0.2.1
git add package.json apps/desktop/Cargo.toml apps/desktop/tauri.conf.json apps/daemon/Cargo.toml
git commit -m "chore(desktop): bump version to 0.2.1"
# 通过 PR 合入 main，不要直接推 main
```

### 3. 打 tag 触发 CI

```bash
git checkout main && git pull
pnpm release:preflight
git tag v0.2.1
git push origin v0.2.1
```

Tag 必须以 `v` 开头，匹配 `.github/workflows/release.yml` 的 `v*` 规则。

### 4. CI 产物（自动）

Workflow：`.github/workflows/release.yml`

| Job | 平台 | 产物 |
|-----|------|------|
| `release-macos` ×2 | ARM64 + Intel | `.dmg` |
| `release-windows` | x64 | NSIS `.exe` |
| `update-release-notes` | — | OSS `latest.json` 镜像 + Release 说明补充 |

Sidecar 随 Desktop 一起编译打包：`teamclu-introspect`、`amuxd`。

### 5. 发布后验收

**GitHub Release 资产：**

- `TeamClu_<version>_aarch64.dmg`
- `TeamClu_<version>_x64.dmg`
- `TeamClu_<version>_x64-setup.exe`
- `latest.json`（Tauri 自动更新清单）

**安装验证：**

```bash
# 海外（GitHub latest release）
curl -fsSL https://raw.githubusercontent.com/different-ai-studio/teamclu/main/scripts/install-mac.sh | bash

# 国内（OSS 镜像，需 OSS secrets 已配置）
curl -fsSL https://teamclu.ucar.cc/install-mac-cn.sh | bash
```

**自动更新端点（`tauri.conf.json`）：**

- `https://teamclu.ucar.cc/releases/latest.json`
- `https://github.com/different-ai-studio/teamclu/releases/latest/download/latest.json`

**通知：** Release published 后 `wecom-notify.yml` 会推送企业微信（需 `WECOM_WEBHOOK_KEY`）。

## 重新发布 / 手动触发

若某次 tag 构建失败，可在 GitHub → Actions → **Release** → **Run workflow**，输入已存在的 tag（如 `v0.2.1`）重新跑全流程。

## 必需 Secrets

| Secret | 用途 |
|--------|------|
| `TAURI_SIGNING_PRIVATE_KEY` + `PASSWORD` | Updater 签名（缺失则构建失败） |
| `BUILD_CONFIG_PRODUCTION` | 生产 `build.config.json` |
| `DEVICE_JWT_SECRET` | 设备 JWT |
| `APPLE_CERTIFICATE` + 相关 | macOS 代码签名（缺失则 ad-hoc，用户需 `xattr`） |
| `OSS_*` | 国内 CDN 镜像（**teamclu 仓库必须配置**，否则 OSS 端点不会更新） |
| `UPDATER_GITHUB_TOKEN` | macOS / Windows job bake 进自定义 updater（GitHub 兜底模式） |

生产配置结构参考 `build.config.example.json`。

## 本地打包（不替代 CI 发布）

| 命令 | 说明 |
|------|------|
| `pnpm tauri:build` | 当前架构生产包 |
| `pnpm tauri:build:mac:all` | macOS 双架构 |
| `pnpm tauri:build:win` | Windows NSIS |
| `pnpm verify-release` | 快速本地 release 构建验证 |

正式发布 **只认 CI 产物**，避免本地 DMG 与线上 updater 不同步。

## macOS 用户提示

当前应用尚未 Apple 公证。首次从网络下载后，若手动拖入 Applications，需执行（路径随品牌名变化，一键安装脚本会自动处理）：

```bash
# TeamClu 默认品牌
sudo xattr -dr com.apple.quarantine "/Applications/TeamClu.app"

# 生产白标（示例：Copilot 361）
sudo xattr -dr com.apple.quarantine "/Applications/Copilot 361.app"
```

Release CI 会根据 `build.config.json` 中的 `app.name` 自动生成正确的命令；本地可用：

```bash
node -e "import('./scripts/lib/read-app-name.mjs').then(m=>{const n=m.readAppName(); console.log(\`sudo xattr -dr com.apple.quarantine \\\"/Applications/\${n}.app\\\"\`)})"
```

Release notes 中已包含此说明。
