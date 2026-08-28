# 架构与安全说明

## 目标边界

v1.0.0 针对固定少量白名单用户、单服务器、双人房间设计。典型实例只配置两个账号。它不是开放注册的公共 TURN、会议 SaaS 或多人 SFU。

```text
Browser A <================ DTLS-SRTP / P2P ================> Browser B
    |                                                             |
    +---- HTTPS/WSS ---- Nginx ---- 127.0.0.1 Rust ---- HTTPS/WSS +
    |                              |                              |
    +---- STUN/TURN ---------------+------------------------------+
```

正常网络下媒体不经过 HTTP/信令路径；只有 ICE 判断 P2P 不可用时，媒体才经内嵌 Rust TURN 中继。

## 身份和信令路径

1. 用户以预配置账号登录。
2. Rust 在受全局 semaphore 限制的 blocking worker 中执行 Argon2id 校验；未知用户名也完成一次 Argon2 校验。
3. 登录成功后返回 HS256 JWT。JWT 默认有效 7 天，只保存在当前页面内存中。
4. 客户端用 Bearer JWT 调 `/api/config` 获取 ICE 配置。
5. 客户端在建立 WebSocket 前用 Bearer JWT 调 `/api/ws-ticket`，提交目标 room。
6. 服务端生成 UUID ticket，默认 30 秒有效、只能消费一次、且和 JWT claims + room 绑定。
7. 浏览器只把 ticket 放入 `/ws?ticket=...`，因此长期 JWT 不进入 WebSocket URL、代理查询日志或浏览器网络历史。
8. ticket 消费后，服务端依次检查全局 WS 上限、单账号 WS 上限和 room 上限；同一个 room 最多两人。

## TURN 认证模型

当前 `turn-server` 依赖的 TURN REST static-secret 模式可以验证 HMAC，但其时间戳用户名不是由 TURN 核心强制检查过期时间。v1.0.0 因此不再制造带时间戳、表面上“1 小时过期”的凭证。

启动时 Rust 对每个白名单账号派生：

```text
username   = "remote-caller:" + account
credential = Base64(HMAC-SHA1(TURN_SECRET,
             "remote-caller-turn-v1\0" || account))
```

随后只把这些账号加入内嵌 TURN 的 static credential table，并关闭 `static_auth_secret` 模式。因此：

- 任意构造的新 TURN username 不会被接受；
- 前端永远拿不到 `TURN_SECRET`；
- TURN 密码具有由服务器 secret 派生的高熵，不依赖用户登录密码强度；
- 同一账号的 TURN 凭证在进程生命周期内稳定，适合长时间 WebRTC allocation refresh；
- 如果凭证泄露，管理员必须轮换 `TURN_SECRET` 并重启服务；这会同时废弃所有旧 TURN 凭证。

这是一项针对“两个可信账号、无额外服务”的明确取舍，而不是公共 TURN 服务的推荐模型。

## 有界资源模型

默认：

```text
Argon2 同时计算             2
全局 WebSocket             16
单账号 WebSocket            3
同时存在的 room             8
待消费 WS tickets          32
room 成员                   2
单 WS 有效信令速率          30 msg/s
单 WS 消息                 64 KiB
HTTP request body            8 KiB
TURN virtual relay IDs      16
TURN sessions/transports    64
```

房间、单用户连接和 ticket 使用 RAII/semaphore 释放容量。创建 ticket 时会清理已过期而从未消费的 ticket，避免容量被永久占住。vendored TURN patch 同时限制 UDP source tuple、TCP/TLS connection 和已认证/未认证 session；未认证 challenge 30 秒过期，allocation 最长 1 小时。

这些数字不是为了吞吐最大化，而是因为私人双人实例没有理由允许攻击者建立成千上万的应用层状态。

## 长时间通话与网络切换

前端对所有远端 SDP/ICE 消息串行处理，避免 `setRemoteDescription()` 尚未完成时 `addIceCandidate()` 抢跑。远端描述尚未安装时到达的 ICE candidate 暂存在队列中。

连接恢复路径：

```text
WebSocket:
  20s Ping -> 断开 -> 1s/2s/.../10s 指数退避重连 -> 新一次性 ticket

WebRTC:
  disconnected 3s -> ICE restart
  failed         -> 立即 ICE restart
  多次失败       -> 重建 RTCPeerConnection -> 重新协商
```

Offer glare 使用 polite/impolite 角色和 rollback 处理，避免双方同时协商导致随机失败。Nginx 将 WS read/send timeout 设为 75 秒；应用每 20 秒发送 Ping，健康连接会持续刷新该计时器，而失活连接能及时回收。

已有 P2P 媒体在信令进程短暂重启时通常仍能继续；需要重新协商或网络切换时客户端再连接信令服务。

## 媒体质量

应用不自行发明“像素差分协议”，而使用浏览器成熟的 WebRTC 拥塞控制、Opus 和视频编码器。客户端通过 `getStats()` 读取 RTT、丢包和可用出口码率，以慢升快降策略调整发送质量；详细策略见 `ALGORITHM_ZH.md` 和 `PERFORMANCE_TEST_ZH.md`。

## 公网边界

生产必须保持：

```text
Rust HTTP/WS: 127.0.0.1:8080
Nginx:        80/443 public
TURN:         3478 UDP/TCP public
TURNS:        5349 TCP public
Relay IDs:    49160-49175 virtual; not firewall ports
```

不要把 8080 暴露到公网，否则会绕过 Nginx 的连接、请求速率、body size 和 TLS 边界。

Nginx 示例启用登录/ticket 限流、每 IP 连接上限、HSTS、CSP、Permissions-Policy、`X-Frame-Options: DENY`、`nosniff`，并禁止公开访问 `/metrics`。

## 仍然存在的现实风险

- 公网端口一定会被扫描；“安全”意味着把未授权操作和资源消耗限制住，而不是没人探测。
- 固定 TURN credential 一旦泄露，要靠 secret rotation 废弃；不要把这个实例当开放 TURN。
- 当前 embedded TURN 把 relay port 当作同一进程内的虚拟 allocation ID，只在已连接到同一实例的 allocation 之间转发。它不在这些 ID 上 bind 系统 socket，也不向任意公网 peer 转发；ICE 必须形成 relay-to-relay candidate pair。该限制降低滥用面，但真实浏览器/NAT 兼容性必须实机验证。
- 单机无法抵御服务器宕机、机房故障、DDoS 塞满公网带宽等故障域。
- WebRTC DTLS-SRTP 加密媒体，但本项目没有实现独立的端到端身份指纹核验协议。
- 浏览器/PWA 无法保证手机锁屏后无限时长通话；若需要系统电话级后台能力必须开发原生客户端。
