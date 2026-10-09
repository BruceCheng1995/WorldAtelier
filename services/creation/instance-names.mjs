import {name} from './schema.mjs';

// Allocation is performed against the current source document inside its
// synchronous transaction, including instances added earlier in the same batch.
export function numberedInstanceName(base,existingNames) {
  const label=name(base),used=new Set(existingNames.filter(value=>typeof value==='string').map(value=>value.trim()));
  let highest=0n;
  for(const existing of used){
    const match=/^(.*) ([1-9][0-9]*)$/.exec(existing);if(!match)continue;
    const serial=BigInt(match[2]),suffix=` ${serial}`;
    if(match[1]===label.slice(0,160-suffix.length).trimEnd()&&serial>highest)highest=serial;
  }
  for(let serial=highest+1n;;serial++){
    const suffix=` ${serial}`,candidate=label.slice(0,160-suffix.length).trimEnd()+suffix;
    if(!used.has(candidate))return candidate;
  }
}

export function flatPrefabInstanceName(value,prefab,objects) {
  // Inverses retain the complete previously saved object and its version.
  if(value.version!==undefined||!prefab||prefab.kind!=='prefab')return value.name;
  const source=typeof value.prefab_node_id==='string'?prefab.objects.find(node=>node.id===value.prefab_node_id):null;
  const requested=value.name===undefined?undefined:name(value.name);
  const copied=source??prefab.objects.find(node=>node.name===requested);
  const base=copied?.name??prefab.name;
  if(requested!==undefined&&requested!==base)return requested;
  return numberedInstanceName(base,objects.map(object=>object.name));
}
