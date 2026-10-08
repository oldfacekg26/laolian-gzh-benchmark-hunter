// 功能 A 第 7 步 / 功能 B：批量下载正文 + 图片。
//
// 两种入口：
//   ① 清单模式（默认）：吃 pick-articles.mjs 产出的 articles.json，或 --from 指定的清单
//   ② 链接模式（--links）：直接吃一串链接（对话里贴的，或本地 txt / csv 文件），
//      不需要 Key、不需要前面任何付费步骤
//
// 默认走【免费直抓】：直接抓 mp.weixin.qq.com 原页，正文和图片都不要钱、不登录。
// 只有直抓失败、且显式加了 --allow-paid 时，才退回付费的 wxrank artinfo 拿纯文字兜底。
//
//   node scripts/download.mjs --out "<输出目录>"
//   node scripts/download.mjs --out "<输出目录>" --links "D:\链接清单.txt"
//   node scripts/download.mjs --out "<输出目录>" --links "https://mp.weixin.qq.com/s?...,https://..."
//   node scripts/download.mjs --out "<输出目录>" --only-accounts "洞见,十点读书"
//   node scripts/download.mjs --out "<输出目录>" --dry-run
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Budget,
  BudgetStop,
  call,
  clean,
  decodeEntities,
  ensureDir,
  htmlToText,
  list,
  loadKey,
  num,
  parseArgs,
  readJson,
  safeName,
  saveBudget,
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

const args = parseArgs(process.argv.slice(2));
const outDir = String(args.out || '').trim();
if (!outDir) {
  console.error('缺少 --out（第 3/4 步的输出目录，里面有 articles.json）。');
  process.exit(2);
}

const cfg = readJson(join(outDir, 'config.json'), {});
const opt = (n, d) => (args[n] !== undefined ? args[n] : cfg[n] !== undefined ? cfg[n] : d);

const dry = truthy(opt('dry-run', false));
const wantImages = opt('images', true) !== false && String(opt('no-images', 'false')) !== 'true';
const force = truthy(opt('force', false));
const limit = num(opt('limit', 0), 0);
const gapLo = num(opt('gap-lo', 3000), 3000);
const gapHi = num(opt('gap-hi', 6000), 6000);
const imgGapLo = num(opt('img-gap-lo', 300), 300);
const imgGapHi = num(opt('img-gap-hi', 800), 800);
const maxYuan = num(opt('max-yuan', 1), 1);
const allowPaid = truthy(opt('allow-paid', false));
const onlySn = new Set(list(opt('only-sn', '')));
const excludeAccount = new Set(list(opt('exclude-account', '')));
const onlyAccounts = new Set(list(opt('only-accounts', '')));
const sourceFile = String(args.from || '').trim() || join(outDir, 'articles.json');

// ---- 链接模式：直接吃一串链接，不需要 Key、不花钱 ----

// 从任意文本里抠出公众号链接（支持一行一条、逗号分隔、表格里混着别的列）
function parseLinks(raw) {
  const text = decodeEntities(String(raw || '')).replace(/&amp;/g, '&');
  const urls = [...text.matchAll(/https?:\/\/[^\s"'<>|]+/gi)]
    .map((m) => m[0].replace(/[),;，。、\]}]+$/, ''))
    .filter((u) => /mp\.weixin\.qq\.com/i.test(u));
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    const sn = snOf({ art_url: u }) || u;
    if (seen.has(sn)) continue;
    seen.add(sn);
    out.push({
      序号: out.length + 1,
      标题: '',
      账号: '',
      原文链接: u,
      sn: snOf({ art_url: u }),
      数据来源: '手动链接清单（无阅读量数据）',
    });
  }
  return out;
}

const linksArg = String(args.links || '').trim();
const linksMode = Boolean(linksArg);
let linkRows = null;
if (linksMode) {
  const isFile = existsSync(linksArg);
  const raw = isFile ? readFileSync(linksArg, 'utf8') : linksArg;
  linkRows = parseLinks(raw);
  if (!linkRows.length) {
    console.error('--links 里没找到公众号链接：' + (isFile ? linksArg : '（命令行参数）'));
    process.exit(1);
  }
  console.log('链接模式：从 ' + (isFile ? linksArg : '命令行') + ' 读到 ' + linkRows.length + ' 条去重后的公众号链接');
}

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const sleepRand = (lo, hi) => sleepMs(Math.round(rand(lo, hi)));

const articlesDir = ensureDir(join(outDir, 'articles'));
const imagesRoot = join(articlesDir, 'images');

// 序号 → 已落盘的 md（链接模式文件名带抓到的标题，只能按序号前缀认）
function existingByIndex(idx) {
  try {
    const hit = readdirSync(articlesDir).find((f) => f.startsWith(idx + '_') && f.endsWith('.md'));
    return hit ? join(articlesDir, hit) : null;
  } catch {
    return null;
  }
}

let rows = linksMode
  ? linkRows
  : dry
  ? [
      {
        序号: 1,
        标题: '【dry-run】认知觉醒：一个人开始变好的3个迹象',
        账号: '洞见',
        阅读量: 100001,
        点赞: 6423,
        在看: 4979,
        转发: 32484,
        爆款分: 197453,
        账号爆款倍率: 1,
        低粉爆款信号: '',
        发布日期: '2026-08-20',
        关键词: '认知',
        原文链接: 'https://mp.weixin.qq.com/s?__biz=DRYBIZ0&sn=dry00',
        阅读量核实状态: '接口读取（wxrank artlist）',
        sn: 'dry00',
        wx_biz: 'DRYBIZ0',
      },
    ]
  : readJson(sourceFile, []);

if (!rows.length) {
  console.error(
    '没有待下载文章：' + sourceFile + ' 为空。先跑 pick-articles.mjs，或用 --from 指定别的清单（如 sogou-articles.json），或用 --links 直接给链接。'
  );
  process.exit(1);
}

if (onlySn.size) rows = rows.filter((r) => onlySn.has(r.sn));
if (excludeAccount.size) rows = rows.filter((r) => !excludeAccount.has(r.账号));
if (onlyAccounts.size) rows = rows.filter((r) => onlyAccounts.has(r.账号));
if (limit > 0) rows = rows.slice(0, limit);

console.log('待下载 ' + rows.length + ' 篇｜图片 ' + (wantImages ? '下载' : '跳过') + '｜间隔 ' + gapLo + '-' + gapHi + 'ms/篇');
console.log('下载方式：免费直抓 mp.weixin 原页' + (allowPaid ? '；失败时可用 artinfo 兜底（付费）' : '；付费兜底已关闭'));
if (linksMode) console.log('入口：链接模式（' + (dry ? 'dry-run' : '不花钱、不需要 Key') + '）');

const budget = new Budget(maxYuan, 'download');
const key = allowPaid && !dry ? loadKey(opt('key')) : null;
const results = [];

// ---- 抓取 ----

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://mp.weixin.qq.com/',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
}

function meta(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1] !== undefined && m[1] !== '') return decodeEntities(m[1]).trim();
  }
  return '';
}

function extractBodyHtml(html) {
  const open = html.match(/<div[^>]*id="js_content"[^>]*>/i);
  if (!open) return '';
  const start = open.index + open[0].length;
  const re = /<div\b[^>]*>|<\/div>/gi;
  re.lastIndex = start;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) return html.slice(start, m.index);
    } else {
      depth++;
    }
  }
  return html.slice(start);
}

function bodyToMarkdown(bodyHtml) {
  let s = bodyHtml;
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<img[^>]*>/gi, (tag) => {
    const src =
      (tag.match(/data-src="([^"]+)"/i) || tag.match(/\bsrc="([^"]+)"/i) || [])[1] || '';
    if (!src || /^data:/i.test(src)) return '';
    return '\n\n@@IMG:' + src.trim() + '@@\n\n';
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|section|div|h[1-6]|li|blockquote|tr|td|figure)>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  const out = [];
  for (const raw of s.split('\n')) {
    const line = raw.replace(/[ \t\u00a0]+/g, ' ').trim();
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    out.push(line);
  }
  return out.join('\n').trim();
}

function imageExtension(url, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  const fmt = (url.match(/wx_fmt=([a-z0-9]+)/i) || [])[1];
  if (fmt) return fmt === 'jpeg' ? 'jpg' : fmt;
  if (/\.png(\?|$)/i.test(url)) return 'png';
  if (/\.gif(\?|$)/i.test(url)) return 'gif';
  return 'jpg';
}

async function downloadImages(urls, slug, stats) {
  const dir = join(imagesRoot, slug);
  mkdirSync(dir, { recursive: true });
  const map = new Map();
  let i = 0;
  for (const url of urls) {
    i++;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://mp.weixin.qq.com/' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) throw new Error('空文件');
      const name = 'img_' + String(i).padStart(3, '0') + '.' + imageExtension(url, res.headers.get('content-type'));
      writeFileSync(join(dir, name), buf);
      map.set(url, 'images/' + slug + '/' + name);
      stats.images++;
      await sleepRand(imgGapLo, imgGapHi);
    } catch (e) {
      stats.imageFailures++;
      map.set(url, null);
    }
  }
  return map;
}

function yaml(s) {
  return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function buildMarkdown(rec, info) {
  const fm = [
    '---',
    '标题: ' + yaml(info.title),
    '账号: ' + yaml(info.nickname),
    '发布: ' + yaml(info.pubTime),
    '阅读: ' + (rec.阅读量 === undefined || rec.阅读量 === null ? '' : rec.阅读量),
    '点赞: ' + (rec.点赞 || ''),
    '在看: ' + (rec.在看 || ''),
    '转发: ' + (rec.转发 || ''),
    '爆款分: ' + (rec.爆款分 || ''),
    '账号爆款倍率: ' + (rec.账号爆款倍率 === undefined ? '' : rec.账号爆款倍率),
    '低粉爆款信号: ' + yaml(rec.低粉爆款信号 || ''),
    '赛道: ' + yaml(cfg.track || ''),
    '赛道关键词: ' + yaml(rec.关键词 || ''),
    '数据来源: ' + yaml(rec.数据来源 || 'wxrank artlist（付费接口）'),
    '原文链接: ' + yaml(rec.原文链接),
    '下载方式: ' + yaml(info.route),
    '下载日期: ' + info.date,
    '粉丝数: "不可见"',
    '---',
    '',
  ].join('\n');
  const mismatch =
    info.apiName && info.nickname && clean(info.apiName) !== clean(info.nickname)
      ? '<!-- 注意：接口记的账号是「' + clean(info.apiName) + '」，页面显示「' + clean(info.nickname) + '」，以页面为准 -->\n\n'
      : '';
  return fm + mismatch + info.markdown + '\n';
}

if (dry) {
  const rec = rows[0];
  const info = {
    title: rec.标题,
    nickname: rec.账号,
    pubTime: rec.发布日期,
    route: 'dry-run（未联网）',
    date: today(),
    markdown: '# 样例正文\n\n这是 dry-run 生成的占位正文，用来验证文件落盘与索引结构。\n',
  };
  const slug = '001_' + safeName(rec.账号 || '未知账号') + '_' + safeName(rec.标题 || '样例').slice(0, 40);
  const file = join(articlesDir, slug + '.md');
  writeText(file, buildMarkdown(rec, info));
  console.log('[dry-run] 已写出示例文件：' + file);
  results.push({ 序号: 1, 标题: rec.标题, 账号: rec.账号, 下载方式: info.route, 正文字数: 30, 图片数: 0, 文件: slug + '.md', 状态: 'dry-run' });
} else {
  for (let i = 0; i < rows.length; i++) {
    const rec = rows[i];
    const idx = String(i + 1).padStart(3, '0');
    const stats = { images: 0, imageFailures: 0 };

    // 文件名以「序号_账号_标题」为准；链接模式一开始没有标题，抓完页面再定
    let slug = idx + '_' + safeName(rec.账号 || '未知账号') + '_' + safeName(rec.标题 || '待识别').slice(0, 40);
    let file = join(articlesDir, slug + '.md');

    const done = existingByIndex(idx);
    if (done && !force && statSync(done).size > 200) {
      const base = done.split(/[\\/]/).pop();
      console.log('[' + idx + '/' + rows.length + '] 已存在，跳过：' + String(rec.标题 || base).slice(0, 24));
      results.push({
        序号: rec.序号 || i + 1, 标题: rec.标题, 账号: rec.账号,
        下载方式: '跳过（已存在）', 正文字数: '', 图片数: '', 文件: base, 状态: 'skip',
      });
      continue;
    }

    let ok = false;
    let failure = '';

    // 1) 免费直抓
    try {
      const html = await fetchHtml(rec.原文链接);
      const bodyHtml = extractBodyHtml(html);
      if (!bodyHtml || bodyHtml.length < 200) throw new Error('未解析到正文容器（可能是已被删除/需验证）');

      const title =
        meta(html, [
          /property="og:title"\s+content="([^"]*)"/,
          /var msg_title\s*=\s*'([^']*)'/,
          /var msg_title\s*=\s*"([^"]*)"/,
          /<h1[^>]*id="activity-name"[^>]*>([\s\S]*?)<\/h1>/,
        ]) || rec.标题;
      // 号名以页面里的 js_name 为准：var nickname 有 htmlDecode("...") 的写法，漏掉会认错号
      const pageName = meta(html, [
        /<a[^>]*id="js_name"[^>]*>([\s\S]*?)<\/a>/,
        /var nickname\s*=\s*htmlDecode\("([^"]*)"\)/,
        /var nickname\s*=\s*"([^"]*)"/,
        /var nickname\s*=\s*'([^']*)'/,
        /property="og:article:author"\s+content="([^"]*)"/,
      ]);
      const nickname = pageName || rec.账号;
      const ct = meta(html, [/var ct\s*=\s*"(\d+)"/, /var create_time\s*=\s*"(\d+)"/]);
      // ct 是北京时间戳，直接按 UTC 转会差一天
      const pubTime = ct ? new Date((Number(ct) + 8 * 3600) * 1000).toISOString().slice(0, 10) : rec.发布日期;

      // 链接模式：拿到页面上的标题/号名后，才定文件名和归档名
      if (!rec.标题) rec.标题 = clean(title);
      if (!rec.账号) rec.账号 = clean(nickname);
      slug = idx + '_' + safeName(rec.账号 || '未知账号') + '_' + safeName(rec.标题 || '未命名').slice(0, 40);
      file = join(articlesDir, slug + '.md');

      let markdown = bodyToMarkdown(bodyHtml);
      const imgUrls = [...new Set([...bodyHtml.matchAll(/data-src="([^"]+)"/gi)].map((m) => decodeEntities(m[1].trim())))].filter(
        (u) => u && !/^data:/i.test(u)
      );

      if (wantImages && imgUrls.length) {
        const map = await downloadImages(imgUrls, slug, stats);
        markdown = markdown
          .split('\n')
          .map((line) => {
            const m = line.match(/^@@IMG:(.+)@@$/);
            if (!m) return line;
            const local = map.get(m[1].trim());
            return local ? '![](' + local + ')' : '<!-- 图片下载失败：' + m[1].trim() + ' -->';
          })
          .join('\n');
      } else {
        markdown = markdown.replace(/@@IMG:(.+)@@/g, '<!-- 图片：$1 -->');
      }
      markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

      const info = {
        title: clean(title),
        nickname: clean(nickname),
        apiName: rec.账号,
        pubTime,
        route: '免费直抓 mp.weixin 原页',
        date: today(),
        markdown,
      };
      writeText(file, buildMarkdown(rec, info));
      results.push({
        序号: rec.序号, 标题: rec.标题, 账号: rec.账号, 下载方式: info.route,
        正文字数: markdown.replace(/\s/g, '').length, 图片数: stats.images,
        图片失败: stats.imageFailures, 文件: slug + '.md', 状态: 'ok',
      });
      console.log('[' + idx + '/' + rows.length + '] 免费直抓 OK｜' + markdown.replace(/\s/g, '').length + ' 字｜图 ' + stats.images + '｜' + String(rec.标题).slice(0, 22));
      ok = true;
    } catch (e) {
      failure = String((e && e.message) || e);
    }

    // 2) 付费兜底（默认关闭）
    if (!ok && allowPaid) {
      try {
        const j = await call('artinfo', { url: rec.原文链接 }, { key, budget, note: 'fallback:' + rec.sn });
        if (j && j.code === 0 && j.data) {
          const text = htmlToText(j.data.text || j.data.content || j.data.body || '');
          if (text.length > 200) {
            const info = {
              title: clean(j.data.title || rec.标题),
              nickname: clean(j.data.name || rec.账号),
              pubTime: String(j.data.pub_time || rec.发布日期).slice(0, 10),
              route: '付费兜底 artinfo（免费直抓失败）',
              date: today(),
              markdown: text,
            };
            if (!rec.标题) rec.标题 = info.title;
            if (!rec.账号) rec.账号 = info.nickname;
            slug = idx + '_' + safeName(rec.账号 || '未知账号') + '_' + safeName(rec.标题 || '未命名').slice(0, 40);
            file = join(articlesDir, slug + '.md');
            writeText(file, buildMarkdown(rec, info));
            results.push({
              序号: rec.序号, 标题: rec.标题, 账号: rec.账号, 下载方式: info.route,
              正文字数: text.replace(/\s/g, '').length, 图片数: 0, 文件: slug + '.md', 状态: 'ok-fallback',
            });
            console.log('[' + idx + '/' + rows.length + '] artinfo 兜底 OK（无图）');
            ok = true;
          } else {
            failure += '｜artinfo 正文为空';
          }
        } else {
          failure += '｜artinfo code=' + (j && j.code) + ' ' + clean(j && j.msg);
        }
      } catch (e) {
        if (e instanceof BudgetStop) {
          console.log(e.message);
        }
        failure += '｜artinfo 异常 ' + String((e && e.message) || e);
      }
    }

    if (!ok) {
      results.push({ 序号: rec.序号, 标题: rec.标题, 账号: rec.账号, 下载方式: '失败', 正文字数: '', 图片数: '', 文件: '', 状态: 'fail', 备注: failure });
      console.log('[' + idx + '/' + rows.length + '] 失败：' + String(rec.标题 || rec.原文链接).slice(0, 40) + '｜' + failure);
    }

    await sleepRand(gapLo, gapHi);
  }
}

writeCsv(
  join(outDir, '下载索引.csv'),
  ['序号', '标题', '账号', '下载方式', '正文字数', '图片数', '图片失败', '文件', '状态', '备注'],
  results
);
writeJson(join(outDir, 'download-summary.json'), {
  total: rows.length,
  ok: results.filter((r) => r.状态 === 'ok' || r.状态 === 'dry-run').length,
  fallback: results.filter((r) => r.状态 === 'ok-fallback').length,
  skipped: results.filter((r) => r.状态 === 'skip').length,
  failed: results.filter((r) => r.状态 === 'fail').length,
  images: results.reduce((n, r) => n + (Number(r.图片数) || 0), 0),
});
saveBudget(outDir, budget, { stage: 'download', images: results.reduce((n, r) => n + (Number(r.图片数) || 0), 0) });

const ok = results.filter((r) => r.状态 === 'ok' || r.状态 === 'dry-run').length;
const fb = results.filter((r) => r.状态 === 'ok-fallback').length;
const skip = results.filter((r) => r.状态 === 'skip').length;
const fail = results.filter((r) => r.状态 === 'fail').length;
console.log('\n完成：成功 ' + ok + '｜兜底 ' + fb + '｜跳过 ' + skip + '｜失败 ' + fail);
console.log('  ' + join(outDir, 'articles') + '\\*.md');
console.log('  ' + join(outDir, '下载索引.csv'));
if (fail) console.log('失败的别急着重试到底：先看是不是原文被删、需要验证，或节流太慢；确认后再加 --force 单篇重跑。');
