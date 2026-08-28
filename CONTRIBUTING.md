# 贡献与 Git 工作流

## 初始化

仓库已包含 `.gitignore`、提交前 hook、GitHub Actions、PR 模板和 tag 发布流水线。克隆后启用本地 hook：

```powershell
./scripts/install-hooks.ps1
```

## 分支

- `main`：随时可发布，开启 PR 保护，禁止直接 push；
- `develop`：可选的集成分支；小团队也可以直接从 main 开短分支；
- `feat/<name>`、`fix/<name>`、`docs/<name>`、`chore/<name>`：短生命周期工作分支。

提交遵循 Conventional Commits，例如：

```text
feat(call): add screen sharing
fix(ice): retry failed candidate negotiation
docs(deploy): clarify embedded TURN firewall rules
```

## 合并前检查

```powershell
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-features
cargo build --release --locked
```

PR 使用 squash merge，标题作为最终提交信息。至少一人评审，CI 必须通过。涉及浏览器行为的改动需写明实测设备和系统版本。

## 发布

采用 SemVer。`Cargo.toml` 与 `Cargo.lock` 的版本必须一致。普通 PR/main push 不会发布 Release。只有在 main 对应提交的 CI 已通过后，显式推送与 Cargo 版本一致的 SemVer tag（例如 `v1.1.0`）才会触发 release workflow；workflow 会再次验证 tag、测试 exact tagged source 并构建产物。

`.github/workflows/release.yml` 会发布带 SHA-256 校验的 Linux x86_64 二进制包。CI 产物使用兼容性较好的 x86-64-v2；在生产服务器运行构建脚本可获得 `target-cpu=native` 的最佳性能。紧急回滚使用上一版本二进制，不重写已发布 tag。

## 仓库保护建议

在 GitHub 设置中要求 PR、至少一个批准、解决全部 review conversation、CI 的 `rust` job 通过、禁止 force push、管理员也遵守保护规则；只为 release workflow 保留 tag 发布所需的 `contents: write` 权限。
