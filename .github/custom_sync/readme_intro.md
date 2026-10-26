# web-access：按需使用浏览器的个人版本

本仓库是 [eze-is/web-access](https://github.com/eze-is/web-access) 的个人 fork，
由 [codefoxs](https://github.com/codefoxs) 维护。浏览器功能和运行代码跟随上游，
主要调整技能的触发描述，使其适用于需要浏览器的任务。

## 与上游版本的区别

| 项目 | 上游版本 | 本版本 |
|---|---|---|
| `SKILL.md` 的 `description` | 将所有联网操作列为技能适用范围 | 仅在明确指定、需要用户浏览器登录态、页面交互或浏览器渲染时使用；普通公开搜索、静态网页读取、公开 API 和无需登录态的下载不默认触发 |
| 浏览器功能与运行代码 | 上游维护 | 跟随上游同步，保留原有功能 |
| `SKILL.md` 正文 | 上游使用流程 | 保持上游内容；正文中的宽泛联网要求仍需由个人 `AGENTS.md` 限定适用范围 |
| 更新方式 | 上游发布提交 | GitHub Actions 每 6 小时检查上游 `main`，合并更新后重新应用自定义描述 |
| README | 上游介绍 | 顶部提供本版本说明与安装方式，分隔线后保留最新上游原文 |

本版本没有删除浏览器能力，也没有重写上游正文。修改 `description` 用于收窄技能的
自动匹配范围；最终调用还取决于代理的规则和当前任务。建议在个人 `AGENTS.md` 明确：

```markdown
- `web-access` 按需使用，仅在明确指定、需要用户浏览器登录态、页面交互，或已确认
  必须依赖浏览器渲染时使用。普通公开搜索、静态网页读取、公开 API 请求和无需
  浏览器登录态的下载，可直接使用当前会话提供的合适工具。
- 若 `web-access` 正文要求所有联网都经过本技能，以本节规定的适用范围为准；
  系统和开发者指令另有要求时从其要求。项目另有专项要求时按其要求执行。
```

## 安装本版本

安装到 Codex 的全局技能目录：

```powershell
npx skills add codefoxs/web-access --skill web-access -g -a codex
```

也可以使用完整仓库地址：

```powershell
npx skills add https://github.com/codefoxs/web-access --skill web-access -g -a codex
```

安装到其他支持的代理时，去掉 `-a codex` 后按命令提示选择目标代理。
本版本的技能名仍为 `web-access`；若已有同名技能，请先确认替换目标，并将个人
浏览器配置和站点经验保留在 `~/.web-access/`，不要只保存在可被替换的安装目录中。
Windows 上该用户数据目录通常是 `C:/Users/24350/.web-access/`。

后续手动更新时，仍使用本仓库的安装命令；GitHub 自动同步不会修改本机已安装的技能。
首次浏览器配置和使用流程见下方上游原文。

## 自动同步与维护

- 工作流：[Sync upstream and customize description](https://github.com/codefoxs/web-access/actions/workflows/sync_upstream.yml)。每 6 小时检查一次，也可点击 **Run workflow** 手动运行。
- 同步上游后，自动重写 `SKILL.md` 的 `description`，并用本说明模板与最新上游 README 重新生成本页；没有变化时不产生新提交。
- 顶部说明的维护源是 [readme_intro.md](.github/custom_sync/readme_intro.md)；本页为生成文件，请勿直接修改顶部说明或上游原文。
- 自定义描述的维护源是 [sync.py](.github/custom_sync/sync.py) 中的 `DESCRIPTION`。
- 同步机制、验证方法和 GitHub 平台限制见 [FORK_SYNC.md](FORK_SYNC.md)。

下方为上游 README 原文。其中安装地址、适用范围和宣传文字保留作者表述；
安装本版本请使用上方 `codefoxs/web-access` 的命令，触发范围以本版本说明及个人规则为准。
