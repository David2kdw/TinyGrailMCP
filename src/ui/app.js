const $ = (id) => document.getElementById(id);
let csrf = '',
  state,
  busy = false,
  chosenPlan;
const labels = {
  pending: '待确认',
  dispatching: '请求已发出',
  executed: '已观察到对应变化',
  rejected: '已拒绝 / 服务端驳回',
  expired: '已过期',
  invalidated: '已失效',
  outcome_unknown: '结果未知，禁止重试',
};
const sessionLabels = {
  logged_out: '未登录',
  logging_in: '等待浏览器授权',
  unchecked: '等待服务器核验',
  authenticated: '已登录',
  expired: '登录已失效',
};
const node = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = String(text);
  if (cls) e.className = cls;
  return e;
};
function notice(message, error = false) {
  $('notice').hidden = false;
  $('notice').className = error ? 'error' : '';
  $('notice').textContent = message;
}
async function request(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await res.json();
  if (!res.ok || value.error)
    throw new Error(`${value.error?.code ?? res.status} · ${value.error?.message ?? '请求失败'}`);
  return value;
}
async function perform(work) {
  if (busy) return;
  busy = true;
  try {
    const value = await work();
    if (value) $('diagnostic').textContent = JSON.stringify(value, null, 2);
    notice('操作已完成，状态已更新。');
  } catch (e) {
    notice(e.message, true);
  } finally {
    busy = false;
    await refresh().catch(() => {});
  }
}
async function refresh(initial = false) {
  state = await request('/api/state');
  csrf = state.csrf;
  const s = state.status;
  $('locked').hidden = true;
  $('workspace').hidden = false;
  $('session-state').textContent = sessionLabels[s.session.state] ?? s.session.state;
  $('account-name').textContent = s.session.nickname ?? '等待本地登录';
  $('tunnel-state').textContent = s.tunnel.health?.ready
    ? '控制面已就绪'
    : s.tunnel.processRunning
      ? '连接中'
      : s.tunnel.configured
        ? '已配置 · 未启动'
        : '未配置';
  const discovery = s.tunnel.health?.components?.mcp?.details?.discovery;
  $('tunnel-detail').textContent =
    discovery?.state === 'complete'
      ? `Tunnel 已发现 ${discovery.toolNames.length} 项工具`
      : s.tunnel.processRunning
        ? '等待 Tunnel 工具发现'
        : '官方客户端 · 单实例 stdio';
  $('tool-count').textContent = `${state.tools.length} 项`;
  $('mcp-detail').textContent =
    s.mcp.lastEvent?.event === 'tool_call'
      ? `最近调用：${s.mcp.lastEvent.tool}`
      : s.mcp.childStarts
        ? 'stdio 子进程已启动'
        : '可使用下方本地协议检查';
  $('write-state').textContent = s.safety.policy.enabled ? '已启用 · 逐笔审批' : '已关闭';
  $('write-detail').textContent = s.safety.unknown
    ? `${s.safety.unknown} 笔结果未知，需要对账`
    : `${s.safety.pending} 笔计划待处理`;
  $('pending-badge').textContent = s.safety.pending;
  $('component-status').textContent = JSON.stringify(s, null, 2);
  $('events').textContent =
    state.events
      .map((e) => `${e.time} [${e.layer}] ${e.event}${e.code ? ' (' + e.code + ')' : ''}`)
      .join('\n') || '尚无事件';
  $('login').disabled = s.session.state === 'logging_in';
  if (initial) {
    const form = $('policy-form');
    for (const k of ['perTrade', 'daily', 'maxShares']) form.elements[k].value = s.safety.policy[k];
    form.elements.enabled.checked = s.safety.policy.enabled;
    form.elements.acknowledgeUnverified.checked = s.safety.policy.acknowledgeUnverified;
    $('allowed-actions').replaceChildren();
    for (const [key, label] of Object.entries(state.actions)) {
      const l = node('label', undefined, 'check');
      const i = node('input');
      i.type = 'checkbox';
      i.name = 'allowedActions';
      i.value = key;
      i.checked = s.safety.policy.allowedActions.includes(key);
      l.append(i, node('span', label));
      $('allowed-actions').append(l);
    }
  }
  renderPlans();
  renderTools();
}
function metric(title, value) {
  const m = node('div');
  m.append(node('span', title), node('strong', value ?? '—'));
  return m;
}
function planContent(p) {
  const t = p.terms,
    box = node('div');
  box.append(
    node('h3', state.actions[t.action]),
    node(
      'p',
      `账号 ${t.snapshot.name}${t.args.characterId ? ` · ${t.snapshot.character.Name ?? '角色'} #${t.args.characterId}` : ''} · ${labels[p.status]}`,
    ),
  );
  const values = node('div', undefined, 'plan-metrics');
  values.append(
    metric('数量 / 投入', t.args.amount ?? (t.action === 'refine' ? '1 股固定资产，精炼一次' : '单次操作')),
    metric('委托单价', t.args.price ? `₵ ${t.args.price}` : '由服务器规则确定'),
    metric('请求本金 / 现金预留', `₵ ${t.cashPrincipal}`),
    metric('额度计量风险值', `₵ ${t.riskValue}`),
    metric('计划有效期至', new Date(t.expiresAt).toLocaleTimeString('zh-CN')),
    metric('订单 / 竞价', t.args.orderId ?? t.args.auctionId ?? '—'),
  );
  for (const [key, label] of Object.entries({
    targetCharacterId: '目标角色 ID',
    username: '收款玩家',
    text: '文本内容',
    url: '图片地址',
    iceberg: '冰山委托',
  }))
    if (t.args[key] !== undefined) values.append(metric(label, String(t.args[key])));
  if (['chaos', 'guidepost', 'fisheye', 'starbreak'].includes(t.action))
    values.append(metric('消耗固定资产', t.action === 'chaos' ? 10 : 100));
  if (t.action === 'temple_destroy') values.append(metric('拆除圣殿固定资产', t.snapshot.game.temple.Assets));
  if (t.args.image) {
    values.append(metric('上传图片', `${t.args.kind} · ${t.args.image.bytes} bytes · ${t.args.image.hash}`));
    const img = node('img');
    img.src = `/api/plan-image/${p.id}`;
    img.alt = '待批准上传的图片';
    img.style.maxWidth = '240px';
    values.append(img);
  }
  box.append(values);
  if (t.warnings?.length) box.append(node('p', t.warnings.join(' '), 'warning'));
  return box;
}
function renderPlans() {
  $('pending-plans').replaceChildren();
  $('history-plans').replaceChildren();
  for (const p of state.plans) {
    const card = node('article', undefined, 'plan');
    card.append(planContent(p));
    if (p.status === 'pending') {
      const buttons = node('div', undefined, 'buttons'),
        approve = node('button', '核对并批准', 'primary'),
        reject = node('button', '拒绝计划');
      approve.disabled = Date.parse(p.terms.expiresAt) <= Date.now() || !state.status.safety.policy.enabled;
      approve.onclick = () => {
        chosenPlan = p;
        $('approval-details').replaceChildren(planContent(p));
        $('approval-check').checked = false;
        $('approve-final').disabled = true;
        $('approval').showModal();
      };
      reject.onclick = () => perform(() => request('/api/reject', { planId: p.id }));
      buttons.append(approve, reject);
      card.append(buttons);
      if (!state.status.safety.policy.enabled)
        card.append(node('p', '写入权限关闭。启用对应权限后仍需在此逐笔批准。'));
    }
    if (p.status === 'outcome_unknown' && !p.resolvedAt) {
      const input = node('input');
      input.placeholder = '核对游戏中的订单、成交与资产后，填写至少 12 字对账说明';
      input.setAttribute('aria-label', '对账说明');
      const button = node('button', '保存人工对账说明并解除阻塞');
      button.onclick = () => perform(() => request('/api/reconcile', { planId: p.id, note: input.value }));
      card.append(input, button);
    }
    const detail = node('details'),
      summary = node('summary', '查看不可变计划、指纹和回执');
    detail.append(summary, node('pre', JSON.stringify(p, null, 2), 'output'));
    card.append(detail);
    (p.status === 'pending' || p.status === 'dispatching' || (p.status === 'outcome_unknown' && !p.resolvedAt)
      ? $('pending-plans')
      : $('history-plans')
    ).append(card);
  }
  if (!$('pending-plans').children.length)
    $('pending-plans').append(
      node('div', '暂无待确认交易。你可以在 ChatGPT 中描述交易意图，计划会出现在这里。', 'empty'),
    );
}
function renderTools() {
  if (!state) return;
  const search = $('tool-filter').value.toLowerCase();
  $('tool-list').replaceChildren();
  for (const t of state.tools.filter((t) => (t.name + ' ' + t.description).toLowerCase().includes(search))) {
    const row = node('div', undefined, 'tool');
    row.append(node('strong', t.name), node('p', t.description));
    const details = node('details');
    details.append(node('summary', '参数 Schema'), node('pre', JSON.stringify(t.schema, null, 2), 'output'));
    row.append(details);
    $('tool-list').append(row);
  }
}
for (const id of [
  'login',
  'logout',
  'tunnel-start',
  'tunnel-stop',
  'tunnel-restart',
  'tunnel-doctor',
  'mcp-probe',
  'confirm-chatgpt',
])
  $(id).onclick = () => perform(() => request('/api/action', { action: id }));
$('kill').onclick = async () => {
  try {
    await request('/api/action', { action: 'emergency-stop' });
    notice('已关闭真实写入并使待确认计划失效。已发出的请求无法撤回，请查看回执。');
    await refresh(true);
  } catch (e) {
    notice(e.message, true);
  }
};
$('check-login').onclick = () => perform(() => request('/api/action', { action: 'session-check' }));
$('refresh').onclick = () => perform(() => refresh());
$('shutdown').onclick = () =>
  perform(async () => {
    await request('/api/action', { action: 'shutdown' });
    return { message: '正在停止管理器及 Tunnel。下次双击 Start.cmd 重新启动。' };
  });
$('public-check').onclick = () =>
  perform(() => request('/api/query', { name: 'get_character', args: { characterId: 1 } }));
$('account-check').onclick = () =>
  perform(() => request('/api/query', { name: 'get_asset_breakdown', args: { page: 1, pageSize: 10 } }));
$('tool-filter').oninput = renderTools;
$('policy-form').onsubmit = (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  perform(async () => {
    const result = await request('/api/policy', {
      enabled: f.elements.enabled.checked,
      acknowledgeUnverified: f.elements.acknowledgeUnverified.checked,
      allowedActions: [...f.querySelectorAll('[name=allowedActions]:checked')].map((i) => i.value),
      perTrade: f.elements.perTrade.value,
      daily: f.elements.daily.value,
      maxShares: Number(f.elements.maxShares.value),
    });
    await refresh(true);
    return result;
  });
};
$('tunnel-form').onsubmit = (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  perform(async () => {
    const result = await request('/api/tunnel-config', {
      tunnelId: f.elements.tunnelId.value.trim(),
      apiKey: f.elements.apiKey.value.trim(),
    });
    f.reset();
    return result;
  });
};
$('approval-check').onchange = (e) => ($('approve-final').disabled = !e.target.checked);
$('approve-final').onclick = () => {
  const p = chosenPlan;
  $('approve-final').disabled = true;
  $('approval').close();
  perform(() => request('/api/approve', { planId: p.id, fingerprint: p.fingerprint }));
};
(async () => {
  try {
    const token = location.hash.slice(1);
    history.replaceState(null, '', '/');
    if (token) await request('/session', { token });
    await refresh(true);
    setInterval(() => {
      if (!busy && !$('approval').open) refresh().catch(() => {});
    }, 4000);
  } catch (e) {
    $('workspace').hidden = true;
    $('locked').hidden = false;
    notice(e.message, true);
  }
})();
