# NutriLink 可运行版

## 启动

```bash
npm install
JWT_SECRET="a-long-random-production-secret" npm start
```

访问 `http://localhost:3000`。首次使用通过“创建账号”注册；登录、订单、文件元数据会写入 `nutrilink.db`，上传原文件保存到 `uploads/`。

## 生产部署

部署时设置强随机 `JWT_SECRET`，以 HTTPS 反向代理运行，并将 `nutrilink.db` 与 `uploads/` 挂载为持久卷。数据库文件与上传目录含业务数据，不应提交到 Git。
Railway deployment trigger
Supabase runtime configuration enabled.
Supabase secrets rotated and configured.
