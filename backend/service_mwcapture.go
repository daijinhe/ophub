package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ============================================================================
// 中间件捕捉 —— 只读探测
//
// 设计要点（均来自真实环境实测，见 .workbuddy/uiverify/recon_mw*.txt）：
//
//  1. 真实环境里大量是**存量中间件**，落点与平台离线包完全不同
//     （实测：/usr/local/nginx 的 nginx 1.19.2、/usr/local/bin/redis-server 的 3.0.7、
//     /data/redis 下另一份 redis.conf），所以一律「先看进程、再看常见落点」，
//     不许假设平台部署路径。
//  2. 读配置需要 root：非 root 时 `nginx -T` 会被 logs 目录权限挡住、
//     `ss -lntp` 也不显示别人进程的 PID。因此优先提权，提权不了就降级并在页面上说明。
//  3. 宝兰德 BWS310 内核就是 nginx，但**安装位置固定**（离线包约定 /data/BWS310），
//     配置也固定只看 conf/bws.conf + conf/vhost/*.conf，因此不做落点猜测、
//     与 nginx 共用同一套配置解析器。
//  4. 远端脚本把每段输出 base64 后打成 `@@SEC:名字` 段，Go 侧逐段解码解析 ——
//     规避换行 / 特殊字符被 SSH 或 shell 吞掉的问题。
// ============================================================================

const mwCaptureTimeout = 100 * time.Second

// mwCaptureRawCap 原始输出的留存上限（排查用，不返回给前端）
const mwCaptureRawCap = 120 << 10

// mwCaptureSelfToken 探测脚本内的自识别标记。
//
// 远端命令由 sshd 以 `sh -c "<整段脚本>"` 执行，脚本正文会出现在这个 sh 进程的
// cmdline 里 —— 于是 `ps | grep java` 会把「承载探测脚本的 shell 自己」也算进去。
// 做法：脚本里埋一个固定标记串，ps 输出里带该标记的行一律排除。
const mwCaptureSelfToken = "__mwcap_self__"

// mwCaptureScript 生成只读探测脚本。
//
// 注意：不要用 fmt.Sprintf 处理脚本正文（里面大量 % 会被当动词），
// 直接拼常量即可。脚本整体以 true 收尾，保证退出码为 0。
func mwCaptureScript() string {
	return `export LC_ALL=C
SELF=` + mwCaptureSelfToken + `
b64() { if command -v base64 >/dev/null 2>&1; then base64; else openssl base64; fi 2>/dev/null; }
sec() { printf '@@SEC:%s\n' "$1"; b64 | tr -d '\n'; printf '\n'; }
cap() { head -c 400000 2>/dev/null; }

{ echo "host=$(hostname 2>/dev/null)"; echo "uid=$(id -u 2>/dev/null)"; echo "who=$(id -un 2>/dev/null)"; echo "arch=$(uname -m 2>/dev/null)"; } | sec meta
ps -eo pid,user,args 2>/dev/null | grep -v "$SELF" | cap | sec procs
{ ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null; } | cap | sec ss

# ---------------- nginx ----------------
NGX=
for b in /usr/local/nginx/sbin/nginx /opt/servers/nginx/sbin/nginx /data/nginx/sbin/nginx /usr/local/sbin/nginx /usr/sbin/nginx /usr/local/bin/nginx; do
  [ -x "$b" ] && { NGX="$b"; break; }
done
if [ -z "$NGX" ]; then
  for p in $(ps -eo pid,args 2>/dev/null | grep '[n]ginx: master' | grep -v "$SELF" | awk '{print $1}' | head -5); do
    e=$(readlink -f /proc/$p/exe 2>/dev/null)
    [ -n "$e" ] && [ -x "$e" ] && { NGX="$e"; break; }
  done
fi
if [ -n "$NGX" ]; then
  printf '%s' "$NGX" | sec nginx_bin
  { "$NGX" -v 2>&1; echo '---V---'; "$NGX" -V 2>&1; } | cap | sec nginx_info
  dump=$("$NGX" -T 2>/dev/null)
  case "$dump" in *'# configuration file'*) mode=t ;; *) dump=; mode=fb ;; esac
  printf '%s' "$mode" | sec nginx_conf_mode
  if [ -z "$dump" ]; then
    pfx=$("$NGX" -V 2>&1 | tr ' ' '\n' | grep '^--prefix=' | head -1 | cut -d= -f2)
    [ -n "$pfx" ] || pfx=$(cd "$(dirname "$NGX")/.." 2>/dev/null && pwd)
    cf=$("$NGX" -t 2>&1 | sed -n 's/.*the configuration file \(.*\) syntax is ok.*/\1/p' | head -1)
    [ -n "$cf" ] || cf="$pfx/conf/nginx.conf"
    cfd=$(dirname "$cf")
    NGSEEN=" "
    for f in "$cf" "$cfd"/vhost/*.conf "$cfd"/conf.d/*.conf "$pfx"/conf/nginx.conf "$pfx"/conf/vhost/*.conf "$pfx"/conf/conf.d/*.conf /etc/nginx/nginx.conf /etc/nginx/conf.d/*.conf /etc/nginx/vhost/*.conf; do
      [ -f "$f" ] || continue
      case "$NGSEEN" in *" $f "*) continue ;; esac
      NGSEEN="$NGSEEN$f "
      dump="$dump
# configuration file $f:
$(cat "$f" 2>/dev/null)"
    done
  fi
  printf '%s' "$dump" | cap | sec nginx_conf
fi

# ---------------- php-fpm ----------------
PHP=
for b in /opt/servers/php/sbin/php-fpm /usr/local/php/sbin/php-fpm /usr/sbin/php-fpm /usr/local/sbin/php-fpm; do
  [ -x "$b" ] && { PHP="$b"; break; }
done
if [ -z "$PHP" ]; then
  for p in $(ps -eo pid,args 2>/dev/null | grep '[p]hp-fpm: master' | grep -v "$SELF" | awk '{print $1}' | head -3); do
    e=$(readlink -f /proc/$p/exe 2>/dev/null)
    [ -n "$e" ] && [ -x "$e" ] && { PHP="$e"; break; }
  done
fi
if [ -n "$PHP" ]; then
  printf '%s' "$PHP" | sec php_bin
  { "$PHP" -v 2>&1; echo '---TT---'; "$PHP" -tt 2>&1; } | cap | sec php_info
  pcf=$(ps -eo args 2>/dev/null | grep -v "$SELF" | sed -n 's/.*php-fpm: master process (\(.*\)).*/\1/p' | head -1)
  {
    for f in "$pcf" /opt/servers/php/etc/php-fpm.conf /opt/servers/php/etc/php-fpm.d/*.conf /opt/servers/php/etc/php.ini /usr/local/php/etc/php-fpm.conf /usr/local/php/etc/php-fpm.d/*.conf /etc/php-fpm.conf /etc/php-fpm.d/*.conf; do
      [ -f "$f" ] || continue
      echo "#FILE $f"
      grep -vE '^[[:space:]]*;|^[[:space:]]*$' "$f" 2>/dev/null | head -40
    done
  } | cap | sec php_conf
fi

# ---------------- redis ----------------
RPIDS=$(ps -eo pid,args 2>/dev/null | grep '[r]edis-server' | grep -v "$SELF" | awk '{print $1}')
{
  for p in $RPIDS; do e=$(readlink -f /proc/$p/exe 2>/dev/null); echo "$p|$e"; done
} | sec redis_exe
{
  for p in $RPIDS; do e=$(readlink -f /proc/$p/exe 2>/dev/null); [ -n "$e" ] && echo "$e"; done
  for b in /data/redis-5.0.14_sentinel/bin/redis-server /data/redis-5.0.14_sentinel/src/redis-server /usr/local/bin/redis-server /usr/local/redis/bin/redis-server /usr/bin/redis-server; do
    [ -x "$b" ] && echo "$b"
  done
} | sort -u | while read -r b; do echo "#BIN $b"; "$b" -v 2>&1 | head -2; done | sec redis_info

RC=
if command -v redis-cli >/dev/null 2>&1; then
  RC=$(command -v redis-cli)
else
  for b in /data/redis-5.0.14_sentinel/bin/redis-cli /data/redis-5.0.14_sentinel/src/redis-cli /usr/local/bin/redis-cli /usr/local/redis/bin/redis-cli /usr/bin/redis-cli; do
    [ -x "$b" ] && { RC="$b"; break; }
  done
fi
if [ -n "$RC" ] && [ -n "$RPIDS" ]; then
  {
    for p in $RPIDS; do
      for pt in $(ss -lntp 2>/dev/null | grep "pid=$p," | awk '{print $4}' | sed 's/.*://' | sort -u); do
        case "$pt" in ''|*[!0-9]*) continue ;; esac
        echo "#PORT $pt"
        for k in dir logfile dbfilename appendfilename port maxmemory unixsocket; do
          v=$(timeout 4 "$RC" -h 127.0.0.1 -p "$pt" CONFIG GET "$k" 2>/dev/null | tail -1 | tr -d '"')
          [ -n "$v" ] && echo "$k=$v"
        done
        timeout 4 "$RC" -h 127.0.0.1 -p "$pt" INFO server 2>/dev/null | grep -E '^(redis_version|redis_mode|tcp_port|config_file|executable):'
      done
    done
  } | cap | sec redis_cli
fi
{
  for f in $(ps -eo args 2>/dev/null | grep '[r]edis-server' | grep -v "$SELF" | grep -o '/[^ ]*\.conf' | sort -u) /data/redis-5.0.14_sentinel/redis.conf /data/redis-5.0.14_sentinel/conf/redis.conf /usr/local/redis/redis.conf /usr/local/redis/etc/redis.conf /etc/redis.conf /etc/redis/redis.conf /data/redis/redis.conf; do
    [ -f "$f" ] || continue
    echo "#FILE $f"
    grep -iE '^[[:space:]]*(port|logfile|dir|dbfilename|appendfilename|appendonly|pidfile|maxmemory|unixsocket|bind|requirepass)[[:space:]]' "$f" 2>/dev/null | head -20
  done
} | cap | sec redis_conf

# ---------------- java ----------------
JPIDS=$(ps -eo pid,args 2>/dev/null | grep '[j]ava' | grep -v "$SELF" | awk '{print $1}')
{
  for p in $JPIDS; do
    e=$(readlink -f /proc/$p/exe 2>/dev/null)
    echo "$p|$e"
  done
} | sec java_exe
{
  for e in $(for p in $JPIDS; do readlink -f /proc/$p/exe 2>/dev/null; echo; done | grep -v '^$' | sort -u); do
    [ -x "$e" ] || continue
    echo "#JVM $e"
    timeout 20 "$e" -version 2>&1 | head -3
  done
} | cap | sec java_ver

# ---------------- 宝兰德 BWS310（安装位置固定 /data/BWS310，内核为 nginx）----------------
# 安装位置固定：平台离线包 install_bws_310_v1.1.sh 的约定就是 /data/BWS310；
# 配置只认 conf/bws.conf + conf/vhost/*.conf（bws.conf 里 include vhost/*.conf;）。
# 坑：不能拿 master 进程的 cwd 当安装目录 —— 它是 /data/BWS310/bin（bws.sh 里先 cd 进 bin 再起进程），
# 实测有机器 master 的 cmdline 干脆没有 -p（被 setproctitle 成 "BWS: master process ./bws"），
# 一旦退回 cwd 就会把安装位置写成 …/bin，配置/版本随之全丢。
BWS=
[ -d /data/BWS310 ] && BWS=/data/BWS310
if [ -z "$BWS" ]; then
  # 兜底：约定目录不存在（非标安装）时，从 master 进程真实 exe 反推（…/bin/bws -> …）
  for p in $(ps -eo pid,args 2>/dev/null | grep '[B]WS: master' | grep -v "$SELF" | awk '{print $1}' | head -5); do
    e=$(readlink -f /proc/$p/exe 2>/dev/null)
    case "$e" in */bin/bws|*/sbin/bws) BWS=$(dirname "$(dirname "$e")"); break ;; esac
  done
fi
if [ -n "$BWS" ]; then
  printf '%s' "$BWS" | sec bws_home
  {
    for f in "$BWS"/license/version "$BWS"/VERSION "$BWS"/version "$BWS"/conf/VERSION; do
      [ -f "$f" ] && { echo "#VERFILE $f"; grep -iE 'version' "$f" 2>/dev/null | head -5; }
    done
    ls -1 "$BWS"/patch/V*.jar 2>/dev/null | sed 's#.*/V##; s#\.jar$##' | head -60
  } | sec bws_ver
  {
    for f in "$BWS"/conf/bws.conf "$BWS"/conf/vhost/*.conf; do
      [ -f "$f" ] || continue
      echo "# configuration file $f:"
      cat "$f" 2>/dev/null
    done
  } | cap | sec bws_conf
fi

# ---------------- tomcat（内核是 java，靠 catalina 识别）----------------
{
  for p in $(ps -eo pid,args 2>/dev/null | grep '[j]ava' | grep -v "$SELF" | awk '{print $1}'); do
    cl=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null)
    case "$cl" in *catalina*|*org.apache.catalina.startup.Bootstrap*) ;; *) continue ;; esac
    ch=$(echo "$cl" | sed -n 's/.*-Dcatalina\.home=\([^ ]*\).*/\1/p' | head -1)
    cb=$(echo "$cl" | sed -n 's/.*-Dcatalina\.base=\([^ ]*\).*/\1/p' | head -1)
    [ -n "$cb" ] || cb="$ch"
    # server.xml 是 Tomcat 端口的权威来源。未提权时 ss -lntp 看不到 pid（也就拿不到
    # 该进程的监听端口），所以从 conf 里解析 <Connector port="..."> 作为兜底。
    # 注意：AJP / HTTPS 等 Connector 都可能带 port 属性，全部收下；值非数字 / 包含
    # redirectPort 等噪声的，awk 的 !~ /\D/ 直接过滤掉。
    tcp=""
    if [ -n "$ch" ] && [ -f "$ch/conf/server.xml" ]; then
      tcp=$(sed -n 's/.*<Connector[^>]*port="\([0-9]\+\)".*/\1/p' "$ch/conf/server.xml" 2>/dev/null | awk '!/[^0-9]/ && $0>0 && $0<65536' | sort -un | paste -sd, -)
    fi
    echo "#TC pid=$p home=$ch base=$cb ports=$tcp"
    if [ -n "$ch" ] && [ -x "$ch/bin/version.sh" ]; then
      ( cd "$ch/bin" 2>/dev/null && ./version.sh 2>&1 | grep -i 'Server version' | head -1 )
    fi
    if [ -n "$ch" ] && [ -f "$ch/lib/catalina.jar" ]; then
      ( command -v unzip >/dev/null 2>&1 && unzip -p "$ch/lib/catalina.jar" META-INF/MANIFEST.MF 2>/dev/null | grep -i 'Implementation-Version' | head -1 )
    fi
    if [ -n "$ch" ] && [ -f "$ch/RELEASE-NOTES" ]; then
      grep -iE 'Apache Tomcat' "$ch/RELEASE-NOTES" 2>/dev/null | head -1
    fi
  done
} | cap | sec tomcat_info

# ---------------- ElasticSearch（2026-09-17 用户新增：版本/端口/安装目录/访问地址/账号/密码/备注）----------------
# 进程发现：主类 org.elasticsearch.bootstrap.Elasticsearch（5.x~8.x 一致）
ES_PIDS=
for p in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
  cl=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null)
  case "$cl" in
    *'org.elasticsearch.bootstrap'*|*'elasticsearch.EsMain'*)
      ES_PIDS="$ES_PIDS $p"
      ;;
  esac
done
{
  for p in $ES_PIDS; do
    e=$(readlink -f /proc/$p/exe 2>/dev/null)
    echo "$p|$e"
  done
} | sec es_exe
{
  for p in $ES_PIDS; do
    cl=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null)
    # ES home：7.x 是 -Des.path.home，8.x 改成 -Epath.home
    h=$(echo "$cl" | grep -oE '\-Des\.path\.home=[^ ]+|\-Epath\.home=[^ ]+|\-Dpath\.home=[^ ]+' | head -1 | cut -d= -f2)
    b=$(echo "$cl" | grep -oE '\-Des\.network\.host=[^ ]+|\-Enetwork\.host=[^ ]+' | head -1 | cut -d= -f2)
    hp=$(echo "$cl" | grep -oE '\-Des\.http\.port=[^ ]+|\-Ehttp\.port=[^ ]+' | head -1 | cut -d= -f2)
    echo "#HOME=$h"
    echo "#BIND=$b"
    echo "#HPORT=$hp"
  done
  # 找 elasticsearch.yml 落点（不读内容，单独 sec 读）
  for f in /usr/share/elasticsearch/config/elasticsearch.yml /opt/elasticsearch/config/elasticsearch.yml /data/elasticsearch/config/elasticsearch.yml /etc/elasticsearch/elasticsearch.yml /usr/local/elasticsearch/config/elasticsearch.yml /var/lib/elasticsearch/elasticsearch.yml; do
    [ -f "$f" ] && echo "#YML=$f"
  done
} | sec es_meta

# HTTP 探测：默认端口试一遍（-k 跳过 TLS）
{
  for pt in 9200 9201 9202 19200; do
    echo "#PROBE port=$pt"
    if command -v curl >/dev/null 2>&1; then
      timeout 4 curl -sS -m 3 -k "http://127.0.0.1:$pt/" 2>/dev/null | head -c 3000
    elif command -v wget >/dev/null 2>&1; then
      timeout 4 wget -qO- --timeout=3 --no-check-certificate "http://127.0.0.1:$pt/" 2>/dev/null | head -c 3000
    fi
    echo
  done
} | sec es_http

# 配置 / 安全相关文件：拼装启动参数里的 conf path（兼容 7/8）+ 默认落点
{
  CONF_PATH=
  if [ -n "$ES_PIDS" ]; then
    for p in $ES_PIDS; do
      cl=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null)
      cp=$(echo "$cl" | grep -oE '\-Des\.path\.conf=[^ ]+|\-Epath\.conf=[^ ]+' | head -1 | cut -d= -f2)
      [ -n "$cp" ] && CONF_PATH="$cp"
    done
  fi
  for f in \
    "$CONF_PATH/elasticsearch.yml" \
    /usr/share/elasticsearch/config/elasticsearch.yml \
    /opt/elasticsearch/config/elasticsearch.yml \
    /data/elasticsearch/config/elasticsearch.yml \
    /etc/elasticsearch/elasticsearch.yml \
    /usr/local/elasticsearch/config/elasticsearch.yml; do
    [ -f "$f" ] && { echo "#FILE $f"; grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$f" 2>/dev/null | head -60; }
  done
  # 安全相关（账号候选来源）
  for f in /etc/elasticsearch/users /etc/elasticsearch/users_roles /etc/elasticsearch/roles.yml /usr/share/elasticsearch/config/users /usr/share/elasticsearch/config/users_roles /usr/share/elasticsearch/config/roles.yml; do
    [ -f "$f" ] && { echo "#FILE $f"; head -40 "$f" 2>/dev/null; }
  done
} | cap | sec es_conf

# ---------------- 证书目录 ----------------
{
  for d in /opt/servers/nginx/ssl /data/nginx/ssl /usr/local/nginx/ssl /usr/local/nginx/conf/ssl /etc/nginx/ssl /data/BWS310/ssl /data/wwwlogs; do
    [ -d "$d" ] && { echo "#DIR $d"; ls -1 "$d" 2>/dev/null | head -30; }
  done
} | sec ssl_dirs

true`
}

// ---------------------------------------------------------------------------
// 远端执行
// ---------------------------------------------------------------------------

// mwCaptureRun 以「尽量 root」的身份执行探测脚本。
//
// 与 mwOpsRunPriv 的区别：探测脚本以 true 收尾、永远退出 0，
// 因此不能靠「直连失败再提权」来触发提权（直连永远不会失败）。
// 这里**先解析通道**再执行：复用与定时任务读取完全相同的 mwOpsEnsurePriv
// （sudo 实测，带进程内指纹缓存，与「定时任务面板读一次」共享同一通道，秒级复用）。
//
// 解析到的通道由 mwOpsPrivPrefix 转成执行语义：
//   - sudo：pre 为 sudo 提权前缀，编进脚本自提权；
//   - direct：SSH 用户即维护用户，pre 为空直接跑。
//
// 返回的 privileged 只是初判，mwCaptureAsset 会按探测脚本回填的 meta 段
// （uid=0）为准覆盖。
func mwCaptureRun(t *crontabTarget, script string) (string, bool) {
	runUser := strings.TrimSpace(t.RunUser)
	if runUser == "" || runUser == strings.TrimSpace(t.SSHUser) {
		// SSH 用户即维护用户：直接以该用户身份跑（无需提权）。
		out, err := t.runScript("", script, mwCaptureTimeout)
		if err != nil && strings.TrimSpace(out) == "" {
			return "", false
		}
		return out, false
	}

	// 非维护用户：先解析 sudo 通道，再按通道前缀执行（探测脚本以 true 收尾、
	// 恒退出 0，不能靠「直连失败再提权」触发，必须先定通道）。
	mwOpsEnsurePriv(t)
	pre := mwOpsPrivPrefix(t)
	out, err := t.runScript(pre, script, mwCaptureTimeout)
	if err != nil && strings.TrimSpace(out) == "" {
		return "", false
	}
	return out, t.plan.Kind == crontabChanSudo
}

// ---------------------------------------------------------------------------
// 段解析
// ---------------------------------------------------------------------------

// mwCaptureSections 把 `@@SEC:名字` + base64 行 解成 map
func mwCaptureSections(out string) map[string]string {
	secs := map[string]string{}
	lines := strings.Split(out, "\n")
	for i := 0; i < len(lines); i++ {
		line := strings.TrimRight(lines[i], "\r")
		if !strings.HasPrefix(line, "@@SEC:") {
			continue
		}
		name := strings.TrimSpace(strings.TrimPrefix(line, "@@SEC:"))
		if i+1 >= len(lines) {
			secs[name] = ""
			break
		}
		payload := strings.TrimSpace(strings.TrimRight(lines[i+1], "\r"))
		if payload == "" {
			secs[name] = ""
		} else if b, err := base64.StdEncoding.DecodeString(payload); err == nil {
			secs[name] = string(b)
		} else {
			secs[name] = payload
		}
		i++
	}
	return secs
}

// mwProc 一行进程
type mwProc struct {
	Pid  int
	User string
	Args string
}

func mwParseProcs(raw string) []mwProc {
	out := []mwProc{}
	for _, line := range strings.Split(raw, "\n") {
		fs := strings.Fields(line)
		if len(fs) < 3 {
			continue
		}
		pid, err := strconv.Atoi(fs[0])
		if err != nil {
			continue
		}
		if fs[0] == "PID" || fs[1] == "USER" {
			continue
		}
		out = append(out, mwProc{Pid: pid, User: fs[1], Args: strings.Join(fs[2:], " ")})
	}
	return out
}

var mwPidInSsRe = regexp.MustCompile(`pid=(\d+)`)

// mwPortsByPid 从 ss/netstat 输出里解析 PID -> 监听端口（需要 root 才有 pid= 信息）
func mwPortsByPid(ssOut string) map[int][]string {
	m := map[int][]string{}
	for _, line := range strings.Split(ssOut, "\n") {
		if !strings.Contains(line, "LISTEN") {
			continue
		}
		fs := strings.Fields(line)
		if len(fs) < 4 {
			continue
		}
		port := fs[3]
		if k := strings.LastIndex(port, ":"); k >= 0 {
			port = port[k+1:]
		}
		if _, err := strconv.Atoi(port); err != nil {
			continue
		}
		for _, mm := range mwPidInSsRe.FindAllStringSubmatch(line, -1) {
			pid, err := strconv.Atoi(mm[1])
			if err != nil {
				continue
			}
			if !mwContains(m[pid], port) {
				m[pid] = append(m[pid], port)
			}
		}
	}
	return m
}

func mwContains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// mwUniq 去重并保持首次出现顺序
func mwUniq(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

// mwLogDir 把日志路径收敛为「目录」：用户只关心日志落在哪个目录，不关心具体文件名。
//
// 规则：看起来像文件（末段带扩展名，如 access.log）就取父目录；看起来已是目录就原样保留。
// off / syslog / memory 等非法值直接丢弃。
func mwLogDir(p string) string {
	p = strings.TrimSpace(p)
	if p == "" || p == "off" || strings.HasPrefix(p, "syslog") || strings.HasPrefix(p, "memory") {
		return ""
	}
	p = strings.TrimRight(p, "/")
	if p == "" {
		return ""
	}
	base := p[strings.LastIndex(p, "/")+1:]
	if strings.Contains(base, ".") {
		return filepath.Dir(p)
	}
	return p
}

// mwLogDirs 批量收敛日志路径（去空 + 去重 + 仅保留目录）
func mwLogDirs(in []string) []string {
	out := []string{}
	for _, p := range in {
		if d := mwLogDir(p); d != "" && !mwContains(out, d) {
			out = append(out, d)
		}
	}
	return out
}

// mwSortPorts 端口按数值排序
func mwSortPorts(in []string) []string {
	out := mwUniq(in)
	sort.Slice(out, func(i, j int) bool {
		a, _ := strconv.Atoi(out[i])
		b, _ := strconv.Atoi(out[j])
		if a != b {
			return a < b
		}
		return out[i] < out[j]
	})
	return out
}

// ---------------------------------------------------------------------------
// 配置语句扫描（nginx / BWS310 同格式）
// ---------------------------------------------------------------------------

// mwConfStmt 配置里的一条语句或一个块边界
type mwConfStmt struct {
	Text  string // 语句正文 / 块头（如 "server"、"location /api/"）
	Open  bool   // 以 { 结束
	Close bool   // }
	Depth int
}

// mwScanConf 扫描配置正文，产出语句序列。
//
// 用一个小状态机逐字符处理：引号内的 {} ; # 不生效，
// 保证 `log_format json '{...}';` 这类内容不会打乱块结构。
func mwScanConf(body string) []mwConfStmt {
	var out []mwConfStmt
	var cur strings.Builder
	depth := 0
	var quote byte
	flush := func() {
		if t := strings.TrimSpace(cur.String()); t != "" {
			out = append(out, mwConfStmt{Text: t, Depth: depth})
		}
		cur.Reset()
	}
	for i := 0; i < len(body); i++ {
		ch := body[i]
		if quote != 0 {
			if ch == '\\' && quote == '"' && i+1 < len(body) {
				i++
				cur.WriteByte(' ')
				continue
			}
			if ch == quote {
				quote = 0
			}
			if ch == '\n' || ch == '\r' || ch == '\t' {
				cur.WriteByte(' ')
				continue
			}
			cur.WriteByte(ch)
			continue
		}
		switch ch {
		case '\'', '"':
			quote = ch
			cur.WriteByte(ch)
		case '#':
			for i < len(body) && body[i] != '\n' {
				i++
			}
		case '{':
			h := strings.TrimSpace(cur.String())
			out = append(out, mwConfStmt{Text: h, Open: true, Depth: depth})
			cur.Reset()
			depth++
		case '}':
			flush()
			depth--
			if depth < 0 {
				depth = 0
			}
			out = append(out, mwConfStmt{Close: true, Depth: depth})
		case ';':
			flush()
		case '\n', '\r', '\t':
			cur.WriteByte(' ')
		default:
			cur.WriteByte(ch)
		}
	}
	flush()
	return out
}

// mwWebBlock 一个 server 块的可提取信息
type mwWebBlock struct {
	File      string
	Listen    []string
	Roots     []string
	Certs     []string
	AccessLog []string
	ErrorLog  []string
}

// mwConfSeg 一份配置文件（来自 `# configuration file X:` 头）
type mwConfSeg struct {
	Path string
	Body string
}

func mwSplitConfDump(dump string) []mwConfSeg {
	segs := []mwConfSeg{}
	var cur string
	var buf strings.Builder
	flush := func() {
		if cur != "" {
			segs = append(segs, mwConfSeg{Path: cur, Body: buf.String()})
		}
		buf.Reset()
	}
	for _, ln := range strings.Split(dump, "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "# configuration file ") && strings.HasSuffix(t, ":") {
			flush()
			cur = strings.TrimSuffix(strings.TrimPrefix(t, "# configuration file "), ":")
			continue
		}
		if cur != "" {
			buf.WriteString(ln)
			buf.WriteByte('\n')
		}
	}
	flush()
	return segs
}

func mwFirstWord(s string) string {
	fs := strings.Fields(s)
	if len(fs) == 0 {
		return ""
	}
	return fs[0]
}

// mwDirectiveArg 取指令的第一个参数（去掉可能的注释残留）
func mwDirectiveArg(s string) string {
	fs := strings.Fields(s)
	if len(fs) < 2 {
		return ""
	}
	return strings.Trim(fs[1], `"'`)
}

// mwListenPort 从 listen 指令参数里取端口
func mwListenPort(arg string) string {
	fs := strings.Fields(arg)
	if len(fs) == 0 {
		return ""
	}
	v := fs[0]
	if k := strings.LastIndex(v, ":"); k >= 0 {
		v = v[k+1:]
	}
	v = strings.Trim(v, "[]")
	if _, err := strconv.Atoi(v); err != nil {
		return ""
	}
	return v
}

var mwPortRe = regexp.MustCompile(`^[0-9]{2,5}$`)

// mwParseWebConf 解析 nginx / BWS310 的配置 dump，
// 返回站点配置文件清单、server 块清单、http 级日志路径。
//
// 配置文件清单只保留「含 server 块的文件 + 主配置文件（含 http 块）」，
// 滤掉 `nginx -T` 里被 include 进来的 mime.types / fastcgi.conf 这类辅助文件
// （它们不是站点配置，列出来只会干扰判断）。
func mwParseWebConf(dump string) ([]string, []mwWebBlock, []string) {
	mainFiles := []string{}
	siteFiles := []string{}
	blocks := []mwWebBlock{}
	globalLogs := []string{}
	addGlobalLog := func(p string) {
		if p != "" && p != "off" && !mwContains(globalLogs, p) {
			globalLogs = append(globalLogs, p)
		}
	}
	for _, seg := range mwSplitConfDump(dump) {
		hasServer := false
		isMain := false
		var cur *mwWebBlock
		serverDepth := 0
		for _, st := range mwScanConf(seg.Body) {
			if st.Close {
				if cur != nil && st.Depth < serverDepth {
					blocks = append(blocks, *cur)
					cur = nil
					serverDepth = 0
				}
				continue
			}
			if st.Open {
				switch mwFirstWord(st.Text) {
				case "server":
					hasServer = true
					if cur == nil {
						cur = &mwWebBlock{File: seg.Path}
						serverDepth = st.Depth + 1
					}
				case "http":
					isMain = true
				}
				continue
			}
			kw := mwFirstWord(st.Text)
			arg := mwDirectiveArg(st.Text)
			switch kw {
			case "listen":
				if cur != nil {
					if p := mwListenPort(arg); p != "" && !mwContains(cur.Listen, p) {
						cur.Listen = append(cur.Listen, p)
					}
				}
			case "root", "alias", "documentRoot":
				// `/` 这种退化值不是业务代码目录，列出来只是噪声
				if cur != nil && arg != "" && arg != "/" {
					cur.Roots = append(cur.Roots, arg)
				}
			case "ssl_certificate", "sslCertificate":
				if cur != nil && arg != "" {
					cur.Certs = append(cur.Certs, arg)
				}
			case "access_log", "accessLog":
				if arg == "" || arg == "off" {
					break
				}
				if cur != nil {
					cur.AccessLog = append(cur.AccessLog, arg)
				} else {
					addGlobalLog(arg)
				}
			case "error_log", "errorLog":
				if arg == "" {
					break
				}
				if cur != nil {
					cur.ErrorLog = append(cur.ErrorLog, arg)
				} else {
					addGlobalLog(arg)
				}
			}
		}
		if cur != nil {
			blocks = append(blocks, *cur)
		}
		if hasServer {
			siteFiles = append(siteFiles, seg.Path)
		} else if isMain {
			mainFiles = append(mainFiles, seg.Path)
		}
	}
	files := []string{}
	for _, f := range mainFiles {
		if !mwContains(files, f) {
			files = append(files, f)
		}
	}
	for _, f := range siteFiles {
		if !mwContains(files, f) {
			files = append(files, f)
		}
	}
	return files, mwUniqWebBlocks(blocks), globalLogs
}

// mwUniqWebBlocks 去掉完全相同的 server 块
// （回退模式（nginx -T 不可用）下同一份配置文件可能被拼装两次，会产出重复块）
func mwUniqWebBlocks(in []mwWebBlock) []mwWebBlock {
	out := []mwWebBlock{}
	seen := map[string]bool{}
	for _, b := range in {
		k := b.File + "|" + strings.Join(b.Listen, ",") + "|" +
			strings.Join(b.Roots, ",") + "|" + strings.Join(b.Certs, ",")
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, b)
	}
	return out
}

// mwUniqCodePaths 去掉重复的「端口→代码路径」配对，并丢掉空路径
func mwUniqCodePaths(in []MwCodePath) []MwCodePath {
	out := []MwCodePath{}
	seen := map[string]bool{}
	for _, c := range in {
		if strings.TrimSpace(c.Path) == "" {
			continue
		}
		k := c.Port + "|" + c.Path
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, c)
	}
	return out
}

// ---------------------------------------------------------------------------
// 各中间件的条目构造
// ---------------------------------------------------------------------------

func mwProcMatch(procs []mwProc, subs ...string) []mwProc {
	out := []mwProc{}
	for _, p := range procs {
		for _, s := range subs {
			if strings.Contains(p.Args, s) {
				out = append(out, p)
				break
			}
		}
	}
	return out
}

var mwNginxVerRe = regexp.MustCompile(`nginx version:\s*nginx/(\S+)`)
var mwPrefixRe = regexp.MustCompile(`--prefix=(\S+)`)
var mwPhpVerRe = regexp.MustCompile(`PHP\s+(\S+)`)
var mwJavaVerRe = regexp.MustCompile(`version\s+"([^"]+)"`)
var mwRedisVerRe = regexp.MustCompile(`v=([0-9][0-9.]*)`)
var mwJarArgRe = regexp.MustCompile(`(?:^|\s)-jar\s+(\S+)`)
var mwCatalinaBaseRe = regexp.MustCompile(`-Dcatalina\.base=(\S+)`)
var mwServerPortRe = regexp.MustCompile(`(?:--server\.port=|--port=|--httpPort=|-Dserver\.port=)(\d{2,5})`)
var mwVerNumRe = regexp.MustCompile(`[0-9]+(?:\.[0-9]+){2,}`)
var mwTomcatVerRe = regexp.MustCompile(`(?:Apache Tomcat/|Implementation-Version:\s*)([0-9]+(?:\.[0-9]+){1,3})`)

// mwPrefixOf 由二进制路径反推安装目录（…/sbin/nginx -> …）
func mwPrefixOf(bin string) string {
	if strings.TrimSpace(bin) == "" {
		return ""
	}
	d := strings.TrimSuffix(bin, "/")
	if k := strings.LastIndex(d, "/"); k > 0 {
		d = d[:k]
	}
	switch {
	case strings.HasSuffix(d, "/sbin"), strings.HasSuffix(d, "/bin"),
		strings.HasSuffix(d, "/src"), strings.HasSuffix(d, "/usr/sbin"):
		if k := strings.LastIndex(d, "/"); k > 0 {
			return d[:k]
		}
	}
	return d
}

// mwNginxItem 构造 nginx 条目
func mwNginxItem(secs map[string]string, procs []mwProc, portsByPid map[int][]string, privileged bool) *MwCaptureItem {
	bin := strings.TrimSpace(secs["nginx_bin"])
	masters := mwProcMatch(procs, "nginx: master process")
	if bin == "" && len(masters) == 0 {
		return nil
	}
	it := &MwCaptureItem{Type: "nginx", Label: "Nginx", Running: len(masters) > 0}
	info := secs["nginx_info"]
	if m := mwNginxVerRe.FindStringSubmatch(info); len(m) > 1 {
		it.Version = m[1]
	}
	prefix := ""
	if m := mwPrefixRe.FindStringSubmatch(info); len(m) > 1 {
		prefix = m[1]
	}
	if prefix == "" {
		prefix = mwPrefixOf(bin)
	}
	it.InstallPath = prefix

	files, blocks, globalLogs := mwParseWebConf(secs["nginx_conf"])
	it.ConfigPaths = files
	ports := []string{}
	codePaths := []MwCodePath{}
	certs := []string{}
	logs := append([]string{}, globalLogs...)
	for _, b := range blocks {
		for _, p := range b.Listen {
			if !mwContains(ports, p) {
				ports = append(ports, p)
			}
		}
		if len(b.Roots) > 0 {
			// 同一 server 块里的多个 root/alias（多个 location 指向不同目录）用「、」连接：
			// 用「 / 」会与路径自身的斜杠混在一起，读起来像夹了空目录
			codePaths = append(codePaths, MwCodePath{
				Port: strings.Join(b.Listen, ","),
				Path: strings.Join(mwUniq(b.Roots), "、"),
			})
		}
		certs = append(certs, b.Certs...)
		logs = append(logs, b.AccessLog...)
		logs = append(logs, b.ErrorLog...)
	}
	// 配置里没写 listen（少见）时，用 master 进程的监听端口兜底
	if len(ports) == 0 {
		for _, m := range masters {
			ports = append(ports, portsByPid[m.Pid]...)
		}
	}
	it.Ports = mwSortPorts(ports)
	it.CodePaths = mwUniqCodePaths(codePaths)
	it.Certs = mwUniq(certs)
	it.LogPaths = mwLogDirs(logs)
	if len(blocks) > 1 {
		it.Notes = append(it.Notes, fmt.Sprintf("共 %d 个 server 块，已按端口与代码路径配对展示", len(blocks)))
	}
	if secs["nginx_conf_mode"] == "fb" {
		it.Notes = append(it.Notes, "nginx -T 不可用（多为未提权 / 配置不可读），已按主配置 + vhost 目录拼装，结果可能不含自定义 include 的文件")
	}
	if len(it.ConfigPaths) == 0 && !privileged {
		it.Notes = append(it.Notes, "未取得 root 权限，未能读取配置文件（请确认资产里的「超级管理员用户密码」或为 SSH 用户配置免密 sudo）")
	}
	if len(it.Certs) == 0 {
		if cs := mwCertsFromDirs(secs["ssl_dirs"], prefix, "ssl"); len(cs) > 0 {
			it.Certs = cs
			it.Notes = append(it.Notes, "配置中未启用 SSL，但 SSL 目录存在证书文件（未启用）")
		}
	}
	return it
}

// mwBwsStdHomes 宝兰德 BWS310 的标准安装位置（离线包约定，唯一正确落点）
var mwBwsStdHomes = []string{"/data/BWS310"}

// mwBwsItem 构造宝兰德 BWS310 条目（配置格式与 nginx 一致）。
//
// 安装位置固定为 /data/BWS310（离线包 install_bws_310_v1.1.sh 的约定），
// 配置只来自 conf/bws.conf 与 conf/vhost/*.conf；版本优先 license/version 的
// PatchVersion（如 BWS3.1.0.1106.017），其次已打补丁 jar 的最大版本号。
func mwBwsItem(secs map[string]string, procs []mwProc, portsByPid map[int][]string, privileged bool) *MwCaptureItem {
	home := strings.TrimSpace(secs["bws_home"])
	masters := mwProcMatch(procs, "BWS: master process")
	if home == "" && len(masters) == 0 {
		return nil
	}
	it := &MwCaptureItem{Type: "bws310", Label: "宝兰德 BWS310", Running: len(masters) > 0}
	it.InstallPath = home
	if home != "" && !mwContains(mwBwsStdHomes, home) {
		it.Notes = append(it.Notes, "安装位置非标准（约定为 /data/BWS310），已按进程实际路径反推")
	}
	it.Version = mwBwsVersion(secs["bws_ver"])

	files, blocks, globalLogs := mwParseWebConf(secs["bws_conf"])
	it.ConfigPaths = files
	ports := []string{}
	codePaths := []MwCodePath{}
	certs := []string{}
	logs := append([]string{}, globalLogs...)
	for _, b := range blocks {
		for _, p := range b.Listen {
			if !mwContains(ports, p) {
				ports = append(ports, p)
			}
		}
		if len(b.Roots) > 0 {
			// 同一 server 块里的多个 root/alias（多个 location 指向不同目录）用「、」连接：
			// 用「 / 」会与路径自身的斜杠混在一起，读起来像夹了空目录
			codePaths = append(codePaths, MwCodePath{
				Port: strings.Join(b.Listen, ","),
				Path: strings.Join(mwUniq(b.Roots), "、"),
			})
		}
		certs = append(certs, b.Certs...)
		logs = append(logs, b.AccessLog...)
		logs = append(logs, b.ErrorLog...)
	}
	if len(ports) == 0 {
		for _, m := range masters {
			ports = append(ports, portsByPid[m.Pid]...)
		}
	}
	it.Ports = mwSortPorts(ports)
	it.CodePaths = mwUniqCodePaths(codePaths)
	it.Certs = mwUniq(certs)
	it.LogPaths = mwLogDirs(logs)
	if len(it.Certs) == 0 {
		// /data/BWS310/conf/security/*.crt 是 BWS 自带的安全文件，不是站点证书，
		// 所以只认 BWS 专属的 ssl 下发目录（平台部署时 CRT/KEY 就放在这里）
		if cs := mwCertsFromDirs(secs["ssl_dirs"], home, "ssl"); len(cs) > 0 {
			it.Certs = cs
			it.Notes = append(it.Notes, "配置中未启用 SSL，但 ssl 目录存在证书文件（未启用）")
		}
	}
	if len(it.ConfigPaths) == 0 && !privileged {
		it.Notes = append(it.Notes, "未取得 root 权限，未能读取配置文件")
	}
	return it
}

// mwCertsFromDirs 从 ssl_dirs 段里取某个目录下的证书文件
func mwCertsFromDirs(sslDirs, prefix, sub string) []string {
	if strings.TrimSpace(sslDirs) == "" || strings.TrimSpace(prefix) == "" {
		return nil
	}
	want := strings.TrimSuffix(prefix, "/") + "/" + strings.Trim(sub, "/")
	out := []string{}
	in := false
	for _, ln := range strings.Split(sslDirs, "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "#DIR ") {
			in = strings.TrimSpace(strings.TrimPrefix(t, "#DIR ")) == want
			continue
		}
		if !in || t == "" {
			continue
		}
		if strings.HasSuffix(t, ".crt") || strings.HasSuffix(t, ".pem") || strings.HasSuffix(t, ".cer") {
			out = append(out, want+"/"+t)
		}
	}
	return out
}

// mwBwsVersion 从版本文件 / 补丁包 / 配置里取 BWS 版本号（补丁号取最大值）
func mwBwsVersion(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	best := ""
	bestParts := []int{}
	better := func(cand string) {
		cand = strings.TrimSpace(cand)
		if cand == "" {
			return
		}
		parts := []int{}
		for _, seg := range strings.Split(cand, ".") {
			n, err := strconv.Atoi(strings.TrimSpace(seg))
			if err != nil {
				return
			}
			parts = append(parts, n)
		}
		if len(parts) == 0 {
			return
		}
		for i := 0; i < len(parts) && i < len(bestParts); i++ {
			if parts[i] != bestParts[i] {
				if parts[i] > bestParts[i] {
					best, bestParts = cand, parts
				}
				return
			}
		}
		if len(parts) > len(bestParts) {
			best, bestParts = cand, parts
		}
	}
	for _, ln := range strings.Split(raw, "\n") {
		t := strings.TrimSpace(ln)
		if t == "" || strings.HasPrefix(t, "#VERFILE") {
			continue
		}
		if m := mwVerNumRe.FindString(t); m != "" {
			better(m)
		}
	}
	return best
}

// mwEsProbe 单个 ES HTTP 探针端口的探测结果（私）。
//
// 与 mwCaptureScript() 的 es_http 段配对：每段按 `#PROBE port=xxx` 切成多份，
// 该行之后直到下一个 #PROBE 或段尾都是该端口的 curl 输出（空字符串 = 没有 curl
// 或端口拒绝连接）。
type mwEsProbe struct {
	Port string
	Raw  string
}

// mwEsParseProbes 把 es_http 段按 `#PROBE port=xxx` 切成多份。
func mwEsParseProbes(raw string) []mwEsProbe {
	out := []mwEsProbe{}
	var cur *mwEsProbe
	for _, ln := range strings.Split(raw, "\n") {
		trim := strings.TrimSpace(strings.TrimRight(ln, "\r"))
		if strings.HasPrefix(trim, "#PROBE port=") {
			if cur != nil {
				cur.Raw = strings.TrimSpace(cur.Raw)
				out = append(out, *cur)
			}
			cur = &mwEsProbe{Port: strings.TrimSpace(strings.TrimPrefix(trim, "#PROBE port="))}
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

// mwEsPickUser 从 es_conf 段里挑一个用户名作为占位（仅当存在 users 文件时）。
//
// Elasticsearch 5.x~8.x 的内置用户文件是 /etc/elasticsearch/users 或
// $ES_HOME/config/users，行格式为「用户名:$2y$...」（bcrypt hash 在冒号后面）。
// 这里只取冒号前的用户名（hash 不读），多数情况下仍由用户手填密码。
func mwEsPickUser(raw string) string {
	inUsers := false
	for _, ln := range strings.Split(raw, "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "#FILE") {
			fp := strings.TrimSpace(strings.TrimPrefix(t, "#FILE"))
			// 形如 /etc/elasticsearch/users 才计入（users_roles / roles.yml 不算）
			inUsers = !strings.Contains(fp, "_roles") && strings.HasSuffix(fp, "/users")
			continue
		}
		if !inUsers || t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		// users 文件行：「用户名:$2y$10$...」（hash 段含 : 和 $，用 strings.Fields 会把整行当一列）
		name := strings.SplitN(t, ":", 2)[0]
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		return name
	}
	return ""
}

// mwEsItem 构造 Elasticsearch 条目（2026-09-17 用户新增）。
//
// 字段：版本 / 端口 / 安装目录 / 访问地址 / 账号 / 密码 / 备注。
//
// 探测思路：
//   - 进程：cmdline 含 "org.elasticsearch.bootstrap" 或 "elasticsearch.EsMain"
//     （兼容 5.x~8.x；ES 旧版 2.x/1.x 用 elasticsearch.EsMain）
//   - 版本：HTTP GET / 拿 JSON 的 version.number；curl 不到时跑不出，先留空
//   - 安装目录：cmdline 里 -Des.path.home= / -Epath.home= 优先；退回
//     JVM argv[0] 向上 3 级（…/jdk/bin/java → ES_HOME）；再退回标准落点
//   - 访问地址：http://<bind>:<port>；bind 从 cmdline -Des.network.host 推断
//     （_local_/空/127.0.0.1 → 127.0.0.1；具体 IP → 用它；0.0.0.0 → 127.0.0.1 让用户改）
//   - 账号：仅在读到 users 文件时填一个用户名（多数情况下用户需手填）
//   - 跑不出的字段全部留空，前端编辑模式让用户补
func mwEsItem(secs map[string]string, procs []mwProc, portsByPid map[int][]string, privileged bool) *MwCaptureItem {
	// 1) ES 进程：cmdline 含 ES 主类
	esPids := map[int]bool{}
	for _, p := range procs {
		cl := p.Args
		if strings.Contains(cl, "org.elasticsearch.bootstrap") || strings.Contains(cl, "elasticsearch.EsMain") {
			esPids[p.Pid] = true
		}
	}
	// 2) es_meta 段：HOME / BIND / HPORT（启动命令行静态参数）
	var (
		installFromCli string
		bindIP         string
		portsFromCli   []string
	)
	for _, ln := range strings.Split(secs["es_meta"], "\n") {
		t := strings.TrimSpace(ln)
		switch {
		case strings.HasPrefix(t, "#HOME="):
			installFromCli = strings.TrimSpace(strings.TrimPrefix(t, "#HOME="))
		case strings.HasPrefix(t, "#BIND="):
			bindIP = strings.TrimSpace(strings.TrimPrefix(t, "#BIND="))
		case strings.HasPrefix(t, "#HPORT="):
			if p := strings.TrimSpace(strings.TrimPrefix(t, "#HPORT=")); p != "" {
				portsFromCli = append(portsFromCli, p)
			}
		}
	}

	// 3) HTTP 探测 → 版本 / 端口
	probes := mwEsParseProbes(secs["es_http"])
	var version string
	ports := append([]string{}, portsFromCli...)
	for i := range probes {
		pr := &probes[i]
		body := strings.TrimSpace(pr.Raw)
		if body == "" || !strings.HasPrefix(body, "{") {
			continue
		}
		var root struct {
			Name        string `json:"name"`
			ClusterName string `json:"cluster_name"`
			Version     struct {
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
	ports = mwSortPorts(ports)

	// 4) 安装目录：先 cmdline 提取；退回 JVM argv[0] 上推三级；最后标准落点
	installPath := installFromCli
	if installPath == "" {
		for _, p := range procs {
			if !esPids[p.Pid] {
				continue
			}
			fs := strings.Fields(p.Args)
			if len(fs) == 0 {
				continue
			}
			jvmPath := fs[0]
			parts := strings.Split(jvmPath, "/")
			// ES 7+ 自带 jdk：…/jdk/bin/java
			if len(parts) >= 4 && parts[len(parts)-2] == "bin" && parts[len(parts)-3] == "jdk" {
				installPath = strings.Join(parts[:len(parts)-3], "/")
				break
			}
			// ES 5/6 自带 jre：…/jre/bin/java
			if len(parts) >= 4 && parts[len(parts)-2] == "bin" && parts[len(parts)-3] == "jre" {
				installPath = strings.Join(parts[:len(parts)-3], "/")
				break
			}
		}
	}
	if installPath == "" {
		for _, cand := range []string{
			"/usr/share/elasticsearch",
			"/opt/elasticsearch",
			"/data/elasticsearch",
			"/etc/elasticsearch",
			"/usr/local/elasticsearch",
		} {
			if _, err := os.Stat(cand); err == nil {
				installPath = cand
				break
			}
		}
	}

	// 5) 访问地址：http://<bind>:<port>
	accessHost := "127.0.0.1"
	switch bindIP {
	case "", "127.0.0.1", "localhost", "_local_":
		accessHost = "127.0.0.1"
	case "0.0.0.0":
		// 0.0.0.0 → bind 全网卡；给本机 IP（用户后续可改成对外 IP）
		accessHost = "127.0.0.1"
	default:
		accessHost = bindIP
	}
	var accessUrl string
	if len(ports) > 0 {
		accessUrl = fmt.Sprintf("http://%s:%s", accessHost, ports[0])
	}

	// 什么也没扫到 → 不出条目
	if len(esPids) == 0 && version == "" && installPath == "" && len(ports) == 0 {
		return nil
	}
	it := &MwCaptureItem{
		Type:        "es",
		Label:       "ElasticSearch",
		Running:     len(esPids) > 0,
		Version:     version,
		Ports:       ports,
		InstallPath: installPath,
		AccessUrl:   accessUrl,
	}
	it.Username = mwEsPickUser(secs["es_conf"])

	// 备注：尽量给用户一个"接下来改什么"的明确指引，而不是让一整行留空
	switch {
	case len(esPids) == 0 && (version != "" || accessUrl != ""):
		it.Notes = append(it.Notes, "未探测到 ES Java 进程，但 HTTP 端口可连通（可能正在重启或非标启动）")
	case !privileged && installPath == "":
		it.Notes = append(it.Notes, "未取得 root 权限，未读取到 ES 安装目录；如需该字段请手工填写")
	}
	if it.Version == "" && len(ports) > 0 {
		it.Notes = append(it.Notes, "未能解析 ES 版本（可能开启了 xpack security，请配置账号密码后用 curl 测试）")
	}
	return it
}

// mwTomcatItem 构造 Tomcat 条目。
//
// Tomcat 本质是 java 进程，靠 cmdline 里的 catalina 关键字识别；
// 安装位置取 -Dcatalina.home，代码路径取 -Dcatalina.base/webapps（base 缺省用 home）。
// 一台机器上可能跑多个 Tomcat 实例（不同 catalina.home），按 home 各出一条。
// 版本优先 version.sh 的『Server version: Apache Tomcat/X』，其次 catalina.jar 的 Implementation-Version。
func mwTomcatItem(secs map[string]string, procs []mwProc, portsByPid map[int][]string) []*MwCaptureItem {
	raw := strings.TrimSpace(secs["tomcat_info"])
	if raw == "" {
		return nil
	}
	type tcInst struct {
		pid      int
		home     string
		base     string
		ver      string
		confPort string // server.xml 里解析到的 Connector port，未提权时的兜底
	}
	insts := map[string]*tcInst{}
	order := []string{}
	var cur *tcInst
	for _, ln := range strings.Split(raw, "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "#TC ") {
			f := strings.Fields(strings.TrimPrefix(t, "#TC "))
			inst := &tcInst{}
			for _, kv := range f {
				switch {
				case strings.HasPrefix(kv, "pid="):
					inst.pid, _ = strconv.Atoi(strings.TrimPrefix(kv, "pid="))
				case strings.HasPrefix(kv, "home="):
					inst.home = strings.TrimPrefix(kv, "home=")
				case strings.HasPrefix(kv, "base="):
					inst.base = strings.TrimPrefix(kv, "base=")
				case strings.HasPrefix(kv, "ports="):
					inst.confPort = strings.TrimPrefix(kv, "ports=")
				}
			}
			if inst.home == "" {
				cur = nil
				continue
			}
			if _, ok := insts[inst.home]; !ok {
				insts[inst.home] = inst
				order = append(order, inst.home)
			}
			cur = insts[inst.home]
			continue
		}
		if cur == nil {
			continue
		}
		if m := mwTomcatVerRe.FindStringSubmatch(t); len(m) > 1 && cur.ver == "" {
			cur.ver = m[1]
		}
	}
	out := []*MwCaptureItem{}
	for _, home := range order {
		inst := insts[home]
		it := &MwCaptureItem{Type: "tomcat", Label: "Tomcat", Running: inst.pid > 0}
		it.Version = inst.ver
		it.InstallPath = inst.home
		// 端口：进程视角（ss -lntp 给的）优先；未提权时退回 server.xml 里解析的 Connector port。
		ports := mwSortPorts(portsByPid[inst.pid])
		if len(ports) == 0 && inst.confPort != "" {
			ports = mwSortPorts(strings.Split(inst.confPort, ","))
			if len(ports) > 0 {
				it.Notes = append(it.Notes, "端口来自 server.xml 的 Connector（未提权时 ss 看不到该进程）")
			}
		}
		it.Ports = ports
		base := inst.base
		if base == "" {
			base = inst.home
		}
		it.CodePaths = []MwCodePath{{Port: "", Path: strings.TrimRight(base, "/") + "/webapps"}}
		out = append(out, it)
	}
	return out
}

// mwPhpItem 构造 PHP-FPM 条目
func mwPhpItem(secs map[string]string, procs []mwProc, privileged bool) *MwCaptureItem {
	bin := strings.TrimSpace(secs["php_bin"])
	masters := mwProcMatch(procs, "php-fpm")
	if bin == "" && len(masters) == 0 {
		return nil
	}
	it := &MwCaptureItem{Type: "php", Label: "PHP-FPM", Running: len(masters) > 0}
	if m := mwPhpVerRe.FindStringSubmatch(secs["php_info"]); len(m) > 1 {
		it.Version = m[1]
	}
	it.InstallPath = mwPrefixOf(bin)
	// 配置候选：脚本探到的 + master 进程 cmdline 括号里的路径
	confs := []string{}
	for _, ln := range strings.Split(secs["php_conf"], "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "#FILE ") {
			confs = append(confs, strings.TrimSpace(strings.TrimPrefix(t, "#FILE ")))
		}
	}
	for _, m := range masters {
		if k := strings.Index(m.Args, "master process ("); k >= 0 {
			if e := strings.Index(m.Args[k:], ")"); e > 0 {
				p := m.Args[k+len("master process (") : k+e]
				if strings.HasPrefix(p, "/") {
					confs = append(confs, p)
				}
			}
		}
	}
	it.ConfigPaths = mwUniq(confs)
	if len(it.ConfigPaths) == 0 && !privileged {
		it.Notes = append(it.Notes, "未取得 root 权限，未能读取配置文件")
	}
	return it
}

// mwJavaItem 构造 Java 应用条目（可能多个 jar / 多个应用）
func mwJavaItem(secs map[string]string, procs []mwProc, portsByPid map[int][]string) *MwCaptureItem {
	// 只认 exe 指向 java 的进程，避免把 grep/脚本自身算进来
	jvmByPid := map[int]string{}
	for _, ln := range strings.Split(secs["java_exe"], "\n") {
		parts := strings.SplitN(strings.TrimSpace(ln), "|", 2)
		if len(parts) != 2 {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(parts[0]))
		if err != nil {
			continue
		}
		exe := strings.TrimSpace(parts[1])
		if base := exe[strings.LastIndex(exe, "/")+1:]; base != "java" {
			continue
		}
		jvmByPid[pid] = exe
	}
	// JVM 版本：按可执行文件归集
	verByExe := map[string]string{}
	curExe := ""
	for _, ln := range strings.Split(secs["java_ver"], "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "#JVM ") {
			curExe = strings.TrimSpace(strings.TrimPrefix(t, "#JVM "))
			continue
		}
		if curExe == "" || t == "" {
			continue
		}
		if m := mwJavaVerRe.FindStringSubmatch(t); len(m) > 1 && verByExe[curExe] == "" {
			verByExe[curExe] = m[1]
		}
	}
	if len(jvmByPid) == 0 {
		return nil
	}
	byPid := map[int]mwProc{}
	for _, p := range procs {
		byPid[p.Pid] = p
	}
	pids := make([]int, 0, len(jvmByPid))
	for pid := range jvmByPid {
		pids = append(pids, pid)
	}
	sort.Ints(pids)

	it := &MwCaptureItem{Type: "java", Label: "Java", Running: true}
	apps := []MwJavaApp{}
	for _, pid := range pids {
		p, ok := byPid[pid]
		if !ok {
			continue
		}
		app := MwJavaApp{Pid: pid, Command: p.Args, Version: verByExe[jvmByPid[pid]]}
		jar := ""
		if m := mwJarArgRe.FindStringSubmatch(p.Args); len(m) > 1 {
			jar = strings.Trim(m[1], `"'`)
		}
		if jar != "" {
			app.Jar = jar
			// 路径里若没有 '/'（如裸文件名 "xxx.jar"），Name 取整个文件名、CodePath 留空，
			// 避免 jar[:strings.LastIndex(jar, "/")] 在 LastIndex 返回 -1 时 slice 越界 panic
			if idx := strings.LastIndex(jar, "/"); idx >= 0 {
				app.Name = jar[idx+1:]
				app.CodePath = jar[:idx]
			} else {
				app.Name = jar
			}
		} else if m := mwCatalinaBaseRe.FindStringSubmatch(p.Args); len(m) > 1 {
			app.CodePath = m[1]
			app.Name = "Tomcat（Bootstrap 启动）"
		} else {
			app.Name = "Java 应用（未使用 -jar 启动）"
		}
		ports := mwSortPorts(portsByPid[pid])
		if len(ports) == 0 {
			// 无 pid↔端口映射时（未提权）退回启动参数里的端口声明
			for _, m := range mwServerPortRe.FindAllStringSubmatch(p.Args, -1) {
				if len(m) > 1 {
					ports = append(ports, m[1])
				}
			}
			ports = mwSortPorts(ports)
		}
		app.Port = strings.Join(ports, ",")
		apps = append(apps, app)
	}
	if len(apps) == 0 {
		return nil
	}
	it.Jars = apps
	if len(apps) > 1 {
		it.Notes = append(it.Notes, fmt.Sprintf("该机器共有 %d 个 Java 应用，已逐个列出启动命令与端口", len(apps)))
	}
	verSet := []string{}
	for _, a := range apps {
		if a.Version != "" {
			verSet = append(verSet, a.Version)
		}
	}
	it.Version = strings.Join(mwUniq(verSet), " / ")
	return it
}

// mwRedisInst 一个 Redis 实例的落点信息。
// 一台机器上常有多个实例（实测：平台装的 17000 + 存量的 6379 同时在跑），
// 因此先按端口把信息分实例归集，最后再合并输出，避免两套配置互相覆盖。
type mwRedisInst struct {
	Port    string
	Exe     string
	Config  string
	Dir     string
	Logfile string
	Rdb     string
	Aof     string
}

// mwRedisItem 构造 Redis 条目
func mwRedisItem(secs map[string]string, procs []mwProc, portsByPid map[int][]string, privileged bool) *MwCaptureItem {
	rsProcs := mwProcMatch(procs, "redis-server")
	if len(rsProcs) == 0 && strings.TrimSpace(secs["redis_info"]) == "" && strings.TrimSpace(secs["redis_conf"]) == "" {
		return nil
	}
	it := &MwCaptureItem{Type: "redis", Label: "Redis", Running: len(rsProcs) > 0}

	// ---- 版本：redis-server -v 的 v= 优先，其次运行时 INFO ----
	for _, ln := range strings.Split(secs["redis_info"], "\n") {
		if m := mwRedisVerRe.FindStringSubmatch(ln); len(m) > 1 {
			if it.Version == "" {
				it.Version = m[1]
			}
			break
		}
	}
	if it.Version == "" {
		for _, ln := range strings.Split(secs["redis_cli"], "\n") {
			if strings.HasPrefix(strings.TrimSpace(ln), "redis_version:") {
				it.Version = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(ln), "redis_version:"))
				break
			}
		}
	}

	// ---- 进程可执行文件（pid -> exe），用于反推安装位置 ----
	exeByPid := map[int]string{}
	for _, ln := range strings.Split(secs["redis_exe"], "\n") {
		parts := strings.SplitN(strings.TrimSpace(ln), "|", 2)
		if len(parts) != 2 {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(parts[0]))
		if err != nil {
			continue
		}
		exeByPid[pid] = strings.TrimSpace(parts[1])
	}

	// ---- 解析各候选 redis.conf 为 路径 -> 键值 ----
	confKeys := map[string]map[string]string{}
	confOrder := []string{}
	for _, ln := range strings.Split(secs["redis_conf"], "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "#FILE ") {
			p := strings.TrimSpace(strings.TrimPrefix(t, "#FILE "))
			if _, ok := confKeys[p]; !ok {
				confKeys[p] = map[string]string{}
				confOrder = append(confOrder, p)
			}
			continue
		}
		if len(confOrder) == 0 {
			continue
		}
		k, v, ok := strings.Cut(t, " ")
		if !ok {
			continue
		}
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		if v == "" {
			continue
		}
		confKeys[confOrder[len(confOrder)-1]][strings.ToLower(strings.TrimSpace(k))] = v
	}

	// ---- 先按端口建立实例表（次序稳定）----
	insts := map[string]*mwRedisInst{}
	order := []string{}
	get := func(port string) *mwRedisInst {
		if v, ok := insts[port]; ok {
			return v
		}
		n := &mwRedisInst{Port: port}
		insts[port] = n
		order = append(order, port)
		return n
	}

	// 运行态（redis-cli CONFIG GET / INFO）最准，优先采信
	curPort := ""
	for _, ln := range strings.Split(secs["redis_cli"], "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "#PORT ") {
			curPort = strings.TrimSpace(strings.TrimPrefix(t, "#PORT "))
			get(curPort)
			continue
		}
		if curPort == "" {
			continue
		}
		ins := get(curPort)
		switch {
		case strings.HasPrefix(t, "config_file:"):
			v := strings.TrimSpace(strings.TrimPrefix(t, "config_file:"))
			if strings.HasPrefix(v, "/") {
				ins.Config = v
			}
			continue
		case strings.HasPrefix(t, "executable:"):
			ins.Exe = strings.TrimSpace(strings.TrimPrefix(t, "executable:"))
			continue
		case strings.HasPrefix(t, "tcp_port:"):
			continue
		}
		k, v, ok := strings.Cut(t, "=")
		if !ok {
			continue
		}
		switch k {
		case "dir":
			ins.Dir = v
		case "logfile":
			ins.Logfile = v
		case "dbfilename":
			ins.Rdb = v
		case "appendfilename":
			ins.Aof = v
		}
	}

	// 进程视角：补 exe / 启动参数里的 conf / 端口（无 root 时 ss 没有 pid，退回参数解析）
	for _, p := range rsProcs {
		fs := strings.Fields(p.Args)
		exe := exeByPid[p.Pid]
		argConf := ""
		argPorts := []string{}
		for _, tok := range fs[1:] {
			if strings.HasSuffix(tok, ".conf") && strings.HasPrefix(tok, "/") {
				argConf = tok
			}
			if strings.HasPrefix(tok, "--port=") {
				if pt := strings.TrimPrefix(tok, "--port="); mwPortRe.MatchString(pt) {
					argPorts = append(argPorts, pt)
				}
			}
			if k := strings.LastIndex(tok, ":"); k >= 0 && !strings.HasPrefix(tok, "/") {
				if pt := tok[k+1:]; mwPortRe.MatchString(pt) {
					argPorts = append(argPorts, pt)
				}
			}
		}
		pts := mwSortPorts(append(portsByPid[p.Pid], argPorts...))
		if len(pts) == 0 {
			pts = []string{""}
		}
		for _, pt := range pts {
			ins := get(pt)
			if ins.Exe == "" {
				ins.Exe = exe
			}
			if ins.Config == "" && argConf != "" {
				ins.Config = argConf
			}
		}
	}

	// 配置文件视角：按 conf 里的 port 与实例配对（配不上的只作为候选路径列出）
	for _, cpath := range confOrder {
		kv := confKeys[cpath]
		cport := kv["port"]
		var target *mwRedisInst
		if cport != "" {
			// conf 里写明 port 时，即便没有 #PORT / portsByPid（未提权）也要创建实例，
			// 否则这个端口会被静默丢弃（之前 ports=[6379] 在未提权资产上随机消失就是这个原因）。
			target = get(cport)
			// 若该 port 实例已经指向另一份 conf，优先保留原指向
			if target.Config != "" && target.Config != cpath {
				continue
			}
		}
		if target == nil || (cport == "" && target == nil) {
			for _, pt := range order {
				if insts[pt].Config == cpath {
					target = insts[pt]
					break
				}
			}
		}
		if target == nil {
			continue
		}
		// 已有明确指向其它配置文件的实例，不被候选覆盖
		if target.Config != "" && target.Config != cpath {
			continue
		}
		target.Config = cpath
		if target.Dir == "" {
			target.Dir = kv["dir"]
		}
		if target.Logfile == "" {
			target.Logfile = kv["logfile"]
		}
		if target.Rdb == "" {
			target.Rdb = kv["dbfilename"]
		}
		if target.Aof == "" {
			target.Aof = kv["appendfilename"]
		}
	}

	ports := []string{}
	logs := []string{}
	install := ""
	for _, pt := range order {
		if pt == "" {
			continue
		}
		ports = append(ports, pt)
	}
	multi := len(ports) > 1
	for _, pt := range order {
		ins := insts[pt]
		if ins.Logfile != "" {
			logs = append(logs, ins.Logfile)
		}
		if install == "" && ins.Exe != "" {
			install = mwPrefixOf(ins.Exe)
		}
		prefix := ""
		if multi && ins.Port != "" {
			prefix = "端口 " + ins.Port + " · "
		}
		if ins.Dir != "" {
			it.Storage = mwSetKv(it.Storage, prefix+"存储位置（dir）", ins.Dir)
		}
		if ins.Rdb != "" {
			it.Storage = mwSetKv(it.Storage, prefix+"RDB 文件", ins.Rdb)
		}
		if ins.Aof != "" {
			it.Storage = mwSetKv(it.Storage, prefix+"AOF 文件", ins.Aof)
		}
	}
	if install == "" {
		for _, p := range rsProcs {
			fs := strings.Fields(p.Args)
			if len(fs) > 0 && strings.Contains(fs[0], "/") {
				install = mwPrefixOf(fs[0])
				break
			}
		}
	}
	// 未提权时 /proc/<pid>/exe 读不到（redis_exe 段为空），
	// 退回「本机确实存在的 redis-server 路径」推断一个安装位置，并标注为推断值
	inferredInstall := false
	if install == "" {
		for _, ln := range strings.Split(secs["redis_info"], "\n") {
			t := strings.TrimSpace(ln)
			if !strings.HasPrefix(t, "#BIN ") {
				continue
			}
			b := strings.TrimSpace(strings.TrimPrefix(t, "#BIN "))
			if !strings.Contains(b, "/") {
				continue
			}
			if install = mwPrefixOf(b); install != "" {
				inferredInstall = true
			}
			break
		}
	}
	it.InstallPath = install
	it.Ports = mwSortPorts(ports)
	it.LogPaths = mwLogDirs(logs)

	confs := []string{}
	for _, pt := range order {
		if insts[pt].Config != "" {
			confs = append(confs, insts[pt].Config)
		}
	}
	it.ConfigPaths = mwUniq(append(confs, confOrder...))

	if multi {
		it.Notes = append(it.Notes, fmt.Sprintf("该机器上同时运行 %d 个 Redis 实例（端口 %s），存储位置按端口分行标注",
			len(ports), strings.Join(it.Ports, ",")))
	}
	if inferredInstall {
		it.Notes = append(it.Notes, "未取得 root 权限，安装位置按本机存在的 redis-server 路径推断（可能不是该实例实际使用的二进制）")
	}
	if len(it.ConfigPaths) == 0 {
		if !privileged {
			it.Notes = append(it.Notes, "未取得 root 权限，未能读取配置文件")
		} else {
			it.Notes = append(it.Notes, "启动参数未指定配置文件，且常见位置未找到 redis.conf（可能以命令行参数方式启动）")
		}
	} else if len(confs) == 0 {
		it.Notes = append(it.Notes, "以上配置路径为常见位置候选，未能确认运行实例实际加载的是哪一个")
	}
	return it
}

// mwSetKv 覆盖式写入键值（同名取值最后一次，保持首次出现的顺序）
func mwSetKv(list []MwKv, k, v string) []MwKv {
	if strings.TrimSpace(v) == "" {
		return list
	}
	for i := range list {
		if list[i].Key == k {
			list[i].Value = v
			return list
		}
	}
	return append(list, MwKv{Key: k, Value: v})
}

// ---------------------------------------------------------------------------
// 单资产捕捉
// ---------------------------------------------------------------------------

// mwCaptureAsset 对一台资产执行一次完整捕捉（只读）。
// 返回的 MwCapture 未落库，由调用方 upsert。
func mwCaptureAsset(a *Asset, by string) *MwCapture {
	start := time.Now()
	rec := &MwCapture{
		AssetID:    a.ID,
		AssetName:  AssetDisplayName(a),
		CapturedAt: time.Now(),
		CapturedBy: by,
	}
	fields := map[string]interface{}{}
	if len(a.Fields) > 0 {
		_ = json.Unmarshal(a.Fields, &fields)
	}
	rec.Host = toStr(fields["虚拟机IPv4"])
	if rec.Host == "" {
		rec.Host = toStr(fields["虚拟机EIP-IPv4"])
	}
	rec.Zone = toStr(fields["所属网络区域"])

	t, err := crontabSSHInfo(a)
	if err != nil {
		rec.Status = MwCaptureStatusFailed
		rec.Error = err.Error()
		rec.DurationMs = time.Since(start).Milliseconds()
		return rec
	}
	rec.Host = t.IP

	if !t.probeReachable(crontabDialProbe) {
		rec.Status = MwCaptureStatusFailed
		rec.Error = fmt.Sprintf("无法从 ansible 控制节点 %s 连接 %s:%d（网络不通或端口未开放）",
			t.runnerName(), t.IP, t.Client.Port)
		rec.DurationMs = time.Since(start).Milliseconds()
		return rec
	}

	out, privileged := mwCaptureRun(t, mwCaptureScript())
	rec.Privileged = privileged
	rec.DurationMs = time.Since(start).Milliseconds()
	if strings.TrimSpace(out) == "" {
		rec.Status = MwCaptureStatusFailed
		rec.Error = "已连上目标机但未取到任何输出（目标机可能缺少 base64/head 等基础命令）"
		return rec
	}
	if len(out) > mwCaptureRawCap {
		rec.Raw = out[:mwCaptureRawCap]
	} else {
		rec.Raw = out
	}

	secs := mwCaptureSections(out)
	// 以探测脚本回填的 meta 段（uid/who）为权威判定：真正拿到 root 才算提权成功。
	// 注意：探测脚本恒退出 0，不能靠退出码判断，只能看 uid。
	if uid := strings.TrimSpace(secs["meta"]); strings.Contains(uid, "uid=0") {
		privileged = true
		rec.Privileged = true
	} else {
		privileged = false
		rec.Privileged = false
	}
	procs := mwParseProcs(secs["procs"])
	portsByPid := mwPortsByPid(secs["ss"])

	items := []MwCaptureItem{}
	for _, it := range []*MwCaptureItem{
		mwNginxItem(secs, procs, portsByPid, privileged),
		mwPhpItem(secs, procs, privileged),
		mwJavaItem(secs, procs, portsByPid),
		mwRedisItem(secs, procs, portsByPid, privileged),
		mwBwsItem(secs, procs, portsByPid, privileged),
		mwEsItem(secs, procs, portsByPid, privileged),
	} {
		if it != nil {
			items = append(items, *it)
		}
	}
	for _, it := range mwTomcatItem(secs, procs, portsByPid) {
		items = append(items, *it)
	}

	types := make([]string, 0, len(items))
	for _, it := range items {
		types = append(types, it.Type)
	}
	rec.MwTypes = strings.Join(types, ",")
	if b, err := json.Marshal(items); err == nil {
		rec.Items = string(b)
	}
	switch {
	case len(items) == 0:
		rec.Status = MwCaptureStatusNone
		if !privileged {
			rec.Error = "未发现目标中间件；且未取得 root 权限，结果可能不完整"
			if hint := strings.TrimSpace(t.PrivHint); hint != "" {
				rec.Error += "【详细原因】" + hint
			}
		}
	case privileged:
		rec.Status = MwCaptureStatusOK
	default:
		rec.Status = MwCaptureStatusPartial
		if hint := strings.TrimSpace(t.PrivHint); hint != "" {
			rec.Error = "未取得 root 权限，部分信息可能不完整【详细原因】" + hint
		} else {
			rec.Error = "未取得 root 权限，部分信息可能不完整"
		}
	}
	return rec
}
