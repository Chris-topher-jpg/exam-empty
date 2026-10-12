const state = {
  config: null,
  payment: null,
  candidate: null,
  poller: null,
  refreshingPayment: false,
};

const $ = (selector) => document.querySelector(selector);
const ACTIVE_EXAM_KEY = 'jlb.activeExam';

function readSavedExam() {
  try { return JSON.parse(localStorage.getItem('jlb.activeExam') || 'null'); } catch { return null; }
}

function saveActiveExam(exam) {
  try { localStorage.setItem(ACTIVE_EXAM_KEY, JSON.stringify(exam)); } catch { /* Storage can be unavailable in private browsing. */ }
}

function clearSavedExam() {
  try { localStorage.removeItem(ACTIVE_EXAM_KEY); } catch { /* Storage can be unavailable in private browsing. */ }
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试');
  return data;
}

function notice(element, message, type = 'info') {
  element.textContent = message;
  element.className = `notice ${type}`;
}

function renderBlueprint() {
  $('#blueprint').innerHTML = state.config.blueprint.map((item) => `<div class="blueprint-item"><strong>${item.count} 题</strong><span>${item.label}</span></div>`).join('');
}

function renderConfig() {
  $('#brandName').textContent = state.config.clubName;
  $('#examTitle').textContent = state.config.examTitle;
  $('#questionCount').textContent = `${state.config.blueprint.reduce((sum, item) => sum + item.count, 0)} 题`;
  $('#examMinutes').textContent = `${state.config.examMinutes} 分钟`;
  $('#passScore').textContent = `${state.config.passScore} 分`;
  $('#maxAttempts').textContent = `${state.config.maxAttempts} 次`;
  $('#paymentInstructions').textContent = state.config.paymentInstructions;
  $('#feePolicy').textContent = state.config.feePolicy;
  const types = state.config.blueprint.filter((item) => item.count > 0);
  $('#questionPolicy').textContent = `共 ${types.reduce((sum, item) => sum + item.count, 0)} 题：${types.map((item) => `${item.label} ${item.count} 道`).join('、')}；满分 ${state.config.totalScore} 分。`;
  $('#scoringPolicy').textContent = `${types.filter((item) => item.points).map((item) => `${item.label}每题 ${item.points} 分`).join('，')}。${state.config.multipleChoiceScoring}`;
  $('#attemptPolicy').textContent = `考试时长 ${state.config.examMinutes} 分钟，${state.config.passScore} 分及以上通过。每人 ${state.config.maxAttempts} 次机会，取最高分。`;
  document.title = `${state.config.clubName} · ${state.config.examTitle}`;
  renderBlueprint();
}

function renderStatus(status) {
  const element = $('#candidateStatus');
  if (!status) return element.classList.add('hidden');
  element.classList.remove('hidden');
  const highestText = status.highestScore === null ? '' : `历史最高分 ${status.highestScore} 分。`;
  if (!status.attemptsRemaining) return notice(element, `该东东数字ID已用完 ${state.config.maxAttempts} 次考试机会。${highestText}`, 'error');
  const feeText = status.nextFee === 0 ? '免费' : `费用 ¥${status.nextFee}`;
  notice(element, `${highestText}已使用 ${status.attemptsUsed} 次，还剩 ${status.attemptsRemaining} 次；本次为第 ${status.nextAttempt} 次，${feeText}。`, 'info');
}

async function lookupStatus(candidateId) {
  const status = await api('/api/candidate/status', { method: 'POST', body: JSON.stringify({ candidateId }) });
  renderStatus(status);
  return status;
}

function showPayment(payment) {
  state.payment = payment;
  $('#setupView').classList.add('hidden');
  $('#paymentView').classList.remove('hidden');
  $('#paymentAmount').textContent = `¥${payment.amount}`;
  $('#paymentCandidate').textContent = payment.candidateName;
  $('#paymentAttempt').textContent = `第 ${payment.attemptNumber} 次考试`;
  $('#paymentId').textContent = payment.id.slice(-12);
  $('#paymentWechatQr').src = "/payment-wechat.jpg";
  $('#paymentAlipayQr').src = "/payment-alipay.jpg";
  updatePaymentStatus(payment);
  window.scrollTo({ top: $('#paymentView').offsetTop - 20, behavior: 'smooth' });
}

function updatePaymentStatus(payment) {
  const status = $('#paymentStatus');
  const button = $('#refreshPaymentButton');
  if (payment.status === 'paid') {
    status.textContent = '已确认';
    status.className = 'paid';
    notice($('#paymentNotice'), '付款已确认，可以开始答题。', 'success');
    button.textContent = '进入考试';
  } else if (payment.status === 'canceled') {
    status.textContent = '已取消';
    status.className = 'canceled';
    notice($('#paymentNotice'), payment.cancelReason === 'fee_policy_changed' ? '收费规则已更新，请重新报名查看本次费用。' : '付款申请已超过 30 分钟并自动取消，请重新发起。', 'error');
    button.textContent = '重新发起付款';
  } else {
    status.textContent = '等待确认';
    status.className = 'pending';
    notice($('#paymentNotice'), state.config.demoAutoPay ? '演示模式已自动确认付款。' : '请扫码付款，完成后点击“我已付款，刷新状态”。', 'warn');
    button.textContent = '我已付款，刷新状态';
  }
}

async function refreshPayment({ interactive = false } = {}) {
  if (!state.payment || state.refreshingPayment) return;
  state.refreshingPayment = true;
  const button = $('#refreshPaymentButton');
  if (interactive) {
    button.disabled = true;
    button.classList.add('loading');
    button.setAttribute('aria-busy', 'true');
  }
  try {
    const payment = await api(`/api/payment/status/${state.payment.token}`);
    state.payment = payment;
    updatePaymentStatus(payment);
    if (payment.status !== 'pending') {
      clearInterval(state.poller);
      state.poller = null;
    }
  } catch (error) {
    notice($('#paymentNotice'), error.message, 'error');
  } finally {
    state.refreshingPayment = false;
    if (interactive) {
      button.disabled = false;
      button.classList.remove('loading');
      button.removeAttribute('aria-busy');
    }
  }
}

async function beginExam(button = $('#refreshPaymentButton'), noticeElement = $('#paymentNotice')) {
  const previousLabel = button.textContent;
  button.disabled = true;
  button.textContent = '正在生成试卷…';
  try {
    const exam = await api('/api/exams/start', { method: 'POST', body: JSON.stringify({ paymentToken: state.payment.token }) });
    saveActiveExam({
      ...exam,
      candidateName: state.payment.candidateName,
      attemptNumber: state.payment.attemptNumber,
      answers: {},
      updatedAt: new Date().toISOString(),
    });
    window.location.href = `/exam.html?id=${encodeURIComponent(exam.id)}&token=${encodeURIComponent(exam.accessToken)}`;
    return true;
  } catch (error) {
    notice(noticeElement, error.message, 'error');
    noticeElement.classList.remove('hidden');
    button.disabled = false;
    button.textContent = previousLabel;
    return false;
  }
}

async function restoreSavedExam() {
  const saved = readSavedExam();
  if (!saved?.id || !saved?.accessToken) return;
  try {
    const exam = await api(`/api/exams/${encodeURIComponent(saved.id)}?token=${encodeURIComponent(saved.accessToken)}`);
    const view = $('#resumeExamView');
    const button = $('#resumeExamButton');
    if (exam.status === 'submitted' && exam.result?.id) {
      $('#resumeExamTitle').textContent = '上次考试已经提交';
      $('#resumeExamMeta').textContent = `${exam.result.candidateName} · 第 ${exam.result.attemptNumber} 次 · ${exam.result.finalScore} 分`;
      button.textContent = '查看成绩';
      button.dataset.href = `/result.html?id=${encodeURIComponent(exam.result.id)}&token=${encodeURIComponent(saved.accessToken)}`;
      view.classList.remove('hidden');
      return;
    }
    const remainingMs = new Date(exam.expiresAt).getTime() - Date.now();
    if (exam.status !== 'active' || remainingMs <= 0) {
      clearSavedExam();
      return;
    }
    const candidateName = exam.candidateName || saved.candidateName || '当前考生';
    $('#resumeExamTitle').textContent = `${candidateName}的第 ${exam.attemptNumber} 次考试`;
    $('#resumeExamMeta').textContent = `剩余约 ${Math.max(1, Math.ceil(remainingMs / 60_000))} 分钟，已填写内容保存在本机`;
    button.textContent = '继续答题';
    button.dataset.href = `/exam.html?id=${encodeURIComponent(saved.id)}&token=${encodeURIComponent(saved.accessToken)}`;
    view.classList.remove('hidden');
  } catch {
    clearSavedExam();
  }
}

async function redeemAnswerCode() {
  const button = $('#redeemAnswerCodeButton');
  const form = new FormData($('#candidateForm'));
  const candidate = Object.fromEntries(form.entries());
  if (candidate.candidateName.trim().length < 2) return notice($('#candidateStatus'), '请填写姓名或入职昵称。', 'error');
  if (!candidate.candidateId.trim()) return notice($('#candidateStatus'), '请填写东东数字ID。', 'error');
  if (!candidate.answerCode.trim()) return notice($('#candidateStatus'), '请填写答题码。', 'error');
  button.disabled = true;
  const previousLabel = button.textContent;
  button.textContent = '正在验证…';
  try {
    state.candidate = candidate;
    state.payment = await api('/api/answer-codes/redeem', { method: 'POST', body: JSON.stringify({ candidateName: candidate.candidateName, candidateId: candidate.candidateId, contact: candidate.contact, code: candidate.answerCode }) });
    const started = await beginExam(button, $('#candidateStatus'));
    if (!started) button.textContent = previousLabel;
  } catch (error) {
    notice($('#candidateStatus'), error.message, 'error');
    $('#candidateStatus').classList.remove('hidden');
    button.disabled = false;
    button.textContent = previousLabel;
  }
}

$('#candidateForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  const form = new FormData(event.currentTarget);
  state.candidate = Object.fromEntries(form.entries());
  try {
    const status = await lookupStatus(state.candidate.candidateId);
    if (!status.attemptsRemaining) return;
    const payment = await api('/api/payment/request', { method: 'POST', body: JSON.stringify(state.candidate) });
    if (payment.status === 'paid' && payment.amount === 0) {
      state.payment = payment;
      await beginExam(submitButton, $('#candidateStatus'));
      return;
    }
    showPayment(payment);
    if (payment.status === 'pending') {
      clearInterval(state.poller);
      state.poller = setInterval(() => void refreshPayment(), 5000);
    }
  } catch (error) {
    notice($('#candidateStatus'), error.message, 'error');
    $('#candidateStatus').classList.remove('hidden');
  } finally {
    submitButton.disabled = false;
  }
});

$('#lookupButton').addEventListener('click', async () => {
  const candidateId = $('#candidateId').value.trim();
  if (!candidateId) return notice($('#candidateStatus'), '请先填写东东数字ID。', 'error');
  try { await lookupStatus(candidateId); } catch (error) { notice($('#candidateStatus'), error.message, 'error'); $('#candidateStatus').classList.remove('hidden'); }
});

$('#redeemAnswerCodeButton').addEventListener('click', redeemAnswerCode);

$('#resumeExamButton').addEventListener('click', (event) => {
  const href = event.currentTarget.dataset.href;
  if (href) window.location.href = href;
});

$('#refreshPaymentButton').addEventListener('click', async () => {
  if (state.payment?.status === 'paid') return beginExam();
  if (state.payment?.status === 'canceled') {
    $('#paymentView').classList.add('hidden');
    $('#setupView').classList.remove('hidden');
    return;
  }
  await refreshPayment({ interactive: true });
  if (state.payment?.status === 'paid') await beginExam();
});

$('#backToFormButton').addEventListener('click', () => {
  clearInterval(state.poller);
  state.poller = null;
  $('#paymentView').classList.add('hidden');
  $('#setupView').classList.remove('hidden');
});

api('/api/config').then((config) => { state.config = config; renderConfig(); }).catch((error) => notice($('#candidateStatus'), error.message, 'error'));
void restoreSavedExam();
