# Agent 安装指南

适用于 Antigravity、Codex 和其他可以运行本地命令的 Agent。安装本身不发送模型请求，不改写 Antigravity 安装包。

## 已下载项目

1. 确认目录内有 `plugin.json`，其中 `name` 是 `agy-max`。读取 `package.json` 获取版本。
2. macOS（主力实测环境）在项目目录执行 `sh ./install.sh`；Windows（未做真机实测，仅供参考）执行 `powershell -NoProfile -ExecutionPolicy Bypass -File ./install.ps1`。Linux Desktop 暂不维护。
3. 安装器优先使用已有 Node.js 22.13 或更高版本，再尝试 Antigravity 自带的 `agy-node`。不需要 `npm install`，发行包已包含编译后的日历组件。
4. 检查命令成功退出，并核对 `~/.gemini/config/plugins/agy-max/.agy-install.json` 的版本（若本机装有旧版 `agy-powertools`，安装器会自动停用旧版并无损继承原有设置与多账号配置）。
5. 告知用户安装结果。如果当前客户端尚未显示入口，让用户完成当前任务后重新打开 Antigravity。不要强制关闭正在承载本次会话的客户端。

## 从 GitHub 安装

使用用户提供的实际仓库地址。先读取仓库 README 和本文件，下载正式 Release 中的 ZIP，或克隆源码到临时工作目录，再执行上面的统一安装入口。仓库地址尚未提供时不要编造下载地址。

仅安装用户指定的项目。不修改其他插件、账户、权限或聊天文件，不在当前对话发送测试提示，不要求管理员权限。

## 一键复制给 Agent 的安装指令

```text
请帮我安装 Antigravity Max（https://github.com/wangbingnan136/agy-max）：先阅读仓库内的 docs/INSTALL_AGENT.md，按统一安装脚本静默安装，保留现有聊天记录与配置，不要强关当前窗口，装完核对版本并提醒我重启即可。
```

若使用已下载的本地目录，将提示词中的链接替换为本地目录路径即可。

## 卸载

macOS 执行 `sh ./uninstall.sh`；Windows（未实测）执行 `powershell -NoProfile -ExecutionPolicy Bypass -File ./uninstall.ps1`。也可以从安装目录执行 `node scripts/uninstall.mjs`。默认清理插件数据，显式传入 `--keep-settings` 可以保留个人设置。

卸载保留原生聊天、工作区、下载的源码和用户主动导出的文件。对不能确认归属的日志不会强行删除，命令会报告保留数量。
