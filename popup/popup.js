/** WebPilot AI 弹出窗口逻辑 */
const $ = (s) => document.querySelector(s);
let draft = null;
let monitors = {};
let changes = {};
let job = null;
let tables = [];

/* ---------------- 套餐计划（优先服务端下发 serverPlan，未绑定时回退本地模拟） ---------------- */
const PLANS = {
  free: {
    label: 'Free',
    maxMonitors: 3,
    minIntervalMin: 1440,
    historyDays: 7,
    upgrade: '升级 Pro（$12/月）：30 个监控页面、每日自动检查、AI 变化分析、90 天历史'
  },
  pro: {
    label: 'Pro',
    maxMonitors: 30,
    minIntervalMin: 60,
    historyDays: 90,
    upgrade: '升级 Team（$29/月）：100 个监控页面、365 天历史、Google Sheets 同步、3 个成员'
  },
  team: {
    label: 'Team',
    maxMonitors: 100,
    minIntervalMin: 30,
    historyDays: 365,
    upgrade: ''
  }
};

async function getPlanLocal() {
  const { wp_settings = {} } = await chrome.storage.local.get('wp_settings');
  // 已绑定云端账号：以服务端下发的套餐为准（升级/降级自动生效）
  if (wp_settings.serverPlan && wp_settings.serverPlan.maxMonitors) {
    const sp = wp_settings.serverPlan;
    const local = PLANS[Object.keys(PLANS).find((k) => PLANS[k].label === sp.label) || 'free'];
    return { label: sp.label, maxMonitors: sp.maxMonitors, minIntervalMin: sp.minIntervalMin, historyDays: sp.historyDays, upgrade: local ? local.upgrade : '请到网页端升级套餐' };
  }
  return PLANS[wp_settings.plan] || PLANS.free;
}

async function renderQuota() {
  const plan = await getPlanLocal();
  const { wp_monitors = {} } = await chrome.storage.local.get('wp_monitors');
  const el = $('#quota');
  if (!el) return;
  const used = Object.keys(wp_monitors).length;
  el.textContent = plan.label + ' · 监控 ' + used + '/' + plan.maxMonitors;
  el.classList.toggle('full', used >= plan.maxMonitors);
}

/** 监控创建前的套餐校验；返回可用的频率（分钟），失败返回 null */
async function checkMonitorPlan(intervalMin) {
  const plan = await getPlanLocal();
  const { wp_monitors = {} } = await chrome.storage.local.get('wp_monitors');
  if (Object.keys(wp_monitors).length >= plan.maxMonitors) {
    setStatus(plan.label + ' 套餐最多 ' + plan.maxMonitors + ' 个监控页面。' + plan.upgrade, true);
    return null;
  }
  const mins = Math.max(intervalMin, plan.minIntervalMin);
  if (mins !== intervalMin) {
    setStatus(plan.label + ' 套餐检查频率为每 ' + plan.minIntervalMin + ' 分钟一次，已自动调整。' + plan.upgrade, true);
  }
  return mins;
}

/* ---------------- 工具 ---------------- */
function setStatus(t, isErr) {
  const el = $('#status');
  el.textContent = t || '';
  el.classList.toggle('err', !!isErr);
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    return x.host + x.pathname.slice(0, 40);
  } catch (e) {
    return u || '';
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendTab(msg) {
  const tab = await getActiveTab();
  if (!tab) throw new Error('未找到活动标签页');
  if (!/^https?:/i.test(tab.url || '')) {
    throw new Error('仅支持 http/https 网页，请先打开目标网站');
  }
  return chrome.tabs.sendMessage(tab.id, msg);
}

function genericHeaders(n) {
  return Array.from({ length: n }, (_, i) => '列' + (i + 1));
}

function headersOf(d) {
  return d.headers && d.headers.length && d.headers.length === (d.rows[0] || []).length
    ? d.headers
    : genericHeaders((d.rows[0] || []).length);
}

async function saveDraft() {
  await chrome.storage.local.set({ wp_draft: draft });
}

async function loadAll() {
  const st = await chrome.storage.local.get(['wp_draft', 'wp_monitors', 'wp_changes', 'wp_paginationJob']);
  draft = st.wp_draft || null;
  monitors = st.wp_monitors || {};
  changes = st.wp_changes || {};
  job = st.wp_paginationJob || null;
}

/* ---------------- 字段确认（稳定字段 ID：历史对比的锚点） ---------------- */
const FIELD_TYPES = ['text', 'price', 'date', 'number', 'link'];
const TYPE_LABELS = { text: '文本', price: '价格', date: '日期', number: '数值', link: '链接' };

function guessType(rows, colIdx) {
  const vals = rows
    .map((r) => String(r[colIdx] == null ? '' : r[colIdx]).trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!vals.length) return 'text';
  const money = vals.filter((v) => /^[$￥€£]\s*[\d.,]+$/.test(v) || /^\d+\.\d{2}$/.test(v)).length;
  if (money >= Math.ceil(vals.length * 0.6)) return 'price';
  if (vals.every((v) => /^(19|20)\d{2}[-/.年]|^\d{1,2}\/\d{1,2}/.test(v))) return 'date';
  if (vals.every((v) => /^-?\d+(\.\d+)?$/.test(v))) return 'number';
  return 'text';
}

function initFieldDefs() {
  const hs = headersOf(draft);
  if (draft.fields && draft.fields.length === hs.length) return draft.fields;
  draft.fields = hs.map((h, i) => ({ id: 'f' + i, name: h, type: guessType(draft.rows, i) }));
  return draft.fields;
}

function renderFieldPanel() {
  const panel = $('#fieldPanel');
  if (!draft || !draft.rows || !draft.rows.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const defs = initFieldDefs();
  const hs = headersOf(draft);
  const list = $('#fieldList');
  list.innerHTML = '';
  defs.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'field-row';
    const name = document.createElement('input');
    name.className = 'f-name';
    name.value = f.name;
    name.spellcheck = false;
    name.title = '字段名（可修改）';
    const type = document.createElement('select');
    type.className = 'f-type';
    FIELD_TYPES.forEach((t) => {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = TYPE_LABELS[t];
      if (t === f.type) o.selected = true;
      type.appendChild(o);
    });
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = '原表头: ' + (hs[i] || '-') + (draft.fieldsConfirmed ? ' · 已确认' : '');
    row.appendChild(name);
    row.appendChild(type);
    row.appendChild(hint);
    list.appendChild(row);
  });
}

$('#btnFieldConfirm').onclick = async () => {
  if (!draft || !draft.rows.length) return setStatus('请先提取数据', true);
  const defs = initFieldDefs();
  document.querySelectorAll('#fieldList .field-row').forEach((row, i) => {
    if (!defs[i]) return;
    const n = row.querySelector('.f-name').value.trim();
    if (n) defs[i].name = n;
    defs[i].type = row.querySelector('.f-type').value;
  });
  draft.fields = defs;
  draft.headers = defs.map((f) => f.name);
  draft.fieldsConfirmed = true;
  await saveDraft();
  renderPreview();
  setStatus('字段已确认。保存监控后将按字段对齐历史数据——页面列序调整、表头改名均不影响对比');
};

/* ---------------- 渲染 ---------------- */
function renderPreview() {
  const wrap = $('#previewWrap');
  if (!draft || !draft.rows || !draft.rows.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  draft.headers = headersOf(draft).slice();
  renderFieldPanel();
  const table = $('#preview');
  table.innerHTML = '';

  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  draft.headers.forEach((h, i) => {
    const th = document.createElement('th');
    th.textContent = h;
    th.contentEditable = 'true';
    th.spellcheck = false;
    th.addEventListener('blur', () => {
      draft.headers[i] = th.textContent.trim();
      saveDraft();
    });
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  draft.rows.slice(0, 100).forEach((r) => {
    const tr = document.createElement('tr');
    draft.headers.forEach((_, i) => {
      const td = document.createElement('td');
      td.textContent = r[i] == null ? '' : r[i];
      td.title = r[i] == null ? '' : String(r[i]);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  $('#rowCount').textContent =
    '共 ' + draft.rows.length + ' 行 × ' + draft.headers.length + ' 列' +
    (draft.rows.length > 100 ? '（预览前 100 行）' : '') +
    (draft.sourceUrl ? '　来源: ' + shortUrl(draft.sourceUrl) : '');
}

function fmtTime(t) {
  return t ? new Date(t).toLocaleString('zh-CN') : '—';
}

function competitorOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch (e) {
    return url || '未知来源';
  }
}

function renderMonitors() {
  const ids = Object.keys(monitors);
  const list = $('#monitorList');
  list.innerHTML = '';

  // 按竞争对手（域名）分组——对齐 CI 工具的组织方式
  const groups = {};
  ids.forEach((id) => {
    const host = competitorOf(monitors[id].url);
    (groups[host] = groups[host] || []).push(id);
  });

  for (const host of Object.keys(groups)) {
    const gt = document.createElement('div');
    gt.className = 'mon-group';
    const changed = groups[host].some((id) => (changes[id] || []).length);
    gt.textContent = host + '（' + groups[host].length + ' 个监控）' + (changed ? ' · 有变化' : '');
    if (changed) gt.classList.add('changed');
    list.appendChild(gt);

    groups[host].forEach((id) => {
      const t = monitors[id];
      const div = document.createElement('div');
      div.className = 'mon';

    const head = document.createElement('div');
    head.className = 'mon-head';
    const b = document.createElement('b');
    b.textContent = t.name;
    const del = document.createElement('button');
    del.className = 'small danger';
    del.textContent = '删除';
    del.onclick = async () => {
      delete monitors[id];
      await chrome.storage.local.set({ wp_monitors: monitors });
      const c = await chrome.storage.local.get('wp_changes');
      if (c.wp_changes && c.wp_changes[id]) {
        delete c.wp_changes[id];
        await chrome.storage.local.set({ wp_changes: c.wp_changes });
      }
      await chrome.alarms.clear('wp-mon-' + id);
      loadAll().then(() => {
        renderMonitors();
        renderQuota();
      });
    };
    head.appendChild(b);
    head.appendChild(del);
    div.appendChild(head);

    const url = document.createElement('div');
    url.className = 'hint';
    url.textContent = shortUrl(t.url) + ' · ' + '每 ' + t.intervalMin + ' 分钟 · 上次检查 ' + fmtTime(t.lastChecked);
    div.appendChild(url);

    if (t.lastStatus === 'selector_broken') {
      const warn = document.createElement('div');
      warn.className = 'mon-warning';
      warn.textContent = '⚠ 页面结构可能已改版，提取定位失效。请打开页面重新「智能选择提取」，再重新保存监控任务。';
      div.appendChild(warn);
    } else if (t.needsReconfigure) {
      const warn = document.createElement('div');
      warn.className = 'mon-warning';
      warn.textContent = '⚠ 上次检查通过备用定位提取成功（页面可能已改版），建议重新设定提取目标。';
      div.appendChild(warn);
    }

    const ch = (changes[id] || [])[0];
    const chEl = document.createElement('div');
    chEl.className = 'mon-change' + (ch ? '' : ' none');
    if (ch) {
      const lines = ch.summary && ch.summary.length
        ? ch.summary.join('；')
        : ch.oldCount + ' → ' + ch.newCount + ' 行';
      const cat = ch.insight && ch.insight.category && ch.insight.category.length
        ? '【' + ch.insight.category.join('/') + '】'
        : '';
      chEl.textContent = cat + '具体变化 ' + fmtTime(ch.time) + '：' + lines;
      chEl.title = chEl.textContent;
      div.appendChild(chEl);
      if (ch.insight && ch.insight.guess && ch.insight.guess.length) {
        const g = document.createElement('div');
        g.className = 'mon-guess';
        g.textContent = '初步推断：' + ch.insight.guess[0];
        div.appendChild(g);
      }
    } else {
      chEl.textContent = '暂未检测到有意义的变化';
      div.appendChild(chEl);
    }

    const aiEl = document.createElement('div');
    aiEl.className = 'hint';
    div.appendChild(aiEl);

    const row = document.createElement('div');
    row.className = 'row';
    const chk = document.createElement('button');
    chk.className = 'small';
    chk.textContent = '立即检查';
    chk.onclick = async () => {
      chk.disabled = true;
      chk.textContent = '检查中…';
      try {
        const r = await chrome.runtime.sendMessage({ type: 'CHECK_MONITOR', id });
        if (!r || !r.ok) throw new Error((r && r.error) || '检查失败');
        await loadAll();
        renderMonitors();
        setStatus('检查完成');
      } catch (e) {
        setStatus('检查失败: ' + e.message, true);
        chk.disabled = false;
        chk.textContent = '立即检查';
      }
    };
    const ai = document.createElement('button');
    ai.className = 'small';
    ai.textContent = 'AI 解读：改了什么';
    ai.onclick = async () => {
      const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
      const recent = (changes[id] || []).filter((c) => c.time >= weekAgo);
      if (!recent.length) {
        setStatus('近 7 天暂无变化记录可解读', true);
        return;
      }
      ai.disabled = true;
      ai.textContent = '解读中…';
      try {
        const lines = recent
          .map((c) =>
            '- ' + fmtTime(c.time) + '：' +
            ((c.summary && c.summary.length) ? c.summary.join('；') : c.oldCount + '→' + c.newCount + ' 行') +
            (c.insight && c.insight.guess && c.insight.guess.length
              ? '（规则初步推断：' + c.insight.guess[0] + '）'
              : '')
          )
          .join('\n');
        const r = await chrome.runtime.sendMessage({
          type: 'LLM_CHAT',
          messages: [
            {
              role: 'system',
              content:
                '你是竞争对手分析助手。用户不想被反复提醒“网页变了”，而是想知道竞争对手究竟改变了什么、背后的战略意图是什么。' +
                '请把多条变化组合起来解释，每个推断引用具体数字作为依据。参考句式：' +
                '“竞争对手将专业版价格从 $29 调整到 $39，同时新增了 SSO 功能。这可能意味着它正在向中大型企业市场转型。”' +
                '输出不超过 5 句：1）具体做了什么改动（组合表述）；2）这组变化可能意味着什么；3）最应该关注/跟进的一点。不要编造数据中没有的信息。'
            },
            {
              role: 'user',
              content: '监控任务「' + t.name + '」近 7 天的字段级变化：\n' + lines
            }
          ]
        });
        if (!r || !r.ok) throw new Error((r && r.error) || 'AI 调用失败');
        aiEl.textContent = r.text;
      } catch (e) {
        setStatus('AI 解读失败: ' + e.message, true);
      }
      ai.disabled = false;
      ai.textContent = 'AI 解读：改了什么';
    };
    const hist = document.createElement('button');
    hist.className = 'small';
    hist.textContent = '导出变化历史';
    hist.onclick = async () => {
      const recs = changes[id] || [];
      if (!recs.length) return setStatus('该监控暂无变化记录', true);
      const esc = (v) => {
        v = v == null ? '' : String(v);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      };
      const rows = [['时间', '分类', '变化明细', '初步推断', '行数变化']];
      recs.forEach((r) => {
        rows.push([
          new Date(r.time).toLocaleString('zh-CN'),
          (r.insight && r.insight.category || []).join('/'),
          (r.summary || []).join('；'),
          (r.insight && r.insight.guess || []).join(' '),
          r.oldCount + '→' + r.newCount
        ]);
      });
      const csv = '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
      download(
        'webpilot-history-' + competitorOf(t.url) + '-' + new Date().toISOString().slice(0, 10) + '.csv',
        'text/csv;charset=utf-8',
        csv
      );
      setStatus('变化历史已导出');
    };
    row.appendChild(chk);
    row.appendChild(ai);
    row.appendChild(hist);
    div.appendChild(row);
    list.appendChild(div);
    });
  }
}

/* ---------------- 提取动作 ---------------- */
$('#btnPick').onclick = async () => {
  try {
    await sendTab({ type: 'START_PICK' });
    setStatus('请在页面上点击要提取的条目（如列表第一项），按 ESC 取消');
  } catch (e) {
    setStatus(e.message, true);
  }
};

$('#btnScan').onclick = async () => {
  try {
    const tab = await getActiveTab();
    const r = await sendTab({ type: 'GET_TABLES' });
    tables = r.tables || [];
    if (!tables.length) {
      setStatus('未检测到数据表格，可尝试「智能选择提取」', true);
      return;
    }
    $('#tableListWrap').hidden = false;
    const sel = $('#tableSelect');
    sel.innerHTML = '';
    tables.forEach((t, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = '表格 ' + (i + 1) + '：' + t.total + ' 行 × ' + t.cols + ' 列' +
        (t.headers.length ? '（' + t.headers.slice(0, 3).join('/') + '）' : '');
      sel.appendChild(o);
    });
    sel.onchange = () => pickTable(parseInt(sel.value, 10), tab.url);
    pickTable(0, tab.url);
    setStatus('检测到 ' + tables.length + ' 个表格');
  } catch (e) {
    setStatus(e.message, true);
  }
};

function pickTable(i, sourceUrl) {
  const t = tables[i];
  if (!t) return;
  draft = {
    mode: 'table',
    config: { mode: 'table', tableSelector: t.selector },
    headers: t.headers.slice(),
    rows: t.rows.map((r) => r.slice()),
    sourceUrl,
    time: Date.now()
  };
  saveDraft().then(renderPreview);
}

/* 监听拾取结果（popup 保持打开时） */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return false;
  if (msg.type === 'PICK_RESULT') {
    if (msg.error) {
      setStatus('拾取失败: ' + msg.error, true);
    } else {
      loadAll().then(() => {
        renderPreview();
        setStatus('提取成功：' + draft.rows.length + ' 行。可导出、批量分页或保存监控。');
      });
    }
  } else if (msg.type === 'PICK_CANCELLED') {
    setStatus('已取消拾取');
  }
  return false;
});

/* ---------------- AI 字段命名 ---------------- */
$('#btnAI').onclick = async () => {
  if (!draft || !draft.rows.length) {
    setStatus('请先提取数据', true);
    return;
  }
  setStatus('AI 识别字段中…');
  const hs = headersOf(draft);
  const sample = draft.rows
    .slice(0, 8)
    .map((r) => hs.map((h, i) => h + ': ' + (r[i] == null ? '' : r[i])).join(' | '))
    .join('\n');
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'LLM_CHAT',
      messages: [
        { role: 'system', content: '你是数据字段命名助手。根据表格样本推断每列含义，只输出 JSON 字符串数组，不要输出其他内容。' },
        {
          role: 'user',
          content:
            '现有列名: ' + JSON.stringify(hs) + '\n样本数据:\n' + sample +
            '\n请给出更准确的中文列名数组（长度必须等于列数 ' + hs.length + '）。'
        }
      ]
    });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'AI 调用失败');
    const m = resp.text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('AI 未返回 JSON');
    const names = JSON.parse(m[0]);
    if (Array.isArray(names) && names.length === hs.length) {
      draft.headers = names.map((n) => String(n).slice(0, 20));
      draft.fields = null; // AI 命名只是草稿，需用户在字段确认面板重新确认
      draft.fieldsConfirmed = false;
      await saveDraft();
      renderPreview();
      setStatus('AI 字段命名完成——请在下方字段确认面板核对后点「确认字段」');
    } else {
      setStatus('AI 返回列数不一致，请重试', true);
    }
  } catch (e) {
    setStatus('AI 识别失败: ' + e.message, true);
  }
};

/* ---------------- 批量分页 ---------------- */
$('#btnPage').onclick = async () => {
  try {
    const r = await sendTab({ type: 'START_PAGINATION', maxPages: parseInt($('#maxPages').value, 10) || 10 });
    setStatus(r && r.ok ? r.message || '批量提取已启动' : (r && r.error) || '启动失败', !(r && r.ok));
  } catch (e) {
    setStatus(e.message, true);
  }
};

/* ---------------- 监控 ---------------- */
$('#btnMonitor').onclick = async () => {
  if (!draft || !draft.config) {
    setStatus('请先完成一次提取', true);
    return;
  }
  const tab = await getActiveTab();
  if (!tab || !/^https?:/i.test(tab.url || '')) {
    setStatus('仅支持 http/https 页面', true);
    return;
  }
  // 核心业务流程：AI 识别字段 → 用户确认字段 → 保存监控任务
  if (!draft.fieldsConfirmed || !draft.fields || !draft.fields.length) {
    setStatus('请先在字段确认面板核对字段并点「确认字段」（可直接采用 AI 命名）', true);
    return;
  }
  const mins = await checkMonitorPlan(parseInt($('#monInterval').value, 10) || 60);
  if (mins == null) return;
  const id = 'm' + Date.now();
  monitors[id] = {
    id,
    name: (new URL(tab.url)).hostname + ' · ' + draft.rows.length + ' 行数据',
    url: tab.url,
    config: draft.config,
    headers: draft.headers || [],
    fields: draft.fields, // 稳定字段 ID：后续检查按字段对齐，页面微调不影响历史对比
    intervalMin: mins,
    created: Date.now(),
    lastRows: draft.rows,
    lastChecked: Date.now(),
    lastStatus: 'ok'
  };
  await chrome.storage.local.set({ wp_monitors: monitors });
  try {
    await chrome.alarms.create('wp-mon-' + id, {
      delayInMinutes: Math.max(1, mins),
      periodInMinutes: Math.max(1, mins)
    });
  } catch (e) { /* ignore */ }
  renderMonitors();
  renderQuota();
  setStatus('已保存监控任务，将按设定频率自动检查变化');
};

/* ---------------- 导出 ---------------- */
function download(name, mime, content) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function toCSV(headers, rows) {
  const esc = (v) => {
    v = v == null ? '' : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  return '\uFEFF' + [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
}

function toXlsHtml(headers, rows) {
  const esc = (v) => (v == null ? '' : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;'));
  const trs = [headers, ...rows]
    .map((r) => '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>')
    .join('');
  return (
    '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"></head>' +
    '<body><table border="1">' + trs + '</table></body></html>'
  );
}

function fname(ext) {
  return 'webpilot-' + new Date().toISOString().slice(0, 10) + '.' + ext;
}

$('#btnCsv').onclick = () => {
  if (!draft) return setStatus('无数据可导出', true);
  download(fname('csv'), 'text/csv;charset=utf-8', toCSV(headersOf(draft), draft.rows));
  setStatus('CSV 已导出');
};

$('#btnXlsx').onclick = () => {
  if (!draft) return setStatus('无数据可导出', true);
  download(fname('xls'), 'application/vnd.ms-excel', toXlsHtml(headersOf(draft), draft.rows));
  setStatus('Excel 文件已导出（可用 Excel / WPS 打开）');
};

$('#btnJson').onclick = () => {
  if (!draft) return setStatus('无数据可导出', true);
  const hs = headersOf(draft);
  const arr = draft.rows.map((r) => {
    const o = {};
    hs.forEach((h, i) => (o[h] = r[i] == null ? '' : r[i]));
    return o;
  });
  download(fname('json'), 'application/json', JSON.stringify(arr, null, 2));
  setStatus('JSON 已导出');
};

/* ---------------- 从网址添加竞品监控 ---------------- */
let urlCands = [];

$('#btnScanUrl').onclick = async () => {
  const url = $('#monUrl').value.trim();
  if (!/^https?:\/\//i.test(url)) return setStatus('请填写有效的 http(s) 网址', true);
  const btn = $('#btnScanUrl');
  btn.disabled = true;
  btn.textContent = '扫描中…';
  setStatus('抓取页面并识别数据表格…');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'SCAN_URL_TABLES', url });
    if (!r || !r.ok) throw new Error((r && r.error) || '扫描失败');
    urlCands = r.tables || [];
    if (!urlCands.length) {
      setStatus('未识别到数据表格。该页面可能是动态渲染（SPA），请打开页面后使用「智能选择提取」再保存监控。', true);
      $('#urlTables').hidden = true;
      return;
    }
    const sel = $('#urlTableSelect');
    sel.innerHTML = '';
    urlCands.forEach((c, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = '表格 ' + (i + 1) + '：' + c.rows.length + ' 行 × ' +
        (c.headers.length || (c.rows[0] || []).length) + ' 列';
      sel.appendChild(opt);
    });
    $('#urlTables').hidden = false;
    showUrlPreview();
    setStatus('识别到 ' + urlCands.length + ' 个候选表格，请确认后创建监控');
  } catch (e) {
    setStatus('扫描失败: ' + e.message, true);
  }
  btn.disabled = false;
  btn.textContent = '扫描';
};

function showUrlPreview() {
  const c = urlCands[parseInt($('#urlTableSelect').value, 10) || 0];
  const el = $('#urlPreview');
  if (!c) return (el.textContent = '');
  const headers = c.headers.length ? c.headers : (c.rows[0] || []).map((_, i) => '列' + (i + 1));
  const first = (c.rows[0] || []).map((v, i) => headers[i] + ': ' + String(v == null ? '' : v).slice(0, 25)).join(' | ');
  el.textContent = '字段（可后续在监控中修改）: ' + first;
}

$('#urlTableSelect').onchange = showUrlPreview;

$('#btnCreateUrlMon').onclick = async () => {
  const c = urlCands[parseInt($('#urlTableSelect').value, 10) || 0];
  if (!c) return setStatus('请先扫描并选择表格', true);
  const mins = await checkMonitorPlan(parseInt($('#urlInterval').value, 10) || 60);
  if (mins == null) return;
  const btn = $('#btnCreateUrlMon');
  btn.disabled = true;
  try {
    // 字段定义：按表头自动生成（字段 ID 是历史对比的锚点；类型按数据形态推断）
    const hs = c.headers.length ? c.headers : (c.rows[0] || []).map((_, i) => '列' + (i + 1));
    const fields = hs.map((h, i) => ({ id: 'f' + i, name: h, type: guessType(c.rows, i) }));
    const r = await chrome.runtime.sendMessage({
      type: 'ADD_URL_MONITOR',
      url: $('#monUrl').value.trim(),
      selector: c.selector,
      xpath: c.xpath,
      textAnchor: c.textAnchor,
      expectedCols: c.expectedCols,
      headers: c.headers,
      rows: c.rows,
      fields,
      intervalMin: mins
    });
    if (!r || !r.ok) throw new Error((r && r.error) || '创建失败');
    $('#urlTables').hidden = true;
    $('#monUrl').value = '';
    setStatus('监控已创建，将按设定频率自动检查');
    await loadAll();
    renderMonitors();
    renderQuota();
  } catch (e) {
    setStatus('创建失败: ' + e.message, true);
  }
  btn.disabled = false;
};

/* ---------------- 每周报告 ---------------- */
$('#btnReport').onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('report.html') });
};

$('#btnGenReport').onclick = async () => {
  setStatus('正在生成周报…');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'GENERATE_REPORT' });
    if (!r || !r.ok) throw new Error((r && r.error) || '生成失败');
    setStatus('周报已生成：' + r.report.totalChanges + ' 次变化');
    chrome.tabs.create({ url: chrome.runtime.getURL('report.html') });
  } catch (e) {
    setStatus('周报生成失败: ' + e.message, true);
  }
};

/* ---------------- 初始化 ---------------- */
$('#btnSettings').onclick = () => chrome.runtime.openOptionsPage();

(async () => {
  chrome.action.setBadgeText({ text: '' });
  await loadAll();
  renderQuota();
  renderPreview();
  renderMonitors();
  if (job && job.active) {
    setStatus('批量提取进行中：已完成 ' + job.pagesDone + ' 页，共 ' + job.collected.length + ' 行…');
  } else if (job && job.status === 'done') {
    setStatus('批量提取完成：共 ' + job.collected.length + ' 行');
    if (!draft) {
      draft = {
        mode: 'pick',
        config: job.config,
        headers: job.headers,
        rows: job.collected,
        sourceUrl: job.startUrl,
        time: Date.now()
      };
      await saveDraft();
      renderPreview();
    }
  }
})();
