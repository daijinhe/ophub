// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

//
// SSH HostKey 校验（v1.7.1 · 安全合规）
//
//   - 旧实现：ssh.InsecureIgnoreHostKey() 永远接受任何公钥，攻击者只要在用户机器
//     → 目标机之间做 ARP/DNS 欺骗就能 MITM 拿到明文 SSH 凭据。
//   - 新实现：维护一份 known_hosts（按 host:port 存一台机器的多把公钥），
//     启动时从磁盘读、连接时按 known_hosts 严格比对，
//     遇到未知 fingerprint 时**自动 pin + 警告日志**（首次信任）。
//     PIN 之后的连接必须**精确匹配**已知公钥；公钥变更需要运维主动 confirm。
//
// 文件位置：Cfg.UploadDir 同级 ./known_hosts.json（或 KNOW_HOSTS_FILE 覆盖）。
// 部署在无网内网环境时，把这个文件挂进卷里漂移到其它机器时仍可被复用；
// 若不需要 PERSISTENT 存储，可设置 ALLOW_TEMP_TRUST=true 让首连后保留在内存。
//
// import 集中放这里避免循环依赖：net 包 + sync 用得着。
//

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"
)

// hostKeyEntry 持久化的 known_hosts 一行。
type hostKeyEntry struct {
	Host    string `json:"host"`    // host:port
	KeyType string `json:"keyType"` // ssh-ed25519 / ecdsa-sha2-nistp256 / ssh-rsa
	KeyData string `json:"keyData"` // base64 编码的 wire-format 公钥
}

// knownHosts 全局 known_hosts（按 host 索引 → 同 host 多 key）。
var (
	knownMu     sync.RWMutex
	knownByHost = map[string][]hostKeyEntry{}
)

const (
	// 默认持久化文件：./known_hosts.json（容器内 /app/known_hosts.json）。
	defaultKnownHostsFile = "./known_hosts.json"
	// envAllowTempTrust = "ALLOW_TEMP_TRUST"：true 时首连保存只到内存（K8s/容器重启即丢）；
	// 生产部署建议 false，但**首次上线 / 大量 ssh 连接迁移时**可以临时置 true。
	envAllowTempTrust = "ALLOW_TEMP_TRUST"
)

// loadKnownHosts 从磁盘加载 known_hosts；找不到文件视为首次启动（空表）。
func loadKnownHosts() {
	f := os.Getenv("KNOWN_HOSTS_FILE")
	if f == "" {
		f = defaultKnownHostsFile
	}
	data, err := os.ReadFile(f)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[known_hosts] 读取 %s 失败：%v —— 启动按首次信任处理", f, err)
		}
		return
	}
	var list []hostKeyEntry
	if err := json.Unmarshal(data, &list); err != nil {
		log.Printf("[known_hosts] 解析 %s 失败：%v —— 按首次信任处理", f, err)
		return
	}
	knownMu.Lock()
	defer knownMu.Unlock()
	for _, e := range list {
		knownByHost[e.Host] = append(knownByHost[e.Host], e)
	}
	log.Printf("[known_hosts] 已加载 %d 条 known_host 记录（文件 %s）", len(list), f)
}

// flushKnownHosts 落盘（write-temp + rename，原子替换）。
func flushKnownHosts() {
	if strings.EqualFold(os.Getenv(envAllowTempTrust), "true") {
		return
	}
	knownMu.RLock()
	list := make([]hostKeyEntry, 0, len(knownByHost))
	for _, es := range knownByHost {
		list = append(list, es...)
	}
	knownMu.RUnlock()
	f := os.Getenv("KNOWN_HOSTS_FILE")
	if f == "" {
		f = defaultKnownHostsFile
	}
	if err := os.MkdirAll(filepath.Dir(f), 0755); err != nil {
		log.Printf("[known_hosts] Mkdir %s 失败：%v（不写入磁盘）", filepath.Dir(f), err)
		return
	}
	tmp := f + ".tmp"
	data, _ := json.MarshalIndent(list, "", "  ")
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		log.Printf("[known_hosts] 写 %s 失败：%v", tmp, err)
		return
	}
	if err := os.Rename(tmp, f); err != nil {
		log.Printf("[known_hosts] 落盘 %s 失败：%v", f, err)
	}
}

// pinHostKey 把新收到的公钥 append 到 knownByHost（首次信任）。
func pinHostKey(host, keyType, keyData string) {
	knownMu.Lock()
	defer knownMu.Unlock()
	for _, e := range knownByHost[host] {
		if e.KeyType == keyType && e.KeyData == keyData {
			return // 已存在
		}
	}
	knownByHost[host] = append(knownByHost[host], hostKeyEntry{Host: host, KeyType: keyType, KeyData: keyData})
	log.Printf("[known_hosts] 首次信任 host=%s keyType=%s fingerprint=%s",
		host, keyType, fingerprintShort(keyType, keyData))
	go flushKnownHosts()
}

func fingerprintShort(keyType, keyData string) string {
	raw, err := base64.StdEncoding.DecodeString(keyData)
	if err != nil {
		return "<invalid>"
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])[:16]
}

// makeHostKeyCallback 生成一个 ssh.HostKeyCallback，按 host:port 严格比对公钥。
// 行为：
//   - 库里有该 host 且 key 命中 → allow
//   - 库里有该 host 但 key 不命中 → 拒绝（这是 MITM 告警），写日志
//   - 库里没有该 host → 落库 + allow（首次信任），打 warning 日志
//
// 注意：库是公司内网封闭环境，但仍存留一个 PIN 过程以减少被动攻击面。
func makeHostKeyCallback() ssh.HostKeyCallback {
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		host := canonicalHost(hostname, remote)
		keyData := base64.StdEncoding.EncodeToString(key.Marshal())
		keyType := key.Type()

		knownMu.RLock()
		known, found := knownByHost[host]
		knownMu.RUnlock()

		if found {
			for _, e := range known {
				if e.KeyType == keyType && e.KeyData == keyData {
					return nil // 命中 → 允许
				}
			}
			// 命中 host 但 key 不一致 → 公钥变更或 MITM
			log.Printf("[hostkey] 拒绝：host=%s 收到的 key（%s / %s） 与本地 known_hosts 不一致（怀疑 MITM 或目标机 sshd 重装）",
				host, keyType, fingerprintShort(keyType, keyData))
			return fmt.Errorf("SSH 公钥校验失败：host=%s 的公钥未在已知列表中；"+
				"若确认目标机重装过 sshd，请删除 %s 中 host=%s 的旧记录后让平台重新 pin",
				host, knownHostsFileForLog(), host)
		}

		// 库里没 host → 落库 + 警告（首次信任）
		log.Printf("[hostkey] 首次信任 host=%s keyType=%s fingerprint=%s（若非预期请删除 %s 中此 host）",
			host, keyType, fingerprintShort(keyType, keyData), knownHostsFileForLog())
		pinHostKey(host, keyType, keyData)
		return nil
	}
}

func knownHostsFileForLog() string {
	f := os.Getenv("KNOWN_HOSTS_FILE")
	if f == "" {
		return defaultKnownHostsFile
	}
	return f
}

// canonicalHost 把 client 传进来的 hostname + remote addr 归一化成 host:port 形式。
//
// ⚠️ 历史坑：原实现先用 remote.String() 拆出纯 IP 再覆盖 hostname，而
// remote 是 *net.TCPAddr 会带上端口 —— 但覆盖时只取了 host 部分，接着对**裸 IP**
// 做 SplitHostPort 必然失败，最终一律落到 `"+":0"`，于是同一 IP 的**所有端口共用一条记录**。
// 后果：内网常见的「跳板机端口映射」（10.x:65181 / 10.x:65182 指向不同虚拟机）会被判成
// 「同一 host 的公钥变了」→ 直接拒绝连接，表现为终端连不上、且日志说疑似 MITM。
//
// 正确做法：ssh.Dial 传入的 hostname 本身就是「host:port」原样地址，端口最可靠，优先用它。
func canonicalHost(hostname string, remote net.Addr) string {
	if h, p, err := net.SplitHostPort(hostname); err == nil && h != "" {
		return h + ":" + p
	}
	if remote != nil {
		if h, p, err := net.SplitHostPort(remote.String()); err == nil && h != "" {
			return h + ":" + p
		}
	}
	if hostname != "" {
		return hostname + ":0"
	}
	return "unknown:0"
}
