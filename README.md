# 大肥鱼 × 歇会儿（dsh-pet-restnow）

让桌面上的大肥鱼替「歇会儿 RestNow」提醒你休息：该歇了它游过来陪着你，关掉弹窗它就回原位；想控制歇会儿，右键点鱼或打开浏览器控制台就行。

**本插件必须搭配「歇会儿 RestNow」**：<https://xiehuier.cn> —— 只装插件、没装歇会儿，不会有任何效果。

> 当前发布版本：`0.4.7`

## 环境要求
- Windows 10 / 11
- 已安装 DSH Desktop 并能正常显示桌面桌宠
- 已安装并运行「歇会儿 RestNow」（默认开机自启）

## 安装

**方式一：DSH 插件页安装（推荐）**
1. 打开 DSH Desktop →「插件」
2. 搜索 `dsh-pet-restnow` 并安装
3. 完全退出 DSH（托盘右键退出），重开让配置生效

**方式二：本地安装包（.tgz）**
1. 取得包文件：在 npm 执行 `npm pack dsh-pet-restnow`，或从 [npm](https://www.npmjs.com/package/dsh-pet-restnow) / GitHub 下载 `dsh-pet-restnow-*.tgz`
2. DSH Desktop →「插件」→ 载入本地安装包，选择该 `.tgz`
3. 完全退出 DSH 重开

> 装完后确认桌宠在桌面模式：DSH 设置 → 桌宠 → 显示位置选「桌面」或「两者」。

## 快速上手
- **右键点鱼 →「更多」**：6 个常用操作（立即休息 / 开始专注 25·35·45 分钟 / 暂停提醒 / 延后 5 分钟）
- **Web 控制台**：浏览器打开 <http://127.0.0.1:47110/>，20 个按钮，手机尺寸自适应
- **斜杠命令**：DSH 输入框里 `/restnow`、`/restnow test` 等

## 用手机控制（可选）
在插件配置里把 `webLan` 设为 `true` 并重启 DSH，控制台会绑定到局域网并强制口令；带口令的网址打印在 DSH 的 `harness.log` 里，手机同 WiFi 打开即可。
注意：打开局域网等于把控制能力放到网络上，请只在可信的私人网络开启，别用弱口令。

## 相关链接
- 歇会儿官网：<https://xiehuier.cn>
- npm 包：[dsh-pet-restnow](https://www.npmjs.com/package/dsh-pet-restnow)
- 问题反馈：GitHub Issues

许可：MIT
