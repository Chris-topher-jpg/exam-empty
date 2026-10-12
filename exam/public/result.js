const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const resultId = params.get('id');
const token = params.get('token');

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function renderFailure(message) {
  $('#resultApp').innerHTML = `<div class="exam-loading"><div><h2>成绩链接无效</h2><p>${escapeHtml(message)}</p><a class="primary-action" href="/">返回考试入口</a></div></div>`;
}

function renderResult(result) {
  const passed = result.passed;
  document.title = passed ? '考试通过' : '考试成绩';
  const certificate = result.certificateId ? `<section class="certificate-callout"><div><small>通过证明编号</small><strong>${escapeHtml(result.certificateId)}</strong><p>该编号可在公开查询页核验。</p></div><a class="primary-action" href="/certificate?id=${encodeURIComponent(result.certificateId)}">查看证明</a></section>` : '';
  const answers = result.details.map((item, index) => `<div class="${item.correct ? '' : 'wrong'}"><b>第 ${item.order || index + 1} 题</b><span>${item.earned} / ${item.maximum}</span></div>`).join('');
  $('#resultApp').innerHTML = `<section class="score-summary ${passed ? '' : 'failed'}"><p>${passed ? 'PASSED' : 'NOT PASSED'}</p><h1>${result.finalScore}</h1><span>/ 100</span><h2>${passed ? '考试通过' : '本次未通过'}</h2><dl><div><dt>考生</dt><dd>${escapeHtml(result.candidateName)}</dd></div><div><dt>考试次数</dt><dd>第 ${result.attemptNumber} 次</dd></div><div><dt>通过标准</dt><dd>${result.passScore} 分</dd></div><div><dt>提交时间</dt><dd>${new Date(result.submittedAt).toLocaleString('zh-CN', { hour12: false })}</dd></div></dl></section>${certificate}<section class="answer-summary"><div class="section-heading"><span>答题概览</span><small>${result.details.filter((item) => item.correct).length} / ${result.details.length} 题达到评分标准</small></div><div class="answer-grid">${answers}</div></section><a class="primary-action full-action" href="/">返回考试入口</a>`;
}

async function loadResult() {
  if (!resultId || !token) return renderFailure('请从考试提交结果页面进入。');
  try {
    const response = await fetch(`/api/results/${encodeURIComponent(resultId)}?token=${encodeURIComponent(token)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '成绩读取失败');
    renderResult(result);
  } catch (error) {
    renderFailure(error.message);
  }
}

loadResult();
