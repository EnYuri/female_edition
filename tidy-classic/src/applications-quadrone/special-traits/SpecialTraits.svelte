<script lang="ts">
  import { getSheetContext } from 'src/sheets/sheet-context.svelte';
  import type { SpecialTraitsContext } from './SpecialTraitsApplication.svelte';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import SelectQuadrone from 'src/components/inputs/SelectQuadrone.svelte';
  import SelectOptions from 'src/components/inputs/SelectOptions.svelte';
  import FormGroup from 'src/components/form-group/FormGroup.svelte';

  let context = $derived(getSheetContext<SpecialTraitsContext>());

  let flags = $derived(context.flags);

  let idPrefix = `special-traits-${foundry.utils.randomID()}`;

  const localize = FoundryAdapter.localize;
</script>

<div
  class="dialog-content-container special-traits-container scroll-container tidy-form flexcol"
>
  <h2>
    {localize('DND5E.SpecialTraits')}
  </h2>

  <fieldset>
    <legend>
      {localize('TYPES.Item.class')}
      <fe-tidy-classic-gold-underline></fe-tidy-classic-gold-underline>
    </legend>
    <div class="form-group">
      <label for="{idPrefix}-original-class">
        {localize('DND5E.ClassMakeOriginal')}
      </label>
      <div class="form-fields">
        <SelectQuadrone
          field="system.details.originalClass"
          document={context.actor}
          value={context.actor.system.details.originalClass}
        >
          <SelectOptions
            data={context.flags.classes}
            labelProp="label"
            valueProp="value"
          />
        </SelectQuadrone>
      </div>
    </div>
  </fieldset>

  {#each flags.sections as section}
    <fieldset onchange={() => context.actor.sheet.submit()}>
      <legend>
        {section.label}
        <fe-tidy-classic-gold-underline></fe-tidy-classic-gold-underline>
      </legend>
      {#each section.fields as fieldContext}
        {#if fieldContext.group}
          <FormGroup
            labelFor="{context.actor.id}-{fieldContext.fields?.[0]?.name
              .slugify()
              .replaceAll('.', '-')}"
            document={context.actor}
            localize={true}
            groupClasses="split-group"
            disableOverriddenInputs
            label={fieldContext.group.label}
            hint={fieldContext.group.hint}
          >
            {#each fieldContext.fields ?? [] as fieldGroupMember}
              {@const memberId = `${context.actor.id}-${fieldGroupMember.name.slugify().replaceAll('.', '-')}`}
              <FormGroup
                document={context.actor}
                field={fieldGroupMember.field}
                choices={fieldGroupMember.choices}
                label={fieldGroupMember.label}
                labelFor={memberId}
                config={{
                  id: memberId,
                  value: fieldGroupMember.value,
                  name: fieldGroupMember.name,
                  classes: fieldGroupMember.classes,
                  placeholder: fieldGroupMember.placeholder,
                }}
                groupClasses={fieldGroupMember.classes}
                disableOverriddenInputs
              />
            {/each}
          </FormGroup>
        {:else}
          {@const isCheckbox =
            fieldContext instanceof foundry.data.fields.BooleanField}
          {@const id = `${context.actor.id}-${fieldContext.name.slugify().replaceAll('.', '-')}`}
          <FormGroup
            labelFor={id}
            document={context.actor}
            field={fieldContext.field}
            hint={fieldContext.hint}
            config={{
              id,
              value: fieldContext.value,
              name: fieldContext.name,
              placeholder: fieldContext.placeholder,
            }}
            localize={true}
            groupClasses={{ slim: isCheckbox }}
            disableOverriddenInputs
          />
        {/if}
      {/each}
    </fieldset>
  {/each}
</div>
