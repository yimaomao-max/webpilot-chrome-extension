/**
 * WebPilot AI content script
 * - 拾取模式：用户点击页面条目 → 生成提取配置并预览
 * - 分页批量提取：跨导航持久化任务，自动翻页收集
 */
(() => {
  if (window.__webpilot_loaded) return;
  window.__webpilot_loaded = true;
  const C = window.WebPilotCore;

  /* ---------------- 拾取模式 ---------------- */
  let picking = false;

  function startPick() {
    if (picking) return;
    picking = true;
    const hl = document.createElement('div');
    hl.id = 'wp-hl';
    document.documentElement.appendChild(hl);

    const over = (e) => {
      const t = e.target;
      if (t === hl) return;
      const r = t.getBoundingClientRect();
      hl.style.display = 'block';
      hl.style.left = r.left + 'px';
      hl.style.top = r.top + 'px';
      hl.style.width = r.width + 'px';
      hl.style.height = r.height + 'px';
    };

    const stop = () => {
      picking = false;
      hl.remove();
      document.removeEventListener('mouseover', over, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true);
    };

    const click = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.target;
      stop();
      try {
        const config = C.buildItemConfig(target);
        const data = C.extractWithConfig(document, config);
        chrome.storage.local.set({
          wp_draft: {
            mode: config.mode || 'pick',
            config,
            headers: data.headers,
            rows: data.rows,
            sourceUrl: location.href,
            time: Date.now()
          }
        });
        chrome.runtime.sendMessage({ type: 'PICK_RESULT' }).catch(() => {});
      } catch (err) {
        chrome.runtime
          .sendMessage({ type: 'PICK_RESULT', error: String(err && err.message || err) })
          .catch(() => {});
      }
    };

    const key = (e) => {
      if (e.key === 'Escape') {
        stop();
        chrome.runtime.sendMessage({ type: 'PICK_CANCELLED' }).catch(() => {});
      }
    };

    document.addEventListener('mouseover', over, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
  }

  /* ---------------- 批量分页提取 ---------------- */
  async function startPagination(maxPages) {
    const { wp_draft } = await chrome.storage.local.get('wp_draft');
    if (!wp_draft || !wp_draft.config) {
      return { ok: false, error: '请先完成一次提取（智能选择或扫描表格）' };
    }
    const data = C.extractWithConfig(document, wp_draft.config);
    const next = C.findNextLink(document, location.href);
    const job = {
      active: true,
      status: 'running',
      config: wp_draft.config,
      mode: wp_draft.mode,
      headers: data.headers,
      collected: data.rows,
      maxPages: Math.max(1, Math.min(200, maxPages || 10)),
      pagesDone: 1,
      nextUrl: next,
      startUrl: location.href,
      time: Date.now()
    };
    await chrome.storage.local.set({ wp_paginationJob: job });
    if (next) {
      setTimeout(() => {
        location.href = next;
      }, 600);
      return { ok: true, message: '批量提取已启动：正在自动翻页，请勿关闭此标签页' };
    }
    job.active = false;
    job.status = 'done';
    await chrome.storage.local.set({ wp_paginationJob: job });
    return { ok: true, message: '未找到“下一页”链接，仅提取了当前页 ' + job.collected.length + ' 行' };
  }

  /* ---------------- 消息处理 ---------------- */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    switch (msg.type) {
      case 'GET_TABLES':
        sendResponse({ tables: C.getTables(document) });
        return false;
      case 'START_PICK':
        startPick();
        sendResponse({ ok: true });
        return false;
      case 'START_PAGINATION':
        startPagination(msg.maxPages)
          .then((r) => sendResponse(r))
          .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
        return true;
      default:
        return false;
    }
  });

  /* ---------------- 页面加载后：续跑分页任务 ---------------- */
  (async () => {
    try {
      const { wp_paginationJob: job } = await chrome.storage.local.get('wp_paginationJob');
      if (!job || !job.active || !job.nextUrl) return;
      if (location.href !== job.nextUrl) return;

      await new Promise((r) => setTimeout(r, 500));
      const { rows } = C.extractWithConfig(document, job.config);
      job.collected.push(...rows);
      job.pagesDone++;

      const next =
        job.pagesDone < job.maxPages ? C.findNextLink(document, location.href) : null;
      job.nextUrl = next;
      if (!next) {
        job.active = false;
        job.status = 'done';
        try {
          chrome.action.setBadgeText({ text: String(job.collected.length) });
          chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
        } catch (e) { /* ignore */ }
      }
      await chrome.storage.local.set({ wp_paginationJob: job });
      if (next) setTimeout(() => { location.href = next; }, 600);
    } catch (e) { /* ignore */ }
  })();
})();
