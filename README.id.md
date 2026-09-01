# TeamClu

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/different-ai-studio/teamclu/actions/workflows/ci.yml/badge.svg)](https://github.com/different-ai-studio/teamclu/actions)
[![Contributors](https://img.shields.io/github/contributors/different-ai-studio/teamclu.svg)](https://github.com/different-ai-studio/teamclu/graphs/contributors)

Agent AI lokal — rekan AI Anda untuk setiap peran

> **Rekan Anda. Bersama.**

- **👥 Dibuat untuk tim** — bagikan Skills, Knowledge, dan konfigurasi MCP ke seluruh tim melalui sinkronisasi Git atau S3/OSS; setiap anggota tetap memiliki konteks pribadinya sendiri
- **🎭 Skills × Roles** — library peran yang dapat dikombinasikan memungkinkan agent yang sama dikhususkan untuk sales, support, ops, engineering, atau peran apa pun yang dibutuhkan tim Anda
- **🔋 Lengkap sejak awal** — knowledge base tim, pemahaman Auto UI, speech-to-text, dan enam channel gateway (WeCom, Feishu, Discord, Kook, WeChat, Email) sudah tersedia tanpa perlu glue code
- **🧑‍💻 Dari developer solo hingga UKM** — local-first dan privat secara default; dapat berkembang dari satu pengguna hingga perusahaan kecil

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | Bahasa Indonesia

## Tangkapan layar

| Beranda | Channel |
|---|---|
| ![TeamClu Home](images/home.png) | ![TeamClu Channels](images/channel.png) |

## Fitur

- **Workspace tiga kolom** — sidebar, chat, dan panel detail
- **Runtime agent lokal** — agent berjalan di mesin Anda dan di-host oleh daemon `amuxd`
- **Channel gateway** — akses agent Anda dari Discord, Feishu, Email, Kook, WeCom, dan WeChat
- **Otomatisasi** — task terjadwal melalui cron
- **Kolaborasi tim** — bagikan team drive (`teamclu-team/`) melalui OSS atau Git; lihat [Kolaborasi tim](#kolaborasi-tim)
- **Dukungan MCP** — hubungkan agent ke sistem enterprise melalui Model Context Protocol
- **Skills / plugin** — perluas kemampuan agent dengan sumber skill di tingkat workspace dan global
- **Knowledge base** — vault Markdown yang disinkronkan ke seluruh tim, dengan ACL per-path dan riwayat versi
- **Editor bawaan** — Markdown dan HTML (Tiptap), code (CodeMirror 6), serta diff reviewer yang dirancang untuk agent
- **Operasi file lokal** — dengan pengelolaan izin untuk setiap operasi

## Cara kerjanya

TeamClu dibagi menjadi layer client, host agent, dan backend cloud:

```
  Desktop (Tauri)     iOS      Mobile (Expo)     Chrome extension
        │              │            │                  │
        └──────────────┴─────┬──────┴──────────────────┘
                             │
              ┌──────────────┴───────────────┐
              │      TeamClu Cloud API      │   identity, teams,
              │            (/v1)             │   sessions, messages
              └──────────────┬───────────────┘
                             │
                    ┌────────┴────────┐
                    │   amux daemon   │  agent host + channel gateways
                    │    (amuxd)      │  + team sync (git / OSS)
                    └────────┬────────┘
                             │ HTTP / RPC
                    ┌────────┴────────┐
                    │ local agents    │  opencode (default), …
                    └─────────────────┘
```

- **Client** menangani UI dan file lokal. Menginstal TeamClu Desktop juga menginstal daemon `amuxd`, sehingga mesin Anda langsung dapat berfungsi sebagai host agent.
- **amuxd** meng-host backend agent lokal, menjalankan channel gateway, dan menangani sinkronisasi tim. amuxd juga dapat diinstal secara standalone di server tanpa GUI.
- **Cloud API** (`/v1`) adalah satu-satunya backend yang diakses client. Lihat [`docs/openapi/teamclu-api.v1.yaml`](docs/openapi/teamclu-api.v1.yaml) untuk kontrak API dan [`docs/architecture/v2.md`](docs/architecture/v2.md) untuk arsitektur lengkap.

## Client

| Client | Path | Status |
|---|---|---|
| **Desktop** (macOS / Windows / Linux) | `apps/desktop/` + `packages/app/` | Client utama |
| **iOS** | `apps/ios/` | Native SwiftUI, didistribusikan melalui TestFlight |
| **Mobile** (iOS / Android) | `apps/expo/` | Expo; onboarding dan sesi |
| **Chrome extension** | `apps/extension/` | MV3 |

## Instalasi

Unduh installer untuk platform Anda dari [GitHub Releases](https://github.com/different-ai-studio/teamclu/releases) — `.dmg` untuk macOS dan `.exe` untuk Windows.

### Peringatan macOS "damaged"

Jika macOS melaporkan bahwa aplikasi **"damaged"** atau **"cannot be opened because the developer cannot be verified"**, itu adalah respons Gatekeeper terhadap unduhan yang tidak ditandatangani. Hapus atribut quarantine:

```bash
xattr -cr /Applications/TeamClu.app
```

Langkah ini tidak diperlukan untuk build yang ditandatangani dan dinotarisasi dengan sertifikat Apple Developer.

## Mulai cepat (development)

**Prasyarat:** Node.js >= 20, pnpm >= 10, Rust >= 1.70

```bash
pnpm install
pnpm tauri:dev
```

Setelah aplikasi berjalan, pilih direktori workspace di UI TeamClu.

Untuk melewati wizard saat pertama kali dijalankan selama development:

```bash
pnpm tauri:dev -- --skip-setup --skip-daemon-onboarding
```

Untuk menjalankan frontend saja (tanpa build Rust), jalankan `pnpm dev`. Perintah build, cache build Rust bersama, test suite, dan struktur repository dijelaskan di [Panduan Kontribusi](CONTRIBUTING.md).

## Kolaborasi tim

Sebuah tim berbagi **team drive** khusus (`teamclu-team/`), bukan seluruh workspace. Saat onboarding, pemilik memilih satu **mode berbagi**, yang kemudian dikunci di sisi server:

| Mode | Cara kerja |
|---|---|
| `oss` | Sinkronisasi melalui object storage yang kompatibel dengan S3 (Alibaba OSS / WebDAV) |
| `managed_git` | Sinkronisasi melalui repository Git yang disediakan untuk Anda |
| `custom_git` | Sinkronisasi melalui repository Git yang Anda host sendiri |

Sinkronisasi ditangani oleh daemon `amuxd`: daemon menyimpan satu salinan global per tim di `~/.amuxd/teams/<team_id>/`, lalu setiap workspace yang terhubung mendapatkan symlink `teamclu-team` ke salinan tersebut.

### Yang dibagikan

Hanya layer bersama yang disinkronkan — `.gitignore` berbasis whitelist menjaga semua yang lain tetap lokal:

- `skills/` — skill agent bersama
- `.mcp/` — konfigurasi server MCP
- `knowledge/` — dokumen knowledge base tim

File pribadi dan bagian workspace lainnya tetap berada di lokal.

### Catatan

- Mode Git memerlukan autentikasi Git yang berfungsi (SSH key atau HTTPS token).
- Sinkronisasi OSS dapat menimbulkan konflik; selesaikan konflik tersebut dari UI shared files tim.
- Sinkronisasi berjalan saat aplikasi dimulai dan juga dapat dipicu secara manual dari **Settings → Team**.

## Konfigurasi

Konfigurasi build-time berada di `build.config.*.json` pada root repository dan digabungkan dalam urutan berikut:

```
build.config.json → build.config.${BUILD_ENV}.json → build.config.local.json
```

Salin file contoh untuk memulai:

```bash
cp build.config.example.json build.config.local.json
```

Pengaturan utama adalah `cloudApiUrl`, yang mengarahkan aplikasi ke deployment TeamClu Cloud API:

```json
{
  "cloudApiUrl": "https://api.teamclu-dev.ucar.cc",
  "features": {
    "channels": { "discord": true, "feishu": true, "email": true }
  }
}
```

`build.config.local.json` diabaikan oleh git. Untuk development lokal, Anda juga dapat mengganti endpoint menggunakan `VITE_CLOUD_API_URL` di `packages/app/.env.local`. Lakukan build ulang agar perubahan diterapkan.

Implementasi Cloud API berada di `services/fc/` (Node.js 20), menggunakan Supabase sebagai backend dan, secara opsional, proxy LiteLLM untuk pengelolaan anggaran AI bersama.

## Dokumentasi

- [Arsitektur](docs/architecture/v2.md) — komponen, topologi, dan model data
- [Kontrak API](docs/openapi/teamclu-api.v1.yaml) — TeamClu Cloud API `/v1`
- [Peta konteks](CONTEXT-MAP.md) — pembagian repository menjadi bounded context
- [Kontribusi](CONTRIBUTING.md) — setup development, testing, dan struktur repository
- [Kebijakan keamanan](SECURITY.md)

## Kontribusi

Kami menyambut kontribusi! Lihat [Panduan Kontribusi](CONTRIBUTING.md) untuk detailnya.

- 📝 [Dokumentasi & terjemahan](CONTRIBUTING.md#-documentation--translation-easiest) — tidak memerlukan environment development
- 🐛 [Laporan bug](CONTRIBUTING.md#-bug-reports)
- ✨ [Usulan fitur](CONTRIBUTING.md#-feature-suggestions)
- 🔧 [Pengembangan frontend](CONTRIBUTING.md#-frontend-development)
- ⚙️ [Pengembangan Rust](CONTRIBUTING.md#-rust-development)

## Tech stack

- **Desktop**: Tauri 2.0 (Rust)
- **Daemon**: Rust (`amuxd`), backend agent lokal (opencode HTTP, …)
- **Frontend**: React 19 + TypeScript, Tailwind CSS 4, Zustand
- **iOS**: SwiftUI + SwiftPM (`AMUXCore`)
- **Editor**: Tiptap (Markdown / HTML), CodeMirror 6 (code), Shiki (highlighting)

## License

MIT
