// 阅读统计只使用按账号、无关键词和阅读下限查询得到的样本。
export function readValue(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function articleKey(row) {
  const biz = row.wx_biz || '';
  if (row.sn) return biz + ':' + row.sn;
  try {
    const url = new URL(row.art_url);
    const sn = url.searchParams.get('sn');
    if (sn) return (biz || url.searchParams.get('__biz') || '') + ':' + sn;
    const mid = url.searchParams.get('mid');
    return mid ? (biz || url.searchParams.get('__biz') || '') + ':' + mid + ':' + (url.searchParams.get('idx') || '1') : biz + ':' + url.origin + url.pathname;
  } catch { return row.art_url ? biz + ':' + row.art_url : null; }
}

export function readingStats(rows) {
  const dedup = new Map();
  for (const row of rows) {
    const id = articleKey(row);
    if (!id) continue;
    const old = dedup.get(id);
    if (!old || readValue(old.read_num) === null) dedup.set(id, row);
  }
  const values = [...dedup.values()].map(r => readValue(r.read_num)).filter(n => n !== null).sort((a, b) => a - b);
  const count = values.length;
  const median = !count ? null : count % 2 ? values[(count - 1) / 2] : (values[count / 2 - 1] + values[count / 2]) / 2;
  const dates = [...dedup.values()].map(r => String(r.pub_time || '').slice(0, 10)).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s)).sort();
  return {
    total: dedup.size, known: count, missing: dedup.size - count,
    mean: count ? Math.round(values.reduce((sum, n) => sum + n, 0) / count * 10) / 10 : null,
    median, max: count ? values.at(-1) : null,
    under1000: values.filter(n => n < 1000).length,
    date_min: dates[0] || null, date_max: dates.at(-1) || null,
    censored: values.some(n => n >= 100000),
  };
}

// 次条阅读不能证明账号平时首条也低；短链未带 idx 时保持未知。
export function articlePosition(row) {
  try {
    const idx = new URL(row.art_url).searchParams.get('idx');
    return idx && /^\d+$/.test(idx) && Number(idx) > 0 ? Number(idx) : null;
  } catch { return null; }
}

export function baselineRows(rows, contentType, window) {
  if (!contentType || !window) return [];
  return rows.filter(row => {
    const pub = String(row.pub_time || '').slice(0, 10);
    return row.content_type === contentType && articlePosition(row) === 1 && pub >= window.start && pub <= window.end;
  });
}

export function baselineWindow(date, days = 30) {
  const end = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || !Number.isFinite(Date.parse(end))) return null;
  const start = new Date(Date.parse(end + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
  const months = [];
  const cursor = new Date(start + 'T00:00:00Z');
  cursor.setUTCDate(1);
  while (cursor.toISOString().slice(0, 10) <= end) {
    months.push(cursor.toISOString().slice(0, 7).replace('-', ''));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return { start, end, months };
}

export function articleSignal(article, account, { medianMax = 1000, minSamples = 10, minRead = 10000, minRatio = 10 } = {}) {
  const read = readValue(article.read_num);
  const median = readValue(account.read_median);
  const pub = String(article.pub_time || '').slice(0, 10);
  const inWindow = !!pub && pub >= account.baseline_start && pub <= account.baseline_end;
  const sameType = !account.baseline_content_type || article.content_type === account.baseline_content_type;
  const ratio = sameType && read !== null && median > 0 ? Math.round(read / median * 100) / 100 : null;
  const valid = account.baseline_verified === true && account.baseline_position === 1 && account.baseline_known >= minSamples && median > 0 && median < medianMax && inWindow && sameType;
  return { ratio, low: !!(valid && read >= minRead && read / median >= minRatio), inWindow };
}
