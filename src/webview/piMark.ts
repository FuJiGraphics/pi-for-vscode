// pi.dev's official block logo, rasterized from /logo-auto.svg onto its native
// 4×4 grid (117.36 units/cell). Rendered as a CSS-grid of square blocks that
// drop into place "tetris"-style — matching pi.dev's hero animation.
//   r0: ██ ██ ██ ··
//   r1: ██ ·· ██ ··
//   r2: ██ ██ ·· ██
//   r3: ██ ·· ·· ██
const PI_CELLS: ReadonlyArray<ReadonlyArray<0 | 1>> = [
  [1, 1, 1, 0],
  [1, 0, 1, 0],
  [1, 1, 0, 1],
  [1, 0, 0, 1],
];

// `boot` = large, plays once and settles. `spinner` = tiny, loops forever.
export function piMarkHtml(variant: "boot" | "spinner"): string {
  let order = 0;
  let cells = "";
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (PI_CELLS[r][c]) {
        cells += `<span class="cell on" style="--i:${order}"></span>`;
        order++;
      } else {
        cells += '<span class="cell"></span>';
      }
    }
  }
  return `<span class="pi-mark ${variant}">${cells}</span>`;
}
