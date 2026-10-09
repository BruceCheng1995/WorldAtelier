import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {referenceName} from '../../packages/contracts/authoring-references.mjs';
import {writeWorkspaceFile} from './environments.mjs';
import {agentTextContext} from './agent-text-context.mjs';

// The immutable capture is retained once, outside the model's default context.
// A reference never embeds engine indices, asset blobs or captured transforms.
export function attachmentReferences({cwd,attachments=[]}){
  return attachments.map(attachment=>{
    const text=JSON.stringify(agentTextContext(attachment)),sha256=createHash('sha256').update(text).digest('hex');
    const file=`context/attachments/${sha256}.json`,id=attachment.id??`observation-${sha256}`;
    writeWorkspaceFile(cwd,file,text);
    return {id,kind:attachment.kind??'observation',name:referenceName(attachment).slice(0,200),href:`attachment:${id}`,snapshot_file:resolve(cwd,file),sha256,
      source_revision:attachment.source_revision??attachment.revision??null,resource_id:attachment.resource_id??null,object_id:attachment.object_id??null,...(attachment.kind==='viewport_annotation'?{annotation_kind:attachment.annotation_kind,dimension:attachment.dimension,position:attachment.position,...(attachment.geometry?.shape&&attachment.annotation_kind==='region'?{region:{shape:attachment.geometry.shape,center:attachment.geometry.center,size:attachment.geometry.size,plane:attachment.geometry.plane,offset:attachment.geometry.offset,depth:attachment.geometry.depth,selection:attachment.geometry.selection,outline_points:attachment.geometry.world_points?.length}}:{}),member_count:attachment.members.length,members:attachment.members.map(m=>({name:m.name,object_id:m.object_id,address:m.address})),note:attachment.note}: {})};
  });
}
