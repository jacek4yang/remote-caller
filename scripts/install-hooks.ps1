$ErrorActionPreference = "Stop"
git config core.hooksPath .githooks
Write-Host "Git hooks 已启用：提交前会检查格式并运行测试。"

