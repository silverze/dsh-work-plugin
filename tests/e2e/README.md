# E2E（W7）

本目录在 W7 完成。目标：用 Mock 飞书 + Playwright 覆盖三条验收场景，不依赖真实租户。

## 计划

1. `tests/e2e/mock-feishu.mjs`：Express 服务，实现 OAuth token、docx、sheets、drive、im 的最小端点；用固定 fixture 返回数据，记录请求用于断言。
2. `tests/e2e/setup.mjs`：启动 `dsh --profile work --patch ...`（或直接调用 host 服务），注入测试凭据，等待端口就绪。
3. `tests/e2e/scenario-*.test.mjs`：Playwright 驱动 Web UI，完成三条场景：
   - 文档 + 表格 → 周报 docx + PPT → 导入云文档 → 发群；
   - Excel → 分析 xlsx + 结论 docx → 每周一 09:00 定时 → 通知；
   - 知识库搜索 → 只引用有权限文档 → 追加到指定文档。
4. `tests/e2e/assertions.mjs`：校验产物存在、内容含关键字段、飞书请求带 user token（非 tenant token）、无越权调用。

## 环境

```bash
export FEISHU_MOCK=1
export FEISHU_MOCK_PORT=17322
export FEISHU_APP_ID=cli_mock
export FEISHU_APP_SECRET=mock_secret
export FEISHU_REDIRECT_URI=http://127.0.0.1:17322/feishu/oauth/callback
pnpm test:e2e
```

## 约束

- Mock 只在测试 profile 启用；生产代码不得因 `FEISHU_MOCK` 改变权限逻辑。
- 断言必须检查“没有用 tenant token 读用户文档”。
- 真实租户冒烟单独跑，不放入 CI（避免凭据与频控问题）。


## Host 级飞书 Mock 流程

```bash
# 终端 A：启动 mock，写入端口
PORT_FILE=.tmp-mock-port PORT=0 node tests/e2e/mock-feishu.mjs

# 终端 B：用 mock 配置启动 work profile（需 FEISHU_APP_ID/SECRET）
# 覆盖 dsh-work-feishu 的 baseUrl 与 redirectUri，然后：
node tests/e2e/feishu-rpc-flow.mjs '<launch-url>' 'http://127.0.0.1:<mock-port>'
```

流程覆盖 `feishu/startAuth -> loopback callback -> status -> shareArtifact`。
