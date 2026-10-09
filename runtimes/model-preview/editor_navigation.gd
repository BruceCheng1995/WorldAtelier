extends RefCounted
## Short velocity response; look rotation stays immediate in the host.
## Analytic integration keeps travel independent of the render frame rate.
var velocity = Vector3.ZERO
var response = 0.045
var sensitivity = 0.0025
var last_input_at = -1.0
var captured = false
var capture_lost = false
var lock_confirmed = false
var lock_callback

func step(direction: Vector3, speed: float, delta: float) -> Vector3:
	var dt=clampf(delta,0,.1)
	var desired=direction.limit_length(1.0)*speed
	var duration=response if not direction.is_zero_approx() else minf(response,.02)
	if duration<=0:
		velocity=desired
		return desired*dt
	var decay=exp(-dt/duration)
	var previous=velocity
	velocity=desired+(previous-desired)*decay
	var travel=desired*dt+(previous-desired)*duration*(1.0-decay)
	if desired.is_zero_approx() and velocity.length()<.001: velocity=Vector3.ZERO
	return travel

func reset() -> void:
	velocity=Vector3.ZERO
	var release=captured
	captured=false
	capture_lost=false
	lock_confirmed=false
	if release: Input.mouse_mode=Input.MOUSE_MODE_VISIBLE

func begin_capture() -> void:
	# Native unattended probes must never capture the desktop pointer.
	if OS.has_feature("web"):
		if lock_callback==null:
			lock_callback=JavaScriptBridge.create_callback(_pointer_lock_changed)
			JavaScriptBridge.eval("window.__atelierNavigation={listen:function(cb){['pointerlockchange','pointerlockerror'].forEach(function(type){document.addEventListener(type,function(e){cb(document.pointerLockElement===document.getElementById('canvas'),e.type==='pointerlockerror');});});}}")
			JavaScriptBridge.get_interface("__atelierNavigation").listen(lock_callback)
		captured=true
		Input.mouse_mode=Input.MOUSE_MODE_CAPTURED

func _pointer_lock_changed(args: Array) -> void:
	if bool(args[0]):
		if captured: lock_confirmed=true
		else: Input.mouse_mode=Input.MOUSE_MODE_VISIBLE # A late grant after mouse-up.
	elif captured and (lock_confirmed or bool(args[1])):
		capture_lost=true # Escape is often consumed by the browser, not Godot.

func active(now: float) -> bool:
	return now-last_input_at<.14 or velocity.length_squared()>.0001
