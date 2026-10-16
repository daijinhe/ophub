# 云枢 OpsHub · 智能运维平台

一套面向虚拟机资产管理的智能运维平台：统一登录注册、RBAC 权限治理、CMDB 多级分类资产管理，支持按「资源清单模板」批量导入 / 导出，页面采用科技感暗色 UI。

> 技术栈：**React 18 + TypeScript + Ant Design 5**（前端） · **Go 1.22 + Gin**（后端） · **PostgreSQL 16**（业务库） · **Redis 7**（缓存 / 会话黑名单） · **Docker Compose** 一键部署。

---

## 版本记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| **v1.5.0** | 2026-08-21 | **智能巡检系统**：对 CMDB 资产列表中的服务器进行资源巡检。后端新增 `inspection_tasks / inspection_records / inspection_results` 三张表与全套接口；**通过 Ansible 采集**目标机 CPU / 内存 / 磁盘 / 负载 / 运行天数等资源指标（可自定义勾选采集项），采集不可用时回退为模拟数据（明确标注来源）。支持**定时巡检**（日 / 周 / 月 / 季度 / 年，服务内调度器自动执行）。前端新增「智能巡检」任务管理页（建任务 / 选范围 / 选指标 / 启定时 / 立即执行）、「巡检报表」页（记录列表 + 详情抽屉 + 按日周月季度年**一键导出 Excel** 用于日报周报季度报年报），以及**独立科幻大屏**（`/inspection/screen`：健康评分、KPI、资源趋势 / 分布 echarts 图表、重点告警 TOP、实时资产滚动概览、实时时钟、10 秒自动刷新）。新增 `inspection:view` / `inspection:manage` 权限。 |
| **v1.4.3** | 2026-08-21 | **中间件类型小写化与排序**：将全部中间件类型名统一为小写——`MySQL→mysql`、`RabbitMQ→rabbitmq`、`RocketMQ→rocketmq`、`Logstash→logstash`、`宝兰德BWS310→宝兰德bws310`、`es→elasticsearch`；下拉顺序固定为 nginx / 宝兰德bws310 / jdk / php / redis / mysql / elasticsearch / logstash / kafka / rocketmq / rabbitmq / 其他。后端 `MwTemplate` 新增 `order_no` 字段，列表按序返回，启动时幂等迁移旧库（重命名类型、设定顺序、并将历史资产 `中间件信息` 里的旧类型名一并改为小写），避免旧资产匹配不到模板。 |
| **v1.4.1** | 2026-08-21 | **批量编辑资产**：勾选多行后工具栏出现「批量编辑」入口；弹窗可添加多个字段（下拉选择 schema 字段 + 新值，下拉型字段自动出选项，支持「置空」清除），点「确认修改」先弹出**确认预览弹窗**汇总即将生效的字段与值，确认后再统一写入。后端新增 `PUT /api/assets/batch`（需 `cmdb:update`），逐条合并指定字段到选中资产并重新派生名称 / IP。 |
| **v1.4.0** | 2026-08-20 | 中间件类型模板（全局共享）：每种中间件 / 数据库类型（nginx、宝兰德BWS310、jdk、redis、php、es、kafka、其他）自带**字段清单与默认值**，选择类型即按模板动态展示对应字段并自动预填默认值；证书路径等字段支持「依赖显示」（仅有证书=是时才出现）。内置「中间件类型管理」弹窗，可对任意类型**新增 / 删除字段、修改默认值与下拉选项、删除类型**，配置全局共享——其他资产选择该类型时直接复用默认值。后端新增 `mw_templates` 表与 CRUD 接口（`/api/mw/templates`），首次启动自动播种 8 类内置模板。 |
| **v1.3.0** | 2026-08-19 | 资产管理重构：以「资源录入终极模板」（127 列）为唯一数据源重建 schema；字段按 **8 大类** 分组展示——资源基本信息 / 用户密码管理（密码明文）/ 项目人员信息 / ELB相关信息 / 其他网络信息 / NAS相关信息 / 中间件和数据库信息 / 资源申请信息；第 7 类支持动态中间件实例（nginx/php/jdk/es/redis/kafka/其他，每实例含安装路径、配置文件路径、端口、域名、证书、密码等 + 自定义字段）；详情弹窗按分组折叠展示、**双击任意字段值即复制**；编辑表单按 8 类分组 + 中间件动态编辑 + 每组可自定义字段；下载/导入模板切换为该 127 列文件，导入自动跳过说明文字列与全空行、重复表头（备注/密码）按顺序映射。 |
| **v1.2.0** | 2026-08-19 | Ansible 节点（远程管理）：可注册多台 ansible 服务器，平台通过 SSH 连接每台节点并管理其 hosts 文件——增删改查节点、测试连接、查看 ansible 版本 / python / 配置文件 / playbook 目录、从 CMDB 导入主机到指定节点、执行任意 ad-hoc 命令（如 `ansible all -m ping`）。前端「主机清单」顶部新增节点选择器，本地节点与远程节点统一视图。 |
| **v1.1.1** | 2026-08-19 | Ansible 主机清单「添加主机」增强：支持来源切换——手工输入（多行 / 逗号 / 空格分隔的多个 IP·域名）或从 CMDB 资产多选；SSH 端口、用户、密码、sudo 密码对本次添加的**所有主机统一生效**；新增 `GET /api/ansible/cmdb-assets` 供前端拉取可导入资产。 |
| **v1.1.0** | 2026-08-19 | 「CMDB 资产管理」更名为「资产管理」；资产列表列重排为 11 列（应用系统名称/IPv4/网络区域/环境/CPU/内存/数据盘/系统版本/归属部门/部署服务/用途）；搜索框支持检索任意字段值（含自定义字段）；配套前端 1.0.0、后端 Go 1.22。 |
| v1.0.0 | — | 基础系统：登录注册、RBAC 权限、CMDB 多级分类资产管理、Excel 导入导出、科技感 UI、Docker Compose 部署。 |

---

## 功能特性

- **认证与账号**
  - 用户注册 / 登录（JWT），登录失效黑名单（Redis）
  - 用户管理：增删改查、启用 / 禁用、分配角色
- **RBAC 权限管理**
  - 角色管理：创建角色并勾选权限（按「概览 / 用户 / 角色 / CMDB / 分类」分组）
  - 内置 `超级管理员`（全权限）、`普通成员`（仅查看）；接口级权限校验
- **CMDB 资产管理**
  - 多级**部门 / 项目**分类树，可任意层级自建分类
  - 虚拟机资产全字段录入（与「资源清单模板」109 列一致，存于 JSONB）
  - 列表仅展示**关键列**（虚拟机名称 / IP / 归属部门 / 项目 / 规格等）；**双击任意一行**弹出抽屉，按分组展示全部字段
  - 导入：上传与模板表头一致的 Excel，按所选分类批量写入（同名自动更新）
  - 导出：按分类子树 + 关键字导出 Excel
- **界面**：暗色玻璃拟态 + 青蓝渐变科技风，路由动效、响应式布局

---

## 目录结构

```
ophub/
├── docker-compose.yml      # 一键编排 postgres / redis / backend / frontend
├── .env.example            # 环境变量样例（复制为 .env 修改）
├── backend/                # Go + Gin 后端
│   ├── main.go             # 路由与中间件装配
│   ├── config.go db.go models.go jwt.go response.go middleware.go
│   ├── handler_*.go        # 认证 / 用户 / 角色 / 分类 / 资产 接口
│   ├── excel.go            # 导入 / 导出（excelize）
│   ├── fields.go           # 由模板自动生成的 109 字段定义（单一数据源）
│   └── Dockerfile
├── frontend/               # React + AntD 前端
│   ├── src/api/fields.ts   # 与后端同源的字段定义（自动生成）
│   ├── src/pages/          # Login / Register / Dashboard / Users / Roles / CMDB
│   └── Dockerfile + nginx.conf
└── scripts/gen_fields.py   # 从模板重新生成前后端字段定义
```

---

## 快速部署（Docker Compose）

```bash
# 1. 准备环境变量
cp .env.example .env
# 编辑 .env，务必将 JWT_SECRET 改为随机长字符串

# 2. 构建并启动
docker compose up -d --build

# 3. 访问
#    前端：  http://localhost:10001
#    接口：  http://localhost:10001/api
```

默认管理员账号：**admin / admin123**（首次启动自动播种，请尽快修改密码）。

---

## 本地开发

后端（需本机 Postgres / Redis，或修改 config.go 默认值）：
```bash
cd backend
go run .
# 默认监听 :8080，环境变量示例：DB_HOST=localhost REDIS_ADDR=localhost:6379
```

前端：
```bash
cd frontend
npm install
npm run dev      # http://localhost:5173，已配置 /api 代理到 :8080
```

---

## 字段定义如何与模板同步

前后端的字段列表都由 `资源清单模板.xlsx` 的表头**自动生成**（脚本 `scripts/gen_fields.py`），保证导入 / 导出 / 列表 / 详情抽屉使用同一份字段。若模板列发生变化：

```bash
python3 scripts/gen_fields.py
```

即可重新生成 `backend/fields.go` 与 `frontend/src/api/fields.ts`。

---

## 接口概览

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | 注册 | 公开 |
| POST | `/api/auth/login` | 登录 | 公开 |
| GET | `/api/auth/me` | 当前用户 | 登录 |
| POST | `/api/auth/logout` | 登出 | 登录 |
| GET | `/api/users` | 用户列表 | user:view |
| POST/PUT/DELETE | `/api/users[/:id]` | 用户管理 | user:create/update/delete |
| GET | `/api/roles` `/api/permissions` | 角色 / 权限目录 | role:view |
| POST/PUT/DELETE | `/api/roles[/:id]` | 角色管理 | role:create/update/delete |
| GET | `/api/categories` | 分类树 | cmdb:view |
| POST/PUT/DELETE | `/api/categories[/:id]` | 分类管理 | category:manage |
| GET | `/api/assets` | 资产列表 | cmdb:view |
| GET/POST/PUT/DELETE | `/api/assets[/:id]` | 资产增删改查 | cmdb:* |
| POST | `/api/assets/import` | Excel 导入 | cmdb:import |
| GET | `/api/assets/export` | Excel 导出 | cmdb:export |
| GET | `/api/fields` | 字段 schema | 公开 |

---

## 开源协议

本项目基于 **MIT License** 开源，详见 [LICENSE](./LICENSE)。

```
Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
```

你可以自由使用、复制、修改、合并、发布、分发、再许可及销售本软件的副本，
但需保留上述版权声明与许可声明。软件按「原样」提供，不含任何明示或暗示的担保。
