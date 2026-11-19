# Contributing to TeamClu

First off, thank you for considering contributing to TeamClu! It's people like you that make TeamClu such a great tool.

Following these guidelines helps to communicate that you respect the time of the developers managing and developing this open source project. In return, they should reciprocate that respect in addressing your issue, assessing changes, and helping you finalize your pull requests.

## Ways to Contribute

We welcome contributions at all levels! Here are different ways you can help:

### 📝 Documentation & Translation (Easiest)
- Fix typos or improve existing documentation
- Translate README or docs to other languages
- Add examples or tutorials
- **No dev environment required!**

### 🐛 Bug Reports
- Report issues with clear reproduction steps
- Verify existing bug reports
- Test PRs and provide feedback

### ✨ Feature Suggestions
- Share ideas for new features
- Discuss implementation approaches
- Vote on existing feature requests

### 🔧 Frontend Development
- React/TypeScript components
- UI/UX improvements
- State management (Zustand)
- **Requires:** Node.js, pnpm

### ⚙️ Rust Development
- Tauri backend commands
- System integrations
- Performance optimizations
- **Requires:** Rust, Tauri

## Getting Started

### For Documentation Contributors

```bash
# Just fork and edit on GitHub - no setup needed!
# Or clone locally for larger changes:
git clone https://github.com/different-ai-studio/teamclu.git
cd teamclu
```

### For Frontend Contributors

**Prerequisites:**
- Node.js >= 24 (`engines` in `package.json`)
- pnpm 11 (pinned by `packageManager` in `package.json`; `corepack enable` picks it up)

```bash
# 1. Clone and install
git clone https://github.com/different-ai-studio/teamclu.git
cd teamclu
pnpm install

# 2. Start frontend only (no Tauri needed)
pnpm dev
```

### For Full Stack Contributors

**Additional Prerequisites:**
- Rust 1.97.1 (pinned by `rust-toolchain.toml`; rustup installs it on first build)

```bash
# Setup development environment
pnpm install

# Start full Tauri app
pnpm tauri:dev

# Skip the first-run wizards while developing
pnpm tauri:dev -- --skip-setup --skip-daemon-onboarding
```

After launching, pick a workspace directory in the TeamClu UI.

## Repo Layout

TeamClu is a monorepo. See [CONTEXT-MAP.md](CONTEXT-MAP.md) for how these map to bounded contexts.

```
teamclu/
├── packages/app/        # React 19 frontend (components, stores, hooks, lib)
├── apps/
│   ├── desktop/         # Tauri backend — commands, RAG, STT
│   ├── daemon/          # amuxd — agent host, gateways, team sync
│   ├── ios/             # Native SwiftUI app + AMUXCore package
│   ├── expo/            # Expo mobile client
│   └── extension/       # Chrome MV3 extension
├── crates/              # Shared Rust crates (proto, types, transport, gateway)
├── services/
│   ├── fc/              # TeamClu Cloud API (Node.js 20)
│   └── supabase/        # Migrations, seed, database tests
├── proto/               # Protobuf wire format
├── docs/                # Architecture, ADRs, OpenAPI, plans
└── tests/               # E2E tests
```

## Build Commands

```bash
pnpm tauri:build          # Production desktop build
pnpm tauri:build:debug    # Debug build
pnpm tauri:build:mac:all  # macOS dual-arch (ARM64 + Intel)
pnpm daemon:build         # Build amuxd
pnpm ios:build            # Build iOS simulator app
```

### Faster Rust Iteration

Rust and Tauri commands share a `.cargo-target/` directory across worktrees and automatically enable `sccache` when it's installed.

```bash
pnpm rust:check   # Fast Rust-only compile check
pnpm rust:build   # Full Rust build using the same shared cache
```

`pnpm tauri:dev` and `pnpm tauri:build` use the same shared build environment. `.cargo-target/` is local-only and git-ignored. Install `sccache` for compiler cache hits on top of the shared target directory.

## Testing

```bash
pnpm test:unit            # Vitest unit tests
pnpm test:smoke           # Smoke subset
pnpm test:e2e             # E2E (PR suite)
pnpm daemon:test          # Daemon tests
pnpm ios:test:core        # AMUXCore SwiftPM tests
```

Watch mode for unit tests: `pnpm --filter @teamclu/app test:unit --watch`

Rust checks before opening a PR:

```bash
cargo fmt --check --manifest-path apps/desktop/Cargo.toml
cargo clippy --manifest-path apps/desktop/Cargo.toml -- -D warnings
```

## Development Workflow

1. **Fork** the repository on GitHub
2. **Clone** your fork locally
3. **Create** a branch for your contribution:
   ```bash
   git checkout -b feat/your-feature-name
   # or
   git checkout -b fix/issue-description
   ```
4. **Make** your changes
5. **Test** your changes:
   ```bash
   # Run linting
   pnpm lint
   
   # Run type checking
   pnpm typecheck
   
   # Run tests
   pnpm test:unit
   ```
6. **Commit** your changes:
   ```bash
   git add .
   git commit -m "feat: add your feature description"
   ```
7. **Push** to your fork:
   ```bash
   git push origin feat/your-feature-name
   ```
8. **Open** a Pull Request

## Commit Message Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, semicolons, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Build process or auxiliary tool changes

Example:
```
feat: add support for custom MCP servers

This change allows users to configure custom MCP servers
through the settings panel.

Closes #123
```

## Pull Request Checklist

Before submitting your PR, please ensure:

- [ ] Code follows the project's style guidelines
- [ ] Tests pass (`pnpm test:unit`)
- [ ] Linting passes (`pnpm lint`)
- [ ] Type checking passes (`pnpm typecheck`)
- [ ] Documentation is updated (if needed)
- [ ] Commit messages follow the convention
- [ ] PR description clearly explains the changes

## Code Review Process

1. All PRs require at least one review
2. CI checks must pass
3. Maintainers may request changes
4. Once approved, a maintainer will merge

## Questions?

- Join our [GitHub Discussions](https://github.com/different-ai-studio/teamclu/discussions)
- Open an issue for questions

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
