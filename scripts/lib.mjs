// wxrank 客户端 + 共用工具。
// Key 只从环境变量 WXRANK_KEY（或 skill 目录下的 wxrank.key）读取，绝不写入产出文件。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export const BASE = (process.env.WXRANK_BASE || 'http://data.wxrank.com/weixin').replace(/\/+$/, '') + '/';

// 价目（2026-10-06 依 wxrank 官方文档核实；以控制台为准）
const DEFAULT_PRICE = {
  artlist: 0.01,
  getso: 0.1,
  artinfo: 0.01,
  getps: 0.05,
  getrk: 0.02,
  getsu: 0.1,
  getbiz: 0.05,
  getinfo: 0.05,
  artshort: 0.01,
  score: 0,
};
const PRICE = (() => {
  if (!process.env.WXRANK_PRICE_JSON) return { ...DEFAULT_PRICE };
  try {
    return { ...DEFAULT_PRICE, ...JSON.parse(process.env.WXRANK_PRICE_JSON) };
  } catch {
    console.log('WXRANK_PRICE_JSON 解析失败，改用内置价目。');
    return { ...DEFAULT_PRICE };
  }
})();

export const priceOf = (api) => PRICE[api] ?? 0;
export const priceTable = () => ({ ...PRICE });

export function loadKey(explicit) {
  const keyFile = process.env.WXRANK_KEY_FILE || join(SKILL_DIR, 'wxrank.key');
  const candidates = [explicit, process.env.WXRANK_KEY];
  if (existsSync(keyFile)) candidates.push(readFileSync(keyFile, 'utf8'));
  const key = candidates.map((s) => String(s || '').trim()).find(Boolean);
  if (!key) {
    throw new Error(
      '缺少 wxrank Key。当前选择的付费功能需要 Key 和足够积分。\n' +
        '充值完全自愿；不充值仍可使用免费正文配图下载和免费合集下载（仅覆盖合集内文章）。\n' +
        '若自愿使用付费功能，请前往 https://data.wxrank.com/ 自行登录，按官网说明获取 API Key 并按需充值。\n' +
        '不想充值可停止本次付费步骤，选择免费功能。获取 Key 后任选一种方式在本地配置：\n' +
        '  1) 设置环境变量 WXRANK_KEY\n' +
        '  2) 在 ' + keyFile + ' 里写入 Key（只写一行）\n' +
        '见 references/wxrank-api.md。不要把 Key 贴进对话、config.json、报告或 GitHub。\n' +
        '配置后仍需先查看本轮预算并确认，才会执行付费请求。'
    );
  }
  return key;
}

export class BudgetStop extends Error {}

export class Budget {
  constructor(capYuan, label = '') {
    this.cap = Number(capYuan);
    this.label = label;
    this.spent = 0;
    this.calls = {};
    this.ledger = [];
  }
  allow(api, n = 1) {
    return this.spent + priceOf(api) * n <= this.cap + 1e-9;
  }
  charge(api, note = '') {
    const yuan = priceOf(api);
    this.spent += yuan;
    this.calls[api] = (this.calls[api] || 0) + 1;
    this.ledger.push({ api, yuan, note });
  }
  summary() {
    const rows = Object.keys(this.calls)
      .sort()
      .map((a) => '  ' + a + '：' + this.calls[a] + ' 次 × ¥' + priceOf(a).toFixed(2));
    const head = '预算上限 ¥' + this.cap.toFixed(2) + '｜保守记账 ¥' + this.spent.toFixed(2);
    return [head, ...rows].join('\n');
  }
}

export function saveBudget(outDir, budget, extra = {}) {
  ensureDir(outDir);
  writeJson(join(outDir, 'budget.json'), {
    cap: budget.cap,
    spent: budget.spent,
    calls: budget.calls,
    ledger: budget.ledger,
    finished_at: new Date().toISOString(),
    ...extra,
  });
  console.log(budget.summary());
}

export const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// 单次调用。error 响应也可能计费，所以每次请求都记账。
// 重要：只有「网络异常 / 响应不是 JSON / QPS 超限(9999)」才重试。
// 业务错误（积分不足 1000、参数错误 1001 等）重试多少次都是同样的结果，只会白花钱。
export async function call(api, body, { key, budget, tries = 3, gapMs = 1200, note = '' } = {}) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    if (budget && !budget.allow(api)) {
      throw new BudgetStop(api + ' 触及预算上限 ¥' + budget.cap.toFixed(2) + '，已停止。');
    }
    let retryable = false;
    try {
      const res = await fetch(BASE + api, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, ...body }),
      });
      const text = await res.text();
      if (budget) budget.charge(api, note);
      try {
        last = JSON.parse(text);
      } catch {
        last = { code: res.status, msg: text.slice(0, 200) };
        retryable = true; // 返回的不是 JSON：多半是网络/网关问题，值得重试
      }
      if (last && last.code === 0) return last;
      if (last && last.code === 9999) retryable = true; // QPS 超限，等一会儿再试
    } catch (e) {
      last = { code: -1, msg: String((e && e.message) || e) };
      retryable = true;
    }
    if (retryable && i < tries) await sleepMs(gapMs * i);
    if (!retryable) break;
  }
  return last || { code: -1, msg: 'unknown' };
}

// ---- 字段工具 ----

export const snOf = (it) =>
  it.sn || (String(it.art_url || '').match(/[?&]sn=([0-9a-fA-F]+)/) || [])[1] || '';

export const bizOf = (it) =>
  it.wx_biz || (String(it.art_url || '').match(/__biz=([^&]+)/) || [])[1] || '';

const ENTITIES = [
  [/&nbsp;/g, ' '],
  [/&amp;/g, '&'],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
];

export const decodeEntities = (s) =>
  ENTITIES.reduce((acc, [re, to]) => acc.replace(re, to), String(s == null ? '' : s));

// 标题/摘要用：去标签 + 压平空白
export const clean = (s) => decodeEntities(String(s == null ? '' : s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

// 正文用：去标签但保留段落换行
export const htmlToText = (s) =>
  decodeEntities(
    String(s == null ? '' : s)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|h[1-6]|li|tr)>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  )
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const fmt = (n) => (n === undefined || n === null || n === '' ? '' : String(n));
export const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
export const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
export const list = (v) =>
  String(v == null ? '' : v)
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
export const truthy = (v) => v === true || v === 'true' || v === '1' || v === 'yes';

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[name] = next;
      i++;
    } else {
      out[name] = true;
    }
  }
  return out;
}

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 1), 'utf8');
}

export function writeText(path, text) {
  writeFileSync(path, String(text), 'utf8');
}

// Excel 友好：UTF-8 BOM + CRLF
export function writeCsv(path, cols, rows) {
  const cell = (v) =>
    esc(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
  const body = [cols.join(',')]
    .concat(rows.map((r) => cols.map((c) => cell(r[c])).join(',')))
    .join('\r\n');
  writeFileSync(path, '\ufeff' + body, 'utf8');
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const safeName = (s) =>
  String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

export const trackSlug = (s) => safeName(s).replace(/\s+/g, '-') || 'track';

export const today = () => new Date().toISOString().slice(0, 10);

// 最近 n 个月，最新的在前，格式 YYYYMM
export function lastMonths(n, end = new Date()) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(end.getFullYear(), end.getMonth() - i, 1);
    out.push(String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0'));
  }
  return out;
}

// 最近 n 个月的起始日期（含头不含尾的起点），用于时间窗过滤
export function sinceFromMonths(n, end = new Date()) {
  const d = new Date(end.getFullYear(), end.getMonth() - (n - 1), 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export function buildMustRegex(words) {
  const parts = words.map((w) => String(w).trim()).filter(Boolean).map(escapeRegExp);
  if (!parts.length) return null;
  return new RegExp(parts.join('|'), 'i');
}

export const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- dry-run 用的内置样例数据（不联网、不花钱） ----
export function samplePool() {
  const seeds = [
    ['洞见', 100001, 6423, 4979, 32484],
    ['人民日报', 100001, 16495, 9228, 67967],
    ['十点读书', 87340, 2311, 1502, 9021],
    ['樊登读书', 42210, 880, 640, 2310],
    ['小城慢读', 31200, 120, 88, 401],
    ['夜读小站', 18600, 63, 41, 210],
    ['老张聊认知', 9800, 44, 27, 150],
    ['书单研究所', 6100, 31, 19, 96],
  ];
  const titles = [
    '人生回报率最高的20本书，收藏起来慢慢读',
    '认知觉醒：一个人开始变好的3个迹象',
    '读书，是普通人最便宜的翻身方式',
    '书单｜把日子过明白的5本书',
    '为什么你读了那么多书，还是过不好这一生',
    '搞钱先搞脑：给普通人的3条认知建议',
    '自律的人，都在用这4个习惯',
    '副业刚需时代，普通人该怎么起步',
    '读书的意义，藏在你熬过的那些夜里',
    '格局大了，事就小了',
  ];
  const rows = [];
  const months = lastMonths(6);
  for (let i = 0; i < seeds.length; i++) {
    const [name, base, like, look, share] = seeds[i];
    const count = i < 2 ? 6 : i < 4 ? 4 : 2;
    for (let k = 0; k < count; k++) {
      const read = Math.round(base / (1 + k * (0.6 + i * 0.08)));
      const month = months[(k + i) % months.length];
      const day = String(2 + ((k * 7 + i * 3) % 26)).padStart(2, '0');
      rows.push({
        sn: 'dry' + i + k,
        title: titles[(i * 3 + k) % titles.length],
        desc: '样例摘要，仅用于 dry-run 自检。',
        pub_time: month.slice(0, 4) + '-' + month.slice(4) + '-' + day,
        read_num: read,
        like_num: Math.round(like / (1 + k * 0.5)),
        look_num: Math.round(look / (1 + k * 0.5)),
        share_num: Math.round(share / (1 + k * 0.5)),
        wx_biz: 'DRYBIZ' + i,
        wx_name: name,
        art_url: 'https://mp.weixin.qq.com/s?__biz=DRYBIZ' + i + '&sn=dry' + i + k,
        keyword: '书单',
        month,
        src: 'dry-run',
      });
    }
  }
  return rows;
}
