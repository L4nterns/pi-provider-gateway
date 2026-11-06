# pi-provider-gateway

面向原生 Pi / Node.js 24 的通用兼容网关扩展。只管理 **连接、协议、模型目录与能力**；上游账号、路由、额度、负载均衡、用量面板均不在职责范围内。零第三方运行时依赖，使用 Pi 提供的原生接口。Pi 作为宿主提供 peer dependencies，不随插件捆绑或锁定版本；本轮测试版本见 [VALIDATION.md](VALIDATION.md)。

## 使用

从公开 GitHub 仓库在线安装，不需要 GitHub token，也不需要 pic：

```sh
pi install git:github.com/L4nterns/pi-provider-gateway
```

默认安装仓库最新分支（当前为 `main`），不固定版本、tag 或提交。独立使用时通过原生 `pi update git:github.com/L4nterns/pi-provider-gateway` 获取后续提交；原生持久化安装不是后台定时自更新器。在 pic 中，通用启动器会在没有其他托管 Pi 使用共享插件时、启动新进程前自动更新；接回原进程不更新，正在运行时不热替换。

开发时也可本地安装：

```sh
pi install /absolute/path/to/pi-provider-gateway
```

重启 Pi 或 `/reload`，运行 `/gateway`。

```text
/gateway                 终端菜单
/gateway add             添加另一个服务
/gateway login [ID]      配置 URL / Key；凭据写入 Pi 原生 auth.json
/gateway refresh [ID]    更新模型目录
/gateway detect [ID]     选择一个模型，显式验证四种协议（可能计费）
/gateway info [ID]       查看实际模型能力、兼容参数与自动信息来源
/gateway protocol [ID]   服务级／模型级协议覆盖，或恢复自动
/gateway remove [ID]     确认后删除连接、凭据和扩展缓存
/model                   Pi 原生模型选择
/thinking                Pi 原生思考档位选择
```

配置和认证在 Pi 终端内完成，不需要编辑宿主机挂载目录。密钥不作为命令参数，不写入聊天记录；菜单使用遮罩密钥输入框。Pi 1.5 的原生 `/login` 对 secret 仍使用明文 Input，并回显提交值，所以本扩展的 `/login` 入口只提示改用 `/gateway login`，不会向它索取密钥。凭据仍通过 Pi 原生接口持久化到 auth.json。删除当前选中服务前须先切换模型。

## 协议自动选择

支持 OpenAI Responses、Chat Completions、Anthropic Messages、Google Generative AI。每个模型单独选协议：

1. 用户明确覆盖。
2. 服务端 `native_endpoints` / `supported_endpoint_types` / 原生 Gemini 声明。
3. 缺少声明时，添加服务的向导询问是否探测：最多每模型四次小型生成请求，并发上限 3 个模型。会说明可能计费。也可在菜单中统一指定协议，不探测。
4. 多协议可用时，GPT/一般模型优先 Responses，Claude 优先 Messages，Gemini 优先原生 Gemini；这是在 **已声明或已验证支持的协议** 内的偏好，不是凭名称猜支持。

探测必须得到协议形状正确的成功响应，不能仅凭 HTTP 200。鉴权错误、429、503、超时一律是失败／未知，不等于协议不存在。没有成功结果不覆盖已有配置。探测不会在普通聊天中发生，不实现删参数后无限重试。新出现但没有协议声明、也没有已有探测记录的模型会暂不注册，在菜单中显式探测即可。

端点探测思路参考 Magpie 的 `internal/provider/detect.go` 与 `test.go`（阅读版本 `814a625a24379032030fbe8300315a7f9935e3e6`），没有复制其源码。

## 模型能力与兼容性

- 网关明确的上下文、输出上限、输入模态、reasoning 和思考档位优先。
- 缺失时使用 Pi 已安装目录的精确模型匹配，再使用 models.dev 公共目录。优先模型原厂；多供应商有歧义则不武断匹配。不依据模型名称杜撰上下文或 reasoning。
- 仍未知时，使用标为未验证的默认值（128K / 16K / text / 非 reasoning）；不能保证任意未知模型被完整识别。
- `max` / `xhigh` 以真实档位映射保留，不把它们静默降为 high。网关明确列出的档位之外显式设为 null。
- 公共目录价格是估算，不是网关账单。
- **不整包继承官方模型 compat。** Responses 不自动启用未经验证的 `prompt_cache_options`；这与模型是否支持 max、图片或工具是独立问题。
- 兼容 OpenAI 并不代表兼容所有可选字段；真实工具、图片与压缩仍需验收。
- Pi 原生 `models.json` 的 `modelOverrides` 是最终用户覆盖层，不由本扩展覆盖。信息页的来源描述自动层，实际参数包含原生覆盖。

## 持久化与边界

位置相对于 `PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）：

| 文件 | 内容 |
|---|---|
| `gateway.json` | 非秘密服务配置、协议选择 |
| `auth.json` | Pi 自己保存的凭据；通过公开 ModelRuntime 登录接口读写 |
| `cache/gateway/<ID>.json` | 仅模型元数据、协议结果、端点＋密钥的 SHA-256 绑定 |
| `cache/gateway/models-dev.json` | 无凭据的公共目录缓存 |

服务目录缓存 1 小时，公共目录缓存 24 小时。有缓存启动优先恢复；刷新失败保留最后有效结果。经过验证的空目录清空动态模型。`--offline` / `PI_OFFLINE=1` 不自动联网。无缓存首次启动可读取目录，但不会未经确认发出付费协议探测。

换地址／密钥后旧缓存不匹配；请求时还会检查模型的凭据绑定，拒绝用旧模型对象发出请求。缓存不保存 API Key、请求头或来自目录的任意 URL。目录／探测请求不跟随重定向；实际聊天请求的传输策略由 Pi 原生协议实现负责。URL 不接受内嵌凭据或查询参数；非本机 HTTP 连接需要确认风险。

注册完整的 Pi 原生 Provider，复用 Pi 的协议实现、工具转换、流解析和压缩。没有请求体修改 hook；没有 node_modules 补丁。配置写入是私有权限、原子替换，并有跨进程锁与冲突检查。

## 开发与测试

```sh
npm ci --ignore-scripts
npm run check
npm test
```

`node scripts/live-check.ts --live [--probe]` 是显式的真实网关测试：只使用已有凭据，不打印密钥；所有新缓存／设置／会话在临时目录或内存中。通过 `GATEWAY_TEST_PROVIDER`、`GATEWAY_TEST_MODEL`、`GATEWAY_TEST_URL` 指定已有服务，默认针对当前开发环境。`--probe` 最多额外发送四次协议测试请求。此脚本不是运行时的一部分。

测试包括元数据、凭据变更、离线、原子写入、协议探测、遮罩输入、Pi 原生覆盖、压缩请求载荷以及真实 Pi CLI 加载。真实网关检查另覆盖 max、工具往返、图片和 Pi 会话压缩。

## 与 pic 解耦

本仓库是独立 Pi 包，不导入或依赖 [pic](https://github.com/L4nterns/pic)。pic 不保存本插件源码或在镜像中复制插件目录，只通过通用启动器调用原生 `pi install` / `pi update`，从这个公开仓库获取默认分支最新提交，不固定插件版本。插件也可以在宿主机或任何其他 Pi 环境独立使用；服务配置、认证和协议策略不属于 pic。

已有本地安装不会被本仓库或 pic 自动迁移。切换安装来源前先备份 Pi 数据，通过原生包管理检查并处理旧声明，避免同时加载本地副本与 Git 副本；不要删除或覆盖 `auth.json`、模型例外或历史。
