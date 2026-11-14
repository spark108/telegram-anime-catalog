const el = id => document.getElementById(id);
let view = 'login-scene';
let accessKey = sessionStorage.getItem('catalogKey') || '';
let auth = {};
let sources = [];
const sourceCards = new Map();
let sourceDialogsSignature;
let catalogAfter = 0;
let catalogVersion = 0;
const animeKinds = { tv: 'ТВ-сериал', movie: 'Фильм', ova: 'OVA', ona: 'ONA', special: 'Спецвыпуск', tv_special: 'ТВ-спецвыпуск', music: 'Музыка' };
const catalogFilterGroups = ['sourceIds', 'voiceovers', 'subtitles', 'years'];
let catalogFilters = normalizeCatalogFilters();
const pendingCovers = new Map();
let detailWaiting = false;
let reviewPage = 1;
let reviewVersion = 0;
let refreshVersion = 0;
let qrExpires = 0;
const pendingPublications = new Map();
const episodeViews = new Map();
const episodeColumnLayout = matchMedia('(min-width: 56rem)');
const seasonEpisodeOrder = new WeakMap();
const collapsedSeasons = new Set();
let episodeLayout = null;
let episodeState;
let episodeMaterial = 'all';
let preferredEpisodeSource = '';
let episodeSource = '';
let episodeSourceOptions = '';
let episodeSourceRequest = 0;
let loadingEpisodeSource = false;
const episodeMaterialCounts = { 'dubbed-video': 'dubbedVideos', 'subtitled-video': 'subtitledVideos', subtitle: 'subtitles' };
let episodeReadEpoch = 0;
let readingEpisodes = false;
let viewSettingsWrite = Promise.resolve();
let trackingListSignature;
let trackingListMode = new URLSearchParams(location.search).get('list') === 'blacklist' ? 'blacklist' : 'tracked';
let detailMembershipMenu;
const javaScriptEditors = new Map();

async function api(path, body) {
  const headers = accessHeaders();
  const options = { headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.method = 'POST';
    options.body = JSON.stringify(body);
  }
  const response = await fetch('/api/' + path, options);
  const data = await response.json();
  if (response.status === 401) {
    showView('login-scene');
    el('auth').hidden = true;
    el('unlock').hidden = false;
  }
  if (!response.ok) throw new Error(data.error);
  return data;
}

function accessHeaders() {
  return accessKey ? { 'X-Catalog-Key': accessKey } : {};
}

function notice(message = '') {
  el('notice').hidden = !message;
  el('notice').textContent = message;
}

function action(handler) {
  return async event => {
    event.preventDefault();
    notice();
    try { await handler(event); } catch (error) { notice(error.message); }
  };
}

function item(text) {
  const li = document.createElement('li');
  li.textContent = text;
  return li;
}

function button(text, handler) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  element.addEventListener('click', action(handler));
  return element;
}

function option(text, value) {
  return new Option(text, value);
}

function setJavaScript(textarea, value) {
  textarea.value = value;
  if (!window.CodeMirror) return;
  let editor = javaScriptEditors.get(textarea);
  if (!editor) {
    textarea.required = false;
    editor = window.CodeMirror.fromTextArea(textarea, {
      mode: 'javascript', lineNumbers: true, indentUnit: 2, tabSize: 2, lineWrapping: true,
      screenReaderLabel: textarea.labels?.[0]?.textContent.trim()
    });
    editor.getWrapperElement().classList.add('js-editor');
    if (textarea.name === 'template') editor.getWrapperElement().classList.add('is-caption');
    editor.on('change', () => editor.save());
    javaScriptEditors.set(textarea, editor);
  } else if (editor.getValue() !== value) {
    editor.setValue(value);
  }
  editor.refresh();
}

async function refresh() {
  const version = ++refreshVersion;
  const data = await api('status');
  if (version !== refreshVersion) return;
  auth = data.auth;
  sources = data.sources;
  el('unlock').hidden = true;
  el('auth').hidden = false;
  if (data.accessKey) {
    el('local-access').hidden = false;
    el('access-key').textContent = data.accessKey;
  }
  const labels = {
    phone: auth.configured ? 'Введите номер телефона или выберите вход по QR-коду.' : 'Введите данные приложения Telegram.',
    connecting: 'Соединение с Telegram…',
    code: 'Введите одноразовый код Telegram.',
    qr: 'Подтвердите вход в Telegram.',
    password: 'Введите облачный пароль Telegram.',
    ready: 'Вход выполнен.'
  };
  el('auth-status').textContent = [labels[auth.step], auth.message].filter(Boolean).join(' ');
  el('login').hidden = auth.step !== 'phone';
  for (const element of el('login').querySelectorAll('[data-app-credentials]')) {
    element.hidden = auth.configured;
  }
  for (const name of ['apiId', 'apiHash']) {
    const field = el('login').elements[name];
    field.required = !auth.configured;
    field.disabled = auth.configured;
  }
  const answer = el('answer');
  const password = auth.step === 'password';
  el('cancel-login').hidden = !auth.canCancel;
  el('qr-login').hidden = auth.step !== 'qr';
  const image = el('qr-image');
  qrExpires = auth.qr?.expires ?? 0;
  if (auth.qr && image.getAttribute('src') !== auth.qr.image) image.src = auth.qr.image;
  if (!auth.qr) image.removeAttribute('src');
  updateQrVisibility();
  answer.hidden = !['code', 'password'].includes(auth.step);
  el('answer-label').textContent = password ? 'Облачный пароль' : 'Код подтверждения';
  answer.elements.value.type = password ? 'password' : 'text';
  answer.elements.value.autocomplete = password ? 'current-password' : 'one-time-code';
  if (auth.step !== 'ready') {
    if (view !== 'login-scene') showView('login-scene');
    return;
  }
  if (view === 'login-scene') await loadRoute();
  else if (view === 'sources') await loadSources();
}

function updateQrVisibility() {
  const valid = auth.step === 'qr' && qrExpires > Date.now();
  el('qr-image').hidden = !valid;
  el('qr-renewing').hidden = auth.step !== 'qr' || valid;
}

el('unlock').onsubmit = action(async event => {
  accessKey = event.currentTarget.elements.key.value.trim();
  await refresh();
  sessionStorage.setItem('catalogKey', accessKey);
  el('unlock').reset();
});
el('logout').onclick = action(async event => {
  const control = event.currentTarget;
  control.disabled = true;
  try {
    await api('logout', {});
    location.replace('/');
  } finally {
    control.disabled = false;
  }
});
el('login').onsubmit = action(async event => {
  const form = event.currentTarget;
  await api('login', Object.fromEntries(new FormData(form)));
  form.elements.apiHash.value = '';
  await refresh();
});
el('login-qr').onclick = action(async () => {
  const form = el('login');
  const { apiId, apiHash } = form.elements;
  if (!apiId.reportValidity() || !apiHash.reportValidity()) return;
  await api('login-qr', { apiId: apiId.value, apiHash: apiHash.value });
  apiHash.value = '';
  await refresh();
});
el('answer').onsubmit = action(async event => {
  const form = event.currentTarget;
  const value = form.elements.value.value;
  form.reset();
  await api('answer', { kind: auth.step, value });
  await refresh();
});
el('cancel-login').onclick = action(async () => {
  await api('cancel-login', {});
  el('answer').reset();
  await refresh();
  el('login').elements.phone.select();
});
el('load-dialogs').onclick = action(async event => {
  const control = event.currentTarget;
  control.disabled = true;
  try { showSourceDialogs(await api('dialogs', {})); } finally { control.disabled = false; }
});

const addSourceForm = el('add-source');
const addSourceButton = addSourceForm.querySelector('button:not([type])');
const sourceDialogSearch = el('source-dialog-search');
const sourceDialogTabs = addSourceForm.querySelectorAll('[data-dialog-category]');
const selectedSourceIds = new Set();
const openSourceForums = new Set();
const loadingSourceForums = new Set();
const sourceForumErrors = new Map();
let sourceDialogCategory = 'chats';
let sourceDialogData = { items: [], refreshedAt: null };
let addingSources = false;

function updateAddSourceButton() {
  const count = selectedSourceIds.size;
  addSourceButton.disabled = addingSources || !count;
  addSourceButton.textContent = count ? 'Подключить выбранные (' + count + ')' : 'Подключить выбранные';
}

addSourceForm.onchange = event => {
  const checkbox = event.target;
  if (checkbox.name !== 'ids') return;
  if (checkbox.checked) selectedSourceIds.add(checkbox.value);
  else selectedSourceIds.delete(checkbox.value);
  updateAddSourceButton();
};
addSourceForm.onsubmit = action(async () => {
  const ids = [...selectedSourceIds];
  if (!ids.length || addingSources) return;
  addingSources = true;
  updateAddSourceButton();
  try {
    await api('source', { ids });
    await refresh();
  } finally {
    addingSources = false;
    updateAddSourceButton();
  }
});

sourceDialogSearch.oninput = () => showSourceDialogs();
sourceDialogSearch.onkeydown = event => { if (event.key === 'Enter') event.preventDefault(); };
for (const tab of sourceDialogTabs) {
  tab.onclick = () => {
    sourceDialogCategory = tab.dataset.dialogCategory;
    for (const control of sourceDialogTabs) control.setAttribute('aria-pressed', String(control === tab));
    showSourceDialogs();
  };
}

function sourceSearchKey(value) {
  return value.normalize('NFKC').trim().toLowerCase().replaceAll('ё', 'е');
}

function sourceCheckbox({ id, title }) {
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = 'ids';
  input.value = id;
  input.checked = selectedSourceIds.has(id);
  label.append(input, document.createTextNode(title));
  return label;
}

async function loadSourceTopics(id) {
  if (loadingSourceForums.has(id)) return;
  loadingSourceForums.add(id);
  sourceForumErrors.delete(id);
  showSourceDialogs();
  try {
    showSourceDialogs(await api('source-topics', { id }));
  } catch (error) {
    sourceForumErrors.set(id, error.message);
  } finally {
    loadingSourceForums.delete(id);
    showSourceDialogs();
  }
}

function sourceForum(dialog, topics, open) {
  const group = document.createElement('details');
  group.className = 'source-forum';
  group.open = open;
  const summary = document.createElement('summary');
  summary.dataset.sourceForum = dialog.id;
  summary.textContent = dialog.title;
  summary.onclick = event => {
    event.preventDefault();
    if (group.open) {
      openSourceForums.delete(dialog.id);
      group.open = false;
    } else {
      openSourceForums.add(dialog.id);
      group.open = true;
      void loadSourceTopics(dialog.id);
    }
  };
  const list = document.createElement('div');
  list.className = 'source-forum-topics';
  if (topics.length) list.append(...topics.map(sourceCheckbox));
  const error = sourceForumErrors.get(dialog.id);
  if (loadingSourceForums.has(dialog.id) || error || !topics.length) {
    const status = document.createElement('div');
    status.className = 'muted';
    status.textContent = loadingSourceForums.has(dialog.id) ? 'Загружаем темы…'
      : error || (dialog.topics == null ? 'Темы ещё не загружены.' : 'Нет доступных тем.');
    list.append(status);
    if (error) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Повторить';
      retry.onclick = () => loadSourceTopics(dialog.id);
      list.append(retry);
    }
  }
  group.append(summary, list);
  return group;
}

function showSourceDialogs(data = sourceDialogData) {
  sourceDialogData = data;
  const { items, refreshedAt } = data;
  const connected = new Set(sources.map(source => source.id));
  const available = items.filter(dialog => dialog.category === 'groups' || !connected.has(dialog.id))
    .map(dialog => ({ ...dialog, topics: dialog.topics?.filter(topic => !connected.has(topic.id)) ?? dialog.topics }));
  const query = sourceSearchKey(sourceDialogSearch.value);
  const signature = JSON.stringify([available, sourceDialogCategory, query, Boolean(refreshedAt),
    [...openSourceForums], [...loadingSourceForums], [...sourceForumErrors]]);
  if (signature === sourceDialogsSignature) return;
  sourceDialogsSignature = signature;
  const availableIds = new Set(available.flatMap(dialog => dialog.category === 'groups'
    ? (dialog.topics ?? []).map(topic => topic.id) : [dialog.id]));
  for (const id of selectedSourceIds) if (!availableIds.has(id)) selectedSourceIds.delete(id);
  const matches = [];
  for (const dialog of available) {
    if (dialog.category !== sourceDialogCategory) continue;
    const matched = sourceSearchKey(dialog.title).includes(query) ||
      Boolean(dialog.username && sourceSearchKey('@' + dialog.username).includes(query));
    if (dialog.category !== 'groups') {
      if (matched) matches.push(sourceCheckbox(dialog));
      continue;
    }
    const topics = (dialog.topics ?? []).filter(topic => matched || sourceSearchKey(topic.title).includes(query));
    if (matched || topics.length) matches.push(sourceForum(dialog, topics, !matched || openSourceForums.has(dialog.id)));
  }
  const list = el('source-dialogs');
  const scrollTop = list.scrollTop;
  const focusedForum = document.activeElement?.dataset.sourceForum;
  list.replaceChildren(...matches);
  list.scrollTop = scrollTop;
  if (focusedForum) [...list.querySelectorAll('[data-source-forum]')]
    .find(summary => summary.dataset.sourceForum === focusedForum)?.focus({ preventScroll: true });
  const status = el('source-dialogs-status');
  status.hidden = Boolean(matches.length);
  status.textContent = !refreshedAt ? 'Ожидаем список чатов из Telegram…' :
    query ? 'В этой вкладке ничего не найдено.' : 'В этой вкладке нет доступных источников.';
  updateAddSourceButton();
}

async function loadSources() {
  const list = el('source-list');
  const attached = new Set(sources.map(source => source.id));
  for (const [id, card] of sourceCards) {
    if (attached.has(id)) continue;
    card.remove();
    sourceCards.delete(id);
  }
  for (const source of sources) {
    if (!sourceCards.has(source.id)) {
      const card = createSourceCard(source.id);
      sourceCards.set(source.id, card);
      list.append(card.element);
    }
    sourceCards.get(source.id).update(source);
  }
  el('sources-empty').hidden = Boolean(sources.length);
  showSourceDialogs(await api('dialogs'));
}

function createSourceCard(id) {
  const element = el('source-template').content.firstElementChild.cloneNode(true);
  const analyzer = element.querySelector('[data-source-pane=analyzer]');
  const preview = element.querySelector('[data-source-pane=preview]');
  const code = analyzer.elements.code;
  const analyzerFile = analyzer.elements.analyzerFile;
  const loadAnalyzer = element.querySelector('[data-load-analyzer]');
  const sampleSelect = preview.elements.samples;
  const result = preview.querySelector('[data-preview-result]');
  const analyzerStatus = element.querySelector('[data-analyzer-status]');
  const tabs = element.querySelectorAll('[data-source-tab]');
  const panes = element.querySelectorAll('[data-source-pane]');
  const sourcePath = 'source?' + new URLSearchParams({ id });
  const samplesPath = 'source-samples?' + new URLSearchParams({ id });
  let samples = [];
  let loaded = false;
  let loading = false;
  let removed = false;

  function showSamples(rows) {
    samples = rows;
    sampleSelect.replaceChildren(option('Выберите сообщение', ''), ...samples.map((row, index) =>
      option('#' + row.id + ' · ' + (row.text.split('\n')[0] || row.attachments[0]?.fileName || 'Без подписи').slice(0, 75), index)));
  }

  element.ontoggle = async () => {
    if (!element.open || loading) return;
    if (loaded) {
      if (!analyzer.hidden) javaScriptEditors.get(code)?.refresh();
      return;
    }
    loading = true;
    try {
      const [data, library] = await Promise.all([api(sourcePath), api('analyzer-library')]);
      if (removed) return;
      setJavaScript(code, data.code);
      showSamples(data.samples);
      analyzerFile.replaceChildren(...library.map(file => option(file, file)));
      analyzerFile.disabled = loadAnalyzer.disabled = !library.length;
      analyzer.querySelector('button:not([type])').disabled = false;
      preview.querySelector('button:not([type])').disabled = false;
      loaded = true;
    } catch (error) {
      notice(error.message);
    } finally {
      loading = false;
    }
  };

  for (const tab of tabs) {
    tab.onclick = () => {
      for (const control of tabs) control.setAttribute('aria-pressed', String(control === tab));
      for (const pane of panes) pane.hidden = pane.dataset.sourcePane !== tab.dataset.sourceTab;
      if (!analyzer.hidden) javaScriptEditors.get(code)?.refresh();
    };
  }
  loadAnalyzer.onclick = action(async () => {
    const { code: draft } = await api('analyzer-library?' + new URLSearchParams({ file: analyzerFile.value }));
    setJavaScript(code, draft);
    analyzerStatus.hidden = false;
    analyzerStatus.textContent = 'Анализатор загружен в редактор. Сохраните его, чтобы применить.';
  });
  analyzer.onsubmit = action(async () => {
    await api('analyzer', { id, code: code.value });
    analyzerStatus.hidden = false;
    analyzerStatus.textContent = 'Анализатор сохранён. Сообщения будут обработаны.';
    await refresh();
  });
  preview.querySelector('[data-load-samples]').onclick = action(async () => showSamples(await api(samplesPath)));
  element.querySelector('[data-detach-source]').onclick = action(async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api('detach-source', { id });
      await refresh();
    } finally {
      button.disabled = false;
    }
  });
  sampleSelect.onchange = () => {
    if (sampleSelect.value === '') return;
    const sample = samples[Number(sampleSelect.value)];
    preview.elements.text.value = sample.text;
    preview.elements.attachments.value = JSON.stringify(sample.attachments, null, 2);
  };
  preview.onsubmit = action(async () => {
    const { text, attachments } = preview.elements;
    const data = await api('preview', { code: code.value, text: text.value, attachments: JSON.parse(attachments.value) });
    result.hidden = false;
    result.textContent = JSON.stringify(data, null, 2);
  });
  return {
    element,
    remove() {
      removed = true;
      javaScriptEditors.get(code)?.toTextArea();
      javaScriptEditors.delete(code);
      element.remove();
    },
    update(source) {
      const progress = source.historyDone ? 'История загружена'
        : !source.configured ? 'Импорт начнётся после сохранения анализатора'
        : source.cursor ? 'Импорт истории · ID ' + source.cursor : 'Ожидание импорта';
      element.querySelector('[data-source-title]').textContent = source.title;
      const status = [progress, source.configured ? 'Анализатор настроен' : '', source.errors.length ? 'Ошибка синхронизации' : ''].filter(Boolean).join(' · ');
      element.querySelector('[data-source-status]').textContent = status;
      element.querySelector('[data-source-progress]').textContent = status;
      const errors = element.querySelector('[data-source-errors]');
      errors.hidden = !source.errors.length;
      errors.replaceChildren(...source.errors.map(item));
    }
  };
}

function normalizeCatalogFilters(saved) {
  const tracking = ['updates', 'tracked', 'untracked', 'blacklisted'].includes(saved?.tracking) ? saved.tracking : 'all';
  return {
    onlyVoiceovers: saved?.onlyVoiceovers === true,
    onlySubtitles: saved?.onlyVoiceovers !== true && saved?.onlySubtitles === true,
    tracking, onlyUnread: saved?.onlyUnread === true, includeBlacklist: saved?.includeBlacklist !== false,
    sourceIds: Array.isArray(saved?.sourceIds) ? saved.sourceIds.filter(value => typeof value === 'string') : [],
    voiceovers: Array.isArray(saved?.voiceovers) ? saved.voiceovers.filter(value => typeof value === 'string') : [],
    subtitles: Array.isArray(saved?.subtitles) ? saved.subtitles.filter(value => typeof value === 'string') : [],
    years: Array.isArray(saved?.years) ? saved.years.filter(Number.isSafeInteger) : []
  };
}

async function loadViewSettings() {
  let settings = await api('view-settings');
  let previous;
  try { previous = JSON.parse(localStorage.getItem('catalogFilters')); } catch { previous = null; }
  if (!settings.catalogFilters && previous) {
    settings = await api('view-settings', { initialCatalogFilters: normalizeCatalogFilters(previous) });
  }
  if (settings.catalogFilters && previous) {
    try { localStorage.removeItem('catalogFilters'); } catch { /* The server setting takes precedence. */ }
  }
  catalogFilters = normalizeCatalogFilters(settings.catalogFilters);
  episodeMaterial = settings.episodeMaterial === 'video' ? 'dubbed-video' : settings.episodeMaterial ?? 'all';
  preferredEpisodeSource = settings.episodeSource ?? '';
  el('episode-material').value = episodeMaterial;
}

function saveViewSettings(change) {
  const write = viewSettingsWrite.then(() => api('view-settings', change));
  viewSettingsWrite = write.catch(() => {});
  return write;
}

function showCatalogFilters(options = {}) {
  const form = el('catalog-filters');
  form.elements.material.value = catalogFilters.onlyVoiceovers ? 'voiceovers' : catalogFilters.onlySubtitles ? 'subtitles' : 'all';
  form.elements.tracking.value = catalogFilters.tracking;
  form.elements.onlyUnread.checked = catalogFilters.onlyUnread;
  form.elements.onlyUnread.disabled = catalogFilters.tracking !== 'tracked';
  form.elements.includeBlacklist.checked = catalogFilters.includeBlacklist;
  form.elements.includeBlacklist.disabled = catalogFilters.tracking !== 'all';
  for (const name of catalogFilterGroups) {
    const selected = new Set(catalogFilters[name]);
    const sourceTitles = name === 'sourceIds' ? new Map((options.sources ?? []).map(({ id, title }) => [id, title])) : null;
    const displayName = value => sourceTitles?.get(value) ?? String(value);
    const values = [...new Set([...(sourceTitles ? sourceTitles.keys() : options[name] ?? []), ...selected])];
    values.sort(name === 'years' ? (a, b) => b - a : (a, b) => displayName(a).localeCompare(displayName(b), 'ru'));
    const list = el('filter-' + name);
    list.replaceChildren(...values.map(value => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = name;
      input.value = value;
      input.checked = selected.has(value);
      label.append(input, document.createTextNode(displayName(value)));
      return label;
    }));
    if (!values.length) list.textContent = 'Нет данных';
  }
}

showCatalogFilters();

async function loadCatalogFilters() {
  showCatalogFilters(await api('catalog-filters'));
}

el('catalog-filters').onchange = action(async event => {
  const form = event.currentTarget;
  const selected = new FormData(form);
  const tracking = form.elements.tracking.value;
  const material = form.elements.material.value;
  const unread = form.elements.onlyUnread;
  const blacklist = form.elements.includeBlacklist;
  unread.disabled = tracking !== 'tracked';
  blacklist.disabled = tracking !== 'all';
  catalogFilters = {
    onlyVoiceovers: material === 'voiceovers',
    onlySubtitles: material === 'subtitles',
    tracking, onlyUnread: unread.checked, includeBlacklist: blacklist.checked,
    sourceIds: selected.getAll('sourceIds'),
    voiceovers: selected.getAll('voiceovers'),
    subtitles: selected.getAll('subtitles'),
    years: selected.getAll('years').map(Number)
  };
  await Promise.all([saveViewSettings({ catalogFilters }), loadCatalog(true)]);
});

function membershipMenu(id, state, posterTitle, onChange) {
  const element = document.createElement('details');
  element.className = 'membership-menu poster-membership-menu';
  const summary = document.createElement('summary');
  summary.textContent = '⋯';
  summary.setAttribute('aria-label', 'Добавить в список · ' + posterTitle);
  const options = document.createElement('div');
  options.className = 'membership-menu-options';
  let pending = false;
  const tracked = button('Отслеживаемые', () => change('tracked'));
  const blacklisted = button('Черный список', () => change('blacklisted'));
  options.append(tracked, blacklisted);
  element.append(summary, options);
  element.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !element.open) return;
    event.preventDefault();
    element.open = false;
    summary.focus();
  });
  update(state);
  return { element, update };

  function update(next) {
    state = next;
    tracked.disabled = pending || Boolean(state.tracked);
    blacklisted.disabled = pending || Boolean(state.blacklisted);
  }

  async function change(status) {
    pending = true;
    update(state);
    try {
      const next = await api('anime-membership', { id, status });
      update(next);
      element.open = false;
      summary.focus();
      await onChange(next);
    } finally {
      pending = false;
      update(state);
    }
  }
}

function updatePosterMembership(card, marker, { tracked, blacklisted }) {
  card.classList.toggle('is-tracked', Boolean(tracked));
  card.classList.toggle('is-blacklisted', Boolean(blacklisted));
  marker.hidden = !tracked && !blacklisted;
  marker.textContent = blacklisted ? '×' : '+';
  marker.setAttribute('aria-label', blacklisted ? 'В черном списке' : 'Отслеживается');
}

document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll('.membership-menu[open]')) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});

async function loadCatalog(reset) {
  if (reset) {
    catalogVersion++;
    catalogAfter = 0;
    el('more-catalog').hidden = true;
    pendingCovers.clear();
    for (const frame of el('catalog-list').querySelectorAll('.poster-frame')) posterObserver.unobserve(frame);
    el('catalog-list').replaceChildren();
  }
  const version = catalogVersion;
  const q = el('search').elements.q.value;
  const result = await api('catalog', { q, after: catalogAfter, filters: catalogFilters, includeCounts: reset });
  if (version !== catalogVersion) return;
  const rows = reset ? result.rows : result;
  if (reset) {
    for (const [id, count] of [['catalog-total', result.total], ['catalog-matched', result.matched]]) {
      const counter = el(id);
      counter.textContent = count.toLocaleString('ru-RU');
      counter.hidden = false;
    }
  }
  const list = el('catalog-list');
  if (!rows.length && reset) {
    const empty = item('Тайтлы не найдены.');
    empty.className = 'catalog-empty';
    list.append(empty);
  }
  for (const row of rows) {
    const li = item('');
    const link = document.createElement('a');
    link.className = 'poster-card';
    link.href = '/anime/' + row.id + (q ? '?' + new URLSearchParams({ q }) : '');
    const visual = document.createElement('div');
    visual.className = 'poster-visual';
    const frame = document.createElement('div');
    frame.className = 'poster-frame';
    const rating = document.createElement('span');
    rating.className = 'poster-rating';
    visual.append(frame, rating);
    const marker = document.createElement('span');
    marker.className = 'poster-status';
    marker.setAttribute('role', 'img');
    updatePosterMembership(link, marker, row);
    visual.append(marker);
    const copy = document.createElement('span');
    copy.className = 'poster-copy';
    const title = document.createElement('span');
    title.className = 'poster-title';
    title.textContent = row.title;
    title.title = row.title;
    const meta = document.createElement('span');
    meta.className = 'poster-meta';
    const kind = document.createElement('span');
    const year = document.createElement('span');
    meta.append(kind, year);
    copy.append(title, meta);
    link.append(visual, copy);
    const menu = membershipMenu(row.id, row, row.title, ({ tracked, blacklisted }) => {
      if (view !== 'catalog') return;
      if (!li.isConnected) return loadCatalog(true);
      const filter = catalogFilters.tracking;
      if ((filter === 'tracked' && !tracked) || filter === 'untracked' ||
          (filter === 'blacklisted' && !blacklisted) ||
          (['all', 'updates'].includes(filter) && blacklisted && !catalogFilters.includeBlacklist)) {
        return loadCatalog(true);
      }
      updatePosterMembership(link, marker, { tracked, blacklisted });
    });
    li.append(link, menu.element);
    list.append(li);
    const render = info => {
      kind.textContent = animeKinds[info?.kind] ?? '';
      year.textContent = row.year ?? info?.year ?? '';
      rating.hidden = !info?.score;
      rating.textContent = info?.score ? '★ ' + info.score : '';
      setPoster(frame, row.id, info);
    };
    render(row.shikimori);
    if (!row.metadataChecked || row.posterPending) pendingCovers.set(row.id, render);
  }
  if (rows.length) catalogAfter = rows.at(-1).id;
  el('more-catalog').hidden = rows.length < 50;
}

const posterObserver = new IntersectionObserver(entries => {
  for (const { isIntersecting, target } of entries) {
    if (!isIntersecting) continue;
    posterObserver.unobserve(target);
    void fetchPoster(target);
  }
}, { rootMargin: '180px' });

function setPoster(frame, id, info) {
  if (!info?.poster) return;
  const endpoint = '/api/poster?' + new URLSearchParams({ id, v: info.poster });
  if (frame.dataset.poster === endpoint) return;
  frame.dataset.poster = endpoint;
  posterObserver.observe(frame);
}

async function fetchPoster(frame) {
  const endpoint = frame.dataset.poster;
  try {
    const response = await fetch(endpoint, { headers: accessHeaders() });
    if (!response.ok) return;
    const blob = await response.blob();
    if (!frame.isConnected || endpoint !== frame.dataset.poster) return;
    const image = document.createElement('img');
    const url = URL.createObjectURL(blob);
    image.alt = '';
    image.onload = image.onerror = () => URL.revokeObjectURL(url);
    image.src = url;
    frame.replaceChildren(image);
  } catch {
    // The card remains usable with the poster placeholder.
  }
}

function animeName(row) {
  return row.title + (row.year ? ' (' + row.year + ')' : '');
}

function cursor(rows) {
  return rows.length ? { before: rows.at(-1).id, beforeSource: rows.at(-1).source_id } : {};
}

function reviewMessageItem(row) {
  const fields = row.result || {};
  const labels = [row.source_title, '#' + row.id,
    fields.season == null ? null : 'Сезон ' + fields.season,
    fields.episode == null ? null : 'Серия ' + fields.episode,
    fields.voiceover ? 'Озвучка — ' + fields.voiceover : null, fields.audioVariant];
  const li = item(labels.filter(Boolean).join(' · '));
  if (fields.subtitles) {
    const line = document.createElement('p');
    const { mode, author, styled } = fields.subtitles;
    const label = mode === 'file' ? 'Отдельные субтитры' : mode === 'video' ? 'Видео с субтитрами' : 'Субтитры';
    line.textContent = [label, author ? 'Автор — ' + author : null, styled ? 'С оформлением' : null].filter(Boolean).join(' · ');
    li.append(line);
  }
  for (const attachment of row.attachments) {
    const line = document.createElement('p');
    const size = attachment.width && attachment.height ? attachment.width + '×' + attachment.height : null;
    const format = attachment.fileName?.match(/\.([a-z0-9]+)$/i)?.[1].toUpperCase();
    line.textContent = [attachment.fileName || attachment.kind, format, size].filter(Boolean).join(' · ');
    li.append(line);
  }
  if (row.text) {
    const text = document.createElement('pre');
    text.textContent = row.text;
    li.append(text);
  }
  const link = telegramMessageLink(row);
  if (link) li.append(link);
  return li;
}

function telegramMessageLink(row) {
  return telegramMessageLinks(row.source_id, row.username, row.id, 'Открыть сообщение в Telegram');
}

function telegramMessageLinks(chatId, username, messageId, label, topicId) {
  const [, channel, sourceTopic] = /^-100(\d+)(?::(\d+))?$/.exec(chatId) ?? [];
  if (!username && !channel) return null;
  const thread = topicId ?? sourceTopic;
  const params = new URLSearchParams(username ? { domain: username, post: messageId } : { channel, post: messageId });
  if (thread) params.set('thread', thread);
  const link = document.createElement('a');
  link.href = 'tg://' + (username ? 'resolve' : 'privatepost') + '?' + params;
  link.textContent = label;
  const web = document.createElement('a');
  web.href = 'https://t.me/' + (username ? encodeURIComponent(username) : 'c/' + channel) + '/' + messageId;
  if (thread) web.href += '?' + new URLSearchParams({ thread });
  web.target = '_blank';
  web.rel = 'noreferrer';
  web.textContent = 'В браузере';
  const links = document.createElement('span');
  links.append(link, document.createTextNode(' · '), web);
  return links;
}

function episodeReleaseCard(row) {
  const card = item('');
  card.className = 'release-card';
  const header = document.createElement('div');
  header.className = 'release-header';
  const title = document.createElement('strong');
  title.textContent = row.source_title || 'Telegram';
  const message = document.createElement('span');
  message.className = 'release-message';
  message.textContent = '#' + row.id;
  header.append(title, message);
  card.append(header);

  const { voiceover, audioVariant, subtitles } = row.result || {};
  const credits = [
    voiceover && 'Озвучка: ' + voiceover,
    audioVariant && audioVariant !== voiceover && audioVariant,
    subtitles && (subtitles.author ? 'Субтитры: ' + subtitles.author : 'Субтитры'),
    subtitles?.styled && 'С оформлением'
  ].filter(Boolean);
  if (credits.length) card.append(releaseTags(credits));

  for (const [position, file] of row.attachments.entries()) {
    const block = document.createElement('div');
    block.className = 'release-file';
    const name = document.createElement('strong');
    const kinds = { video: 'Видео', subtitle: 'Файл субтитров', photo: 'Фото', animation: 'GIF', file: 'Файл' };
    name.textContent = file.fileName || kinds[file.kind] || 'Вложение';
    block.append(name);
    const format = file.fileName?.match(/\.([a-z0-9]+)$/i)?.[1].toUpperCase();
    const resolution = file.width && file.height ? file.width + ' × ' + file.height : null;
    const details = [format, resolution].filter(Boolean);
    if (details.length) block.append(releaseTags(details));
    if (file.kind === 'video' || file.kind === 'subtitle') {
      const index = file.attachmentIndex ?? position;
      const actions = document.createElement('div');
      actions.className = 'release-actions';
      block.append(actions);
      actions.append(publishControls(row, index));
    }
    card.append(block);
  }
  if (!row.attachments.length && row.text) {
    const text = document.createElement('pre');
    text.textContent = row.text;
    card.append(text);
  }
  const link = telegramMessageLink(row);
  if (link) {
    link.className = 'release-telegram-link';
    card.append(link);
  }
  return card;
}

function releaseTags(values) {
  const tags = document.createElement('div');
  tags.className = 'release-tags';
  for (const value of values) {
    const tag = document.createElement('span');
    tag.textContent = value;
    tags.append(tag);
  }
  return tags;
}

const animePlayer = el('anime-video');
const playbackCover = el('anime-video-cover');
const playbackStatus = el('anime-video-status');
const playbackStart = el('anime-video-start');
const playbackSeason = el('playback-season');
const playbackEpisode = el('playback-episode');
const playbackVoice = el('playback-voice');
const playbackSource = el('playback-source');
let playbackRows = [];
let playbackSources = new Map();
let playbackVersion = 0;

function playbackNotice(text, canStart = false) {
  playbackCover.hidden = false;
  playbackStatus.textContent = text;
  playbackStatus.hidden = !text;
  playbackStart.hidden = !canStart;
}

function fillPlaybackSelect(select, entries) {
  select.replaceChildren(...Array.from(entries, ([value, label]) => option(label, value)));
  select.disabled = !select.options.length;
}

function playbackVoiceLabel(row) {
  const names = [...new Set([row.voiceover, row.audioVariant].filter(Boolean))];
  if (names.length) return names.join(' · ');
  return row.subtitleMode === 'video' ? 'Видео с субтитрами' : 'Озвучка не указана';
}

function updatePlaybackChoices(from) {
  const seasonRows = playbackRows.filter(row => String(row.season ?? '') === playbackSeason.value);
  if (from === 'season') {
    fillPlaybackSelect(playbackEpisode, new Map(seasonRows.map(({ episode }) => [
      String(episode ?? ''), episode === null ? 'Без номера серии' : 'Серия ' + episode
    ])));
  }
  const episodeRows = seasonRows.filter(row => String(row.episode ?? '') === playbackEpisode.value);
  if (from !== 'voice') {
    const voices = [...new Set(episodeRows.map(playbackVoiceLabel))].sort((a, b) => a.localeCompare(b, 'ru'));
    fillPlaybackSelect(playbackVoice, voices.map(voice => [voice, voice]));
  }
  playbackSources = new Map();
  for (const row of episodeRows) {
    if (playbackVoiceLabel(row) === playbackVoice.value && !playbackSources.has(row.sourceId)) {
      playbackSources.set(row.sourceId, row);
    }
  }
  fillPlaybackSelect(playbackSource, [...playbackSources.values()]
    .sort((a, b) => a.sourceTitle.localeCompare(b.sourceTitle, 'ru')).map(row => [row.sourceId, row.sourceTitle]));
}

async function loadPlaybackChoices(id) {
  el('anime-playback').hidden = false;
  try {
    playbackRows = await api('video-options?' + new URLSearchParams({ id }));
    fillPlaybackSelect(playbackSeason, new Map(playbackRows.map(({ season }) => [
      String(season ?? ''), season === null ? 'Сезон не указан' : 'Сезон ' + season
    ])));
    updatePlaybackChoices('season');
    playbackNotice(playbackRows.length ? '' : 'У этого тайтла пока нет видео.', Boolean(playbackRows.length));
  } catch (error) {
    playbackNotice(error.message);
  }
}

async function playSelectedVideo() {
  const version = ++playbackVersion;
  const selected = playbackSources.get(playbackSource.value);
  animePlayer.pause();
  animePlayer.hidden = true;
  animePlayer.removeAttribute('src');
  animePlayer.load();
  if (!selected) return playbackNotice('Видео недоступно.');
  playbackNotice('Загружаем видео…');
  const { sourceId, messageId, index } = selected;
  try {
    const { url } = await api('video-playback', { sourceId, messageId, index });
    if (version !== playbackVersion || el('details').hidden) return;
    animePlayer.src = url;
    animePlayer.hidden = false;
    playbackCover.hidden = true;
    await animePlayer.play().catch(() => {});
  } catch (error) {
    if (version === playbackVersion) playbackNotice(error.message, true);
  }
}

for (const [select, from] of [[playbackSeason, 'season'], [playbackEpisode, 'episode'], [playbackVoice, 'voice']]) {
  select.onchange = () => {
    updatePlaybackChoices(from);
    void playSelectedVideo();
  };
}
playbackSource.onchange = playbackStart.onclick = playSelectedVideo;
animePlayer.addEventListener('error', () => {
  if (!animePlayer.hasAttribute('src')) return;
  animePlayer.hidden = true;
  playbackNotice('Не удалось воспроизвести видео из этого источника.', true);
});

function publishControls(row, index) {
  const key = { sourceId: row.source_id, messageId: row.id, index };
  const keyId = publicationKey(key);
  const panel = document.createElement('div');
  panel.className = 'publish-controls';
  const menu = document.createElement('div');
  menu.className = 'publish-menu';
  menu.hidden = true;
  const statuses = document.createElement('ul');
  statuses.className = 'publication-states';
  statuses.setAttribute('aria-live', 'polite');
  let busy = false;
  let pending = false;
  const control = button('Опубликовать', async () => {
    if (!menu.hidden) return closeMenu();
    busy = true;
    updateButton();
    try {
      const { destinations } = await api('publication-settings');
      const available = destinations.filter(destination => destination.id !== key.sourceId);
      if (available.length === 1) return await publish(available[0].id);
      menu.replaceChildren();
      if (available.length) {
        for (const destination of available) menu.append(button(destination.title, () => publish(destination.id)));
        const all = button('Опубликовать везде', () => publish('all'));
        all.className = 'publish-all';
        menu.append(all);
      } else {
        const link = document.createElement('a');
        link.href = '/?view=publication';
        link.textContent = 'Выбрать места в настройках публикации';
        menu.append(link);
      }
      menu.hidden = false;
      control.setAttribute('aria-expanded', 'true');
      menu.firstElementChild.focus();
    } finally {
      busy = false;
      updateButton();
    }
  });
  control.setAttribute('aria-expanded', 'false');
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || menu.hidden) return;
    closeMenu();
    control.focus();
  });
  panel.append(control, menu, statuses);
  render(row.publications?.filter(state => state.index === index) || []);
  return panel;

  function closeMenu() {
    menu.hidden = true;
    control.setAttribute('aria-expanded', 'false');
  }

  function updateButton() {
    control.disabled = busy || pending;
  }

  function render(states) {
    pending = states.some(state => state.status === 'pending');
    if (pending) pendingPublications.set(keyId, { key, panel, render });
    else pendingPublications.delete(keyId);
    statuses.replaceChildren(...states.map(state => {
      const labels = { pending: 'В очереди', published: 'Опубликовано', failed: 'Ошибка' };
      const history = state.status === 'published' ? (state.count > 1 ? ' (' + state.count + ')' : '')
        : state.count ? ' · Уже опубликовано: ' + state.count : '';
      const text = state.channel + ' · ' + labels[state.status] + history;
      const li = item(text + (state.error ? ' · ' + state.error : ''));
      if (state.status === 'failed') li.className = 'publication-failed';
      const links = state.sentMessageId && telegramMessageLinks(
        state.chatId || state.channelId, state.username, state.sentMessageId, 'Открыть в Telegram', state.topicId
      );
      if (links) li.append(document.createTextNode(' · '), links);
      return li;
    }));
    statuses.hidden = !states.length;
    updateButton();
  }

  async function publish(target) {
    closeMenu();
    busy = true;
    updateButton();
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    const data = { ...key, target, requestId };
    try {
      let states;
      try {
        states = await api('publish', data);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        states = await api('publish', data);
      }
      render(states);
    } finally {
      busy = false;
      updateButton();
    }
  }
}

function publicationKey({ sourceId, messageId, index }) {
  return [sourceId, messageId, index].join('/');
}

function showAnimeInfo({ anime, aliases, shikimori: info, metadataChecked, posterPending }) {
  detailWaiting = !metadataChecked || posterPending;
  el('anime-title').textContent = anime.title;
  document.title = anime.title + ' · Аниме из Telegram';
  const original = el('anime-original');
  original.textContent = info?.originalTitle || '';
  original.hidden = !original.textContent || original.textContent === anime.title;
  const alternativeNames = el('anime-aliases');
  alternativeNames.hidden = !aliases.length;
  alternativeNames.textContent = aliases.length ? 'Альтернативные названия: ' + aliases.join(' · ') : '';
  const facts = el('anime-facts');
  const statuses = { released: 'Завершён', ongoing: 'Выходит', anons: 'Анонсирован' };
  const values = [anime.year || info?.year, animeKinds[info?.kind], statuses[info?.status],
    info?.score ? '★ ' + info.score : null, info?.episodes ? 'Серий на Shikimori: ' + info.episodes : null];
  facts.replaceChildren(...values.filter(Boolean).map(value => item(value)));
  facts.hidden = !facts.children.length;
  const genres = el('anime-genres');
  genres.textContent = [...(info?.genres || []), ...(info?.studios || [])].join(' · ');
  genres.hidden = !genres.textContent;
  el('anime-description').textContent = info?.description || (info ? 'Описание отсутствует.'
    : metadataChecked ? 'Данные Shikimori пока недоступны.' : 'Ищем данные на Shikimori…');
  const source = el('anime-shikimori');
  source.hidden = !info;
  if (info) source.href = 'https://shikimori.io/animes/' + info.id;
  setPoster(el('anime-poster'), anime.id, info);
}

function episodeDetails(id, group) {
  const section = document.createElement('details');
  section.className = 'episode';
  const summary = document.createElement('summary');
  summary.textContent = group.episode == null ? 'Без номера серии' : 'Серия ' + group.episode;
  const counts = document.createElement('span');
  counts.className = 'episode-counts';
  const badge = document.createElement('span');
  badge.className = 'tracking-badge';
  summary.append(counts, badge);
  const body = document.createElement('div');
  body.className = 'episode-body';
  const groups = Object.entries({ video: 'Видео', subtitle: 'Файлы субтитров', other: 'Другие материалы' })
    .map(([kind, title]) => {
      const block = document.createElement('div');
      const heading = document.createElement('h4');
      heading.textContent = title;
      const list = document.createElement('ul');
      list.className = 'entries';
      block.hidden = true;
      block.append(heading, list);
      body.append(block);
      return { kind, block, list };
    });
  let before = {};
  let busy = false;
  let version = 0;
  const more = button('Ещё материалы', () => load(false));
  more.hidden = true;
  body.append(more);
  section.append(summary, body);
  section.addEventListener('toggle', () => {
    if (section.open) load(true).catch(error => notice(error.message));
  });
  update(group);
  return { section, update, reloadMaterials: () => load(true, false) };

  function update(state) {
    group = state;
    const { videos, subtitles, items, unread } = state;
    const visibleVideos = episodeMaterial === 'all' ? videos :
      episodeMaterial === 'subtitle' ? 0 : state[episodeMaterialCounts[episodeMaterial]];
    const visibleSubtitles = ['all', 'subtitle'].includes(episodeMaterial) ? subtitles : 0;
    counts.textContent = [visibleVideos ? 'Видео: ' + visibleVideos : null,
      visibleSubtitles ? 'Субтитры: ' + visibleSubtitles : null,
      episodeMaterial === 'all' && items > videos + subtitles ? 'Другие: ' + (items - videos - subtitles) : null].filter(Boolean).join(' · ');
    badge.textContent = 'Непрочитано: ' + unread;
    badge.hidden = !unread;
    section.classList.toggle('is-unread', Boolean(unread));
  }

  async function load(reset, markRead = reset) {
    if (busy && !reset) return;
    const currentVersion = ++version;
    if (markRead) episodeReadEpoch++;
    const material = episodeMaterial;
    const source = episodeSource;
    const attachmentKind = material === 'subtitle' ? 'subtitle' : 'video';
    busy = true;
    more.disabled = true;
    if (reset) {
      more.hidden = true;
      for (const { list, block } of groups) {
        list.replaceChildren();
        block.hidden = true;
      }
    }
    try {
      const rows = markRead ? await api('episode-open', { id, season: group.season, episode: group.episode, material, source })
        : await api('episode?' + new URLSearchParams({ id, season: group.season ?? '', episode: group.episode ?? '', material, source,
          ...(reset ? {} : before) }));
      if (version !== currentVersion || source !== episodeSource || material !== episodeMaterial) return;
      if (markRead) {
        episodeReadEpoch++;
        group.unread = 0;
        update(group);
        updateReadControls();
      }
      for (const row of rows) {
        for (const { kind, block, list } of groups) {
          if (material !== 'all' && kind !== attachmentKind) continue;
          const attachments = row.attachments.map((file, index) => ({ ...file, attachmentIndex: index })).filter(file => kind === 'other'
            ? !['video', 'subtitle'].includes(file.kind) : file.kind === kind);
          if (attachments.length || (kind === 'other' && !row.attachments.length)) {
            list.append(episodeReleaseCard({ ...row, attachments }));
            block.hidden = false;
          }
        }
      }
      before = cursor(rows);
      more.hidden = rows.length < 50;
    } finally {
      if (version === currentVersion) {
        busy = false;
        more.disabled = false;
      }
    }
  }
}

async function loadAnime(id) {
  const page = await api('anime-page?' + new URLSearchParams({ id, source: preferredEpisodeSource }));
  if (page.anime.id !== Number(id)) {
    location.replace('/anime/' + page.anime.id + location.search);
    return;
  }
  episodeSource = page.source;
  showAnimeInfo(page);
  detailMembershipMenu = membershipMenu(page.anime.id, page, page.anime.title, async membership => {
    const epoch = ++episodeReadEpoch;
    if (episodeState) episodeState = { ...episodeState, ...membership };
    updateDetailMembership(membership);
    const state = await api('tracking-episodes?' + new URLSearchParams({ id, source: episodeSource }));
    if (epoch === episodeReadEpoch) showEpisodes(id, state);
  });
  el('anime-poster-card').append(detailMembershipMenu.element);
  el('anime-merge').hidden = false;
  const q = new URLSearchParams(location.search).get('q');
  const back = el('back-catalog');
  const backParams = new URLSearchParams({ view: detailOrigin });
  if (q && detailOrigin === 'catalog') backParams.set('q', q);
  const fromBlacklist = detailOrigin === 'tracking' && trackingListMode === 'blacklist';
  if (fromBlacklist) backParams.set('list', 'blacklist');
  back.href = '/?' + backParams;
  back.textContent = fromBlacklist ? '← К черному списку' : detailOrigin === 'tracking' ? '← К отслеживанию' : '← К каталогу';
  showEpisodes(id, page);
  void loadPlaybackChoices(id);
}

el('anime-merge-search').onsubmit = action(async event => {
  const search = event.currentTarget;
  const form = el('anime-merge-confirm');
  const feedback = el('anime-merge-status');
  const submit = search.querySelector('button');
  form.hidden = true;
  feedback.hidden = true;
  submit.disabled = true;
  try {
    const matches = await api('catalog?' + new URLSearchParams({ q: search.elements.q.value }));
    const choices = matches.filter(match => match.id !== Number(detailId));
    form.elements.sourceId.replaceChildren(option('Выберите тайтл', ''),
      ...choices.map(match => option(animeName(match), match.id)));
    form.hidden = !choices.length;
    feedback.hidden = Boolean(choices.length);
    feedback.textContent = 'Других тайтлов по этому запросу нет.';
  } finally {
    submit.disabled = false;
  }
});

el('anime-merge-confirm').onsubmit = action(async event => {
  const form = event.currentTarget;
  const submit = form.querySelector('button');
  submit.disabled = true;
  try {
    const { id } = await api('anime-merge', { sourceId: Number(form.elements.sourceId.value), targetId: Number(detailId) });
    if (id === Number(detailId)) location.reload();
    else location.replace('/anime/' + id + location.search);
  } finally {
    submit.disabled = false;
  }
});

el('episode-material').onchange = action(async event => {
  episodeMaterial = event.currentTarget.value;
  const saving = saveViewSettings({ episodeMaterial });
  if (!episodeState) return saving;
  showEpisodes(detailId, episodeState);
  const opened = [...episodeViews.values()].filter(({ section }) => section.open && section.isConnected);
  await Promise.all([saving, ...opened.map(entry => entry.reloadMaterials())]);
});

el('episode-source').onchange = action(async event => {
  const source = event.currentTarget.value;
  const request = ++episodeSourceRequest;
  const list = el('anime-episodes');
  loadingEpisodeSource = list.inert = true;
  updateReadControls();
  try {
    const state = await api('tracking-episodes?' + new URLSearchParams({ id: detailId, source }));
    if (request !== episodeSourceRequest) return;
    ++episodeReadEpoch;
    preferredEpisodeSource = episodeSource = source;
    showEpisodes(detailId, state);
    const opened = [...episodeViews.values()].filter(({ section }) => section.open && section.isConnected);
    await Promise.all([saveViewSettings({ episodeSource: source }), ...opened.map(entry => entry.reloadMaterials())]);
  } finally {
    if (request === episodeSourceRequest) {
      loadingEpisodeSource = list.inert = false;
      el('episode-source').value = episodeSource;
      updateReadControls();
    }
  }
});

el('episode-read-all').onclick = action(() => markEpisodesRead());

async function markEpisodesRead(season) {
  readingEpisodes = true;
  const epoch = ++episodeReadEpoch;
  updateReadControls();
  try {
    const state = await api('tracking-episodes', { id: Number(detailId), season, source: episodeSource });
    if (epoch === episodeReadEpoch) {
      episodeReadEpoch++;
      showEpisodes(detailId, state);
    }
  } finally {
    readingEpisodes = false;
    updateReadControls();
  }
}

function updateReadControls() {
  const unreadSeasons = new Set(episodeState?.episodes.filter(group => group.unread).map(group => group.season));
  el('episode-read-all').disabled = loadingEpisodeSource || readingEpisodes || !unreadSeasons.size;
  for (const control of el('anime-episodes').querySelectorAll('[data-read-season]')) {
    control.disabled = loadingEpisodeSource || readingEpisodes || !unreadSeasons.has(Number(control.dataset.readSeason));
  }
}

function updateDetailMembership(state) {
  updatePosterMembership(el('anime-poster-card'), el('anime-poster-status'), state);
  const status = el('anime-tracked');
  status.hidden = !state.tracked && !state.blacklisted;
  status.textContent = state.blacklisted ? 'В черном списке' : 'Отслеживается';
  detailMembershipMenu?.update(state);
}

function layoutSeasonEpisodes(body, episodes) {
  seasonEpisodeOrder.set(body, episodes);
  const twoColumns = episodeColumnLayout.matches && episodes.length > 1;
  body.classList.toggle('has-columns', twoColumns);
  if (!twoColumns) {
    body.replaceChildren(...episodes);
    return;
  }

  const columns = [document.createElement('div'), document.createElement('div')];
  for (const column of columns) column.className = 'episode-column';
  for (const [index, episode] of episodes.entries()) columns[index % 2].append(episode);
  body.replaceChildren(...columns);
}

episodeColumnLayout.addEventListener('change', () => {
  for (const body of el('anime-episodes').querySelectorAll('.season-episodes')) {
    layoutSeasonEpisodes(body, seasonEpisodeOrder.get(body));
  }
});

function showEpisodes(id, state) {
  episodeState = state;
  const { episodes, sources } = state;
  const sourceSelect = el('episode-source');
  const choices = [...sources].sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  const signature = JSON.stringify(choices);
  if (signature !== episodeSourceOptions) {
    episodeSourceOptions = signature;
    sourceSelect.replaceChildren(option('Все источники', ''), ...choices.map(({ id, title }) => option(title, id)));
  }
  if (!loadingEpisodeSource) sourceSelect.value = episodeSource;
  updateDetailMembership(state);
  const seasons = new Map();
  const active = new Set();
  const visible = [];
  for (const group of episodes) {
    const key = JSON.stringify([group.season, group.episode]);
    active.add(key);
    let entry = episodeViews.get(key);
    if (entry) entry.update(group);
    else {
      entry = episodeDetails(id, group);
      episodeViews.set(key, entry);
    }
    if (episodeMaterial !== 'all' && !group[episodeMaterialCounts[episodeMaterial]]) continue;
    visible.push(key);
    if (!seasons.has(group.season)) seasons.set(group.season, []);
    seasons.get(group.season).push(entry.section);
  }
  for (const key of episodeViews.keys()) {
    if (!active.has(key)) episodeViews.delete(key);
  }
  const layout = JSON.stringify([episodeSource, episodeMaterial, visible]);
  if (episodeLayout === layout) {
    updateReadControls();
    return;
  }
  episodeLayout = layout;
  const list = el('anime-episodes');
  const sections = [];
  for (const [season, groups] of seasons) {
    const section = document.createElement('section');
    section.className = 'season-list';
    const body = document.createElement('div');
    body.className = 'season-episodes';
    body.id = 'season-episodes-' + (season ?? 'unknown');
    body.hidden = collapsedSeasons.has(season);
    if (season !== null || seasons.size > 1) {
      const header = document.createElement('div');
      header.className = 'season-heading';
      const heading = document.createElement('h3');
      const toggle = button(season === null ? 'Сезон не указан' : 'Сезон ' + season, () => {
        body.hidden = !body.hidden;
        if (body.hidden) collapsedSeasons.add(season);
        else collapsedSeasons.delete(season);
        toggle.setAttribute('aria-expanded', String(!body.hidden));
      });
      toggle.className = 'season-toggle';
      toggle.setAttribute('aria-controls', body.id);
      toggle.setAttribute('aria-expanded', String(!body.hidden));
      heading.append(toggle);
      header.append(heading);
      if (season !== null) {
        const readSeason = button('Прочитать всё', () => markEpisodesRead(season));
        readSeason.dataset.readSeason = season;
        readSeason.setAttribute('aria-label', 'Прочитать всё в сезоне ' + season);
        header.append(readSeason);
      }
      section.append(header);
    }
    if (season === null && seasons.size === 1) body.hidden = false;
    layoutSeasonEpisodes(body, groups);
    section.append(body);
    sections.push(section);
  }
  list.replaceChildren(...sections);
  if (!seasons.size) list.textContent = episodeSource ? 'Нет материалов по выбранным фильтрам.'
    : episodeMaterial === 'all' ? 'Материалов пока нет.' : 'Нет материалов выбранного типа.';
  updateReadControls();
}

async function loadTracking() {
  const mode = trackingListMode;
  const isBlacklist = mode === 'blacklist';
  const rows = await api('tracking?' + new URLSearchParams({ list: mode }));
  if (mode !== trackingListMode) return;
  const signature = JSON.stringify([mode, rows]);
  if (trackingListSignature === signature) return;
  trackingListSignature = signature;
  const list = el('tracking-list');
  if (!rows.length) {
    list.replaceChildren(item(isBlacklist ? 'Черный список пуст.' : 'Добавьте тайтл в отслеживание из каталога или карточки тайтла.'));
    return;
  }
  const sameLayout = list.children.length === rows.length &&
    rows.every((row, index) => list.children[index].dataset.animeId === String(row.id));
  if (!sameLayout) {
    list.replaceChildren(...rows.map(row => {
      const li = document.createElement('li');
      li.dataset.animeId = row.id;
      const link = document.createElement('a');
      li.append(link, document.createElement('span'));
      return li;
    }));
  }
  for (const [index, row] of rows.entries()) {
    const [link, status] = list.children[index].children;
    link.textContent = animeName(row);
    link.href = '/anime/' + row.id + '?from=tracking' + (isBlacklist ? '&list=blacklist' : '');
    status.hidden = isBlacklist;
    status.className = row.unread ? 'tracking-badge' : 'muted';
    status.textContent = row.unread ? 'Непрочитанные серии: ' + row.unread : 'Всё прочитано';
  }
}

const trackingTabs = document.querySelectorAll('[data-tracking-list]');
function trackingPath() {
  const params = new URLSearchParams({ view: 'tracking' });
  if (trackingListMode === 'blacklist') params.set('list', 'blacklist');
  return '/?' + params;
}

function showTrackingTabs() {
  for (const tab of trackingTabs) {
    if (tab.dataset.trackingList === trackingListMode) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
}
for (const tab of trackingTabs) {
  tab.onclick = action(async () => {
    if (trackingListMode === tab.dataset.trackingList) return;
    trackingListMode = tab.dataset.trackingList;
    showTrackingTabs();
    history.replaceState(null, '', trackingPath());
    el('tracking-list').replaceChildren();
    trackingListSignature = undefined;
    await loadTracking();
  });
}
showTrackingTabs();

async function loadReview(page = reviewPage) {
  const version = ++reviewVersion;
  const sourceSelect = el('review-source');
  const source = sourceSelect.value;
  const pageSize = el('review-page-size').value;
  const list = el('review-list');
  const pagination = el('review-pagination');
  list.inert = pagination.inert = true;
  list.setAttribute('aria-busy', 'true');
  try {
    const result = await api('review?' + new URLSearchParams({ source, page, pageSize }));
    if (version !== reviewVersion) return;
    reviewPage = result.page;
    const choices = result.sources.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    const previousTitle = sourceSelect.selectedOptions[0]?.textContent;
    if (source && !choices.some(entry => entry.id === source)) choices.push({ id: source, title: previousTitle });
    sourceSelect.replaceChildren(option('Все источники', ''), ...choices.map(({ id, title }) => option(title, id)));
    sourceSelect.value = source;
    list.replaceChildren(...(result.rows.length ? result.rows.map(row => {
      const li = reviewMessageItem(row);
      const issue = document.createElement('p');
      issue.textContent = row.issue;
      li.append(issue, button('Указать тайтл', () => editAssignment(li, row)));
      return li;
    }) : [item(source ? 'У этого источника нет сообщений на проверку.' : 'Очередь пуста.')]));
    showReviewPages(result.page, result.pages);
  } finally {
    if (version === reviewVersion) {
      list.inert = pagination.inert = false;
      list.removeAttribute('aria-busy');
    }
  }
}

function showReviewPages(page, pages) {
  const pagination = el('review-pagination');
  pagination.hidden = pages <= 1;
  if (pagination.hidden) return;
  const go = target => async () => {
    await loadReview(target);
    el('review').scrollIntoView({ block: 'start' });
    pagination.querySelector('[aria-current="page"]')?.focus({ preventScroll: true });
  };
  const previous = button('Назад', go(page - 1));
  previous.disabled = page === 1;
  const next = button('Вперёд', go(page + 1));
  next.disabled = page === pages;
  const numbers = [...new Set([1, page - 1, page, page + 1, pages])].filter(number => number >= 1 && number <= pages);
  const controls = [previous];
  for (const [index, number] of numbers.entries()) {
    if (index && number - numbers[index - 1] > 1) controls.push(document.createTextNode('…'));
    const control = button(String(number), go(number));
    control.setAttribute('aria-label', 'Страница ' + number);
    if (number === page) control.setAttribute('aria-current', 'page');
    controls.push(control);
  }
  pagination.replaceChildren(...controls, next);
}

el('review-source').onchange = el('review-page-size').onchange = action(() => loadReview(1));

function editAssignment(li, row) {
  if (li.querySelector('form')) return;
  const form = document.createElement('form');
  form.className = 'row';
  const input = document.createElement('input');
  input.placeholder = 'Название тайтла';
  input.setAttribute('aria-label', 'Название тайтла');
  input.value = row.result?.title || row.result?.fileTitle || '';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Выбор тайтла');
  const find = async () => {
    const matches = await api('catalog?' + new URLSearchParams({ q: input.value }));
    select.replaceChildren(option('Создать новый тайтл', ''), ...matches.map(match => option(animeName(match), match.id)));
  };
  const submit = document.createElement('button');
  submit.textContent = 'Сохранить';
  form.append(input, button('Найти в каталоге', find), select, submit);
  form.onsubmit = action(async () => {
    await api('assign', {
      sourceId: row.source_id, messageId: row.id, animeId: select.value ? Number(select.value) : null,
      title: input.value, year: row.result?.year
    });
    await loadReview();
  });
  li.append(form);
  return find();
}

function catalogPath() {
  const q = el('search').elements.q.value;
  return '/?' + new URLSearchParams(q ? { view: 'catalog', q } : { view: 'catalog' });
}

let savedDestinations = [];
let inventorySignature = '';
let inventoryLoading = false;

function selectedPublicationDestinations() {
  return new Set([...el('publication-settings').querySelectorAll('input[name=destination]:checked')].map(input => input.value));
}

function destinationCheckbox(destination, selected, title = destination.title) {
  const label = document.createElement('label');
  label.className = 'publication-channel';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = 'destination';
  input.value = destination.id;
  input.checked = selected.has(destination.id);
  label.append(input, document.createTextNode(title));
  return label;
}

function showPublicationInventory(inventory, selected) {
  const groupList = el('publication-group-list');
  const open = new Set([...groupList.querySelectorAll('details[open]')].map(details => details.dataset.forum));
  const active = document.activeElement;
  const focused = active instanceof HTMLInputElement && active.type === 'checkbox' ? active.value : null;
  const options = new Map(inventory.items.map(item => [item.id, item]));
  for (const destination of savedDestinations) {
    if (!options.has(destination.id)) options.set(destination.id, destination);
  }
  const topics = new Map();
  for (const option of options.values()) {
    if (option.type !== 'topic') continue;
    if (!topics.has(option.chatId)) topics.set(option.chatId, []);
    topics.get(option.chatId).push(option);
    if (!options.has(option.chatId)) {
      options.set(option.chatId, { id: option.chatId, title: option.chatTitle, type: 'group', forum: true });
    }
  }
  const sortByTitle = (a, b) => a.title.localeCompare(b.title, 'ru');
  const channels = [...options.values()].filter(option => option.type === 'channel').sort(sortByTitle);
  const groups = [...options.values()].filter(option => option.type === 'group').sort(sortByTitle);
  const channelList = el('publication-channel-list');
  channelList.replaceChildren(...channels.map(channel => destinationCheckbox(channel, selected,
    channel.title + (channel.username ? ' · @' + channel.username : ''))));
  groupList.replaceChildren(...groups.map(group => {
    if (!group.forum) return destinationCheckbox(group, selected);
    const forum = document.createElement('details');
    forum.className = 'publication-forum';
    forum.dataset.forum = group.id;
    forum.open = open.has(group.id);
    const summary = document.createElement('summary');
    summary.textContent = group.title;
    const list = document.createElement('div');
    list.className = 'publication-topics';
    const items = topics.get(group.id) || [];
    if (items.length) {
      list.append(...items.sort(sortByTitle).map(topic => destinationCheckbox(topic, selected, topic.topicTitle || topic.title)));
    } else {
      list.textContent = group.topicsChecked ? 'Нет открытых тем.' : 'Темы ещё загружаются…';
    }
    forum.append(summary, list);
    return forum;
  }));
  if (!channels.length) channelList.textContent = inventory.refreshedAt ? 'Нет доступных каналов.' : 'Ожидаем список из Telegram…';
  if (!groups.length) groupList.textContent = inventory.refreshedAt ? 'Нет доступных групп.' : 'Ожидаем список из Telegram…';
  if (focused) {
    [...el('publication-settings').querySelectorAll('input[name=destination]')].find(input => input.value === focused)?.focus();
  }
}

async function refreshPublicationInventory() {
  if (inventoryLoading) return;
  inventoryLoading = true;
  try {
    const inventory = await api('publication-inventory');
    const signature = JSON.stringify([Boolean(inventory.refreshedAt), inventory.items]);
    if (signature !== inventorySignature) {
      inventorySignature = signature;
      showPublicationInventory(inventory, selectedPublicationDestinations());
    }
  } finally {
    inventoryLoading = false;
  }
}

async function loadPublicationSettings() {
  const settings = await api('publication-settings');
  savedDestinations = settings.destinations;
  inventorySignature = '';
  const form = el('publication-settings');
  el('publication-settings-status').textContent = '';
  form.elements.originalCaption.checked = settings.originalCaption;
  form.elements.originalAuthor.checked = settings.originalAuthor;
  el('caption-preview-data').value = JSON.stringify(settings.captionExample, null, 2);
  el('caption-preview-result').hidden = true;
  showPublicationInventory({ items: [], refreshedAt: null }, new Set(savedDestinations.map(destination => destination.id)));
  form.hidden = false;
  setJavaScript(form.elements.template, settings.template);
  await refreshPublicationInventory();
}

const destinationTabs = [el('publication-channel-tab'), el('publication-group-tab')];
function showDestinationTab(active) {
  for (const tab of destinationTabs) {
    const selected = tab === active;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    el(tab.getAttribute('aria-controls')).hidden = !selected;
  }
}
for (const tab of destinationTabs) {
  tab.onclick = () => showDestinationTab(tab);
  tab.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? destinationTabs[0] : event.key === 'End' ? destinationTabs[1]
      : destinationTabs.find(item => item !== tab);
    showDestinationTab(next);
    next.focus();
  };
}

el('caption-preview').onclick = action(async event => {
  const control = event.currentTarget;
  const result = el('caption-preview-result');
  const code = el('caption-script').value;
  const input = el('caption-preview-data').value;
  control.disabled = true;
  result.hidden = true;
  try {
    let data;
    try { data = JSON.parse(input); } catch {
      throw new Error('Проверьте JSON в данных для подписи.');
    }
    const { caption } = await api('caption-preview', { code, data });
    result.textContent = caption || 'Пустая подпись.';
  } catch (error) {
    result.textContent = error.message;
  } finally {
    control.disabled = false;
    result.hidden = false;
  }
});

el('caption-reset').onclick = action(async event => {
  const control = event.currentTarget;
  control.disabled = true;
  try {
    const { template } = await api('caption-reset', {});
    setJavaScript(el('caption-script'), template);
    el('caption-preview-result').hidden = true;
    el('publication-settings-status').textContent = 'Шаблон восстановлен из файла.';
  } finally {
    control.disabled = false;
  }
});

el('publication-settings').onsubmit = action(async event => {
  const form = event.currentTarget;
  const feedback = el('publication-settings-status');
  feedback.textContent = '';
  const settings = await api('publication-settings', {
    destinationIds: [...selectedPublicationDestinations()],
    template: form.elements.template.value,
    originalCaption: form.elements.originalCaption.checked,
    originalAuthor: form.elements.originalAuthor.checked
  });
  savedDestinations = settings.destinations;
  feedback.textContent = 'Настройки сохранены.';
});

setInterval(() => {
  if (view === 'publication' && !el('publication-settings').hidden && el('unlock').hidden) {
    refreshPublicationInventory().catch(() => {});
  }
}, 5000);

el('search').onsubmit = action(async () => {
  history.replaceState(null, '', catalogPath());
  await loadCatalog(true);
});
el('more-catalog').onclick = action(async event => {
  const control = event.currentTarget;
  control.disabled = true;
  try { await loadCatalog(false); } finally { control.disabled = false; }
});

const detailId = /^\/anime\/([1-9]\d*)\/?$/.exec(location.pathname)?.[1];
const detailOrigin = new URLSearchParams(location.search).get('from') === 'tracking' ? 'tracking' : 'catalog';

function showView(next) {
  if (view === 'details' && next !== view) {
    playbackVersion++;
    animePlayer.pause();
    animePlayer.hidden = true;
    animePlayer.removeAttribute('src');
    animePlayer.load();
    playbackNotice('', Boolean(playbackSources.size));
  }
  el(view).hidden = true;
  view = next;
  el('app-header').hidden = next === 'login-scene';
  const tabView = next === 'details' ? detailOrigin : next;
  for (const tab of document.querySelectorAll('[data-view]')) {
    if (tab.dataset.view === tabView) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  el(view).hidden = false;
  for (const editor of javaScriptEditors.values()) {
    if (editor.getWrapperElement().offsetParent) editor.refresh();
  }
}

let updateRequest;
function loadUpdateStatus() {
  updateRequest ??= api('update-status').then(({ status, current, latest }) => {
    el('update-link').hidden = status !== 'available';
    const messages = {
      available: 'Доступна новая версия ' + (latest?.slice(0, 7) ?? '') + '.',
      current: 'Обновлений нет.',
      unknown: 'Не удалось определить версию установленной копии.',
      unavailable: 'Не удалось проверить обновления на GitHub.'
    };
    el('update-status').textContent = [messages[status], current ? 'Текущая версия ' + current.slice(0, 7) + '.' : '']
      .filter(Boolean).join(' ');
  }).catch(() => {
    el('update-status').textContent = 'Не удалось проверить обновления.';
  }).finally(() => { updateRequest = undefined; });
  return updateRequest;
}

async function loadRoute() {
  await loadViewSettings();
  void loadUpdateStatus();
  showCatalogFilters();
  const query = new URLSearchParams(location.search);
  if (detailId) {
    showView('details');
    await loadAnime(detailId);
  } else if (!query.get('view') || query.get('view') === 'catalog') {
    showView('catalog');
    el('search').elements.q.value = query.get('q') || '';
    await Promise.all([loadCatalog(true), loadCatalogFilters()]);
  } else if (query.get('view') === 'review') {
    showView('review');
    await loadReview();
  } else if (query.get('view') === 'publication') {
    showView('publication');
    await loadPublicationSettings();
  } else if (query.get('view') === 'tracking') {
    showView('tracking');
    await loadTracking();
  } else if (query.get('view') === 'sources') {
    showView('sources');
    await loadSources();
  } else if (query.get('view') === 'analysis-log') {
    showView('analysis-log');
    await loadAnalysisLog();
  } else if (query.get('view') === 'updates') {
    showView('updates');
  } else {
    location.replace('/');
  }
}

el('update-link').onclick = event => {
  if (detailId || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  showView('updates');
  history.replaceState(null, '', event.currentTarget.href);
  void loadUpdateStatus();
};

for (const tab of document.querySelectorAll('[data-view]')) {
  tab.onclick = action(async () => {
    const next = tab.dataset.view;
    if (detailId) {
      location.href = next === detailOrigin ? el('back-catalog').href : '/?' + new URLSearchParams({ view: next });
      return;
    }
    showView(next);
    const path = next === 'catalog' ? catalogPath() : next === 'tracking' ? trackingPath() : '/?' + new URLSearchParams({ view: next });
    history.replaceState(null, '', path);
    if (view === 'catalog') await Promise.all([loadCatalog(true), loadCatalogFilters()]);
    if (view === 'review') await loadReview();
    if (view === 'publication') await loadPublicationSettings();
    if (view === 'tracking') await loadTracking();
    if (view === 'sources') await refresh();
    if (view === 'analysis-log') await loadAnalysisLog();
  });
}

let logSession = '';
let logEntries = [];
let pollingLog = false;
const logDateTime = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit'
});
async function loadAnalysisLog() {
  if (pollingLog) return;
  pollingLog = true;
  try {
    const { session, entries } = await api('analysis-log?' + new URLSearchParams({
      session: logSession, after: logEntries.at(-1)?.id ?? 0
    }));
    if (session === logSession && !entries.length) return;
    const screen = el('analysis-console');
    const atBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 24;
    const oldTop = screen.scrollTop;
    if (session !== logSession) logEntries = [];
    logSession = session;
    logEntries = [...logEntries, ...entries].slice(-1000);
    screen.textContent = logEntries.length
      ? logEntries.map(entry => '[' + logDateTime.format(entry.processedAt) + '] ' + entry.line).join('\n')
      : 'Ожидаем сообщения…';
    screen.scrollTop = atBottom ? screen.scrollHeight : oldTop;
  } finally {
    pollingLog = false;
  }
}

refresh().catch(error => notice(error.message));
setInterval(() => {
  if (view !== 'login-scene') void loadUpdateStatus();
}, 60_000);
setInterval(() => {
  if (view === 'analysis-log') loadAnalysisLog().catch(() => {});
}, 1000);
setInterval(updateQrVisibility, 1000);
setInterval(() => {
  if (['login-scene', 'sources'].includes(view) && el('unlock').hidden) refresh().catch(error => notice(error.message));
}, 2200);

let pollingMetadata = false;
setInterval(async () => {
  if (pollingMetadata || !el('unlock').hidden) return;
  pollingMetadata = true;
  try {
    if (view === 'catalog' && pendingCovers.size) {
      const version = catalogVersion;
      const ids = [...pendingCovers.keys()].slice(0, 50);
      const rows = await api('anime-metadata?' + new URLSearchParams({ ids: ids.join(',') }));
      if (version !== catalogVersion) return;
      for (const row of rows) {
        if (!row.metadataChecked) continue;
        pendingCovers.get(row.id)?.(row.shikimori);
        if (!row.posterPending) pendingCovers.delete(row.id);
      }
    } else if (view === 'details' && detailWaiting) {
      const page = await api('anime-page?' + new URLSearchParams({ id: detailId }));
      if (page.anime.id !== Number(detailId)) location.replace('/anime/' + page.anime.id + location.search);
      else showAnimeInfo(page);
    }
  } catch {
    // A transient metadata failure should not interrupt browsing the local catalog.
  } finally {
    pollingMetadata = false;
  }
}, 3500);

let pollingTracking = false;
setInterval(async () => {
  if (pollingTracking || !el('unlock').hidden || !['tracking', 'details'].includes(view)) return;
  pollingTracking = true;
  try {
    if (view === 'tracking') await loadTracking();
    else {
      const epoch = episodeReadEpoch;
      const state = await api('tracking-episodes?' + new URLSearchParams({ id: detailId, source: episodeSource }));
      if (epoch === episodeReadEpoch) showEpisodes(detailId, state);
    }
  } catch {
    // The next refresh can recover after a temporary connection problem.
  } finally {
    pollingTracking = false;
  }
}, 5000);

let pollingPublications = false;
setInterval(async () => {
  if (pollingPublications || !el('unlock').hidden) return;
  for (const [id, entry] of pendingPublications) {
    if (!entry.panel.isConnected) pendingPublications.delete(id);
  }
  if (!pendingPublications.size) return;
  pollingPublications = true;
  try {
    const entries = [...pendingPublications.values()];
    for (let start = 0; start < entries.length; start += 100) {
      const batch = entries.slice(start, start + 100);
      const states = await api('publication-status', batch.map(entry => entry.key));
      for (const { key, panel, render } of batch) {
        if (panel.isConnected) render(states.filter(state => publicationKey(state) === publicationKey(key)));
      }
    }
  } catch {
    // A temporary connection problem will be retried by the next poll.
  } finally {
    pollingPublications = false;
  }
}, 1700);
