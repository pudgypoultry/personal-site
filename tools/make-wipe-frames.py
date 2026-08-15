#!/usr/bin/env python3
"""Pre-render the tab-transition cellular automata to a sprite sheet.

The site used to run these rules in the browser on every tab change, one DOM
element per cell. That caps out around a hundred cells; at a 10px cell a normal
viewport wants ten thousand. So the whole thing is baked here instead: the rules
run once, offline, and the browser just plays the resulting frames.

Output is wipe-frames.png -- a vertical strip of FRAMES frames, one *pixel* per
cell. The stylesheet blows it up with image-rendering: pixelated, so one source
pixel becomes one CELL_PX square on screen. That keeps the asset tiny while the
cells stay crisp.

Three automata, same rules the JS used to run:

  growth  a threshold CA seeded at the centre of the sheet. Neighbours that are
          already on contribute ORTH (edge-adjacent) or DIAG (corner-adjacent) to
          a score; a cell switches on once that score passes its own threshold.
          Per-cell thresholds are what make the front ragged and pocketed.
  life    Conway's B3/S23, ticking once per frame underneath everything.
  decay   a second threshold CA, weighted towards diagonals so it clears the board
          differently from the way it filled.

Run:  python tools/make-wipe-frames.py
It prints the constants script.js needs. Re-run after changing anything here.
"""

import struct
import zlib
from pathlib import Path

# ---- knobs ----------------------------------------------------------------

COLS, ROWS = 320, 200   # cells; at CELL_PX this covers a 3200x2000 viewport
CELL_PX = 10            # display size of one cell, for the printed constants
FRAMES = 32             # total frames in the sheet

GROW_LAST = 15          # last frame of the growth wave
COVER_FRAME = 16        # the one frame where every cell is on (tab swaps here)
DECAY_FIRST = 17        # first frame of the decay wave
DECAY_LAST = 30         # last frame a cell may switch off; frame 31 is empty

LIFE_DENSITY = 0.34     # starting density of the Life soup

# How thick the lit front of each wave is, as a fraction of the generations that
# land in a single frame. Each frame absorbs ~17 generations of the automaton; at
# 1.0 every cell arriving that frame is lit, which makes a band ~17 generations
# deep. At 0.5 only the outermost half lights up and the rest arrive already dark,
# so the wave keeps its speed but the glowing edge is half as deep.
FRONT_FRACTION = 0.5

# Neighbour weights: how much an already-flipped neighbour contributes, depending on
# whether it is edge- or corner-adjacent. Both waves use the same weighting so the
# board clears with the same ragged, pocketed front that it filled with. Only the
# salt differs, which reshuffles the per-cell thresholds -- the clear is a different
# colony of the same species, not the growth played backwards.
GROW_ORTH, GROW_DIAG = 2, 1
DECAY_ORTH, DECAY_DIAG = 2, 1

# Palette indices, written as a 4-colour 2-bit PNG.
CLEAR, DARK, LIT, FLASH = 0, 1, 2, 3
PALETTE = [(0, 0, 0), (14, 14, 14), (194, 85, 31), (239, 109, 61)]
ALPHA = [0, 255, 255, 255]

OUT = Path(__file__).resolve().parent.parent / "wipe-frames.png"

N = COLS * ROWS


def cell_hash(i, salt):
    """Deterministic per-cell value in [0,1). Same shape as the old JS hash: the
    point is that a cell's threshold is a property of where it is, not of luck."""
    h = (i + 1) * 374761393 ^ (salt + 1) * 668265263
    h &= 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 4294967296.0


def neighbours(idx):
    """The up-to-8 Moore neighbours of a cell, as (index, is_diagonal)."""
    c = idx % COLS
    r = idx // COLS
    out = []
    for dr in (-1, 0, 1):
        rr = r + dr
        if rr < 0 or rr >= ROWS:
            continue
        for dc in (-1, 0, 1):
            cc = c + dc
            if (dr == 0 and dc == 0) or cc < 0 or cc >= COLS:
                continue
            out.append((rr * COLS + cc, dr != 0 and dc != 0))
    return out


def run_automaton(seed_index, salt, orth, diag):
    """Threshold CA. Returns (generation each cell flipped in, last generation).

    Only cells on the frontier are evaluated each generation, which keeps this
    near-linear instead of rescanning a 64,000-cell grid every step.
    """
    gen = [-1] * N
    on = bytearray(N)
    threshold = [0] * N

    for i in range(N):
        c = i % COLS
        r = i // COLS
        edge_x = c == 0 or c == COLS - 1
        edge_y = r == 0 or r == ROWS - 1
        if edge_x and edge_y:
            reach = 2 * orth + diag
        elif edge_x or edge_y:
            reach = 3 * orth + 2 * diag
        else:
            reach = 4 * orth + 4 * diag

        h = cell_hash(i, salt)
        if h < 0.35:
            want = orth                # one edge neighbour is enough
        elif h < 0.75:
            want = orth + diag         # an edge and a corner
        elif h < 0.93:
            want = 2 * orth + diag     # properly supported on one side
        else:
            want = 3 * orth + diag     # holdout: nearly enclosed first
        threshold[i] = min(want, reach)

    on[seed_index] = 1
    gen[seed_index] = 0
    remaining = N - 1
    g = 0

    frontier = set()
    for nb, _ in neighbours(seed_index):
        frontier.add(nb)

    guard = 8 * (COLS + ROWS)
    while remaining > 0 and g < guard:
        g += 1
        flipping = []
        best, best_score = [], 0

        for idx in frontier:
            score = 0
            for nb, is_diag in neighbours(idx):
                if on[nb]:
                    score += diag if is_diag else orth
            if score >= threshold[idx]:
                flipping.append(idx)
            elif score > best_score:
                best_score, best = score, [idx]
            elif score == best_score and score > 0:
                best.append(idx)

        # A young colony can stall when every cell touching it is a holdout. Let
        # the best-supported cells through rather than deadlocking.
        if not flipping:
            flipping = best
        if not flipping:
            break

        for idx in flipping:
            on[idx] = 1
            gen[idx] = g
        remaining -= len(flipping)

        for idx in flipping:
            frontier.discard(idx)
            for nb, _ in neighbours(idx):
                if not on[nb]:
                    frontier.add(nb)

    for i in range(N):
        if gen[i] < 0:
            gen[i] = g
    return gen, max(1, g)


def run_life(frames, salt):
    """Conway's Life, one generation per frame. Returns a list of bytearrays."""
    state = bytearray(1 if cell_hash(i, salt) < LIFE_DENSITY else 0 for i in range(N))
    history = []

    for _ in range(frames):
        history.append(bytes(state))
        nxt = bytearray(N)
        for r in range(ROWS):
            row = r * COLS
            up = row - COLS
            down = row + COLS
            has_up = r > 0
            has_down = r < ROWS - 1
            for c in range(COLS):
                idx = row + c
                left = c > 0
                right = c < COLS - 1
                live = 0
                if left and state[idx - 1]:
                    live += 1
                if right and state[idx + 1]:
                    live += 1
                if has_up:
                    if state[up + c]:
                        live += 1
                    if left and state[up + c - 1]:
                        live += 1
                    if right and state[up + c + 1]:
                        live += 1
                if has_down:
                    if state[down + c]:
                        live += 1
                    if left and state[down + c - 1]:
                        live += 1
                    if right and state[down + c + 1]:
                        live += 1
                nxt[idx] = 1 if (live == 3 or (state[idx] and live == 2)) else 0
        state = nxt

    return history


def write_png(path, width, height, rows_2bit):
    """Minimal 2-bit indexed PNG with a transparent palette entry."""
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 2, 3, 0, 0, 0)
    plte = b"".join(bytes(c) for c in PALETTE)
    trns = bytes(ALPHA)

    raw = bytearray()
    for row in rows_2bit:
        raw.append(0)          # filter: None
        raw.extend(row)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"PLTE", plte)
           + chunk(b"tRNS", trns)
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)
    return len(png)


def main():
    seed = (ROWS // 2) * COLS + (COLS // 2)

    print(f"grid {COLS}x{ROWS} = {N} cells, {FRAMES} frames")
    print("running growth automaton...")
    birth_gen, birth_last = run_automaton(seed, seed, GROW_ORTH, GROW_DIAG)
    print(f"  covered in {birth_last} generations")

    print("running decay automaton...")
    death_gen, death_last = run_automaton(seed, seed + 7919, DECAY_ORTH, DECAY_DIAG)
    print(f"  cleared in {death_last} generations")

    print("running life...")
    life = run_life(FRAMES, seed + 104729)

    # Squeeze each automaton's generations into its slice of the frame budget. The
    # exact (fractional) position is kept as well as the rounded frame: a cell sits
    # somewhere inside its frame's window of generations, and only the ones near the
    # leading edge of that window are lit.
    decay_span = DECAY_LAST - DECAY_FIRST
    birth_pos = [g / birth_last * GROW_LAST for g in birth_gen]
    death_pos = [DECAY_FIRST + g / death_last * decay_span for g in death_gen]

    birth_frame = [round(p) for p in birth_pos]
    death_frame = [round(p) for p in death_pos]

    # A frame's window is [frame - 0.5, frame + 0.5); light the top slice of it.
    cutoff = 0.5 - FRONT_FRACTION
    birth_lit = [(birth_pos[i] - birth_frame[i]) >= cutoff for i in range(N)]
    death_lit = [(death_pos[i] - death_frame[i]) >= cutoff for i in range(N)]

    print("composing frames...")
    row_bytes = (COLS + 3) // 4     # 2 bits per pixel
    sheet = []

    for f in range(FRAMES):
        alive = life[f]
        for r in range(ROWS):
            packed = bytearray(row_bytes)
            base = r * COLS
            for c in range(COLS):
                i = base + c
                # A cell flashes accent as it arrives and again as it leaves, so both
                # waves travel behind a visible lit edge. Without the second flash the
                # board just thins out into nothing. Cells that arrive or leave behind
                # the front of their own frame skip the flash, which is what keeps the
                # band thin.
                if f < birth_frame[i] or f > death_frame[i]:
                    idx = CLEAR
                elif (f == birth_frame[i] and birth_lit[i]) or \
                     (f == death_frame[i] and death_lit[i]):
                    idx = FLASH
                else:
                    idx = LIT if alive[i] else DARK
                packed[c >> 2] |= idx << (6 - 2 * (c & 3))
            sheet.append(bytes(packed))

    size = write_png(OUT, COLS, ROWS * FRAMES, sheet)

    # Sanity checks: the swap frame must be completely opaque, and the last frame
    # completely empty, or the overlay would blink out with cells still lit.
    holes = sum(1 for i in range(N)
                if birth_frame[i] > COVER_FRAME or death_frame[i] < COVER_FRAME)
    leftover = sum(1 for i in range(N) if death_frame[i] >= FRAMES - 1)

    print(f"\nwrote {OUT.name}: {size / 1024:.1f} KB, {COLS}x{ROWS * FRAMES} px")
    print(f"holes in cover frame {COVER_FRAME}: {holes} (must be 0)")
    print(f"cells still up on last frame: {leftover} (must be 0)")
    print("\nconstants for script.js:")
    print(f"  var SHEET_COLS   = {COLS};")
    print(f"  var SHEET_ROWS   = {ROWS};")
    print(f"  var SHEET_FRAMES = {FRAMES};")
    print(f"  var COVER_FRAME  = {COVER_FRAME};")
    print(f"  var CELL_PX      = {CELL_PX};")


if __name__ == "__main__":
    main()
