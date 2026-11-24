<script lang="ts">
  import { EventHelper } from 'src/utils/events';
  import { untrack, type Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  type Props = {
    expanded?: boolean;
    children?: Snippet;
    /**
     * When collapsed, exclude the wrapper and its children from rendering.
     * When rendering the content, trigger a soft render of the sheet
     * to ensure all integrating code can inject content appropriately.
     */
    deferRendering?: boolean;
  } & HTMLAttributes<HTMLElement>;

  let {
    expanded = true,
    children,
    class: cssClass,
    deferRendering,
    ...rest
  }: Props = $props();

  let previousExpanded = untrack(() => expanded);
  let overflowYHidden = $state(!previousExpanded);
  let expandableContainer: HTMLElement;
  let renderContents = $state(previousExpanded);

  $effect(() => {
    const open = expanded;
    if (open === previousExpanded) return;
    previousExpanded = open;
    if (open) renderContents = true;
    overflowYHidden = true;

    // Only the grid transition controls clipping. It may be disabled, or
    // cancelled halfway through when a sheet tab becomes hidden.
    let current = true;
    const settle = () => {
      if (!current) return;
      overflowYHidden = !open;
      renderContents = open;
    };
    const frame = requestAnimationFrame(() => {
      const transition = expandableContainer.getAnimations().find(animation =>
        'transitionProperty' in animation && animation.transitionProperty === 'grid-template-rows');
      if (transition) transition.finished.then(settle, settle);
      else settle();
    });
    return () => {
      current = false;
      cancelAnimationFrame(frame);
    };
  });
</script>

<div
  bind:this={expandableContainer}
  class={[
    'expandable',
    cssClass,
    {
      expanded,
      'overflow-y-hidden': overflowYHidden,
    },
  ]}
  role="presentation"
  {...rest}
>
  {#if !deferRendering || renderContents}
    <div
      role="presentation"
      class="expandable-child-animation-wrapper"
      {@attach () => {
        untrack(() => {
          if (deferRendering && expandableContainer) {
            EventHelper.triggerDynamicContentRenderedEvent(expandableContainer);
          }
        });
      }}
    >
      {@render children?.()}
    </div>
  {/if}
</div>
