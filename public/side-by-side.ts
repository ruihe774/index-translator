// Full view's side by side (full-view.ts): both texts in two columns, each block in the grid row of its
// counterpart. Pure, so bun test can import it.
//
// The rows come from the paragraph alignment (`paragraphs.ts`), whose blocks are runs of raw lines, but
// the elements laid out are the rendered ones (`data-line`), and one element can hold several blocks (a
// list or a table written one line to a block, consecutive lines in one Markdown paragraph). Groups that
// one element reaches across are therefore joined into one band, and every band takes as many rows as
// its longer side has elements: those are laid out one to a row, and the shorter side's last element
// spans the rows left. A side with no element in a band leaves its cell empty: a block left out or added.

import { type Alignment, blockAt } from "./paragraphs.ts";
import type { Side } from "./state.ts";

/** The grid row an element starts on (1-based) and how many rows it spans. */
export interface Placement {
  row: number;
  span: number;
}

export interface Layout {
  rows: number;
  source: Placement[];
  output: Placement[];
}

const SIDES = ["source", "output"] as const;

/**
 * Rows for the elements of both views, given the `data-line` of each element of each side in order.
 * Every element gets a placement; groups that no element shows take no row.
 */
export function sideBySideRows(a: Alignment, lines: Record<Side, number[]>): Layout {
  const groupOf: Record<Side, number[]> = { source: [], output: [] };
  a.groups.forEach((g, i) => {
    for (const side of SIDES) {
      for (const b of g[side]) {
        groupOf[side][b] = i;
      }
    }
  });

  // The groups each element shows: from its first line's block to the block before the next element's.
  const reach = (side: Side) => {
    const starts = a[side];
    const own = lines[side];
    return own.map((line, i) => {
      const next = own[i + 1];
      const last = next === undefined ? starts.length - 1 : blockAt(starts, next - 1);
      return { first: groupOf[side][blockAt(starts, line)] ?? 0, last: groupOf[side][last] ?? 0 };
    });
  };
  const reaches = { source: reach("source"), output: reach("output") };

  // `joined[g]`: group g is in the band of group g - 1.
  const joined = a.groups.map(() => false);
  for (const side of SIDES) {
    for (const { first, last } of reaches[side]) {
      for (let g = first + 1; g <= last; g++) {
        joined[g] = true;
      }
    }
  }
  const bandOf: number[] = [];
  let bands = 0;
  joined.forEach((j, g) => {
    if (g > 0 && !j) {
      bands++;
    }
    bandOf[g] = bands;
  });

  const members: Record<Side, number[][]> = { source: [], output: [] };
  for (const side of SIDES) {
    reaches[side].forEach(({ first }, i) => {
      (members[side][bandOf[first] ?? 0] ??= []).push(i);
    });
  }

  const layout: Layout = { rows: 0, source: [], output: [] };
  for (let b = 0; b <= bands; b++) {
    const count = Math.max(members.source[b]?.length ?? 0, members.output[b]?.length ?? 0);
    for (const side of SIDES) {
      const own = members[side][b] ?? [];
      own.forEach((el, k) => {
        const last = k === own.length - 1;
        layout[side][el] = { row: layout.rows + k + 1, span: last ? count - k : 1 };
      });
    }
    layout.rows += count;
  }
  return layout;
}
