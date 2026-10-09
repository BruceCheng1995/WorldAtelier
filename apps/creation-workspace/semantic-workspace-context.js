/** Pure UI adapters. Stable addresses and immutable revisions are never inferred from names. */
export function leadingSemanticMode(text) {
  const match=/^\s*\/(plan|goal)(?:\s+|$)/.exec(String(text));
  return match?{mode:match[1],text:String(text).slice(match[0].length)}:null;
}
export function nextSemanticSelection(previous, id, order, { toggle = false, range = false } = {}) {
  const valid = new Set(order), ids = new Set((previous.ids ?? []).filter(value => valid.has(value)));
  if (!id || !valid.has(id)) return { ids: [], primary: null, anchor: null };
  if (range && valid.has(previous.anchor)) {
    const start = order.indexOf(previous.anchor), end = order.indexOf(id);
    if (!toggle) ids.clear();
    for (const value of order.slice(Math.min(start, end), Math.max(start, end) + 1)) ids.add(value);
  } else if (toggle) { if (ids.has(id)) ids.delete(id); else ids.add(id); }
  else { ids.clear(); ids.add(id); }
  const selected=[...ids].slice(-128);
  return { ids: selected, primary: selected.includes(id) ? id : selected.at(-1) ?? null, anchor: range ? previous.anchor ?? id : id };
}

export function semanticMutationBody(action, model, extra, transactionId) {
  if (!model?.revision || !model?.target || !model?.resource) throw new Error('缺少固定版本的设计上下文');
  const target = model.target;
  const definition = action === 'update_design';
  if (definition && target.is_instance) throw new Error('请先打开来源预制件，再修改功能描述');
  const resourceId = definition ? model.resource.id : target.resource_id;
  const version = definition ? model.resource.version : target.expected_version;
  if (!resourceId || !version) throw new Error('缺少对象或定义版本，请刷新后重试');
  return { ...structuredClone(extra), action, transaction_id: transactionId, base_revision: model.revision,
    resource_id: resourceId, expected_version: version,
    ...(!definition && target.address ? { address: structuredClone(target.address) } : !definition && target.object_id ? { object_id: target.object_id } : {}),
  };
}

export function semanticAttachmentLabel(attachment) {
  return attachment?.name || attachment?.snapshot?.name || attachment?.snapshot?.title || attachment?.address?.definition_node_id || attachment?.object_id || '空间批注';
}
export function semanticAttachmentSummary(attachment) {
  if (attachment?.kind === 'knowledge') return '共享知识 · 固定版本';
  if (attachment?.kind === 'prefab') return `${attachment?.design?.category === 'system' || attachment?.snapshot?.design?.category === 'system' ? '游戏系统' : '预制件定义'} · ${attachment.role === 'target' ? '修改目标' : '参考内容'}`;
  return null;
}
