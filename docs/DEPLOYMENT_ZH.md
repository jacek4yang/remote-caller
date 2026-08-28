# 单服务器 Linux x86_64 部署指南

生产只运行 Nginx 和一个 Rust ELF。Nginx 提供静态前端、HTTPS 和 WSS；Rust 进程在回环地址提供鉴权/信令，并直接在公网地址提供 STUN/TURN。无需 Docker、Kubernetes、Redis、数据库或 Coturn 服务。

以下示例使用：

    域名：call.example.com（必须替换）
    公网 IPv4：203.0.113.10（必须替换）
    安装目录：/opt/remote-caller
    静态文件：/var/www/remote-caller/web

## 1. DNS、系统包与防火墙

为域名添加指向 VPS 公网 IPv4 的 A 记录。普通 HTTP CDN 不能代理 TURN；使用 Cloudflare 时应选择“仅 DNS”。如果 VPS 在 NAT 后面，必须有可入站的公网 IP 和正确端口转发；CGNAT 不适合作为该 TURN 服务端。

Ubuntu 22.04/24.04：

    sudo apt update
    sudo apt install nginx certbot curl openssl

先确保 SSH 规则不会把自己锁在服务器外，然后开放：

    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp
    sudo ufw allow 3478/udp
    sudo ufw allow 3478/tcp
    sudo ufw allow 5349/tcp
    sudo ufw enable
    sudo ufw status

端口含义：

| 公网端口 | 是否需要 | 用途 |
|---|---|---|
| TCP 80 | 证书 HTTP-01/跳转时需要 | ACME 和 HTTPS 跳转 |
| TCP 443 | 必需 | HTTPS/WSS |
| UDP 3478 | 必需 | STUN/TURN 首选通道 |
| TCP 3478 | 必需 | TURN/TCP 回退 |
| TCP 5349 | 配置 TURN TLS 时需要 | TURNS |

绝不能开放 Rust 内部 TCP 8080。此版本的 TURN_RELAY_MIN_PORT/TURN_RELAY_MAX_PORT 是进程内虚拟 allocation ID，经 3478/5349 listener 复用，并不会 bind 对应的 Linux UDP/TCP socket；因此不要开放 49160–49175。

## 2. 获取并校验 v1.0.0

从 GitHub Release 下载同一版本的两个文件，然后在同一目录执行：

    sha256sum -c SHA256SUMS
    tar -xzf remote-caller-v1.0.0-linux-x86_64.tar.gz
    cd remote-caller-v1.0.0-linux-x86_64
    ./bin/remote-caller --help >/dev/null 2>&1 || test $? -eq 2

最后一条只验证 Linux loader 能启动二进制；普通服务启动需要完整环境配置。发布二进制以 Ubuntu 22.04、x86-64-v2 为兼容基线。

如从源码构建，需要 Rust 1.85+、C/C++ toolchain、CMake 和 pkg-config：

    sudo apt install build-essential cmake pkg-config
    chmod +x scripts/build-release.sh
    ./scripts/build-release.sh
    sha256sum -c SHA256SUMS

本地脚本与 tag workflow 都生成 remote-caller-v1.0.0-linux-x86_64.tar.gz。

## 3. 首次签发 TLS 证书

    CALL_DOMAIN=call.example.com
    sudo install -d /var/www/letsencrypt
    sed "s/call\.example\.com/$CALL_DOMAIN/g" deploy/nginx/bootstrap.conf |
      sudo tee /etc/nginx/conf.d/remote-caller.conf >/dev/null
    sudo nginx -t
    sudo systemctl reload nginx
    sudo certbot certonly --webroot -w /var/www/letsencrypt -d "$CALL_DOMAIN"

先用 HTTP-only bootstrap 配置签发证书。最终 Nginx 文件保留相同的 ACME webroot location，因此后续 certbot renew 不会被 HTTPS 跳转破坏。

## 4. 生成两个密码哈希和两个 secret

在不会记录终端输入的交互 shell 中执行：

    read -rsp 'Caller one password: ' PASSWORD_ONE; echo
    HASH_ONE=$(printf '%s' "$PASSWORD_ONE" | ./bin/remote-caller hash-password)
    unset PASSWORD_ONE
    read -rsp 'Caller two password: ' PASSWORD_TWO; echo
    HASH_TWO=$(printf '%s' "$PASSWORD_TWO" | ./bin/remote-caller hash-password)
    unset PASSWORD_TWO
    JWT_VALUE=$(openssl rand -base64 48)
    TURN_VALUE=$(openssl rand -base64 48)
    test "$JWT_VALUE" != "$TURN_VALUE"

密码必须是 10–256 字符。JWT_VALUE 和 TURN_VALUE 必须不同。不要把密码、hash 或 secret 提交到 Git、发到聊天中或写进 Release 包。

AUTH_USERS_JSON 必须包含两个不同账号，例如：

    AUTH_USERS_JSON='[{"username":"caller-one","displayName":"Caller One","passwordHash":"$argon2id$REPLACE_WITH_FIRST_HASH","role":"user"},{"username":"caller-two","displayName":"Caller Two","passwordHash":"$argon2id$REPLACE_WITH_SECOND_HASH","role":"user"}]'

## 5. 安装文件与配置

    CALL_DOMAIN=call.example.com
    sudo useradd --system --home /opt/remote-caller --shell /usr/sbin/nologin remote-caller 2>/dev/null || true
    sudo install -d -o root -g root /opt/remote-caller/bin
    sudo install -m 0755 bin/remote-caller /opt/remote-caller/bin/remote-caller
    sudo install -d -o root -g root /var/www/remote-caller/web
    sudo cp -a web/. /var/www/remote-caller/web/

    sudo install -d -o root -g remote-caller -m 0750 /etc/remote-caller/tls
    sudo install -o root -g remote-caller -m 0640 \
      "/etc/letsencrypt/live/$CALL_DOMAIN/fullchain.pem" \
      /etc/remote-caller/tls/fullchain.pem
    sudo install -o root -g remote-caller -m 0640 \
      "/etc/letsencrypt/live/$CALL_DOMAIN/privkey.pem" \
      /etc/remote-caller/tls/privkey.pem

    sed "s/call\.example\.com/$CALL_DOMAIN/g" deploy/systemd/remote-caller.env.example |
      sudo tee /etc/remote-caller/remote-caller.env >/dev/null
    sudo chmod 0600 /etc/remote-caller/remote-caller.env
    sudo install -m 0644 deploy/systemd/remote-caller.service /etc/systemd/system/remote-caller.service

用 sudoedit /etc/remote-caller/remote-caller.env 完成以下替换：

- JWT_SECRET → JWT_VALUE 的值；
- TURN_SECRET → TURN_VALUE 的值；
- TURN_PUBLIC_IP → VPS 的实际公网 IPv4；
- 两个 passwordHash placeholder → HASH_ONE、HASH_TWO 的完整 Argon2id PHC 字符串；
- 根据需要修改两个 username/displayName。

保持 BIND_ADDR=127.0.0.1:8080、SERVE_STATIC=false、EMBEDDED_TURN=true。确认环境文件中没有任何 placeholder：

    if sudo grep -n REPLACE_WITH /etc/remote-caller/remote-caller.env; then
      echo 'configuration still contains placeholders' >&2
      exit 1
    fi

不要打印完整环境文件到日志或工单。

## 6. 安装最终 Nginx 和启动 systemd

    CALL_DOMAIN=call.example.com
    sed "s/call\.example\.com/$CALL_DOMAIN/g" deploy/nginx/remote-caller.conf |
      sudo tee /etc/nginx/conf.d/remote-caller.conf >/dev/null
    sudo nginx -t
    sudo systemctl reload nginx

    sudo systemd-analyze verify /etc/systemd/system/remote-caller.service
    sudo systemctl daemon-reload
    sudo systemctl enable --now remote-caller
    sudo systemctl status remote-caller --no-pager
    curl -fsS http://127.0.0.1:8080/health/ready
    curl -fsS "https://$CALL_DOMAIN/health/ready"

Readiness 在 HTTP 已接受正常流量且 embedded TURN 的 TCP listener 已成功 bind 后才返回 200。TURN 子任务意外退出会结束主进程，随后由 systemd 重启整套服务。

## 7. 证书自动续期

创建 hook 前把其中的 call.example.com 替换成实际域名：

    sudoedit /etc/letsencrypt/renewal-hooks/deploy/restart-remote-caller.sh

文件内容：

    #!/bin/sh
    set -eu
    install -o root -g remote-caller -m 0640 \
      /etc/letsencrypt/live/call.example.com/fullchain.pem \
      /etc/remote-caller/tls/fullchain.pem
    install -o root -g remote-caller -m 0640 \
      /etc/letsencrypt/live/call.example.com/privkey.pem \
      /etc/remote-caller/tls/privkey.pem
    systemctl restart remote-caller
    systemctl reload nginx

    sudo chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/restart-remote-caller.sh
    sudo certbot renew --dry-run

## 8. 部署后验证

    CALL_DOMAIN=call.example.com
    getent ahostsv4 "$CALL_DOMAIN"
    curl -fsS "https://$CALL_DOMAIN/health/live" -o /dev/null
    curl -fsS "https://$CALL_DOMAIN/health/ready"
    curl -fsSI "https://$CALL_DOMAIN/" | grep -Ei \
      'strict-transport-security|content-security-policy|x-content-type-options|referrer-policy'
    openssl s_client -connect "$CALL_DOMAIN:5349" -servername "$CALL_DOMAIN" </dev/null
    sudo ss -lntup | grep -E ':(80|443|8080|3478|5349)\b'
    sudo journalctl -u remote-caller -n 200 --no-pager

ss 应显示 8080 只监听 127.0.0.1。还必须用两个真实账号和两台真实设备验证：同 room 登录、第三账号拒绝、TURN/UDP、TURN/TCP、TURNS、Wi-Fi/蜂窝切换、摄像头切换和长时间前台通话。虚拟 relay port 模型要求双方从同一实例取得 relay allocation，并选择 relay-to-relay candidate pair；这项真实公网兼容性不能由单元测试证明。

## 9. 升级

先在新 Release 目录校验 SHA256SUMS，然后：

    sudo cp /opt/remote-caller/bin/remote-caller /opt/remote-caller/bin/remote-caller.previous
    sudo rm -rf /var/www/remote-caller/web.previous
    sudo cp -a /var/www/remote-caller/web /var/www/remote-caller/web.previous
    sudo install -m 0755 bin/remote-caller /opt/remote-caller/bin/remote-caller.new
    sudo mv /opt/remote-caller/bin/remote-caller.new /opt/remote-caller/bin/remote-caller
    sudo cp -a web/. /var/www/remote-caller/web/
    sudo systemctl restart remote-caller
    sudo nginx -t
    sudo systemctl reload nginx
    curl -fsS http://127.0.0.1:8080/health/ready

如版本修改了示例配置，先人工比较，不要覆盖真实 secret：

    diff -u deploy/systemd/remote-caller.env.example /etc/remote-caller/remote-caller.env || true

## 10. 回滚

    sudo cp /opt/remote-caller/bin/remote-caller.previous /opt/remote-caller/bin/remote-caller
    sudo rm -rf /var/www/remote-caller/web
    sudo mv /var/www/remote-caller/web.previous /var/www/remote-caller/web
    sudo systemctl restart remote-caller
    sudo nginx -t
    sudo systemctl reload nginx
    curl -fsS http://127.0.0.1:8080/health/ready

应用没有数据库迁移。短暂重启期间已建立的 P2P 媒体可能继续，但需要重新协商或 TURN 的通话会受影响。

## 11. 可选 WSL 生产形态验收

scripts/test-production-wsl.sh 会安装临时配置/证书，验证 HTTPS header、登录、ticket/WebSocket、STUN、TURN UDP/TCP/TLS、错误 TURN 密码、并发 HTTP 和 systemd stop/start，最后清理服务。coturn 软件包在此仅提供外部协议测试客户端；Coturn daemon 会被停用，生产不需要该包。

在启用 systemd 的 Ubuntu WSL 中：

    sudo apt update
    sudo apt install nginx openssl curl coturn wrk build-essential cmake pkg-config
    sudo systemctl disable --now coturn
    chmod +x scripts/test-production-wsl.sh
    sudo WORKSPACE="$PWD" CARGO_TARGET_DIR="$PWD/target-wsl" scripts/test-production-wsl.sh

Release 解压目录可额外设置 REMOTE_CALLER_BIN="$PWD/bin/remote-caller"。WSL 测试不能代替真实域名、公网 NAT、iPhone/Android 或多小时弱网验证。
