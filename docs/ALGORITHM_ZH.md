# 高清低延迟算法方案

## 最终组合

本项目采用“浏览器原生实时编码器 + 能力探测 + 时域可伸缩编码 + 拥塞控制监督”的组合：

1. 申请摄像头 1920×1080、最高 60fps，麦克风 48kHz/16bit 单声道。
2. 使用 W3C Media Capabilities 对浏览器提供的 AV1、VP9、H.264、VP8 逐个测试 1080p/60fps：`supported` 是硬门槛，`smooth` 加分，`powerEfficient` 最高加分。
3. 能力探测不可用时，高性能设备按 AV1 → VP9 → H.264 → VP8；Apple/低功耗 Android 按 H.264 → VP8 → VP9 → AV1 回退，避免软件 AV1 编码导致发热、掉帧和高延迟。
4. 支持时设置 `L1T3`：单一 1080p RTP 流包含三层时域依赖。60fps 增强层可在拥塞时丢弃，基础层仍可解码，不需要重新协商或发送三份完整视频。
5. WebRTC 编码器完成帧内压缩、帧间预测、运动估计、变换量化和熵编码；应用不重复做像素差分。
6. 浏览器内部拥塞控制根据传输延迟和丢包调节真实发送率；应用每两秒读取标准统计，用非对称 EWMA 做第二层监督：网络下降权重 0.55、恢复权重 0.15，快速避让、谨慎升档。
7. 丢包恢复交给 WebRTC 的 NACK、关键帧请求、RTX/RED/FEC 组合。应用保留修复编解码器，不用 TCP 重传视频帧造成队头阻塞。
8. 音频使用 Opus 48kHz 全频带、96Kbit/s VBR、in-band FEC。关闭 DTX，优先保持呼吸声、尾音和连续环境音质量。

## 质量档位

| 档位 | 分辨率 | 帧率上限 | 视频码率上限 | 进入条件参考 |
|---|---:|---:|---:|---|
| 极清 | 1920×1080 | 60fps | 8Mbit/s | 可用上行 ≥6.5M、丢包 <3%、RTT <300ms |
| 超清 | 1920×1080 | 45fps | 5.5Mbit/s | 可用上行 4–6.5M |
| 高清 | 1920×1080 | 30fps | 3.5Mbit/s | 可用上行 2.2–4M |
| 弱网保护 | 1280×720 | 30fps | 1.8Mbit/s | 更差网络或编码器 CPU 受限 |

连续两个坏样本才下降一档；连续八个好样本才上升一档。分辨率最低保持 720p，不主动降到标清。若实际可用上行低于 1.8Mbit/s，浏览器仍会为避免网络崩溃而降低真实码率，此时不可能同时保证 720p/30fps 和无压缩痕迹。

## 为什么不用自制像素差分

H.264、VP9 和 AV1 已经对参考帧做宏块/分块运动搜索，只编码预测残差；AV1 还拥有更丰富的分块、预测和变换工具。先在 JavaScript/Canvas 计算画面差分再交给视频编码器，会发生重复计算，并可能破坏编码器参考帧、硬件加速、色彩路径和零拷贝采集，移动端更容易发热和掉帧。

WebCodecs + WebTransport 的自定义媒体协议理论上控制更细，但需要自行实现抖动缓冲、拥塞控制、NAT 穿越、丢包恢复、音画同步、密钥协商、iOS 后台行为和硬件兼容性；对双人浏览器通话，它不是性能升级，而是丢弃成熟的 WebRTC 实时链路。

## 没有强制使用某一个编码器的原因

AV1 通常具有更好的率失真效率，但软件编码 1080p/60fps 可能比硬件 H.264 更慢、更耗电。真正的“最佳”必须结合设备：支持、是否平滑、是否省电、双方共同解码能力。代码先让浏览器报告能力再排序，而不是根据宣传参数强制 AV1。

## 标准与研究依据

- [W3C WebRTC：发送参数、码率和编码器偏好](https://www.w3.org/TR/webrtc/)
- [W3C Media Capabilities：WebRTC 编码是否平滑、省电](https://www.w3.org/TR/media-capabilities/)
- [W3C WebRTC SVC：L1T3 等时域/空间可伸缩模式](https://www.w3.org/TR/webrtc-svc/)
- [W3C WebRTC Stats：丢包、RTT、码率、编码帧率](https://www.w3.org/TR/webrtc-stats/)
- [RFC 7587：Opus VBR、FEC、DTX 和声道参数](https://www.rfc-editor.org/rfc/rfc7587)
- [Google Research：WebRTC 的 NACK/FEC 与时域层混合丢包恢复](https://research.google/pubs/handling-packet-loss-in-webrtc/)

