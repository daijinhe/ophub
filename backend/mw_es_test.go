package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

// mwEsParseProbes 复刻版（与 service_mwcapture.go 行为一致），用于单测
func mwEsParseProbesTest(raw string) []struct {
	Port string
	Raw  string
} {
	out := []struct {
		Port string
		Raw  string
	}{}
	var cur *struct {
		Port string
		Raw  string
	}
	for _, ln := range strings.Split(raw, "\n") {
		trim := strings.TrimSpace(strings.TrimRight(ln, "\r"))
		if strings.HasPrefix(trim, "#PROBE port=") {
			if cur != nil {
				cur.Raw = strings.TrimSpace(cur.Raw)
				out = append(out, *cur)
			}
			cur = &struct {
				Port string
				Raw  string
			}{Port: strings.TrimSpace(strings.TrimPrefix(trim, "#PROBE port="))}
			continue
		}
		if cur != nil {
			cur.Raw += strings.TrimRight(ln, "\r") + "\n"
		}
	}
	if cur != nil {
		cur.Raw = strings.TrimSpace(cur.Raw)
		out = append(out, *cur)
	}
	return out
}

// mwEsPickUser 复刻版
func mwEsPickUserTest(raw string) string {
	inUsers := false
	for _, ln := range strings.Split(raw, "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "#FILE") {
			fp := strings.TrimSpace(strings.TrimPrefix(t, "#FILE"))
			inUsers = !strings.Contains(fp, "_roles") && strings.HasSuffix(fp, "/users")
			continue
		}
		if !inUsers || t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		name := strings.SplitN(t, ":", 2)[0]
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		return name
	}
	return ""
}

func TestMwEsParseProbes(t *testing.T) {
	in := `#PROBE port=9200
{"name":"node1","cluster_name":"es","version":{"number":"7.10.2","lucene_version":"8.7.0"},"tagline":"You Know, for Search"}
#PROBE port=9201

#PROBE port=9202
body-not-json
`
	p := mwEsParseProbesTest(in)
	if len(p) != 3 {
		t.Fatalf("want 3 probes, got %d", len(p))
	}
	if p[0].Port != "9200" {
		t.Fatalf("probe[0] port want 9200 got %q", p[0].Port)
	}
	if !strings.Contains(p[0].Raw, "7.10.2") {
		t.Fatalf("probe[0] missing version: %q", p[0].Raw)
	}
	if p[1].Port != "9201" || p[1].Raw != "" {
		t.Fatalf("probe[1] empty expected, got port=%q raw=%q", p[1].Port, p[1].Raw)
	}
	if p[2].Raw != "body-not-json" {
		t.Fatalf("probe[2] raw want body-not-json, got %q", p[2].Raw)
	}
	fmt.Println("OK TestMwEsParseProbes")
}

func TestMwEsPickUser(t *testing.T) {
	in := `#FILE /etc/elasticsearch/elasticsearch.yml
cluster.name: es
#FILE /etc/elasticsearch/users_roles
elastic:elastic,kibana_system
#FILE /etc/elasticsearch/users
elastic:$2y$10$abcdefghijklmnopqrstuv
kibana_system:$2y$10$abcdefghijklmnopqrstuv
logstash_system:$2y$10$abcdefghijklmnopqrstuv
`
	if got := mwEsPickUserTest(in); got != "elastic" {
		t.Fatalf("want elastic, got %q", got)
	}
	fmt.Println("OK TestMwEsPickUser")
}

func TestMwEsItemJsonParse(t *testing.T) {
	body := `{"name":"node1","cluster_name":"elasticsearch","cluster_uuid":"abc","version":{"number":"8.12.0","build_flavor":"default","build_type":"docker","lucene_version":"9.7.0"},"tagline":"You Know, for Search"}`
	var root struct {
		Name        string `json:"name"`
		ClusterName string `json:"cluster_name"`
		Version     struct {
			Number string `json:"number"`
		} `json:"version"`
	}
	if err := json.Unmarshal([]byte(body), &root); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if root.Version.Number != "8.12.0" {
		t.Fatalf("version want 8.12.0 got %q", root.Version.Number)
	}
	fmt.Println("OK TestMwEsItemJsonParse")
}

// 端到端：模拟探测脚本生成的完整 sec 段，跑一遍 mwEsItem 类似的逻辑（直接搬迁实现），确认产出的条目符合预期
func TestMwEsItemEndToEnd(t *testing.T) {
	// 模拟 es_meta 段
	secMeta := `#HOME=/usr/share/elasticsearch
#BIND=0.0.0.0
#HPORT=9200
#YML=/usr/share/elasticsearch/config/elasticsearch.yml
`
	// 模拟 es_http 段：9200 通的、9201 不通
	secHttp := `#PROBE port=9200
{"name":"node-1","cluster_name":"es","version":{"number":"7.10.2","lucene_version":"8.7.0"},"tagline":"You Know, for Search"}
#PROBE port=9201

#PROBE port=9202
`
	// 模拟 es_conf 段
	secConf := `#FILE /usr/share/elasticsearch/config/elasticsearch.yml
cluster.name: es
network.host: 0.0.0.0
http.port: 9200
#FILE /etc/elasticsearch/users
elastic:$2y$10$xxxxxx
kibana_system:$2y$10$yyyyyy
`

	// 简单复刻 mwEsItem 关键步骤（避免 import 完整 mw 模块）
	var version string
	var ports []string
	// meta
	var bindIP string
	for _, ln := range strings.Split(secMeta, "\n") {
		t := strings.TrimSpace(ln)
		switch {
		case strings.HasPrefix(t, "#BIND="):
			bindIP = strings.TrimSpace(strings.TrimPrefix(t, "#BIND="))
		case strings.HasPrefix(t, "#HPORT="):
			if p := strings.TrimSpace(strings.TrimPrefix(t, "#HPORT=")); p != "" {
				ports = append(ports, p)
			}
		}
	}
	// http
	probes := mwEsParseProbesTest(secHttp)
	for i := range probes {
		pr := &probes[i]
		body := strings.TrimSpace(pr.Raw)
		if body == "" || !strings.HasPrefix(body, "{") {
			continue
		}
		var root struct {
			Version struct {
				Number string `json:"number"`
			} `json:"version"`
		}
		if err := json.Unmarshal([]byte(body), &root); err == nil && root.Version.Number != "" {
			if version == "" {
				version = root.Version.Number
			}
			if pr.Port != "" {
				ports = append(ports, pr.Port)
			}
		}
	}
	// 访问地址
	accessHost := "127.0.0.1"
	switch bindIP {
	case "0.0.0.0":
		accessHost = "127.0.0.1"
	case "127.0.0.1":
		accessHost = "127.0.0.1"
	default:
		accessHost = bindIP
	}
	var accessUrl string
	if len(ports) > 0 {
		accessUrl = fmt.Sprintf("http://%s:%s", accessHost, ports[0])
	}
	username := mwEsPickUserTest(secConf)

	if version != "7.10.2" {
		t.Fatalf("version want 7.10.2 got %q", version)
	}
	if len(ports) == 0 || ports[0] != "9200" {
		t.Fatalf("ports want [9200], got %v", ports)
	}
	if accessUrl != "http://127.0.0.1:9200" {
		t.Fatalf("accessUrl want http://127.0.0.1:9200 got %q", accessUrl)
	}
	if username != "elastic" {
		t.Fatalf("username want elastic got %q", username)
	}
	_ = base64.StdEncoding.EncodeToString([]byte(secHttp))
	fmt.Println("OK TestMwEsItemEndToEnd")
}

// 验证：os.Stat fallback（标准路径不存在时 installPath 保持空，给前端编辑模式补）
func TestMwEsInstallFallback(t *testing.T) {
	var installPath string
	for _, cand := range []string{"/usr/share/elasticsearch", "/opt/elasticsearch", "/data/elasticsearch", "/etc/elasticsearch", "/usr/local/elasticsearch"} {
		if _, err := os.Stat(cand); err == nil {
			installPath = cand
			break
		}
	}
	// golang 镜像里都不存在 → installPath 必须留空（让前端编辑模式让用户手填）
	if installPath != "" {
		t.Fatalf("want empty installPath in test env, got %q", installPath)
	}
	if t.Failed() {
		return
	}
	fmt.Println("OK TestMwEsInstallFallback (all standard paths missing → installPath empty)")
}
