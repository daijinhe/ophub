# 云枢 OpsHub · 智能运维平台
# Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
# SPDX-License-Identifier: MIT

import re
src = open("backend/fields.go", encoding="utf-8").read()
targets = ["项目经理","开发人员","运维负责人","项目技术负责人","用途","备注","申请日期","申请人","端口","云账号","分发区域","备注_2","密码_2","业务环境"]
for line in src.splitlines():
    matched = False
    for t in targets:
        if t in line and "Key:" in line and "Label:" in line:
            matched = True
            break
    if not matched:
        continue
    km = line.find('Key: "'); kj = line.find('"', km+6)
    key = line[km+6:kj]
    lm = line.find('Label: "'); lj = line.find('"', lm+8)
    label = line[lm+8:lj]
    g = re.findall(r'Group:\s*"([^"]+)"', line)
    gs_match = re.search(r'Groups:\s*\[([^\]]+)\]', line)
    gs = []
    if gs_match:
        gs = [s.strip().strip('"') for s in gs_match.group(1).split(',')]
    all_g = g + gs
    print(f"LABEL={label!r:14} KEY={key!r:20} groups={all_g}")