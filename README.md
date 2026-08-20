# NutriLink 可运行版

## 启动

```bash
npm install
JWT_SECRET="a-long-random-production-secret" npm start
```

访问 `http://localhost:3000`。首次使用通过“创建账号”注册；登录、订单、文件元数据和原文件均写入已配置的 Supabase 项目。

## 工厂订单详情看板迁移

在生产 Supabase 项目的 SQL Editor 中执行：

1. `supabase/nl_factory_detail_board_migration.sql`（已有环境可重复执行）
2. `supabase/nl_factory_order_board_v2_migration.sql`

第二个脚本新增采购成本和订单变更审计表。执行后重新部署 Railway 服务，工厂详情看板会使用确认稿中的字段顺序；发票、付款凭证、成品 COA、自由销售证明、原产地证和健康证通过订单文档类型自动联动。

## 生产部署

部署时设置强随机 `JWT_SECRET`、`SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`，以 HTTPS 运行 Railway 服务。Supabase 数据库和 Storage 是生产数据源，不应把密钥提交到 Git。
Railway deployment trigger
Supabase runtime configuration enabled.
Supabase secrets rotated and configured.
