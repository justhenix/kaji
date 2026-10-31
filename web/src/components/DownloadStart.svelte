<script lang="ts">
  import { onMount } from 'svelte';
  let { url }: { url: string } = $props();
  let link: HTMLAnchorElement;
  onMount(() => { link.click(); });
</script>

<p>Your download should start automatically.<br />Didn't start? <a bind:this={link} href={url} download>Download manually</a></p>

<style>
  p { color: var(--muted); font-size: 18px; line-height: 1.7; }
  @media (max-width: 600px) { p { font-size: 16px; } }
</style>
