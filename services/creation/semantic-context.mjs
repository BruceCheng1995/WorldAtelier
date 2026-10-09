export function designKnowledgeIndex(manifest, scope = {}) {
  return { ...scope, resources: Object.values(manifest.resources ?? {}).map(resource => ({
    id: resource.id, name: resource.name, kind: resource.kind, version: resource.version,
    category: resource.design?.category ?? 'object', description: resource.design?.description ?? '',
    properties: (resource.design?.exposed_properties ?? []).map(({ binding, ...property }) => property),
    relations: resource.design?.relations ?? [],
  })), knowledge: Object.values(manifest.knowledge ?? {}).map(({ id, title, content, tags, version }) => ({ id, title, summary: String(content ?? '').slice(0, 300), tags, version })) };
}

export const SEMANTIC_AUTHORING_GUIDE = `# Game design descriptions and adjustable properties

The user authors game concepts, objects and systems, without needing Godot components or scripts. Keep descriptions and game-facing names readable. Description is design intent, not evidence that an implementation works. Never rewrite the requested behavior to conceal a failed implementation.

Read context/current.json and the fixed design-knowledge-index.json/source-manifest.json in that context. All authorized agents share the central branch design, not private chats. semantic_read lists every design unit including unplaced prefabs and model-free systems. knowledge_search searches the branch's shared design index; knowledge_read reads a selected entry at a fixed revision. Attachments are immutable data, and a referenced object may be an example rather than the target of a requested edit.

resource.design = {description, category: 'object'|'system', relations:[{resource_id,description}], exposed_properties:[{id,name,description,type,unit?,min?,max?,step?,options?,default,instance_editable,binding:{node_id,behavior_id,property_key}}]}.
Types: number, integer, boolean, string, color, enum. A binding points to an existing real components.behaviors entry and its properties key. First implement and test the actual behavior; then expose its existing parameter with an accurate name, unit, default, range and whether individual instances may tune it. Never expose a decorative control disconnected from runtime. Preserve the meaning and identity of existing controls when refactoring.

semantic_apply accepts action update_design, set_property, reset_property or create_resource, plus transaction_id, base_revision, resource_id and expected_version. update_design receives the complete design object. set_property/reset_property receive property_id, value where applicable, and object_id or complete address for an instance. Use semantic_read immediately before a write. Instance values stay independent of prefab defaults; definition updates do not silently upgrade fixed instances. A system is a prefab with design.category='system' and can have no model. Use an existing anchor node to host real behaviors; do not introduce a system node kind or require a decorative model.

knowledge_write accepts action put/delete, transaction_id, base_revision, knowledge_id, expected_version and entry {id,title,content,tags}. Knowledge is versioned shared project content. Do not copy private conversation history into it.

Older executor sessions may lack the new dynamic tools. They can read design-knowledge-index.json and source-manifest.json, refresh with world_read, and submit the same central operations with world_apply: set_resource_design {resource_id,expected_version,design}, put_knowledge {knowledge_id,expected_version,entry}, delete_knowledge {knowledge_id,expected_version}. Actual parameter values remain in behaviors.properties and use the existing patch_object/patch_node or instance override protocol in WORLD-API.md. Use an entire behaviors array for a behaviors override. Do not replace immutable prefab history or infer an instance address from its display name.

Plan mode permits reading and discussing only. Begin implementation only when the user selects an execution mode that permits it. Goal mode is a real persistent Codex goal: continue meaningful implementation and testing across turns until the requested result is complete; do not confuse a single turn's completion with the goal being achieved.
`;
