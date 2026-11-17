/**
 * offscreen 文档：在 DOM 环境中解析后台抓取的 HTML 并执行提取
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'OFFSCREEN_EXTRACT') {
    try {
      const doc = new DOMParser().parseFromString(msg.html, 'text/html');
      const data = window.WebPilotCore.extractWithConfig(doc, msg.config);
      sendResponse({
        ok: true,
        rows: data.rows,
        headers: data.headers || [],
        broken: !!data.broken,
        degraded: !!data.degraded
      });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  } else if (msg && msg.type === 'OFFSCREEN_SCAN_TABLES') {
    try {
      const doc = new DOMParser().parseFromString(msg.html, 'text/html');
      const tables = window.WebPilotCore.getTables(doc);
      const allTables = Array.from(doc.querySelectorAll('table'));
      // 文本锚点：从表格向上/向前找最近的可见标题文本（比 CSS 类名更稳定）
      const findAnchor = (t) => {
        let p = t.previousElementSibling;
        for (let hop = 0; p && hop < 6; hop++) {
          if (/^H[1-5]$/.test(p.tagName) && p.textContent.trim()) return p.textContent.trim().slice(0, 60);
          p = p.previousElementSibling;
        }
        let a = t.parentElement;
        while (a && a !== doc.body) {
          const h = a.querySelector('h1,h2,h3,h4,h5,caption,summary');
          if (h && h.textContent.trim()) return h.textContent.trim().slice(0, 60);
          a = a.parentElement;
        }
        return null;
      };
      const cands = tables
        .map((t) => {
          const d = window.WebPilotCore.tableToData(t);
          const cols = d.headers.length || (d.rows[0] || []).length;
          const k = allTables.indexOf(t) + 1;
          return {
            selector: window.WebPilotCore.cssPath(t),
            xpath: k > 0 ? '(//table)[' + k + ']' : null,
            textAnchor: { text: findAnchor(t) },
            expectedCols: cols,
            headers: d.headers,
            rows: d.rows
          };
        })
        .filter((c) => c.rows.length >= 2)
        .slice(0, 8);
      sendResponse({ ok: true, tables: cands });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  }
  return false;
});
