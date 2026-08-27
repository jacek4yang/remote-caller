# Remote Caller

Remote Caller 是一个面向**固定少量白名单用户**的自托管双人 WebRTC 语音/视频通话服务。生产形态只需要 Nginx 和一个 Rust 二进制：Rust 进程负责账号鉴权、WebSocket 信令、内嵌 STUN/TURN 与资源限制；媒体优先 P2P，复杂 NAT 下自动使用同一 Rust 进程中继。

v1.0.0 的目标不是公共会议 SaaS，而是让两名固定用户长期、稳定地在 Android、iOS 和桌面浏览器之间通话，同时把公网攻击面压到很小。

## v1.0.0 设计重点

- **无开放注册**：只有环境文件中预先配置的账号可以登录。
- **Argon2id 密码**：服务端只保存 PHC 哈希；未知用户名也执行一次 Argon2 校验，降低用户名时序枚举。
- **有界登录成本**：默认最多同时执行 2 个 Argon2 校验，防止登录接口形成无限 `spawn_blocking` 队列。
- **JWT 不进入 WebSocket URL**：浏览器先用 Bearer JWT 换取 30 秒、一次性的 WebSocket ticket，再建立 `/ws?ticket=...`。
- **资源上限**：默认全局最多 16 个 WebSocket、每账号 3 个、8 个房间、32 个待使用 ticket；每房间仍严格最多 2 人。
- **纯 Rust TURN 数据面**：继续使用现有 `turn-server` crate，不引入 Coturn、Redis、数据库或额外守护进程。
- **TURN 只允许配置账号**：v1.0.0 不再使用无法由当前内嵌 TURN 真正强制过期的 REST 时间戳用户名，而是把每个白名单账号的高熵 TURN 凭证直接加入内嵌 TURN 静态凭证表。轮换 `TURN_SECRET` 并重启即可使所有旧 TURN 凭证失效。
- **长通话恢复**：WebSocket 每 20 秒应用层 Ping；Nginx WebSocket 超时为 24 小时；前端串行处理 SDP/ICE、缓存提前到达的 ICE candidate，并在网络切换后自动 ICE restart / 重建 PeerConnection。
- **安全默认监听**：HTTP 默认只监听 `127.0.0.1:8080`，公网入口应只有 Nginx 443 和 TURN 所需端口。

> 安全边界：TURN 凭证在 `TURN_SECRET` 轮换前是稳定凭证，不是时间到期凭证。这是为了在不引入外部 TURN 服务的前提下避免“看似有 TTL、服务端却不验证 TTL”的错误安全模型。对于只有固定两名可信用户的私人实例，这是明确且可控的取舍。若怀疑浏览器、账号或凭证泄露，应立即轮换 `TURN_SECRET`、`JWT_SECRET` 和对应账号密码。

## 本地开发

需要 Rust 1.85+。桌面浏览器访问 `localhost` 可测试摄像头/麦克风；真实手机和跨网络测试必须使用可信 HTTPS。

```powershell
$env:JWT_SECRET="development-jwt-secret-at-least-32-chars"
$hash = "一个至少十个字符的密码" | cargo run -- hash-password
$env:ADMIN_PASSWORD_HASH=$hash
$env:EMBEDDED_TURN="false"
cargo run
```

打开 `http://localhost:8080`。如果要测试两名独立账号，通过 `USERS_JSON` 再添加一个白名单用户。

## 生产拓扑

```text
Internet
   |
   +-- 80/443 ----------> Nginx ----------> 127.0.0.1:8080 Rust HTTP/WS
   |
   +-- 3478 UDP/TCP ----------------------> Rust STUN/TURN
   +-- 5349 TCP (TLS) --------------------> Rust TURNS
   +-- 49160-49175 UDP -------------------> Rust TURN relay
```

生产服务器不需要 Docker、Coturn、Redis 或数据库。详见 [`docs/DEPLOYMENT_ZH.md`](docs/DEPLOYMENT_ZH.md)。

## 核心配置

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `BIND_ADDR` | `127.0.0.1:8080` | HTTP/WS 监听地址；生产保持回环地址 |
| `JWT_SECRET` | 必填 | JWT HMAC 密钥，至少 32 字符 |
| `ADMIN_USERNAME` | `admin` | 第一个白名单账号；生产建议改成不可猜的真实用户名 |
| `ADMIN_DISPLAY_NAME` | `Admin` | 显示名称 |
| `ADMIN_PASSWORD_HASH` | 必填 | `remote-caller hash-password` 生成的 Argon2id PHC 哈希 |
| `USERS_JSON` | `[]` | 额外白名单账号；私人双人部署添加第二个账号即可 |
| `SESSION_TTL_SECS` | `604800` | JWT 会话 7 天；允许范围 1 小时到 30 天 |
| `AUTH_MAX_CONCURRENT_HASHES` | `2` | 全局同时执行的 Argon2 校验上限 |
| `MAX_WS_CONNECTIONS` | `16` | 全局 WebSocket 上限 |
| `MAX_WS_PER_USER` | `3` | 单账号 WebSocket 上限 |
| `MAX_ROOMS` | `8` | 同时存在的房间上限 |
| `WS_TICKET_TTL_SECS` | `30` | 一次性 WebSocket ticket 有效期，10-300 秒 |
| `MAX_PENDING_WS_TICKETS` | `32` | 尚未消费的一次性 ticket 上限 |
| `EMBEDDED_TURN` | Linux 为 `true` | 启动同进程 Rust STUN/TURN |
| `TURN_SECRET` | 内嵌 TURN 时必填 | 至少 32 字符；派生每账号的 TURN 高熵凭证 |
| `TURN_PUBLIC_IP` | 内嵌 TURN 时必填 | 服务器公网 IPv4 |
| `TURN_REALM` | `localhost` | 生产设置为通话域名 |
| `TURN_URLS` | 自动生成 | `turn:` / `turns:` 地址列表 |
| `TURN_RELAY_MIN_PORT` | `49160` | TURN 中继端口起点 |
| `TURN_RELAY_MAX_PORT` | `49175` | TURN 中继端口终点 |
| `STATIC_DIR` | `web` | 静态前端目录 |
| `SERVE_STATIC` | `true` | 生产由 Nginx 托管静态资源时设为 `false` |

## HTTP / WebSocket 接口

- `POST /api/login`：白名单账号登录，返回内存中使用的 JWT。
- `GET /api/config`：Bearer JWT 获取 ICE 配置和当前账号的 TURN 凭证。
- `POST /api/ws-ticket`：Bearer JWT + 房间号换取短时一次性 ticket。
- `GET /ws?ticket=...`：消费 ticket 后升级 WebSocket；ticket 使用一次立即删除。
- `GET /health/live`、`GET /health/ready`：健康探针。
- `GET /metrics`：Prometheus 文本指标；生产 Nginx 默认仅允许 localhost。

## GitHub Actions / Release

`main` 的 CI 会执行：

```text
cargo fmt --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-features
cargo build --locked --release
node --check web/app.js
node --check web/sw.js
```

首次把 `Cargo.toml` 的 `version = "1.0.0"` 推到 `main` 时，release workflow 会在测试全部通过后创建 `v1.0.0` Release，并上传：

```text
remote-caller-linux-x86_64.tar.gz
remote-caller-linux-x86_64.tar.gz.sha256
```

之后同一版本已经存在 Release 时不会重复发布。新版本先更新 `Cargo.toml`/`Cargo.lock`，再推送 `main` 或显式推送对应 SemVer tag。

## 文档

- [生产部署](docs/DEPLOYMENT_ZH.md)
- [架构与安全边界](docs/ARCHITECTURE_ZH.md)
- [运维与故障处理](docs/OPERATIONS_ZH.md)
- [弱网与性能测试](docs/PERFORMANCE_TEST_ZH.md)
- [编解码与质量策略](docs/ALGORITHM_ZH.md)
- [iOS / Android 使用指南](docs/USER_GUIDE_ZH.md)
- [贡献与发布流程](CONTRIBUTING.md)

## 平台限制

浏览器可以支持数小时的前台通话和网络切换恢复，但**无法保证 iOS/Android 锁屏后无限期保持 WebRTC 采集与网络活动**。这是移动操作系统对 Web/PWA 后台执行的限制，不是服务端心跳能够绕过的。如果目标升级为系统电话级锁屏通话、来电推送和 CallKit/ConnectionService 集成，需要额外开发原生移动客户端。

## License

MIT
