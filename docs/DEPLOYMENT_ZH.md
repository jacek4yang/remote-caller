# 单服务器 Linux x86_64 部署指南

最终只运行两个进程：Nginx 托管前端与 HTTPS，一个 Rust ELF 同时提供鉴权、WebSocket 信令、STUN 和 TURN 中继。无需 Docker、Kubernetes 或 Coturn。

## 1. 网络拓扑与 DNS

```text
call.example.com  ──A记录──> 服务器公网 IPv4
                                  │
                 ┌────────────────┼─────────────────┐
                 │                │                 │
             Nginx 80/443   Rust HTTP 127.0.0.1   同一 Rust 进程
             静态前端/TLS        :8080            TURN 3478/5349
                                                   UDP 49160-49175
```

DNS 控制台只需一条 A 记录：主机记录 `call`，值为服务器公网 IPv4，初始 TTL 300。使用 Cloudflare 时设置为“仅 DNS / 灰色云”。TURN 不是 HTTP，不能穿过普通 CDN 代理。只有服务器和防火墙完整支持 IPv6 时才添加 AAAA。

不建议直接使用 IP：iOS/Android 浏览器需要可信 HTTPS 才开放摄像头和麦克风，域名证书最稳定。若服务器位于家用路由器后，必须具有真实公网 IP，并将下列端口转发到 Linux 内网 IP；运营商 CGNAT 环境不能直接作为 TURN 服务端。

## 2. 防火墙和依赖

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 49160:49175/udp
sudo ufw enable

sudo apt update
sudo apt install nginx certbot build-essential cmake pkg-config curl
```

TURN 的 TLS 内核使用 AWS-LC，因此源码构建需要 C 编译器和 CMake。发布包运行时不需要 Rust、CMake或编译器。

## 3. 首次签发证书

```bash
sudo install -d /var/www/letsencrypt
sudo cp deploy/nginx/bootstrap.conf /etc/nginx/conf.d/remote-caller.conf
# 将 call.example.com 替换为真实域名
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/letsencrypt -d call.example.com
```

最终 Nginx 配置引用证书，因此必须先用纯 HTTP 引导配置取得证书。

## 4. 构建原生二进制

```bash
chmod +x scripts/build-release.sh
./scripts/build-release.sh
sha256sum -c remote-caller-linux-release.tar.gz.sha256
```

脚本运行测试，再用 `target-cpu=native`、fat LTO、单 codegen unit、panic abort 和符号裁剪构建。该产物绑定构建机指令集。跨机器分发使用 `RUSTFLAGS='-C target-cpu=x86-64-v3' ./scripts/build-release.sh`；不支持 AVX2 的旧服务器使用 x86-64-v2。Git tag 流水线自动生成兼容 x86-64-v2 的 Linux 包及 SHA-256 文件。

## 5. 创建账号与密钥

```bash
openssl rand -base64 48  # JWT_SECRET
openssl rand -base64 48  # TURN_SECRET
printf '%s' '管理员密码至少十个字符' | dist/bin/remote-caller hash-password
printf '%s' '另一位用户的独立密码' | dist/bin/remote-caller hash-password
```

两个密码只保存 `$argon2id$...` 哈希。JWT 与 TURN 密钥必须不同且不能提交 Git。

这是私有双人服务，不要开放注册或把 `/api/config` 暴露给未登录用户。内嵌 TURN 使用 HMAC 凭证；升级版本、怀疑令牌泄露或成员变化时，应生成新的 `TURN_SECRET` 并重启服务，使所有旧 TURN 凭证立即失效。

## 6. 安装二进制和证书

```bash
sudo useradd --system --home /opt/remote-caller --shell /usr/sbin/nologin remote-caller
sudo install -d -o remote-caller -g remote-caller /opt/remote-caller/bin
sudo install -m 0755 dist/bin/remote-caller /opt/remote-caller/bin/remote-caller
sudo install -d -o root -g remote-caller -m 0750 /etc/remote-caller/tls
sudo install -o root -g remote-caller -m 0640 /etc/letsencrypt/live/call.example.com/fullchain.pem /etc/remote-caller/tls/fullchain.pem
sudo install -o root -g remote-caller -m 0640 /etc/letsencrypt/live/call.example.com/privkey.pem /etc/remote-caller/tls/privkey.pem
sudo cp deploy/systemd/remote-caller.env.example /etc/remote-caller/remote-caller.env
sudo chmod 0600 /etc/remote-caller/remote-caller.env
sudo cp deploy/systemd/remote-caller.service /etc/systemd/system/
```

编辑环境文件：替换域名和 `TURN_PUBLIC_IP`；填入 JWT/TURN 密钥、管理员哈希以及 `USERS_JSON` 中另一位用户哈希；保留哈希和 JSON 外侧单引号；保持 `BIND_ADDR=127.0.0.1:8080`、`SERVE_STATIC=false`、`EMBEDDED_TURN=true`。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now remote-caller
sudo systemctl status remote-caller
curl -fsS http://127.0.0.1:8080/health/ready
```

TURN 的 UDP、TCP 或 TLS 任一监听任务异常退出时，Rust 主进程会退出，由 systemd 整体重启，避免半健康状态。Tokio 默认按可用 CPU 并行调度；16 个中继端口足够双人多 ICE candidate，同时限制资源滥用面。

## 7. 启用最终 Nginx

```bash
sudo install -d /var/www/remote-caller/web
sudo cp -a dist/web/. /var/www/remote-caller/web/
sudo cp deploy/nginx/remote-caller.conf /etc/nginx/conf.d/remote-caller.conf
# 替换 call.example.com
sudo nginx -t && sudo systemctl reload nginx
```

Nginx 只代理 HTTP API、WebSocket、探针和指标。TURN 由同一 Rust 进程直接监听 3478/5349，不经过 Nginx，避免额外复制和协议转换。

## 8. 自动续期证书

```bash
sudo tee /etc/letsencrypt/renewal-hooks/deploy/restart-remote-caller.sh >/dev/null <<'EOF'
#!/bin/sh
install -o root -g remote-caller -m 0640 /etc/letsencrypt/live/call.example.com/fullchain.pem /etc/remote-caller/tls/fullchain.pem
install -o root -g remote-caller -m 0640 /etc/letsencrypt/live/call.example.com/privkey.pem /etc/remote-caller/tls/privkey.pem
systemctl restart remote-caller
systemctl reload nginx
EOF
sudo chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/restart-remote-caller.sh
sudo certbot renew --dry-run
```

Nginx 直接读取 Let's Encrypt 路径；Rust 低权限进程只读取属于 `root:remote-caller` 的安全副本。

## 9. 发布、回滚与验收

```bash
sudo install -m 0755 dist/bin/remote-caller /opt/remote-caller/bin/remote-caller.new
sudo mv /opt/remote-caller/bin/remote-caller.new /opt/remote-caller/bin/remote-caller
sudo systemctl restart remote-caller
sudo cp -a dist/web/. /var/www/remote-caller/web/
sudo nginx -t && sudo systemctl reload nginx
```

保留上一版 ELF 即可快速回滚。已建立的点对点媒体通常不因短暂信令重启而中断。

```bash
dig +short call.example.com A
curl -fsS https://call.example.com/health/ready
openssl s_client -connect call.example.com:5349 -servername call.example.com </dev/null
sudo ss -lntup | grep -E ':80|:443|:8080|:3478|:5349'
sudo journalctl -u remote-caller -f
```

最后在 iPhone Safari ↔ Android Chrome 验证 1080p/60fps、Wi-Fi ↔ 5G、TURN/UDP、TURN/TCP、TURNS、摄像头切换、后台恢复和[弱网测试矩阵](PERFORMANCE_TEST_ZH.md)。

## 10. WSL 全栈生产形态验收

仓库包含 `scripts/test-production-wsl.sh`。它会创建临时 systemd 服务账户和证书链，按正式文件安装 Nginx 与二进制，逐项检查 HTTPS、安全响应头、登录成功/失败、ICE 配置、WebSocket 101、TURN UDP/TCP 完整中继、TURNS 证书和 STUN 协议帧、并发 HTTP 基线以及 systemd 重启恢复，结束后自动清理服务。Coturn 软件包在这里仅提供外部测试客户端，服务会被强制停用；生产服务器不需要它。

在启用 systemd 的 Ubuntu WSL 中执行：

```bash
sudo apt update
sudo apt install nginx openssl curl coturn wrk build-essential cmake pkg-config
sudo systemctl disable --now coturn
chmod +x scripts/test-production-wsl.sh
sudo WORKSPACE="$PWD" CARGO_TARGET_DIR="$PWD/target-wsl" scripts/test-production-wsl.sh
```

测试要求先按第 4 节生成 release ELF。若直接验收解压后的发布包，增加 `REMOTE_CALLER_BIN="$PWD/bin/remote-caller"`。成功时输出 `PASS`，原始证书、Nginx 检查、套接字、TURN 丢包、并发压测和 journal 日志保留在 `/tmp/remote-caller-e2e/`。WSL 验收能发现 Linux ABI、权限、证书、反向代理、端口和服务恢复问题，但不能代替真实域名、公网 NAT、iPhone/Android 编解码器和长时间弱网验收。
