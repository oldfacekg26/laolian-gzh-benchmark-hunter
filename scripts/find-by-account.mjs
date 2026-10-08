// 「扒一个号」：给一个博主，把它的文章清单拉出来，供批量下载。
//
// 两条路，免费在默认位，付费按需开：
//
//   【免费路 · 默认】--url "<该号任意一篇文章链接>"
//     免费抓该文页面 → 拿 __biz / 号名 / 它所属的「合集」→ 翻合集页拿该合集全部文章（永久链）
//     --sogou 再加一层搜狗按号名补漏（召回低、是临时链，但能捞到合集外的文章）
//     局限：只有作者放进合集的文章才拿得到；号没开合集就基本拿不到（这正是付费路存在的理由）
//
//   【付费路 · 可选】--account "<号名>" --paid
//     --paid            用 artlist + wx_biz 从离线库按号筛文章，自带真实阅读量（¥0.01/次，50 条/页）
//     --paid --realtime 用 getps 按原始ID拉该号推文列表，能翻到更早，但没有阅读量（¥0.05/次）
//     --with-read       给清单里缺阅读量的文章逐篇补阅读量（getrk，¥0.02/篇）
//
//   node scripts/find-by-account.mjs --url "https://mp.weixin.qq.com/s?__biz=..." --out "<目录>"
//   node scripts/find-by-account.mjs --account "洞见" --paid --months 3 --yes
//   node scripts/find-by-account.mjs --url "https://mp.weixin.qq.com/s?__biz=..." --dry-run
//
// 付费调用前不带 --yes 只会打印「接口 × 次数 × 预估金额」，不花钱。
import { join } from 'node:path';
import {
  Budget,
  bizOf,
  call,
  clean,
  decodeEntities,
  ensureDir,
  fmt,
  lastMonths,
  loadKey,
  num,
  parseArgs,
  priceOf,
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

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SOGOU_REF = 'https://weixin.sogou.com/';

const args = parseArgs(process.argv.slice(2));
const opt = (n, d) => (args[n] !== undefined ? args[n] : d);

const urlArg = String(opt('url', '')).trim();
const bizArg = String(opt('biz', '')).trim();
const acctArg = String(opt('account', '')).trim();
const paid = truthy(opt('paid', false));
const realtime = truthy(opt('realtime', false));
const withRead = truthy(opt('with-read', false));
const useSogou = truthy(opt('sogou', false));
const monthsN = num(opt('months', 6), 6);
const pagesN = num(opt('pages', realtime ? 3 : 2), realtime ? 3 : 2);
const minRead = num(opt('min-read', 0), 0);
const maxYuan = num(opt('max-yuan', 10), 10);
const gapMs = num(opt('gap-ms', 1500), 1500);
const dry = truthy(opt('dry-run', false));
const confirmed = truthy(opt('yes', false)) || dry;

if (!urlArg && !bizArg && !acctArg) {
  console.error(
    '用法：node scripts/find-by-account.mjs （--url "<该号任意一篇>" | --account "<号名>" | --biz "<biz>"）\n' +
      '  免费路（默认）：给 --url 即可，靠该号的「合集」翻文章；--sogou 可加搜狗补漏\n' +
      '  付费路（要 Key）：--paid 按 biz 拉离线库（带阅读量）｜--paid --realtime 拉全量推文｜--with-read 补阅读量\n' +
      '  先不带 --yes 跑一次看预估花费，拿到授权再加 --yes。'
  );
  process.exit(2);
}

const label = acctArg || bizArg || '按链接扒号';
const outDir = ensureDir(String(opt('out', join(process.cwd(), 'gzh-bench', 'account-' + trackSlug(label)))));
const months = lastMonths(monthsN);
const needKey = paid || withRead;

// ---- 先报账：免费路明说 ¥0，付费路把接口 × 次数 × 预估金额摆出来 ----
const listCalls = realtime ? pagesN : monthsN * pagesN;
const listApi = realtime ? 'getps' : 'artlist';
const paidParts = [];
if (acctArg && !bizArg && !urlArg) paidParts.push('getsu 搜号 1 次（¥' + priceOf('getsu').toFixed(2) + '）');
if (paid) {
  paidParts.push(listApi + ' 最多 ' + listCalls + ' 次（¥' + priceOf(listApi).toFixed(2) + '/次）');
  if (realtime && !urlArg) paidParts.push('getinfo 兜底换原始ID 1 次（¥' + priceOf('getinfo').toFixed(2) + '）');
}
if (withRead) paidParts.push('getrk 按实际篇数补阅读量（¥' + priceOf('getrk').toFixed(2) + '/篇）');
const paidFloor =
  (acctArg && !bizArg && !urlArg ? priceOf('getsu') : 0) +
  (paid ? listCalls * priceOf(listApi) : 0) +
  (paid && realtime && !urlArg ? priceOf('getinfo') : 0);

console.log('目标账号：' + label);
console.log('枚举路线：' + (paid ? '付费（' + (realtime ? 'getps 实时推文列表，无阅读量' : 'artlist 离线库按 __biz 筛选，自带阅读量') + '）' : '免费（合集 + 可选搜狗补漏）'));
if (urlArg) console.log('  来源链接：' + urlArg);
console.log('参数：时间窗近 ' + monthsN + ' 个月（' + months[months.length - 1] + '~' + months[0] + '）｜翻页 ' + pagesN + '｜阅读下限 ' + minRead);
console.log('输出目录：' + outDir);
if (needKey) {
  console.log('付费项：' + paidParts.join(' + '));
  console.log('预估花费：¥' + paidFloor.toFixed(2) + ' 起（预算上限 ¥' + maxYuan.toFixed(2) + '，硬停）');
} else {
  console.log('付费项：无（这条路不花一分钱）');
}

if (!confirmed) {
  console.log('\n未确认，未调用任何付费接口、未花费。');
  console.log('把上面的「接口 × 次数 × 预估金额」报给用户，拿到授权后再加 --yes 重跑。');
  process.exit(0);
}

const key = needKey && !dry ? loadKey(opt('key')) : null;
const budget = new Budget(maxYuan, 'find-by-account');
const failures = [];

// ---------------- 工具 ----------------
const pageHeaders = (referer) => ({
  'User-Agent': UA,
  Referer: referer || 'https://mp.weixin.qq.com/',
  'Accept-Language': 'zh-CN,zh;q=0.9',
});

async function getText(url, referer) {
  const res = await fetch(url, { headers: pageHeaders(referer), redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
}

// 合集/文章链接里带 \x26amp; 转义，统一还原
const unescapeLink = (s) => String(s || '').replace(/\\x26amp;/g, '&').replace(/&amp;/g, '&');

// ---------------- 1. 定位账号（免费优先） ----------------
let wxBiz = bizArg;
let wxId = '';
let wxName = acctArg;
let albumIds = [];
const locateNotes = [];

if (dry) {
  wxBiz = wxBiz || 'DRYBIZ0';
  wxName = wxName || '样例账号';
  albumIds = ['1000000000000000001'];
  locateNotes.push('[dry-run] 不联网，用内置样例');
} else if (urlArg) {
  const html = await getText(urlArg);
  const rawBiz =
    (html.match(/var\s+biz\s*=\s*"([A-Za-z0-9+/=]{8,})"/) || [])[1] ||
    (html.match(/__biz=([A-Za-z0-9+/=]{8,})/) || [])[1] ||
    '';
  wxBiz = wxBiz || rawBiz;
  wxId = (html.match(/var\s+user_name\s*=\s*"([^"]+)"/) || [])[1] || '';
  wxName =
    wxName ||
    clean((html.match(/<a[^>]*id="js_name"[^>]*>([\s\S]*?)<\/a>/) || [])[1]) ||
    clean((html.match(/var\s+nickname\s*=\s*htmlDecode\("([^"]*)"\)/) || [])[1]) ||
    '';
  albumIds = [
    ...new Set(
      [...html.matchAll(/album_id['"]?\s*[:=]\s*['"]?(\d{10,25})/g)].map((m) => m[1])
    ),
  ];
  if (!wxBiz) {
    console.error('这条链接里没解析到 __biz，换一篇该号的文章，或用 --biz 直接指定。');
    process.exit(1);
  }
  locateNotes.push('免费抓页面（__biz=' + wxBiz + '｜原始ID=' + (wxId || '未取到') + '｜合集 ' + albumIds.length + ' 个）');
  console.log('\n已定位：' + (wxName || '（未识别号名）'));
  console.log('  ' + locateNotes.at(-1));
  if (!albumIds.length) {
    console.log('  ⚠ 这篇文章没挂合集 → 免费路没有可翻的合集，只能靠 --sogou 碰运气；想要完整清单用 --paid。');
  }
} else if (acctArg) {
  if (!needKey && !dry) {
    console.error('只知道号名的话，免费路没有入口（微信的历史消息页要登录、搜狗搜号已停用）。');
    console.error('两条出路：① 给我该号任意一篇文章的链接（--url，免费）；② 加 --paid 走付费接口搜号。');
    process.exit(2);
  }
  const j = await call('getsu', { keyword: acctArg }, { key, budget, note: 'locate:' + acctArg });
  const arr = (j && j.data) || [];
  if (!j || j.code !== 0 || !arr.length) {
    console.error('getsu 没搜到这个号：' + acctArg + '（code=' + (j && j.code) + ' ' + clean(j && j.msg) + '）');
    console.error('改用 --url "<该号任意一篇文章链接>" 定位更稳，还免费。');
    saveBudget(outDir, budget, { stage: 'find-by-account', failures });
    process.exit(1);
  }
  const exact = arr.find((x) => clean(x.wx_name) === acctArg);
  const hit = exact || arr[0];
  wxBiz = hit.wx_biz || '';
  wxId = hit.wx_user || '';
  wxName = clean(hit.wx_name) || acctArg;
  locateNotes.push('getsu 搜号（' + (exact ? '精确命中' : '取第一条') + '）');
  console.log('\n已定位：' + wxName + '（微信号 ' + (hit.wx_id || '-') + '｜原始ID ' + (wxId || '-') + '）');
}

// ---------------- 2. 枚举文章 ----------------
const pool = [];
const seen = new Set();
const addRow = (sn, fields) => {
  const k = sn || fields.art_url;
  if (!k || seen.has(k)) return;
  seen.add(k);
  pool.push({ sn: sn || '', ...fields });
};

if (dry) {
  for (let i = 1; i <= 3; i++) {
    addRow('dryacc' + i, {
      title: '【dry-run】样例文章 ' + i,
      pub_time: months[0].slice(0, 4) + '-' + months[0].slice(4) + '-' + String(7 + i).padStart(2, '0'),
      read_num: i === 2 ? 21000 : 1200 * i,
      like_num: 40 * i,
      look_num: 22 * i,
      share_num: i === 2 ? 5300 : 100 * i,
      art_url: 'https://mp.weixin.qq.com/s?__biz=DRYBIZ0&mid=' + i + '&idx=1&sn=dryacc' + i,
      src: 'dry-run',
    });
  }
} else {
  // ---- 免费：合集 ----
  for (const albumId of albumIds) {
    let beginMsgid = '';
    let beginItemidx = '';
    let got = 0;
    for (let p = 1; p <= Math.max(pagesN, 1) * 2; p++) {
      const api =
        'https://mp.weixin.qq.com/mp/appmsgalbum?action=getalbum&__biz=' +
        encodeURIComponent(wxBiz) +
        '&album_id=' +
        albumId +
        '&count=20&is_reverse=0&f=json' +
        (beginMsgid ? '&begin_msgid=' + beginMsgid + '&begin_itemidx=' + beginItemidx : '');
      let json = null;
      try {
        json = JSON.parse(await getText(api, urlArg || 'https://mp.weixin.qq.com/'));
      } catch (e) {
        failures.push({ api: 'appmsgalbum', album_id: albumId, page: p, msg: String((e && e.message) || e) });
        break;
      }
      const resp = (json && json.getalbum_resp) || {};
      const list = resp.article_list || [];
      const info = resp.base_info || {};
      wxName = wxName || clean(info.nickname);
      for (const it of list) {
        const u = unescapeLink(it.url || '');
        addRow(snOf({ art_url: u }), {
          title: clean(it.title),
          pub_time: it.create_time ? new Date(Number(it.create_time) * 1000).toISOString().slice(0, 10) : '',
          read_num: null,
          like_num: null,
          look_num: null,
          share_num: null,
          art_url: u,
          src: '合集《' + clean(info.title || '未命名') + '》p' + p,
        });
        got++;
      }
      console.log('合集《' + clean(info.title || albumId) + '》p' + p + '：' + list.length + ' 篇｜累计 ' + pool.length + ' 篇');
      if (String(resp.continue_flag) !== '1' || !list.length) break;
      const last = list[list.length - 1];
      beginMsgid = last.msgid;
      beginItemidx = last.itemidx;
      await sleepMs(800);
    }
    if (!got) failures.push({ api: 'appmsgalbum', album_id: albumId, msg: '合集翻页没拿到文章' });
  }

  // ---- 免费：搜狗按号名补漏 ----
  if (useSogou && wxName) {
    const jar = new Map();
    const cookieHeader = () => [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');
    const sogouGet = async (u, ref) => {
      const headers = pageHeaders(ref || SOGOU_REF);
      const c = cookieHeader();
      if (c) headers.Cookie = c;
      const res = await fetch(u, { headers, redirect: 'follow' });
      for (const x of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const pair = String(x).split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      return await res.text();
    };
    const strip = (s) => decodeEntities(String(s || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    try {
      await sogouGet(SOGOU_REF);
      const norm = (s) => String(s || '').replace(/[^0-9A-Za-z\u4e00-\u9fff]/g, '').toLowerCase();
      const target = norm(wxName);
      for (let page = 1; page <= Math.max(pagesN, 1); page++) {
        const html = await sogouGet(
          'https://weixin.sogou.com/weixin?type=2&query=' + encodeURIComponent(wxName) + '&ie=utf8&page=' + page
        );
        if (/验证码|antispider/.test(html)) {
          console.log('搜狗触发验证码，停止补漏（已有的结果保留）。');
          break;
        }
        let hit = 0;
        for (const block of html.split('<div class="txt-box">').slice(1)) {
          const link = (block.match(/href="(\/link\?url=[^"]+)"/) || [])[1];
          if (!link) continue;
          const acct = strip((block.match(/class="all-time-y2">([\s\S]*?)<\/span>/) || [])[1]);
          if (norm(acct) !== target) continue; // 严格按号名，宁少勿错
          const title = strip((block.match(/<h3>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1]);
          const ts = (block.match(/timeConvert\('(\d+)'\)/) || [])[1];
          let real = '';
          try {
            const hop = await sogouGet(
              'https://weixin.sogou.com' + link.replace(/&amp;/g, '&').replace(/\s/g, '%20'),
              'https://weixin.sogou.com/weixin?type=2&query=' + encodeURIComponent(wxName)
            );
            real = [...hop.matchAll(/url \+= '(.*?)'/g)].map((m) => m[1]).join('').replace(/@/g, '').replace(/&amp;/g, '&');
          } catch {
            real = '';
          }
          if (!/mp\.weixin\.qq\.com/.test(real)) continue;
          addRow('', {
            title,
            pub_time: ts ? new Date(Number(ts) * 1000).toISOString().slice(0, 10) : '',
            read_num: null,
            like_num: null,
            look_num: null,
            share_num: null,
            art_url: real,
            src: '搜狗补漏（临时链，尽快下载）',
            临时链: '是',
          });
          hit++;
          await sleepMs(Math.round(3000 + Math.random() * 3000));
        }
        console.log('搜狗补漏 p' + page + '：本号 ' + hit + ' 篇｜累计 ' + pool.length + ' 篇');
        await sleepMs(Math.round(3000 + Math.random() * 2000));
      }
    } catch (e) {
      console.log('搜狗补漏中断：' + String((e && e.message) || e));
      failures.push({ api: 'sogou', msg: String((e && e.message) || e) });
    }
  }

  // ---- 付费：artlist（离线库按 biz，自带阅读量）/ getps（实时全量）----
  if (paid && realtime) {
    if (!wxId) {
      const gi = await call('getinfo', { biz: wxBiz }, { key, budget, note: 'wxid:' + wxBiz });
      wxId = (gi && gi.data && (gi.data.user_name || gi.data.username)) || '';
      if (wxId) wxName = wxName || clean(gi.data.name);
      if (!wxId) {
        console.error('getinfo 没换到原始ID，实时路线走不通（code=' + (gi && gi.code) + ' ' + clean(gi && gi.msg) + '）。');
      } else {
        console.log('已用 getinfo 换到原始ID：' + wxId);
      }
    }
    if (wxId) {
      let cursor = '';
      for (let p = 1; p <= pagesN; p++) {
        if (!budget.allow('getps')) {
          console.log('getps 预算到顶，停止翻页。');
          break;
        }
        const j = await call('getps', { wxid: wxId, ...(cursor ? { cursor } : {}) }, { key, budget, gapMs, note: 'getps:p' + p });
        if (!j || j.code !== 0) {
          failures.push({ api: 'getps', page: p, code: j && j.code, msg: clean(j && j.msg) });
          console.log('getps 第 ' + p + ' 页失败：code=' + (j && j.code) + ' ' + clean(j && j.msg));
          break;
        }
        const rows = (j.data && j.data.list) || [];
        for (const it of rows) {
          const u = unescapeLink(it.art_url || '');
          addRow(snOf({ art_url: u }), {
            title: clean(it.title),
            pub_time: String(it.pub_time || '').slice(0, 10),
            read_num: null,
            like_num: null,
            look_num: null,
            share_num: null,
            art_url: u,
            src: 'getps:p' + p,
          });
        }
        console.log('getps 第 ' + p + ' 页：' + rows.length + ' 篇｜累计 ' + pool.length + ' 篇');
        cursor = (j.data && j.data.cursor) || '';
        if (!cursor) {
          console.log('已到该号最早一页（cursor 为空），停止翻页。');
          break;
        }
        await sleepMs(gapMs);
      }
    }
  } else if (paid) {
    outer: for (const month of months) {
      let cursor = '';
      for (let p = 1; p <= pagesN; p++) {
        if (!budget.allow('artlist')) {
          console.log('artlist 预算到顶，停止轮月份。');
          break outer;
        }
        const body = { month, wx_biz: wxBiz, min_read_num: minRead, page: p };
        if (cursor) body.cursor = cursor;
        const j = await call('artlist', body, { key, budget, gapMs, note: 'biz:' + month + ':p' + p });
        if (!j || j.code !== 0) {
          failures.push({ api: 'artlist', month, page: p, code: j && j.code, msg: clean(j && j.msg) });
          break;
        }
        const rows = (j.data && j.data.list) || [];
        for (const it of rows) {
          if (wxBiz && bizOf(it) && bizOf(it) !== wxBiz) continue; // 二次确认归属
          const u = unescapeLink(it.art_url || '');
          addRow(snOf({ art_url: u }), {
            title: clean(it.title),
            desc: clean(it.digest || it.desc || '').slice(0, 140),
            pub_time: String(it.pub_time || '').slice(0, 10),
            read_num: num(it.read_num, 0),
            like_num: num(it.like_num, 0),
            look_num: num(it.look_num, 0),
            share_num: num(it.share_num, 0),
            art_url: u,
            src: 'artlist:' + month + ':p' + p,
          });
        }
        console.log('artlist ' + month + ' p' + p + '：' + rows.length + ' 篇｜累计 ' + pool.length + ' 篇');
        cursor = (j.data && j.data.cursor) || '';
        if (!cursor) break;
        await sleepMs(gapMs);
      }
      await sleepMs(gapMs);
    }
  }
}

if (!pool.length) {
  console.error(
    '\n没拿到任何文章。\n' +
      '  免费路：这篇文章所属合集可能为空，或该号没开合集 → 加 --sogou 碰运气，或改用 --paid。\n' +
      '  付费路：这个号可能不在离线库里（加 --realtime），或时间窗太窄（加 --months），或阅读下限太高（--min-read 0）。'
  );
  saveBudget(outDir, budget, { stage: 'find-by-account', failures, pool: 0 });
  process.exit(1);
}

// ---------------- 3. 可选：补阅读量（付费 getrk） ----------------
if (withRead && !dry) {
  const targets = pool.filter((r) => r.read_num === null || r.read_num === undefined);
  console.log('\n补阅读量：待补 ' + targets.length + ' 篇（¥' + priceOf('getrk').toFixed(2) + '/篇）');
  let done = 0;
  for (const r of targets) {
    if (!budget.allow('getrk')) {
      console.log('getrk 预算到顶，停止补阅读量。');
      break;
    }
    const j = await call('getrk', { url: r.art_url }, { key, budget, gapMs, note: 'read:' + (r.sn || r.art_url) });
    if (j && j.code === 0 && j.data) {
      r.read_num = num(j.data.read_num, 0);
      r.like_num = num(j.data.like_num, 0);
      r.look_num = num(j.data.look_num, 0);
      r.share_num = num(j.data.share_num, 0);
      r.collect_num = num(j.data.collect_num, 0);
      r.read_state = '接口读取（getrk 实时）';
      done++;
    } else {
      r.read_state = '补阅读量失败（code=' + (j && j.code) + '）';
      failures.push({ api: 'getrk', sn: r.sn, code: j && j.code, msg: clean(j && j.msg) });
    }
    if (done % 20 === 0 && done) writeJson(join(outDir, 'account-articles.json'), pool);
    await sleepMs(gapMs);
  }
  console.log('补到阅读量：' + done + '/' + targets.length);
}

// ---------------- 4. 该号自身的爆款倍率 + 落盘 ----------------
const reads = pool.filter((r) => Number(r.read_num) > 0).map((r) => Number(r.read_num)).sort((a, b) => a - b);
const median = reads.length ? reads[Math.floor((reads.length - 1) / 2)] : 0;
const max = reads.length ? reads[reads.length - 1] : 0;
const ratio = median > 0 ? Number((max / median).toFixed(2)) : null;

const sorted = pool
  .slice()
  .sort((a, b) => String(b.pub_time).localeCompare(String(a.pub_time)) || Number(b.read_num || 0) - Number(a.read_num || 0));

const rows = sorted.map((r, i) => ({
  序号: i + 1,
  标题: r.title,
  账号: wxName || label,
  阅读量: r.read_num === null || r.read_num === undefined ? '' : r.read_num,
  点赞: r.like_num ?? '',
  在看: r.look_num ?? '',
  转发: r.share_num ?? '',
  爆款分: (Number(r.read_num) || 0) + (Number(r.share_num) || 0) * 3 || '',
  账号爆款倍率: ratio === null ? '' : ratio,
  低粉爆款信号: ratio !== null && ratio >= 3 && max >= 10000 ? '是（该号自身最高/中位）' : '',
  发布日期: String(r.pub_time).slice(0, 10),
  关键词: '',
  原文链接: r.art_url,
  阅读量核实状态:
    r.read_num === null || r.read_num === undefined
      ? '不可见（这条路不含阅读量，可用 --with-read 补）'
      : r.read_state || '接口读取（artlist）',
  sn: r.sn,
  wx_biz: wxBiz,
  数据来源: r.src,
}));

writeJson(join(outDir, 'account-articles.json'), rows);
writeCsv(
  join(outDir, 'account-articles.csv'),
  ['序号', '标题', '账号', '发布日期', '阅读量', '点赞', '在看', '转发', '原文链接', '数据来源', '阅读量核实状态'],
  rows
);
writeJson(join(outDir, 'failures.json'), failures);

const routeText = paid
  ? realtime
    ? '付费 · getps 实时推文列表（无阅读量）'
    : '付费 · artlist 离线库按 __biz 筛选（自带阅读量）'
  : '免费 · 合集翻页' + (useSogou ? ' + 搜狗补漏' : '');

const report = [
  '# 扒一个号 · ' + (wxName || label) + '（' + today() + '）',
  '',
  '- 枚举路线：' + routeText,
  '- 定位：' + (locateNotes.join('；') || '—'),
  '- wx_biz：' + (wxBiz || '未知') + '｜原始ID：' + (wxId || '未知') + '｜合集：' + (albumIds.join(', ') || '无'),
  '- 时间窗：近 ' + monthsN + ' 个月｜文章数：' + rows.length,
  '- 该号自身：最高阅读 ' + fmt(max) + '｜阅读中位 ' + fmt(median) + '｜爆款倍率 ' + (ratio === null ? '不可算（无阅读量）' : ratio),
  '- 粉丝数：不可见（wxrank 不提供）',
  '',
  '## 文章清单（按发布时间倒序）',
  '',
  '| # | 日期 | 阅读 | 转发 | 标题 |',
  '|---|---|---|---|---|',
  ...rows
    .slice(0, 60)
    .map((r) => '| ' + r.序号 + ' | ' + r.发布日期 + ' | ' + fmt(r.阅读量) + ' | ' + fmt(r.转发) + ' | ' + String(r.标题).replace(/\|/g, '／') + ' |'),
  '',
  '## 口径说明',
  '',
  '- **粉丝数不可见**：wxrank 不返回粉丝数，低粉爆款一律用「爆款倍率 = 最高阅读 ÷ 阅读中位」做代理。',
  paid
    ? '- 付费路按 __biz 从离线库/推文接口取，覆盖度取决于该号是否在库里。'
    : '- **免费路的边界**：只能翻到「该号的合集」里收录的文章（合集是作者自己编的），**不等于该号全部文章**。想要完整清单必须走 `--paid`。',
  useSogou ? '- 搜狗补漏的链接是**临时链**，解析完要尽快下载，隔天多半失效。' : '',
  withRead ? '- 阅读量由 getrk 实时取（¥' + priceOf('getrk').toFixed(2) + '/篇），补不到的写「不可见」，不估。' : '- 这条路的阅读量「不可见」不代表没人看，只是没走付费接口。',
  '',
  '## 下一步',
  '',
  '1. 人工过一遍这份清单（卡点），剔掉不要的。',
  '2. 批量下载正文 + 配图（免费）：',
  '',
  '```',
  'node "<SKILL目录>\\scripts\\download.mjs" --out "' + outDir + '" --from "' + join(outDir, 'account-articles.json') + '"',
  '```',
  '',
].filter(Boolean);

writeText(join(outDir, 'report-account.md'), report.join('\n') + '\n');
writeJson(join(outDir, 'summary.json'), {
  account: wxName || label,
  wx_biz: wxBiz,
  wx_id: wxId,
  albums: albumIds,
  route: routeText,
  articles: rows.length,
  with_read: rows.filter((r) => r.阅读量 !== '').length,
  ratio,
  failures: failures.length,
});
saveBudget(outDir, budget, { stage: 'find-by-account', articles: rows.length });

console.log('\n扒号完成：' + (wxName || label) + '｜文章 ' + rows.length + ' 篇（有阅读量 ' + rows.filter((r) => r.阅读量 !== '').length + ' 篇）');
console.log('  ' + join(outDir, 'account-articles.csv'));
console.log('  ' + join(outDir, 'report-account.md'));
console.log('下一步：把 report-account.md 给用户过目（人工卡点），确认后跑：');
console.log('  node scripts/download.mjs --out "' + outDir + '" --from "' + join(outDir, 'account-articles.json') + '"');
if (failures.length) console.log('失败 ' + failures.length + ' 条，见 failures.json');
