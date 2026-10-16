# 云枢 OpsHub · 智能运维平台
# Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
# SPDX-License-Identifier: MIT

# ---- 后端编译镜像 ----
FROM golang:1.22.12 AS build

# 1️⃣ 设置国内 Go 代理（核心加速）
ENV GOPROXY=https://goproxy.cn,direct
# 如果你有私有仓库，请在这里排除，例如：
# ENV GOPRIVATE=git.mycompany.com

WORKDIR /src

# 2️⃣ 利用 Docker 缓存：先复制依赖文件，下载依赖，再复制源码
COPY go.mod go.sum* ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/app .

# ---- 运行时镜像 ----
FROM alpine:3.20
# ca-certificates：HTTPS / SSH 主机名校验依赖
# tzdata：日志时区
# ansible：v1.7.10 起 backend 容器内直接跑 ansible 命令（Adhoc/Script/ping），
#          不再 SSH 到远端控制节点。alpine:3.20 主线仓库有 ansible-core，
#          体积可控；openssh-client / bash 是 ansible -m script / 协议脚本的依赖
# sshpass：ansible 密码认证（ansible_ssh_pass）强制依赖，缺了所有 Adhoc 全挂
#          （实测 v1.7.11/v1.7.12 资源校准 500 就是它）
RUN apk add --no-cache ca-certificates tzdata ansible openssh-client sshpass bash
WORKDIR /app
COPY --from=build /out/app .
EXPOSE 8080
CMD ["./app"]