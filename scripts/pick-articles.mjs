// 第 4 步：从第 3 步的池子里按规则挑出「值得下载学习的爆款文章」。
//
//   node scripts/pick-articles.mjs --out "<输出目录>" --total 50
//   node scripts/pick-articles.mjs --out "<输出目录>" --dry-run
//
// 规则：时间窗 + 阅读下限 + 赛道词必中 + 去重 + 爆款分排序 + 每号上限 + 低粉爆款优先配额。
import { join } from 'node:path';
import { articleKey, articleSignal, readValue } from './reading-stats.mjs';
import {
  buildMustRegex,
  clean,
  ensureDir,
  fmt,
  list,
  num,
  parseArgs,
  readJson,
  samplePool,
  sinceFromMonths,
  today,
  truthy,
  writeCsv,
  writeJson,
  writeText,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const outDir = String(args.out || process.argv[2] || '').trim();
if (!outDir) {
  console.error('缺少 --out（第 3 步的输出目录，里面有 pool.json / accounts.json）。');
  process.exit(2);
}

const cfg = readJson(join(outDir, 'config.json'), {});
const opt = (name, def) => (args[name] !== undefined ? args[name] : cfg[name] !== undefined ? cfg[name] : def);

const total = num(opt('total', 50), 50);
const perAccount = num(opt('per-account', 5), 5);
const minRead = num(opt('min-read', 10000), 10000);
const onlyLow = truthy(opt('only-low', false));
const signalOptions = {medianMax:num(opt('baseline-median-max',1000),1000),minSamples:num(opt('baseline-min-samples',10),10),minRead:num(opt('signal-read',10000),10000),minRatio:num(opt('signal-ratio',10),10)};
const monthsN = num(opt('months', 6), 6);
const since = String(opt('since', sinceFromMonths(monthsN))).slice(0, 10);
const mustWords = list(opt('must', cfg.keywords || []));
const must = buildMustRegex(mustWords);
const exclude = new Set(list(opt('exclude-account', '')));
const only = new Set(list(opt('only-accounts', '')));
const dry = truthy(opt('dry-run', false));
const preferLowFan = opt('prefer-low-fan', true) !== false && String(opt('prefer-low-fan', 'true')) !== 'false';
const lowFanQuota = num(opt('low-fan-quota', 0.6), 0.6);
const wShare = num(opt('w-share', 3), 3);
const wLook = num(opt('w-look', 0), 0);
const wLike = num(opt('w-like', 0), 0);
const wRead = num(opt('w-read', 1), 1);
const skipMust = truthy(opt('no-must', false)) || !mustWords.length;

ensureDir(outDir);

const pool = dry ? samplePool() : readJson(join(outDir, 'pool.json'), []);
// dry-run 也读 accounts.json：只要第 3 步跑过，账号名和倍率就该带上
const accountList = readJson(join(outDir, 'accounts.json'), []);
if (!pool.length) {
  console.error('池子为空：' + join(outDir, 'pool.json') + ' 里没有数据，先跑 find-accounts.mjs。');
  process.exit(1);
}

const accByBiz = new Map(accountList.map((a) => [a.wx_biz, a]));
const scoreOf = (r) => (readValue(r.read_num)||0)*wRead + (readValue(r.share_num)||0)*wShare + (readValue(r.look_num)||0)*wLook + (readValue(r.like_num)||0)*wLike;

// ---- 过滤 + 双重去重 ----
const seenSn = new Set();
const seenTitle = new Set();
const candidates = [];
let droppedTime = 0;
let droppedRead = 0;
let droppedMust = 0;
let droppedAccount = 0;
let droppedDup = 0;

for (const r of pool.slice().sort((a,b) => scoreOf(b) - scoreOf(a))) {
  const pub = String(r.pub_time || '').slice(0, 10);
  if (pub && pub < since) {
    droppedTime++;
    continue;
  }
  if (readValue(r.read_num) === null || r.read_num < minRead) {
    droppedRead++;
    continue;
  }
  const hay = (r.title || '') + ' ' + (r.desc || '');
  if (!skipMust && must && !must.test(hay)) {
    droppedMust++;
    continue;
  }
  const acc = accByBiz.get(r.wx_biz) || {};
  const accName = acc.wx_name || r.wx_name || '';
  if (exclude.size && (exclude.has(accName) || exclude.has(r.wx_biz))) {
    droppedAccount++;
    continue;
  }
  if (only.size && !(only.has(accName) || only.has(r.wx_biz))) {
    droppedAccount++;
    continue;
  }
  const titleKey = r.wx_biz + ':' + clean(r.title);
  const id = articleKey(r);
  const signal = articleSignal(r, acc, signalOptions);
  if (onlyLow && !signal.low) { droppedAccount++; continue; }
  if (seenSn.has(id) || seenTitle.has(titleKey)) {
    droppedDup++;
    continue;
  }
  seenSn.add(id);
  seenTitle.add(titleKey);
  candidates.push({
    ...r,
    爆款分: scoreOf(r),
    账号爆款倍率: acc.ratio === undefined || acc.ratio === null ? '' : acc.ratio,
    单篇爆款倍率: signal.inWindow ? signal.ratio : null,
    低粉爆款信号: signal.low ? '是' : '',
    基线起日: acc.baseline_start || '',
    基线止日: acc.baseline_end || '',
    wx_name: accName,
  });
}

candidates.sort((a, b) => b.爆款分 - a.爆款分);

// ---- 选：低粉爆款优先配额 + 每号上限 ----
const perAccCount = new Map();
const picked = [];
const pickedKeys = new Set();
const take = (item) => {
  const key = item.sn;
  if (pickedKeys.has(key)) return false;
  const accKey = item.wx_biz || item.art_url;
  if ((perAccCount.get(accKey) || 0) >= (perAccount || Infinity)) return false;
  perAccCount.set(accKey, (perAccCount.get(accKey) || 0) + 1);
  pickedKeys.add(key);
  picked.push(item);
  return true;
};

const limit = total || Infinity;
const lowFanTarget = preferLowFan ? Math.ceil(limit * lowFanQuota) : 0;
for (const it of candidates) {
  if (picked.length >= lowFanTarget) break;
  if (it.低粉爆款信号) take(it);
}
for (const it of candidates) {
  if (picked.length >= limit) break;
  take(it);
}

// ---- 落盘 ----
const rows = picked.map((it, i) => ({
  序号: i + 1,
  标题: clean(it.title),
  账号: it.wx_name || '',
  阅读量: it.read_num,
  点赞: it.like_num,
  在看: it.look_num,
  转发: it.share_num,
  爆款分: it.爆款分,
  账号爆款倍率: it.账号爆款倍率,
  单篇爆款倍率: it.单篇爆款倍率,
  基线起日: it.基线起日,
  基线止日: it.基线止日,
  低粉爆款信号: it.低粉爆款信号,
  发布日期: String(it.pub_time || '').slice(0, 10),
  关键词: it.keyword || '',
  原文链接: it.art_url,
  阅读量核实状态: '接口读取（wxrank artlist）',
  sn: it.sn,
  wx_biz: it.wx_biz,
}));

writeJson(join(outDir, 'articles.json'), rows);
writeCsv(
  join(outDir, 'articles.csv'),
  ['序号', '标题', '账号', '阅读量', '点赞', '在看', '转发', '爆款分', '账号爆款倍率', '单篇爆款倍率', '基线起日', '基线止日', '低粉爆款信号', '发布日期', '关键词', '原文链接', '阅读量核实状态'],
  rows
);

const byAccTop = [...perAccCount.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .map(([biz, n]) => {
    const name = (accByBiz.get(biz) || {}).wx_name || biz;
    return '| ' + name + ' | ' + n + ' |';
  });

const report = [
  '# 待下载爆款文章 · ' + String(cfg.track || '') + '（' + today() + '）',
  '',
  '- 池内文章：' + pool.length + ' 篇｜过滤后候选：' + candidates.length + ' 篇｜选中：' + rows.length + ' 篇',
  '- 规则：时间窗 ≥ ' + since + '｜阅读 ≥ ' + minRead + '｜赛道词' + (skipMust ? '（未启用）' : '必中：' + mustWords.join(' / ')) +
    '｜爆款分 = 阅读×' + wRead + ' + 转发×' + wShare + ' + 在看×' + wLook + ' + 点赞×' + wLike,
  '- 每号上限：' + (perAccount || '不限制') + ' 篇｜低粉爆款优先配额：' + (preferLowFan ? Math.round(lowFanQuota * 100) + '%' : '关闭'),
  '- 被过滤：时间窗 ' + droppedTime + '｜阅读不足 ' + droppedRead + '｜赛道词不符 ' + droppedMust + '｜账号黑白名单 ' + droppedAccount + '｜重复 ' + droppedDup,
  '',
  '## 选中文章',
  '',
  '| # | 标题 | 账号 | 阅读 | 转发 | 爆款分 | 倍率 | 发布日期 |',
  '|---|---|---|---|---|---|---|---|',
  ...rows
    .map(
      (r) =>
        '| ' + r.序号 + ' | ' + String(r.标题).replace(/\|/g, '／') + ' | ' + r.账号 + ' | ' + fmt(r.阅读量) + ' | ' +
        fmt(r.转发) + ' | ' + fmt(r.爆款分) + ' | ' + fmt(r.单篇爆款倍率) + ' | ' + r.发布日期 + ' |'
    ),
  '',
  '## 账号分布（前 12）',
  '',
  '| 账号 | 选中篇数 |',
  '|---|---|',
  ...byAccTop,
  '',
  '## 人工卡点（必须）',
  '',
  '**先停在这里，把这份清单给用户过目，确认后才下载。**',
  '- 想砍掉某个号：下载时加 `--exclude-account "号名1,号名2"`',
  '- 只留某几个号：下载时加 `--only-accounts "号名1,号名2"`',
  '- 只下指定几篇：下载时加 `--only-sn "sn1,sn2"`',
  '- 想要更多/更少：调整 `--total`、`--per-account`、`--min-read` 后重跑本脚本',
];
writeText(join(outDir, 'picked.md'), report.join('\n') + '\n');

console.log('选中 ' + rows.length + ' 篇（候选 ' + candidates.length + '，池内 ' + pool.length + '）');
console.log('  ' + join(outDir, 'articles.csv'));
console.log('  ' + join(outDir, 'picked.md'));
console.log('下一步：把 picked.md 给用户过目——这是必留的人工卡点，确认后再跑 download.mjs。');
