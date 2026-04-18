
// NOTE: In GLSL ES 1.00 (WebGL), non-constant array indexing is restricted
// to loop counters inside their originating loop. Passing a loop counter as
// a function parameter strips the exemption, so WebGL rejects `lights[i]`
// inside a function. We therefore fetch the 4 vec4s at the call site (where
// `i` is still a loop counter) and pass them in as plain parameters.
vec3 lightContribution(vec4 lightpos, vec4 lightcolor, vec4 lightspot1, vec4 lightspot2, vec3 normal)
{
	float lightdistance = distance(lightpos.xyz, pixelpos.xyz);
	
	//if (lightpos.w < lightdistance)
	//	return vec3(0.0); // Early out lights touching surface but not this fragment

	vec3 lightdir = normalize(lightpos.xyz - pixelpos.xyz);
	float dotprod = dot(normal, lightdir);

	if (dotprod < -0.0001) return vec3(0.0);	// light hits from the backside. This can happen with full sector light lists and must be rejected for all cases. Note that this can cause precision issues.
	
	float attenuation = clamp((lightpos.w - lightdistance) / lightpos.w, 0.0, 1.0);


#if (DEF_HAS_SPOTLIGHT == 1) // Only perform test below if there are ANY spot lights on this surface.

	if (lightspot1.w == 1.0)
		attenuation *= spotLightAttenuation(lightpos, lightspot1.xyz, lightspot2.x, lightspot2.y);

#endif

	if (lightcolor.a < 0.0) // Sign bit is the attenuated light flag
	{
		attenuation *= clamp(dotprod, 0.0, 1.0);
	}
	return lightcolor.rgb * attenuation;
}


vec3 ProcessMaterialLight(Material material, vec3 color)
{
	vec4 dynlight = uDynLightColor;
	vec3 normal = material.Normal;

#if (DEF_DYNAMIC_LIGHTS_MOD == 1)
	// modulated lights
	
	// Some very old GLES2 hardware does not allow non-constants in a for-loop expression because it can not unroll it.
	// However they do allow 'break', so use stupid hack
	#if (USE_GLSL_V100 == 1)

		for(int i = 0; i < 8; i++) // Max 8 lights
		{
			if(i == ((uLightRange.y - uLightRange.x) / 4))
				break;

			dynlight.rgb += lightContribution(lights[i*4], lights[i*4+1], lights[i*4+2], lights[i*4+3], normal);
		}

	#else

		for(int i=uLightRange.x; i<uLightRange.y; i+=4)
		{
			dynlight.rgb += lightContribution(lights[i], lights[i+1], lights[i+2], lights[i+3], normal);
		}

	#endif
#endif

#if (DEF_DYNAMIC_LIGHTS_SUB == 1)
	// subtractive lights
	#if (USE_GLSL_V100 == 1)

		for(int i = 0; i < 4; i++) // Max 4 lights
		{
			if(i == ((uLightRange.z - uLightRange.y) / 4))
				break;

			int base = uLightRange.y / 4 + i;
			dynlight.rgb -= lightContribution(lights[base*4], lights[base*4+1], lights[base*4+2], lights[base*4+3], normal);
		}

	#else

		for(int i=uLightRange.y; i<uLightRange.z; i+=4)
		{
			dynlight.rgb -= lightContribution(lights[i], lights[i+1], lights[i+2], lights[i+3], normal);
		}

	#endif
#endif
	
	vec3 frag = material.Base.rgb * clamp(color + desaturate(dynlight).rgb, 0.0, 1.4);
	
#if (DEF_DYNAMIC_LIGHTS_ADD == 1)
	vec4 addlight = vec4(0.0,0.0,0.0,0.0);
				
	// additive lights
	#if (USE_GLSL_V100 == 1)

		for(int i = 0; i < 4; i++) // Max 4 lights
		{
			if(i == ((uLightRange.w - uLightRange.z) / 4))
				break;

			int base = uLightRange.z / 4 + i;
			addlight.rgb += lightContribution(lights[base*4], lights[base*4+1], lights[base*4+2], lights[base*4+3], normal);
		}

	#else

		for(int i=uLightRange.z; i<uLightRange.w; i+=4)
		{
			addlight.rgb += lightContribution(lights[i], lights[i+1], lights[i+2], lights[i+3], normal);
		}

	#endif

	frag = clamp(frag + desaturate(addlight).rgb, 0.0, 1.0);
#endif
 
	return frag;
}
