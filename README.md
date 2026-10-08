# 老脸公众号对标爆款猎手（laolian-gzh-benchmark-hunter）

三个功能：**搜爆款（付费）｜下单篇（免费）｜指定博主批量下载（免费或付费）**。

这是一个供 Codex 读取并执行的中文 Skill，适合做公众号对标研究、整理文章素材库。免费通道负责下载公开文章，付费数据通道负责搜索和读取阅读量；二者分别选择。

[下载 v1.2.0 安装包](https://github.com/oldfacekg26/laolian-gzh-benchmark-hunter/releases/tag/v1.2.0) · [MIT 许可证](LICENSE) · [更新记录](CHANGELOG.zh.md)

---

## 一、装到哪

把整个 `laolian-gzh-benchmark-hunter` 文件夹放进你的 skills 目录：

在上面的下载页找到 `laolian-gzh-benchmark-hunter-v1.2.0.zip`，解压后取出同名文件夹。最终应能找到 `laolian-gzh-benchmark-hunter/SKILL.md`，避免重复套两层同名目录。

- Windows：`C:\Users\你的用户名\.codex\skills\`
- macOS / Linux：`~/.codex/skills/`

放好后新开一个 Codex 会话，说「用公众号对标爆款猎手」，或直接说「帮我找对标存爆款」「把这个号的文章都下下来」，就能唤起。

有 Git 的用户也可以直接克隆到尚不存在的安装目录：

```powershell
# Windows PowerShell
git clone https://github.com/oldfacekg26/laolian-gzh-benchmark-hunter.git "$env:USERPROFILE\.codex\skills\laolian-gzh-benchmark-hunter"
```

```bash
# macOS / Linux
git clone https://github.com/oldfacekg26/laolian-gzh-benchmark-hunter.git ~/.codex/skills/laolian-gzh-benchmark-hunter
```

已安装旧版时，先备份旧文件夹再替换。不要把自己的 `wxrank.key` 上传到 GitHub 或转发给别人。

## 二、环境要求

- 需要 **Node.js 18 或更高版本**（脚本用的是 Node 自带的网络能力）。
- **不需要装任何依赖包，不需要 Python。**

## 三、三个功能

### ① 搜爆款（付费）

给一个赛道**大类词**（中老年 / 读书 / 职场 / 心灵鸡汤 / AI / 养生 / 育儿 ……），它会：

1. 先给你 5-10 个赛道关键词，**等你拍板**
2. 搜出值得对标的公众号（低粉爆款优先）
3. 按固定规则挑出值得下载学习的爆款文章清单，**等你过目**
4. 你点头后，才批量下载正文 + 配图

**这一步要花钱，必须自备 wxrank 的 Key。** 因为"爆款"的命门是**真实阅读量**，而公众号公开页面把阅读量清空了，免登录抓不到——只有付费接口能给。

参考花费：一轮任务通常 **¥1.5 上下**（8 个关键词 × 近 6 个月）。脚本自带花费上限闸门，付费前先把"接口 × 次数 × 预估金额"报给你，你同意才花钱。

**Key 怎么配**（二选一，**不要把 Key 贴进对话或发给别人**）：

1. 设置环境变量 `WXRANK_KEY`
2. 在本文件夹里新建文本文件 `wxrank.key`，里面只写一行 Key

### ② 下单篇（免费）

把你手上**任意来源**的公众号链接丢给它——一条一行、直接贴一串、或给个 txt / csv 文件，它会把**正文 + 配图**一起存下来。

**完全免费，不需要 Key。** 一次 100 篇也是 ¥0。链接从哪来都行：自己收藏的、搜狗搜的、别人发的。

### ③ 指定博主批量下载（免费或付费）

想扒某个号，给它**这个号任意一篇文章的链接**即可（不用你手动翻历史）。

**免费路（默认，¥0）**：它抓这篇文章的页面，找到这个号的「**合集**」，把合集里的文章连正文带图全下走。

> 免费路的边界（先说清楚，不是 bug）：微信的"历史消息"页需要登录，免登录拿不到全部；所以**免费路只能覆盖作者放进「合集」的文章**，不等于该号全部文章。如果那篇文章没挂合集，免费路就没得翻——这时候走付费路。

**付费路（要 Key，可选）**：走 wxrank 接口拉这个号**更完整的文章清单**，还能补上每篇的**真实阅读量**。

- 按号拉离线库：¥0.01/次（一个号近 6 个月 ≈ ¥0.06）
- 实时拉推文列表（能翻更早）：¥0.05/次
- 逐篇补真实阅读量：¥0.02/篇

两条路都留**人工卡点**：清单出来先给你看，你确认哪几篇才下载。

## 四、几条重要说明（别当成 bug）

- **粉丝数拿不到。** wxrank 不返回粉丝数，所以"低粉爆款"用的是代理指标：**爆款倍率 = 最高阅读 ÷ 阅读中位**。报告里会明写"粉丝数不可见"。
- **阅读量拿不到就留空。** 免费路没有阅读量，不是"没人看"，只是没走付费接口；要真实数字就开 `--with-read`（¥0.02/篇）或走 `artlist`。
- **搜狗入口只是可选补充**，默认不用：它**不返回阅读量**（判不了爆款），而且解析出来的多是临时链，要马上下载。
- 价格、平台规则这类时效信息，用前请重新核实（核实日期见文末）。

## 五、目录结构

```
laolian-gzh-benchmark-hunter/
├── SKILL.md                      # 主流程（Codex 读这个）
├── README.md                     # 本文件，给人看的说明
├── agents/openai.yaml            # 界面显示名与默认提示词
├── references/
│   ├── wxrank-api.md             # 全部接口、字段、计费、能力边界（实测）
│   ├── selection-rules.md        # 对标账号与爆款文章的判定口径
│   └── keyword-playbook.md       # 赛道大类词 → 关键词族
└── scripts/
    ├── lib.mjs                   # wxrank 客户端（预算闸门、重试策略、去重）
    ├── find-accounts.mjs         # 功能 ① 第 3 步：搜账号
    ├── pick-articles.mjs         # 功能 ① 第 5 步：选爆款文章
    ├── download.mjs              # 功能 ②：免费下载正文 + 配图（支持 --links 直吃链接）
    ├── find-by-account.mjs       # 功能 ③：扒一个号（免费合集路 / 付费接口路）
    └── sogou-find.mjs            # 可选补充：搜狗找文章（无阅读量）
```

## 六、授权

MIT。

许可证覆盖本仓库的代码和文档。下载的第三方文章及图片仍归原权利人所有，不属于本仓库的开源授权范围。

## 七、先免费试用

安装后，可以对 Codex 说：

> 用公众号对标爆款猎手，下载这篇公众号文章的正文和配图，保存到我指定的文件夹：[在这里粘贴公开文章链接]。只走免费通道。

还可以说：

> 用公众号对标爆款猎手，在读书赛道找对标。先给我关键词，再等我确认；付费接口先报预算。

## 八、离线自检

在本仓库目录打开终端，依次执行以下命令。它们使用内置样例，不联网，不需要 Key，也不消耗积分。

```bash
node scripts/find-accounts.mjs --track "读书" --keywords "书单,认知" --dry-run --out .validation/search
node scripts/pick-articles.mjs --out .validation/search --dry-run
node scripts/download.mjs --out .validation/download --dry-run
node scripts/download.mjs --out .validation/links --links "https://mp.weixin.qq.com/s?__biz=X&sn=Y" --dry-run
node scripts/find-by-account.mjs --url "https://mp.weixin.qq.com/s?__biz=X&sn=Y" --dry-run --out .validation/account
node scripts/sogou-find.mjs --out .validation/sogou --dry-run
```

离线自检只验证脚本运行和文件产出，不能代替在线可用性验证。遇到文章删除、验证页面、合集缺失或平台限制时，先查看失败记录，按提示处理。

---

最后核实日期：2026-10-06（接口价目与平台规则以 wxrank 官方为准）。
