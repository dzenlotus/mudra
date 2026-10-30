import init, {Simulation} from './pkg/mudra_cellarium_web.js';

// HTTP, persistence and embedding inference belong here; policy execution belongs to WASM.
const DB_NAME = 'mudra-cellarium-wasm-v1';
const defaultConfig = () => ({model_url:'',model:'',reasoning:'off',model_options:{},max_model_calls:24,
  embedding_url:'',embedding_model:'',embedding_dimensions:null,embedding_use_model_key:false});
let database = null, simulation, config = defaultConfig(), requiresKeys = {model:false,embedding:false};
let modelKey = '', embeddingKey = '', checked = false, initialized = false, generation = 0;
let lastTick = performance.now(), lastLifetimeCheck = 0, dispatchAfter = 0, persistenceError = '', fatalError = '';
let saving = null, journalPending = [];
const jobs = new Map(), vectorMemory = new Map();
const embeddingMetrics = {provider_calls:0,provider_responses:0,cache_hits:0,vectors_received:0,failures:0};
const modelMetrics = {provider_requests:0,provider_responses:0,provider_failures:0,probe_requests:0,probe_responses:0};
let lastSearch = null;

function secretFreeError(error) {
  let text = error?.message || String(error);
  for (const secret of [modelKey, embeddingKey]) if (secret) text = text.split(secret).join('[скрытый ключ]');
  return text.slice(0, 2000);
}
function providerError(error) {
  const text = secretFreeError(error);
  return /failed to fetch|networkerror|load failed|network request failed/i.test(text)
    ? 'Браузер не получил ответ от API. Проверьте URL, доступ к сети и разрешение API на запросы из браузера (CORS).'
    : text;
}
function warnPersistence(error) {
  persistenceError = `Не удалось сохранить мир в браузере: ${secretFreeError(error)}. Экспортируйте сохранение в файл.`;
  self.postMessage({type:'persistence-warning',error:persistenceError});
}
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
      if (!db.objectStoreNames.contains('journal')) db.createObjectStore('journal', {autoIncrement:true});
      if (!db.objectStoreNames.contains('embeddings')) db.createObjectStore('embeddings');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Другая вкладка блокирует открытие хранилища.'));
  });
}
function readStore(store, key) {
  if (!database) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const request = database.transaction(store, 'readonly').objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function writeVector(key, vector) {
  if (!database) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('embeddings', 'readwrite');
    transaction.objectStore('embeddings').put(vector, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Запись эмбеддинга прервана.'));
  });
}
function collectJournal() {
  if (!simulation) return;
  journalPending.push(...JSON.parse(simulation.drain_journal()));
}
function record(event) {
  journalPending.push({...event, browser_time:new Date().toISOString()});
}
async function persist() {
  if (saving) return saving;
  collectJournal();
  if (!database || !simulation) return;
  const count = journalPending.length;
  const events = journalPending.slice(0, count);
  const snapshot = simulation.snapshot();
  const saved = {snapshot,config:structuredClone(config),requires_keys:{...requiresKeys},embedding_metrics:{...embeddingMetrics},model_metrics:{...modelMetrics}};
  saving = new Promise((resolve, reject) => {
    const transaction = database.transaction(['state','journal'], 'readwrite');
    transaction.objectStore('state').put(saved, 'current');
    const store = transaction.objectStore('journal');
    for (const event of events) store.add(event);
    transaction.oncomplete = () => { journalPending.splice(0,count); persistenceError=''; resolve(); };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Сохранение прервано.'));
  }).catch(warnPersistence).finally(() => {saving=null;});
  return saving;
}
function configured() { return !!(config.model_url && config.model); }
function effectiveEmbeddingKey() { return config.embedding_use_model_key ? modelKey : embeddingKey; }
function keyRequired() {
  return (requiresKeys.model && !modelKey) || (!!config.embedding_model && (config.embedding_use_model_key ? requiresKeys.model && !modelKey : requiresKeys.embedding && !embeddingKey));
}
function publicConfiguration() {
  return {configured:configured(),config:structuredClone(config),has_api_key:!!modelKey,
    has_embedding_api_key:!!effectiveEmbeddingKey(),keys_required:!!keyRequired(),checked};
}
function normalizeUrl(value, label = 'API') {
  let parsed;
  try { parsed = new URL(String(value).trim()); } catch { throw new Error(`${label}: укажите полный HTTP(S) адрес API.`); }
  if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label}: используйте корень HTTP(S) API без ключей, query-параметров и /chat/completions.`);
  }
  return parsed.href.replace(/\/+$/, '');
}
function validateConfiguration(value) {
  const model_url = normalizeUrl(value.model_url, 'Модель');
  const model = String(value.model || '').trim();
  if (!model) throw new Error('Укажите ID модели.');
  const options = value.model_options || {};
  if (typeof options !== 'object' || Array.isArray(options)) throw new Error('Параметры модели должны быть JSON-объектом.');
  const reasoning = value.reasoning || 'off';
  if (!['off','none','minimal','low','medium','high','xhigh'].includes(reasoning)) throw new Error('Неизвестный режим reasoning.');
  const max_model_calls = Number(value.max_model_calls ?? 24);
  if (!Number.isInteger(max_model_calls) || max_model_calls < 1) throw new Error('Лимит урока должен быть положительным целым числом.');
  const embedding_model = String(value.embedding_model || '').trim();
  const embedding_url = value.embedding_url ? normalizeUrl(value.embedding_url, 'Эмбеддер') : '';
  if (!!embedding_model !== !!embedding_url) throw new Error('Для эмбеддера нужны и адрес API, и ID модели.');
  const embedding_dimensions = value.embedding_dimensions == null || value.embedding_dimensions === '' ? null : Number(value.embedding_dimensions);
  if (embedding_dimensions !== null && (!Number.isInteger(embedding_dimensions) || embedding_dimensions < 1 || embedding_dimensions > 65536)) {
    throw new Error('Размерность эмбеддингов должна быть целым числом от 1 до 65536.');
  }
  return {model_url,model,reasoning,model_options:structuredClone(options),max_model_calls,
    embedding_url,embedding_model,embedding_dimensions,embedding_use_model_key:!!value.embedding_use_model_key};
}
function cancelJobs(reason, feedFailure) {
  generation++;
  for (const [id, job] of jobs) {
    job.controller.abort();
    if (feedFailure) simulation.complete_job(BigInt(id), JSON.stringify({transport_error:reason}));
  }
  jobs.clear();
}
function headers(key) {
  const result = {'Content-Type':'application/json','Accept':'application/json'};
  if (key) result.Authorization = `Bearer ${key}`;
  return result;
}
async function jsonFetch(url, options = {}, key = '', signal) {
  let response;
  const controller=new AbortController();
  const forwardAbort=()=>controller.abort();
  signal?.addEventListener('abort',forwardAbort,{once:true});
  if(signal?.aborted) controller.abort();
  const timeout=setTimeout(()=>controller.abort(new Error('API не ответил за 120 секунд.')),120000);
  try {
  response = await fetch(url, {...options,cache:'no-store',headers:{...headers(key),...options.headers},signal:controller.signal});
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`API вернул не JSON (HTTP ${response.status}). Проверьте корень API и протокол Chat Completions.`); }
  if (!response.ok) {
    const detail = value.error?.message || value.error || value.message || response.statusText;
    throw new Error(`API: HTTP ${response.status}${detail ? ` — ${secretFreeError(typeof detail === 'string' ? detail : JSON.stringify(detail))}` : ''}`);
  }
  if (value.error) throw new Error(`API: ${secretFreeError(value.error.message || JSON.stringify(value.error))}`);
  return value;
  } catch (error) {
    const message=controller.signal.reason?.message || providerError(error);
    throw new Error(key ? message.split(key).join('[скрытый ключ]') : message);
  }
  finally {clearTimeout(timeout);signal?.removeEventListener('abort',forwardAbort);}
}
function modelBody(messages, tools) {
  const options = structuredClone(config.model_options);
  if (config.reasoning === 'off') { delete options.reasoning; delete options.reasoning_effort; }
  else { delete options.reasoning_effort; options.reasoning = {effort:config.reasoning}; }
  return {...options,model:config.model,messages,tools,tool_choice:'auto',parallel_tool_calls:false,stream:false};
}
function vectorValid(vector) {
  return Array.isArray(vector) && vector.length > 0 && vector.every(Number.isFinite) && vector.some(x => x !== 0);
}
async function vectorBatch(texts, signal, useCache = true) {
  const identity = [config.embedding_url,config.embedding_model,config.embedding_dimensions];
  const vectors = new Map(), missing = [];
  for (const text of new Set(texts)) {
    const key = JSON.stringify([...identity,text]);
    let vector = useCache ? vectorMemory.get(key) : undefined;
    if (!vector && useCache && database) {
      try { vector = await readStore('embeddings',key); } catch (error) { warnPersistence(error); }
    }
    if (vector && vectorValid(vector)) {
      vectors.set(text,vector);vectorMemory.set(key,vector);embeddingMetrics.cache_hits++;
    } else missing.push({text,key});
  }
  for (let start=0;start<missing.length;start+=64) {
    const batch = missing.slice(start,start+64);
    const body = {model:config.embedding_model,input:batch.map(item=>item.text),encoding_format:'float'};
    if (config.embedding_dimensions) body.dimensions=config.embedding_dimensions;
    embeddingMetrics.provider_calls++;
    try {
    const value=await jsonFetch(`${config.embedding_url}/embeddings`,{method:'POST',body:JSON.stringify(body)},effectiveEmbeddingKey(),signal);
    if (!Array.isArray(value.data) || value.data.length!==batch.length) throw new Error('Эмбеддер вернул неверное количество векторов.');
    const ordered = new Array(batch.length);
    for (let i=0;i<value.data.length;i++) {
      const index = value.data[i].index ?? i;
      if (!Number.isInteger(index) || index<0 || index>=batch.length || ordered[index]) throw new Error('Эмбеддер вернул неверные индексы векторов.');
      ordered[index]=value.data[i].embedding;
    }
    let dimensions=config.embedding_dimensions || null;
    for (let i=0;i<batch.length;i++) {
      const vector=ordered[i];
      if (!vectorValid(vector) || dimensions && vector.length!==dimensions) throw new Error('Эмбеддер вернул некорректный вектор или размерность.');
      dimensions=vector.length;
      vectors.set(batch[i].text,vector);
      vectorMemory.set(batch[i].key,vector);
      try { await writeVector(batch[i].key,vector); } catch (error) { warnPersistence(error); }
    }
    embeddingMetrics.provider_responses++;embeddingMetrics.vectors_received+=batch.length;
    } catch(error) {embeddingMetrics.failures++;throw error;}
  }
  return vectors;
}
function cosine(left,right) {
  if (left.length!==right.length) return -1;
  let dot=0,a=0,b=0;
  for(let i=0;i<left.length;i++){dot+=left[i]*right[i];a+=left[i]*left[i];b+=right[i]*right[i];}
  return a&&b?dot/Math.sqrt(a*b):-1;
}
function lexicalHits(query,documents) {
  const words=query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  return documents.map(document=>({...document,score:words.reduce((n,w)=>n+(document.text.toLowerCase().includes(w)?1:0),0)}))
    .sort((a,b)=>b.score-a.score).slice(0,6);
}
async function knowledgeSearch(job,signal) {
  const documents=Array.isArray(job.documents)?job.documents:[];
  if (!config.embedding_model) return {mode:'lexical',hits:lexicalHits(job.query,documents)};
  try {
    const vectors=await vectorBatch([job.query,...documents.map(doc=>doc.text)],signal);
    const query=vectors.get(job.query);
    const hits=documents.map(document=>({...document,score:cosine(query,vectors.get(document.text))})).sort((a,b)=>b.score-a.score).slice(0,6);
    return {mode:'semantic',hits};
  } catch (error) {
    if (signal.aborted) throw error;
    const message=providerError(error);
    record({kind:'embedding_search_failed',job:job.id,error:message,fallback:'lexical'});
    return {mode:'lexical_fallback',error:message,hits:lexicalHits(job.query,documents)};
  }
}
async function executeJob(job) {
  const controller=new AbortController(), epoch=generation;
  let requested=false;
  jobs.set(job.id,{controller,cell_id:job.cell_id});
  try {
    const search=await knowledgeSearch(job,controller.signal);
    lastSearch={job:job.id,mode:search.mode,hits:search.hits.length,error:search.error || null};
    if(typeof simulation.record_retrieval==='function') simulation.record_retrieval(JSON.stringify({job_id:job.id,
      provider_calls:embeddingMetrics.provider_calls,provider_responses:embeddingMetrics.provider_responses,
      cache_hits:embeddingMetrics.cache_hits,documents:job.documents?.length || 0,...lastSearch}));
    const messages=job.messages.slice();
    if (search.hits.length || search.error) messages.push({role:'user',content:JSON.stringify({knowledge_search:search,
      note:'These are semantic candidates from your own subnet and archived knowledge; relevance is not proof of applicability. Keep the original observation and goal unchanged.'})});
    record({kind:'knowledge_search',job:job.id,cell_id:job.cell_id,query:job.query,...search});
    requested=true;modelMetrics.provider_requests++;
    const value=await jsonFetch(`${config.model_url}/chat/completions`,{method:'POST',body:JSON.stringify(modelBody(messages,job.tools))},modelKey,controller.signal);
    modelMetrics.provider_responses++;
    if (epoch!==generation) return;
    value._request_messages=messages;
    simulation.complete_job(BigInt(job.id),JSON.stringify(value));
  } catch (error) {
    if (epoch!==generation) return;
    if(requested)modelMetrics.provider_failures++;
    const message=providerError(error);
    simulation.complete_job(BigInt(job.id),JSON.stringify({transport_error:message}));
    dispatchAfter=performance.now()+2000;
    record({kind:'model_transport_failed',job:job.id,cell_id:job.cell_id,error:message});
  } finally {
    if (epoch===generation) jobs.delete(job.id);
    collectJournal();
  }
}
async function probe() {
  if (!configured()) throw new Error('Сначала укажите API и модель.');
  if (keyRequired()) throw new Error('Введите API-ключи для этой вкладки.');
  checked=false;
  const tools=[{type:'function',function:{name:'cellarium_probe',description:'Return connectivity status only.',parameters:{type:'object',properties:{ready:{type:'boolean'}},required:['ready'],additionalProperties:false}}}];
  const messages=[{role:'user',content:'Connectivity check only. Call cellarium_probe with ready=true. Do not perform any other task.'}];
  modelMetrics.probe_requests++;
  const value=await jsonFetch(`${config.model_url}/chat/completions`,{method:'POST',body:JSON.stringify(modelBody(messages,tools))},modelKey);
  modelMetrics.probe_responses++;
  const choice=value.choices?.[0],calls=choice?.message?.tool_calls;
  let args;
  try {args=JSON.parse(calls?.[0]?.function?.arguments || '{}');}catch{}
  if (choice?.finish_reason!=='tool_calls' || calls?.length!==1 || !calls[0].id || calls[0].function?.name!=='cellarium_probe' || args?.ready!==true) {
    throw new Error('Модель не вернула корректный вызов инструмента. Нужен Chat Completions API с поддержкой tool calls.');
  }
  if(config.embedding_model) await vectorBatch(['cell hunger'],undefined,false);
  checked=true;
  record({kind:'provider_probe',model:config.model,embedding_model:config.embedding_model || null,passed:true});
  return {ok:true,detail:`Модель выполнила настоящий вызов инструмента${config.embedding_model ? ', эмбеддер вернул вектор' : ''}. WebAssembly готова.`};
}
function state() {
  const value=JSON.parse(simulation.state());
  value.learning.transport={embedding:{...embeddingMetrics},model:{...modelMetrics},last_search:lastSearch,persistence_error:persistenceError || null};
  value.metrics.model_http_requests=modelMetrics.provider_requests;
  value.metrics.model_http_responses=modelMetrics.provider_responses;
  value.metrics.embedding_provider_calls=embeddingMetrics.provider_calls;
  value.metrics.embedding_cache_hits=embeddingMetrics.cache_hits;
  return value;
}
async function route(path,method,raw) {
  const body=raw?JSON.parse(raw):{};
  if(path==='/api/state' && method==='GET') return state();
  if(path==='/api/config' && method==='GET') return publicConfiguration();
  if(path==='/api/config' && method==='POST') {
    const next=validateConfiguration(body);
    cancelJobs('Подключение изменено. Урок продолжится с новым API.',true);
    const modelChanged=next.model_url!==config.model_url,embeddingChanged=next.embedding_url!==config.embedding_url;
    modelKey=String(body.api_key || (modelChanged ? '' : modelKey)).trim();
    embeddingKey=String(body.embedding_api_key || (embeddingChanged ? '' : embeddingKey)).trim();
    requiresKeys={model:!!modelKey || (!modelChanged && requiresKeys.model),embedding:!!embeddingKey || (!embeddingChanged && requiresKeys.embedding)};
    config=next;checked=false;simulation.set_provider(config.model);await persist();
    return {ok:true,...publicConfiguration()};
  }
  if(path==='/api/models' && method==='POST') {
    const url=normalizeUrl(body.url);
    const key=String(body.api_key || (url===config.model_url?modelKey:url===config.embedding_url?effectiveEmbeddingKey():'')).trim();
    const value=await jsonFetch(`${url}/models`,{method:'GET'},key);
    const list=Array.isArray(value.data)?value.data:Array.isArray(value.models)?value.models:Array.isArray(value)?value:[];
    const names=[...new Set(list.map(model=>typeof model==='string'?model:model.id).filter(id=>typeof id==='string'&&id))].sort();
    return {ok:true,models:names.map(id=>({id}))};
  }
  if(path==='/api/check' && method==='POST') return probe();
  if(path==='/api/control' && method==='POST') {
    if(['resume','step'].includes(body.action) && (!configured() || !checked || keyRequired())) throw new Error('Подключите и проверьте модель через настройки перед запуском.');
    const value=JSON.parse(simulation.control(JSON.stringify(body)));collectJournal();await persist();return value;
  }
  if(path==='/api/export' && method==='GET') {
    await persist();
    return {format:'mudra-cellarium-export-v1',snapshot:JSON.parse(simulation.snapshot()),config:structuredClone(config),requires_keys:{...requiresKeys}};
  }
  if(path==='/api/import' && method==='POST') {
    if(body.format && body.format!=='mudra-cellarium-export-v1') throw new Error('Неизвестный формат экспорта.');
    const saved=typeof body.snapshot==='string'?body.snapshot:JSON.stringify(body.snapshot);
    const replacement=new Simulation(3701,saved);
    let next=defaultConfig();
    try {if(body.config?.model_url) next=validateConfiguration(body.config);} catch(error){replacement.free();throw error;}
    cancelJobs('Открыто другое сохранение.',false);
    const previous=simulation;simulation=replacement;previous.free();
    modelKey='';embeddingKey='';checked=false;config=next;
    requiresKeys={model:!!body.requires_keys?.model,embedding:!!body.requires_keys?.embedding};
    simulation.set_provider(config.model || 'не настроена');lastTick=performance.now();await persist();
    return {ok:true,...publicConfiguration()};
  }
  throw new Error(`Неизвестный локальный запрос: ${method} ${path}`);
}

const ready=(async()=>{
  try {database=await openDatabase();}catch(error){warnPersistence(error);}
  let saved;
  try {saved=await readStore('state','current');}catch(error){warnPersistence(error);}
  await init();
  simulation=new Simulation(3701,saved?.snapshot || '');
  if(saved?.config?.model_url) config=validateConfiguration(saved.config);
  requiresKeys={model:!!saved?.requires_keys?.model,embedding:!!saved?.requires_keys?.embedding};
  Object.assign(embeddingMetrics,saved?.embedding_metrics || {});
  Object.assign(modelMetrics,saved?.model_metrics || {});
  simulation.set_provider(config.model || 'не настроена');
  initialized=true;lastTick=performance.now();
  self.postMessage({type:'ready',runtime:'WebAssembly'});
  setInterval(()=>{
    if(fatalError)return;
    try {
      const now=performance.now(),elapsed=(now-lastTick)/1000;lastTick=now;
      simulation.tick(elapsed);collectJournal();
      if(jobs.size && now-lastLifetimeCheck>=500){
        lastLifetimeCheck=now;
        const active=new Set(JSON.parse(simulation.state()).learning.active);
        for(const [id,job] of jobs)if(!active.has(job.cell_id)){job.controller.abort();jobs.delete(id);}
      }
      if(checked && configured() && !keyRequired() && now>=dispatchAfter) {
        const next=JSON.parse(simulation.take_jobs(2,config.max_model_calls));
        for(const job of next) executeJob(job);
      }
    }catch(error){fatalError=secretFreeError(error);self.postMessage({type:'fatal',error:`WebAssembly: ${fatalError}`});}
  },50);
  setInterval(()=>persist(),1000);
})().catch(error=>{
  fatalError=secretFreeError(error);self.postMessage({type:'fatal',error:`Не удалось загрузить WebAssembly: ${fatalError}`});
  throw error;
});
ready.catch(()=>{});
self.addEventListener('message',async({data})=>{
  const {id,path,method,body}=data;
  try {
    await ready;
    if(!initialized || fatalError)throw new Error(fatalError || 'WebAssembly ещё загружается.');
    const result=await route(path,method,body);
    self.postMessage({id,status:200,body:result});
  }catch(error){self.postMessage({id,status:400,body:{ok:false,error:providerError(error)}});}
});
