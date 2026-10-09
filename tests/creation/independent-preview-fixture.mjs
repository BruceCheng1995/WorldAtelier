/** Real, visible test content for isolated editor Play/inspection verification.
 * Creates only caller-provided independent-service accounts and source objects.
 * It never supplies a runtime ACK, gameplay snapshot, or synthetic completion.
 */
import {randomUUID,createHash} from 'node:crypto';

export const independentPreviewBehavior=`extends RefCounted
func initialize(ctx) -> Dictionary:
\tif ctx.role == "authority":
\t\tctx.state["interactions"] = int(ctx.state.get("interactions",0))
\t\tctx.state["ticks"] = int(ctx.state.get("ticks",0))
\tif ctx.role == "presentation":
\t\tvar overlay = CanvasLayer.new()
\t\toverlay.name = "IndependentPreviewGameUI"
\t\tctx.root.add_child(overlay)
\t\tctx.local["canvas_layer"] = overlay
\t\tvar root_ui = Control.new()
\t\troot_ui.name = "FullScreenInputBlocker"
\t\troot_ui.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
\t\troot_ui.mouse_filter = Control.MOUSE_FILTER_STOP
\t\toverlay.add_child(root_ui)
\t\tvar panel = ColorRect.new()
\t\tpanel.color = Color(0.66,0.04,0.36,0.97)
\t\tpanel.position = Vector2(28,92)
\t\tpanel.size = Vector2(580,208)
\t\troot_ui.add_child(panel)
\t\tvar title = Label.new()
\t\ttitle.text = "INDEPENDENT PREVIEW - GAME UI"
\t\ttitle.add_theme_font_size_override("font_size",22)
\t\ttitle.position = Vector2(16,16)
\t\tpanel.add_child(title)
\t\tvar count = Label.new()
\t\tcount.name = "InteractionCount"
\t\tcount.add_theme_font_size_override("font_size",28)
\t\tcount.position = Vector2(16,66)
\t\tpanel.add_child(count)
\t\tctx.local["count_label"] = count
\t\tvar clock_label = Label.new()
\t\tclock_label.position = Vector2(16,116)
\t\tpanel.add_child(clock_label)
\t\tctx.local["clock_label"] = clock_label
\t\tvar hint = Label.new()
\t\thint.text = "E / Interact changes only this test session."
\t\thint.position = Vector2(16,160)
\t\tpanel.add_child(hint)
\t\tvar hidden_hint = Label.new()
\t\thidden_hint.name = "MustRemainHidden"
\t\thidden_hint.text = "ERROR: originally hidden UI was revealed"
\t\thidden_hint.visible = false
\t\tpanel.add_child(hidden_hint)
\t\tctx.local["hidden_control"] = hidden_hint
\t\tvar game_camera = Camera3D.new()
\t\tgame_camera.name = "CreatorGameCamera"
\t\tctx.root.add_child(game_camera)
\t\tgame_camera.position = Vector3(5,7,10)
\t\tgame_camera.look_at(Vector3(0,1,0))
\t\tgame_camera.make_current()
\t\tctx.local["game_camera"] = game_camera
\t\tfor index in range(3):
\t\t\tvar landmark = MeshInstance3D.new()
\t\t\tlandmark.name = "CameraLandmark"+str(index)
\t\t\tvar mesh = BoxMesh.new()
\t\t\tmesh.size = Vector3(0.8,1.2+index*0.8,0.8)
\t\t\tlandmark.mesh = mesh
\t\t\tvar material = StandardMaterial3D.new()
\t\t\tmaterial.albedo_color = [Color("f2bc57"),Color("57cba8"),Color("6a9eea")][index]
\t\t\tlandmark.material_override = material
\t\t\tlandmark.position = Vector3((index-1)*2,mesh.size.y/2,-2)
\t\t\tctx.root.add_child(landmark)
\treturn {"ok":true}
func tick(ctx,_delta) -> Dictionary:
\tif ctx.role == "authority": ctx.state["ticks"] = int(ctx.state.get("ticks",0))+1
\treturn {"ok":true}
func interact(ctx,_actor) -> Dictionary:
\tif ctx.role == "authority": ctx.state["interactions"] = int(ctx.state.get("interactions",0))+1
\treturn {"ok":true}
func present(ctx,_event) -> Dictionary:
\tif ctx.role == "presentation":
\t\tctx.local.count_label.text = "LOCAL INTERACTIONS: " + str(ctx.state.get("interactions",0))
\t\tctx.local.clock_label.text = "Authority tick: " + str(ctx.tick)
\treturn {"ok":true}
`;

export const independentPreviewBehaviorHash=createHash('sha256').update(independentPreviewBehavior).digest('hex');
export function independentPreviewObject(asset){
 return {id:'independent-preview-device',name:'独立运行与暂停UI验证',kind:'anchor',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],components:{interactable:{radius:12,label:'增加本次运行计数'},behaviors:[{id:'independent-preview-counter',api:1,script_hash:asset.id,script_url:asset.url,properties:{}}]}};
}

/** request(method,path,{auth,body,raw,name}) must use an isolated 48923 service. */
export async function createIndependentPreviewFixture(request){
 const users=[];
 for(const label of ['A','B']){
  const name=`Independent preview ${label} ${randomUUID().slice(0,6)}`,password=`isolated-${randomUUID()}`;
  const auth=await request('POST','/auth/register',{body:{name,password}});
  users.push({label,name,password,...auth});
 }
 const [owner,peer]=users;
 const created=await request('POST','/projects',{auth:owner,body:{name:'独立Play与暂停观察回归',template:'empty'}});
 const projectId=created.project.id,branchPath=`/projects/${projectId}/branches/main`;
 const invite=await request('POST',`/projects/${projectId}/invites`,{auth:owner,body:{role:'editor'}});
 await request('POST','/invites/join',{auth:peer,body:{code:invite.code}});
 const asset=await request('POST',`/projects/${projectId}/assets`,{auth:owner,raw:true,name:'independent-preview-fixture.gd',body:Buffer.from(independentPreviewBehavior)});
 if(asset.id!==independentPreviewBehaviorHash)throw Error('Test asset hash mismatch');
 const current=await request('GET',branchPath,{auth:owner});
 const resourceId=current.manifest.entry_scene_id,object=independentPreviewObject(asset);
 const changed=await request('POST',branchPath+'/transactions',{auth:owner,body:{transaction_id:`independent-preview-${randomUUID()}`,base_revision:current.head,ops:[{type:'put_object',resource_id:resourceId,object_id:object.id,expected_version:null,object}]}});
 return {users,project_id:projectId,branch_id:'main',resource_id:resourceId,source_revision:changed.revision,asset,object};
}
