shader_type spatial;
render_mode unshaded, fog_disabled, shadows_disabled, depth_draw_always;
uniform bool selected = false;
void fragment() {
	ALBEDO = vec3(1.0);
	ALPHA = selected ? 1.0 : 0.0;
}
