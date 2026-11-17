/** 每周报告页面逻辑 */
const $ = (s) => document.querySelector(s);

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineMd(s) {
  return s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}

/** 极简 Markdown 渲染（标题/列表/加粗/段落） */
function mdToHtml(md) {
  let html = '';
  for (const line of String(md).split('\n')) {
    const e = escHtml(line);
    if (/^### /.test(e)) html += '<h4>' + inlineMd(e.slice(4)) + '</h4>';
    else if (/^## /.test(e)) html += '<h3>' + inlineMd(e.slice(3)) + '</h3>';
    else if (/^# /.test(e)) html += '<h2>' + inlineMd(e.slice(2)) + '</h2>';
    else if (/^[-*] /.test(e)) html += '<li>' + inlineMd(e.slice(2)) + '</li>';
    else if (e.trim()) html += '<p>' + inlineMd(e) + '</p>';
  }
  return html;
}

/* ---------------- 监控仪表盘 ---------------- */

function lastChangeBadge(ch) {
  if (!ch) return '<span class="meta">暂无变化</span>';
  const cat = (ch.insight && ch.insight.category) || [];
  const guess = (ch.insight && ch.insight.guess) || [];
  const text = (ch.summary && ch.summary.length ? ch.summary[0] : '').slice(0, 60);
  let cls = '';
  if (guess.some((g) => g.includes('提价'))) cls = 'up';
  else if (guess.some((g) => g.includes('降价'))) cls = 'down';
  return (
    (cls ? '<span class="' + cls + '">' + (cls === 'up' ? '▲ 提价' : '▼ 降价') + '</span> ' : '') +
    '<span class="meta">[' + cat.join('/') + '] ' + escHtml(text) + '（' +
    new Date(ch.time).toLocaleDateString('zh-CN') + '）</span>'
  );
}

function renderDashboard(monitors, changes) {
  const sec = $('#dashSection');
  const stats = $('#dashStats');
  const table = $('#dashTable');
  const ids = Object.keys(monitors);
  if (!ids.length) {
    sec.hidden = true;
    return;
  }
  const now = Date.now();
  const dayAgo = now - 24 * 3600 * 1000;
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  const comps = new Set(ids.map((id) => competitorOf(monitors[id].url)));
  const allChanges = ids.flatMap((id) => changes[id] || []);
  const weekCount = allChanges.filter((c) => c.time >= weekAgo).length;
  const dayCount = allChanges.filter((c) => c.time >= dayAgo).length;

  const statDefs = [
    [comps.size, '竞争对手'],
    [ids.length, '监控任务'],
    [weekCount, '本周变化'],
    [dayCount, '24 小时内变化']
  ];
  stats.innerHTML = statDefs
    .map((s) => '<div class="stat"><div class="num">' + s[0] + '</div><div class="lab">' + s[1] + '</div></div>')
    .join('');

  const rows = ids
    .map((id) => ({ t: monitors[id], last: (changes[id] || [])[0] }))
    .sort((a, b) => (b.t.lastChanged || 0) - (a.t.lastChanged || 0));

  table.innerHTML =
    '<thead><tr><th>竞争对手</th><th>频率</th><th>上次检查</th><th>状态</th><th>最近变化</th></tr></thead>' +
    '<tbody>' +
    rows
      .map((r) => {
        const status =
          r.t.lastStatus === 'selector_broken'
            ? '<span class="up">⚠ 定位失效</span>'
            : r.t.needsReconfigure
              ? '<span style="color:#d97706;">⚠ 备用定位</span>'
              : '<span class="down">● 正常</span>';
        return (
          '<tr><td>' + escHtml(competitorOf(r.t.url)) + '<br><span class="meta">' +
          escHtml(String(r.t.url).replace(/^https?:\/\//, '').slice(0, 50)) + '</span></td>' +
          '<td>每 ' + r.t.intervalMin + ' 分钟</td>' +
          '<td>' + new Date(r.t.lastChecked || 0).toLocaleString('zh-CN') + '</td>' +
          '<td>' + status + '</td>' +
          '<td>' + lastChangeBadge(r.last) + '</td></tr>'
        );
      })
      .join('') +
    '</tbody>';
  sec.hidden = false;
}

/* ---------------- 字段追踪历史（历史数据对比 + 趋势） ---------------- */

function numVal(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}

/** 找出适合画趋势的数值列：优先价格类列名，其次任意多数快照可解析数值的列 */
function findTrendCol(mon) {
  const headers = mon.headers || [];
  const hist = mon.history || [];
  const priceRe = /价格|price|定价|费用|plan|套餐|版/i;
  let best = -1;
  let bestScore = -1;
  for (let c = 0; c < headers.length; c++) {
    let ok = 0;
    for (const h of hist) {
      const vs = (h.rows || []).map((r) => numVal(r[c])).filter((v) => v != null);
      if (vs.length) ok++;
    }
    if (ok < Math.min(2, hist.length)) continue;
    const score = ok + (priceRe.test(headers[c]) ? 10 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function svgTrend(points, w, hgt) {
  if (points.length < 2) return null;
  const pad = 12;
  const vals = points.map((p) => p.v);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const xs = points.map((p, i) => pad + (i * (w - pad * 2)) / (points.length - 1));
  const ys = points.map((p) => hgt - pad - ((p.v - min) / span) * (hgt - pad * 2));
  const line = xs.map((x, i) => x.toFixed(1) + ',' + ys[i].toFixed(1)).join(' ');
  const dots = points
    .map(
      (p, i) =>
        '<circle cx="' + xs[i].toFixed(1) + '" cy="' + ys[i].toFixed(1) + '" r="3" fill="#4f46e5"><title>' +
        escHtml(p.label + '：' + p.v) + '</title></circle>'
    )
    .join('');
  const minL = '<text x="' + (w - pad) + '" y="' + (hgt - pad - ((min - min) / span) * (hgt - pad * 2) + 4) +
    '" font-size="10" fill="#6b7280" text-anchor="end">' + min + '</text>';
  const maxL = '<text x="' + (w - pad) + '" y="' + (pad + 2) +
    '" font-size="10" fill="#6b7280" text-anchor="end">' + max + '</text>';
  return (
    '<svg viewBox="0 0 ' + w + ' ' + hgt + '" style="width:100%;height:' + hgt + 'px">' +
    '<polyline points="' + line + '" fill="none" stroke="#4f46e5" stroke-width="2"/>' +
    dots + minL + maxL + '</svg>'
  );
}

function renderHistory(monitors) {
  const sec = $('#historySection');
  const list = $('#historyList');
  list.innerHTML = '';
  let shown = 0;

  Object.keys(monitors).forEach((id) => {
    const t = monitors[id];
    const hist = t.history || [];
    if (!hist.length) return;
    shown++;
    const card = document.createElement('div');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';
    const b = document.createElement('b');
    b.textContent = t.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = hist.length + ' 个历史快照';
    head.appendChild(b);
    head.appendChild(meta);
    card.appendChild(head);

    // 历史快照对比表
    const table = document.createElement('table');
    table.className = 'hist-table';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    ['时间'].concat(t.headers || []).forEach((h) => {
      const th = document.createElement('th');
      th.textContent = h;
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    hist.slice(-8).forEach((h) => {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.textContent = new Date(h.time).toLocaleString('zh-CN');
      tr.appendChild(td);
      (h.rows[0] || []).forEach((v) => {
        const tdd = document.createElement('td');
        tdd.textContent = v == null ? '' : String(v).slice(0, 40);
        tr.appendChild(tdd);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    card.appendChild(table);

    // 数值趋势线（如价格走势）
    const ci = findTrendCol(t);
    if (ci >= 0) {
      const points = hist
        .map((h) => {
          const vs = (h.rows || []).map((r) => numVal(r[ci])).filter((v) => v != null);
          if (!vs.length) return null;
          return {
            v: vs.reduce((a, b) => a + b, 0) / vs.length,
            label: new Date(h.time).toLocaleString('zh-CN')
          };
        })
        .filter(Boolean);
      const svg = svgTrend(points, 640, 90);
      if (svg) {
        const cap = document.createElement('div');
        cap.className = 'meta';
        cap.style.marginTop = '6px';
        cap.textContent = '「' + ((t.headers || [])[ci] || '数值') + '」均值趋势（每次变化的快照均值）';
        card.appendChild(cap);
        const box = document.createElement('div');
        box.innerHTML = svg;
        card.appendChild(box);
      }
    }

    list.appendChild(card);
  });

  sec.hidden = shown === 0;
}

function render() {
  chrome.storage.local.get(['wp_reports', 'wp_monitors', 'wp_changes'], ({ wp_reports = [], wp_monitors = {}, wp_changes = {} }) => {
    renderDashboard(wp_monitors, wp_changes);
    renderHistory(wp_monitors);
    const list = $('#reports');
    list.innerHTML = '';
    $('#empty').hidden = wp_reports.length > 0;
    wp_reports.forEach((r, idx) => {
      const card = document.createElement('div');
      card.className = 'card';

      const head = document.createElement('div');
      head.className = 'card-head';
      const b = document.createElement('b');
      b.textContent = new Date(r.time).toLocaleString('zh-CN');
      const badge = document.createElement('span');
      badge.className = 'badge ' + (r.llm ? 'ai' : 'rule');
      badge.textContent = r.llm ? 'AI 深度解读' : '规则摘要（未配置 AI）';
      b.appendChild(badge);
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = '监控 ' + r.monitorCount + ' 个页面 · ' + r.totalChanges + ' 次变化';
      head.appendChild(b);
      head.appendChild(meta);
      card.appendChild(head);

      const sum = document.createElement('div');
      sum.className = 'md';
      sum.innerHTML = mdToHtml(r.summary);
      card.appendChild(sum);

      if (r.analysis) {
        const box = document.createElement('div');
        box.className = 'analysis';
        const t = document.createElement('div');
        t.className = 'analysis-title';
        t.textContent = 'AI 商业解读与建议';
        const body = document.createElement('div');
        body.className = 'md';
        body.innerHTML = mdToHtml(r.analysis);
        box.appendChild(t);
        box.appendChild(body);
        card.appendChild(box);
      } else if (idx === 0) {
        const tip = document.createElement('div');
        tip.className = 'meta';
        tip.style.marginTop = '10px';
        tip.textContent = '提示：在扩展设置中配置 AI API Key 后重新生成，可获得变化解读与建议行动。';
        card.appendChild(tip);
      }
      list.appendChild(card);
    });
  });
}

function latestText() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['wp_reports', 'wp_monitors'], ({ wp_reports = [], wp_monitors = {} }) => {
      if (!wp_reports.length) return resolve(null);
      const r = wp_reports[0];
      let text = '# 每周报告 · ' + new Date(r.time).toLocaleString('zh-CN') + '\n\n' + r.summary +
        (r.analysis ? '\n\n---\n\n## AI 商业解读与建议\n\n' + r.analysis : '');
      // 附带字段追踪历史（历史数据对比）
      const histLines = [];
      Object.keys(wp_monitors).forEach((id) => {
        const t = wp_monitors[id];
        const hist = t.history || [];
        if (!hist.length) return;
        histLines.push('### ' + t.name + '（' + hist.length + ' 个历史快照）');
        hist.slice(-8).forEach((h) => {
          histLines.push('- ' + new Date(h.time).toLocaleString('zh-CN') + '：' + (h.rows[0] || []).join(' | '));
        });
      });
      if (histLines.length) {
        text += '\n\n---\n\n## 字段追踪历史\n\n' + histLines.join('\n');
      }
      resolve(text);
    });
  });
}

$('#btnGen').onclick = async () => {
  const btn = $('#btnGen');
  btn.disabled = true;
  btn.textContent = '生成中…';
  $('#hint').textContent = '正在汇总本周监控变化' + '（如配置了 AI Key，将同时生成商业解读）…';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'GENERATE_REPORT' });
    if (!r || !r.ok) throw new Error((r && r.error) || '生成失败');
    $('#hint').textContent = '报告已生成：' + r.report.totalChanges + ' 次变化，来自 ' + r.report.monitorCount + ' 个监控页面。';
    render();
  } catch (e) {
    $('#hint').textContent = '生成失败: ' + e.message;
  }
  btn.disabled = false;
  btn.textContent = '立即生成本周报告';
};

$('#btnCopy').onclick = async () => {
  const t = await latestText();
  if (!t) return ($('#hint').textContent = '暂无报告可复制');
  await navigator.clipboard.writeText(t);
  $('#hint').textContent = '最新报告已复制到剪贴板';
};

$('#btnExport').onclick = async () => {
  const t = await latestText();
  if (!t) return ($('#hint').textContent = '暂无报告可导出');
  const blob = new Blob(['\uFEFF' + t], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'webpilot-weekly-report-' + new Date().toISOString().slice(0, 10) + '.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $('#hint').textContent = '已导出 Markdown 文件';
};

render();
