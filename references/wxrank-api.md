# wxrank 接口能力与边界（公众号数据）

最后核实：2026-10-06（官方文档 https://www.showdoc.com.cn/2343746579263506 ；价目以控制台为准）。

## 接口本体

- Base：`http://data.wxrank.com/weixin/`
- 鉴权：请求体带 `key`（GET / POST 均可，本 skill 统一用 POST JSON）
- 计费：**只有 `code === 0` 才扣积分**；非 0 是业务错误（积分不足 1000、参数错误 1001 等），**不要重试**——重试多少次都是同一结果，只是白花钱
- 返回的是**真实阅读量**，不是估算值

## 端点清单（10 个）

| 端点 | 作用 | 单价 | 关键参数 | 返回重点 |
|---|---|---|---|---|
| `artlist` | 按「日期/月份 + 条件」列文章（离线库，50 条/页，5 亿篇，覆盖约 40 万活跃号） | ¥0.01 | `month`/`date`、`keyword`、**`wx_biz`（按号筛）**、`min_read_num`、`max_read_num`、`wx_type`、`cursor`(5 分钟) | `sn`/`title`/`pub_time`/**`read_num`**/`like_num`/`look_num`/`share_num`/`wx_biz`/`art_url` |
| `getps` | **实时拉某个号的推文列表**（可翻页到历史） | ¥0.05 | `wxid`（微信号或 `gh_` 原始ID）、`cursor`(24 小时) | `title`/`pub_time`/`sn`/`art_url`/`pic_url`（**无阅读量**，每页约 10 次推文 × 最多 8 篇） |
| `getsu` | 按关键词搜公众号（搜号） | ¥0.10 | `keyword`、`page` | `wx_id`（微信号）/`wx_biz`/`wx_user`（原始ID）/`wx_name`/`signature`/头像 |
| `getrk` | **按文章链接取实时数据** | ¥0.02 | `url`（长链，需含 `__biz`）、`comment_id`（可选） | `read_num`/`like_num`/`look_num`/`share_num`/`collect_num`/`reward_count`/`comment_count` |
| `getbiz` | 按 `biz` 取公众号基础信息（关于公众号页） | ¥0.05 | `biz` | 简介/微信号/认证类型/认证主体/商标保护/名称记录/IP 属地 |
| `getinfo` | 按 `biz` 取公众号原始ID | ¥0.05 | `biz` | `name`/`user_name`（`gh_` 原始ID）/`signature`/`hd_head_img` |
| `artinfo` | 按文章链接取内容（正文） | ¥0.01 | `url` | `name`/`user_name`/`signature`/`pub_time`/`text`（**不含阅读量**） |
| `artshort` | 文章长链转短链 | ¥0.01 | `url` | 短链 |
| `getso` | 搜一搜/关键词文章列表 | ¥0.10 | `keyword`、`sort_type`、`page` | `wx_name`/`pub_time`/`title`/`desc`/`art_url`/`pic_url`（**无阅读量**） |
| `score` | 查剩余积分 | 免费 | — | 剩余积分文案 |

> `code` 约定：`0` 成功并扣分；`1000` 积分不足；`1001` 参数错误；`1002` 获取失败；`9999` QPS 超限（每秒最多 3~5 个）——**只有 9999 和网络异常值得重试**。

## 三条别踩的坑（实测）

1. **`artlist` 不限号时只回流高阅读文章**。用小号标题反查可能是 0 命中。按 `wx_biz` 筛号时覆盖度取决于该号是否在离线库里——"库里没有"≠"这个号没发文"。
2. **`getso` 按账号名搜索 ≠ 账号维度查询**。拿号名当 keyword，返回的是"标题/正文含这几个字的热文"，实测归属率 0/17。判号不能用它。
3. **`getrk` 要长链**。短链要先走 `artshort`（反了，是把长链转短链；短链想变长链要自己解析页面拿 `__biz/mid/idx/sn`）。

## 免费通道（不花一分钱）

2026-10-06 实测：

| 通道 | 能拿到什么 | 结论 |
|---|---|---|
| 直抓文章页 `mp.weixin.qq.com/s?__biz=...` | 正文 + 配图 + 标题 + 作者 + 发布时间 | **可用**（功能 B 的底座，约 3.4MB/篇） |
| 合集页 `mp/appmsgalbum?action=getalbum&__biz=X&album_id=Y&f=json` | 该合集**全部文章的标题+永久链+日期**，可翻页（`begin_msgid`/`begin_itemidx` + `continue_flag`） | **可用**，是「扒一个号」免费路的核心 |
| 文章页里的 `appmsgalbuminfo.album_id` | 该文所属合集的 id | **可用**，从任意一篇文章链接就能拿到 |
| 文章页里的 `publictag?action=get&tag_id=...`（号全量入口） | 理论上是该号内容全量 | **不可用**：返回 `no session`，要登录 |
| 历史消息 `mp/profile_ext?action=home&__biz=X` | 该号全部历史 | **不可用**：返回「请在微信客户端打开」，要登录态 |
| 微信读书 | — | **否决**：无公开 API、需逆向挂 cookie、有账号风险 |
| 搜狗搜公众号 `type=1` | 按号名搜号 | **已停用**：返回「暂无与 X 相关的官方认证订阅号」 |
| 搜狗搜文章 `type=2&query=号名` | 该号的一部分文章 | **可用但很差**：实测本号占比 2/10，翻到第 2、3 页是 0 条；且是 `timestamp+signature` 临时链 |
| 阅读量 | — | **免费拿不到**：公开页面里是 `var read_num = "" * 1`，真实值只对登录态返回 |

## 结论

**"找得到文章"（免费）和"判得出爆款"（付费）是两件事。** 本 skill 的分工：

- 搜爆款 → 必须付费（`artlist` 建池 + `artinfo` 补号名）。
- 扒一个号 → **免费走合集**（只覆盖该作者放进合集的文章）；**付费走 `artlist`+`wx_biz` 或 `getps`**（完整度高）。
- 下载正文和图片 → 免费直抓，`artinfo` 只做失败兜底（默认关闭）。
- 阅读量 → 要么 `artlist` 自带，要么用 `getrk` 按篇补（¥0.02/篇）；**没有就写「不可见」，不许估**。
