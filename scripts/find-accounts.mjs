// 先发现高阅读文章，再按账号查询无阅读下限的普通文章建立基线。
import { join } from 'node:path';
import {
  Budget, BudgetStop, bizOf, buildMustRegex, call, clean, ensureDir, fmt, lastMonths,
  list, loadKey, parseArgs, priceOf, readJson, samplePool, saveBudget, sleepMs, snOf,
  today, trackSlug, truthy, writeCsv, writeJson, writeText,
} from './lib.mjs';
import { articleKey, articleSignal, baselineWindow, baselineRows, readingStats, readValue } from './reading-stats.mjs';

const args = parseArgs(process.argv.slice(2));
const cfg = readJson(args.config, {});
const opt = (name, def) => args[name] !== undefined ? args[name] : cfg[name] !== undefined ? cfg[name] : def;
const numberOpt = (name, def, min = 0) => {
  const n = Number(opt(name, def));
  if (!Number.isFinite(n) || n < min) throw new Error('无效参数 --' + name);
  return n;
};
const track = String(opt('track', '')).trim();
const keywords = list(opt('keywords', ''));
if (!track || !keywords.length) throw new Error('需要 --track 和已确认的 --keywords');
const monthsN = Math.floor(numberOpt('months', 6, 1));
const pagesN = Math.floor(numberOpt('pages', 3, 1));
const minRead = numberOpt('min-read', 10000);
const maxRead = numberOpt('max-read', 0);
const maxYuan = numberOpt('max-yuan', 15);
const nameTop = Math.floor(numberOpt('name-top', 30));
const verifyTop = Math.floor(numberOpt('verify-top', 80));
const baselineDays = Math.floor(numberOpt('baseline-days', 30, 1));
const baselinePages = Math.floor(numberOpt('baseline-pages', 3, 1));
const medianMax = numberOpt('baseline-median-max', 1000);
const minSamples = Math.floor(numberOpt('baseline-min-samples', 10, 1));
const signalRatio = numberOpt('signal-ratio', 10);
const signalRead = numberOpt('signal-read', 10000);
const targetAccounts = Math.floor(numberOpt('target-accounts', 0));
const gapMs = numberOpt('gap-ms', 1500);
const dry = truthy(opt('dry-run', false));
const resume = truthy(opt('resume', false));
const confirmed = truthy(opt('yes', false)) || dry;
const mustWords = list(opt('must', ''));
const must = buildMustRegex(mustWords);
const preferred = buildMustRegex(list(opt('prefer-words', '')));
const excluded = new Set(list(opt('exclude-account', '')));
const outDir = ensureDir(String(opt('out', join(process.cwd(), 'gzh-bench', trackSlug(track)))));
const months = lastMonths(monthsN);
const searchPlan = keywords.length * monthsN * pagesN;
// 30 天窗口至多跨三个自然月（如 2 月很短），按更保守上限展示。
const baselineMonths = Math.ceil(baselineDays / 28) + 1;
const estimate = searchPlan * priceOf('artlist') + verifyTop * baselineMonths * baselinePages * priceOf('artlist') + (verifyTop + nameTop) * priceOf('artinfo');
console.log('赛道：' + track + '\n关键词：' + keywords.join(' / '));
console.log('发现：阅读 ≥' + minRead + (maxRead ? ' 且 ≤' + maxRead : '') + '；核查：按号查询，阅读下限为 0，无关键词');
console.log('基线：同类型首条，爆款发布日期及之前 ' + baselineDays + ' 天；有效样本 ≥' + minSamples + '，中位数 <' + medianMax + '，单篇 ≥' + signalRead + ' 且倍率 ≥' + signalRatio);
console.log('调用计划上限：搜索 artlist ' + searchPlan + ' 次；基线 artlist ' + (verifyTop * baselineMonths * baselinePages) + ' 次；artinfo ' + (verifyTop + nameTop) + ' 次；理论估算 ¥' + estimate.toFixed(2) + '，硬上限 ¥' + maxYuan.toFixed(2));
if (!confirmed) { console.log('未确认，未调用付费接口。'); process.exit(0); }
const key = dry ? '' : loadKey();
const budget = new Budget(maxYuan, 'find-accounts');
const previousBudget = resume ? readJson(join(outDir, 'budget.json'), null) : null;
if (previousBudget) {
  budget.spent = previousBudget.spent;
  budget.calls = previousBudget.calls || {};
  budget.ledger = previousBudget.ledger || [];
} else {
  budget.spent = numberOpt('spent-before', 0);
  if (budget.spent) budget.ledger.push({api:'prior-task',yuan:budget.spent,note:'本轮之前已支出，计入累计上限'});
}
if (budget.spent > maxYuan) throw new Error('既有支出已经超过本轮预算');
const failures = resume ? readJson(join(outDir, 'failures.json'), []) : [];
const searchCache = resume ? readJson(join(outDir, 'search-cache.json'), {}) : {};
const accountCache = readJson(join(outDir, 'account-cache.json'), {});
const names = readJson(join(outDir, 'biz2name.json'), {});
const poolMap = new Map();
for (const row of (resume ? readJson(join(outDir, 'pool.json'), []) : [])) {
  const id = articleKey(row); if (id) poolMap.set(id, row);
}
const accounts = [];
const normalize = (it, keyword = '', src = '') => ({
  sn: snOf(it), title: clean(it.title), desc: clean(it.digest || it.desc || ''),
  pub_time: String(it.pub_time || ''), read_num: readValue(it.read_num),
  like_num: readValue(it.like_num), look_num: readValue(it.look_num), share_num: readValue(it.share_num),
  wx_biz: bizOf(it), wx_name: clean(it.wx_name || ''), art_url: clean(it.art_url || ''), keyword, src,
  content_type: String(it.content_type || ''), word_num: readValue(it.word_num), data_update_time: String(it.data_update_time || ''),
});
function checkpoint() {
  writeJson(join(outDir, 'pool.json'), [...poolMap.values()]);
  writeJson(join(outDir, 'accounts.json'), accounts);
  writeJson(join(outDir, 'search-cache.json'), searchCache);
  writeJson(join(outDir, 'account-cache.json'), accountCache);
  writeJson(join(outDir, 'biz2name.json'), names);
  writeJson(join(outDir, 'failures.json'), failures);
  writeJson(join(outDir, 'budget.json'), {cap:budget.cap,spent:budget.spent,calls:budget.calls,ledger:budget.ledger});
}
async function request(api, body, note) {
  const j = await call(api, body, {key,budget,tries:1,note});
  if (j?.code !== 0) failures.push({api, note, code:j?.code});
  checkpoint();
  await sleepMs(gapMs);
  return j;
}
let stopped = false;
try {
  if (dry) {
    for (const row of samplePool()) poolMap.set(articleKey(row), row);
  } else {
    for (const keyword of keywords) {
      for (const month of months) {
        const cacheKey = keyword + ':' + month;
        if (searchCache[cacheKey]?.done) continue;
        let cursor = '';
        for (let page = 1; page <= pagesN; page++) {
          const j = await request('artlist', {month,keyword,min_read_num:minRead,...(maxRead?{max_read_num:maxRead}:{}),...(cursor?{cursor}:{})}, 'search:' + cacheKey + ':p' + page);
          if (j?.code !== 0) break;
          const rows = j.data?.list || [];
          for (const it of rows) {
            const row = normalize(it, keyword, 'keyword:' + month);
            const id = articleKey(row); if (id) poolMap.set(id, row);
          }
          cursor = j.data?.cursor || '';
          searchCache[cacheKey] = {done:page === pagesN || !cursor || !rows.length,pages:page,truncated:page === pagesN && !!cursor && rows.length > 0};
          checkpoint();
          if (!cursor || !rows.length) break;
        }
      }
      console.log('关键词完成：' + keyword + '｜去重池 ' + poolMap.size);
    }
  }
} catch (e) { if (!(e instanceof BudgetStop)) throw e; stopped = true; console.log(e.message); }
const byBiz = new Map();
for (const row of poolMap.values()) {
  if (!row.wx_biz || readValue(row.read_num) < signalRead || row.read_num === null) continue;
  if (must && !must.test(row.title + ' ' + row.desc)) continue;
  if (excluded.has(row.wx_biz) || excluded.has(row.wx_name)) continue;
  if (!byBiz.has(row.wx_biz)) byBiz.set(row.wx_biz, []);
  byBiz.get(row.wx_biz).push(row);
}
const relevance = row => preferred?.test(row.title) ? 1 : 0;
const candidates = [...byBiz].map(([biz, rows]) => {
  rows.sort((a,b) => String(b.pub_time).localeCompare(String(a.pub_time)) || relevance(b)-relevance(a) || b.read_num-a.read_num);
  return {biz,rows,anchor:rows[0]};
}).sort((a,b) => relevance(b.anchor)-relevance(a.anchor) || a.anchor.read_num-b.anchor.read_num);
try {
  for (const {biz, rows, anchor} of candidates.slice(0, verifyTop)) {
    if (stopped) break;
    const window = baselineWindow(anchor.pub_time, baselineDays);
    if (!window) { failures.push({api:'baseline',note:biz,code:'INVALID_DATE'}); continue; }
    const baselineMap = new Map();
    let truncated = false;
    if (dry) {
      for (let i = 0; i < 12; i++) {
        const row = {...anchor,content_type:anchor.content_type||'article',art_url:'https://mp.weixin.qq.com/s?idx=1&sn='+anchor.sn+'normal'+i,sn:anchor.sn+'normal'+i,pub_time:window.start,read_num:biz==='DRYBIZ4'||biz==='DRYBIZ5'?80+i*10:5000+i*100};
        baselineMap.set(articleKey(row), row);
      }
      anchor.content_type ||= 'article';
      anchor.art_url += '&idx=1';
      baselineMap.set(articleKey(anchor), anchor);
      names[biz] = {name:anchor.wx_name};
    } else {
      for (const month of window.months) {
        const cacheKey = biz + ':' + month;
        let cached = accountCache[cacheKey];
        if (!cached || cached.pages < baselinePages && cached.truncated || anchor.content_type && cached.rows.some(r => !r.content_type)) {
          const monthRows = new Map(); let cursor = ''; let pages = 0; let more = false; let failed = false;
          for (let page = 1; page <= baselinePages; page++) {
            const j = await request('artlist', {month,wx_biz:biz,min_read_num:0,...(cursor?{cursor}:{})}, 'baseline:'+cacheKey+':p'+page);
            if (j?.code !== 0) {failed = true; break;}
            const items = j.data?.list || []; pages = page;
            for (const it of items) {
              const row = normalize(it, '', 'account:' + month);
              if (row.wx_biz !== biz) continue;
              const id = articleKey(row); if (id) monthRows.set(id,row);
            }
            cursor = j.data?.cursor || ''; more = !!cursor && items.length > 0;
            if (!more) break;
          }
          cached = {rows:[...monthRows.values()],pages,truncated:more,failed};
          accountCache[cacheKey] = cached; checkpoint();
        }
        truncated ||= cached.truncated || cached.failed;
        for (const row of cached.rows) {
          const pub = String(row.pub_time).slice(0,10);
          if (pub >= window.start && pub <= window.end) baselineMap.set(articleKey(row),row);
        }
      }
    }
    // 发现池只提供候选，不能往基线补入“只搜到的高阅读文章”。
    const baseline = baselineRows([...baselineMap.values()], anchor.content_type, window);
    const stats = readingStats(baseline);
    const account = {
      wx_biz:biz,wx_name:names[biz]?.name||anchor.wx_name||'',article_count:rows.length,
      baseline_content_type:anchor.content_type || '',baseline_position:1,
      baseline_verified:stats.known >= minSamples && (!!anchor.content_type || dry),baseline_total:stats.total,baseline_known:stats.known,baseline_missing:stats.missing,
      baseline_start:window.start,baseline_end:window.end,baseline_date_min:stats.date_min,baseline_date_max:stats.date_max,
      baseline_truncated:truncated,read_mean:stats.mean,read_median:stats.median,read_max:stats.max,
      ratio:stats.median>0?Math.round(stats.max/stats.median*100)/100:null,
      last_pub:stats.date_max||'',censored:stats.censored,low_fan_signal:false,
      sample_title:anchor.title,top_art_url:anchor.art_url,top_keyword:anchor.keyword,
    };
    const related = [...new Map([...rows,...[...baselineMap.values()].filter(r=>!must||must.test(r.title+' '+r.desc))].map(r=>[articleKey(r),r])).values()];
    const verifiedArticles = related.filter(row => articleSignal(row,account,{medianMax,minSamples,minRead:signalRead,minRatio:signalRatio}).low).sort((a,b)=>b.read_num-a.read_num);
    account.low_fan_signal = verifiedArticles.length>0;
    account.verified_article_count = verifiedArticles.length;
    if (verifiedArticles.length) {
      const best = verifiedArticles[0]; account.sample_title=best.title;account.top_art_url=best.art_url;
      account.signal_ratio=articleSignal(best,account,{medianMax,minSamples,minRead:signalRead,minRatio:signalRatio}).ratio;
      for (const row of verifiedArticles) poolMap.set(articleKey(row),row);
    }
    if (!dry && account.low_fan_signal && !account.wx_name) {
      const j = await request('artinfo',{url:account.top_art_url},'name:'+biz);
      if (j?.code===0 && j.data?.name) {
        names[biz]={name:clean(j.data.name),user_name:j.data.user_name||'',signature:clean(j.data.signature||'')};
        account.wx_name=names[biz].name;
      }
    }
    if (excluded.has(account.wx_name)) continue;
    accounts.push(account); checkpoint();
    console.log((account.wx_name||biz)+'｜样本 '+stats.known+'｜中位 '+fmt(stats.median)+'｜相关爆款 '+verifiedArticles.length+'｜'+(account.low_fan_signal?'低日常阅读信号':'未符合/不足'));
    if (targetAccounts && accounts.filter(a=>a.low_fan_signal&&a.wx_name).length >= targetAccounts) break;
  }
} catch(e) { if (!(e instanceof BudgetStop)) throw e; stopped = true; console.log(e.message); }
accounts.sort((a,b)=>Number(b.low_fan_signal)-Number(a.low_fan_signal)||(b.signal_ratio||0)-(a.signal_ratio||0));
const flagged = accounts.filter(a=>a.low_fan_signal);
checkpoint();
writeJson(join(outDir,'config.json'),{track,keywords,must:mustWords,months:monthsN,pages:pagesN,'min-read':minRead,'max-yuan':maxYuan,'baseline-median-max':medianMax,'baseline-min-samples':minSamples,'signal-read':signalRead,'signal-ratio':signalRatio,'baseline-days':baselineDays,out:outDir});
writeCsv(join(outDir,'accounts.csv'),['账号','wx_biz','样本篇数','有效阅读篇数','缺失篇数','样本均读','阅读中位数','样本最高阅读','账号倍率','代表作倍率','低日常阅读爆款','基线起日','基线止日','分页截断','内容类型','基线位置','代表作','原文链接','粉丝数'],accounts.map(a=>({
  账号:a.wx_name,wx_biz:a.wx_biz,样本篇数:a.baseline_total,有效阅读篇数:a.baseline_known,缺失篇数:a.baseline_missing,样本均读:a.read_mean,阅读中位数:a.read_median,样本最高阅读:a.read_max,账号倍率:a.ratio,代表作倍率:a.signal_ratio,低日常阅读爆款:a.low_fan_signal?'是':'',基线起日:a.baseline_start,基线止日:a.baseline_end,分页截断:a.baseline_truncated?'是':'',内容类型:a.baseline_content_type,基线位置:'首条',代表作:a.sample_title,原文链接:a.top_art_url,粉丝数:'不可见',
})));
const report=['# 对标账号候选 · '+track,'','- 日期：'+today(),'','- 候选账号已核查 '+accounts.length+' 个；低日常阅读爆款信号 '+flagged.length+' 个。粉丝数不可见。','- 基线按账号查询，取消关键词和阅读门槛，只取与候选爆款同一 content_type 的首条（idx=1）；取该号最新相关过万内容发布日及之前 '+baselineDays+' 天。','- 中位数 <'+medianMax+'，有效样本 ≥'+minSamples+'，单篇 ≥'+signalRead+' 且倍率 ≥'+signalRatio+'；十万阅读不会自动判低粉。','',
'| 账号 | 样本数 | 样本均读 | 中位数 | 相关爆款倍率 | 信号 | 基线日期 | 代表作 |',
'|---|---:|---:|---:|---:|---|---|---|',
...accounts.map(a=>'| '+(a.wx_name||a.wx_biz)+' | '+a.baseline_known+' | '+fmt(a.read_mean)+' | '+fmt(a.read_median)+' | '+fmt(a.signal_ratio)+' | '+(a.low_fan_signal?'是':'待核实/未符合')+' | '+a.baseline_start+'—'+a.baseline_end+' | ['+a.sample_title.replace(/\|/g,'／')+']('+a.top_art_url+') |'),'',
'- 这些是库中样本，不是已经证明完整的账号月均；缺失不补零，真实零阅读计入。分页截断见 accounts.csv。','- 历史爆款使用当时窗口；实时峰值不能与旧中位数混算精确新倍率。10万＋为下界，不能推算真实值。','- 已有本轮关键词、账号数和文章数授权时按授权继续出清单；下载正文仍等用户明确确认。'];
writeText(join(outDir,'report-accounts.md'),report.join('\n')+'\n');
writeJson(join(outDir,'summary.json'),{track,pool:poolMap.size,accounts:accounts.length,low_fan_signals:flagged.length,named:flagged.filter(a=>a.wx_name).length,failures:failures.length,budget_stopped:stopped});
saveBudget(outDir,budget,{stage:'find-accounts',pool:poolMap.size,accounts:accounts.length});
console.log('已写账号报告：'+join(outDir,'report-accounts.md'));
