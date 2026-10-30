(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const canvas = $('world'), ctx = canvas.getContext('2d');
  const emptyInspector = $('inspector').innerHTML;
  let state = null, selectedId = null, hoveredId = null, feedMode = false, spawnMode = false, panMode = false, filter = 'all';
  let busy = false, connected = false, frame = 0, toastTimer = 0, pixelRatio = 1;
  let lastPoll = 0, interpolationMs = 450, previous = new Map(), current = new Map(), learningIds = new Set(), canvasSize = {w:1,h:1};
  const camera = {x:0,y:0,zoom:1};
  let drag = null, ignoreClick = false;
  const trails = new Map();
  const escape = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num = (v,d=0) => Number.isFinite(Number(v)) ? Number(v) : d;
  const cells = () => Array.isArray(state?.cells) ? state.cells : [];
  const time = v => { const s = Math.max(0, Math.floor(num(v))); return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; };
  const display = v => v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const compact = (v,max=180) => display(v).length>max ? display(v).slice(0,max)+'…' : display(v);
  const labels = {hunger:'Голод',hungry:'Голод',fatigue:'Усталость',tired:'Усталость',threat:'Опасность',danger:'Опасность',reproduction:'Размножение',reproduce:'Размножение',mate:'Найти партнёра',feed:'Поесть',eat:'Поесть',food:'Питание',rest:'Отдохнуть',move:'Перемещение',contact:'Контакт',wait:'Наблюдение',explore:'Исследование',flee:'Убежать',hunt:'Охота',idle:'Наблюдает',waiting:'Ожидает',learning:'Учится',learned:'Способ сохранён',learning_failed:'Урок не завершён',learning_error:'Ошибка обучения',action_failed:'Действие не выполнено',executing:'Выполняет действие',queued:'В очереди',pending:'В очереди',running:'В работе',testing:'Проверка',published:'Знания сохранены',complete:'Завершено',completed:'Завершено',failed:'Ошибка',blocked:'Не хватает знаний',missing:'Нехватка знаний',vajra:'Ваджра',ghanta:'Гханта',parent:'Опыт родителей',reused:'Повторное применение',birth:'Рождение',death:'Гибель',bond:'Связь',inheritance:'Наследование',grazer:'Клетка',predator:'Клетка',male:'♂',female:'♀'};
  Object.assign(labels,{evolution:'Эволюция',evolution_spawn:'Появилась таблетка',pill_spawn:'Появилась таблетка',arrival:'Прибыла',old_age:'Старость',starvation:'Истощение',predation:'Укус другой клетки',dash:'Рывок',scan:'Сканирование',bite:'Укус',photosynthesize:'Фотосинтез',digest:'Переваривание',store:'Запасание пищи'});
  const label = v => labels[v] || display(v);
  const traitNames={speed:'Скорость',sense:'Сенсоры',social:'Общительность',lifespan:'Срок жизни',aggression:'Агрессия',fertility:'Плодовитость'};
  const organInfo={
    flagellum:{name:'Жгутик',benefit:'Рывок на 3 с; энергия и перезарядка',cost:.015},
    eyespot:{name:'Глазок',benefit:'Активное сканирование на 5 с',cost:.01},
    digestive_vacuole:{name:'Пищеварительная вакуоль',benefit:'Запас до 40 энергии; постепенное переваривание',cost:.012},
    shell:{name:'Защитная оболочка',benefit:'Пассивная защита при укусе',cost:.02},
    jaws:{name:'Челюсти',benefit:'Укус другой клетки; обычная пища тоже доступна',cost:.02},
    chloroplast:{name:'Хлоропласт',benefit:'Фотосинтез на свету',cost:.025}
  };
  const organsOf=c=>[...new Set(Array.isArray(c.organs)?c.organs:[])];
  const learningFor=c=>learningIds.has(String(c.id));
  const deathText=c=>c.death_cause?`Погибла: ${label(c.death_cause).toLowerCase()}`:'Погибла';
  function toast(text,error=false) { $('toast').textContent=text; $('toast').className='toast'+(error?' error':''); $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,4000); }
  function connection(ok) { connected=ok; $('connection-dot').className='status-dot '+(ok?'online':'offline'); $('connection-label').textContent=ok?'Мир на связи':'Нет связи с миром'; document.querySelector('.connection').classList.toggle('offline',!ok); }
  async function refresh() {
    if(busy) return; busy=true;
    try {
      const response=await fetch('/api/state',{cache:'no-store'}); if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const data=await response.json(); if(!Array.isArray(data.cells))throw new Error('Ответ не содержит состояние клеток');
      const now=performance.now();interpolationMs=lastPoll?Math.max(120,Math.min(2000,(now-lastPoll)*.9)):450;previous=current;current=new Map(data.cells.map(c=>[String(c.id),c]));learningIds=new Set((Array.isArray(data.learning?.active)?data.learning.active:[]).map(String));lastPoll=now;state=data;connection(true);
      for(const c of cells()) { const id=String(c.id); const t=trails.get(id)||[]; if(!t.length||Math.hypot(t[t.length-1].x-c.x,t[t.length-1].y-c.y)>3){t.push({x:c.x,y:c.y});if(t.length>32)t.shift();trails.set(id,t);} }
      for(const id of trails.keys())if(!current.has(id))trails.delete(id);
      updateUI();
    } catch(error) { connection(false); $('loading-message').hidden=!!state; if(!state){const issue=window.cellariumRuntimeError,detail=typeof issue==='string'?issue:issue?.message;const message=document.createElement('span');message.textContent=detail||'Проверьте загрузку страницы и доступность симуляции.';$('loading-message').replaceChildren(document.createTextNode(detail?'Не удалось загрузить симуляцию':'Загрузка симуляции…'),message);} }
    finally { busy=false; }
  }
  async function control(action,extra={}) {
    try { const response=await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...extra})}); const result=await response.json();if(!response.ok||result.ok===false||result.error)throw new Error(result.error||result.message||`HTTP ${response.status}`); while(busy)await new Promise(resolve=>setTimeout(resolve,20));await refresh();return result; }
    catch(error) { toast(`Не удалось выполнить действие: ${error.message}`,true);throw error; }
  }
  function pickMetric(...keys) { for(const key of keys) if(state?.metrics?.[key]!=null)return state.metrics[key];return null; }
  function updateUI() {
    clampCamera();cameraUI();
    $('loading-message').hidden=true; $('world-time').textContent=time(state.time);
    $('population-count').textContent=cells().filter(c=>c.alive!==false&&c.status!=='dead').length;
    if(document.activeElement!==$('food-level'))$('food-level').value=String(state.food_level??50);$('food-level-value').textContent=`${Math.round(Number($('food-level').value))}%`;
    $('birth-count').textContent=display(pickMetric('births','birth_count'));
    $('knowledge-count').textContent=display(pickMetric('learned_rules','knowledge_count','rules')??cells().reduce((sum,c)=>sum+num(c.knowledge_count),0));
    $('reuse-count').textContent=display(pickMetric('vajra_reuses','reuse_count','reuses','native_actions'));
    $('model-count').textContent=display(pickMetric('model_calls','ghanta_calls','llm_calls'));
    $('pause-btn').textContent=state.running?'Ⅱ':'▷'; $('pause-btn').setAttribute('aria-label',state.running?'Приостановить симуляцию':'Продолжить симуляцию');
    document.querySelectorAll('[data-speed]').forEach(b=>{const on=num(b.dataset.speed)===num(state.speed,1);b.classList.toggle('active',on);b.setAttribute('aria-pressed',on);});
    const pillCount=(state.foods||[]).filter(f=>f.kind==='evolution'&&num(f.amount)>0).length;
    const next=num(state.next_evolution_at)-num(state.time);
    $('evolution-summary').textContent=`Эволюций: ${num(pickMetric('evolutions'))} · Таблеток на полотне: ${pillCount}${next>0?` · Следующая через ${time(next)}`:''} · От старости: ${num(pickMetric('deaths_old_age'))}`;
    $('light-status').textContent=state.daylight!=null?`Свет ${Math.round(Math.max(0,Math.min(1,num(state.daylight)))*100)}%`:'Свет';
    inspector(); learningUI(); eventUI();
  }
  function meter(title,value,invert=false) {const n=Math.max(0,Math.min(100,num(value)));return `<div class="vital"><span class="vital-label">${title}</span><span class="meter"><i class="${(invert?n>75:n<25)?'low':''}" style="width:${n}%"></i></span><span class="vital-number">${Math.round(n)}</span></div>`;}
  const rounded=v=>num(v).toFixed(1);
  function targetName(id) {const cell=current.get(String(id));if(cell)return cell.name||`#${id}`;const food=(state?.foods||[]).find(f=>String(f.id)===String(id));return food?`${food.kind==='evolution'?'Таблетка':'Пища'} #${id}`:`#${id}`;}
  function actionDescription(entry) {
    if(typeof entry==='string')return entry;
    if(entry.text||entry.message)return entry.text||entry.message;
    const a=entry.action||entry,o=entry.outcome||entry,k=['evolution','dash','scan','bite','photosynthesize','digest','store'].includes(o.kind)?o.kind:a.kind||o.kind;
    if(o.ok===false)return `Не выполнено: ${o.message||'мир отклонил действие'}`;
    const energy=o.energy_before!=null&&o.energy_after!=null?` Энергия ${rounded(o.energy_before)} → ${rounded(o.energy_after)}.`:o.energy_after!=null?` Энергия ${rounded(o.energy_after)}.`:'';
    if(k==='move'&&o.intent)return `Идёт к (${Math.round(num(o.target_x,a.x))}, ${Math.round(num(o.target_y,a.y))}). Движение продолжается во времени мира.`;
    if(k==='evolution'){if(o.change_type==='organ')return `Новый орган: ${organInfo[o.organ]?.name||o.organ}. Поддержание ${num(o.upkeep_per_second).toFixed(3)} энергии/с. Масса ${rounded(o.mass_before)} → ${rounded(o.mass_after)}.`;return `${traitNames[o.trait]||o.trait}: ${rounded(o.before)} → ${rounded(o.after)} (+${rounded(o.percent)}%).`; }
    if(k==='move')return `Прошла ${rounded(o.distance)} ед.${a.x!=null&&a.y!=null?` к (${Math.round(a.x)}, ${Math.round(a.y)})`:''}.${o.reached?' Точка достигнута.':''}${energy}`;
    if(k==='eat')return `Получила ${rounded(o.consumed)} энергии${a.target_id!=null?` от ${targetName(a.target_id)}`:''}.${energy}`;
    if(k==='dash')return `Рывок включён${o.duration!=null?` на ${rounded(o.duration)} с`:''}${o.energy_cost!=null?`; расход ${rounded(o.energy_cost)} энергии`:''}.${energy}`;
    if(k==='scan')return `Активное сканирование${o.duration!=null?` на ${rounded(o.duration)} с`:''}${o.energy_cost!=null?`; расход ${rounded(o.energy_cost)} энергии`:''}.`;
    if(k==='bite')return `Укус ${targetName(a.target_id??o.target_id)}${o.consumed!=null?`; получено ${rounded(o.consumed)} энергии`:''}.${energy}`;
    if(k==='photosynthesize')return `${o.photosynthesizing===false||o.enabled===false?'Фотосинтез выключен':'Фотосинтез включён'}: энергия зависит от света.${energy}`;
    if(k==='digest')return `Пищеварительная вакуоль переваривает запас.${energy}`;
    if(k==='store')return `Пища помещена в запас${o.food_reserve!=null?`: ${rounded(o.food_reserve)} / 40`:''}.${energy}`;
    if(k==='rest')return `Отдых: усталость ${rounded(o.fatigue_before)} → ${rounded(o.fatigue_after)}.`;
    if(k==='contact')return `Контакт с ${targetName(a.target_id)}. Привязанность ${Math.round(num(o.affinity)*100)}%, взаимная ${Math.round(num(o.reciprocal_affinity)*100)}%.${o.bonded?' Взаимная связь сформировалась.':''}`;
    if(k==='reproduce')return `Родилась ${targetName(o.child_id)}. Родители: ${(o.parents||[]).map(targetName).join(' и ')}.${o.knowledge_inherited?' Знания переданы.':' Передача знаний проверяется отдельно.'}`;
    if(k==='wait')return a.reason||'Наблюдает за доступным окружением.';
    return entry.reason||label(k||entry.source||entry.state||'Событие');
  }
  function procedureNames(value) {
    const found=[];
    function collect(v){if(!v)return;if(typeof v==='string'){found.push(v);return;}if(Array.isArray(v)){v.forEach(collect);return;}if(typeof v==='object'){if(v.procedure){const name=typeof v.procedure==='string'?v.procedure:v.procedure.name;if(name)found.push(`${name}${v.revision!=null?`@${v.revision}`:''}`);}if(v.applied)collect(v.applied);if(v.execution)collect(v.execution);}}
    collect(value);return [...new Set(found)];
  }
  function knowledgeDetails(k,open) {
    if(!k)return '';
    const procedures=Array.isArray(k.procedures)?k.procedures:[],rules=Array.isArray(k.rules)?k.rules:[];
    return `<details class="knowledge-details"${open?' open':''}><summary>Сохранённые знания и связи</summary><div class="knowledge-summary">${num(k.parameters)} параметров · ${num(k.contexts)} контекстов · ${num(k.context_relations)} контекстных связей</div>${procedures.length?`<div class="knowledge-list"><b>Процедуры</b>${procedures.map(p=>`<span>${escape(typeof p==='string'?p:`${p.name}@${p.revision}`)}</span>`).join('')}</div>`:''}${rules.length?`<div class="knowledge-list"><b>Правила</b>${rules.map(r=>`<span>${escape(typeof r==='string'?r:r.name||display(r))}</span>`).join('')}</div>`:''}<div class="evidence-label">Снимок ${escape(k.stamp||'—')}</div></details>`;
  }
  function biologyDetails(c) {
    const lifespan=num(c.traits?.lifespan),age=num(c.age),mass=Math.max(.01,num(c.mass,1)),organs=organsOf(c);
    const upkeep=organs.reduce((sum,name)=>sum+(organInfo[name]?.cost||0),0),base=.08*mass;
    const life=lifespan>0?`<div class="life-cycle"><div><span>Возраст ${time(age)}</span><span>Срок жизни ${time(lifespan)}</span></div><span class="life-track"><i style="width:${Math.min(100,age/lifespan*100)}%"></i></span></div>`:`<div class="life-cycle"><span>Возраст ${time(age)}</span></div>`;
    const reserve=organs.includes('digestive_vacuole')||num(c.food_reserve)>0?`<div class="food-reserve"><span>Запас пищи <b>${num(c.food_reserve).toFixed(1)} / 40</b></span><span class="reserve-track"><i style="width:${Math.min(100,num(c.food_reserve)/40*100)}%"></i></span></div>`:'';
    const activity=[];
    if(c.alive!==false){
      if(c.photosynthesizing)activity.push(`Фотосинтез включён · получено ${num(c.photosynthesis_gained).toFixed(2)} энергии`);
      if(num(c.dash_until)>num(state.time))activity.push(`Рывок · ещё ${Math.ceil(num(c.dash_until)-num(state.time))} с`);
      else if(organs.includes('flagellum')&&num(c.dash_ready_at)>num(state.time))activity.push(`Рывок готов через ${Math.ceil(num(c.dash_ready_at)-num(state.time))} с`);
      if(num(c.scan_until)>num(state.time))activity.push(`Сканирование · ещё ${Math.ceil(num(c.scan_until)-num(state.time))} с`);
      else if(organs.includes('eyespot')&&num(c.scan_ready_at)>num(state.time))activity.push(`Сканирование готово через ${Math.ceil(num(c.scan_ready_at)-num(state.time))} с`);
    }
    const actualCapabilities=Array.isArray(c.capabilities)?c.capabilities:['move','eat','rest','contact','reproduce','wait',...Object.entries({flagellum:'dash',eyespot:'scan',jaws:'bite',chloroplast:'photosynthesize'}).filter(([organ])=>organs.includes(organ)).map(([,action])=>action)];
    return `${life}<div class="body-cost"><span>Масса <b>${mass.toFixed(2)}×</b></span><span>Поддержание тела <b>${(c.alive===false?0:base+upkeep).toFixed(3)}</b> энергии/с</span>${c.anatomy_revision!=null?`<span>Анатомия #${escape(c.anatomy_revision)}</span>`:''}</div>${reserve}${activity.length?`<div class="cell-activity">${activity.map(v=>`<span>${escape(v)}</span>`).join('')}</div>`:''}<div class="organ-list">${organs.length?organs.map(name=>{const organ=organInfo[name];return `<div class="organ-item"><i class="organ-mark ${escape(name)}" aria-hidden="true"></i><span><b>${escape(organ?.name||name)}</b><small>${escape(organ?.benefit||'Изменение организма')}${organ?` · ${organ.cost.toFixed(3)} энергии/с`:''}</small></span></div>`;}).join(''):'<span class="no-organs">Дополнительных органов пока нет</span>'}</div>${c.alive!==false&&actualCapabilities.length?`<div class="capability-line">Доступные действия: ${actualCapabilities.map(v=>escape(label(v))).join(', ')}</div>`:''}`;
  }
  function inspector() {
    const c=cells().find(c=>String(c.id)===String(selectedId));
    if(!c) { $('inspector').innerHTML=selectedId!=null?'<div class="empty-inspector"><h2>История продолжается</h2><p>Этой клетки больше нет в текущем мире. Выберите другую, чтобы продолжить наблюдение.</p></div>':emptyInspector;return; }
    $('selected-id').textContent=`#${c.id}`;
    const b=c.brain||{}, tr=c.traits||{},dead=c.alive===false;
    const allHistory=Array.isArray(c.history)?c.history:[],actions=allHistory.filter(h=>h?.action||h?.kind==='evolution');
    const history=(actions.length?actions:allHistory).slice(-3);
    const lessons=(state.events||[]).filter(e=>String(e.cell_id)===String(c.id)&&isLearning(e)).slice(-2);
    let flow=[...lessons,...history].sort((a,b)=>num(a.time)-num(b.time));
    if(!flow.length&&b.state)flow=[{kind:b.state,text:typeof b.reason==='string'?b.reason:label(b.state)}];
    const procedures=procedureNames(b.rule||b.procedure);
    const resultId=history.slice().reverse().find(h=>h.result_id)?.result_id||b.result_id;
    const details=b.knowledge||c.learned_rules||c.knowledge||null;
    const detailsOpen=$('inspector').querySelector('details')?.open;
    const background=learningFor(c)&&!dead;
    $('inspector').innerHTML=`<div class="cell-title"><div><h2>${escape(c.name||`Клетка ${c.id}`)}</h2><p>${escape(label(c.species))} <span>·</span> ${num(c.generation)+1}-е поколение <span>·</span> ${escape(label(c.sex||'—'))}</p></div><span class="species-dot ${escape(c.species)}"></span></div><div class="cell-intent${dead?' deceased':''}"><small>${dead?'ЖИЗНЬ ЗАВЕРШЕНА':c.goal?'ТЕКУЩАЯ ЦЕЛЬ':'СОСТОЯНИЕ'}</small>${escape(dead?deathText(c):label(c.goal||c.status||b.state||'Наблюдает за миром'))}${!dead&&b.reason&&typeof b.reason==='string'?`<span class="intent-reason">${escape(b.reason)}</span>`:''}${background?'<span class="background-lesson">Гханта учится в фоне. Клетка продолжает жить.</span>':''}</div>${meter('Энергия',c.energy)}${meter('Усталость',c.fatigue,true)}${biologyDetails(c)}<div class="trait-line">${Object.entries(tr).filter(([k])=>k!=='lifespan').slice(0,5).map(([k,v])=>`<span class="trait">${escape(traitNames[k]||k)} ${escape(typeof v==='number'?v.toFixed(1):v)}</span>`).join('')}</div><div class="section-heading"><h3>Как пришла к действию</h3><span class="small-badge ${b.source==='vajra'?'active':''}">${escape(label(b.source||b.state||'ожидание'))}</span></div><ol class="causal-flow">${flow.length?flow.map((h,i)=>`<li class="${i===flow.length-1?'current':''}"><strong>${h.action?`Ваджра → ${escape(label(h.outcome?.kind==='evolution'?'evolution':h.action.kind))}`:escape(label(h.kind||h.stage||h.source||h.state||'Событие'))}</strong><small>${escape(actionDescription(h))}</small></li>`).join(''):'<li><strong>Ожидает события</strong><small>История решений пока пуста.</small></li>'}</ol>${procedures.length?`<div class="evidence-label">Вызваны процедуры:<br>${procedures.map(escape).join('<br>')}</div>`:''}${resultId?`<div class="evidence-label">Результат: ${escape(resultId)}</div>`:''}<div class="kinship"><b>${num(c.knowledge_count)} правил</b> в личной сети${Array.isArray(c.parents)&&c.parents.length?`<br>Родители: ${c.parents.map(p=>escape(targetName(p))).join(' и ')}`:'<br>Основатель популяции'}${c.partner!=null?`<br>Связь: ${escape(targetName(c.partner))}`:''}</div>${knowledgeDetails(details,detailsOpen)}`;
  }
  function learningUI() {
    const l=state.learning||{};
    const active=Array.isArray(l.active)?l.active:[],pending=Array.isArray(l.pending)?l.pending.length:num(l.pending);
    const working=active.length>0||pending>0||(l.active===true);
    $('world-clock-status').textContent=state.running?`время мира · ${num(state.speed,1)}×`:'пауза';
    $('clock-notice').hidden=!working;
    $('clock-notice').textContent=state.running?'Гханта обучает в фоне. Движение, голод, старение и взаимодействия продолжаются.':'Мир поставлен на паузу. Начатые уроки Гханты продолжаются в фоне.';
    const stage=working?(l.state||'running'):(l.state||(l.status==='live'?'waiting':l.status)||'waiting');
    $('learning-state').textContent=label(stage);$('learning-state').classList.toggle('active',!['waiting','idle','complete','completed'].includes(stage));
    const recent=(state.events||[]).slice().reverse().find(e=>e.kind==='learning'||e.kind==='learning_error'||e.kind==='learned');
    $('learning-description').textContent=l.message||l.description||l.reason||(working&&recent?`${targetName(recent.cell_id)}: ${recent.text}`:'Если Ваджре не хватит знаний, Гханта получит событие и контекст клетки. Сохранённый способ будет выполняться повторно.');
    const rows=[];if(l.provider)rows.push(l.provider);if(l.cell_id!=null)rows.push(`Клетка ${targetName(l.cell_id)}`);if(l.goal)rows.push(label(l.goal));if(active.length)rows.push(`В обработке и очереди: ${active.map(targetName).join(', ')}`);else if(!working)rows.push('Активных уроков нет.');if(l.pending!=null)rows.push(`В очереди: ${pending}`);if(l.tests_passed!=null)rows.push(`Проверок пройдено: ${l.tests_passed}`);if(l.procedure)rows.push(l.procedure);
    if(state.metrics?.model_responses_completed!=null)rows.push(`Ответов модели: ${state.metrics.model_responses_completed}; неудачных попыток: ${state.metrics.model_failed_attempts||0}; локальных отказов: ${state.metrics.model_local_rejections||0}.`);
    $('learning-detail').innerHTML=rows.length?`<div class="evidence-label">${rows.map(escape).join('<br>')}</div>`:'';
    const archive=l.archive||l.global_archive||state.metrics?.global_archive,note=$('global-archive-note');
    note.hidden=!archive;
    if(archive){const parts=[];if(archive.archived_cells!=null)parts.push(`${display(archive.archived_cells)} клеток`);if(archive.rules!=null)parts.push(`${display(archive.rules)} правил`);if(archive.parameters!=null)parts.push(`${display(archive.parameters)} параметров`);const source=archive.last_source_cell;note.textContent=`Общая Ваджра: ${parts.length?parts.join(' · '):'архив обновляется'}${source!=null?` · источник ${typeof source==='object'?source.name||source.id||compact(source,45):source}`:''}${archive.last_error?` · ${compact(archive.last_error,120)}`:''}`;}

  }
  const isLearning=e=>/learn|ghanta|vajra|knowledge|rule|test|publish|fail|blocked|reuse|journal|repair/i.test(String(e.kind));
  function eventUI() {
    const events=(Array.isArray(state.events)?state.events:[]).slice().reverse().filter(e=>filter==='all'||(filter==='learning'?isLearning(e):!isLearning(e))).slice(0,24);
    $('event-list').innerHTML=events.length?events.map(e=>`<article class="event ${isLearning(e)?'learning':''}"><span class="event-time">${time(e.time)}</span><div class="event-text"><div class="event-kind">${escape(label(e.kind||'Событие'))}</div>${e.cell_id!=null?`<strong>${escape(current.get(String(e.cell_id))?.name||`Клетка #${e.cell_id}`)}</strong> · `:''}${escape(e.text||e.message||compact(e))}</div></article>`).join(''):'<p class="empty-note">В этой категории пока нет событий.</p>';
  }
  function resize() {const r=canvas.getBoundingClientRect();pixelRatio=Math.min(window.devicePixelRatio||1,2);canvasSize={w:r.width,h:r.height};canvas.width=Math.round(r.width*pixelRatio);canvas.height=Math.round(r.height*pixelRatio);cameraUI();}
  new ResizeObserver(resize).observe(canvas);
  function dimensions() {return {w:num(state?.width,1200),h:num(state?.height,800)};}
  function viewport() {const {w,h}=dimensions();return {x:camera.x,y:camera.y,w:w/camera.zoom,h:h/camera.zoom};}
  function clampCamera() {const {w,h}=dimensions();camera.x=Math.max(0,Math.min(w-w/camera.zoom,camera.x));camera.y=Math.max(0,Math.min(h-h/camera.zoom,camera.y));}
  function screenPoint(x,y) {const v=viewport();return {x:(x-v.x)/v.w*canvasSize.w,y:(y-v.y)/v.h*canvasSize.h};}
  function worldPoint(p) {const v=viewport(),{w,h}=dimensions();return {x:Math.max(0,Math.min(w,v.x+p.x/canvasSize.w*v.w)),y:Math.max(0,Math.min(h,v.y+p.y/canvasSize.h*v.h))};}
  function cameraUI() {if(!$('zoom-value'))return;$('zoom-value').textContent=`${Math.round(camera.zoom*100)}%`;$('zoom-out').disabled=camera.zoom<=1;$('zoom-in').disabled=camera.zoom>=12;const v=viewport(),scale=canvasSize.w/v.w,units=[10,25,50,100,250,500].filter(n=>n*scale<=80).at(-1)||10;$('scale-bar').style.width=`${units*scale}px`;$('scale-label').textContent=`${units} ед.`;}
  function zoomAt(value,p={x:canvasSize.w/2,y:canvasSize.h/2}) {const anchor=worldPoint(p),{w,h}=dimensions();camera.zoom=Math.max(1,Math.min(12,value));camera.x=anchor.x-p.x/canvasSize.w*w/camera.zoom;camera.y=anchor.y-p.y/canvasSize.h*h/camera.zoom;clampCamera();cameraUI();$('hover-label').hidden=true;}
  function radius(c) {const {w,h}=dimensions(),mass=Math.max(.25,num(c.mass,1));return Math.max(8.5*Math.sqrt(mass),num(c.radius,11)*Math.min(canvasSize.w/w,canvasSize.h/h))*camera.zoom;}
  function placement(mode) {feedMode=mode==='feed';spawnMode=mode==='spawn';panMode=mode==='pan';$('feed-btn').classList.toggle('active',feedMode);$('spawn-btn').classList.toggle('active',spawnMode);$('pan-btn').classList.toggle('active',panMode);$('spawn-btn').setAttribute('aria-pressed',String(spawnMode));$('pan-btn').setAttribute('aria-pressed',String(panMode));$('interaction-hint').textContent=feedMode?'Нажмите на полотно, чтобы добавить питание':spawnMode?'Нажмите в любом месте мира, чтобы создать клетку. Esc — закончить':panMode?'Перетаскивайте полотно. Колёсико или + / − меняют масштаб':'Нажмите на клетку, чтобы познакомиться';canvas.style.cursor=feedMode||spawnMode?'crosshair':panMode?'grab':'default';}

  function position(c) {const old=previous.get(String(c.id));if(!old)return screenPoint(c.x,c.y);const a=Math.min(1,(performance.now()-lastPoll)/interpolationMs);return screenPoint(num(old.x)+(num(c.x)-num(old.x))*a,num(old.y)+(num(c.y)-num(old.y))*a);}
  function organicPath(x,y,r,phase,predator=false) {ctx.beginPath();const n=56;for(let i=0;i<=n;i++){const a=i/n*Math.PI*2;const m=1+Math.sin(a*3+phase)*.055+Math.cos(a*5-phase*.65)*.035;const rr=r*m*(predator?1+.07*Math.sin(a*4):1);const px=x+Math.cos(a)*rr,py=y+Math.sin(a)*rr*.91;if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);}ctx.closePath();}
  function drawOrgans(c,p,r,t,layer) {
    const organs=organsOf(c),target=Array.isArray(c.target)?screenPoint(c.target[0],c.target[1]):null;
    const heading=target?Math.atan2(target.y-p.y,target.x-p.x):-.75;
    if(layer==='behind'&&organs.includes('flagellum')) {
      const a=heading+Math.PI,length=r*2.8;ctx.save();ctx.translate(p.x,p.y);ctx.rotate(a);
      ctx.beginPath();ctx.moveTo(r*.85,0);ctx.bezierCurveTo(r*1.5,Math.sin(t*(num(c.dash_until)>num(state.time)?8:4)+num(c.id))*r*.8,length*.8,-Math.sin(t*(num(c.dash_until)>num(state.time)?8:4)+num(c.id))*r*.7,length,Math.sin(t*3+num(c.id))*r*.45);
      ctx.strokeStyle=c.species==='predator'?'#9b745bad':'#658260ad';ctx.lineWidth=1.3;ctx.stroke();ctx.restore();
    }
    if(layer!=='inside')return;
    if(organs.includes('shell')) {organicPath(p.x,p.y,r+2.3,t*.2+num(c.id));ctx.strokeStyle='#8c936cae';ctx.lineWidth=2.1;ctx.stroke();organicPath(p.x,p.y,r+4.1,t*.2+num(c.id));ctx.strokeStyle='#c1c6a67a';ctx.lineWidth=.8;ctx.stroke();}
    if(organs.includes('eyespot')) {const x=p.x+Math.cos(heading)*r*.7,y=p.y+Math.sin(heading)*r*.64;ctx.beginPath();ctx.arc(x,y,Math.max(2.1,r*.19),0,Math.PI*2);ctx.fillStyle='#a57b57c9';ctx.fill();ctx.strokeStyle='#eef0d5bb';ctx.lineWidth=.7;ctx.stroke();ctx.beginPath();ctx.arc(x+.5,y-.4,Math.max(.8,r*.07),0,Math.PI*2);ctx.fillStyle='#6d624be0';ctx.fill();}
    if(organs.includes('digestive_vacuole')) {for(let i=0;i<2;i++){const a=2.2+i*1.4;ctx.beginPath();ctx.ellipse(p.x+Math.cos(a)*r*.55,p.y+Math.sin(a)*r*.45,r*.19,r*.15,a,0,Math.PI*2);ctx.fillStyle=i?'#c9b97d70':'#aac7926b';ctx.fill();ctx.strokeStyle='#8f9c687d';ctx.lineWidth=.65;ctx.stroke();}}
    if(organs.includes('chloroplast')) {for(let i=0;i<3;i++){const a=.45+i*1.9,x=p.x+Math.cos(a)*r*.58,y=p.y+Math.sin(a)*r*.48;ctx.beginPath();ctx.ellipse(x,y,Math.max(1.7,r*.2),Math.max(.9,r*.1),a+.7,0,Math.PI*2);ctx.fillStyle='#6e9b5eaa';ctx.fill();ctx.strokeStyle='#b7ce8b99';ctx.lineWidth=.6;ctx.stroke();ctx.beginPath();ctx.moveTo(x-r*.09,y);ctx.lineTo(x+r*.09,y);ctx.strokeStyle='#d7e8b199';ctx.lineWidth=.5;ctx.stroke();}}
    if(organs.includes('jaws')) {ctx.save();ctx.translate(p.x,p.y);ctx.rotate(heading);const biting=c.previous_outcome?.kind==='bite'&&num(state.time)-num(c.previous_outcome?.time)<.7,gap=biting?.5:.25;ctx.strokeStyle='#8c8064d0';ctx.lineWidth=1.6;for(const sign of [-1,1]){ctx.beginPath();ctx.moveTo(r*.7,sign*r*.42);ctx.quadraticCurveTo(r*1.5,sign*r*.63,r*1.5,sign*r*gap);ctx.lineTo(r*1.18,sign*r*(gap-.05));ctx.stroke();}ctx.restore();}

  }
  function drawEvolutionPill(f,t) {
    const p=screenPoint(f.x,f.y),pulse=(1+Math.sin(t*1.8+num(f.id))*.06)*camera.zoom;
    const halo=ctx.createRadialGradient(p.x,p.y,1,p.x,p.y,20*camera.zoom);halo.addColorStop(0,'#d2b46d30');halo.addColorStop(1,'#d2b46d00');ctx.fillStyle=halo;ctx.fillRect(p.x-20*camera.zoom,p.y-20*camera.zoom,40*camera.zoom,40*camera.zoom);
    ctx.save();ctx.translate(p.x,p.y);ctx.rotate(-.55);ctx.scale(pulse,pulse);
    ctx.beginPath();ctx.moveTo(-4,-3.8);ctx.lineTo(4,-3.8);ctx.arc(4,0,3.8,-Math.PI/2,Math.PI/2);ctx.lineTo(-4,3.8);ctx.arc(-4,0,3.8,Math.PI/2,Math.PI*1.5);ctx.closePath();
    ctx.save();ctx.clip();ctx.fillStyle='#d6b56fd9';ctx.fillRect(-8,-4,8,8);ctx.fillStyle='#8fa889e3';ctx.fillRect(0,-4,8,8);ctx.restore();ctx.strokeStyle='#9b9867b3';ctx.lineWidth=.8;ctx.stroke();ctx.beginPath();ctx.moveTo(0,-3.6);ctx.lineTo(0,3.6);ctx.strokeStyle='#f2efc9cc';ctx.lineWidth=.75;ctx.stroke();ctx.beginPath();ctx.moveTo(-4,-2.3);ctx.lineTo(-1.5,-2.3);ctx.strokeStyle='#fff5d2c9';ctx.lineWidth=1;ctx.stroke();ctx.restore();
    if(String(hoveredId)==='pill-'+f.id){ctx.font='9px "Avenir Next",sans-serif';ctx.textAlign='center';ctx.fillStyle='#7a7951';ctx.fillText('Таблетка эволюции',p.x,p.y+19);}
  }
  function drawCell(c,t) {
    const p=position(c),r=radius(c),coral=c.species==='predator';const id=String(c.id),selected=String(selectedId)===id,hovered=String(hoveredId)===id;
    const anatomyTime=c.alive===false?0:t,phase=anatomyTime*.3+num(c.id,Array.from(id).reduce((a,ch)=>a+ch.charCodeAt(0),0))*.7;const alpha=c.alive===false?.25:1;
    ctx.save();ctx.globalAlpha=alpha;
    if(c.alive!==false&&c.photosynthesizing){const gain=num(c.last_photosynthesis_gain)>0,shine=ctx.createRadialGradient(p.x,p.y,r*.5,p.x,p.y,r*2.5);shine.addColorStop(0,gain?'#e9ce7135':'#99bd6918');shine.addColorStop(1,'#d6c76800');ctx.fillStyle=shine;ctx.fillRect(p.x-r*2.5,p.y-r*2.5,r*5,r*5);}

    if(selected){const trail=trails.get(id)||[];if(trail.length>1){ctx.beginPath();trail.forEach((q,i)=>{const s=screenPoint(q.x,q.y);i?ctx.lineTo(s.x,s.y):ctx.moveTo(s.x,s.y);});ctx.strokeStyle='#647b6544';ctx.lineWidth=1;ctx.setLineDash([2,5]);ctx.stroke();ctx.setLineDash([]);}
      const sense=num(c.effective_sense,c.traits?.sense||0);if(sense>0){const {w,h}=dimensions();const sr=sense>10?sense*Math.min(canvasSize.w/w,canvasSize.h/h)*camera.zoom:r*(2+sense*.1);ctx.beginPath();ctx.arc(p.x,p.y,sr,0,Math.PI*2);ctx.fillStyle='#647b6505';ctx.fill();ctx.strokeStyle='#647b651c';ctx.setLineDash([2,6]);ctx.lineWidth=1;ctx.stroke();ctx.setLineDash([]);}
      ctx.beginPath();ctx.arc(p.x,p.y,r+8,0,Math.PI*2);ctx.strokeStyle='#4d6b5bb5';ctx.lineWidth=1;ctx.stroke();ctx.beginPath();ctx.arc(p.x,p.y,r+11,-.3,.3);ctx.strokeStyle='#4d6b5b';ctx.lineWidth=2;ctx.stroke();}
    drawOrgans(c,p,r,anatomyTime,'behind');
    ctx.strokeStyle=coral?'#c0917a50':'#81977550';ctx.lineWidth=.7;
    for(let i=0;i<6;i++){const a=i*Math.PI/3+phase*.07,rr=r*(1.07+.025*Math.sin(anatomyTime+i));ctx.beginPath();ctx.moveTo(p.x+Math.cos(a)*rr,p.y+Math.sin(a)*rr*.91);const end=r*(coral?1.55:1.35);ctx.quadraticCurveTo(p.x+Math.cos(a+.13)*end,p.y+Math.sin(a+.13)*end*.91,p.x+Math.cos(a+.04)*end,p.y+Math.sin(a+.04)*end*.91);ctx.stroke();}
    const gradient=ctx.createRadialGradient(p.x-r*.32,p.y-r*.4,r*.1,p.x,p.y,r*1.1);gradient.addColorStop(0,coral?'#f5dacaad':'#f0f2d8db');gradient.addColorStop(.62,coral?'#d7ab91a0':'#b8c5a29c');gradient.addColorStop(1,coral?'#c1977c80':'#91a77c99');organicPath(p.x,p.y,r,phase,coral);ctx.fillStyle=gradient;ctx.shadowBlur=10;ctx.shadowColor=coral?'#aa7c6017':'#71865b1a';ctx.fill();ctx.shadowBlur=0;ctx.strokeStyle=coral?'#aa785ba8':'#718a5fbc';ctx.lineWidth=hovered?1.6:1;ctx.stroke();
    organicPath(p.x,p.y,r-2,phase+.2,coral);ctx.strokeStyle=coral?'#efcbb855':'#e2e8cd88';ctx.lineWidth=.8;ctx.stroke();
    const nx=p.x+Math.cos(phase*.4)*r*.18,ny=p.y+Math.sin(phase*.35)*r*.15;const nr=r*(coral?.36:.33);organicPath(nx,ny,nr,phase+.6);const nucleus=ctx.createRadialGradient(nx-nr*.3,ny-nr*.4,1,nx,ny,nr);nucleus.addColorStop(0,coral?'#d2a28b9c':'#95ab7ca8');nucleus.addColorStop(1,coral?'#a277609e':'#6d8c5f8a');ctx.fillStyle=nucleus;ctx.fill();ctx.strokeStyle=coral?'#a77c6177':'#748e6066';ctx.lineWidth=.6;ctx.stroke();ctx.beginPath();ctx.arc(nx+nr*.2,ny-nr*.15,Math.max(1,nr*.2),0,Math.PI*2);ctx.fillStyle=coral?'#87644b77':'#5d7b4c88';ctx.fill();
    for(let i=0;i<4;i++){const a=i*2.1+phase*.15,dist=r*(.48+.1*Math.sin(i+phase));ctx.beginPath();ctx.ellipse(p.x+Math.cos(a)*dist,p.y+Math.sin(a)*dist,Math.max(1,r*.08),Math.max(1,r*.05),a,0,Math.PI*2);ctx.fillStyle=coral?'#ae7e5e50':'#81946560';ctx.fill();}
    drawOrgans(c,p,r,anatomyTime,'inside');
    if(c.alive!==false&&(learningFor(c)||['learning','queued','pending','running','testing'].includes(c.brain?.state))){ctx.beginPath();ctx.arc(p.x,p.y,r+4,t*1.2,t*1.2+Math.PI*.8);ctx.strokeStyle='#b69452bb';ctx.lineWidth=1.4;ctx.stroke();}
    if(selected||hovered){ctx.font='10px "Avenir Next", sans-serif';ctx.textAlign='center';ctx.fillStyle='#466047';ctx.fillText(c.name||`#${c.id}`,p.x,p.y+r+24);}
    ctx.restore();
  }
  function drawLightPatches() {
    if(!Array.isArray(state?.light_patches))return;
    const daylight=Math.max(0,Math.min(1,num(state.daylight))),scale=Math.min(canvasSize.w/num(state.width,1200),canvasSize.h/num(state.height,800))*camera.zoom;
    if(daylight<=0)return;
    for(const patch of state.light_patches){if(!Array.isArray(patch)||patch.length<3)continue;const p=screenPoint(patch[0],patch[1]),r=Math.max(1,num(patch[2])*scale*3),light=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,r);for(let i=0;i<=6;i++){const f=i/6,alpha=Math.exp(-.5*(f*3)**2)*daylight*.2;light.addColorStop(f,`rgba(249,224,147,${i===6?0:alpha})`);}ctx.fillStyle=light;ctx.fillRect(p.x-r,p.y-r,r*2,r*2);}
  }
  function draw() {
    frame=requestAnimationFrame(draw);const t=performance.now()/1000,w=canvasSize.w,h=canvasSize.h;ctx.setTransform(pixelRatio,0,0,pixelRatio,0,0);ctx.clearRect(0,0,w,h);
    const bg=ctx.createLinearGradient(0,0,w,h);bg.addColorStop(0,'#e9eddf');bg.addColorStop(.5,'#e2e8d6');bg.addColorStop(1,'#dfe5d3');ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);
    const glow=ctx.createRadialGradient(w*.4,h*.35,0,w*.5,h*.5,w*.65);glow.addColorStop(0,'#f7f7e72b');glow.addColorStop(1,'#8092670a');ctx.fillStyle=glow;ctx.fillRect(0,0,w,h);
    // Microscopy texture only; these marks carry no simulated state.
    for(let i=0;i<110;i++){const x=((Math.sin(i*123.73)*43758.54)%1+1)%1*w,y=((Math.sin(i*72.39)*19523.4)%1+1)%1*h;ctx.beginPath();ctx.arc(x,y,i%7===0?1.3:.65,0,Math.PI*2);ctx.fillStyle=i%3?'#82956b1b':'#a4af8429';ctx.fill();}
    if(!state)return;
    drawLightPatches();
    for(const f of state.foods||[]){if(num(f.amount,1)<=0)continue;if(f.kind==='evolution'){drawEvolutionPill(f,t);continue;}const p=screenPoint(f.x,f.y),count=Math.min(9,Math.max(3,Math.ceil(num(f.amount,5)/5)));const halo=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,15*camera.zoom);halo.addColorStop(0,'#9aa85c0f');halo.addColorStop(1,'#9aa85c00');ctx.fillStyle=halo;ctx.fillRect(p.x-15*camera.zoom,p.y-15*camera.zoom,30*camera.zoom,30*camera.zoom);for(let j=0;j<count;j++){const a=j*2.4+num(f.id),rr=Math.sqrt(j)*2.2*camera.zoom;ctx.beginPath();ctx.ellipse(p.x+Math.cos(a)*rr,p.y+Math.sin(a)*rr,1.7*camera.zoom,1.1*camera.zoom,a,0,Math.PI*2);ctx.fillStyle=['#8a9b61a6','#a5b177c9','#7f9463a6'][j%3];ctx.fill();}}
    const byId=new Map(cells().map(c=>[String(c.id),c]));
    for(const link of state.links||[]){const a=byId.get(String(link.from)),b=byId.get(String(link.to));if(!a||!b)continue;const p=position(a),q=position(b);ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.quadraticCurveTo((p.x+q.x)/2+8,(p.y+q.y)/2-15,q.x,q.y);ctx.strokeStyle=link.kind==='bond'?'#b48f783d':'#7b947042';ctx.lineWidth=link.kind==='bond'?1.2:.8;ctx.setLineDash(link.kind==='bond'?[]:[2,4]);ctx.stroke();ctx.setLineDash([]);}
    cells().filter(c=>String(c.id)!==String(selectedId)).forEach(c=>drawCell(c,t));const chosen=byId.get(String(selectedId));if(chosen)drawCell(chosen,t);
  }
  function pointer(e) {const r=canvas.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};}
  function nearest(p) {let hit=null,best=Infinity;for(const c of cells()){const q=position(c),d=Math.hypot(p.x-q.x,p.y-q.y);if(d<Math.max(radius(c)+9,18)&&d<best){hit=c;best=d;}}return hit;}
  canvas.addEventListener('pointerdown',e=>{ignoreClick=false;if(e.button===1||e.button===2||(e.button===0&&(panMode||(!feedMode&&!spawnMode)))){drag={id:e.pointerId,start:pointer(e),x:camera.x,y:camera.y,moved:false,button:e.button};canvas.setPointerCapture(e.pointerId);}});
  canvas.addEventListener('pointermove',e=>{const p=pointer(e);if(drag&&drag.id===e.pointerId){const dx=p.x-drag.start.x,dy=p.y-drag.start.y;if(Math.hypot(dx,dy)>4)drag.moved=true;if(drag.moved){const v=viewport();camera.x=drag.x-dx/canvasSize.w*v.w;camera.y=drag.y-dy/canvasSize.h*v.h;clampCamera();cameraUI();canvas.style.cursor='grabbing';$('hover-label').hidden=true;return;}}const hit=nearest(p);hoveredId=hit?.id??null;canvas.style.cursor=feedMode||spawnMode?'crosshair':panMode?'grab':hit?'pointer':'default';const tip=$('hover-label');if(hit&&!feedMode&&!spawnMode&&!panMode){tip.hidden=false;tip.textContent=`${hit.name||`Клетка #${hit.id}`} · ${hit.alive===false?deathText(hit):label(hit.goal||hit.status||hit.species)}`;tip.style.left=`${Math.max(8,Math.min(canvasSize.w-180,p.x+15))}px`;tip.style.top=`${Math.max(8,p.y-32)}px`;}else tip.hidden=true;});
  canvas.addEventListener('pointerup',e=>{if(drag?.id===e.pointerId){ignoreClick=drag.moved&&drag.button===0;drag=null;canvas.releasePointerCapture(e.pointerId);canvas.style.cursor=panMode?'grab':'default';}});
  canvas.addEventListener('pointercancel',()=>{drag=null;ignoreClick=false;});
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  canvas.addEventListener('wheel',e=>{e.preventDefault();if(!drag)zoomAt(camera.zoom*Math.exp(-e.deltaY*.0015),pointer(e));},{passive:false});
  canvas.addEventListener('pointerleave',()=>{hoveredId=null;$('hover-label').hidden=true;});
  canvas.addEventListener('click',async e=>{if(ignoreClick){ignoreClick=false;return;}const p=pointer(e);if(feedMode||spawnMode){const mode=spawnMode?'add_cell':'feed';try{const result=await control(mode,worldPoint(p));if(mode==='feed'){placement(null);$('interaction-hint').textContent='Еда добавлена. Наблюдайте за реакцией клеток.';}else{const id=result.cell_id??result.id;if(id!=null){selectedId=id;inspector();}$('interaction-hint').textContent='Клетка появилась. Нажмите ещё раз, чтобы добавить другую. Esc — закончить';}}catch{}return;}if(panMode)return;const hit=nearest(p);if(hit){selectedId=hit.id;inspector();$('interaction-hint').textContent=`${hit.name||`Клетка #${hit.id}`} — личное состояние и опыт справа`;}else{selectedId=null;$('selected-id').textContent='—';inspector();$('interaction-hint').textContent='Нажмите на клетку, чтобы познакомиться';}});
  $('pause-btn').addEventListener('click',()=>control(state?.running?'pause':'resume').catch(()=>{}));
  $('food-level').addEventListener('input',()=>{$('food-level-value').textContent=`${$('food-level').value}%`;});
  $('food-level').addEventListener('change',()=>control('food_level',{value:Number($('food-level').value)}).catch(()=>{}));
  $('step-btn').addEventListener('click',()=>control('step',{value:1}).catch(()=>{}));
  document.querySelectorAll('[data-speed]').forEach(b=>b.addEventListener('click',()=>control('speed',{value:num(b.dataset.speed,1)}).catch(()=>{})));
  $('feed-btn').addEventListener('click',()=>placement(feedMode?null:'feed'));
  $('spawn-btn').addEventListener('click',()=>placement(spawnMode?null:'spawn'));
  $('pan-btn').addEventListener('click',()=>placement(panMode?null:'pan'));
  $('zoom-in').addEventListener('click',()=>zoomAt(camera.zoom*1.5));
  $('zoom-out').addEventListener('click',()=>zoomAt(camera.zoom/1.5));
  $('zoom-fit').addEventListener('click',()=>{camera.zoom=1;camera.x=0;camera.y=0;cameraUI();});
  $('drought-btn').addEventListener('click',()=>control('drought').then(()=>toast('Условия мира изменились: засуха.')).catch(()=>{}));
  $('predator-btn').addEventListener('click',()=>control('predator').then(()=>toast('В мире появилась клетка коралловой линии.')).catch(()=>{}));
  document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>{const active=x===b;x.classList.toggle('active',active);x.setAttribute('aria-pressed',active);});if(state)eventUI();}));
  async function fullscreen(){if(document.fullscreenElement)await document.exitFullscreen();else await $('world-frame').requestFullscreen();}
  $('fullscreen-btn').addEventListener('click',()=>fullscreen().catch(()=>toast('Полноэкранный режим недоступен',true)));
  document.addEventListener('keydown',e=>{if(document.querySelector('dialog[open]'))return;if(e.key.toLowerCase()==='f'&&!e.ctrlKey&&!e.metaKey&&!['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)){e.preventDefault();fullscreen().catch(()=>{});}if(e.key==='Escape'){if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});if(feedMode||spawnMode||panMode)placement(null);}});
  window.render_game_to_text=()=>JSON.stringify({coordinate_system:'origin top-left; x right; y down; world units',connected,width:state?.width,height:state?.height,time:state?.time,running:state?.running,speed:state?.speed,food_level:state?.food_level,camera:{...camera,view:viewport()},spawn_mode:spawnMode,pan_mode:panMode,daylight:state?.daylight,light_patches:state?.light_patches,selected:selectedId,feed_mode:feedMode,cells:cells().map(c=>({id:c.id,name:c.name,species:c.species,x:c.x,y:c.y,alive:c.alive,age:c.age,lifespan:c.traits?.lifespan,mass:c.mass,organs:c.organs||[],aggression:c.traits?.aggression,anatomy_revision:c.anatomy_revision,photosynthesizing:c.photosynthesizing,food_reserve:c.food_reserve,dash_until:c.dash_until,dash_ready_at:c.dash_ready_at,scan_until:c.scan_until,scan_ready_at:c.scan_ready_at,last_photosynthesis_gain:c.last_photosynthesis_gain,photosynthesis_gained:c.photosynthesis_gained,capabilities:c.capabilities,death_cause:c.death_cause,target:c.target,energy:c.energy,fatigue:c.fatigue,generation:c.generation,goal:c.goal,status:c.status,knowledge_count:c.knowledge_count,brain:c.brain,parents:c.parents})),foods:(state?.foods||[]).map(f=>({id:f.id,x:f.x,y:f.y,amount:f.amount,kind:f.kind||'food'})),metrics:state?.metrics,learning:state?.learning,events:(state?.events||[]).slice(-6)});
  window.cellariumNotify=toast;
  window.addEventListener('cellarium-imported',()=>{selectedId=null;hoveredId=null;trails.clear();previous.clear();current.clear();camera.zoom=1;camera.x=0;camera.y=0;placement(null);cameraUI();refresh();});
  window.advanceTime=async ms=>{await control('step',{value:Math.max(0,num(ms))/1000});};
  window.addEventListener('beforeunload',()=>cancelAnimationFrame(frame));
  resize();draw();refresh();setInterval(refresh,500);
})();
