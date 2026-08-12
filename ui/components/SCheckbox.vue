<script setup lang="ts">
withDefaults(
	defineProps<{
		modelValue?: boolean;
		disabled?: boolean;
	}>(),
	{ modelValue: false, disabled: false },
);
defineEmits<{ "update:modelValue": [boolean] }>();
</script>

<template>
	<label class="s-check" :aria-disabled="disabled || undefined">
		<input
			type="checkbox"
			:checked="modelValue"
			:disabled="disabled"
			@change="$emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
		/>
		<span class="s-check__box" aria-hidden="true" />
		<span><slot /></span>
	</label>
</template>
