import {hash} from './schema.mjs';

const freeze=value=>{
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value))freeze(child);
    Object.freeze(value);
  }
  return value;
};
const trim=(map,limit)=>{while(map.size>limit)map.delete(map.keys().next().value);};
const touch=(map,key,value)=>{map.delete(key);map.set(key,value);return value;};

/** Only immutable revision content is cached. Callers still read live users,
 * memberships, branch heads, build grants and run leases on every request.
 * Storage.get keeps its existing mutable-copy contract for edit code. */
export class RevisionReads {
  constructor(store,{maxBytes=64*1024*1024,maxEntries=8}={}){
    this.store=store;this.maxBytes=maxBytes;this.maxEntries=maxEntries;
    this.documents=new Map();this.metadata=new Map();this.signatures=new Map();this.bytes=0;
  }
  clear(){this.documents.clear();this.metadata.clear();this.signatures.clear();this.bytes=0;}
  invalidate(id){const old=this.documents.get(id);if(old)this.bytes-=old.bytes;this.documents.delete(id);this.metadata.delete(id);this.signatures.delete(id);}
  read(id){
    if(id==null)return null;
    const cached=this.documents.get(id);if(cached)return touch(this.documents,id,cached).value;
    const row=this.store.read.get('creator_revision',id);if(!row)return null;
    const value=freeze(JSON.parse(row.body)),bytes=row.body.length*2;
    if(bytes<=this.maxBytes){
      this.documents.set(id,{value,bytes});this.bytes+=bytes;
      while(this.bytes>this.maxBytes||this.documents.size>this.maxEntries){const first=this.documents.keys().next().value;this.bytes-=this.documents.get(first).bytes;this.documents.delete(first);}
    }
    this.rememberMeta(id,value);return value;
  }
  rememberMeta(id,value){
    const meta=freeze({id:value.id,project_id:value.project_id,parents:value.parents??[],created_at:value.created_at,schema:value.manifest?.schema});
    touch(this.metadata,id,meta);trim(this.metadata,512);return meta;
  }
  meta(id){
    if(id==null)return null;
    const old=this.metadata.get(id);if(old)return touch(this.metadata,id,old);
    // Fetch lineage/timestamp/schema without materializing native node indices.
    this.metaQuery??=this.store.db.prepare("SELECT json_extract(body,'$.id') AS id,json_extract(body,'$.project_id') AS project_id,json_extract(body,'$.parents') AS parents,json_extract(body,'$.created_at') AS created_at,json_extract(body,'$.manifest.schema') AS schema FROM documents WHERE kind='creator_revision' AND id=?");
    const row=this.metaQuery.get(id);if(!row)return null;
    const value=freeze({...row,parents:row.parents?JSON.parse(row.parents):[]});touch(this.metadata,id,value);trim(this.metadata,512);return value;
  }
  resourceSignature(id,resourceId){
    let entry=this.signatures.get(id);
    if(entry?.resources.has(resourceId)){touch(this.signatures,id,entry);return entry.resources.get(resourceId);}
    const manifest=this.read(id)?.manifest;
    if(!manifest?.resources?.[resourceId])return null;
    if(!entry){
      entry={schema:manifest.schema,prefabs:hash(Object.values(manifest.resources).filter(r=>r.kind==='prefab').sort((a,b)=>a.id.localeCompare(b.id))),resources:new Map()};
      this.signatures.set(id,entry);trim(this.signatures,128);
    }
    // Equality covers the same complete resource and conservative prefab set
    // as Inbox's old combined signature, including unknown properties.
    const signature=hash({schema:entry.schema,prefabs:entry.prefabs,resource:hash(manifest.resources[resourceId])});
    entry.resources.set(resourceId,signature);trim(entry.resources,256);return signature;
  }
}
