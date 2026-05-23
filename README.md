# DeepSeek Web API Proxy

将 DeepSeek 网页版（chat.deepseek.com）包装为 OpenAI 兼容的 API 接口。

## 功能

- OpenAI 兼容 `/v1/chat/completions` 端点
- 流式（SSE）和非流式响应
- Cookie + Token 认证
- PoW 挑战自动求解
- 多会话隔离
- Docker 容器化部署

## 快速开始

### 1. 获取认证凭证

1. 打开 https://chat.deepseek.com 并登录
2. 按 F12 打开开发者工具 → Network 标签
3. 发送一条消息，找到 `chat.deepseek.com/api/v0/chat/completion` 请求
4. 从请求头中复制：
   - `Authorization: Bearer <token>` → 填入 `auth.json` 的 `token` 字段
   - `Cookie` → 填入 `auth.json` 的 `cookie` 字段
   - `x-hif-dliq` 和 `x-hif-leim`（如果有）→ 可选

### 2. 配置

```bash
cp auth.example.json auth.json
# 编辑 auth.json 填入你的凭证
```

### 3. 启动

```bash
docker-compose up -d
```

### 4. 使用

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8000/v1", api_key="any")
response = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

## API 端点

| 路径 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/v1/models` | GET | 模型列表 |
| `/v1/chat/completions` | POST | 聊天补全（OpenAI 兼容） |
| `/v1/auth` | POST | 动态配置认证信息 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 8000 | 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `CONFIG_PATH` | /app/auth.json | 配置文件路径 |
| `LOG_LEVEL` | info | 日志级别 |
