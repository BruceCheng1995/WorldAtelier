shader_type canvas_item;
render_mode unshaded;
uniform sampler2D filled_mask : filter_linear, repeat_disable;
uniform sampler2D layer_masks : filter_linear, repeat_disable;
uniform sampler2D agent_masks : filter_linear, repeat_disable;
uniform float opacity = 0.85;
uniform float pixel_ratio = 1.0;
void fragment() {
	vec4 masks = texture(layer_masks, UV);
	float agent = texture(agent_masks, UV).r;
	// Agent activity is a style of the shared selection band, not a separate
	// geometry or label renderer. User selection remains steady and solid.
	float phase = fract((FRAGCOORD.x + FRAGCOORD.y) / (18.0 * max(pixel_ratio, 0.25)) - TIME * 0.65);
	float dash = smoothstep(0.03, 0.10, phase) * (1.0 - smoothstep(0.58, 0.65, phase));
	float activity_alpha = mix(1.0, mix(0.18, 1.0, dash), agent);
	vec3 color = mix(masks.rgb, vec3(1.0), agent * dash * 0.22);
	// Subtract the hole-free silhouette, never the raw mesh coverage. All
	// interior edges (including door/ring holes) disappear from the result.
	COLOR = vec4(color, masks.a * (1.0 - texture(filled_mask, UV).a) * opacity * activity_alpha);
}
