(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const dialog = $('setup-dialog'), form = $('setup-form');
  let configured = false, available = true, busy = false;
  const errorMessage = error => /failed to fetch|networkerror|load failed/i.test(error.message || '') ? 'Браузер не получил ответ от API. Проверьте адрес и доступ API из браузера (CORS).' : error.message;

  async function request(path, body) {
    const response = await fetch(path, body === undefined ? {cache:'no-store'} : {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
    });
    let value;
    try { value = await response.json(); }
    catch { throw new Error(`Не удалось прочитать ответ подключения (HTTP ${response.status}).`); }
    if (!response.ok || value.ok === false || value.error) {
      const error = value.error?.message || value.error || value.message || `HTTP ${response.status}`;
      throw new Error(typeof error === 'string' ? error : JSON.stringify(error));
    }
    return value;
  }
  function status(message, error = false) {
    $('setup-status').textContent = message;
    $('setup-status').hidden = !message;
    $('setup-status').classList.toggle('error', error);
  }
  function setBusy(value) {
    busy = value;
    $('setup-fields').disabled = value;
    $('setup-close').disabled = value;
    $('setup-start').disabled = value;
    $('setup-start').textContent = value ? 'Проверяю подключение…' : 'Проверить и запустить';
    dialog.setAttribute('aria-busy', String(value));
  }
  function embeddingFields() {
    const enabled = $('setup-embedding-enabled').checked;
    $('setup-embedding-fields').hidden = !enabled;
    $('setup-embedding-url').required = enabled;
    $('setup-embedding-model').required = enabled;
    $('setup-dimensions').disabled = !enabled;
    $('setup-embedding-key-field').hidden = $('setup-embedding-use-model-key').checked;
  }
  function fill(value) {
    const config = value.config || {};
    configured = !!value.configured;
    $('setup-model-url').value = config.model_url || '';
    $('setup-model').value = config.model || '';
    $('setup-reasoning').value = config.reasoning || 'off';
    $('setup-max-calls').value = String(config.max_model_calls || 24);
    $('setup-model-options').value = typeof config.model_options === 'string' ? config.model_options : JSON.stringify(config.model_options || {}, null, 2);
    $('setup-embedding-enabled').checked = !!(config.embedding_url && config.embedding_model);
    $('setup-embedding-url').value = config.embedding_url || '';
    $('setup-embedding-model').value = config.embedding_model || '';
    $('setup-dimensions').value = config.embedding_dimensions || '';
    $('setup-embedding-use-model-key').checked = config.embedding_use_model_key ?? (config.embedding_url === config.model_url || !value.has_embedding_api_key);
    $('setup-api-key').value = '';
    $('setup-embedding-api-key').value = '';
    $('setup-key-note').textContent = value.has_api_key ? 'Ключ уже есть в памяти вкладки. Оставьте поле пустым, чтобы использовать его.' : 'Ключ останется в памяти вкладки до её закрытия.';
    $('setup-embedding-key-note').textContent = value.has_embedding_api_key ? 'Ключ уже есть в памяти вкладки. Оставьте поле пустым, чтобы использовать его.' : 'Ключ не сохраняется в настройках.';
    embeddingFields();
    return value;
  }
  async function open() {
    if (busy) return;
    status('');
    if (!dialog.open) dialog.showModal();
    try {
      fill(await request('/api/config'));
      available = true;
      $('setup-model-url').focus();
    } catch (error) {
      status(`Не удалось загрузить настройки: ${errorMessage(error)}`, true);
    }
  }
  async function discover(embedding) {
    const prefix = embedding ? 'setup-embedding-' : 'setup-';
    const url = $(embedding ? 'setup-embedding-url' : 'setup-model-url');
    const key = $(embedding && !$('setup-embedding-use-model-key').checked ? 'setup-embedding-api-key' : 'setup-api-key');
    const button = $(`${prefix}models`), note = $(`${prefix}models-status`);
    if (!url.value.trim() || !url.reportValidity()) { url.focus(); return; }
    button.disabled = true;
    note.classList.remove('error'); note.textContent = 'Запрашиваю доступные модели…';
    try {
      const payload = {url:url.value.trim()};
      if (key.value.trim()) payload.api_key = key.value.trim();
      const result = await request('/api/models', payload);
      const list = $(`${prefix}model-list`);
      list.replaceChildren();
      const models = result.models || result.data || [];
      for (const model of models) {
        const id = typeof model === 'string' ? model : model.id;
        if (typeof id !== 'string' || !id) continue;
        const option = document.createElement('option'); option.value = id; list.append(option);
      }
      note.textContent = list.children.length ? `Доступно моделей: ${list.children.length}. Выберите модель в поле выше.` : 'API вернул пустой список. Можно вписать ID модели вручную.';
      $(embedding ? 'setup-embedding-model' : 'setup-model').focus();
    } catch (error) {
      note.textContent = `${errorMessage(error)} Можно вписать ID модели вручную.`; note.classList.add('error');
    } finally { button.disabled = false; }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    let options;
    try {
      options = JSON.parse($('setup-model-options').value || '{}');
      if (!options || Array.isArray(options) || typeof options !== 'object') throw new Error();
    } catch {
      status('Параметры модели должны быть JSON-объектом, например {}.', true);
      $('setup-model-options').closest('details').open = true;
      $('setup-model-options').focus();
      return;
    }
    const embedding = $('setup-embedding-enabled').checked;
    const payload = {
      model_url:$('setup-model-url').value.trim(), model:$('setup-model').value.trim(),
      reasoning:$('setup-reasoning').value, model_options:options,
      max_model_calls:Number($('setup-max-calls').value),
      embedding_url:embedding ? $('setup-embedding-url').value.trim() : '',
      embedding_model:embedding ? $('setup-embedding-model').value.trim() : '',
      embedding_dimensions:embedding && $('setup-dimensions').value ? Number($('setup-dimensions').value) : null,
      embedding_use_model_key:embedding && $('setup-embedding-use-model-key').checked
    };
    if ($('setup-api-key').value.trim()) payload.api_key = $('setup-api-key').value.trim();
    if (embedding && !$('setup-embedding-use-model-key').checked && $('setup-embedding-api-key').value.trim()) payload.embedding_api_key = $('setup-embedding-api-key').value.trim();
    setBusy(true);
    status('Сохраняю настройки подключения…');
    try {
      await request('/api/control', {action:'pause'});
      await request('/api/config', payload);
      $('setup-api-key').value = ''; $('setup-embedding-api-key').value = '';
      status(`Проверяю модель${embedding ? ' и эмбеддер' : ''}. Это может занять несколько секунд…`);
      await request('/api/check', {});
      status('Подключение проверено. Запускаю мир…');
      await request('/api/control', {action:'resume'});
      configured = true;
      dialog.close();
      window.dispatchEvent(new CustomEvent('cellarium-config-applied'));
    } catch (error) {
      status(`Мир остаётся на паузе. ${errorMessage(error)}`, true);
    } finally { setBusy(false); }
  });
  $('settings-btn').addEventListener('click', open);
  $('setup-close').addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  $('setup-models').addEventListener('click', () => discover(false));
  $('setup-embedding-models').addEventListener('click', () => discover(true));
  $('setup-embedding-enabled').addEventListener('change', () => {
    if ($('setup-embedding-enabled').checked && !$('setup-embedding-url').value) $('setup-embedding-url').value = $('setup-model-url').value;
    embeddingFields();
  });
  $('setup-embedding-use-model-key').addEventListener('change', embeddingFields);
  $('setup-embedding-url').addEventListener('change', () => {
    if ($('setup-embedding-url').value.replace(/\/$/,'') !== $('setup-model-url').value.replace(/\/$/,'')) $('setup-embedding-use-model-key').checked = false;
    embeddingFields();
  });
  // The server/worker also validates activation; this keeps first-run clicks explanatory.
  for (const id of ['pause-btn','step-btn']) $(id).addEventListener('click', event => {
    if (available && !configured) { event.stopImmediatePropagation(); open(); }
  }, true);
  window.cellariumSetup = {open, snapshot:() => ({open:dialog.open, configured, busy}), reload:async () => {
    const value = fill(await request('/api/config'));
    if (!configured || value.keys_required) { if (!dialog.open) dialog.showModal(); status(value.keys_required ? 'Мир загружен на паузе. Введите API-ключи для этой вкладки.' : 'Подключите модель, чтобы клетки могли учиться.'); }
    return value;
  }};
  function fileBusy(value) { $('export-btn').disabled = value; $('import-btn').disabled = value; }
  $('export-btn').addEventListener('click', async () => {
    fileBusy(true);
    try {
      const saved = await request('/api/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(saved)], {type:'application/json'}));
      const link = document.createElement('a'); link.href = url; link.download = `cellarium-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      window.cellariumNotify?.('Мир и знания сохранены в файл. API-ключи в него не включены.');
    } catch (error) { window.cellariumNotify?.(`Не удалось сохранить мир: ${errorMessage(error)}`, true); }
    finally { fileBusy(false); }
  });
  $('import-btn').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files[0]; if (!file) return;
    fileBusy(true);
    try {
      let saved;
      try { saved = JSON.parse(await file.text()); }
      catch { throw new Error('Файл не содержит корректный JSON.'); }
      await request('/api/import', saved);
      window.dispatchEvent(new CustomEvent('cellarium-imported'));
      await window.cellariumSetup.reload();
      window.cellariumNotify?.('Мир и знания загружены. Симуляция на паузе.');
    } catch (error) { window.cellariumNotify?.(`Не удалось загрузить мир: ${errorMessage(error)}`, true); }
    finally { fileBusy(false); $('import-file').value = ''; }
  });
  request('/api/config').then(value => {
    fill(value);
    if (!configured || value.keys_required) {
      dialog.showModal();
      if (value.keys_required) status('Настройки сохранены. Введите API-ключи для этой вкладки.');
    }
  }).catch(() => { available = false; });
})();
