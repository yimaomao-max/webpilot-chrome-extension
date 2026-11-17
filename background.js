/**
 * WebPilot AI 后台 Service Worker
 * - LLM 代理（字段命名 / 变化解读）
 * - 监控任务：chrome.alarms 定时抓取页面 → offscreen 解析 → 字段级 diff → 洞察报告
 */
importScripts('lib/extract-core.js');

const MON_PREFIX = 'wp-mon-';

/* ---------------- 套餐计划（优先服务端下发 serverPlan，未绑定时回退本地模拟） ---------------- */
const PLANS = {
  free: { label: 'Free', maxMonitors: 3, minIntervalMin: 1440, historyDays: 7 },
  pro: { label: 'Pro', maxMonitors: 30, minIntervalMin: 60, historyDays: 90 },
  team: { label: 'Team', maxMonitors: 100, minIntervalMin: 30, historyDays: 365 }
};

async function getPlan() {
  const { wp_settings = {} } = await chrome.storage.local.get('wp_settings');
  // 已绑定云端账号：以服务端下发的套餐为准
  if (wp_settings.serverPlan && wp_settings.serverPlan.maxMonitors) {
    return {
      label: wp_settings.serverPlan.label,
      maxMonitors: wp_settings.serverPlan.maxMonitors,
      minIntervalMin: wp_settings.serverPlan.minIntervalMin,
      historyDays: wp_settings.serverPlan.historyDays
    };
  }
  return PLANS[wp_settings.plan] || PLANS.free;
}

/* ---------------- LLM ---------------- */
async function llmChat(messages) {
  const { wp_settings = {} } = await chrome.storage.local.get('wp_settings');
  if (!wp_settings.apiKey) {
    throw new Error('尚未配置 AI API Key，请点击弹出窗口右上角齿轮打开设置');
  }
  const base = (wp_settings.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + wp_settings.apiKey
    },
    body: JSON.stringify({
      model: wp_settings.model || 'gpt-4o-mini',
      messages,
      temperature: 0.2
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('API 错误 ' + res.status + ': ' + t.slice(0, 200));
  }
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

/* ---------------- offscreen（DOM 解析沙箱） ---------------- */
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!ctx.length) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: '解析网页 HTML 用于数据提取与变化监控'
    });
  }
}

/* ---------------- 监控任务 ----------------
 * AI 成本控制（三级流水线，每次检查 AI 调用数为 0）：
 * 1. 程序提取：offscreen/extract-core 纯 DOM 解析
 * 2. 字段级比较：diffRows + buildFieldChanges 纯规则
 * 3. AI 仅在确认有效变化后按需触发（用户点「AI 解读」或生成周报时），绝不每次检查调用
 */
async function checkMonitor(id) {
  const { wp_monitors = {} } = await chrome.storage.local.get('wp_monitors');
  const t = wp_monitors[id];
  if (!t) return;

  t.lastStatus = 'checking';
  await chrome.storage.local.set({ wp_monitors });

  const res = await fetch(t.url, { credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error('页面请求失败 ' + res.status);
  const html = await res.text();

  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_EXTRACT',
    html,
    config: t.config
  });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || '页面解析失败');
  const rows = resp.rows || [];
  const newHeaders = resp.headers || [];

  const oldRows = t.lastRows || [];

  // 字段对齐：按用户确认后的字段（ID + 名称锚点）把新数据映射回稳定列序。
  // 页面列序调整、表头改名均不影响与历史快照的对比——这是历史数据可比性的根基。
  let headers = t.headers || [];
  let rowsAligned = rows;
  if (t.fields && t.fields.length && newHeaders.length) {
    const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
    const idx = t.fields.map((f) => newHeaders.findIndex((h) => norm(h) === norm(f.name)));
    const mapped = idx.filter((i) => i >= 0).length;
    if (mapped >= Math.ceil(t.fields.length * 0.6) && rows.length) {
      headers = t.fields.map((f) => f.name);
      rowsAligned = rows.map((r) => idx.map((i) => (i >= 0 ? r[i] : '')));
    } else if (oldRows.length > 0 && mapped === 0) {
      // 字段全部失配：页面结构大改，明确提示而非静默错比
      t.needsReconfigure = true;
    }
  }

  // 选择器失效（页面改版）：显式告警，绝不假装“没有变化”
  if (resp.broken && oldRows.length > 0) {
    t.lastChecked = Date.now();
    t.lastStatus = 'selector_broken';
    wp_monitors[id] = t;
    await chrome.storage.local.set({ wp_monitors });
    try {
      chrome.action.setBadgeText({ text: '⚠' });
      chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
    } catch (e) { /* ignore */ }
    return;
  }

  // 自动降级（通过备用定位提取成功）：提示用户重新设定
  if (resp.degraded) {
    t.needsReconfigure = true;
  } else {
    t.needsReconfigure = false;
  }

  // 字段级 diff：识别新增 / 移除 / 同一行的字段值变化（对齐后按稳定列序比较）
  const diff = WebPilotCore.diffRows(oldRows, rowsAligned);
  const meaningful = diff.added.length || diff.removed.length || diff.modified.length;

  t.lastRows = rowsAligned;
  t.lastChecked = Date.now();
  t.lastStatus = 'ok';

  // 纯顺序抖动 / 无实质变化：静默更新快照，不打扰用户
  if (oldRows.length > 0 && !meaningful) {
    wp_monitors[id] = t;
    await chrome.storage.local.set({ wp_monitors });
    return;
  }

  if (meaningful) {
    t.lastChanged = Date.now();
    // 历史数据结构化：保留时间序列快照（数量上限 + 按套餐天数修剪）
    t.history = (t.history || []).concat([{ time: Date.now(), rows: rowsAligned }]).slice(-30);
    try {
      const plan = await getPlan();
      const cutoff = Date.now() - plan.historyDays * 86400000;
      t.history = t.history.filter((h) => h.time >= cutoff);
    } catch (e) { /* ignore */ }
    const summary = summarizeDiff(headers, diff);
    if (resp.degraded) {
      summary.unshift('⚠ 页面结构可能已改版，本次通过备用定位提取，建议重新设定提取目标');
    }
    const insight = buildInsight(headers, diff, t.fields);
    const fieldChanges = buildFieldChanges(t.fields, headers, diff, Date.now());
    const { wp_changes = {} } = await chrome.storage.local.get('wp_changes');
    const list = wp_changes[id] || [];
    const record = {
      time: Date.now(),
      oldCount: oldRows.length,
      newCount: rowsAligned.length,
      added: diff.added.slice(0, 10),
      removed: diff.removed.slice(0, 10),
      modified: diff.modified.slice(0, 10),
      summary,
      fieldChanges: fieldChanges.slice(0, 20), // 机器可读字段级记录（AI 成本控制：规则先行，AI 后置）
      insight
    };
    list.unshift(record);
    wp_changes[id] = list.slice(0, 20);
    await chrome.storage.local.set({ wp_changes });
    try {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    } catch (e) { /* ignore */ }
    // Webhook 变化推送（失败不影响监控本身）
    notifyWebhook(t, record).catch(() => {});
  }

  wp_monitors[id] = t;
  await chrome.storage.local.set({ wp_monitors });
}

/* ---------------- Webhook 变化推送 ---------------- */

/** 按 URL 识别目标平台，生成对应机器人的消息格式 */
function webhookPayload(url, text, data) {
  try {
    const host = new URL(url).host;
    if (/feishu|larksuite/i.test(host)) return { msg_type: 'text', content: { text } };
    if (/dingtalk/i.test(host)) return { msgtype: 'text', text: { content: text } };
    if (/qyapi\.weixin/i.test(host)) return { msgtype: 'text', text: { content: text } };
    if (/slack/i.test(host)) return { text };
  } catch (e) { /* ignore */ }
  return data; // 自定义接收端：完整结构化 JSON
}

function buildChangeText(t, rec) {
  const lines = [
    '【WebPilot AI · 竞争对手变化】',
    '监控：' + t.name,
    '时间：' + new Date(rec.time).toLocaleString('zh-CN'),
    '分类：' + ((rec.insight && rec.insight.category) || []).join('/') || '内容',
    '变化：'
  ];
  (rec.summary || []).forEach((s) => lines.push('· ' + s));
  if (rec.insight && rec.insight.guess && rec.insight.guess.length) {
    lines.push('初步推断：' + rec.insight.guess[0]);
  }
  lines.push('页面：' + t.url);
  return lines.join('\n');
}

async function postWebhook(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('Webhook 返回 ' + res.status + (t ? ': ' + t.slice(0, 120) : ''));
  }
}

async function notifyWebhook(t, rec) {
  const { wp_settings = {} } = await chrome.storage.local.get('wp_settings');
  const url = wp_settings.webhookUrl;
  if (!url) return;
  const text = buildChangeText(t, rec);
  const data = {
    event: 'webpilot.change',
    monitor: t.name,
    pageUrl: t.url,
    time: rec.time,
    summary: rec.summary,
    insight: rec.insight,
    oldCount: rec.oldCount,
    newCount: rec.newCount
  };
  await postWebhook(url, webhookPayload(url, text, data));
}

async function sendWebhookTest(url) {
  const payload = webhookPayload(
    url,
    'WebPilot AI 测试消息：Webhook 配置成功，监控到有意义的变化时将推送到这里。',
    { event: 'webpilot.test', time: Date.now() }
  );
  await postWebhook(url, payload);
}

/** 把字段级 diff 转成人类可读的“究竟改了什么”摘要行 */
function summarizeDiff(headers, d, limit = 6) {
  const colName = (i) => (headers && headers[i]) || '列' + (i + 1);
  const lines = [];
  for (const m of d.modified.slice(0, limit)) {
    for (const c of m.cells.slice(0, 3)) {
      const oldV = m.old[c] || '（空）';
      const newV = m.new[c] || '（空）';
      lines.push('「' + colName(c) + '」 ' + oldV.slice(0, 40) + ' → ' + newV.slice(0, 40));
    }
  }
  if (d.added.length) {
    lines.push(
      '新增 ' + d.added.length + ' 条' +
      (d.added[0] ? '，如：' + d.added[0].join(' | ').slice(0, 100) : '')
    );
  }
  if (d.removed.length) {
    lines.push(
      '移除 ' + d.removed.length + ' 条' +
      (d.removed[0] ? '，如：' + d.removed[0].join(' | ').slice(0, 100) : '')
    );
  }
  return lines;
}

/**
 * 变化分类：价格/套餐、功能、招聘、内容
 * 对应产品机会一“监控具体业务字段”
 */
function classifyChanges(headers, d) {
  const colName = (i) => (headers && headers[i]) || '列' + (i + 1);
  const texts = [];
  for (const m of d.modified) {
    for (const c of m.cells) {
      texts.push(colName(c), m.old[c], m.new[c]);
    }
  }
  for (const r of d.added) texts.push(...r);
  for (const r of d.removed) texts.push(...r);
  const joined = texts.join(' ');
  const cats = new Set();
  if (/招聘|职位|岗位|薪资|job|hiring|career/i.test(joined)) cats.add('招聘');
  if (/价格|定价|费用|套餐|方案|免费版|专业版|企业版|订阅|price|pricing|plan|tier/i.test(joined)) cats.add('价格/套餐');
  if (/功能|API|接口|集成|SSO|支持|上线|发布|feature|integrate|launch/i.test(joined)) cats.add('功能');
  if (!cats.size) cats.add('内容');
  return Array.from(cats);
}

/**
 * 字段级变化记录（结构化）：
 * 变化识别不比较整个 HTML，而是按字段值输出机器可读记录——
 * { field, old_value, new_value, change_type, changed_at }
 * change_type 由确认后的字段类型驱动：price → price_increase / price_decrease
 */
function buildFieldChanges(fields, headers, d, now) {
  const aligned = fields && fields.length && headers && fields.length === headers.length;
  const nameOf = (i) =>
    (aligned && fields[i] && fields[i].name) || (headers && headers[i]) || '列' + (i + 1);
  const typeOf = (i) => (aligned && fields[i] && fields[i].type) || 'text';
  const num = (v) => parseFloat(String(v || '').replace(/[^\d.]/g, ''));
  const day = new Date(now).toISOString().slice(0, 10);
  const out = [];
  for (const m of d.modified) {
    for (const c of m.cells) {
      const o = String(m.old[c] == null ? '' : m.old[c]).trim();
      const n = String(m.new[c] == null ? '' : m.new[c]).trim();
      let changeType = 'value_changed';
      if (typeOf(c) === 'price') {
        const po = num(o);
        const pn = num(n);
        if (!isNaN(po) && !isNaN(pn) && pn !== po) {
          changeType = pn > po ? 'price_increase' : 'price_decrease';
        }
      }
      out.push({
        field: nameOf(c),
        old_value: o.slice(0, 120),
        new_value: n.slice(0, 120),
        change_type: changeType,
        changed_at: day
      });
    }
  }
  for (const a of d.added) {
    out.push({
      field: '__row__',
      old_value: '',
      new_value: a.join(' | ').slice(0, 120),
      change_type: 'row_added',
      changed_at: day
    });
  }
  for (const r of d.removed) {
    out.push({
      field: '__row__',
      old_value: r.join(' | ').slice(0, 120),
      new_value: '',
      change_type: 'row_removed',
      changed_at: day
    });
  }
  return out;
}

/**
 * 规则层洞察引擎 v2（无需 AI）：
 * 变化分类 + 幅度量化（如“价格上涨 20%”）+ 事实 + 推断假设，全部附证据
 */
function buildInsight(headers, d, fields) {
  const colName = (i) => (headers && headers[i]) || '列' + (i + 1);
  const facts = [];
  let priceUp = null;
  let priceDown = null;

  // 用户确认的字段类型是最可靠的信号：type === 'price' 直接判定价格列
  const priceFields = new Set(
    (fields || []).filter((f) => f && f.type === 'price').map((f) => String(f.name || '').trim())
  );

  // 值本身长得像价格（带货币符号或两位小数）时，即使列名不含“价格”也能识别
  const looksPrice = (v) =>
    /^[$￥€£]\s*[\d.,]+$/.test(v) || /^\d+\.\d{2}$/.test(v);

  for (const m of d.modified) {
    for (const c of m.cells) {
      const h = colName(c);
      const o = String(m.old[c] || '').trim();
      const n = String(m.new[c] || '').trim();
      const po = parseFloat(o.replace(/[^\d.]/g, ''));
      const pn = parseFloat(n.replace(/[^\d.]/g, ''));
      if (
        (/价格|price|定价|费用|plan|套餐|版/i.test(h) ||
          priceFields.has(h) ||
          (looksPrice(o) && looksPrice(n))) &&
        !isNaN(po) && !isNaN(pn)
      ) {
        if (pn > po) priceUp = { field: h, o, n, pct: Math.round(((pn - po) / po) * 100) };
        else if (pn < po) priceDown = { field: h, o, n, pct: Math.round(((po - pn) / po) * 100) };
      }
    }
  }

  if (priceUp) facts.push('价格上涨 ' + priceUp.pct + '%：' + priceUp.field + ' 从 ' + priceUp.o + ' 调整为 ' + priceUp.n);
  if (priceDown) facts.push('价格下调 ' + priceDown.pct + '%：' + priceDown.field + ' 从 ' + priceDown.o + ' 调整为 ' + priceDown.n);
  if (d.added.length) {
    facts.push('新增 ' + d.added.length + ' 条内容' + (d.added[0] ? '（如：' + d.added[0].join(' | ').slice(0, 80) + '）' : ''));
  }
  if (d.removed.length) {
    facts.push('移除 ' + d.removed.length + ' 条内容' + (d.removed[0] ? '（如：' + d.removed[0].join(' | ').slice(0, 80) + '）' : ''));
  }

  const guess = [];
  if (priceUp && d.added.length) {
    guess.push('同时出现“提价 ' + priceUp.pct + '%”与“新增内容”，可能意味着产品/定价策略调整，或正在向更高价值客户群转型，建议核对新增内容是否面向企业级客户');
  } else if (priceUp && d.removed.length) {
    guess.push('提价 ' + priceUp.pct + '% 同时缩减内容，可能是“涨价+减配”，需关注老客户流失风险');
  } else if (priceUp) {
    guess.push('价格上涨 ' + priceUp.pct + '%，可能意味着产品价值主张调整、功能增强或成本传导');
  } else if (priceDown) {
    guess.push('价格下调 ' + priceDown.pct + '%，可能意味着竞争压力加大、促销活动开始或切入低价市场');
  } else if (d.added.length) {
    guess.push('新增内容，可能意味着功能扩展、新品上架或内容更新');
  } else if (d.removed.length) {
    guess.push('内容被移除，可能意味着功能下线、商品停售或页面改版');
  }
  return { facts, guess, category: classifyChanges(headers, d) };
}

chrome.alarms.onAlarm.addListener((al) => {
  if (al.name && al.name.startsWith(MON_PREFIX)) {
    checkMonitor(al.name.slice(MON_PREFIX.length)).catch(() => {});
  } else if (al.name === REPORT_ALARM) {
    generateReport().catch(() => {});
  }
});

/* ---------------- 每周竞争对手变化报告 ---------------- */
const REPORT_ALARM = 'wp-weekly-report';

function ensureWeeklyAlarm() {
  chrome.alarms.get(REPORT_ALARM, (a) => {
    if (!a) {
      chrome.alarms.create(REPORT_ALARM, {
        delayInMinutes: 60,
        periodInMinutes: 7 * 24 * 60
      });
    }
  });
}

chrome.runtime.onInstalled.addListener(ensureWeeklyAlarm);

function buildWeekRaw(wp_monitors, wp_changes, weekAgo) {
  const parts = [];
  let total = 0;
  const touchedSet = new Set();
  for (const id of Object.keys(wp_monitors)) {
    const t = wp_monitors[id];
    const list = (wp_changes[id] || []).filter((c) => c.time >= weekAgo);
    const competitor = competitorOf(t.url);
    if (list.length) {
      total += list.length;
      touchedSet.add(competitor);
    }
    parts.push({
      name: t.name,
      url: t.url,
      interval: t.intervalMin,
      competitor,
      changes: list
    });
  }
  return { sections: parts, total, touched: Array.from(touchedSet) };
}

/** 竞争对手识别：以域名（去 www）为单位聚合，对齐 CI 工具的组织方式 */
function competitorOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch (e) {
    return url || '未知来源';
  }
}

/** 生成周报：规则摘要保底 + AI 商业解读（可选） */
async function generateReport(useLLM = true) {
  ensureWeeklyAlarm();
  const { wp_monitors = {}, wp_changes = {} } = await chrome.storage.local.get([
    'wp_monitors',
    'wp_changes'
  ]);
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  const { sections, total, touched } = buildWeekRaw(wp_monitors, wp_changes, weekAgo);
  const active = sections.filter((s) => s.changes.length);

  // 按“竞争对手”（域名）聚合——对齐 CI 工具（Crayon/Klue）的组织方式
  const byComp = {};
  for (const s of sections) {
    (byComp[s.competitor] = byComp[s.competitor] || []).push(s);
  }
  const activeComps = Object.keys(byComp).filter((k) => byComp[k].some((s) => s.changes.length));

  let summary =
    '# WebPilot AI 每周竞争对手变化报告\n\n生成时间：' +
    new Date(now).toLocaleString('zh-CN') + '\n\n## 概览\n' +
    '共监控 ' + sections.length + ' 个页面、' + Object.keys(byComp).length +
    ' 家竞争对手，其中 ' + activeComps.length + ' 家本周有动作，合计 ' + total + ' 次变化。\n';
  if (!active.length) {
    summary += '\n本周所有监控页面均无变化。\n';
  }
  for (const comp of activeComps) {
    summary += '\n## ' + comp + '\n';
    for (const s of byComp[comp].filter((x) => x.changes.length)) {
      summary += '### ' + s.name + '\n';
      for (const c of s.changes) {
        summary += '- ' + new Date(c.time).toLocaleString('zh-CN') + '：';
        if (c.summary && c.summary.length) {
          summary += c.summary.join('；');
        } else {
          // 兼容旧记录
          summary += '数据从 ' + c.oldCount + ' 行变为 ' + c.newCount + ' 行';
          if (c.added && c.added.length) {
            summary += '，新增示例：' + c.added.map((r) => r.join(' | ')).join(' / ').slice(0, 200);
          }
          if (c.removed && c.removed.length) {
            summary += '，移除示例：' + c.removed.map((r) => r.join(' | ')).join(' / ').slice(0, 120);
          }
        }
        summary += '\n';
      }
      const withGuess = s.changes.find((c) => c.insight && c.insight.guess && c.insight.guess.length);
      if (withGuess) {
        summary += '\n> 规则推断：' + withGuess.insight.guess[0] + '\n';
      }
    }
  }

  let analysis = null;
  if (useLLM && active.length) {
    try {
      analysis = await llmChat([
        {
          role: 'system',
          content:
            '你是竞争对手分析顾问。用户不想被反复提醒“网页变了”，而是想知道竞争对手究竟改变了什么、以及背后的战略意图。' +
            '写作要求：1）把同一竞争对手的多条变化组合起来解释，而不是逐条罗列；' +
            '2）每个推断必须引用变化中的具体数字/内容作为依据；' +
            '3）参考句式：“竞争对手将专业版价格从 $29 调整到 $39，同时新增了 SSO 功能。这可能意味着它正在向中大型企业市场转型。”' +
            '报告包含三部分：' +
            '“## 重点变化解读”（按竞争对手分组、按重要性排序，先说改动再说推断）、' +
            '“## 对业务的影响”、“## 建议行动”（最多3条，明确该关注什么、何时跟进）。' +
            '忽略无意义的细节变化，聚焦价格、商品、文案、促销等有商业含义的改动。不要编造数据中没有的信息。'
        },
        {
          role: 'user',
          content:
            '本周监控到 ' + total + ' 次变化，涉及 ' + touched.length + ' 家竞争对手：' + touched.join('、') +
            '。字段级变化记录如下（按竞争对手聚合）：\n' +
            activeComps
              .map((comp) =>
                '【' + comp + '】\n' +
                byComp[comp]
                  .filter((s) => s.changes.length)
                  .map((s) =>
                    '(' + s.name + ')\n' +
                    s.changes
                      .map((c) =>
                        '- ' + new Date(c.time).toLocaleString('zh-CN') + ' [' +
                        ((c.insight && c.insight.category) || []).join('/') + '] ' +
                        (c.summary && c.summary.length
                          ? c.summary.join('；')
                          : c.oldCount + '→' + c.newCount + ' 行') +
                        (c.insight && c.insight.guess && c.insight.guess.length
                          ? '（规则初步推断：' + c.insight.guess[0] + '）'
                          : '')
                      )
                      .join('\n')
                  )
                  .join('\n')
              )
              .join('\n\n')
        }
      ]);
    } catch (e) {
      analysis = null; // AI 不可用时降级为规则摘要
    }
  }

  const report = {
    id: 'r' + now,
    time: now,
    summary,
    analysis,
    llm: !!analysis,
    totalChanges: total,
    monitorCount: sections.length
  };
  const { wp_reports = [] } = await chrome.storage.local.get('wp_reports');
  wp_reports.unshift(report);
  await chrome.storage.local.set({ wp_reports: wp_reports.slice(0, 12) });
  return report;
}

/* ---------------- 从网址创建监控（切入场景：SaaS 竞争对手定价与功能监控） ---------------- */

/** 抓取网址并识别页面中的数据表格候选 */
async function scanUrlTables(url) {
  const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error('页面请求失败 ' + res.status + '（可能不是公开可访问页面）');
  const html = await res.text();
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_SCAN_TABLES', html });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || '页面解析失败');
  return resp.tables || [];
}

async function addUrlMonitor(m) {
  const url = String(m.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('请填写有效的 http(s) 网址');
  if (!m.selector || !Array.isArray(m.rows)) throw new Error('监控配置不完整');
  const plan = await getPlan();
  const { wp_monitors = {} } = await chrome.storage.local.get('wp_monitors');
  if (Object.keys(wp_monitors).length >= plan.maxMonitors) {
    throw new Error(plan.label + ' 套餐最多 ' + plan.maxMonitors + ' 个监控页面，请先删除部分监控或升级套餐');
  }
  const id = 'm' + Date.now().toString(36);
  const mins = Math.max(plan.minIntervalMin, parseInt(m.intervalMin, 10) || plan.minIntervalMin);
  wp_monitors[id] = {
    id,
    name: m.name || competitorOf(url) + ' · ' + m.rows.length + ' 行数据',
    url,
    config: {
      mode: 'table',
      tableSelector: m.selector,
      xpath: m.xpath || undefined,
      textAnchor: m.textAnchor && m.textAnchor.text ? m.textAnchor : undefined,
      expectedCols: m.expectedCols
    },
    headers: m.headers || [],
    fields: Array.isArray(m.fields) ? m.fields : [], // 稳定字段 ID：历史对比的锚点
    intervalMin: mins,
    created: Date.now(),
    lastChecked: Date.now(),
    lastStatus: 'ok',
    lastRows: m.rows // 当前快照作为基线，首轮检查不会误报“全部新增”
  };
  await chrome.storage.local.set({ wp_monitors });
  chrome.alarms.create(MON_PREFIX + id, {
    delayInMinutes: mins,
    periodInMinutes: mins
  });
  return id;
}

/* ---------------- 消息路由 ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  if (msg.type === 'OFFSCREEN_EXTRACT') return false; // 由 offscreen 文档处理

  (async () => {
    try {
      if (msg.type === 'LLM_CHAT') {
        sendResponse({ ok: true, text: await llmChat(msg.messages) });
      } else if (msg.type === 'CHECK_MONITOR') {
        await checkMonitor(msg.id);
        sendResponse({ ok: true });
      } else if (msg.type === 'GENERATE_REPORT') {
        const report = await generateReport(msg.useLLM !== false);
        sendResponse({ ok: true, report });
      } else if (msg.type === 'TEST_WEBHOOK') {
        await sendWebhookTest(msg.url);
        sendResponse({ ok: true });
      } else if (msg.type === 'SCAN_URL_TABLES') {
        // 切入场景第 1-2 步：用户粘贴竞争对手网址 → 抓取 → 识别表格/字段候选
        sendResponse({ ok: true, tables: await scanUrlTables(msg.url) });
      } else if (msg.type === 'ADD_URL_MONITOR') {
        // 第 3 步：用户确认表格与字段后创建监控（当前快照作为基线，不产生首轮“新增”误报）
        sendResponse({ ok: true, id: await addUrlMonitor(msg) });
      } else {
        sendResponse({ ok: false, error: '未知指令: ' + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    }
  })();
  return true;
});
