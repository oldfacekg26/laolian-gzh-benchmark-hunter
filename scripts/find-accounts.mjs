// 第 3 步：按关键词用 wxrank artlist 建池，聚合成候选对标账号（低粉爆款优先）。
//
//   node scripts/find-accounts.mjs --track "读书" --keywords "书单,认知,搞钱" --yes
//   node scripts/find-accounts.mjs --track "读书" --keywords "书单,认知" --dry-run
//
// 先不带 --yes 跑一次，只会打印计划和预估花费，不调用接口、不花钱。
import { join } from 'node:path';
import {
  Budget,
  BudgetStop,
  bizOf,
  buildMustRegex,
  call,
  clean,
  ensureDir,
  fmt,
  lastMonths,
  list,
  loadKey,
  num,
  parseArgs,
  priceOf,
  readJson,
  samplePool,
  saveBudget,
  sleepMs,
  snOf,
  today,
  trackSlug,
  truthy,
  writeCsv,
  writeJson,
  writeText,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const cfg = readJson(args.config, {});
const opt = (name, def) => (args[name] !== undefined ? args[name] : cfg[name] !== undefined ? cfg[name] : def);

const track = String(opt('track', '')).trim();
const keywords = list(opt('keywords', ''));
const monthsN = num(opt('months', 6), 6);
const pagesN = num(opt('pages', 3), 3);
const minRead = num(opt('min-read', 1000), 1000);
const maxYuan = num(opt('max-yuan', 10), 10);
const nameTop = num(opt('name-top', 30), 30);
const gapMs = num(opt('gap-ms', 1500), 1500);
const maxRatioFlag = num(opt('signal-ratio', 3), 3);
const signalReadFloor = num(opt('signal-read', 10000), 10000);
const dry = truthy(opt('dry-run', false));
const confirmed = truthy(opt('yes', false)) || dry;

if (!track) {
  console.error('缺少 --track（赛道大类词）。先问用户：你想做的赛道大类词是什么？');
  process.exit(2);
}
if (!keywords.length) {
  console.error('缺少 --keywords。先按 references/keyword-playbook.md 给用户 5-10 个关键词并等他确认。');
  process.exit(2);
}

const outDir = ensureDir(String(opt('out', join(process.cwd(), 'gzh-bench', trackSlug(track)))));
const months = lastMonths(monthsN);
const plan = keywords.length * monthsN * pagesN;
const planYuan = plan * priceOf('artlist') + nameTop * priceOf('artinfo');

console.log('赛道：' + track);
console.log('关键词（' + keywords.length + '）：' + keywords.join(' / '));
console.log('时间窗：近 ' + monthsN + ' 个月（' + months[months.length - 1] + ' ~ ' + months[0] + '），单篇阅读下限 ' + minRead);
console.log('输出目录：' + outDir);
console.log('计划：artlist 最多 ' + plan + ' 次 + artinfo 最多 ' + nameTop + ' 次，预估 ¥' + planYuan.toFixed(2) + '（预算上限 ¥' + maxYuan.toFixed(2) + '）');

if (!confirmed) {
  console.log('\n未确认，未调用任何接口、未花费。');
  console.log('把上面的「接口 × 次数 × 预估金额」报给用户，拿到授权后再加 --yes 重跑。');
  process.exit(0);
}

const key = dry ? 'dry-run' : loadKey(opt('key'));
const budget = new Budget(maxYuan, 'find-accounts');
const failures = [];

// ---- 建池 ----
const poolMap = new Map();
if (dry) {
  for (const row of samplePool()) poolMap.set(row.sn, row);
  console.log('\n[dry-run] 使用内置样例池 ' + poolMap.size + ' 篇，不联网。');
} else {
  outer: for (const kw of keywords) {
    for (const month of months) {
      for (let page = 1; page <= pagesN; page++) {
        if (!budget.allow('artlist')) {
          console.log('预算到顶，停止关键词轮。');
          break outer;
        }
        let j;
        try {
          j = await call(
            'artlist',
            { month, keyword: kw, min_read_num: minRead, page },
            { key, budget, gapMs, note: kw + ':' + month + ':p' + page }
          );
        } catch (e) {
          if (e instanceof BudgetStop) {
            console.log(e.message);
            break outer;
          }
          throw e;
        }
        if (!j || j.code !== 0) {
          failures.push({ api: 'artlist', keyword: kw, month, page, code: j && j.code, msg: clean(j && j.msg) });
          break;
        }
        const rows = (j.data && j.data.list) || [];
        for (const it of rows) {
          const sn = snOf(it);
          if (!sn || poolMap.has(sn)) continue;
          poolMap.set(sn, {
            sn,
            title: clean(it.title),
            desc: clean(it.digest || it.desc || '').slice(0, 140),
            pub_time: it.pub_time || '',
            read_num: num(it.read_num, 0),
            like_num: num(it.like_num, 0),
            look_num: num(it.look_num, 0),
            share_num: num(it.share_num, 0),
            wx_biz: bizOf(it),
            wx_name: '',
            wx_type: it.wx_type || '',
            ip_region: it.ip_region || '',
            art_url: it.art_url || '',
            keyword: kw,
            month,
            src: 'artlist:' + kw + ':' + month,
          });
        }
        if (!(j.data && j.data.cursor)) break;
        await sleepMs(gapMs);
      }
      await sleepMs(gapMs);
    }
    console.log('关键词完成：' + kw + '｜池子累计 ' + poolMap.size + ' 篇');
  }
}

const pool = [...poolMap.values()];
if (!pool.length) {
  console.error('\n池子为空，没有可分析的候选账号。检查关键词、月份或 min-read。');
  saveBudget(outDir, budget, { stage: 'find-accounts', failures, pool: 0 });
  process.exit(1);
}

// ---- 按公众号聚合 ----
const byBiz = new Map();
for (const r of pool) {
  const b = r.wx_biz || r.art_url || ('unknown:' + r.sn);
  if (!byBiz.has(b)) byBiz.set(b, []);
  byBiz.get(b).push(r);
}

const accounts = [];
for (const [biz, arts] of byBiz) {
  const sorted = arts.slice().sort((a, b) => a.read_num - b.read_num);
  const reads = sorted.map((a) => a.read_num);
  const median = reads[Math.floor((reads.length - 1) / 2)] || 0;
  const max = reads[reads.length - 1] || 0;
  const ratio = median > 0 ? Number((max / median).toFixed(2)) : null;
  const top = sorted[sorted.length - 1];
  accounts.push({
    wx_biz: biz,
    wx_name: '',
    article_count: arts.length,
    read_median: median,
    read_max: max,
    ratio,
    last_pub: arts.map((a) => a.pub_time).filter(Boolean).sort().pop() || '',
    low_fan_signal: (ratio !== null && ratio >= maxRatioFlag && max >= signalReadFloor) || max >= 100000,
    sample_title: top.title,
    top_art_url: top.art_url,
    top_keyword: top.keyword,
  });
}

accounts.sort((a, b) => (b.ratio || 0) - (a.ratio || 0) || b.read_max - a.read_max);

// ---- 给前 N 个账号补名字（artinfo，按 biz 去重 + 本地缓存）----
const bizCachePath = join(outDir, 'biz2name.json');
const biz2name = readJson(bizCachePath, {});
const nameTargets = accounts.filter((a) => !biz2name[a.wx_biz]).slice(0, nameTop);
let named = 0;

if (dry) {
  for (const a of accounts) {
    const hit = pool.find((r) => (r.wx_biz || r.art_url) === a.wx_biz && r.wx_name);
    if (hit) biz2name[a.wx_biz] = { name: hit.wx_name, user_name: '', signature: '' };
  }
  console.log('[dry-run] 跳过 artinfo，直接用样例账号名。');
} else {
  console.log('\n补账号名：待补 ' + nameTargets.length + ' 个（缓存已有 ' + Object.keys(biz2name).length + ' 个）');
  for (const a of nameTargets) {
    if (!budget.allow('artinfo')) {
      console.log('artinfo 预算到顶，停止补名。');
      break;
    }
    const sample = pool.find((r) => (r.wx_biz || r.art_url) === a.wx_biz && r.art_url);
    if (!sample) continue;
    let j;
    try {
      j = await call('artinfo', { url: sample.art_url }, { key, budget, gapMs, note: 'name:' + a.wx_biz });
    } catch (e) {
      if (e instanceof BudgetStop) {
        console.log(e.message);
        break;
      }
      throw e;
    }
    if (j && j.code === 0 && j.data && j.data.name) {
      biz2name[a.wx_biz] = {
        name: clean(j.data.name),
        user_name: j.data.user_name || '',
        signature: clean(j.data.signature).slice(0, 80),
      };
      named++;
    } else {
      failures.push({ api: 'artinfo', biz: a.wx_biz, code: j && j.code, msg: clean(j && j.msg) });
    }
    if (named % 25 === 0 && named > 0) writeJson(bizCachePath, biz2name);
    await sleepMs(gapMs);
  }
}

writeJson(bizCachePath, biz2name);
for (const a of accounts) {
  const hit = biz2name[a.wx_biz];
  a.wx_name = (hit && hit.name) || '';
  a.signature = (hit && hit.signature) || '';
}

// ---- 落盘 ----
writeJson(join(outDir, 'pool.json'), pool);
writeJson(join(outDir, 'accounts.json'), accounts);
writeJson(join(outDir, 'config.json'), {
  track,
  keywords,
  months: monthsN,
  pages: pagesN,
  'min-read': minRead,
  'max-yuan': maxYuan,
  'name-top': nameTop,
  out: outDir,
});
writeCsv(
  join(outDir, 'accounts.csv'),
  ['对标账号名', 'wx_biz', '池内篇数', '阅读中位', '最高阅读', '爆款倍率', '最近更新', '低粉爆款信号', '代表作标题', '代表作链接', '关键词', '粉丝数', '备注'],
  accounts.map((a) => ({
    对标账号名: a.wx_name,
    wx_biz: a.wx_biz,
    池内篇数: a.article_count,
    阅读中位: a.read_median,
    最高阅读: a.read_max,
    爆款倍率: a.ratio === null ? '' : a.ratio,
    最近更新: String(a.last_pub).slice(0, 10),
    低粉爆款信号: a.low_fan_signal ? '是' : '',
    代表作标题: a.sample_title,
    代表作链接: a.top_art_url,
    关键词: a.top_keyword,
    粉丝数: '不可见',
    备注: a.wx_name ? '' : '账号名未补到，需人工核实',
  }))
);

const flagged = accounts.filter((a) => a.low_fan_signal);
const report = [
  '# 对标账号候选 · ' + track,
  '',
  '- 生成日期：' + today(),
  '- 关键词（' + keywords.length + '）：' + keywords.join(' / '),
  '- 时间窗：近 ' + monthsN + ' 个月｜单篇阅读下限：' + minRead,
  '- 池内文章：' + pool.length + ' 篇｜候选账号：' + accounts.length + ' 个｜低粉爆款信号：' + flagged.length + ' 个',
  '- 粉丝数：不可见（wxrank 不提供）',
  '',
  '## 候选账号（按爆款倍率排序）',
  '',
  '| # | 账号 | 池内篇数 | 阅读中位 | 最高阅读 | 爆款倍率 | 最近更新 | 低粉爆款 | 代表作 |',
  '|---|---|---|---|---|---|---|---|---|',
  ...accounts
    .slice(0, 40)
    .map(
      (a, i) =>
        '| ' + (i + 1) + ' | ' + (a.wx_name || '（未补到名）') + ' | ' + a.article_count + ' | ' + fmt(a.read_median) +
        ' | ' + fmt(a.read_max) + ' | ' + (a.ratio === null ? '-' : a.ratio) + ' | ' + String(a.last_pub).slice(0, 10) +
        ' | ' + (a.low_fan_signal ? '是' : '') + ' | ' + (a.sample_title || '').replace(/\|/g, '／') + ' |'
    ),
  '',
  '## 口径说明',
  '',
  '- 粉丝数拿不到，低粉爆款用「爆款倍率 = 最高阅读 ÷ 阅读中位」做代理指标，≥' + maxRatioFlag + ' 且最高阅读 ≥' + signalReadFloor + '，或最高阅读 ≥100000 记为信号。',
  '- artlist 只回流高于阅读下限的文章，所以「池内篇数」是被截断后的值，不等于该号发文量。',
  '- 账号名靠 artinfo 按 __biz 去重补齐，未补到的需人工核实。',
  '',
  '## 下一步',
  '',
  '1. 人工过一遍名单，剔掉不相关的号和明显大号。',
  '2. 跑 pick-articles.mjs 按规则选爆款文章，再跑 download.mjs 批量下载。',
];
writeJson(join(outDir, 'summary.json'), {
  track,
  pool: pool.length,
  accounts: accounts.length,
  low_fan_signals: flagged.length,
  named: accounts.filter((a) => a.wx_name).length,
  failures: failures.length,
});
writeJson(join(outDir, 'failures.json'), failures);
writeText(join(outDir, 'report-accounts.md'), report.join('\n') + '\n');
saveBudget(outDir, budget, { stage: 'find-accounts', pool: pool.length, accounts: accounts.length });

console.log('\n候选账号 ' + accounts.length + ' 个（低粉爆款信号 ' + flagged.length + ' 个），已写：');
console.log('  ' + join(outDir, 'accounts.csv'));
console.log('  ' + join(outDir, 'report-accounts.md'));
console.log('  ' + join(outDir, 'pool.json') + '（第 4 步复用）');
if (failures.length) console.log('失败 ' + failures.length + ' 条，见 failures.json');
