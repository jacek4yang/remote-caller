# 运维手册

## 关键指标

`/metrics` 暴露：

- `remote_caller_active_connections`：当前 WebSocket 数；
- `remote_caller_active_rooms`：当前 room 数；
- `remote_caller_total_connections`：累计 WebSocket；
- `remote_caller_signaling_messages`：累计有效信令消息；
- `remote_caller_rejected_signaling_messages`：累计因 JSON、类型、大小或速率不合格而拒绝的信令消息；
- `remote_caller_rejected_connections`：因 room 满、全局/账号容量等被拒绝的连接；
- `remote_caller_rejected_logins`：失败或受限登录；
- `remote_caller_issued_ws_tickets`：累计签发的一次性 WebSocket ticket。

生产 Nginx 默认只允许 localhost 读取 `/metrics`。

建议监控：systemd 服务状态、`/health/ready`、3478/5349 listener、服务器 NIC 入/出带宽、内存以及真实客户端 selected ICE candidate 类型。49160–49175 是进程内虚拟 allocation ID，不会出现在 `ss` 中。

## 私人双人容量

业务 HTTP/WS 流量很小。P2P 时服务器基本不承载媒体；使用 TURN relay 时，服务器同时接收并发送媒体，因此公网带宽才是主要瓶颈。

默认只给 16 个虚拟 relay ID、64 个 TURN session/transport，并对应用状态设置很低的有界上限。未认证 TURN challenge 30 秒过期，allocation/refresh 最长 1 小时。这些是防滥用边界，不是公共会议容量参数。

## 长通话预期

- JWT 默认 7 天；已经建立的 WebSocket/媒体不会因为 JWT 到达 `exp` 就被服务器主动切断。
- WebSocket 每 20 秒 Ping，Nginx read/send timeout 为 75 秒；只要页面和网络正常，应用心跳会持续刷新计时器，数小时通话不依赖“空闲连接永不过期”。
- Wi-Fi/蜂窝切换后客户端会尝试 ICE restart，多次失败再重建 PeerConnection。
- 手机系统把 Safari/Chrome/PWA 挂起或杀死时，Web 应用无法强制在后台继续运行；回到前台后会尝试恢复。

## 常见故障

| 现象 | 首要检查 | 处理 |
|---|---|---|
| 手机无法申请摄像头 | 是否可信 HTTPS | 修复证书，不使用公网/局域网裸 HTTP |
| 双方进入但无媒体 | selected ICE candidate / TURN listener | 检查 3478 UDP/TCP、5349 TCP、防火墙、`TURN_PUBLIC_IP`，并确认双方从同一实例取得 relay candidate |
| 长时间后信令断开 | Nginx 配置、页面是否被系统挂起 | 确认部署的是仓库 v1.0.0 Nginx 配置；前台页面应自动 ticket 重连 |
| Wi-Fi 切换 5G 后无媒体 | ICE restart 是否成功 | 等待自动恢复；持续失败时重新进入房间并查看浏览器 console / journal |
| 一直“等待对方” | `/api/ws-ticket` 与 `/ws` 是否成功 | 检查 Nginx、JWT 是否过期、系统日志；JWT 不再放在 WS URL 中 |
| 登录返回 429 | Argon2 并发已满或 Nginx 限流 | 等待几秒；若持续发生检查扫描/撞库流量 |
| `/api/ws-ticket` 返回 503 | pending ticket 容量被占用 | 30 秒后重试；程序会在新签发时清理过期 ticket |
| 房间 409 | 已有两名连接 | 等待旧连接清理或换新房间 |
| TURN 突然全部认证失败 | `TURN_SECRET` 或用户配置改变 | 确保前后端来自同一实例，重新登录刷新 `/api/config` |

## 密钥轮换

怀疑任何浏览器、日志或账号泄露时：

1. 为相关账号生成新密码哈希；
2. 生成新 `JWT_SECRET`；
3. 生成新 `TURN_SECRET`；
4. 更新 `/etc/remote-caller/remote-caller.env`；
5. `systemctl restart remote-caller`。

`TURN_SECRET` 变化并重启后，静态 TURN credential table 会重新派生，旧 allocation 随进程退出而释放，旧凭证无法用于新认证。严重泄露时，在完成密码与 secret 轮换前可先临时关闭公网 TURN 端口。

## 日志与隐私

Rust tracing 只记录 HTTP path，不记录 query。Nginx 对 `/ws` 关闭 access log。v1.0.0 的 WebSocket query 只包含短时一次性 ticket，而不是 JWT，但仍不建议记录完整查询字符串。

不要记录：

- 密码或 Argon2 输入；
- JWT / WebSocket ticket；
- TURN credential / `TURN_SECRET`；
- SDP 全文（可能包含网络地址和设备信息）；
- TLS 私钥。

## 备份与恢复

应用没有数据库和持久 room 状态。需要备份的是：部署脚本、域名/TLS 自动化、**安全保存的**服务器环境配置以及上一版可执行文件。不要把生产 secrets 备份到公开 Git 仓库。

## 更新与回滚

更新前：

```bash
sha256sum -c SHA256SUMS
sudo cp /opt/remote-caller/bin/remote-caller /opt/remote-caller/bin/remote-caller.previous
```

替换二进制和 web 文件后重启。若健康检查失败，恢复 `.previous` 并重启。Rust HTTP 与 embedded TURN 在同一进程；TURN 任务异常退出会使整个进程失败，再由 systemd 重启，避免只剩半套服务。
