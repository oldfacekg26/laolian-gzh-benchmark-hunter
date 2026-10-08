import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readingStats, articleSignal, articleKey, baselineWindow, baselineRows } from '../scripts/reading-stats.mjs';

test('零阅读计入、缺失排除、去重及偶数中位数', () => {
  const rows = [0, 100, null, '', 200, 300, 'bad'].map((read_num, i) => ({wx_biz:'a',sn:String(i),read_num}));
  rows.push({...rows[1]});
  const stats = readingStats(rows);
  assert.equal(stats.total, 7);
  assert.equal(stats.known, 4);
  assert.equal(stats.missing, 3);
  assert.equal(stats.mean, 150);
  assert.equal(stats.median, 150);
  assert.notEqual(articleKey({art_url:'https://mp.weixin.qq.com/s/a'}), articleKey({art_url:'https://mp.weixin.qq.com/s/b'}));
});

test('大号十万、样本不足与窗口外文章不冒充低日常阅读爆款', () => {
  const account = {baseline_verified:true,baseline_position:1,baseline_known:20,read_median:100,baseline_start:'2026-09-01',baseline_end:'2026-09-30'};
  const article = {read_num:12000,pub_time:'2026-09-20'};
  assert.equal(articleSignal(article,account).low,true);
  assert.equal(articleSignal({...article,read_num:500},account).low,false);
  assert.equal(articleSignal({...article,read_num:100001},{...account,read_median:30000}).low,false);
  assert.equal(articleSignal(article,{...account,baseline_known:2}).low,false);
  assert.equal(articleSignal({...article,pub_time:'2026-08-20'},account).low,false);
  assert.equal(articleSignal({...article,content_type:'book'},{...account,baseline_content_type:'article'}).low,false);
  assert.equal(baselineWindow('2026-03-01').start,'2026-01-31');
});

test('选文按单篇判断，不继承整号标签，且不限总量仍输出所有合格文章', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const validation = join(root,'.validation'); mkdirSync(validation,{recursive:true});
  const out = mkdtempSync(join(validation,'selection-'));
  const account = {wx_biz:'a',wx_name:'小号',low_fan_signal:true,baseline_verified:true,baseline_position:1,baseline_known:20,read_median:100,baseline_start:'2026-09-01',baseline_end:'2026-09-30'};
  writeFileSync(join(out,'accounts.json'),JSON.stringify([account]));
  writeFileSync(join(out,'config.json'),JSON.stringify({since:'2026-01-01'}));
  writeFileSync(join(out,'pool.json'),JSON.stringify([
    {wx_biz:'a',sn:'lower-duplicate',title:'有效爆款',read_num:11000,pub_time:'2026-09-20'},
    {wx_biz:'a',sn:'pass',title:'有效爆款',read_num:12000,pub_time:'2026-09-20'},
    {wx_biz:'a',sn:'normal',title:'普通文章',read_num:500,pub_time:'2026-09-20'},
    {wx_biz:'a',sn:'outside',title:'不同月份',read_num:50000,pub_time:'2026-08-20'},
  ]));
  execFileSync(process.execPath,[join(root,'scripts/pick-articles.mjs'),'--out',out,'--total','0','--per-account','0','--only-low','true'],{stdio:'pipe'});
  const rows = JSON.parse(readFileSync(join(out,'articles.json'),'utf8'));
  assert.deepEqual(rows.map(r=>r.sn),['pass']);
  assert.equal(rows[0].单篇爆款倍率,120);
});

test('次条低阅读不把大号判成小号，未知位置与不同类型不进入首条基线', () => {
  const window = {start:'2026-09-01',end:'2026-09-30'};
  const rows = Array.from({length:60},(_,i)=>({
    wx_biz:'large',sn:String(i),content_type:'article',pub_time:'2026-09-20',
    art_url:'https://mp.weixin.qq.com/s?idx='+(i<10?1:2)+'&sn='+i,read_num:i<10?12000:100,
  }));
  rows.push({...rows[0],sn:'unknown',art_url:'https://mp.weixin.qq.com/s/short',read_num:50});
  rows.push({...rows[0],sn:'book',content_type:'book',read_num:50});
  assert.equal(readingStats(rows).median,100);
  const stats = readingStats(baselineRows(rows,'article',window));
  assert.equal(stats.known,10);
  assert.equal(stats.median,12000);
  const account = {baseline_verified:true,baseline_position:1,baseline_known:stats.known,read_median:stats.median,baseline_start:window.start,baseline_end:window.end};
  assert.equal(articleSignal({...rows[0],read_num:100001},account).low,false);
  assert.equal(articleSignal({...rows[0],read_num:12000},{...account,read_median:100,baseline_position:undefined}).low,false);
});
