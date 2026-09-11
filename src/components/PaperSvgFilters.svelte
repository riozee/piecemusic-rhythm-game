<!-- Global SVG filter for thin slightly jagged paper edges -->
<svg
  class="fixed -top-[9999px] -left-[9999px] w-0 h-0 pointer-events-none opacity-0"
  aria-hidden="true"
>
  <defs>
    <filter id="jagged-paper" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="3" result="noise" />
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.8" xChannelSelector="R" yChannelSelector="G" />
    </filter>
  </defs>
</svg>
