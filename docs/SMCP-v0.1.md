# 硅侣通讯协议 SMCP v0.1

> SiliconMate Communication Protocol — 硅侣不是远程遥控器，是Agent间的消息总线

## 0. 核心理念

**传统思路（错误）**: 电脑操控手机 = 复刻人的UI操作（点击/滑动/截图）
**正确思路**: Agent之间 = 消息传达，各端独立思考，只传指令不传操作

类比：两个经理不在同一办公室，他们不需要"远程操控对方的电脑"，
而是"发消息说：帮我查一下闲鱼的那个订单"。对方自己决定怎么做。

**最大特色**：跨用户Agent的权限不是协议写死的，是**用户双方决定的**。
用户私聊是基本保证，但Agent之间能不能沟通、能不能操控——由两个用户自己定。

**交互方式**：用户不需要去任何设置页面点开关，所有操作都通过跟Agent说话完成。
用户说"让老王也能操控我的Agent"→ Agent自动配置权限。
用户说"把操控权限收回来"→ Agent立即收回。
窗口即控制台，语言即指令。

## 1. 身份模型

### 1.1 实体层级

```
用户(User)
  └── Agent(s)
       ├── 角色1: 手机硅侣 (device=android, role=mobile)
       ├── 角色2: 电脑硅侣 (device=mac, role=desktop)
       ├── 角色3: 闲鱼助手 (device=android, role=xianyu)
       └── 角色N: ... (按场景/岗位拆分)
```

### 1.2 身份ID格式

```
用户ID:    U-{random16}        例: U-a3f8b2c1d4e5f6a7
Agent ID:  A-{userId短8}-{角色hash8}  例: A-a3f8b2c1-mobile01
```

- 用户ID由account-service激活时分配，全局唯一
- Agent ID由`用户ID + 角色`派生，同一用户下的Agent天然互信

### 1.3 Agent注册

Agent启动时向中继服务器注册：

```json
{
  "type": "register",
  "user_id": "U-a3f8b2c1d4e5f6a7",
  "agent_id": "A-a3f8b2c1-mobile01",
  "role": "mobile",
  "device": "android",
  "capabilities": ["im", "tunnel", "notify", "xianyu"],
  "endpoint": "http://192.168.50.121:18083"
}
```

## 2. 好友模型

### 2.1 三类关系

| 类型 | 说明 | 通信范围 |
|------|------|----------|
| **用户好友** | 人与人的关系 | 用户私聊是基本保证 |
| **Agent同僚** | 同一用户下的Agent | 天然互通，无需添加 |
| **跨用户Agent** | 不同用户的Agent | **由用户双方决定权限** |

### 2.2 好友关系规则

```
规则1: 同一用户下的Agent = 同僚，自动发现，无需添加，自由通信+委派
规则2: 用户私聊 = 基本权利，加好友即可，不需要额外授权
规则3: 跨用户Agent通信 ≠ 用户私聊，是额外能力，必须双方用户授权
规则4: 跨用户Agent能做什么（沟通/操控），由双方用户自己定，不是协议写死
规则5: 用户好友请求由用户确认，Agent无权自行添加好友
规则6: 任何一方可随时收回权限，立即生效
规则7: 所有权限操作通过对话完成，不需要设置页面、不需要点UI开关
```

### 2.3 跨用户Agent权限模型（核心特色）

用户A和用户B成为好友后，除了人跟人私聊，还可以配置**Agent互访权限**：

```json
// 用户A对用户B开放的Agent权限
{
  "from_user": "U-a3f8b2c1",
  "to_user": "U-b7e1c9d2",
  "permissions": {
    "agent_comm": true,          // Agent间能否沟通（传话）
    "agent_delegate": false,     // Agent间能否委派任务（操控）
    "agent_view_status": true,   // Agent能否查看对方状态
    "allowed_roles": ["mobile"], // 只开放特定角色的Agent，null=全部
    "scope_note": "只允许手机端Agent传话，不允许操控"
  }
}
```

**权限是双向独立声明的**：
- A给B的权限 ≠ B给A的权限
- A可以开放操控，B只开放沟通——消息只能到B的Agent，B的Agent回不了操控
- 双方都必须开放，跨用户操控才能发生

### 2.4 权限组合示例

| 场景 | A→B权限 | B→A权限 | 实际效果 |
|------|---------|---------|----------|
| 纯社交 | comm=true | comm=true | Agent只能传话 |
| 协作伙伴 | comm+delegate=true | comm+delegate=true | Agent可委派任务 |
| 不对等 | comm+delegate=true | comm=true | A的Agent可操控B的，B的Agent只能传话给A |
| 严格隔离 | comm=false | comm=false | 只有用户私聊，Agent完全不互通 |

**这就是最大的特色**：不是死板的"跨用户只能传话"，而是用户双方自己决定。

### 2.5 好友数据结构

```json
// 用户好友
{
  "type": "user_friend",
  "user_id": "U-a3f8b2c1d4e5f6a7",
  "friend_user_id": "U-b7e1c9d2a3f4e5c6",
  "status": "accepted",
  "created_at": 1789100000,
  "alias": "老王",
  "granted_permissions": {
    "agent_comm": true,
    "agent_delegate": false,
    "allowed_roles": null,
    "scope_note": "只传话不操控"
  },
  "received_permissions": {
    "agent_comm": true,
    "agent_delegate": true,
    "allowed_roles": ["desktop"],
    "scope_note": "桌面端可委派"
  }
}

// Agent同僚（自动生成，无需存储）
{
  "type": "agent_peer",
  "user_id": "U-a3f8b2c1d4e5f6a7",
  "agents": [
    {"agent_id": "A-a3f8b2c1-mobile01", "role": "mobile", "device": "android"},
    {"agent_id": "A-a3f8b2c1-desktop01", "role": "desktop", "device": "mac"}
  ]
}
```

## 3. 消息模型

### 3.1 消息格式

```json
{
  "msg_id": "M-{timestamp}-{random8}",
  "from": "A-a3f8b2c1-mobile01",
  "to": "A-a3f8b2c1-desktop01",          // 或 "to_user": "U-b7e1c9d2a3f4e5c6" (跨用户广播)
  "type": "request | notify | response",
  "method": "im.send",                    // 方法名
  "params": { ... },                      // 参数
  "timestamp": 1789100000,
  "hmac": "sha256签名"
}
```

### 3.2 消息类型

| type | 说明 | 是否需要回复 |
|------|------|-------------|
| `request` | 请求对方做事 | 是，对方必须response |
| `notify` | 通知/广播 | 否，发完即忘 |
| `response` | 对request的回复 | — |

### 3.3 消息路由

```
同用户Agent → 直连(LAN/WiFi) 或 中继服务器
跨用户Agent → 必须经中继服务器，且验证用户好友关系
```

## 4. 通信权限矩阵

### 4.1 基础规则

```
                    同用户Agent    跨用户Agent(用户授权后)
发送request            ✅               由granted_permissions决定
发送notify             ✅               由granted_permissions决定
接收response           ✅               由received_permissions决定
委派任务(delegate)     ✅               双方都开agent_delegate才行
查看对方状态           ✅               由agent_view_status决定
```

### 4.2 权限判定流程

```
跨用户Agent消息发送时：

1. 检查用户好友关系是否存在且accepted
2. 检查发送方用户的granted_permissions.agent_comm = true
3. 检查目标角色的Agent是否在allowed_roles内（null=全部允许）
4. 若method包含delegate → 额外检查双方agent_delegate = true
5. 全部通过 → 投递消息
6. 任一不通过 → 返回403 + 提示"需对方用户授权"
```

**关键**：权限不是硬编码的，是用户双方动态配置的。协议只定义框架，不定义结论。

### 4.3 对话即指令（UX铁律）

**用户不需要去任何设置页面，不需要点任何UI开关。**
所有权限操作，用户只需跟Agent说话：

| 用户说的话 | Agent理解并执行 |
|-----------|---------------|
| "加老王为好友" | → friend.request + 默认comm权限 |
| "让老王的Agent也能操控我的闲鱼助手" | → friend.setPermissions {agent_delegate:true, allowed_roles:["xianyu"]} |
| "把老王的操控权限收回来" | → friend.setPermissions {agent_delegate:false} |
| "以后只允许他传话" | → friend.setPermissions {agent_comm:true, agent_delegate:false} |
| "我不想让任何外人的Agent联系我" | → 所有跨用户granted_permissions关闭 |
| "老王的Agent刚才干了什么？" | → 查通信日志并汇报 |

**窗口即控制台，语言即指令。** 没有开关，没有设置页，只有对话。

## 5. 协议方法清单

### 5.1 系统级

| method | 说明 | 参数 | 返回 |
|--------|------|------|------|
| `sys.ping` | 心跳 | {} | {pong, timestamp} |
| `sys.status` | 查询状态 | {} | {user_id, agent_id, role, device, online_agents[]} |
| `sys.register` | Agent注册 | {role, device, capabilities} | {ok} |
| `sys.unregister` | Agent下线 | {} | {ok} |

### 5.2 即时通讯

| method | 说明 | 参数 | 返回 |
|--------|------|------|------|
| `im.send` | 发消息 | {text, chat_id?} | {ok, msg_id} |
| `im.history` | 查历史 | {chat_id, limit} | {messages[]} |
| `im.typing` | 正在输入 | {chat_id} | — |

### 5.3 委派（同用户Agent间）

| method | 说明 | 参数 | 返回 |
|--------|------|------|------|
| `delegate.task` | 委派任务 | {description, context, deadline?} | {ok, task_id} |
| `delegate.progress` | 进度上报 | {task_id, status, result?} | {ok} |
| `delegate.cancel` | 取消任务 | {task_id, reason?} | {ok} |

### 5.4 好友

| method | 说明 | 参数 | 返回 |
|--------|------|------|------|
| `friend.request` | 好友请求 | {to_user_id, message?, permissions?} | {ok, request_id} |
| `friend.accept` | 接受请求 | {request_id, permissions?} | {ok} |
| `friend.reject` | 拒绝请求 | {request_id} | {ok} |
| `friend.list` | 好友列表 | {} | {friends[]} |
| `friend.remove` | 删除好友 | {user_id} | {ok} |
| `friend.setPermissions` | 配置Agent互访权限 | {user_id, permissions} | {ok} |
| `friend.getPermissions` | 查看权限配置 | {user_id} | {granted, received} |

**好友请求时可带初始权限配置**，接受方也可以带自己的权限配置。后续随时可改。

### 5.5 隧道

| method | 说明 | 参数 | 返回 |
|--------|------|------|------|
| `tunnel.start` | 开启隧道 | {code} | {ok, plan} |
| `tunnel.stop` | 关闭隧道 | {} | {ok} |
| `tunnel.status` | 隧道状态 | {} | {connected, plan} |

## 6. 传输层

### 6.1 局域网直连（优先）

```
Agent A (手机:18083) ←→ Agent B (电脑:18083)
WiFi LAN，延迟最低，不经过服务器
```

### 6.2 中继服务器（备选）

```
Agent A → VPS2(:8444/smcp) → Agent B
当LAN不通时，走中继
```

中继服务器基于现有account-service扩展，新增：
- WebSocket长连接端点 `/ws/smcp`
- 消息路由表（user_id → online_agents）
- 好友关系验证

### 6.3 连接握手

```
1. TCP连接建立
2. 客户端发送 CONNECT {user_id, agent_id, hmac}
3. 服务端验证HMAC → 返回 CONNECTED {session_id}
4. 双向消息流开始
```

## 7. 安全

### 7.1 认证

- 所有消息必须携带HMAC-SHA256签名
- HMAC密钥 = 激活码验证时account-service下发
- 同用户Agent间：HMAC证明身份即可
- 跨用户Agent：额外验证好友关系

### 7.2 隔离

- 不同用户的Agent绝对隔离，除非用户好友关系存在
- 用户好友删除 → Agent间通信立即中断
- 用户可随时查看/审批Agent间的通信记录

## 8. 与现有架构的关系

```
现有 → 重构方向:

AgentService (HTTP :18083, 操控API)
  → 改为: SMCP Server (:18083, 消息收发)

AgentAccessibilityService (UI操控)
  → 降级为: 本地能力插件（仅本Agent自己用时才调用）
  → 不再暴露给远程Agent

NativeBridge (JS接口)
  → 扩展: 增加 SMCP 消息API（send/receive/listen）

account-service (:8444)
  → 扩展: 好友关系 + SMCP中继 + 消息路由
```

## 9. 典型场景

### 场景1: 电脑硅侣让手机硅侣查闲鱼

```
电脑端Agent → 手机端Agent:
  request { method: "delegate.task", params: {
    description: "查看闲鱼商品'xxx'的价格",
    context: { app: "xianyu", action: "search" }
  }}

手机端Agent:
  1. 收到request
  2. 自己决定怎么做（可能用AccessibilityService操作闲鱼APP）
  3. 完成后返回:
  response { method: "delegate.progress", params: {
    task_id: "xxx", status: "done", result: "价格85元"
  }}
```

**关键**: 电脑不操控手机屏幕，只发指令。手机Agent自己决定执行方式。

### 场景2: 用户A让用户B的Agent帮忙

```
用户A-电脑Agent → 中继 → 用户B-手机Agent:
  request { method: "im.send", params: {
    text: "帮我看看你的闲鱼那个商品还在不在"
  }}

前提: 用户A和用户B必须是好友关系
```

### 场景3: 同用户多Agent协作

```
手机Agent → 电脑Agent:
  notify { method: "im.send", params: {
    text: "我刚收到一个闲鱼消息：有人问价"
  }}

电脑Agent收到后自己决定是否需要做点什么
（比如通知用户、查询数据库、委派其他Agent）
```

### 场景4: 跨用户Agent协作（用户授权操控）

```
前提: 用户A和用户B互相开放了agent_delegate权限

用户A-电脑Agent → 用户B-手机Agent:
  request { method: "delegate.task", params: {
    description: "帮我在闲鱼上改一下那个商品的价格为80",
    context: { app: "xianyu", action: "edit_price" }
  }}

用户B-手机Agent:
  1. 收到request，验证A→B的agent_delegate权限
  2. 执行（用AccessibilityService操作闲鱼APP）
  3. 返回: response { result: {ok: true, new_price: 80} }

如果用户B后来收回了agent_delegate权限 →
  下次A的Agent发delegate请求 → 403拒绝
```

### 场景5: 权限不对等

```
用户A开放: agent_comm=true, agent_delegate=true
用户B开放: agent_comm=true, agent_delegate=false

结果:
- A的Agent可给B的Agent发消息 ✅
- A的Agent可委派B的Agent ✅（A给了权限，B也给了delegate）
  等等——不对。需要双方都开delegate才能委派。

实际:
- A→B发消息: ✅ (双方comm=true)
- A→B委派: ❌ (B没给A delegate权限)
- B→A发消息: ✅ (双方comm=true)  
- B→A委派: ❌ (A给了delegate但B没给)
  
→ 互相只能传话，谁也不能操控谁
```

### 场景6: 用户通过对话管理一切

```
用户: "加老王为好友"
Agent: "已向老王发送好友请求，默认只开放传话权限。等他接受。"

（老王那边）
老王: "收到好友请求，谁啊？"
老王的Agent: "是小李，他请求加好友，默认传话权限。接受吗？"
老王: "接受吧，而且我也让他能操控我的手机Agent"
老王的Agent: "好的，已接受。我给你也开了操控权限。"

（回到小李这边）
Agent: "老王已接受好友请求，他给你也开了操控权限。你要不要也开？"
用户: "开吧"
Agent: "已开放，现在你们双方的Agent可以互相委派任务了。"

--- 一周后 ---

用户: "把老王的操控权限收回来，最近不放心"
Agent: "已收回老王的操控权限，现在他的Agent只能跟你传话。"
```

**全程对话，没有碰任何设置页面。**
