# TeamClu 二进制文件

此目录包含 Tauri sidecar 二进制文件。

| 文件 | 用途 |
|------|------|
| `teamclu-introspect-<target>` | TeamClu introspect sidecar（用于运行时自省） |
| `llama-funasr-sensevoice-<target>` | macOS 本地语音输入运行时；arm64 与 Intel 均从固定官方源码构建 |

`<target>` 为 Rust target triple，例如 `aarch64-apple-darwin`、`x86_64-apple-darwin`、`x86_64-pc-windows-msvc`（Windows 下带 `.exe`）。

## 命名约定

```
<服务名>-<target-triple>
```

Windows 下为 `<服务名>-<target-triple>.exe`。
