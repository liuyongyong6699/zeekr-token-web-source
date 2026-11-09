# Zeekr Token Local Web - Docker 部署指南（ARM64）

## 支持架构

- `linux/arm64`（ARMv8，如树莓派 4/5、树莓派 Zero 2 W、Apple Silicon、Android 装 Linux 等）
- `linux/amd64`（x86_64 PC/服务器）

## 一、快速开始（ARM64）

### 方法 A：直接用源码跑（无需 Docker）

```bash
cd zeekr-token-web
npm ci
npm run browser:install
npm start
# 浏览器打开 http://localhost:8767
```

### 方法 B：用 Docker（推荐）

#### 单机编译（ARM64）

```bash
cd zeekr-token-web
docker build --platform linux/arm64 -t zeekr-token-web:1.0.1 .
docker run -d \
  --name zeekr-token \
  --restart unless-stopped \
  -p 8767:8767 \
  -m 1g \
  --cpus=1.5 \
  --cap-add=SYS_ADMIN \
  zeekr-token-web:1.0.1
```

浏览器打开：`http://localhost:8767`

#### Docker Compose

```bash
cd zeekr-token-web
docker compose up -d
```

浏览器打开：`http://localhost:8767`

### 方法 C：多架构镜像（推送到仓库）

```bash
# 安装 buildx 插件后
docker buildx create --use
docker buildx build \
  --platform linux/arm64,linux/amd64 \
  -t yourname/zeekr-token-web:1.0.1 \
  --push .

# 其他机器直接拉
docker run -d --name zeekr-token -p 8767:8767 yourname/zeekr-token-web:1.0.1
```

## 二、端口与访问

- 容器内固定监听 `127.0.0.1:8767`
- 容器端口映射到宿主机 `8767`
- **仅宿主机可访问**，不建议直接暴露到公网

如果要改宿主机端口，改 `docker-compose.yml` 或 `-p 9000:8767`。

## 三、注意事项

1. **Chromium 沙箱**  
   Docker 容器内 Chromium 必须加 `--no-sandbox`，代码中已内置。容器额外添加 `cap_add: SYS_ADMIN` 以兼容。

2. **内存与 CPU**  
   建议宿主机至少 1GB 内存，CPU 1 核以上，否则 Chromium 启动易超时。

3. **ARM64 镜像体积**  
   基于 `node:22-alpine`，约 120MB；加上 Chromium 约 200MB，总镜像约 320MB。

4. **无状态设计**  
   手机号、验证码、Token 不写入磁盘，容器重启后会话清空。每次使用请完整走一遍流程。

5. **与 Minis 沙箱区别**  
   Minis 内置环境已直接可用（`http://127.0.0.1:8767`），无需 Docker。Docker 适合部署到自己的树莓派、NAS、VPS 等独立设备。

## 四、常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| `exec /usr/local/bin/docker-entrypoint.sh: not found` | 基础镜像兼容性 | 使用 `node:22-alpine` |
| Chromium 启动失败 | 缺少系统依赖 | Dockerfile 已内置 `chromium` 及字体依赖 |
| 容器无法访问官网 | 宿主机网络问题 | 确认宿主机能访问 `https://www.zeekrlife.com` |
| 端口冲突 | 8767 已被占用 | 改 `-p 8768:8767` |

## 五、安全提示

- 容器仅监听本地回环，不要将端口映射到公网 IP
- Token 等同登录凭据，复制到青龙后请立即清除剪贴板
- 不要将该镜像部署到公共服务器供多人使用