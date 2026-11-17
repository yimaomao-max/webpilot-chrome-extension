const $ = (s) => document.querySelector(s);
const msg = (t, isErr) => {
  const el = $('#msg');
  el.textContent = t || '';
  el.classList.toggle('err', !!isErr);
};

(async () => {
  const { wp_settings = {} } = await chrome.storage.local.get('wp_settings');
  $('#baseUrl').value = wp_settings.baseUrl || '';
  $('#apiKey').value = wp_settings.apiKey || '';
  $('#model').value = wp_settings.model || '';
  $('#webhookUrl').value = wp_settings.webhookUrl || '';
  $('#plan').value = wp_settings.plan || 'free';
  $('#cloudBase').value = wp_settings.cloudBase || '';
  $('#pairKey').value = wp_settings.pairKey || '';
  renderBindStatus(wp_settings);
})();

function renderBindStatus(s) {
  const el = $('#bindStatus');
  if (s.serverPlan && s.pairKey) {
    el.textContent = '已绑定：' + s.serverPlan.label + ' 套餐（最多 ' + s.serverPlan.maxMonitors +
      ' 个监控 · 每 ' + s.serverPlan.minIntervalMin + ' 分钟检查 · ' + s.serverPlan.historyDays + ' 天历史），由服务端下发';
    el.style.color = '#16a34a';
  } else {
    el.textContent = '未绑定：使用下方本地模拟套餐。';
    el.style.color = '';
  }
}

$('#bind').onclick = async () => {
  const cloudBase = $('#cloudBase').value.trim().replace(/\/+$/, '');
  const pairKey = $('#pairKey').value.trim();
  if (!/^https?:\/\//.test(cloudBase)) return msg('请填写云端地址（https:// 开头）', true);
  if (!/^wpk_[0-9a-f]{32}$/.test(pairKey)) return msg('配对码格式无效（应为 wpk_ 开头的 32 位字符串）', true);
  msg('验证中…');
  try {
    const r = await fetch(cloudBase + '/api/extension/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: pairKey })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status);
    const { wp_settings = {} } = await chrome.storage.local.get('wp_settings');
    wp_settings.cloudBase = cloudBase;
    wp_settings.pairKey = pairKey;
    wp_settings.serverPlan = j.limits;
    await chrome.storage.local.set({ wp_settings });
    renderBindStatus(wp_settings);
    msg('绑定成功：套餐已由服务端下发（' + j.limits.label + '）');
  } catch (e) {
    msg('绑定失败: ' + e.message, true);
  }
};

$('#unbind').onclick = async () => {
  const { wp_settings = {} } = await chrome.storage.local.get('wp_settings');
  delete wp_settings.serverPlan;
  delete wp_settings.pairKey;
  await chrome.storage.local.set({ wp_settings });
  $('#pairKey').value = '';
  renderBindStatus(wp_settings);
  msg('已解绑，恢复本地模拟套餐');
};

$('#save').onclick = async () => {
  await chrome.storage.local.set({
    wp_settings: {
      baseUrl: $('#baseUrl').value.trim(),
      apiKey: $('#apiKey').value.trim(),
      model: $('#model').value.trim(),
      webhookUrl: $('#webhookUrl').value.trim(),
      plan: $('#plan').value || 'free'
    }
  });
  msg('已保存。套餐限制将在下次创建监控/检查时生效');
};

$('#test').onclick = async () => {
  msg('测试中…');
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'LLM_CHAT',
      messages: [{ role: 'user', content: '回复“OK”两个字' }]
    });
    if (!r || !r.ok) throw new Error((r && r.error) || '调用失败');
    msg('连接成功，模型返回: ' + r.text.slice(0, 50));
  } catch (e) {
    msg('测试失败: ' + e.message, true);
  }
};

$('#testWebhook').onclick = async () => {
  const url = $('#webhookUrl').value.trim();
  if (!url) return msg('请先填写 Webhook URL', true);
  msg('发送测试消息中…');
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'TEST_WEBHOOK',
      url
    });
    if (!r || !r.ok) throw new Error((r && r.error) || '发送失败');
    msg('测试消息已发送，请到群里查看');
  } catch (e) {
    msg('发送失败: ' + e.message, true);
  }
};
