<script lang="ts">
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';

  const localize = FoundryAdapter.localize;
</script>

<div class="dialog-content-container flexcol">
  <div class="tidy-info-banner">
    <a href="https://github.com/EnYuri/female_edition" target="_blank" rel="noopener noreferrer">
      <img
        class="logo"
        src="modules/female_edition/tidy-classic/public/images/tidy-shield-large.webp"
        alt={localize('FE_TIDY.About.logoAltText')}
      />
    </a>
    <p class="banner-text">
      {@html localize('FE_TIDY.About.MaintainerParagraph', {
        urlStart: '<a href="https://github.com/EnYuri/female_edition" target="_blank" rel="noopener noreferrer">',
        urlEnd: '</a>',
      })}
    </p>
  </div>
  <p>
    {@html localize('FE_TIDY.About.GithubParagraph', {
      urlStart:
        '<a href="https://github.com/EnYuri/female_edition/issues" target="_blank" rel="noopener noreferrer">',
      urlEnd: '</a>',
    })}
  </p>
  <p>
    {@html localize('FE_TIDY.About.OriginParagraph', {
      urlStart: '<a href="https://github.com/kgar/foundry-vtt-tidy-5e-sheets" target="_blank" rel="noopener noreferrer">',
      urlEnd: '</a>',
    })}
  </p>
</div>

<style lang="less">
  .tidy-info-banner {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    margin-top: -0.5rem;
    margin-left: -0.5rem;
    margin-right: -0.5rem;
    margin-bottom: 1rem;
    min-height: 10rem;
    padding-left: 2rem;
    padding-right: 2rem;
  }

  .logo {
    max-width: 7.5rem;
    animation: TheShining 16s infinite;
  }

  @keyframes TheShining {
    0% {
      filter: drop-shadow(0 0 0.625rem var(--t5e-primary-accent-color));
    }
    50% {
      filter: drop-shadow(0 0 5rem var(--t5e-primary-accent-color))
        hue-rotate(90deg);
    }
    100% {
      filter: drop-shadow(0 0 0.625rem var(--t5e-primary-accent-color))
        hue-rotate(360deg);
    }
  }
</style>
