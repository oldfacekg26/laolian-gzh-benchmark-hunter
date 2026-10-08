// 可选补充入口：用搜狗微信搜索按关键词找文章。
//
// 默认关闭，只在用户明确要求时用。三条硬边界（实测）：
//   1) 搜狗不返回阅读量 → 找出来的是「文章」，不是「爆款」，阅读量一栏一律写「不可见」。
//   2) 跳转链带一次性签名，必须同会话当场解析；批量跑容易被弹验证码。
//   3) 结果里混有大量其他号的转载 → 必须按账号名过滤（--account）。
//
//   node scripts/sogou-find.mjs --out "<输出目录>" --keywords "读书,认知" --account "洞见"
//   node scripts/sogou-find.mjs --out "<输出目录>" --keywords "读书" --dry-run
import { join } from 'node:path';
import {
  bizOf,
  clean,
  decodeEntities,
  ensureDir,
  list,
  num,
  parseArgs,
  readJson,
  safeName,
  sleepMs,
  snOf,
  today,
  truthy,
  writeCsv,
  writeJson,
  writeText,
} from './lib.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SEARCH_REF = 'https://weixin.sogou.com/';

const args = parseArgs(process.argv.slice(2));
const outDir = String(args.out || '').trim();
const keywords = list(args.keywords || '');
const dry = truthy(args['dry-run']);

if (!outDir || (!keywords.length && !dry)) {
  console.error('用法：node scripts/sogou-find.mjs --out "<输出目录>" --keywords "词1,词2" [--account "号名"]');
  process.exit(2);
}

const pagesN = num(args.pages, 2);
const gapMs = num(args['gap-ms'], 5000);
const permanentize = String(args['permanent'] === undefined ? 'true' : args['permanent']) !== 'false';
const accountFilter = list(args.account || '').map((s) => s.replace(/[^0-9A-Za-z\u4e00-\u9fff]/g, '').toLowerCase());

const ensureDirAbs = ensureDir(outDir);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

// 搜狗的跳转签名要同会话解析，必须带着 cookie 走完整流程
const jar = new Map();
function storeCookies(res) {
  let list = [];
  try {
    list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  } catch {
    list = [];
  }
  for (const c of list) {
    const pair = String(c).split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = () => [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');

async function get(url, referer) {
  const headers = {
    'User-Agent': UA,
    Referer: referer || SEARCH_REF,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  const ck = cookieHeader();
  if (ck) headers.Cookie = ck;
  const res = await fetch(url, { headers, redirect: 'follow' });
  storeCookies(res);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
}

function stripHighlight(s) {
  return decodeEntities(
    String(s || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSearchPage(html) {
  const out = [];
  const seen = new Set();
  for (const block of html.split('<div class="txt-box">').slice(1)) {
    const link = (block.match(/href="(\/link\?url=[^"]+)"/) || [])[1];
    if (!link) continue;
    const base = link.split('&amp;')[0];
    if (seen.has(base)) continue;
    seen.add(base);

    const title = stripHighlight((block.match(/<h3>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1]);
    const account = stripHighlight((block.match(/class="all-time-y2">([\s\S]*?)<\/span>/) || [])[1]);
    const abstract = stripHighlight((block.match(/<p class="txt-info[^"]*"[^>]*>([\s\S]*?)<\/p>/) || [])[1]);
    const ts = (block.match(/timeConvert\('(\d+)'\)/) || [])[1];
    out.push({
      link,
      base,
      title,
      account,
      abstract,
      pub_time: ts ? new Date(Number(ts) * 1000).toISOString().slice(0, 10) : '',
    });
  }
  return out;
}

// 还原一次性跳转链 → 永久 mp.weixin 链接
async function resolveLink(item, searchUrl) {
  const raw = item.link.replace(/&amp;/g, '&').replace(/\s/g, '%20');
  const html = await get('https://weixin.sogou.com' + raw, searchUrl);
  const parts = [...html.matchAll(/url \+= '(.*?)'/g)].map((m) => m[1]);
  if (!parts.length) return '';
  return parts
    .join('')
    .replace(/@/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

// 搜狗给的是 src=3&timestamp=...&signature=... 的临时链，会过期。
// 抓一次页面，用页面里的 __biz/mid/idx/sn 拼出永久链，下载才不会失效。
async function toPermanent(url) {
  try {
    // 临时链必须带搜狗来源，否则微信会返回「环境异常」空壳页
    const html = await get(url, SEARCH_REF);
    const biz =
      (html.match(/var __biz\s*=\s*"([^"]+)"/) ||
        html.match(/var\s+biz\s*=\s*"(Mz[A-Za-z0-9+/=]{8,40})"/) ||
        html.match(/__biz=(Mz[A-Za-z0-9+/=]{8,40})/) ||
        [])[1] || '';
    const mid = (html.match(/var\s+mid\s*=\s*"?([0-9]{5,})"?/) || [])[1] || '';
    const idx = (html.match(/var\s+idx\s*=\s*"?([0-9]+)"?/) || [])[1] || '1';
    const sn = (html.match(/var\s+sn\s*=\s*"([0-9a-fA-F]{8,})"/) || [])[1] || '';
    if (!biz || !mid) return '';
    return 'https://mp.weixin.qq.com/s?__biz=' + biz + '&mid=' + mid + '&idx=' + idx + (sn ? '&sn=' + sn : '');
  } catch {
    return '';
  }
}

const effectiveKeywords = dry ? ['读书'] : keywords;
const pool = [];
const failures = [];
let blocked = false;
let searched = 0;
let resolved = 0;

if (dry) {
  pool.push({
    标题: '【dry-run】读书，是普通人最便宜的翻身方式',
    账号: '洞见',
    发布日期: '2026-08-12',
    关键词: '读书',
    原文链接: 'https://mp.weixin.qq.com/s?__biz=DRYBIZ0&mid=1&idx=1&sn=dry0001',
    sn: 'dry0001',
    wx_biz: 'DRYBIZ0',
    摘要: '样例摘要（未联网）',
  });
  console.log('[dry-run] 使用内置样例，不联网。');
} else {
  outer: for (const kw of effectiveKeywords) {
    for (let page = 1; page <= pagesN; page++) {
      const url = 'https://weixin.sogou.com/weixin?type=2&query=' + encodeURIComponent(kw) + '&ie=utf8&page=' + page;
      let html = '';
      try {
        html = await get(url);
      } catch (e) {
        failures.push({ keyword: kw, page, msg: String((e && e.message) || e) });
        console.log('搜索失败：' + kw + ' p' + page + '｜' + (e && e.message));
        break;
      }
      if (/antispider|请输入验证码|验证码/.test(html)) {
        console.log('触发搜狗反爬/验证码，立即停止（不要硬冲）。已拿到的结果仍然保留。');
        blocked = true;
        break outer;
      }
      const items = parseSearchPage(html);
      searched++;
      console.log('搜索 ' + kw + ' p' + page + '：' + items.length + ' 条');

      for (const it of items) {
        if (accountFilter.length) {
          const norm = (it.account || '').replace(/[^0-9A-Za-z\u4e00-\u9fff]/g, '').toLowerCase();
          if (!accountFilter.some((f) => f && (norm.includes(f) || f.includes(norm)))) continue;
        }
        try {
          const tempUrl = await resolveLink(it, url);
          if (!tempUrl || !/mp\.weixin\.qq\.com/.test(tempUrl)) {
            failures.push({ keyword: kw, page, title: it.title, msg: '跳转链解析失败（签名过期或被拦）' });
            await sleepMs(Math.round(rand(gapMs, gapMs * 1.6)));
            continue;
          }
          let realUrl = tempUrl;
          let isTemp = true;
          if (permanentize) {
            await sleepMs(Math.round(rand(gapMs, gapMs * 1.2)));
            const perm = await toPermanent(tempUrl);
            if (perm) {
              realUrl = perm;
              isTemp = false;
            }
          }
          resolved++;
          pool.push({
            标题: it.title,
            账号: it.account,
            发布日期: it.pub_time,
            关键词: kw,
            原文链接: realUrl,
            sn: snOf({ art_url: realUrl }),
            wx_biz: bizOf({ art_url: realUrl }),
            摘要: it.abstract,
            临时链: isTemp ? '是（未取到永久链，链接会过期）' : '',
          });
        } catch (e) {
          failures.push({ keyword: kw, page, title: it.title, msg: String((e && e.message) || e) });
        }
        await sleepMs(Math.round(rand(gapMs, gapMs * 1.6)));
      }
      await sleepMs(Math.round(rand(gapMs, gapMs * 2)));
    }
  }
}

// 与已有 articles.json 去重
const existing = readJson(join(ensureDirAbs, 'articles.json'), []);
const usedUrl = new Set(existing.map((r) => r.原文链接).filter(Boolean));
const usedSn = new Set(existing.map((r) => r.sn).filter(Boolean));
const usedTitle = new Set(existing.map((r) => clean(r.标题)));
const seen = new Set();
const rows = [];
let dup = 0;
for (const it of pool) {
  const t = clean(it.标题);
  // 去重键：永久链有 sn 就用 sn，临时链没有 sn → 退回用链接本身，否则第一条之后全被误判成重复
  const key = it.sn || it.原文链接 || t;
  if (!t || !it.原文链接 || seen.has(key) || usedUrl.has(it.原文链接) || (it.sn && usedSn.has(it.sn)) || usedTitle.has(t)) {
    dup++;
    continue;
  }
  seen.add(key);
  rows.push({
    序号: rows.length + 1,
    标题: t,
    账号: it.账号,
    阅读量: '',
    点赞: '',
    在看: '',
    转发: '',
    爆款分: '',
    账号爆款倍率: '',
    低粉爆款信号: '',
    发布日期: it.发布日期,
    关键词: it.关键词,
    原文链接: it.原文链接,
    阅读量核实状态: '不可见（搜狗无阅读量，需人工核实）',
    sn: it.sn,
    wx_biz: it.wx_biz,
    摘要: it.摘要,
    临时链: it.临时链 || '',
  });
}

writeJson(join(outDir, 'sogou-articles.json'), rows);
writeCsv(
  join(outDir, 'sogou-articles.csv'),
  ['序号', '标题', '账号', '发布日期', '关键词', '原文链接', '阅读量', '阅读量核实状态', '临时链'],
  rows
);
writeJson(join(outDir, 'sogou-failures.json'), failures);
writeText(
  join(outDir, 'report-sogou.md'),
  [
    '# 搜狗补充入口 · ' + (args.track || '') + '（' + today() + '）',
    '',
    '- 关键词：' + effectiveKeywords.join(' / ') + '｜翻页：' + pagesN + '｜账号过滤：' + (accountFilter.join(' / ') || '未设置'),
    '- 搜索结果数：' + searched + ' 次请求｜解析出链接：' + resolved + ' 条｜入库：' + rows.length + ' 条｜去重丢弃：' + dup,
    '- 其中没取到永久链（链接会过期，需尽快下载）：' + rows.filter((r) => r.临时链).length + ' 条',
    blocked ? '- **本轮触发搜狗验证码，已提前停止。**' : '- 未触发反爬。',
    '',
    '## 口径警告',
    '',
    '- 搜狗**不返回阅读量**，所以这份清单不能用来判爆款，阅读量一栏全部是「不可见」。',
    '- 想判爆款必须回到 wxrank 付费接口（第 3 步）。搜狗只适合「补漏 / 找某个号的某篇文章」。',
    '- 跳转链是一次性签名，跨会话复用会失效；触发验证码时应停止，不要连续重试。',
    '- 2026-10-06 实测：9 条搜索结果能全部解析出链接，但多数拿不到永久链，落到 `timestamp+signature` 临时链。**解析完要尽快下载**，隔天多半失效。',
    '',
    '## 下一步',
    '',
    '```',
    'node scripts/download.mjs --out "' + outDir + '" --from "' + join(outDir, 'sogou-articles.json') + '"',
    '```',
    '',
  ].join('\n')
);

console.log('\n搜狗补充入口完成：入库 ' + rows.length + ' 条' + (blocked ? '（被验证码中断）' : ''));
console.log('  ' + join(outDir, 'sogou-articles.json'));
console.log('  ' + join(outDir, 'report-sogou.md'));
console.log('提醒用户：搜狗没有阅读量，这批只能当素材，不能当爆款榜单。');
