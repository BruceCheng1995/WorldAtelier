extends SceneTree
const Game=preload("res://scripts/game_state.gd")
const Visual=preload("res://scripts/world_visual.gd")
var failures=[]
func _initialize() -> void:
	run.call_deferred()
func run() -> void:
	var checks=0
	for scale_value in [.1,.5,1,2.2,4,8]:
		for status in ["editing","testing","delivered","failed"]:
			var content=JSON.parse_string(FileAccess.get_file_as_string("res://content/world.json"))
			var subject=content.objects.filter(func(o):return o.id=="starheart")[0].duplicate(true)
			subject.x=0;subject.z=0;subject.scale=scale_value
			content.objects=[subject];content.enemies=[]
			content.zones=[{"id":"observatory","x":0,"z":0,"radius":80,"color":"#35566d"}]
			content.spawn={"x":subject.radius*scale_value+1,"z":0}
			var game=Game.new();var error=game.initialize(content)
			if not error.is_empty():failures.append(error);continue
			game.join("fixture","Layout fixture");game.command("fixture","select",{"object_id":subject.id})
			game.state.tasks=[{"id":"task","object_id":subject.id,"status":status,"author":"尺寸验证","title":"独立状态文字"}]
			var visual=Visual.new();root.add_child(visual);visual.build_world(content);visual.update_world(game.snapshot(),"fixture",.01)
			var selection_label=visual.selection.find_children("*","Label3D",true,false)[0]
			var task_labels=visual.task_nodes.task.find_children("*","Label3D",true,false)
			var bottom=minf(task_labels[0].global_position.y,task_labels[1].global_position.y)
			var separation=bottom-selection_label.global_position.y
			checks+=1
			if separation<1.25 or absf(task_labels[0].global_position.y-task_labels[1].global_position.y)<.79:
				failures.append({"scale":scale_value,"status":status,"separation":separation})
			visual.queue_free();await process_frame
	print("STATUS_LABEL_LAYOUT "+JSON.stringify({"ok":failures.is_empty(),"cases":checks,"failures":failures,"scope":"world-space label band separation across object scale .1 to 8; actual representative screenshots are separate"}))
	quit(0 if failures.is_empty() else 1)
