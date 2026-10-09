import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeControlLayout} from '../../services/creation/native-control-compat.mjs';
import {nativeObjectViews} from '../../services/creation/native-view.mjs';
import {measureLegacyControl,nativeControlOperation,nativePatchOperations} from '../../apps/creation-workspace/native-authoring.js';
// Property subset captured from a real pre-Control Godot adapter. In particular,
// off-tree position/size are unmeasured; the test must never treat them as a rect.
const node={
  "instance_ids": [
    "a"
  ],
  "local_transform": null,
  "metadata": {
    "_edit_pinned_properties_": [
      "anchor_left",
      "anchor_top",
      "anchor_right",
      "anchor_bottom",
      "offset_left",
      "offset_top",
      "offset_right",
      "offset_bottom",
      "pivot_offset",
      "rotation",
      "scale",
      "grow_horizontal",
      "grow_vertical"
    ],
    "wa_node_id": "child"
  },
  "name": "Child",
  "node_id": "child",
  "owner_path": "A",
  "path": "A/Child",
  "type": "ColorRect",
  "world_transform": null,
  "key": "[\"node\",[\"a\"],\"child\"]",
  "addressable": true,
  "version": "83d17b4ba6642fe8318e3c2f5d1662435b1948f349995cfdd3f471ce82ee5f46",
  "properties": [
    {
      "default_known": true,
      "name": "custom_minimum_size",
      "overridden": false,
      "stored_locally": false,
      "usage": 6,
      "value": {
        "$type": "Vector2",
        "value": [
          0,
          0
        ]
      }
    },
    {
      "default_known": true,
      "name": "anchor_left",
      "overridden": true,
      "stored_locally": true,
      "usage": 2,
      "value": 0
    },
    {
      "default_known": true,
      "name": "anchor_top",
      "overridden": true,
      "stored_locally": true,
      "usage": 2,
      "value": 0
    },
    {
      "default_known": true,
      "name": "anchor_right",
      "overridden": true,
      "stored_locally": true,
      "usage": 2,
      "value": 1
    },
    {
      "default_known": true,
      "name": "anchor_bottom",
      "overridden": true,
      "stored_locally": true,
      "usage": 2,
      "value": 1
    },
    {
      "default_known": true,
      "name": "offset_left",
      "overridden": true,
      "stored_locally": true,
      "usage": 2,
      "value": 0
    },
    {
      "default_known": true,
      "name": "offset_top",
      "overridden": true,
      "stored_locally": true,
      "usage": 2,
      "value": 0
    },
    {
      "default_known": true,
      "name": "offset_right",
      "overridden": true,
      "stored_locally": true,
      "usage": 2,
      "value": 0
    },
    {
      "default_known": true,
      "name": "offset_bottom",
      "overridden": true,
      "stored_locally": true,
      "usage": 2,
      "value": 0
    },
    {
      "default_known": true,
      "name": "grow_horizontal",
      "overridden": true,
      "stored_locally": true,
      "usage": 2,
      "value": 1
    },
    {
      "default_known": true,
      "name": "grow_vertical",
      "overridden": true,
      "stored_locally": true,
      "usage": 2,
      "value": 1
    },
    {
      "default_known": true,
      "name": "size",
      "overridden": false,
      "stored_locally": false,
      "usage": 4,
      "value": {
        "$type": "Vector2",
        "value": [
          0,
          0
        ]
      }
    },
    {
      "default_known": true,
      "name": "position",
      "overridden": false,
      "stored_locally": false,
      "usage": 4,
      "value": {
        "$type": "Vector2",
        "value": [
          0,
          0
        ]
      }
    },
    {
      "default_known": true,
      "name": "rotation",
      "overridden": true,
      "stored_locally": true,
      "usage": 6,
      "value": 0.610865235328674
    },
    {
      "default_known": true,
      "name": "scale",
      "overridden": true,
      "stored_locally": true,
      "usage": 6,
      "value": {
        "$type": "Vector2",
        "value": [
          -1,
          2
        ]
      }
    },
    {
      "default_known": true,
      "name": "pivot_offset",
      "overridden": true,
      "stored_locally": true,
      "usage": 6,
      "value": {
        "$type": "Vector2",
        "value": [
          20,
          10
        ]
      }
    },
    {
      "default_known": true,
      "name": "size_flags_horizontal",
      "overridden": false,
      "stored_locally": false,
      "usage": 2,
      "value": 1
    },
    {
      "default_known": true,
      "name": "size_flags_vertical",
      "overridden": false,
      "stored_locally": false,
      "usage": 2,
      "value": 1
    },
    {
      "default_known": true,
      "name": "size_flags_stretch_ratio",
      "overridden": false,
      "stored_locally": false,
      "usage": 2,
      "value": 1
    }
  ]
};
test('old Control projections retain recorded Godot override flags and wait for measured geometry',()=>{
 const before=JSON.stringify(node),layout=nativeControlLayout(node);
 assert.equal(layout.needs_measurement,true);assert.equal(layout.values.position,null);assert.equal(layout.values.size,null);
 assert.equal(layout.fields.offsets.overridden,node.properties.filter(p=>p.name.startsWith('offset_')).some(p=>p.overridden));
 assert.equal(layout.fields.offsets.resettable,true);assert.equal(JSON.stringify(node),before);
 assert.equal(nativeControlLayout({...node,type:'Node3D'}),null,'a similarly named script export is not a native Control');
 const managed=structuredClone(node);managed.properties.find(p=>p.name==='position').usage=268435460;
 assert.equal(nativeControlLayout(managed).fields.size.editable,false);assert.equal(nativeControlLayout(managed).fields.custom_minimum_size.editable,true);
});
test('only matching actual native observations fill the window view; old guards and source stay fixed',()=>{
 const manifest={schema:'creation-native-1',source_identity:'source-v1',resources:{main:{id:'main',path:'main.tscn',kind:'scene',version:'resource-v1',native_nodes:[structuredClone(node)]}}};
 const before=JSON.stringify(manifest),target=nativeObjectViews(manifest,'main',{project_id:'p',branch_id:'b'})[0],ctx={base:'revision-v1',resourceId:'main',manifest};
 const guard={version:target.version,address:structuredClone(target.address),ancestry_hash:target.ancestry_hash};
 // This unit fixture exercises observation validation. Real PackedScene/Chrome
 // round-trip evidence is retained in control-compat/actual-report.json.
 const actual={id:target.id,source_revision:ctx.base,source_identity:manifest.source_identity,object_version:target.version,dimension:'2d',ancestry_hash:target.ancestry_hash,address:target.address,native_target:target.native_target,local_transform:{position:[100,90,0],rotation:[0,0,35],scale:[-1,2,1]},control_layout:{needs_measurement:false,values:{position:[100,90],size:[320,180]},viewport_size:[1024,768],parent_size:[400,300],minimum_size:[0,0]}};
 for(const field of ['source_revision','source_identity','object_version','ancestry_hash'])assert.equal(measureLegacyControl(target,{...actual,[field]:'stale'},ctx),false);
 assert.equal(measureLegacyControl(target,actual,ctx),true);assert.deepEqual(target.control_layout.values.size,[320,180]);
 assert.deepEqual({version:target.version,address:target.address,ancestry_hash:target.ancestry_hash},guard);assert.equal(JSON.stringify(manifest),before);
 assert.equal(nativeControlOperation(target,{value:{size:[240,120]}},ctx).expected_version,'resource-v1');assert.equal(nativePatchOperations(target,{position:[101,90,0]},ctx)[0].operation.op,'control_layout');
 assert.equal(measureLegacyControl(target,{...actual,control_layout:{...actual.control_layout,values:{position:[900,900],size:[1,1]}}},ctx),false,'later transient measurements do not rewrite the fixed canonical view');
});
