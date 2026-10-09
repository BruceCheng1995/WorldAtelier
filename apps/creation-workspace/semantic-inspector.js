/** Semantic object / system inspector. Engine fields and persistence stay with the host. */
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const clone = value => value == null ? value : structuredClone(value);

export function semanticInspectorModel(detail = {}) {
  const resource = detail.resource ?? {};
  const design = detail.design ?? resource.design ?? {};
  const target = detail.target ?? {};
  const category = design.category ?? detail.category;
  const kind = detail.kind ?? (category === 'system' ? 'system' : target.is_instance ? 'instance' : resource.kind === 'prefab' ? 'prefab' : 'object');
  const declared = design.exposed_properties ?? [];
  const supplied = detail.properties ?? [];
  const properties = [...declared.map(property => ({ ...property, ...supplied.find(value => value.id === property.id) })), ...(detail.includeSuppliedProperties ? supplied.filter(property => !declared.some(value => value.id === property.id)) : [])];
  return { ...detail, resource, design, target, kind, properties,
    resource_id: detail.resource_id ?? target.resource_id ?? resource.id,
    name: detail.name ?? resource.name ?? '游戏对象',
    description: detail.description ?? design.description ?? '',
    editable: Boolean(detail.editable),
    scopeLabel: detail.scopeLabel ?? (kind === 'system' ? '整个游戏的系统规则' : kind === 'prefab' ? '这个预制件的定义与默认属性' : target.is_instance ? '仅当前场景中的这个对象' : '当前对象'),
    sourceDefinition: detail.sourceDefinition ?? (target.is_instance && target.definition_resource_id ? { id: target.definition_resource_id, version: target.definition_version, name: resource.name ?? '来源预制件' } : null),
  };
}

export function propertyValue(property) {
  if (own(property, 'value')) return property.value;
  if (own(property, 'inherited_value')) return property.inherited_value;
  return property.default;
}

export function coerceSemanticProperty(property, raw) {
  if (property.type === 'boolean') {
    if (typeof raw !== 'boolean') throw new TypeError('请选择开启或关闭');
    return raw;
  }
  if (property.type === 'number' || property.type === 'integer') {
    if (typeof raw === 'string' && !raw.trim()) throw new TypeError('请输入数值');
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new TypeError('请输入有效数值');
    if (property.type === 'integer' && !Number.isInteger(value)) throw new TypeError('请输入整数');
    if (property.min != null && value < property.min) throw new RangeError(`不能小于 ${property.min}`);
    if (property.max != null && value > property.max) throw new RangeError(`不能大于 ${property.max}`);
    return value;
  }
  if (property.type === 'enum') {
    const choices = (property.options ?? []).map(option => typeof option === 'object' && option !== null ? option.value : option);
    const value = choices.find(option => String(option) === String(raw));
    if (!choices.some(option => String(option) === String(raw))) throw new TypeError('请选择已提供的选项');
    return value;
  }
  const value = String(raw);
  if (property.type === 'color' && !/^#[0-9a-f]{6}$/i.test(value)) throw new TypeError('请选择有效颜色');
  if (!['string', 'color'].includes(property.type)) throw new TypeError('这个属性暂不支持直接调整');
  return value;
}

const format = value => value == null ? '未设置' : value === true ? '开启' : value === false ? '关闭' : String(value);
const typeLabel = property => ({ number: '数值', integer: '整数', boolean: '开关', string: '文字', color: '颜色', enum: '选项' })[property.type] ?? '属性';

/** Shared property row for exposed values, local vectors and hierarchy forms.
 * Hosts own commit timing, version guards and undo; controls own presentation only.
 */
export function createParameterControl(document, property, value, {disabled = false} = {}) {
  const make = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
  const row = make('div', 'semantic-property');
  const label = make('div', 'semantic-property-label');
  const caption = make('span', 'semantic-property-name');
  caption.append(make('span', 'semantic-property-title', property.name || property.id));
  const editor = make('span', 'semantic-property-editor');
  const inputs = [], vector = /^vector[234]$/.test(property.type);
  row.dataset.controlType = property.type;
  function field(spec, current, aria) {
    const input = make(spec.type === 'enum' ? 'select' : 'input');
    if (spec.type === 'enum') {
      for (const choice of spec.options ?? []) {
        const object = choice !== null && typeof choice === 'object';
        const option = make('option', '', object ? choice.label ?? choice.name ?? choice.value : choice);
        option.value = String(object ? choice.value : choice); input.append(option);
      }
    } else input.type = {number:'number',integer:'number',boolean:'checkbox',color:'color'}[spec.type] ?? 'text';
    if (spec.type === 'boolean') { input.checked = current === true; if (input.checked) input.setAttribute('checked', ''); }
    else { input.value = current == null ? '' : String(current); if (input.tagName === 'INPUT') input.setAttribute('value', input.value); }
    for (const key of ['min','max','step']) if (spec[key] != null) input.setAttribute(key, String(spec[key]));
    if (['number','integer'].includes(spec.type)) { input.required = true; if (spec.step == null) input.step = spec.type === 'integer' ? '1' : 'any'; }
    input.disabled = disabled; input.setAttribute('aria-label', aria); inputs.push(input); return input;
  }
  if (vector) {
    editor.classList.add('semantic-vector');
    const axes = (property.axisLabels ?? ['X','Y','Z','W']).slice(0, Number(property.type.slice(-1)));
    for (const [index, axis] of axes.entries()) {
      const cell = make('label', 'semantic-vector-axis axis-' + ['x','y','z','w'][index]);
      cell.append(make('span', '', axis));
      const input = field({...property,type:'number'}, value?.[index], `${axis} ${property.name || property.id}`);
      if (property.transform) { input.dataset.transform = property.transform; input.dataset.axis = String(index); }
      cell.append(input); editor.append(cell);
    }
  } else editor.append(field(property, value, property.name || property.id));
  let colorText;
  if (property.type === 'color') {
    colorText = field({type:'string'}, value, `${property.name || property.id}十六进制颜色`);
    colorText.className = 'semantic-color-text'; colorText.maxLength = 7; editor.append(colorText);
  }
  if (property.unit) caption.append(make('small', 'semantic-property-unit', property.unit));
  caption.title = [property.name || property.id, property.description].filter(Boolean).join(' · ');
  label.append(caption, editor); row.append(label);
  const reset = make('button', 'semantic-button semantic-property-reset', '↶'); reset.type = 'button';
  reset.disabled = true; reset.setAttribute('aria-label', `恢复${property.name || property.id}默认值`); row.append(reset);
  return {row, input:inputs[0], inputs, editor, reset, colorText};
}

/** A single heading switches to a local draft; no save on each keystroke. */
export function createInspectorName(document, {name, kind, editable, onRename, onError}) {
  const heading = document.createElement('div'); heading.className = 'semantic-object-heading';
  const title = document.createElement('button'); title.type = 'button'; title.className = 'inspector-name';
  title.textContent = name; title.title = editable ? '双击重命名 · Enter 或 F2 编辑' : name;
  title.setAttribute('aria-label', `对象名称：${name}`); title.disabled = !editable;
  const input = document.createElement('input'); input.className = 'inspector-name-input'; input.hidden = true;
  input.value = name; input.maxLength = 160; input.setAttribute('aria-label', '对象名称');
  const badge = document.createElement('span'); badge.className = 'semantic-kind'; badge.textContent = kind;
  const status = document.createElement('span'); status.className = 'inspector-name-status'; status.setAttribute('role','status'); status.hidden = true;
  let editing = false, busy = false;
  const begin = () => { if (!editable || busy) return; editing = true; title.hidden = true; input.hidden = false; input.focus(); input.select(); };
  const cancel = () => { editing = false; input.value = name; input.hidden = true; title.hidden = false; input.setCustomValidity(''); status.hidden = true; };
  async function save() {
    if (!editing || busy) return;
    const next = input.value.trim();
    if (!next) { input.setCustomValidity('请输入名称'); input.reportValidity(); return; }
    if (next === name) { cancel(); return; }
    busy = true; input.disabled = true;
    try { await onRename(next); name = next; title.textContent = next; title.setAttribute('aria-label', `对象名称：${next}`); cancel(); }
    catch (error) { status.hidden = false; status.textContent = error.message || '名称保存失败'; onError?.(error); }
    finally { busy = false; input.disabled = false; }
  }
  title.ondblclick = begin;
  title.onkeydown = event => { if (['Enter','F2'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); begin(); } };
  input.oninput = () => input.setCustomValidity(''); input.onblur = save;
  input.onkeydown = event => { if (event.isComposing || !['Enter','Escape'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); if (event.key === 'Escape' && !busy) { cancel(); title.focus(); } else if (event.key === 'Enter') save(); };
  const glyph=document.createElement('span');glyph.className='inspector-object-icon';glyph.setAttribute('aria-hidden','true');
  const iconName=kind==='预制件实例'?'instance':kind==='预制件'?'component':kind==='空间锚点'?'pin':'cube';
  glyph.innerHTML=`<svg class="icon"><use href="#i-${iconName}"></use></svg>`;heading.dataset.objectKind=iconName;
  heading.append(glyph,title,input,badge,status); return heading;
}

/**
 * render accepts GET semantic-resources detail plus editable / name / scopeLabel / readOnlyReason.
 * Callbacks receive captured model identity; the host must preserve revision / expected_version guards.
 * onSaveDescription(description, model), onParameterChange(property, value, model),
 * onRestoreDefault(property, model), onOpenDefinition(source, model),
 * onRequestAgent({kind:'develop'|'expose-property',text,resource_id,target}, model).
 * The root owns only semantic controls; independent preview and spatial / appearance controls stay outside it.
 */
export function createSemanticInspector({ root, callbacks = {} } = {}) {
  if (!root) throw new TypeError('设计检查器需要挂载容器');
  const document = root.ownerDocument;
  const make = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
  let generation = 0, currentModel = null, disposed = false;
  const drafts = new Map(), expanded = new Map();
  function modelKey(model) { return JSON.stringify([model.project_id, model.branch_id, model.resource_id, model.target.object_id, model.target.address, model.target.is_instance]); }
  function action(label, handler, disabled = false, className = '') {
    const button = make('button', `semantic-button ${className}`.trim(), label); button.type = 'button'; button.disabled = disabled; button.onclick = handler; return button;
  }
  function render(input = {}) {
    const model = semanticInspectorModel(input), current = ++generation, key = modelKey(model);
    currentModel = model; disposed = false; root.classList.add('semantic-inspector'); root.replaceChildren();
    const isDefinition = !model.target.is_instance && ['prefab', 'system'].includes(model.kind);
    const canWrite = model.editable && !model.readOnlyReason;
    const isInstance = Boolean(model.target.is_instance);
    root.dataset.instance = String(isInstance);
    const visibleProperties = isInstance ? model.properties.filter(property => property.instance_editable !== false && property.editable === true && property.binding_valid === true) : model.properties;
    if (model.readOnlyReason) root.append(make('p', 'semantic-readonly', model.readOnlyReason));

    const feedback = make('p', 'semantic-feedback'); feedback.setAttribute('role', 'status'); feedback.hidden = true;
    const section = (title, caption) => { const part = make('section', 'semantic-section'); part.append(make('h3', '', title)); if (caption) part.title = caption; root.append(part); return part; };
    const requests = make('details', 'semantic-quick-actions');
    const aiSummary = make('summary'); aiSummary.setAttribute('aria-label', 'AI 修改对象'); aiSummary.title = '通过 Agent 修改';
    aiSummary.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-robot"></use></svg>';
    const aiActions = make('div', 'semantic-ai-menu'); requests.append(aiSummary, aiActions);
    aiActions.append(action('修改功能', event => request('develop', event.currentTarget), !canWrite || !callbacks.onRequestAgent));
    if (!model.aiPropertiesAvailable) aiActions.append(action('控制属性需求', event => request('expose-property', event.currentTarget), !canWrite || !callbacks.onRequestAgent));
    for (const button of aiActions.children) button.title = '在新的 Agent 会话中描述需求';
    root.append(requests);
    const scope = make('div', 'semantic-scope-line'); scope.title = model.scopeLabel; scope.append(make('span', 'semantic-scope', model.scopeLabel)); root.append(scope);
    if (model.sourceDefinition) {
      const source = make('div', 'semantic-instance-source');
      source.append(make('span', '', model.sourceDefinition.name));
      const jump = action('打开预制件', event => run(event.currentTarget, () => callbacks.onOpenDefinition(clone(model.sourceDefinition), clone(model)), ''), !callbacks.onOpenDefinition, 'semantic-open-definition');
      jump.title = `打开 ${model.sourceDefinition.name} 的定义${model.sourceDefinition.version ? ' · 当前实例来源版本 ' + model.sourceDefinition.version.slice(0, 8) : ''}`;
      source.append(jump); root.append(source);
    }

    const parameters = make('details', 'semantic-section semantic-parameters'); parameters.open = expanded.get(key) ?? true;
    const summary = make('summary', '', '可调属性'); summary.append(make('small', '', String(visibleProperties.length))); parameters.append(summary);
    if (model.aiPropertiesAvailable && !isInstance) {
      const add = action('AI 添加属性', event => { event.preventDefault(); event.stopPropagation(); return request('expose-property', event.currentTarget); }, !canWrite || !callbacks.onRequestAgent, 'semantic-ai-add');
      add.title = `为「${model.resource.name}」的预制件定义增加可调属性`;
      summary.append(add);
    }
    parameters.ontoggle = () => { if (generation === current) expanded.set(key, parameters.open); }; root.append(parameters);
    if (!visibleProperties.length) parameters.append(make('p', 'semantic-empty', isInstance ? '此预制件暂无可调整的实例参数。' : '还没有公开的可调属性。可以告诉 Agent 你希望调整什么。'));
    const metadata = make('details', 'semantic-metadata'); metadata.append(make('summary', '', '其他属性'));
    for (const property of visibleProperties) {
      const value = propertyValue(property);
      const writable = canWrite && property.editable === true && property.binding_valid === true && (isDefinition || property.instance_editable !== false) && Boolean(callbacks.onParameterChange);
      const {row, input, colorText, reset} = createParameterControl(document, property, value, {disabled: !writable});
      row.dataset.propertyId = property.id;
      const source = isDefinition ? `初始重置值：${format(property.default)}` : property.overridden ? `已单独调整 · 默认 ${format(property.inherited_value ?? property.default)}` : '使用默认值';
      const facts = [property.description, typeLabel(property), property.min != null || property.max != null ? `范围 ${property.min ?? '不限'} 至 ${property.max ?? '不限'}` : null, property.step != null ? `步长 ${property.step}` : null, source,
        property.instance_editable === false ? '由来源定义统一设置' : null, property.binding_valid !== true ? '此属性尚未连接到游戏行为，可让 Agent 完成。' : null];
      const help = make('span', 'semantic-property-tooltip', facts.filter(Boolean).join(' · ')); help.id = `semantic-help-${current}-${model.properties.indexOf(property)}`; help.setAttribute('role', 'tooltip');
      input.setAttribute('aria-describedby', help.id); colorText?.setAttribute('aria-describedby', help.id); row.append(help);
      if (property.binding_valid !== true) row.dataset.unavailable = 'true';
      if (property.overridden) row.dataset.overridden = 'true';
      reset.disabled = !writable || !callbacks.onRestoreDefault || (!isDefinition && !property.overridden);
      reset.onclick = event => run(event.currentTarget, () => callbacks.onRestoreDefault(clone(property), clone(model)), '已恢复默认值');
      reset.title = source;
      input.onchange = async () => {
        input.setCustomValidity('');
        let next;
        try { next = coerceSemanticProperty(property, property.type === 'boolean' ? input.checked : input.value); }
        catch (error) { input.setCustomValidity(error.message); input.reportValidity(); return; }
        await run(input, () => callbacks.onParameterChange(clone(property), next, clone(model)), '属性已保存。');
      };
      input.oninput = () => { input.setCustomValidity(''); if (colorText) colorText.value = input.value.toUpperCase(); };
      if (colorText) { colorText.oninput = () => colorText.setCustomValidity(''); colorText.onchange = async () => { try { const next = coerceSemanticProperty(property, colorText.value); input.value = next; await run(colorText, () => callbacks.onParameterChange(clone(property), next, clone(model)), '属性已保存。'); } catch (error) { colorText.setCustomValidity(error.message); colorText.reportValidity(); } }; }
      if (/^author_/.test(property.name || property.id)) metadata.append(row); else parameters.append(row);
    }
    if (metadata.children.length > 1) parameters.append(metadata);
    if (!isInstance && Array.isArray(model.design.relations) && model.design.relations.length) {
      const related = section('相关设计');
      for (const relation of model.design.relations) {
        const relationName = relation.name ?? relation.title ?? relation.resource_id;
        related.append(action(relation.description || relationName, () => callbacks.onOpenDefinition?.({ id: relation.resource_id, name: relationName }, clone(model)), !callbacks.onOpenDefinition, 'semantic-link'));
      }
    }
    const descriptionPart = make('details', 'semantic-section semantic-description-section');
    descriptionPart.title = isDefinition ? '描述它在游戏中负责什么，以及应当怎样工作。' : '了解这个对象的功能；需要改变行为时，向 Agent 描述目标。';
    const descriptionToggle=make('summary', '', '功能描述');descriptionToggle.title=model.description.slice(0,500)||'展开查看功能描述';descriptionPart.append(descriptionToggle);
    descriptionPart.open = expanded.get(key + ':description') ?? drafts.has(key);
    descriptionPart.ontoggle = () => { if (generation === current) expanded.set(key + ':description', descriptionPart.open); };
    root.append(descriptionPart);
    let description = null;
    if (isDefinition && canWrite && model.descriptionEditable !== false) {
      description = make('textarea', 'semantic-description'); description.rows = 3; description.maxLength = 20000;
      description.setAttribute('aria-label', `${model.name}的功能描述`); description.placeholder = '用语言描述功能、规则与期望效果…';
      const priorDraft = drafts.get(key);
      if (priorDraft && priorDraft.base !== model.description) descriptionPart.append(make('p', 'semantic-readonly', '功能描述已更新；这里保留了你的未保存内容，请核对后保存。'));
      description.value = priorDraft?.value ?? model.description;
      const save = action('保存描述', async () => {
        const value = description.value.trim();
        await run(save, async () => { await callbacks.onSaveDescription(value, clone(model)); drafts.delete(key); }, '描述已保存。需要开发时，可继续告诉 Agent。');
      }, !callbacks.onSaveDescription, 'semantic-button-primary');
      description.oninput = () => { if (description.value === model.description) drafts.delete(key); else drafts.set(key, { value: description.value, base: model.description }); save.disabled = !callbacks.onSaveDescription || description.value.trim() === model.description; };
      save.disabled ||= description.value.trim() === model.description;
      descriptionPart.append(description, save);
    } else descriptionPart.append(make('p', 'semantic-description-read', model.description || '还没有功能描述。可让 Agent 整理这个对象的设计。'));
    descriptionPart.classList.add('semantic-description-section');
    root.append(feedback);
    async function request(kind, button) {
      const text = kind === 'expose-property' ? `我希望为「${model.name}」增加可调属性：` : `我想调整「${model.name}」的功能：`;
      const captured = clone(model);
      if (description) captured.draftDescription = description.value;
      await run(button, () => callbacks.onRequestAgent({ kind, text, resource_id: model.resource_id, target: clone(model.target) }, captured), '');
    }
    function showError(error) {
      callbacks.onError?.(error);
      if (disposed || generation !== current) return;
      feedback.hidden = false; feedback.dataset.state = 'error'; feedback.textContent = error.message || '保存失败，输入已保留。';
    }
    async function run(control, job, success) {
      const disabled = control.disabled; control.disabled = true; control.setAttribute('aria-busy', 'true');
      try {
        await job();
        if (!disposed && generation === current && success) { feedback.hidden = false; feedback.dataset.state = 'saved'; feedback.textContent = success; }
      } catch (error) { showError(error); }
      finally { if (!disposed && generation === current) { control.disabled = disabled; control.removeAttribute('aria-busy'); } }
    }
    return model;
  }
  return { render, get model() { return currentModel; }, destroy() { disposed = true; generation++; drafts.clear(); expanded.clear(); currentModel = null; root.replaceChildren(); root.classList.remove('semantic-inspector'); } };
}
