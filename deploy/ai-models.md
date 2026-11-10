# AI 模型发现

后端只需配置根地址和密钥。
模型 ID 来自上游标准接口。
后端不再读取 `QFLI_AI_MODEL`。

## 配置

在部署目录的 `.env` 中填写：

```dotenv
QFLI_AI_BASE_URL=https://your-provider.example
QFLI_AI_API_KEY=your-provider-key
```

后端使用以下两个上游接口：

```text
GET  https://your-provider.example/v1/models
POST https://your-provider.example/v1/chat/completions
Authorization: Bearer <QFLI_AI_API_KEY>
```

根地址也可包含 `/v1`。
后端保留已有路径前缀。
例如 `/proxy/v1` 对应 `/proxy/v1/models`。
非本机地址必须使用 HTTPS。
本机开发可用 HTTP 回环地址。
地址不能含用户名、密码、查询参数或片段。

修改配置后，重建业务容器：

```sh
docker compose up -d --no-deps --force-recreate server
```

## 客户端接口

客户端继续使用 QFLI 登录令牌。
两个接口沿用现有账号验证规则。
上游密钥只留在后端。

### 获取模型

```http
GET /api/ai/models
Authorization: Bearer <QFLI_TOKEN>
```

响应保持标准模型列表结构：

```json
{
  "object": "list",
  "data": [
    {
      "id": "provider/coder:latest",
      "object": "model",
      "created": 0,
      "owned_by": "provider"
    }
  ]
}
```

后端保留上游顺序。
后端移除重复 ID。
`created` 和 `owned_by` 为可选字段。
后端只返回已定义字段。
后端最多接受 4096 个模型。
响应体上限为 2 MiB。

### 使用模型

```http
POST /api/ai/chat
Authorization: Bearer <QFLI_TOKEN>
Content-Type: application/json

{
  "model": "provider/coder:latest",
  "messages": [{ "role": "user", "content": "你好" }]
}
```

`model` 可省略，以兼容旧客户端。
省略时，后端使用列表中的第一个模型。
指定时，模型 ID 必须在列表中。
模型 ID 支持 `/` 和 `:` 等字符。
消息与工具调用沿用现有协议。
响应中的 `model` 为本次使用的模型 ID。

标准列表不保证每个模型都支持聊天或工具调用。
后端不会根据模型名称猜测能力。
旧客户端依赖上游将可用聊天模型排在首位。
支持模型选择的客户端应传入所选 ID。
本次发布只增加后端接口。

## 缓存与错误

模型列表缓存 60 秒。
缓存按上游地址和密钥区分。
更换任一配置后，后端重新获取列表。
后端不会缓存请求失败或格式错误。
列表和聊天请求共用现有限流规则。
请求断开后，后端取消上游请求。
聊天超时包括获取列表所用的时间。

| 条件 | 响应 |
| --- | --- |
| 未登录 | 401 |
| 缺少根地址或密钥 | 503 |
| 上游返回 401 或 403 | 502，AI 服务凭据无效 |
| 所选模型不在列表中 | 400 |
| 空列表 | 列表接口返回 200，聊天接口返回 503 |
| 模型列表格式错误 | 502 |
| 请求超时 | 504 |
| 超过请求限制 | 429 或 503 |

后端不转发上游错误正文。
后端不跟随上游重定向。
模型列表不可用时，后端不会猜测模型 ID。

## 验证

```sh
node --test test/ai-relay.test.js
node scripts/ci-common.mjs verify
```

测试覆盖模型选择、旧客户端、缓存与配置修改。
测试也覆盖鉴权、超时、取消、限流及错误脱敏。
