/**
 * WebPilot AI 提取核心库（无依赖）
 * 同时运行于：content script（真实页面）与 offscreen 文档（监控时解析 HTML）
 */
(function () {
  const PRICE_RE = /(^[$￥€£]\s*\d)|(\d+\.\d{2}\b)|(^\d{1,3}(,\d{3})+(\.\d+)?$)/;
  const DATE_RE = /\d{4}[-/年.]\s*\d{1,2}[-/月.]\s*\d{1,2}/;
  const EMAIL_RE = /^[\w.+-]+@[\w-]+\.[\w.]+$/;
  const PCT_RE = /^\d+(\.\d+)?%$/;

  function clean(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) t += n.textContent;
    }
    return t.trim();
  }

  /** 生成元素的 CSS 选择器路径（用于跨页面定位） */
  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
      if (node.id) {
        parts.unshift('#' + node.id);
        break;
      }
      let s = node.tagName.toLowerCase();
      const cls = Array.from(node.classList).slice(0, 2);
      if (cls.length) {
        try {
          s += '.' + cls.map((c) => CSS.escape(c)).join('.');
        } catch (e) { /* ignore */ }
      }
      const p = node.parentElement;
      if (p) {
        const same = Array.from(p.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(s);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  /** 解析一个 <table> 为 {headers, rows} */
  function tableToData(table) {
    const thead = table.querySelector('thead');
    if (thead) {
      const headers = Array.from(thead.querySelectorAll('tr')).flatMap(
        (tr) => Array.from(tr.children).map((c) => clean(c.textContent))
      );
      const rows = Array.from(table.querySelectorAll('tbody tr'))
        .filter((tr) => tr.children.length > 0)
        .map((tr) => Array.from(tr.children).map((c) => clean(c.textContent)));
      return { headers, rows };
    }
    const trs = Array.from(table.querySelectorAll('tr')).filter((tr) => tr.children.length > 0);
    if (!trs.length) return { headers: [], rows: [] };
    const first = trs[0];
    const allTh = Array.from(first.children).every((c) => c.tagName === 'TH');
    const headers = Array.from(first.children).map((c) => clean(c.textContent));
    const body = allTh ? trs.slice(1) : trs;
    const rows = body.map((tr) => Array.from(tr.children).map((c) => clean(c.textContent)));
    return { headers: allTh ? headers : [], rows };
  }

  /** 扫描文档中可提取的数据表格 */
  function getTables(doc) {
    const out = [];
    for (const t of doc.querySelectorAll('table')) {
      const d = tableToData(t);
      const cols = d.headers.length || (d.rows[0] || []).length;
      if (d.rows.length >= 2 && cols >= 2) {
        const nonEmpty =
          d.rows.flat().filter((x) => x).length / Math.max(1, d.rows.length * cols);
        if (nonEmpty > 0.3) {
          out.push({
            selector: cssPath(t),
            headers: d.headers,
            rows: d.rows.slice(0, 40),
            total: d.rows.length,
            cols
          });
        }
      }
      if (out.length >= 10) break;
    }
    return out;
  }

  /** 向上寻找“重复兄弟条目”分组（列表项自动识别） */
  function findGroup(el) {
    let node = el;
    for (let i = 0; i < 6; i++) {
      const p = node.parentElement;
      if (!p || p === document.body) break;
      const same = Array.from(p.children).filter((c) => c.tagName === node.tagName);
      if (same.length >= 3 && same.includes(node)) {
        return { parent: p, item: node, siblings: same };
      }
      node = p;
    }
    return null;
  }

  /** 基于样本值推测字段名（规则优先，无需 LLM） */
  function guessName(f, texts) {
    const t = (texts[0] || '').trim();
    if (f.mode === 'img') return '图片';
    if (f.wantHref) return '链接';
    if (f.mode === 'self') return '内容';
    const sel = f.selector || '';
    if (/^h1\b/.test(sel)) return '标题';
    if (/^h2\b/.test(sel)) return '副标题';
    if (/^h[34]\b/.test(sel)) return '小标题';
    if (/^a\b/.test(sel)) return t ? '链接文本' : '链接';
    if (/^time\b/.test(sel)) return '时间';
    if (EMAIL_RE.test(t)) return '邮箱';
    if (PRICE_RE.test(t)) return '价格';
    if (PCT_RE.test(t)) return '占比';
    if (DATE_RE.test(t)) return '日期';
    return null;
  }

  /** 用户点击某个条目后，构建可复用的提取配置（用于分页/监控） */
  function buildItemConfig(el) {
    if (el.tagName === 'TABLE') {
      const d = tableToData(el);
      const cols = d.headers.length || (d.rows[0] || []).length;
      return { mode: 'table', tableSelector: cssPath(el), expectedCols: cols };
    }
    const g = findGroup(el);
    const parent = g ? g.parent : el.parentElement;
    const containerSelector = parent ? cssPath(parent) : 'body';
    let itemSelector;
    if (g) {
      const cls = Array.from(g.item.classList).slice(0, 2);
      itemSelector =
        g.item.tagName.toLowerCase() +
        (cls.length ? '.' + cls.map((c) => CSS.escape(c)).join('.') : '');
    } else {
      itemSelector = cssPath(el);
    }
    let items = [];
    try {
      items = Array.from(parent.querySelectorAll(itemSelector)).slice(0, 6);
    } catch (e) { /* ignore */ }
    if (items.length < 2) items = [el];

    const fields = [];
    const used = new Set();
    let n = 0;
    for (const d of items[0].querySelectorAll('*')) {
      let mode = 'sel';
      const tag = d.tagName.toLowerCase();
      if (d.childElementCount === 0) {
        if (tag === 'img') mode = 'img';
      } else if (!ownText(d)) {
        continue;
      }
      if (mode === 'sel' && !clean(d.textContent)) continue;
      const cls = Array.from(d.classList).slice(0, 2);
      let sel = tag + (cls.length ? '.' + cls.map((c) => {
        try { return CSS.escape(c); } catch (e) { return c; }
      }).join('.') : '');
      if (used.has(sel)) continue;
      if (items.length > 1 && !items.slice(1).every((it) => it.querySelector(sel))) continue;
      used.add(sel);
      const texts = items.map((it) => {
        const x = it.querySelector(sel);
        return x ? clean(x.textContent) : '';
      });
      const name = guessName({ selector: sel, mode }, texts) || '字段' + ++n;
      fields.push({ selector: sel, name, mode, wantHref: false });
      if (fields.length >= 8) break;
    }
    // 追加链接列
    const a = items[0].querySelector('a[href]');
    if (a) {
      const cls = Array.from(a.classList).slice(0, 2);
      const sel = 'a' + (cls.length ? '.' + cls.map((c) => CSS.escape(c)).join('.') : '');
      if (!used.has(sel)) {
        fields.push({ selector: sel, name: '链接', mode: 'sel', wantHref: true });
      }
    }
    if (!fields.length) {
      fields.push({ selector: null, name: '内容', mode: 'self' });
    }
    // 备用定位链：主选择器失效（页面改版）时逐级降级
    const itemFallbacks = [itemSelector];
    if (g) {
      const tagOnly = g.item.tagName.toLowerCase();
      if (tagOnly !== itemSelector) itemFallbacks.push(tagOnly);
      const cls0 = Array.from(g.item.classList)[0];
      if (cls0) {
        try {
          const oneCls = g.item.tagName.toLowerCase() + '.' + CSS.escape(cls0);
          if (oneCls !== itemSelector) itemFallbacks.push(oneCls);
        } catch (e) { /* ignore */ }
      }
    }
    return { mode: 'pick', containerSelector, itemSelector, itemFallbacks, fields };
  }

  function fieldValue(el, f) {
    if (f.mode === 'self') return clean(el.textContent);
    const d = f.selector ? el.querySelector(f.selector) : null;
    if (!d) return '';
    if (f.mode === 'img') return d.getAttribute('alt') || d.getAttribute('src') || '';
    if (f.wantHref) return d.href || d.getAttribute('href') || '';
    return clean(d.textContent);
  }

  /** 按配置在任意文档（真实页面或解析后的 HTML）中提取数据；降级时返回 degraded 标记 */
  /** XPath 定位（多策略定位链第 2 级）—— 9 = FIRST_ORDERED_NODE_TYPE 字面量，避免依赖 XPathResult 全局 */
  function evalXPath(doc, xp) {
    try {
      const r = doc.evaluate(xp, doc, null, 9, null);
      return r.singleNodeValue;
    } catch (e) {
      return null;
    }
  }

  /**
   * 文本锚点 + DOM 邻近关系定位（第 3/5 级）：
   * CSS 类名是易变面，页面上的可见标题文本往往比类名更稳定。
   * 找到包含锚点文本的元素后，沿兄弟/祖先链找最近的表格。
   */
  function findByTextAnchor(doc, anchorText) {
    const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
    const target = norm(anchorText);
    if (!target) return null;
    let best = null;
    const tags = 'h1,h2,h3,h4,h5,th,td,label,summary,dt,b,strong,em,span,div,p,li';
    for (const el of doc.querySelectorAll(tags)) {
      const txt = norm(el.textContent);
      if (txt === target || (el.childElementCount === 0 && txt && txt.indexOf(target) >= 0)) {
        if (!best || txt.length < norm(best.textContent)) best = el;
      }
    }
    if (!best) return null;
    // DOM 邻近：锚点向后兄弟链找最近表格（8 跳以内）
    let n = best.nextElementSibling;
    for (let hop = 0; n && hop < 8; hop++) {
      if (n.tagName === 'TABLE') return n;
      const inner = n.querySelector && n.querySelector('table');
      if (inner) return inner;
      n = n.nextElementSibling;
    }
    // 祖先链：锚点所在容器内的表格
    let p = best.parentElement;
    while (p && p !== doc.body) {
      if (p.tagName === 'TABLE') return p;
      const inner = p.querySelector && p.querySelector('table');
      if (inner) return inner;
      p = p.parentElement;
    }
    return null;
  }

  function extractWithConfig(doc, config) {
    if (!config) return { headers: [], rows: [] };
    if (config.mode === 'table') {
      let t = null;
      try { t = doc.querySelector(config.tableSelector); } catch (e) { /* ignore */ }
      let degraded = false;
      // 第 2 级：XPath（CSS 类名变化但结构未变时常能命中）
      if (!t && config.xpath) {
        const node = evalXPath(doc, config.xpath);
        if (node && node.tagName === 'TABLE') {
          t = node;
          degraded = true;
        }
      }
      // 第 3 级：文本锚点（找锚点后沿 DOM 邻近关系定位表格）
      if (!t && config.textAnchor && config.textAnchor.text) {
        const node = findByTextAnchor(doc, config.textAnchor.text);
        if (node) {
          t = node;
          degraded = true;
        }
      }
      // 第 4 级：按列数匹配其他数据表格
      if (!t && config.expectedCols) {
        for (const cand of doc.querySelectorAll('table')) {
          const d = tableToData(cand);
          const cols = d.headers.length || (d.rows[0] || []).length;
          if (cols === config.expectedCols && d.rows.length >= 1) {
            t = cand;
            degraded = true;
            break;
          }
        }
      }
      // 第 5 级：DOM 邻近全局兜底（第一个像数据表格的表格）
      if (!t) {
        for (const cand of doc.querySelectorAll('table')) {
          const d = tableToData(cand);
          const cols = d.headers.length || (d.rows[0] || []).length;
          if (cols >= 2 && d.rows.length >= 2) {
            t = cand;
            degraded = true;
            break;
          }
        }
      }
      if (!t) return { headers: [], rows: [], broken: true };
      const d = tableToData(t);
      return { headers: d.headers, rows: d.rows, degraded };
    }
    let container = doc;
    if (config.containerSelector) {
      try { container = doc.querySelector(config.containerSelector) || doc; } catch (e) { /* ignore */ }
    }
    const trySel = (root, sel) => {
      try {
        return sel ? Array.from(root.querySelectorAll(sel)) : [];
      } catch (e) {
        return [];
      }
    };
    let items = [];
    let usedFallback = false;
    if (config.itemSelector) {
      items = trySel(container, config.itemSelector);
      if (items.length < 2) items = trySel(doc, config.itemSelector);
    }
    if (items.length < 2 && config.itemFallbacks) {
      for (const fb of config.itemFallbacks) {
        if (!fb || fb === config.itemSelector) continue;
        let cand = trySel(container, fb);
        if (cand.length < 2) cand = trySel(doc, fb);
        if (cand.length >= 2) {
          items = cand;
          usedFallback = true;
          break;
        }
      }
    }
    if (items.length === 0 && (config.itemSelector || config.itemFallbacks)) {
      return { headers: [], rows: [], broken: true };
    }
    const fields = config.fields || [];
    const rows = items.map((it) => fields.map((f) => fieldValue(it, f)));
    return {
      headers: fields.map((f) => f.name),
      rows,
      degraded: usedFallback || undefined
    };
  }

  /** 探测“下一页”链接，返回绝对 URL */
  function findNextLink(doc, baseUrl) {
    const pat = /^(下一页|下页|后一页|next(\s*page)?|»|›|＞|更多)$/i;
    for (const a of doc.querySelectorAll('a')) {
      const t = clean(a.textContent);
      const aria = clean(a.getAttribute('aria-label') || '');
      const rel = (a.getAttribute('rel') || '').toLowerCase();
      const href = a.getAttribute('href');
      if (!href || href === '#') continue;
      const isNext =
        rel === 'next' || pat.test(t) || pat.test(aria) || /\bnext\b/i.test(a.className);
      if (isNext) {
        try {
          return new URL(href, baseUrl || a.baseURI).href;
        } catch (e) {
          return href;
        }
      }
    }
    return null;
  }

  /* ---------------- 字段级 diff ---------------- */
  function rowKey(r) {
    return JSON.stringify(r);
  }

  /**
   * 对比新旧数据行：识别新增 / 移除 / “同一行的哪些字段发生了变化”
   * 通过行相似度配对（≥50% 单元格相同视为同一行），纯顺序抖动不会产生任何差异
   */
  function diffRows(oldRows, newRows) {
    oldRows = oldRows || [];
    newRows = newRows || [];
    const oldKeys = new Set(oldRows.map(rowKey));
    const newKeys = new Set(newRows.map(rowKey));
    const removedIdx = [];
    const addedIdx = [];
    oldRows.forEach((r, i) => {
      if (!newKeys.has(rowKey(r))) removedIdx.push(i);
    });
    newRows.forEach((r, i) => {
      if (!oldKeys.has(rowKey(r))) addedIdx.push(i);
    });

    const matchedOld = new Set();
    const matchedNew = new Set();
    const modified = [];
    // 数据量过大时跳过逐行配对，只报告增删
    const pair = oldRows.length * newRows.length <= 40000;
    if (pair) {
      for (const oi of removedIdx) {
        const o = oldRows[oi];
        let best = -1;
        let bestScore = 0;
        for (const ni of addedIdx) {
          if (matchedNew.has(ni)) continue;
          const n = newRows[ni];
          let same = 0;
          const len = Math.max(o.length, n.length) || 1;
          for (let j = 0; j < len; j++) {
            if ((o[j] || '') === (n[j] || '')) same++;
          }
          const score = same / len;
          if (score >= 0.5 && score > bestScore) {
            bestScore = score;
            best = ni;
          }
        }
        if (best >= 0) {
          matchedNew.add(best);
          matchedOld.add(oi);
          const n = newRows[best];
          const cells = [];
          for (let j = 0; j < Math.max(o.length, n.length); j++) {
            if ((o[j] || '') !== (n[j] || '')) cells.push(j);
          }
          modified.push({ old: o, new: n, cells });
        }
      }
    }

    return {
      added: addedIdx.filter((i) => !matchedNew.has(i)).map((i) => newRows[i]),
      removed: removedIdx.filter((i) => !matchedOld.has(i)).map((i) => oldRows[i]),
      modified
    };
  }

  globalThis.WebPilotCore = {
    clean,
    cssPath,
    tableToData,
    getTables,
    findGroup,
    guessName,
    buildItemConfig,
    extractWithConfig,
    findNextLink,
    diffRows
  };
})();
