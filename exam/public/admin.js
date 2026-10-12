const $ = (selector) => document.querySelector(selector);
const adminState = { token: sessionStorage.getItem('jqdj.adminToken') || '', dashboard: null, questionBank: null, answerCodes: null, lastGeneratedCode: '', resultDetail: null, editingQuestionId: null, questionSearch: '', questionType: 'all', view: 'overview' };

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(adminState.token ? { Authorization: `Bearer ${adminState.token}` } : {}), ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function date(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function notice(element, message, type = 'info') { if (element) element.innerHTML = `<div class="admin-notice ${type}">${escapeHtml(message)}</div>`; }
function statusLabel(status) { return ({ pending: '待确认', paid: '已确认', canceled: '已取消', pass: '已通过', fail: '未通过' })[status] || status; }
function paymentStatusLabel(payment) { return payment.status === 'paid' && payment.amount === 0 ? '免费资格' : statusLabel(payment.status); }
function roleLabel(role) { return ({ owner: '所有者', admin: '系统管理员', examiner: '考官', finance: '财务' })[role] || role; }
function can(permission) { return adminState.dashboard?.currentUser?.permissions?.includes(permission); }

function renderLogin(message = '') {
  $('#adminApp').innerHTML = `<div class="login-layout">
    <section class="login-context"><a href="/" class="login-brand"><img class="club-logo" src="/club-logo.png?v=20261012-2" alt="机枪纯女电竞俱乐部图标" width="384" height="384"><strong>机枪纯女电竞</strong></a><div><p>文考管理系统</p><h1>管理考试、收款与成绩复核</h1><ul><li>独立管理员账号与操作权限</li><li>付款申请集中处理</li><li>成绩复核与证明签发</li></ul></div><small>机枪纯女电竞入职考核</small></section>
    <section class="login-panel"><form id="loginForm" class="login-form"><div class="form-heading"><h2>管理员登录</h2><p>请输入分配给你的账号凭证。</p></div><label><span>用户名</span><input id="adminUsername" autocomplete="username" required autofocus placeholder="例如 admin"></label><label><span>密码</span><input id="adminPassword" type="password" autocomplete="current-password" required placeholder="请输入密码"></label><button class="button primary wide" type="submit">登录</button><div id="loginNotice">${message ? `<div class="admin-notice info">${escapeHtml(message)}</div>` : ''}</div><a class="back-link" href="/">返回考生端</a></form></section>
  </div>`;
  $('#loginForm').addEventListener('submit', login);
}

async function login(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  button.textContent = '正在登录…';
  try {
    const result = await api('/api/admin/login', { method: 'POST', headers: {}, body: JSON.stringify({ username: $('#adminUsername').value, password: $('#adminPassword').value }) });
    adminState.token = result.token;
    sessionStorage.setItem('jqdj.adminToken', adminState.token);
    await loadDashboard();
  } catch (error) { notice($('#loginNotice'), error.message, 'error'); button.disabled = false; button.textContent = '登录'; }
}

function navItems(user) {
  return [['overview', '总览', '▦'], ...(user.permissions.includes('payments') ? [['payments', '付款申请', '¥']] : []), ...(user.permissions.includes('answer_codes') ? [['answerCodes', '答题码', '码']] : []), ...(user.permissions.includes('results') ? [['results', '成绩复核', '✓']] : []), ...(user.permissions.includes('questions') ? [['questions', '题库管理', '题']] : []), ...(user.permissions.includes('settings') ? [['settings', '站点设置', '⚙']] : []), ...(user.permissions.includes('users') ? [['users', '管理员账号', '人']] : []), ['account', '我的账号', '我']];
}

function shell(content) {
  const user = adminState.dashboard.currentUser;
  const navigation = navItems(user).map(([view, label, icon]) => `<button class="side-link ${adminState.view === view ? 'active' : ''}" type="button" data-view="${view}"><span>${icon}</span>${label}</button>`).join('');
  return `<div class="admin-layout"><aside class="admin-sidebar"><div class="admin-brand"><img class="club-logo" src="/club-logo.png?v=20261012-2" alt="机枪纯女电竞俱乐部图标" width="384" height="384"><div><strong>文考管理</strong><small>机枪纯女电竞</small></div></div><nav>${navigation}</nav><div class="sidebar-user"><div class="avatar">${escapeHtml(user.displayName.slice(0, 1))}</div><div><strong>${escapeHtml(user.displayName)}</strong><small>${roleLabel(user.role)} · ${escapeHtml(user.username)}</small></div></div><button id="logoutButton" class="logout-button" type="button">退出登录</button></aside><div class="admin-workspace"><header class="workspace-header"><button id="mobileMenuButton" class="mobile-menu" type="button">菜单</button><div><strong>${escapeHtml(adminState.dashboard.config.clubName)}</strong><span>文考管理后台</span></div><div class="header-links"><a href="/" target="_blank">打开考生端</a><button id="refreshDashboard" type="button">刷新</button></div></header><main class="workspace-main">${content}</main></div></div>`;
}

function pageHeading(title, description, action = '') { return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div>${action}</div>`; }
function money(value) { return `¥${Number(value || 0).toFixed(2)}`; }

function renderTrendChart(days) {
  const maxRevenue = Math.max(1, ...days.map((day) => Number(day.revenue || 0)));
  const maxSubmissions = Math.max(1, ...days.map((day) => Number(day.submissions || 0)));
  return `<div class="trend-chart">${days.map((day) => `<div class="trend-day"><div class="trend-bars">${day.revenue !== null ? `<i class="revenue-bar" style="height:${day.revenue ? Math.max(8, day.revenue / maxRevenue * 100) : 0}%" title="收款 ${money(day.revenue)}"></i>` : ''}${day.submissions !== null ? `<i class="exam-bar" style="height:${day.submissions ? Math.max(8, day.submissions / maxSubmissions * 100) : 0}%" title="交卷 ${day.submissions} 份"></i>` : ''}</div><span>${day.label}</span></div>`).join('')}</div>`;
}

function renderPaymentMix(channels) {
  const total = channels.reduce((sum, item) => sum + item.revenue, 0);
  let cursor = 0;
  const colors = ['#345347', '#8aa098', '#c0a15b'];
  const stops = channels.map((item, index) => { const start = cursor; cursor += total ? item.revenue / total * 100 : 0; return `${colors[index]} ${start}% ${cursor}%`; }).join(', ');
  return `<div class="mix-visual"><div class="donut" style="background:${total ? `conic-gradient(${stops})` : '#e7e9ea'}"><div><strong>${money(total)}</strong><span>累计收款</span></div></div><div class="mix-legend">${channels.map((item, index) => `<div><i style="background:${colors[index]}"></i><span>${item.label}</span><strong>${money(item.revenue)}</strong><small>${item.count} 笔</small></div>`).join('')}</div></div>`;
}

function renderResultMix(breakdown) {
  const total = (breakdown?.passed || 0) + (breakdown?.failed || 0);
  const rate = total ? breakdown.passed / total * 100 : 0;
  return `<div class="mix-visual"><div class="donut result-donut" style="background:conic-gradient(#345347 0 ${rate}%, #d8b1ad ${rate}% 100%)"><div><strong>${rate.toFixed(1)}%</strong><span>通过率</span></div></div><div class="mix-legend"><div><i style="background:#345347"></i><span>通过</span><strong>${breakdown?.passed || 0}</strong><small>份</small></div><div><i style="background:#d8b1ad"></i><span>未通过</span><strong>${breakdown?.failed || 0}</strong><small>份</small></div></div></div>`;
}

function renderOverview() {
  const { stats, analytics, payments, results } = adminState.dashboard;
  const recentPayments = payments.slice(0, 5).map((item) => `<tr><td><strong>${escapeHtml(item.candidateName)}</strong><small>${escapeHtml(item.candidateId)}</small></td><td>¥${item.amount}</td><td><span class="tag ${item.status}">${paymentStatusLabel(item)}</span></td><td>${date(item.createdAt)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-cell">暂无付款申请</td></tr>';
  const recentResults = results.slice(0, 5).map((item) => `<tr><td><strong>${escapeHtml(item.candidateName)}</strong><small>${escapeHtml(item.candidateId)}</small></td><td>${item.finalScore} 分<small>历史最高 ${item.highestScore} 分</small></td><td><span class="tag ${item.passed ? 'paid' : 'failed'}">${item.passed ? '通过' : '未通过'}</span></td><td>${date(item.submittedAt)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-cell">暂无考试成绩</td></tr>';
  const metrics = [[stats.totalRevenue, '累计收款', money], [stats.todayRevenue, '今日收款', money], [stats.paidPayments, '已确认付款'], [stats.pendingPayments, '待确认付款'], [stats.totalExams, '累计考试'], [stats.submittedToday, '今日交卷'], [stats.averageScore, '平均分', (value) => `${value} 分`], [stats.passRate, '通过率', (value) => `${value}%`], [stats.activeAnswerCodes, '启用答题码'], [stats.questionCount, '题库题量']].filter(([value]) => value !== null).map(([value, label, formatter]) => `<div><span>${label}</span><strong>${formatter ? formatter(value) : value}</strong></div>`).join('');
  const panels = `${can('payments') ? `<section class="panel"><header><div><h2>最近付款</h2><p>最新 5 条付款申请</p></div><button class="text-button" data-view="payments">查看全部</button></header><div class="table-wrap"><table><thead><tr><th>考生</th><th>金额</th><th>状态</th><th>申请时间</th></tr></thead><tbody>${recentPayments}</tbody></table></div></section>` : ''}${can('results') ? `<section class="panel"><header><div><h2>最近成绩</h2><p>最新 5 条考试结果</p></div><button class="text-button" data-view="results">查看全部</button></header><div class="table-wrap"><table><thead><tr><th>考生</th><th>成绩</th><th>结果</th><th>提交时间</th></tr></thead><tbody>${recentResults}</tbody></table></div></section>` : ''}`;
  const visualPanels = `<section class="panel trend-panel"><header><div><h2>近 7 天业务趋势</h2><p>${can('payments') ? '绿色为收款金额' : ''}${can('payments') && can('results') ? '，' : ''}${can('results') ? '灰色为交卷数量' : ''}</p></div></header>${renderTrendChart(analytics.days)}</section>${can('payments') ? `<section class="panel mix-panel"><header><div><h2>收款渠道构成</h2><p>按已确认金额统计</p></div></header>${renderPaymentMix(analytics.paymentChannels)}</section>` : can('results') ? `<section class="panel mix-panel"><header><div><h2>考试结果构成</h2><p>通过与未通过比例</p></div></header>${renderResultMix(analytics.resultBreakdown)}</section>` : ''}`;
  return `${pageHeading('总览', escapeHtml(adminState.dashboard.config.feePolicy))}<section class="metrics-row">${metrics}</section><div class="dashboard-visual-grid">${visualPanels}</div><div class="overview-grid">${panels}</div>`;
}

function renderPayments() {
  const rows = adminState.dashboard.payments.map((payment) => `<tr><td><strong>${escapeHtml(payment.candidateName)}</strong><small>${escapeHtml(payment.candidateId)}</small></td><td>第 ${payment.attemptNumber} 次</td><td>¥${payment.amount}</td><td>${date(payment.createdAt)}</td><td><span class="tag ${payment.status}">${paymentStatusLabel(payment)}</span></td><td class="row-actions">${payment.status === 'pending' ? `<button class="button small confirm-payment" data-id="${payment.id}">确认收款</button>` : payment.status === 'canceled' ? `<span class="muted">${payment.cancelReason === 'fee_policy_changed' ? '收费已更新' : '超时关闭'}</span>` : payment.examId ? '<span class="muted">已开考</span>' : '<span class="muted">待考生进入</span>'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-cell">暂无付款申请</td></tr>';
  return `${pageHeading('付款申请', '考费全部归考官，免费资格不计入收款。考生使用固定微信或支付宝收款码付款后，须核实到账再确认。')}<section class="panel table-panel"><div class="table-wrap"><table><thead><tr><th>考生</th><th>次数</th><th>金额</th><th>申请时间</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function answerCodeStatusLabel(status) { return ({ active: '可使用', disabled: '已停用', expired: '已过期', exhausted: '次数用完' })[status] || status; }

function renderAnswerCodes() {
  if (!adminState.answerCodes) return `${pageHeading('答题码', '正在读取答题码。')}<section class="panel loading-panel">正在加载…</section>`;
  const rows = adminState.answerCodes.map((item) => {
    const lastRedemption = item.redemptions?.at(-1);
    return `<tr><td><strong class="answer-code-value">${escapeHtml(item.code)}</strong><small>${escapeHtml(item.note || '无备注')}${item.countAsRevenue ? ' · 计入收款' : ' · 免费'}</small></td><td><span class="tag ${item.effectiveStatus === 'active' ? 'paid' : 'canceled'}">${answerCodeStatusLabel(item.effectiveStatus)}</span></td><td>${item.usedCount} / ${item.usageLimit}</td><td>${date(item.expiresAt)}</td><td><strong>${escapeHtml(item.createdBy?.displayName || item.createdBy?.username || '—')}</strong><small>${date(item.createdAt)}</small></td><td>${lastRedemption ? `<strong>${escapeHtml(lastRedemption.candidateName)}</strong><small>${escapeHtml(lastRedemption.candidateId)} · ${date(lastRedemption.redeemedAt)}</small>` : '<span class="muted">尚未使用</span>'}</td><td class="row-actions"><button class="button small copy-answer-code" data-code="${escapeHtml(item.code)}">复制</button>${item.effectiveStatus === 'active' ? `<button class="button small danger toggle-answer-code" data-id="${item.id}" data-active="false">停用</button>` : item.status === 'disabled' ? `<button class="button small toggle-answer-code" data-id="${item.id}" data-active="true">重新启用</button>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="7" class="empty-cell">尚未生成答题码</td></tr>';
  const generated = adminState.lastGeneratedCode ? `<div class="generated-code-banner"><div><span>新答题码已生成</span><strong>${escapeHtml(adminState.lastGeneratedCode)}</strong></div><button class="button copy-answer-code" data-code="${escapeHtml(adminState.lastGeneratedCode)}">复制答题码</button></div>` : '';
  return `${pageHeading('答题码', '生成免支付考试资格，并查看每个码的使用记录。')} ${generated}<section class="panel answer-code-create"><header><div><h2>生成答题码</h2><p>答题码本身是考试凭证，请通过可信渠道发送。</p></div></header><form id="answerCodeForm" class="answer-code-form"><label><span>备注</span><input id="answerCodeNote" maxlength="120" placeholder="例如 8 月线下培训"></label><label><span>可用次数</span><input id="answerCodeUsageLimit" type="number" min="1" max="1000" value="1"></label><label><span>有效小时数</span><input id="answerCodeValidHours" type="number" min="1" max="8760" value="24"></label><label class="revenue-option"><span>收款统计</span><span class="checkbox-row"><input id="answerCodeCountRevenue" type="checkbox">按本次应收考试费计入收款</span><small>默认不勾选；勾选后只影响后台统计，不会发起实际支付。</small></label><button class="button primary" type="submit">生成答题码</button></form><div id="answerCodeNotice"></div></section><section class="panel table-panel"><div class="table-wrap"><table><thead><tr><th>答题码</th><th>状态</th><th>使用次数</th><th>有效期至</th><th>创建人</th><th>最近使用</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderResults() {
  const rows = adminState.dashboard.results.map((result) => `<tr><td><strong>${escapeHtml(result.candidateName)}</strong><small>${escapeHtml(result.candidateId)}</small></td><td>第 ${result.attemptNumber} 次</td><td><span class="tag ${result.passed ? 'paid' : 'failed'}">${result.finalScore} 分 · ${result.passed ? '通过' : '未通过'}</span></td><td>${date(result.submittedAt)}</td><td><small>历史最高 ${result.highestScore} 分</small><input class="compact-input" type="number" min="0" max="100" value="${result.finalScore}" data-score="${result.id}"></td><td><input class="review-note" placeholder="复核备注" data-note="${result.id}" value="${escapeHtml(result.reviewNote)}"></td><td class="row-actions"><button class="button small view-result" data-id="${result.id}">查看答卷</button><button class="button small review-result" data-id="${result.id}">保存</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty-cell">暂无考试成绩</td></tr>';
  const detail = adminState.resultDetail ? renderResultDetail(adminState.resultDetail) : '';
  return `${pageHeading('成绩复核', '查看完整答卷，调整最终成绩或填写复核说明。达到 85 分后系统将签发通过证明。')}${detail}<section class="panel table-panel"><div class="table-wrap"><table><thead><tr><th>考生</th><th>次数</th><th>当前结果</th><th>提交时间</th><th>最终分</th><th>复核备注</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderAnswer(value) { return escapeHtml(Array.isArray(value) ? value.join('、') : value || '未作答'); }
function renderResultDetail(result) {
  return `<section class="panel result-detail"><header><div><h2>${escapeHtml(result.candidateName)}的答卷</h2><p>第 ${result.attemptNumber} 次 · ${result.finalScore} 分 · ${date(result.submittedAt)}</p></div><button class="text-button" id="closeResultDetail" type="button">关闭</button></header><div class="answer-detail-list">${result.details.map((item, index) => `<article class="${item.correct ? 'correct' : 'incorrect'}"><header><span>${String(index + 1).padStart(2, '0')} · ${questionTypeLabels[item.type] || item.type}</span><strong>${item.earned} / ${item.maximum} 分</strong></header><h3>${escapeHtml(item.prompt)}</h3><dl><div><dt>考生答案</dt><dd>${renderAnswer(item.submitted)}</dd></div><div><dt>${item.gradingMethod ? '打分标准' : '参考答案'}</dt><dd>${renderAnswer(item.correctAnswer)}</dd></div></dl>${item.gradingMethod ? `<div class="grading-meta"><span>评分方式：${item.gradingMethod === 'local-heuristic' ? '本地评分要点算法（AI 回退）' : escapeHtml(item.gradingMethod)}${item.gradingAt ? ` · ${date(item.gradingAt)}` : ''}</span>${item.gradingReason ? `<p><strong>打分原因：</strong>${escapeHtml(item.gradingReason)}</p>` : ''}</div>` : ''}</article>`).join('')}</div></section>`;
}

function renderSettings() {
  const config = adminState.dashboard.config;
  return `${pageHeading('站点设置', '维护考生端显示信息、答题时长和考试收款说明。默认 30 题：判断 8、单选 20、多选 2；满分 100 分，18 分钟，85 分通过，6 次机会取最高分，多选全对才得分。')}<section class="panel form-panel"><form id="configForm" class="settings-form"><div class="form-section"><h2>基本信息</h2><div class="field-grid"><label><span>俱乐部名称</span><input id="configClubName" value="${escapeHtml(config.clubName)}"></label><label><span>考试名称</span><input id="configExamTitle" value="${escapeHtml(config.examTitle)}"></label><label><span>答题时长（分钟）</span><input id="configExamMinutes" type="number" min="1" max="180" step="1" required value="${Number(config.examMinutes) || 18}"><small class="field-help">仅对新创建的考试生效，范围 1-180 分钟。</small></label><label class="full"><span>付款提示</span><textarea id="configPayment" rows="4">${escapeHtml(config.paymentInstructions)}</textarea></label><label class="full"><span>底部联系方式</span><input id="configContact" value="${escapeHtml(config.contactText)}"></label></div></div><div class="form-section"><h2>考试收款码</h2><p>考生付款页固定展示以下微信和支付宝收款码，付款后由管理员确认到账。</p><div class="qr-setting payment-qr-settings"><figure><img src="/payment-wechat.jpg" alt="微信收款码"><figcaption>微信支付</figcaption></figure><figure><img src="/payment-alipay.jpg" alt="支付宝收款码"><figcaption>支付宝</figcaption></figure></div></div><div class="form-footer"><div id="configNotice"></div><button class="button primary" type="submit">保存设置</button></div></form></section>`;
}

function userRows() {
  const currentUser = adminState.dashboard.currentUser;
  return adminState.dashboard.adminUsers.map((user) => `<tr><td><strong>${escapeHtml(user.displayName)}</strong><small>${escapeHtml(user.username)}${user.id === currentUser.id ? ' · 当前账号' : ''}</small></td><td><select data-role="${user.id}" ${user.id === currentUser.id ? 'disabled' : ''}><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>系统管理员</option><option value="examiner" ${user.role === 'examiner' ? 'selected' : ''}>考官</option><option value="finance" ${user.role === 'finance' ? 'selected' : ''}>财务</option><option value="owner" ${user.role === 'owner' ? 'selected' : ''}>所有者</option></select></td><td><label class="switch-label"><input type="checkbox" data-active="${user.id}" ${user.active ? 'checked' : ''} ${user.id === currentUser.id ? 'disabled' : ''}><span>${user.active ? '启用' : '停用'}</span></label></td><td>${date(user.lastLoginAt)}</td><td><input class="password-reset" data-password="${user.id}" type="password" autocomplete="new-password" placeholder="留空则不修改"></td><td class="row-actions"><button class="button small save-user" data-id="${user.id}">保存</button>${user.id === currentUser.id ? '' : `<button class="button small danger delete-user" data-id="${user.id}">删除</button>`}</td></tr>`).join('');
}

function renderUsers() {
  return `${pageHeading('管理员账号', '按职责分配所有者、系统管理员、考官或财务角色。', '<button class="button primary" id="showCreateUser" type="button">新建管理员</button>')}<section class="role-guide"><div><strong>系统管理员</strong><span>付款、成绩、题库和站点设置</span></div><div><strong>考官</strong><span>查看成绩并进行复核</span></div><div><strong>财务</strong><span>查看付款并人工确认</span></div></section><section id="createUserPanel" class="panel create-user-panel hidden"><header><div><h2>新建管理员</h2><p>创建后请通过安全渠道单独发送初始密码。</p></div></header><form id="createUserForm" class="inline-form"><label><span>用户名</span><input id="newUsername" required minlength="3" maxlength="32" placeholder="字母、数字、点、下划线"></label><label><span>显示名称</span><input id="newDisplayName" required maxlength="40" placeholder="例如 成绩复核员"></label><label><span>角色</span><select id="newRole"><option value="admin">系统管理员</option><option value="examiner">考官</option><option value="finance">财务</option><option value="owner">所有者</option></select></label><label><span>初始密码</span><input id="newPassword" type="password" required minlength="10" maxlength="128" autocomplete="new-password"></label><div class="inline-actions"><button class="button" id="cancelCreateUser" type="button">取消</button><button class="button primary" type="submit">创建账号</button></div></form><div id="createUserNotice"></div></section><section class="panel table-panel"><div class="table-wrap"><table><thead><tr><th>账号</th><th>角色</th><th>状态</th><th>最后登录</th><th>重置密码</th><th>操作</th></tr></thead><tbody>${userRows()}</tbody></table></div></section>`;
}

function renderAccount() {
  const user = adminState.dashboard.currentUser;
  return `${pageHeading('我的账号', '查看当前登录信息或修改自己的密码。')}<div class="account-grid"><section class="panel account-card"><h2>账号信息</h2><dl><div><dt>显示名称</dt><dd>${escapeHtml(user.displayName)}</dd></div><div><dt>用户名</dt><dd>${escapeHtml(user.username)}</dd></div><div><dt>角色</dt><dd>${roleLabel(user.role)}</dd></div><div><dt>最近登录</dt><dd>${date(user.lastLoginAt)}</dd></div></dl></section><section class="panel account-card"><h2>修改密码</h2><form id="changePasswordForm" class="stack-form"><label><span>当前密码</span><input id="currentPassword" type="password" autocomplete="current-password" required></label><label><span>新密码</span><input id="myNewPassword" type="password" autocomplete="new-password" minlength="10" maxlength="128" required></label><label><span>确认新密码</span><input id="confirmNewPassword" type="password" autocomplete="new-password" minlength="10" maxlength="128" required></label><button class="button primary" type="submit">修改密码</button></form><div id="passwordNotice"></div></section></div>`;
}

const questionTypeLabels = { single: '单选题', multiple: '多选题', fill: '填空题', judge: '判断题', short: '简答题', scenario: '情景题' };

function filteredQuestions() {
  if (!adminState.questionBank) return [];
  const keyword = adminState.questionSearch.trim().toLowerCase();
  return adminState.questionBank.questions.filter((question) => {
    if (adminState.questionType !== 'all' && question.type !== adminState.questionType) return false;
    if (!keyword) return true;
    return `${question.prompt} ${question.category || ''} ${question.id}`.toLowerCase().includes(keyword);
  });
}

function renderBlueprintEditor() {
  const bank = adminState.questionBank;
  return `<section class="question-summary">${bank.summary.map((item) => `<div><span>${item.label}</span><strong>${item.enabled}</strong><small>启用 / 共 ${item.total} 题</small><label>每卷抽取<input type="number" min="0" max="100" data-blueprint="${item.type}" value="${item.drawCount}"></label></div>`).join('')}</section><div class="blueprint-actions"><span>每份试卷共 <strong id="blueprintTotal">${Object.values(bank.blueprint).reduce((sum, value) => sum + value, 0)}</strong> 题</span><button class="button" id="saveBlueprint" type="button">保存组卷规则</button></div>`;
}

function optionRow(option, index, answer, type) {
  const key = String.fromCharCode(65 + index);
  const answers = Array.isArray(answer) ? answer : answer ? [answer] : [];
  const inputType = type === 'multiple' ? 'checkbox' : 'radio';
  return `<div class="option-editor-item" data-option-row data-key="${key}"><label class="correct-choice" title="设为正确答案"><input type="${inputType}" name="correctOption" ${answers.includes(option?.key || key) ? 'checked' : ''}><span>正确</span></label><strong class="option-key">${key}</strong><input class="option-text" maxlength="300" value="${escapeHtml(option?.text || '')}" placeholder="请输入选项内容"><button class="remove-option" type="button" title="删除选项" aria-label="删除选项 ${key}">−</button></div>`;
}

function choiceEditor(question, type) {
  const options = question.options?.length ? question.options : [{ text: '' }, { text: '' }, { text: '' }, { text: '' }];
  return `<div class="choice-editor full"><div class="choice-editor-heading"><span>选项与正确答案</span><small>${type === 'multiple' ? '可勾选多个正确答案' : '点击左侧单选框设置唯一正确答案'}</small></div><div id="optionEditorList" class="option-editor-list" data-choice-type="${type}">${options.map((option, index) => optionRow(option, index, question.answer, type)).join('')}</div><button class="add-option" id="addOption" type="button">＋ 添加选项</button></div>`;
}

function answerEditor(question = {}) {
  const type = question.type || 'single';
  if (type === 'single' || type === 'multiple') {
    return choiceEditor(question, type);
  }
  if (type === 'judge') return `<label class="full"><span>正确答案</span><select id="questionAnswer"><option value="true" ${String(question.answer) === 'true' ? 'selected' : ''}>正确</option><option value="false" ${String(question.answer) === 'false' ? 'selected' : ''}>错误</option></select></label>`;
  if (type === 'fill') return `<label class="full"><span>可接受答案 <em>每行一个，任一匹配即得分</em></span><textarea id="acceptedAnswers" rows="5">${escapeHtml((question.acceptedAnswers || []).join('\n'))}</textarea></label>`;
  return `<label class="full"><span>打分标准 <em>列出满分答案应覆盖的核心结论、数字和规则要点</em></span><textarea id="gradingCriteria" rows="7">${escapeHtml(question.gradingCriteria || question.referenceAnswer || '')}</textarea></label>`;
}

function questionEditor(embedded = false) {
  if (adminState.editingQuestionId === null) return '';
  const question = adminState.editingQuestionId ? adminState.questionBank.questions.find((item) => item.id === adminState.editingQuestionId) || {} : {};
  return `<section class="panel question-editor ${embedded ? 'embedded' : ''}" id="questionEditor"><header><div><h2>${question.id ? '编辑题目' : '新增题目'}</h2><p>${question.id ? `题目编号：${escapeHtml(question.id)}` : '设置题型、题干、分值和评分答案。'}</p></div><button class="text-button" id="closeQuestionEditor" type="button">关闭</button></header><form id="questionForm" class="question-form"><div class="field-grid"><label><span>题型</span><select id="questionType">${Object.entries(questionTypeLabels).map(([type, label]) => `<option value="${type}" ${question.type === type ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label><span>分类</span><input id="questionCategory" maxlength="80" value="${escapeHtml(question.category || '')}" placeholder="例如 接单规范"></label><label><span>分值</span><input id="questionPoints" type="number" min="0.01" max="100" step="0.01" value="${question.points || 2}"></label><label class="check-field"><span>状态</span><span class="checkbox-row"><input id="questionEnabled" type="checkbox" ${question.enabled !== false ? 'checked' : ''}>启用并参与抽题</span></label><label class="full"><span>题目内容</span><textarea id="questionPrompt" rows="5">${escapeHtml(question.prompt || '')}</textarea></label><div id="answerEditor" class="answer-editor full">${answerEditor(question)}</div><label class="full"><span>答案解析 <em>选填，供成绩复盘或内部参考</em></span><textarea id="questionExplanation" rows="4">${escapeHtml(question.explanation || '')}</textarea></label></div><div class="form-footer"><div id="questionNotice"></div><button class="button" id="cancelQuestionEdit" type="button">取消</button><button class="button primary" type="submit">保存题目</button></div></form></section>`;
}

function renderQuestions() {
  if (!adminState.questionBank) return `${pageHeading('题库管理', '正在读取题库和组卷规则。')}<section class="panel loading-panel">正在加载…</section>`;
  const rows = filteredQuestions().map((question) => `<tr id="question-row-${escapeHtml(question.id)}"><td><strong>${escapeHtml(question.prompt)}</strong><small>${escapeHtml(question.id)}${question.category ? ` · ${escapeHtml(question.category)}` : ''}</small></td><td>${questionTypeLabels[question.type]}</td><td>${question.points}</td><td><span class="tag ${question.enabled !== false ? 'paid' : ''}">${question.enabled !== false ? '启用' : '停用'}</span></td><td class="row-actions"><button class="button small edit-question" data-id="${escapeHtml(question.id)}">编辑</button><button class="button small danger delete-question" data-id="${escapeHtml(question.id)}">删除</button></td></tr>${adminState.editingQuestionId === question.id ? `<tr class="question-editor-row"><td colspan="5">${questionEditor(true)}</td></tr>` : ''}`).join('') || '<tr><td colspan="5" class="empty-cell">没有符合条件的题目</td></tr>';
  const newEditor = adminState.editingQuestionId === '' ? questionEditor() : '';
  return `${pageHeading('题库管理', '维护题目、标准答案和每份试卷的抽题数量。', '<button class="button primary" id="createQuestion" type="button">新增题目</button>')}<section class="panel blueprint-panel"><header><div><h2>组卷规则</h2><p>系统会按题型随机抽取启用题目，同一份试卷不会重复。</p></div></header>${renderBlueprintEditor()}</section>${newEditor}<section class="panel question-list-panel"><div class="question-toolbar"><input id="questionSearch" value="${escapeHtml(adminState.questionSearch)}" placeholder="搜索题干、分类或编号"><select id="questionTypeFilter"><option value="all">全部题型</option>${Object.entries(questionTypeLabels).map(([type, label]) => `<option value="${type}" ${adminState.questionType === type ? 'selected' : ''}>${label}</option>`).join('')}</select><span>共 ${filteredQuestions().length} 题</span></div><div class="table-wrap"><table><thead><tr><th>题目</th><th>题型</th><th>分值</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function currentView() { return ({ overview: renderOverview, payments: renderPayments, answerCodes: renderAnswerCodes, results: renderResults, questions: renderQuestions, settings: renderSettings, users: renderUsers, account: renderAccount }[adminState.view] || renderOverview)(); }
function renderDashboard() { if (adminState.view === 'users' && !can('users')) adminState.view = 'overview'; if (adminState.view === 'questions' && !can('questions')) adminState.view = 'overview'; if (adminState.view === 'answerCodes' && !can('answer_codes')) adminState.view = 'overview'; $('#adminApp').innerHTML = shell(currentView()); bindCommonEvents(); bindViewEvents(); }

async function loadDashboard() {
  try { adminState.dashboard = await api('/api/admin/dashboard'); if (adminState.view === 'questions' && can('questions')) adminState.questionBank = await api('/api/admin/question-bank'); if (adminState.view === 'answerCodes' && can('answer_codes')) adminState.answerCodes = (await api('/api/admin/answer-codes')).answerCodes; renderDashboard(); }
  catch (error) { sessionStorage.removeItem('jqdj.adminToken'); adminState.token = ''; renderLogin(error.message); }
}

async function switchView(view) {
  adminState.view = view;
  if (view === 'questions' && !adminState.questionBank) {
    renderDashboard();
    try { adminState.questionBank = await api('/api/admin/question-bank'); } catch (error) { alert(error.message); }
  }
  if (view === 'answerCodes' && !adminState.answerCodes) {
    renderDashboard();
    try { adminState.answerCodes = (await api('/api/admin/answer-codes')).answerCodes; } catch (error) { alert(error.message); }
  }
  renderDashboard();
}

function bindCommonEvents() {
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => void switchView(button.dataset.view)));
  $('#refreshDashboard').addEventListener('click', loadDashboard);
  $('#mobileMenuButton').addEventListener('click', () => document.querySelector('.admin-sidebar').classList.toggle('open'));
  $('#logoutButton').addEventListener('click', async () => { try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); } catch { /* Local logout still proceeds. */ } sessionStorage.removeItem('jqdj.adminToken'); adminState.token = ''; adminState.dashboard = null; renderLogin(); });
}

function bindViewEvents() {
  document.querySelectorAll('.confirm-payment').forEach((button) => button.addEventListener('click', async () => { if (!confirm('确认已核实该笔款项到账？')) return; button.disabled = true; try { await api(`/api/admin/payments/${button.dataset.id}/confirm`, { method: 'POST', body: '{}' }); await loadDashboard(); } catch (error) { alert(error.message); button.disabled = false; } }));
  document.querySelectorAll('.review-result').forEach((button) => button.addEventListener('click', async () => { const id = button.dataset.id; button.disabled = true; try { await api(`/api/admin/results/${id}/review`, { method: 'POST', body: JSON.stringify({ finalScore: document.querySelector(`[data-score="${id}"]`).value, reviewNote: document.querySelector(`[data-note="${id}"]`).value }) }); await loadDashboard(); } catch (error) { alert(error.message); button.disabled = false; } }));
  document.querySelectorAll('.view-result').forEach((button) => button.addEventListener('click', () => void viewResult(button.dataset.id)));
  if ($('#closeResultDetail')) $('#closeResultDetail').addEventListener('click', () => { adminState.resultDetail = null; renderDashboard(); });
  if ($('#configForm')) $('#configForm').addEventListener('submit', saveConfig);
  if ($('#answerCodeForm')) bindAnswerCodeEvents();
  if ($('#showCreateUser')) { $('#showCreateUser').addEventListener('click', () => $('#createUserPanel').classList.remove('hidden')); $('#cancelCreateUser').addEventListener('click', () => $('#createUserPanel').classList.add('hidden')); $('#createUserForm').addEventListener('submit', createUser); document.querySelectorAll('.save-user').forEach((button) => button.addEventListener('click', () => saveUser(button.dataset.id))); document.querySelectorAll('.delete-user').forEach((button) => button.addEventListener('click', () => deleteUser(button.dataset.id))); }
  if ($('#createQuestion')) bindQuestionEvents();
  if ($('#changePasswordForm')) $('#changePasswordForm').addEventListener('submit', changeOwnPassword);
}

function bindAnswerCodeEvents() {
  $('#answerCodeForm').addEventListener('submit', createAnswerCodeFromForm);
  document.querySelectorAll('.copy-answer-code').forEach((button) => button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(button.dataset.code); button.textContent = '已复制'; setTimeout(() => { button.textContent = '复制'; }, 1200); }
    catch { alert(`答题码：${button.dataset.code}`); }
  }));
  document.querySelectorAll('.toggle-answer-code').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await api(`/api/admin/answer-codes/${button.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ active: button.dataset.active === 'true' }) }); adminState.answerCodes = (await api('/api/admin/answer-codes')).answerCodes; renderDashboard(); }
    catch (error) { alert(error.message); button.disabled = false; }
  }));
}

async function createAnswerCodeFromForm(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api('/api/admin/answer-codes', { method: 'POST', body: JSON.stringify({ note: $('#answerCodeNote').value, usageLimit: Number($('#answerCodeUsageLimit').value), validHours: Number($('#answerCodeValidHours').value), countAsRevenue: $('#answerCodeCountRevenue').checked }) });
    adminState.lastGeneratedCode = result.answerCode.code;
    adminState.answerCodes = (await api('/api/admin/answer-codes')).answerCodes;
    renderDashboard();
  } catch (error) { notice($('#answerCodeNotice'), error.message, 'error'); button.disabled = false; }
}

async function viewResult(id) {
  try { adminState.resultDetail = await api(`/api/admin/results/${id}`); renderDashboard(); }
  catch (error) { alert(error.message); }
}

function bindQuestionEvents() {
  $('#createQuestion').addEventListener('click', () => openQuestionEditor(''));
  $('#saveBlueprint').addEventListener('click', saveBlueprint);
  document.querySelectorAll('[data-blueprint]').forEach((input) => input.addEventListener('input', () => { $('#blueprintTotal').textContent = [...document.querySelectorAll('[data-blueprint]')].reduce((sum, item) => sum + Number(item.value || 0), 0); }));
  $('#questionSearch').addEventListener('input', (event) => { adminState.questionSearch = event.target.value; });
  $('#questionSearch').addEventListener('change', () => renderDashboard());
  $('#questionTypeFilter').addEventListener('change', (event) => { adminState.questionType = event.target.value; renderDashboard(); });
  document.querySelectorAll('.edit-question').forEach((button) => button.addEventListener('click', () => openQuestionEditor(button.dataset.id)));
  document.querySelectorAll('.delete-question').forEach((button) => button.addEventListener('click', () => deleteQuestion(button.dataset.id)));
  if ($('#questionForm')) {
    $('#questionType').addEventListener('change', (event) => { $('#answerEditor').innerHTML = answerEditor({ type: event.target.value }); bindChoiceEditorEvents(); });
    $('#questionForm').addEventListener('submit', saveQuestion);
    $('#closeQuestionEditor').addEventListener('click', closeQuestionEditor);
    $('#cancelQuestionEdit').addEventListener('click', closeQuestionEditor);
    bindChoiceEditorEvents();
  }
}

function openQuestionEditor(id) {
  adminState.editingQuestionId = id;
  renderDashboard();
  requestAnimationFrame(() => $('#questionEditor')?.scrollIntoView({ behavior: 'smooth', block: id ? 'center' : 'start' }));
}

function normalizeOptionRows() {
  document.querySelectorAll('[data-option-row]').forEach((row, index) => {
    const key = String.fromCharCode(65 + index);
    row.dataset.key = key;
    row.querySelector('.option-key').textContent = key;
    row.querySelector('.remove-option').setAttribute('aria-label', `删除选项 ${key}`);
  });
}

function bindChoiceEditorEvents() {
  const list = $('#optionEditorList');
  if (!list) return;
  $('#addOption').addEventListener('click', () => {
    const count = list.querySelectorAll('[data-option-row]').length;
    if (count >= 26) return alert('最多支持 26 个选项');
    list.insertAdjacentHTML('beforeend', optionRow({ text: '' }, count, [], list.dataset.choiceType));
    normalizeOptionRows();
    list.querySelector('[data-option-row]:last-child .option-text')?.focus();
  });
  list.addEventListener('click', (event) => {
    const removeButton = event.target.closest('.remove-option');
    if (!removeButton) return;
    if (list.querySelectorAll('[data-option-row]').length <= 2) return alert('选择题至少需要两个选项');
    removeButton.closest('[data-option-row]').remove();
    normalizeOptionRows();
  });
}

function closeQuestionEditor() { adminState.editingQuestionId = null; renderDashboard(); }

async function saveBlueprint() {
  const blueprint = Object.fromEntries([...document.querySelectorAll('[data-blueprint]')].map((input) => [input.dataset.blueprint, Number(input.value)]));
  try { const result = await api('/api/admin/question-bank/config', { method: 'POST', body: JSON.stringify({ blueprint }) }); adminState.questionBank.blueprint = result.blueprint; adminState.questionBank.summary = result.summary; renderDashboard(); }
  catch (error) { alert(error.message); }
}

function questionPayload() {
  const type = $('#questionType').value;
  const payload = { type, prompt: $('#questionPrompt').value, category: $('#questionCategory').value, points: Number($('#questionPoints').value), enabled: $('#questionEnabled').checked, explanation: $('#questionExplanation').value };
  if (type === 'single' || type === 'multiple') {
    const rows = [...document.querySelectorAll('[data-option-row]')];
    payload.options = rows.map((row) => ({ key: row.dataset.key, text: row.querySelector('.option-text').value.trim() }));
    payload.answer = rows.filter((row) => row.querySelector('[name="correctOption"]').checked).map((row) => row.dataset.key);
  } else if (type === 'judge') payload.answer = $('#questionAnswer').value;
  else if (type === 'fill') payload.acceptedAnswers = $('#acceptedAnswers').value.split('\n').map((item) => item.trim()).filter(Boolean);
  else payload.gradingCriteria = $('#gradingCriteria').value;
  return payload;
}

async function saveQuestion(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const id = adminState.editingQuestionId;
    await api(id ? `/api/admin/questions/${encodeURIComponent(id)}` : '/api/admin/questions', { method: id ? 'PUT' : 'POST', body: JSON.stringify(questionPayload()) });
    adminState.questionBank = await api('/api/admin/question-bank');
    adminState.editingQuestionId = null;
    renderDashboard();
  } catch (error) { notice($('#questionNotice'), error.message, 'error'); button.disabled = false; }
}

async function deleteQuestion(id) {
  const question = adminState.questionBank.questions.find((item) => item.id === id);
  if (!confirm(`确认删除题目“${question?.prompt || id}”？`)) return;
  try { await api(`/api/admin/questions/${encodeURIComponent(id)}`, { method: 'DELETE' }); adminState.questionBank = await api('/api/admin/question-bank'); renderDashboard(); }
  catch (error) { alert(error.message); }
}

async function saveConfig(event) {
  event.preventDefault();
  const payload = { clubName: $('#configClubName').value, examTitle: $('#configExamTitle').value, examMinutes: Number($('#configExamMinutes').value), paymentInstructions: $('#configPayment').value, contactText: $('#configContact').value };
  try { await api('/api/admin/config', { method: 'POST', body: JSON.stringify(payload) }); await loadDashboard(); } catch (error) { notice($('#configNotice'), error.message, 'error'); }
}

async function createUser(event) {
  event.preventDefault(); const button = event.currentTarget.querySelector('button[type="submit"]'); button.disabled = true;
  try { await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ username: $('#newUsername').value, displayName: $('#newDisplayName').value, role: $('#newRole').value, password: $('#newPassword').value }) }); await loadDashboard(); }
  catch (error) { notice($('#createUserNotice'), error.message, 'error'); button.disabled = false; }
}

async function saveUser(id) {
  const button = document.querySelector(`.save-user[data-id="${id}"]`); button.disabled = true;
  const payload = { role: document.querySelector(`[data-role="${id}"]`).value, active: document.querySelector(`[data-active="${id}"]`).checked };
  const password = document.querySelector(`[data-password="${id}"]`).value; if (password) payload.password = password;
  try { await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }); await loadDashboard(); } catch (error) { alert(error.message); button.disabled = false; }
}

async function deleteUser(id) {
  const user = adminState.dashboard.adminUsers.find((item) => item.id === id);
  if (!confirm(`确认删除管理员“${user?.displayName || user?.username}”？删除后该账号将立即无法登录。`)) return;
  try { await api(`/api/admin/users/${id}`, { method: 'DELETE' }); await loadDashboard(); } catch (error) { alert(error.message); }
}

async function changeOwnPassword(event) {
  event.preventDefault();
  if ($('#myNewPassword').value !== $('#confirmNewPassword').value) return notice($('#passwordNotice'), '两次输入的新密码不一致', 'error');
  const button = event.currentTarget.querySelector('button'); button.disabled = true;
  try { await api('/api/admin/me/password', { method: 'POST', body: JSON.stringify({ currentPassword: $('#currentPassword').value, newPassword: $('#myNewPassword').value }) }); sessionStorage.removeItem('jqdj.adminToken'); adminState.token = ''; renderLogin('密码已修改，请使用新密码重新登录。'); }
  catch (error) { notice($('#passwordNotice'), error.message, 'error'); button.disabled = false; }
}

if (adminState.token) loadDashboard(); else renderLogin();
