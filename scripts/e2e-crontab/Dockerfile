FROM alpine:3.20

# 先换源：默认 dl-cdn 在本机会「挂住」而不是失败，A || B 的兜底永远走不到
RUN sed -i 's#dl-cdn.alpinelinux.org#mirrors.aliyun.com#g' /etc/apk/repositories \
 && apk add --no-cache openssh sudo \
 # 注意：alpine 用的是 busybox crontab，镜像里**没有** /etc/crontab / /etc/cron.d，
 # 这几个目录要自己建（旧口径就是读它们，这里造出来当「不该被读 / 不该被改」的对照物）
 && mkdir -p /run/sshd /etc/cron.d /var/spool/cron/crontabs \
 # 登录用户：在 sudoers 里（%wheel），用于覆盖「sudo 提权成功」分支
 && adduser -D -s /bin/sh ituser \
 && echo 'ituser:Ituser@Test123' | chpasswd \
 && addgroup ituser wheel \
 # 无特权用户：不在 sudoers，用于覆盖「提权必然失败」分支
 && adduser -D -s /bin/sh nopriv \
 && echo 'nopriv:Nopriv@Test123' | chpasswd \
 && printf '%%wheel ALL=(ALL) ALL\n' > /etc/sudoers.d/wheel \
 && chmod 440 /etc/sudoers.d/wheel \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
 && ssh-keygen -A

# 基线 crontab（属于 root 的**用户 crontab**，平台的唯一数据源）。
# 单独 COPY 到 /tmp 以便随时一键重置：crontab /tmp/base.crontab
COPY base.crontab /tmp/base.crontab
RUN crontab /tmp/base.crontab \
 && echo "--- baseline: crontab -l ---" && crontab -l \
 && echo "--- baseline: /var/spool/cron/crontabs ---" && ls -l /var/spool/cron/crontabs

# 「平台不得误读 / 不得误伤」的对照物：
#   · /etc/crontab       —— 旧口径的唯一数据源；busybox 环境下本来没有，
#                           这里造出来并埋诱饵任务，用来证明新口径「一条都不读」
#   · /etc/cron.d/myapp  —— 旧口径采集过的系统级文件，既不该被读也不该被改
#   · ituser 自己的 crontab —— 平台的写入绝不能跑到别人头上
RUN printf 'SHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin\n# 诱饵：旧口径（/etc/crontab）里的系统级任务，平台绝不该读到它\n0 9 * * * root /bin/echo decoy-etc-crontab\n' > /etc/crontab \
 && printf '*/10 * * * * root /bin/echo cron-d-task\n' > /etc/cron.d/myapp \
 && printf 'SHELL=/bin/sh\n0 1 * * * /bin/echo ituser-own-task\n' > /var/spool/cron/crontabs/ituser \
 && chown root:root /etc/crontab /etc/cron.d/myapp \
 && chown ituser:root /var/spool/cron/crontabs/ituser \
 && chmod 644 /etc/crontab /etc/cron.d/myapp \
 && chmod 600 /var/spool/cron/crontabs/ituser \
 && echo "--- 诱饵 /etc/crontab ---" && cat /etc/crontab

EXPOSE 22
CMD ["/usr/sbin/sshd","-D","-e"]
