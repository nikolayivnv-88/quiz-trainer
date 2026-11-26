"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const main = $("#main");
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const e = escapeHTML;
const checkIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
const slidersIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16M8 3v8m8 2v8"/></svg>';
const statusNames = {playing:"В процес", review:"Проверени отговори", completed:"Завършена"};
const state = {data:null, questions:[], session:null, draft:null, mode:"topic", categories:[], difficulty:"mixed", count:10, library:{q:"",category:"",kind:"",limit:25}, busy:false};
const canManage = () => state.data?.permissions?.can_manage === true;
let autosaveTimeout, toastTimeout, searchTimeout, routeVersion = 0, mutationTail = Promise.resolve();

async function api(path, method = "GET", body) {
  let response;
  try {
    response = await fetch(path, {method, headers:{...(body === undefined ? {} : {"Content-Type":"application/json"}), ...(method === "GET" ? {} : {"X-Quiz-CSRF":state.data?.csrf_token || ""})}, body:body === undefined ? undefined : JSON.stringify(body), cache:"no-store"});
  } catch {
    throw new Error("Няма връзка с приложението. Проверете интернет връзката и презаредете.");
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Заявката не беше изпълнена.");
  return result;
}

function toast(message, error = false) {
  clearTimeout(toastTimeout);
  const target = $("#toast");
  target.textContent = message;
  target.className = error ? "error" : "";
  target.hidden = false;
  toastTimeout = setTimeout(() => { target.hidden = true; }, error ? 9000 : 3500);
}

async function loadData() {
  const [data, bank] = await Promise.all([api("/api/bootstrap"), api("/api/questions")]);
  state.data = data;
  state.questions = bank.questions;
  const accessControl = $("#access-control");
  if (accessControl) accessControl.innerHTML = canManage()
    ? '<a class="quiet" href="/signout-with-chatgpt?return_to=%2F" target="_top">Изход от управлението</a>'
    : '<a class="quiet" href="/signin-with-chatgpt?return_to=%2F" target="_top">Управление</a>';
}

function dateLabel(iso, time = false) {
  return new Intl.DateTimeFormat("bg-BG", {day:"numeric",month:"short",...(time ? {hour:"2-digit",minute:"2-digit"} : {year:"numeric"})}).format(new Date(iso));
}

function option(value, label, current) {
  return `<option value="${e(value)}"${String(value) === String(current) ? " selected" : ""}>${e(label)}</option>`;
}

function countForMode() { return state.mode === "full" ? 51 : state.count; }
function config() { return {mode:state.mode, categories:state.categories, difficulty:state.difficulty, count:countForMode()}; }

function setNav(section) {
  document.querySelectorAll("nav a").forEach(a => {
    const active = a.dataset.route === section;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  $("#page-label").textContent = {home:"Тренировка",library:"Въпроси",history:"История"}[section] || "Тренировъчен център";
}

function meta(q) {
  return `<div class="question-meta"><span class="category">${e(state.data.categories[q.category])}</span><span>${e(state.data.difficulties[q.difficulty])}</span>${q.image ? '<span class="tag">С изображение</span>' : ""}</div>`;
}

function sourceLink(q) {
  if (!q.source_url || !/^https:\/\//i.test(q.source_url)) return "";
  let host = "Източник";
  try { host = new URL(q.source_url).hostname.replace(/^www\./, ""); } catch { return ""; }
  return `<a class="source-link" href="${e(q.source_url)}" target="_blank" rel="noopener noreferrer">Източник: ${e(host)}</a>`;
}

function questionImage(q, reveal = false, eager = false) {
  const media = q.image;
  if (!media || !/^\/media\/v\d{2}\.(jpg|svg)$/.test(media.path)) return "";
  const link = (url, label) => /^https:\/\//i.test(url || "") ? `<a href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(label)}</a>` : "";
  const credit = reveal ? `<figcaption>${e(media.credit)} · ${e(media.license)} ${link(media.source_url, "Източник на изображението")} ${link(media.license_url, "Лиценз")}${media.changes ? `<span class="media-changes">Обработка: ${e(media.changes)}</span>` : ""}</figcaption>` : "";
  return `<figure class="question-media"><img src="${e(media.path)}" alt="Изображение към въпроса" loading="${eager ? "eager" : "lazy"}" decoding="async">${credit}</figure>`;
}

function modeCard(mode, count, title) {
  const selected = state.mode === mode;
  return `<button class="mode-card${selected ? " selected" : ""}" data-action="mode" data-mode="${mode}" aria-pressed="${selected}"><span class="mode-quantity"><span class="mode-count number">${count}</span><span class="mode-unit">въпроса</span></span><h3>${title}</h3><p>${mode === "full" ? "5 кръга + бонус" : mode === "topic" ? "Категория по избор" : "Смесени категории"}</p>${selected ? `<span class="selected-mark">${checkIcon}</span>` : ""}</button>`;
}

function recentSessions() {
  const items = state.data.sessions.slice(0,3);
  return `<section><div class="section-heading"><h2>Последни тренировки</h2><a class="small" href="#/history">Всички</a></div><div class="compact-list">${items.length ? items.map(s => `<div class="compact-row"><div><h3>${e(s.name)}</h3><p>${e(dateLabel(s.updated_at))} · ${s.status === "completed" ? `${s.correct}/${s.count} точки` : e(statusNames[s.status])}</p></div><a class="secondary" href="#/game/${s.id}">${s.status === "completed" ? "Резултат" : "Продължи"}</a></div>`).join("") : '<p class="empty">Няма тренировки.</p>'}</div></section>`;
}

function home(focusSelector) {
  setNav("home");
  const stats = state.data.stats;
  const pending = state.data.sessions.find(s => s.status !== "completed");
  main.innerHTML = `<section class="intro"><div><h1>Тренировка</h1></div><div class="bank-stat"><span class="number">${stats.bank}</span><p>въпроса · ${stats.visual || 0} с изображение</p><a href="#/library">Разгледай въпросите</a></div></section>
  ${pending ? `<div class="banner"><div><h3>Незавършена тренировка</h3><p>${e(pending.name)} · ${e(statusNames[pending.status])} · ${pending.graded}/${pending.count} оценени въпроса</p></div><a class="secondary" href="#/game/${pending.id}">Продължи</a></div>` : ""}
  <section aria-labelledby="mode-title"><div class="section-heading"><h2 id="mode-title">Режим</h2></div><div class="mode-grid">${modeCard("topic",state.count,"Тренировка")}${modeCard("full",51,"Генерална репетиция")}</div></section>
  <div class="dashboard-grid"><section class="panel" aria-labelledby="setup-title"><div class="panel-header"><h2 id="setup-title">${e(state.data.modes[state.mode])}</h2>${slidersIcon}</div><form id="setup-form"><div class="fields">
  <fieldset class="full-width"><legend>Категории</legend><div class="chips"><button type="button" class="chip${state.categories.length === Object.keys(state.data.categories).length ? " selected" : ""}" data-action="all-categories" aria-pressed="${state.categories.length === Object.keys(state.data.categories).length}">Всички</button>${Object.entries(state.data.categories).map(([key,label]) => `<button type="button" class="chip${state.categories.includes(key) ? " selected" : ""}" data-action="category" data-category="${key}" aria-pressed="${state.categories.includes(key)}">${e(label)}</button>`).join("")}</div></fieldset>
  <div class="field"><label for="difficulty">Трудност</label><select id="difficulty" data-config="difficulty">${option("mixed","Смесена",state.difficulty)}${Object.entries(state.data.difficulties).map(([k,v]) => option(k,v,state.difficulty)).join("")}</select></div>
  ${["topic","retry"].includes(state.mode) ? `<div class="field full-width"><label for="count">Брой въпроси${state.mode === "retry" ? " (до наличните пропуски)" : ""}</label><select id="count" data-config="count">${[5,10,20].map(n => option(n,`${n} въпроса`,state.count)).join("")}</select></div>` : ""}
  </div><div class="config-bottom"><button class="primary stretch" id="start-button" type="submit">Започни тренировката</button><p class="availability" id="availability" aria-live="polite"></p><p class="form-error" id="setup-error" role="alert"></p></div></form></section>
  <aside class="aside-stack"><section class="retry-card"><span class="number">${stats.missed.toString().padStart(2,"0")}</span><h3>Втори шанс</h3><button class="quiet" data-action="retry"${!stats.missed ? " disabled" : ""}>Тренирай пропуските</button></section>${recentSessions()}</aside></div>`;
  updateAvailability();
  if (focusSelector) $(focusSelector)?.focus({preventScroll:true});
}

function updateAvailability() {
  const element = $("#availability");
  const button = $("#start-button");
  if (!element || !button) return;
  const available = state.questions.filter(q => state.categories.includes(q.category) && (state.difficulty === "mixed" || q.difficulty === state.difficulty));
  const count = state.mode === "retry" ? available.filter(q => state.data.missed_ids.includes(q.id)).length : available.length;
  const need = countForMode();
  const shortage = state.mode === "retry" ? count === 0 : count < need;
  button.disabled = shortage || state.categories.length === 0;
  element.classList.toggle("warning", shortage);
  element.textContent = state.mode === "retry" ? `До ${Math.min(need,count)} въпроса.` : shortage ? `Налични: ${count} от нужни ${need}. Променете филтрите.` : `${count} налични въпроса`;
}

async function startTraining() {
  if (state.busy) return;
  const error = $("#setup-error");
  if (error) error.textContent = "";
  state.busy = true;
  const button = $("#start-button");
  if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); button.textContent = "Подготовка на играта…"; }
  try {
    const session = await api("/api/sessions", "POST", config());
    location.hash = `/game/${session.id}`;
  } catch (err) {
    if (error) error.textContent = err.message; else toast(err.message, true);
    if (button) { button.disabled = false; button.textContent = "Започни тренировката"; }
  } finally { state.busy = false; button?.removeAttribute("aria-busy"); }
}

function selectedRetry() {
  state.mode = "retry"; state.categories = Object.keys(state.data.categories); state.difficulty = "mixed";
  if (location.hash === "#/" || !location.hash) { home(); $("#setup-title").scrollIntoView({block:"center"}); }
  else location.hash = "/";
}

function categoryRows(stats, includeEmpty = true) {
  return Object.entries(state.data.categories).filter(([key])=>includeEmpty || stats[key]?.total).map(([key,label]) => {
    const row = stats[key] || {total:0,correct:0};
    return `<div class="category-row"><span>${e(label)}</span><progress max="${row.total || 1}" value="${row.correct}" aria-label="${e(label)}: ${row.correct} от ${row.total}"></progress><span class="number">${row.total ? `${row.correct}/${row.total}` : "—"}</span></div>`;
  }).join("");
}

function history() {
  setNav("history");
  const stats = state.data.stats;
  const rows = Object.values(stats.categories);
  const total = rows.reduce((sum,r) => sum + r.total, 0);
  const correct = rows.reduce((sum,r) => sum + r.correct, 0);
  main.innerHTML = `<div class="page-heading"><div><h1>История</h1></div></div>
  <div class="metric-grid"><div class="metric"><strong class="number">${stats.completed}</strong><span>завършени тренировки</span></div><div class="metric"><strong class="number">${total ? `${Math.round(correct/total*100)}%` : "—"}</strong><span>верни от ${total} оценени отговора</span></div><div class="metric"><strong class="number">${stats.missed}</strong><span>въпроса за втори шанс</span></div></div>
  <section><div class="section-heading"><h2>По категории</h2><span class="small">Верни / оценени</span></div>${categoryRows(stats.categories)}${stats.missed ? '<button class="secondary spaced" data-action="retry">Тренирай пропуските</button>' : ""}</section>
  <section class="spaced"><div class="section-heading"><h2>Всички тренировки</h2></div>${state.data.sessions.length ? `<div class="table-wrapper" tabindex="0" role="region" aria-label="Всички тренировки"><table class="history-table"><thead><tr><th>Тренировка</th><th>Дата</th><th>Резултат</th><th>Състояние</th><th><span class="visually-hidden">Действие</span></th></tr></thead><tbody>${state.data.sessions.map(s => `<tr><td>${e(s.name)}</td><td>${e(dateLabel(s.created_at,true))}</td><td>${s.correct}/${s.graded}${s.status === "completed" ? "" : " оценени"}</td><td>${e(statusNames[s.status])}</td><td><a class="secondary" href="#/game/${s.id}">${s.status === "completed" ? "Резултат" : "Продължи"}</a> ${canManage() ? `<button class="danger-button" data-action="delete-session" data-id="${s.id}" aria-label="Изтрий тренировка">Изтрий</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty-large"><h2>Няма тренировки</h2><a class="primary spaced" href="#/">Към тренировките</a></div>'}</section>`;
}

function library() {
  setNav("library");
  const filters = state.library;
  main.innerHTML = `<div class="page-heading"><div><h1>Въпроси</h1></div><span class="tag">${state.data.stats.bank} въпроса</span></div>
  <div class="filters"><div class="field search-field"><label for="library-search">Търсене</label><input id="library-search" type="search" placeholder="Въпрос или отговор" value="${e(filters.q)}" autocomplete="off"></div><div class="field"><label for="library-category">Категория</label><select id="library-category">${option("","Всички категории",filters.category)}${Object.entries(state.data.categories).map(([k,v])=>option(k,v,filters.category)).join("")}</select></div><div class="field"><label for="library-kind">Формат</label><select id="library-kind">${option("","Всички въпроси",filters.kind)}${option("visual","С изображение",filters.kind)}${option("text","Само текст",filters.kind)}</select></div></div><div id="library-results"></div>`;
  libraryResults();
}

function libraryResults() {
  const f = state.library;
  const term = f.q.trim().toLocaleLowerCase("bg");
  const questions = state.questions.filter(q => (!f.category || q.category === f.category) && (!f.kind || (f.kind === "visual" ? !!q.image : !q.image)) && (!term || `${q.prompt} ${q.answer}`.toLocaleLowerCase("bg").includes(term)));
  $("#library-results").innerHTML = `<p class="result-count">${questions.length} намерени въпроса</p>${questions.slice(0,f.limit).map(q => `<details class="library-row"><summary><div>${meta(q)}<h3>${e(q.prompt)}</h3></div></summary><div class="library-content">${questionImage(q,true)}<p class="canonical">${e(q.answer)}</p>${q.alternatives.length ? `<p class="small muted">Допустими варианти: ${e(q.alternatives.join(" · "))}</p>` : ""}<p class="muted small">${e(q.explanation)}</p>${sourceLink(q)}${canManage() ? `<div class="library-actions"><button class="secondary" data-action="edit" data-id="${q.id}">Редактирай</button><button class="danger-button" data-action="delete-question" data-id="${q.id}">Изтрий</button></div>` : ""}</div></details>`).join("") || '<p class="empty">Няма намерени въпроси.</p>'}${questions.length > f.limit ? '<div class="library-more"><button class="secondary" data-action="library-more">Покажи още 25</button></div>' : ""}`;
}

function openEditor(identity) {
  const q = state.questions.find(item => item.id === identity);
  if (!q) return;
  const dialog = $("#editor");
  dialog.innerHTML = `<div class="dialog-heading"><div><h2 id="editor-title">Редактиране на въпрос</h2></div><button class="close-dialog" data-action="close-editor" aria-label="Затвори">×</button></div>${questionImage(q,true)}<form id="edit-form" data-id="${q.id}"><div class="fields"><div class="field full-width"><label for="edit-prompt">Въпрос</label><textarea id="edit-prompt" name="prompt" required maxlength="1500">${e(q.prompt)}</textarea></div><div class="field full-width"><label for="edit-answer">Отговор</label><input id="edit-answer" name="answer" value="${e(q.answer)}" required maxlength="500"></div><div class="field full-width"><label for="edit-alternatives">Допустими варианти — по един на ред</label><textarea id="edit-alternatives" name="alternatives">${e(q.alternatives.join("\n"))}</textarea></div><div class="field full-width"><label for="edit-explanation">Обяснение</label><textarea id="edit-explanation" name="explanation" required maxlength="2000">${e(q.explanation)}</textarea></div><div class="field"><label for="edit-category">Категория</label><select id="edit-category" name="category">${Object.entries(state.data.categories).map(([k,v])=>option(k,v,q.category)).join("")}</select></div><div class="field"><label for="edit-difficulty">Трудност</label><select id="edit-difficulty" name="difficulty">${Object.entries(state.data.difficulties).map(([k,v])=>option(k,v,q.difficulty)).join("")}</select></div></div><p class="small muted spaced">Редакцията премахва източника и важи само за бъдещи игри.</p><p id="edit-error" class="form-error" role="alert"></p><div class="actions"><button class="primary" type="submit">Запази</button><button class="secondary" type="button" data-action="close-editor">Отказ</button></div></form>`;
  dialog.showModal();
}

async function updateQuestion(identity, changes) {
  const q = state.questions.find(item => item.id === identity);
  await api(`/api/questions/${identity}`, "PUT", {...q,...changes});
  await loadData();
}

function confirmQuestionDeletion(identity) {
  const q = state.questions.find(item => item.id === identity);
  if (!q) return;
  const dialog = $("#delete-question");
  dialog.innerHTML = `<h2 id="delete-title">Изтриване на въпрос</h2><p>${e(q.prompt)}</p><p class="small muted spaced">Изтриването е окончателно. Историята се запазва.</p><p id="delete-error" class="form-error" role="alert"></p><div class="actions"><button class="danger-button" data-action="confirm-delete-question" data-id="${e(q.id)}">Изтрий въпроса</button><button class="secondary" data-action="cancel-delete-question" autofocus>Отказ</button></div>`;
  dialog.showModal();
}

async function deleteQuestion(identity) {
  await api(`/api/questions/${identity}`, "DELETE");
  await loadData();
  $("#delete-question").close();
  library();
  toast("Въпросът е изтрит.");
}

function setDraft() {
  if (!state.session || state.session.status !== "playing") { state.draft = null; return; }
  const answer = state.session.answers[state.session.index];
  state.draft = {id:state.session.id,index:state.session.index,text:answer.text,dirty:false};
}

function mutateSession(action, payload = {}) {
  const identity = state.session.id;
  const task = mutationTail.catch(() => {}).then(async () => {
    if (state.session?.id !== identity) throw new Error("Отворена е друга игра. Презаредете страницата.");
    const updated = await api(`/api/sessions/${identity}`, "PATCH", {action, revision:state.session.revision,...payload});
    state.session = updated;
    return updated;
  });
  mutationTail = task;
  return task;
}

async function saveDraft() {
  clearTimeout(autosaveTimeout);
  if (state.busy) return mutationTail.catch(() => {});
  const draft = state.draft;
  if (!draft || !draft.dirty || state.session?.status !== "playing") return mutationTail.catch(() => {});
  const snapshot = {...draft};
  if ($("#save-status")) $("#save-status").textContent = "Запазване…";
  await mutateSession("save_answer", {question_index:snapshot.index,text:snapshot.text});
  if (state.draft?.id === snapshot.id && state.draft?.index === snapshot.index && state.draft.text === snapshot.text) {
    state.draft.dirty = false;
    if ($("#save-status")) $("#save-status").textContent = "Запазено";
  }
}

function game() {
  setNav("home");
  const s = state.session;
  if (s.status === "completed") return results();
  if (s.status === "review") return review();
  const q = s.questions[s.index];
  const round = Math.floor(s.index / 10) + 1;
  const rounds = Math.ceil(s.questions.length / 10);
  const roundStart = Math.floor(s.index / 10) * 10;
  const roundEnd = Math.min(roundStart + 10,s.questions.length);
  const lastInRound = s.index + 1 === roundEnd;
  main.innerHTML = `<div class="game-shell"><div class="game-heading"><div><h2>${e(s.name)}</h2><p>${s.mode === "full" && round === 6 ? "Бонус въпрос" : `Кръг ${round} от ${rounds}`} · въпрос ${s.index+1} от ${s.questions.length}</p><button class="quiet" data-action="leave-game">Запази и излез</button></div></div><div class="round-track" aria-label="Напредък в кръга">${Array.from({length:roundEnd-roundStart},(_,i)=>`<span class="${roundStart+i < s.index ? "done" : roundStart+i === s.index ? "current" : ""}"></span>`).join("")}</div><div class="question-layout"><div class="question-index number">${String(s.index+1).padStart(2,"0")}</div><div class="question-body">${meta(q)}<h1>${e(q.prompt)}</h1>${questionImage(q,false,true)}<form id="answer-form"><label class="answer-label" for="answer">Отговор</label><textarea id="answer" name="answer" placeholder="Вашият отговор…" maxlength="2000" autocomplete="off">${e(state.draft?.text || "")}</textarea><p class="save-status" id="save-status" role="status">Запазено</p><p id="game-error" class="form-error" role="alert"></p><div class="game-bottom"><p>Enter: предай · Shift+Enter: нов ред</p><button class="primary" id="answer-next" type="submit">${lastInRound ? "Предай кръга" : "Следващ въпрос"}</button></div></form></div></div></div>`;
  $("#answer")?.focus();
}

async function submitAnswer() {
  if (state.busy || state.session?.status !== "playing") return;
  state.busy = true;
  clearTimeout(autosaveTimeout);
  const button = $("#answer-next");
  if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
  if ($("#answer")) $("#answer").readOnly = true;
  try {
    const snapshot = {...state.draft};
    await mutateSession("next",{question_index:snapshot.index,text:snapshot.text});
    setDraft();
    game();
    window.scrollTo(0,0);
  } catch (error) {
    if ($("#game-error")) $("#game-error").textContent = error.message;
    if (button) button.disabled = false;
    if ($("#answer")) $("#answer").readOnly = false;
  } finally { state.busy = false; button?.removeAttribute("aria-busy"); }
}

function reviewItem(q, a, index) {
  const wrong = a.correct === false;
  const verdict = a.accepted_at ? "Приет" : a.correct ? "Верен" : "Грешен";
  return `<article class="review-item"><span class="number">${String(index+1).padStart(2,"0")}</span><div class="review-content"><div class="review-question"><span class="review-category">${e(state.data.categories[q.category])}</span><h3 id="review-question-${index}" tabindex="-1">${e(q.prompt)}</h3></div><div class="review-cards">
  <div class="review-card"><span>Даден отговор</span><strong>${e(a.text || "Без отговор")}</strong></div>
  <div class="review-card"><span>Верен отговор</span><strong>${e(q.answer)}</strong></div>
  <div class="review-card verdict-card ${a.correct ? "correct" : "wrong"}"><span>Резултат</span><strong>${verdict}</strong></div>
  ${canManage() ? `<div class="review-card action-card"><button class="secondary" data-action="accept-answer" data-index="${index}"${!wrong || !a.text.trim() ? " disabled" : ""}>Приеми за верен</button></div>` : ""}
  <div class="review-card action-card"><button class="secondary" data-action="review-details" data-index="${index}">Подробности</button></div>
  </div></div></article>`;
}

function openReviewDetails(index) {
 const q=state.session.questions[index];
 const dialog=$("#review-details");
 dialog.innerHTML=`<div class="dialog-heading"><h2 id="review-details-title">Подробности</h2><button class="close-dialog" data-action="close-review-details" aria-label="Затвори">×</button></div><p class="spaced">${e(q.prompt)}</p>${questionImage(q,true)}<p class="spaced">${e(q.explanation)}</p><p class="small muted spaced">Варианти: ${e([q.answer,...q.alternatives].join(" · "))}</p>${sourceLink(q)}`;
 dialog.showModal();
}

async function acceptAnswer(index) {
  if (state.busy) return;
  state.busy = true;
  const scrollTop = window.scrollY || 0;
  try {
    await mutateSession("accept_answer", {index});
    await loadData();
    game();
    window.scrollTo(0,scrollTop);
    $("#review-question-"+index)?.focus({preventScroll:true});
    toast(state.session.answers[index].variant_saved ? "Отговорът е приет и запазен като вариант." : "Приет за тази игра. Въпросът в банката е редактиран или изтрит.");
  } finally { state.busy = false; }
}

function review() {
  const s = state.session;
  const start = Math.floor(s.index/10)*10;
  const end = Math.min(start+10,s.questions.length);
  main.innerHTML = `<div class="game-shell"><div class="review-intro"><p class="eyebrow">${s.mode === "full" && start === 50 ? "Бонус въпрос" : `Кръг ${Math.floor(start/10)+1}`}</p><h1>Отговори</h1></div>${s.questions.slice(start,end).map((q,i)=>reviewItem(q,s.answers[start+i],start+i)).join("")}<div class="review-footer"><p>${s.answers.slice(start,end).filter(a=>a.correct === true).length}/${end-start} верни отговора</p><button class="primary" data-action="next-round">${end === s.questions.length ? "Виж резултата" : end === 50 ? "Към бонус въпроса" : "Следващ кръг"}</button></div><button class="quiet" data-action="leave-game">Запази и излез</button></div>`;
}

function results() {
  const s = state.session;
  const correct = s.answers.filter(a=>a.correct === true).length;
  const categories = {};
  s.questions.forEach((q,i)=>{const r=categories[q.category] ||= {total:0,correct:0};r.total++;r.correct += Number(s.answers[i].correct === true);});
  main.innerHTML = `<div class="page-heading"><div><p class="eyebrow">${e(s.name)} · ${e(dateLabel(s.created_at))}</p><h1>Резултат</h1></div><a class="secondary" href="#/">Нова тренировка</a></div><section class="score-hero"><div><span class="number">${correct}</span><span class="score-total"> / ${s.questions.length}</span><p class="spaced">верни отговора · ${Math.round(correct/s.questions.length*100)}% успеваемост</p></div></section><div><section><div class="section-heading"><h2>Резултат по теми</h2></div>${categoryRows(categories,false)}</section>${correct < s.questions.length ? '<button class="primary spaced" data-action="retry">Тренирай пропуските</button>' : ""}</div><section class="spaced"><div class="section-heading"><h2>Отговори</h2></div>${s.questions.map((q,i)=>reviewItem(q,s.answers[i],i)).join("")}</section>`;
}

function currentPath() { return location.hash.slice(1).split("?")[0] || "/"; }

async function route() {
  const version = ++routeVersion;
  clearTimeout(autosaveTimeout);
  try {
    await saveDraft();
    await loadData();
    if (version !== routeVersion) return;
    state.session = null; state.draft = null;
    const path = currentPath();
    if (path === "/library") library();
    else if (path === "/history") history();
    else if (/^\/game\/[a-f0-9]{32}$/.test(path)) {
      const session = await api(`/api/sessions/${path.split("/")[2]}`);
      if (version !== routeVersion) return;
      state.session = session;
      setDraft(); game();
    }
    else home();
    window.scrollTo(0,0);
    if (state.session?.status === "playing") $("#answer")?.focus({preventScroll:true});
    else main.focus({preventScroll:true});
  } catch (error) {
    if (version !== routeVersion) return;
    main.innerHTML = `<section class="empty-large"><h1>Не успяхме да заредим.</h1><p class="muted spaced">${e(error.message)}</p><button class="primary spaced" data-action="reload">Опитай отново</button></section>`;
  }
}

document.addEventListener("click", async event => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  try {
    if (action === "mode") { state.mode = button.dataset.mode; state.categories = Object.keys(state.data.categories); home(`[data-action="mode"][data-mode="${state.mode}"]`); }
    else if (action === "category") {
      const key = button.dataset.category;
      if (state.categories.length === Object.keys(state.data.categories).length) state.categories = [key];
      else state.categories = state.categories.includes(key) ? state.categories.filter(c=>c !== key) : [...state.categories,key];
      home(`[data-action="category"][data-category="${key}"]`);
    }
    else if (action === "all-categories") { state.categories = Object.keys(state.data.categories); home('[data-action="all-categories"]'); }
    else if (action === "retry") selectedRetry();
    else if (action === "library-more") { state.library.limit += 25; libraryResults(); }
    else if (action === "edit") openEditor(button.dataset.id);
    else if (action === "close-editor") $("#editor").close();
    else if (action === "delete-question") confirmQuestionDeletion(button.dataset.id);
    else if (action === "cancel-delete-question") $("#delete-question").close();
    else if (action === "confirm-delete-question") {
      button.disabled = true;
      try { await deleteQuestion(button.dataset.id); }
      catch (error) { $("#delete-error").textContent = error.message; button.disabled = false; }
    }
    else if (action === "leave-game") { button.disabled = true; await saveDraft(); state.draft = null; location.hash = "/"; }
    else if (action === "review-details") openReviewDetails(Number(button.dataset.index));
    else if (action === "close-review-details") $("#review-details").close();
    else if (action === "delete-session") {
      const dialog=$("#delete-session");
      dialog.innerHTML=`<h2 id="delete-session-title">Изтриване на тренировка</h2><p>Тренировката ще бъде изтрита. Статистиките ще се преизчислят.</p><div class="actions"><button class="danger-button" data-action="confirm-delete-session" data-id="${e(button.dataset.id)}">Изтрий</button><button class="secondary" data-action="cancel-delete-session">Отказ</button></div>`;
      dialog.showModal();
    }
    else if (action === "cancel-delete-session") $("#delete-session").close();
    else if (action === "confirm-delete-session") {
      button.disabled=true; await api(`/api/sessions/${button.dataset.id}`,"DELETE"); await loadData(); $("#delete-session").close(); history(); toast("Тренировката е изтрита.");
    }
    else if (action === "accept-answer") { button.disabled = true; await acceptAnswer(Number(button.dataset.index)); }
    else if (action === "next-round") { button.disabled = true; await mutateSession("next_round"); setDraft(); game(); window.scrollTo(0,0); }
    else if (action === "reload") route();
  } catch (error) { toast(error.message,true); if (button?.isConnected) button.disabled = false; }
});

document.addEventListener("input", event => {
  if (event.target.id === "answer" && state.draft) {
    state.draft.text = event.target.value; state.draft.dirty = true;
    $("#save-status").textContent = "Запазване…";
    clearTimeout(autosaveTimeout);
    autosaveTimeout = setTimeout(()=>saveDraft().catch(error=>{ if ($("#save-status")) $("#save-status").textContent = "Не е запазено. Опитайте да предадете отговора отново."; toast(error.message,true); }),350);
  }
  if (event.target.id === "library-search") {
    state.library.q = event.target.value; state.library.limit = 25;
    clearTimeout(searchTimeout); searchTimeout = setTimeout(libraryResults,120);
  }
});

document.addEventListener("change", event => {
  const target = event.target;
  if (target.dataset.config) {
    const key = target.dataset.config;
    state[key] = key === "count" ? Number(target.value) : target.value;
    if (key === "count") {
      const number = $('.mode-card[data-mode="topic"] .mode-count');
      if (number) number.textContent = state.count;
    }
    updateAvailability();
  }
  if (target.id === "library-category" || target.id === "library-kind") { state.library[target.id === "library-category" ? "category" : "kind"] = target.value; state.library.limit = 25; libraryResults(); }
});

function handleAnswerKeydown(event) {
  if (event.target.id !== "answer" || event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
  event.preventDefault();
  if (!event.repeat) return submitAnswer();
}

document.addEventListener("keydown", handleAnswerKeydown);

document.addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.target;
  if (form.id === "setup-form") return startTraining();
  if (form.id === "answer-form") return submitAnswer();
  const button = $("button[type=submit]",form);
  if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
  try {
    if (form.id === "edit-form") {
      $("#edit-error").textContent = "";
      const values = Object.fromEntries(new FormData(form));
      values.alternatives = values.alternatives.split("\n").map(s=>s.trim()).filter(Boolean);
      await updateQuestion(form.dataset.id,values);
      $("#editor").close(); library(); toast("Въпросът е запазен.");
    }
  } catch (error) {
    const target = $("#edit-error");
    if (target) target.textContent = error.message; else toast(error.message,true);
  } finally { if (button?.isConnected) { button.disabled = false; button.removeAttribute("aria-busy"); } }
});

window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange",()=>{ if (document.visibilityState === "hidden") saveDraft().catch(()=>{}); });

async function boot() {
  try {
    await loadData();
    state.categories = Object.keys(state.data.categories);
    await route();
  } catch (error) {
    main.innerHTML = `<section class="empty-large"><h1>Не успяхме да заредим.</h1><p class="spaced">${e(error.message)}</p><button class="primary spaced" data-action="reload">Опитай отново</button></section>`;
  }
}

boot();
