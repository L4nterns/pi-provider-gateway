# 验证记录

## 验证对象与边界

- 独立公开仓库：[L4nterns/pi-provider-gateway](https://github.com/L4nterns/pi-provider-gateway)，包名 `pi-provider-gateway@1.0.0`。
- 本轮实际测试宿主：Pi Coding Agent 1.5.0、Node.js 24.22.2。这是测试基线，不是插件要求锁定的 Pi 运行时版本；宿主提供的 peer dependencies 为 `*`。
- 代码不依赖 pic、Docker、浏览器或独立认证后端。pic 只通过原生 `pi install` 从本仓库在线安装，不再捆绑源码。
- 此次公开发布只调整安装说明、仓库元数据、验证文档与 CI；协议、凭据和模型能力实现保持不变。
- 未发布 npm 包或预构建镜像，也未修改现有 Pi 的配置、凭据、模型覆盖、历史或宿主安装。

## 本地自动化

```sh
npm ci --ignore-scripts
npm run check
npm test
```

- TypeScript 检查通过。
- 18 项测试通过，0 失败。
- 覆盖 URL 规范化、协议声明与优先级、真实 JSON/SSE 形状验证、分页、认证头协商、Gemini 只读目录回退、重定向保护、能力来源和显式 false、图片/max、密钥绑定缓存、0600/原子写入/并发冲突、原生用户覆盖、离线、凭据变化、失败保留、合法空目录、取消、遮罩输入、菜单操作与独立分发形态的真实 Pi CLI 加载。
- 离线压缩载荷检查确认 `cacheRetention: none` 不发送未验证的 `prompt_cache_options`，不降低 max 档位。
- GitHub Actions 运行相同的无真实凭据检查；真实网关脚本不会在 CI 自动执行。

## 先前完成的真实网关验证

以下是开发阶段已实际执行的记录，并非本轮发布时重新发出的付费请求。已有凭据只读入内存，测试状态使用临时目录或内存，不打印密钥：

- 测试网关目录包含 9 个模型；`gpt-6.1-sol` 的 Responses、272000 上下文、128000 输出、text/image 与 low/medium/high/xhigh/max 正常注册。
- Responses、Chat Completions、Anthropic Messages 的真实协议探测成功；Gemini 返回 HTTP 503，仍标为**未确认**，不是不支持。
- max 普通生成、工具调用 → 工具结果 → 最终回复、离线缓存恢复通过。
- 128×128 纯绿 PNG 被回答为 Green；较早的 32px 红色样本被答作 Orange。只证明这些样本的实际行为，不代表全面视觉准确率；没有为通过测试修改传输或关闭图片。
- 真正的 Pi `session.compact()` 使用多轮合成会话、调用模型生成摘要后成功；不是仅检查 JSON，也不是在真实用户历史中执行压缩。
- 无开发 `node_modules` 的独立发布目录通过真实 Pi 安装、离线模型列表、max 请求、终端菜单和 `/reload` 检查。
- 早期独立安装暴露的内部 API 子路径问题已修复为公开 `builtinProviders()` 委托，并由分发形态回归覆盖。
- 实测 Pi 1.5 原生 `/login` 会明文回显 secret；扩展只指引使用遮罩的 `/gateway login`，仍使用原生凭据存储。

## 在线安装验收

在与真实 Pi 数据分离的临时 HOME/agent 目录，实际验证公开提交 `47a2480a312c69ec705a6ea599586e20eaf75298`：

- 清空全局 Git 配置、禁用 credential helper，不提供 GitHub token，匿名 HTTPS 查询成功。
- pic 的实际通用引导器调用原生 `pi install` 成功；checkout HEAD 与审查提交一致，没有安装另一份宿主 Pi peer。
- 只构造合成服务与密钥，原生 Pi 离线加载后正确注册模型；合成凭据和模型覆盖保持不变，不读取真实账号或调用付费模型。
- 再次离线引导成功；原生卸载后引导不会自动装回。

具体发布提交与在线检查结果也随交付报告记录。

不把单次版本验收当作对所有未来 Pi 版本的兼容保证。容器镜像、宿主安装、实际业务服务与 iOS/其他项目不在本仓库验证范围内。
