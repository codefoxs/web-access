# 自定义 web-access 同步说明

本仓库 fork 自 https://github.com/eze-is/web-access ，保留上游历史与代码，
仅对 `SKILL.md` 顶部的 `description` 应用个人使用范围，并增加本同步工具及说明。
正文流程、作者和版本信息继续跟随上游；AGENTS.md 中的适用范围覆盖规则仍需保留。

## 自动同步

- GitHub Actions 每 6 小时检查一次：UTC 00:23、06:23、12:23、18:23。
- Actions → **Sync upstream and customize description** → **Run workflow** 可手动执行。
- 同步使用上游 `main`，保留提交历史；常规内容冲突优先采用上游，再重新应用自定义描述。
- 没有变化不产生提交；异常冲突或文件结构变化导致任务失败，不推送部分结果。
- 同步脚本不会执行上游脚本，也不会连接本机浏览器。运行只使用仓库的 `GITHUB_TOKEN`，
  不需要保存个人访问令牌或浏览器资料。
- `.github/custom_sync/`、本同步 workflow 和本文保留本仓库版本。
- 若未来上游新增或修改其他 Actions workflow，`GITHUB_TOKEN` 可能因不允许修改
  workflow 文件而拒绝推送。届时用具备 workflow 权限的本机 Git 凭据手动同步，
  或另行配置专用凭据；当前上游没有 `.github` 目录。
- GitHub 的 schedule 可能延迟；公开仓库连续 60 天没有活动时，定时任务可能被自动停用。
  如停用，在 Actions 页面重新启用工作流。此工具不生成空提交维持活跃。

## 自定义描述

修改 `.github/custom_sync/sync.py` 中的 `DESCRIPTION`，随后在仓库根目录运行：

```powershell
python -B .github/custom_sync/test_sync.py
python -B .github/custom_sync/sync.py --patch-only
```

检查 `git diff` 后提交推送。不要只修改 `SKILL.md` 的 description，因为下一次同步
会按照脚本中的内容重新生成。其他 YAML 字段和正文不由描述补丁改写。

## 本机手动更新

本仓库自动同步不修改本机已安装的 skill。后续安装时使用自己的来源：

```powershell
npx skills add codefoxs/web-access --skill web-access -g -a codex
```

若本机 skill 已经作为本仓库的 Git checkout 维护，可在确认工作树无未提交改动后执行
`git pull --ff-only`。当前安装目录若不是 Git checkout，则不能直接在其中执行 git pull。
更新前保留个人配置及站点经验；它们应存放在 `C:/Users/24350/.web-access/`。
