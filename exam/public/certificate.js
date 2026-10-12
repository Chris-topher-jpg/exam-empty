const $ = (selector) => document.querySelector(selector);
const queryId = new URLSearchParams(location.search).get('id');

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

async function verify(id) {
  const result = $('#certificateResult');
  result.innerHTML = '<div class="notice info">正在核验…</div>';
  try {
    const response = await fetch(`/api/certificates/${encodeURIComponent(id)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '查询失败');
    result.innerHTML = `<section class="certificate-document"><header><span>YES ENTERTAINMENT</span><b>入职文考通过证明</b></header><p class="cert-statement">${escapeHtml(data.clubName)} 确认，以下人员已完成 ${escapeHtml(data.examTitle)}，成绩达到规定标准。</p><h2>${escapeHtml(data.candidateName)}</h2><dl><div><dt>报名编号</dt><dd>${escapeHtml(data.candidateId)}</dd></div><div><dt>最终成绩</dt><dd>${data.score} 分</dd></div><div><dt>签发时间</dt><dd>${new Date(data.issuedAt).toLocaleString('zh-CN', { hour12: false })}</dd></div><div><dt>证明编号</dt><dd>${escapeHtml(data.id)}</dd></div></dl><footer><span>核验状态</span><strong>有效</strong></footer></section><div class="certificate-actions"><button class="secondary-action" type="button" onclick="window.print()">打印 / 保存为 PDF</button></div>`;
  } catch (error) {
    result.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
  }
}

$('#verifyForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const id = $('#certificateId').value.trim();
  if (id) void verify(id);
});

if (queryId) {
  $('#certificateId').value = queryId;
  void verify(queryId);
}
