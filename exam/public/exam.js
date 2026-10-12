const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const examId = params.get('id');
const accessToken = params.get('token');
const examState = { exam: null, answers: {}, timer: null, secondsLeft: 0 };
const ACTIVE_EXAM_KEY = 'jlb.activeExam';

function readSavedExam() {
  try { return JSON.parse(localStorage.getItem(ACTIVE_EXAM_KEY) || 'null'); } catch { return null; }
}

function persistActiveExam() {
  if (!examState.exam) return;
  try {
    localStorage.setItem('jlb.activeExam', JSON.stringify({
      id: examState.exam.id,
      accessToken,
      expiresAt: examState.exam.expiresAt,
      status: examState.exam.status,
      candidateName: examState.exam.candidateName,
      attemptNumber: examState.exam.attemptNumber,
      answers: examState.answers,
      updatedAt: new Date().toISOString(),
    }));
  } catch { /* Storage can be unavailable in private browsing. */ }
}

function clearSavedExam() {
  try { localStorage.removeItem(ACTIVE_EXAM_KEY); } catch { /* Storage can be unavailable in private browsing. */ }
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function typeLabel(type) {
  return ({ single: '单选', multiple: '多选', fill: '填空', judge: '判断', short: '简答', scenario: '情景' })[type] || type;
}

function answerValue(question) {
  const value = examState.answers[question.id];
  return Array.isArray(value) ? value : String(value || '');
}

function optionMarkup(question, value) {
  if (question.type === 'judge') {
    return [{ key: 'true', text: '正确' }, { key: 'false', text: '错误' }]
      .map((option) => `<label><input type="radio" name="${question.id}" value="${option.key}" ${value === option.key ? 'checked' : ''}><b></b><span>${option.text}</span></label>`)
      .join('');
  }
  const inputType = question.type === 'single' ? 'radio' : 'checkbox';
  return question.options.map((option) => {
    const checked = Array.isArray(value) ? value.includes(option.key) : value === option.key;
    return `<label><input type="${inputType}" name="${question.id}" value="${option.key}" ${checked ? 'checked' : ''}><b>${escapeHtml(option.key)}</b><span>${escapeHtml(option.text)}</span></label>`;
  }).join('');
}

function renderQuestion(question) {
  const value = answerValue(question);
  const answer = ['single', 'multiple', 'judge'].includes(question.type)
    ? `<div class="answer-options">${optionMarkup(question, value)}</div>`
    : `<textarea data-answer="${question.id}" rows="${question.type === 'fill' ? 2 : 5}" placeholder="在此作答">${escapeHtml(value)}</textarea>`;
  return `<section class="question-block" id="question-${question.id}" data-question-id="${question.id}"><header><span>${String(question.order).padStart(2, '0')}</span><div><small>${typeLabel(question.type)} · ${question.points} 分</small><h2>${escapeHtml(question.prompt)}</h2></div></header>${answer}</section>`;
}

function collectAnswers() {
  for (const question of examState.exam.questions) {
    const inputs = [...document.querySelectorAll(`[name="${question.id}"]`)];
    if (question.type === 'multiple') examState.answers[question.id] = inputs.filter((input) => input.checked).map((input) => input.value);
    else if (question.type === 'single' || question.type === 'judge') examState.answers[question.id] = inputs.find((input) => input.checked)?.value || '';
    else examState.answers[question.id] = document.querySelector(`[data-answer="${question.id}"]`)?.value || '';
  }
  persistActiveExam();
}

function answered(question) {
  const value = answerValue(question);
  return Array.isArray(value) ? value.length > 0 : String(value).trim().length > 0;
}

function updateProgress() {
  const count = examState.exam.questions.filter(answered).length;
  $('#answeredCount').textContent = `${count} / ${examState.exam.questions.length}`;
}

function renderExam() {
  const exam = examState.exam;
  document.title = `第 ${exam.attemptNumber} 次 · 机枪纯女电竞入职文考`;
  $('#candidateMeta').textContent = `${exam.candidateName} · 第 ${exam.attemptNumber} 次`;
  $('#examApp').innerHTML = `${exam.questions.map(renderQuestion).join('')}<footer class="submit-section"><p>请确认所有答案。多选全对才得分，多选、少选、错选均不得分。提交后系统立即评分，6 次考试取最高分。</p><button id="submitExam" type="button">提交试卷</button></footer>`;
  document.querySelectorAll('input, textarea').forEach((input) => input.addEventListener('change', () => { collectAnswers(); updateProgress(); }));
  document.querySelectorAll('textarea').forEach((input) => input.addEventListener('input', () => { collectAnswers(); updateProgress(); }));
  $('#submitExam').addEventListener('click', () => submitExam(false));
  updateProgress();
  persistActiveExam();
  startTimer();
}

function startTimer() {
  examState.secondsLeft = Math.max(0, Math.floor((new Date(examState.exam.expiresAt).getTime() - Date.now()) / 1000));
  const renderTime = () => {
    const minutes = Math.floor(examState.secondsLeft / 60).toString().padStart(2, '0');
    const seconds = (examState.secondsLeft % 60).toString().padStart(2, '0');
    $('#timerText').textContent = `${minutes}:${seconds}`;
    $('#timerText').classList.toggle('urgent', examState.secondsLeft <= 300);
  };
  renderTime();
  examState.timer = setInterval(() => {
    examState.secondsLeft -= 1;
    if (examState.secondsLeft <= 0) {
      clearInterval(examState.timer);
      void submitExam(true);
      return;
    }
    renderTime();
  }, 1000);
}

async function submitExam(automatic = false) {
  collectAnswers();
  const answeredCount = examState.exam.questions.filter(answered).length;
  if (!automatic && !confirm(`已完成 ${answeredCount} / ${examState.exam.questions.length} 题，提交后不能修改。确认交卷吗？`)) return;
  const button = $('#submitExam');
  button.disabled = true;
  button.textContent = automatic ? '时间到，正在提交' : '正在提交';
  try {
    const payload = { method: 'POST', body: JSON.stringify({ accessToken, answers: examState.answers }) };
    let result;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        result = await api(`/api/exams/${examId}/submit`, payload);
        break;
      } catch (error) {
        if (error.message.includes('考试时间已结束') || attempt === 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }
    sessionStorage.setItem('jlb.result', JSON.stringify(result));
    clearSavedExam();
    location.href = `/result.html?id=${encodeURIComponent(result.id)}&token=${encodeURIComponent(accessToken)}`;
  } catch (error) {
    button.disabled = false;
    button.textContent = '提交试卷';
    alert(error.message);
  }
}

function renderFailure(title, message) {
  $('#examApp').innerHTML = `<div class="exam-loading"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><a class="primary-action" href="/">返回考试入口</a></div></div>`;
}

async function loadExam() {
  if (!examId || !accessToken) return renderFailure('考试链接无效', '请返回考试入口重新开始。');
  try {
    const exam = await api(`/api/exams/${encodeURIComponent(examId)}?token=${encodeURIComponent(accessToken)}`);
    if (exam.status === 'submitted') {
      clearSavedExam();
      location.href = `/result.html?id=${encodeURIComponent(exam.result.id)}&token=${encodeURIComponent(accessToken)}`;
      return;
    }
    examState.exam = exam;
    const saved = readSavedExam();
    if (saved?.id === exam.id && saved.accessToken === accessToken && saved.answers && typeof saved.answers === 'object') {
      examState.answers = saved.answers;
    }
    renderExam();
  } catch (error) {
    renderFailure('无法进入考试', error.message);
  }
}

loadExam();
