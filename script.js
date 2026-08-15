// Wait for the document to load before running the script
(function ($) {

  // ---- Tab transition ------------------------------------------------------
  // A cellular automaton covers the screen and clears it again: threshold-CA growth
  // out of the point of the click, Conway's Life ticking underneath, threshold-CA
  // decay behind it. None of that is computed here. tools/make-wipe-frames.py runs
  // the rules once, offline, and bakes the frames into wipe-frames.png; the browser
  // plays that strip back as a flipbook via one background-position animation.
  //
  // Everything below is measurement: where to put the sheet so the seed cell lands
  // under the cursor, and when the board is covered so the tab can change behind it.
  // Re-run the generator after changing it -- it prints these constants.

  var SHEET_COLS   = 320;  // cells across one frame
  var SHEET_ROWS   = 200;  // cells down one frame
  var SHEET_FRAMES = 32;   // frames in the strip; must match steps() in style.css
  var COVER_FRAME  = 16;   // the frame where every cell is on
  var CELL_PX      = 10;   // display size of one cell

  var FRAME_MS     = 20;   // one frame; 32 of them is a 640ms transition

  // Where the last click landed, in viewport coordinates. Defaults to the middle
  // of the screen so keyboard navigation and pasted #hash URLs still look right.
  var origin = null;
  var swapTimer = null;
  var cleanupTimer = null;

  $(document).on('click', '.main-menu a', function (e) {
    origin = { x: e.clientX, y: e.clientY };
  });

  $(window).on('load', function () {
    // The hidden tabs hold some large screenshots. A display:none image is fetched
    // but not decoded, so the first time a tab is shown the browser decodes it on
    // the main thread -- right in the middle of the transition, which shows up as a
    // stutter. Decoding up front moves that cost to page load.
    $('#content img').each(function () {
      if (this.decode) { this.decode().catch(function () {}); }
    });

    // Same reasoning for the frame sheet, which is the one asset the transition
    // cannot start without.
    var sheet = new Image();
    sheet.src = 'wipe-frames.png';
    if (sheet.decode) { sheet.decode().catch(function () {}); }
  });

  // The stylesheet hides the overlay outright when the OS asks for reduced motion,
  // so the transition must be skipped here too -- otherwise we would sit waiting to
  // swap the tab behind a cover that is never drawn, which just reads as a laggy menu.
  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // Swap which region is on screen. Called behind the covered screen mid-transition,
  // and directly on first load when there is nothing to transition from.
  function showRegion(region) {
    $('.content-region').hide();
    $('.main-menu a').removeClass('active');

    // Show the region specified in the URL hash and highlight its menu link
    $(region).show();
    $('.main-menu a[href="'+ region +'"]').addClass('active');

    var $region = $(region);
    $region.removeClass('wipe-in');
    if ($region.length) { $region[0].offsetWidth; } // forced reflow: replays the animation
    $region.addClass('wipe-in');
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function playWipe(region) {
    var overlay = document.getElementById('wipe-overlay');
    if (!overlay || prefersReducedMotion()) { showRegion(region); return; }

    var vw = window.innerWidth;
    var vh = window.innerHeight;

    // Fall back to the centre of the screen when we have no click to work from
    // (keyboard activation reports 0,0, so treat that as "no real click" too).
    var point = (origin && (origin.x || origin.y)) ? origin : { x: vw / 2, y: vh / 2 };
    origin = null;

    // Cells are CELL_PX on screen. On a display bigger than the sheet was baked for
    // they grow instead, which keeps the board covered -- a partly uncovered screen
    // would expose the tab change.
    var scale = Math.max(1, vw / (SHEET_COLS * CELL_PX), vh / (SHEET_ROWS * CELL_PX));
    var sheetW = SHEET_COLS * CELL_PX * scale;
    var frameH = SHEET_ROWS * CELL_PX * scale;
    var sheetH = frameH * SHEET_FRAMES;

    // The seed cell is baked at the centre of the frame. Line it up with the click,
    // then clamp so no edge of the viewport is left uncovered; on a click near a
    // corner the origin ends up as close to the cursor as coverage allows.
    var ox = clamp(point.x - sheetW / 2, vw - sheetW, 0);
    var oy = clamp(point.y - frameH / 2, vh - frameH, 0);

    clearTimeout(swapTimer);
    clearTimeout(cleanupTimer);

    overlay.classList.remove('wipe-active');
    overlay.style.setProperty('--sheet-w', sheetW + 'px');
    overlay.style.setProperty('--sheet-h', sheetH + 'px');
    overlay.style.setProperty('--ox', ox + 'px');
    overlay.style.setProperty('--oy', oy + 'px');
    overlay.style.setProperty('--play-ms', (SHEET_FRAMES * FRAME_MS) + 'ms');

    // Forced reflow so playback restarts from frame 0 on every switch.
    overlay.offsetWidth;
    overlay.classList.add('wipe-active');

    // Change the tab on the one frame where the board is completely opaque. The
    // generator asserts that frame has no holes in it.
    swapTimer = setTimeout(function () {
      showRegion(region);
    }, COVER_FRAME * FRAME_MS);

    cleanupTimer = setTimeout(function () {
      overlay.classList.remove('wipe-active');
    }, SHEET_FRAMES * FRAME_MS + 30);
  }

  // We use some Javascript and the URL #fragment to hide/show different parts of the page
  // https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a#Linking_to_an_element_on_the_same_page
  $(window).on('load hashchange', function (e) {

    // The hash can carry a deep-link slug: #thoughts/my-piece activates the
    // Thoughts tab AND scrolls to that entry. Regular #region hashes still work.
    // Contact used to be its own tab and moved onto the landing page, so an old
    // #contact bookmark would otherwise show an empty area -- anything that does
    // not name a real region falls back to the first tab.
    var first = $('.main-menu a:first').attr('href');
    var raw = location.hash.toString();
    var match = raw.match(/^#([A-Za-z][\w-]*)(?:\/([\w-]+))?$/);
    var region = first;
    var slug = null;

    if (match) {
      var candidate = '#' + match[1];
      if ($(candidate).hasClass('content-region')) {
        region = candidate;
        slug = match[2] || null;
      }
    }

    if (e.type === 'load') {
      // Nothing to transition away from on first paint, so just show the region.
      showRegion(region);
    } else {
      // Play the automaton, which changes the tab once it has the screen covered.
      playWipe(region);
    }

    // Ask the Thoughts loader (below) to scroll to a specific entry once it has
    // finished fetching them. Harmless if the slug does not match anything.
    if (region === '#thoughts' && slug && window.__requestThoughtsJump) {
      window.__requestThoughtsJump(slug);
    }

    // Alternate method: Use AJAX to load the contents of an external file into a div based on URL fragment
    // This will extract the region name from URL hash, and then load [region].html into the main #content div
    // var region = location.hash.toString() || '#first';
    // $('#content').load(region.slice(1) + '.html')

  });

})(jQuery);


// ---- Living background -----------------------------------------------------
// A game of Life running behind the page, seeded by the cursor: sweep over a block
// and it switches on. Unlike the tab transition this one cannot be pre-rendered --
// it reacts to you -- so it is written to cost almost nothing.
//
// Where the budget goes:
//   * one generation every few seconds, not every frame. A tick over a grid this
//     size is a few thousand operations, so the cost is a rounding error even at
//     the top of the second.
//   * moving the cursor repaints exactly one cell, never the whole canvas.
//   * the timer stops entirely while the tab is in the background.
//
// Cells are white at very low alpha over black, so the board reads as a texture
// rather than as something competing with the text on top of it.
(function () {

  var CELL_PX  = 28;                      // block size on screen
  var TICK_MS  = 1500;                    // several seconds between generations
  var LIVE     = 'rgba(255,255,255,.10)'; // fallback fill before the image loads
  var GUTTER   = 1;                       // leaves a faint grid between blocks

  // Seed the board at load so the page opens on something alive rather than blank.
  // Every shape placed here is stable in Life: still-lifes never change, oscillators
  // repeat, spaceships translate, the gun emits gliders forever. There is deliberately
  // no random-cell "noise" -- a lone cell has zero neighbours and dies on the very
  // next tick, so scattering singletons just wastes them.
  //
  // Counts are [min, max] ranges, inclusive. Every value is optional -- set the
  // range to [0, 0] to disable a pattern entirely.
  var SEED_BLOCKS    = [1, 3]; // 2x2 still-life
  var SEED_BEEHIVES  = [1, 2]; // 6-cell still-life
  var SEED_BOATS     = [1, 2]; // 5-cell still-life
  var SEED_BLINKERS  = [2, 4]; // period-2 oscillator
  var SEED_TOADS     = [1, 2]; // period-2 oscillator
  var SEED_BEACONS   = [0, 1]; // period-2 oscillator
  var SEED_GLIDERS   = [1, 3]; // diagonal spaceship
  var SEED_LWSS      = [0, 2]; // horizontal spaceship (Lightweight Spaceship)
  var GUN_CHANCE     = 0.35;   // chance of placing a Gosper glider gun

  // A live cell is a window onto the background image, in greyscale. The image is
  // pre-processed once into a dimmed grey texture, and each cell blits the piece of
  // it that lies under that cell -- so the picture is only ever visible through the
  // colony, and holds still while cells come and go over it.
  var IMAGE_SRC = 'background.jpg';  // 1920x1080; the .png is only 375x330

  // The image's brightness distribution rarely covers the whole 0-255 range in a
  // useful way, so its levels are stretched from a percentile window into a fixed
  // band. Cells over the darker regions land at LEVEL_MIN and read like the flat
  // grey they used to be, while cells over the lit parts pick up the picture. The
  // band is deliberately narrow: a background that competes with the text on top
  // of it is worse than one that shows less of the picture. Retune LEVEL_MAX for
  // any new image that lands too bright or too flat.
  var LEVEL_MIN = 20;    // darkest a live cell can be; keeps every cell visible
  var LEVEL_MAX = 62;    // brightest, so highlights cannot flare
  var LO_PCT    = 0.50;  // luminance percentile mapped to LEVEL_MIN
  var HI_PCT    = 0.98;  // ...and to LEVEL_MAX

  // Named patterns for the initial seed. Each entry has its bounding-box height
  // and width, plus the list of [row, col] offsets from its top-left corner.
  // All are standard B3/S23 constructs. The bounding boxes let the placer keep
  // each shape entirely on screen so no pattern arrives split across a screen
  // edge (the sim still wraps -- this is a visual choice).
  var PATTERNS = {
    // Still-lifes: never change once placed.
    block:   { h: 2, w: 2, cells: [[0,0],[0,1],[1,0],[1,1]] },
    beehive: { h: 3, w: 4, cells: [[0,1],[0,2],[1,0],[1,3],[2,1],[2,2]] },
    boat:    { h: 3, w: 3, cells: [[0,0],[0,1],[1,0],[1,2],[2,1]] },

    // Period-2 oscillators: alternate between two shapes.
    blinker: { h: 1, w: 3, cells: [[0,0],[0,1],[0,2]] },
    toad:    { h: 2, w: 4, cells: [[0,1],[0,2],[0,3],[1,0],[1,1],[1,2]] },
    beacon:  { h: 4, w: 4, cells: [[0,0],[0,1],[1,0],[1,1],[2,2],[2,3],[3,2],[3,3]] },

    // Spaceships: translate across the board.
    glider:  { h: 3, w: 3, cells: [[0,1],[1,2],[2,0],[2,1],[2,2]] },
    lwss:    { h: 4, w: 5, cells: [[0,1],[0,2],[0,3],[0,4],[1,0],[1,4],[2,4],[3,0],[3,3]] },

    // Gosper's period-30 gun -- continually emits gliders.
    gun: { h: 9, w: 36, cells: [
      [0,24],
      [1,22],[1,24],
      [2,12],[2,13],[2,20],[2,21],[2,34],[2,35],
      [3,11],[3,15],[3,20],[3,21],[3,34],[3,35],
      [4,0],[4,1],[4,10],[4,16],[4,20],[4,21],
      [5,0],[5,1],[5,10],[5,14],[5,16],[5,17],[5,22],[5,24],
      [6,10],[6,16],[6,24],
      [7,11],[7,15],
      [8,12],[8,13]
    ] }
  };

  var canvas = document.getElementById('life-bg');
  if (!canvas || !canvas.getContext) { return; }

  // A background that evolves on its own is precisely what this setting is about.
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }

  var ctx = canvas.getContext('2d');
  var cols = 0, rows = 0, cells = null;
  var vw = 0, vh = 0, dpr = 1;
  var timer = null, resizeTimer = null;
  var texture = null;   // offscreen canvas holding the dimmed greyscale image
  var hasSeeded = false;

  var source = new Image();
  source.onload = function () { buildTexture(); paint(); };
  source.src = IMAGE_SRC;

  // Render the image to cover the grid, convert to luminance, then scale the whole
  // thing so its *mean* level matches what the flat cells used to be. Normalising to
  // the mean rather than picking a fixed multiplier keeps the overall brightness of
  // the page unchanged no matter what image is dropped in.
  function buildTexture() {
    if (!source.complete || !source.naturalWidth || !cols || !rows) {
      texture = null;
      return;
    }

    // Size to the whole grid, not the viewport: the last row and column of cells
    // hang past the edge, and their slices still have to exist.
    var w = Math.round(cols * CELL_PX * dpr);
    var h = Math.round(rows * CELL_PX * dpr);

    var off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    var octx = off.getContext('2d');

    var scale = Math.max(w / source.naturalWidth, h / source.naturalHeight);
    var dw = source.naturalWidth * scale;
    var dh = source.naturalHeight * scale;
    octx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);

    var frame;
    try {
      frame = octx.getImageData(0, 0, w, h);
    } catch (e) {
      texture = null;   // tainted canvas (image served cross-origin): fall back
      return;
    }

    var px = frame.data;
    var count = px.length / 4;
    var hist = new Uint32Array(256);
    var i, lum;

    // Pass one: to greyscale, building a histogram as we go.
    for (i = 0; i < px.length; i += 4) {
      lum = (px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722) | 0;
      px[i] = px[i + 1] = px[i + 2] = lum;
      hist[lum]++;
    }

    // Read the two percentiles straight off the histogram.
    var loTarget = count * LO_PCT;
    var hiTarget = count * HI_PCT;
    var running = 0, lo = 0, hi = 255;
    var haveLo = false;

    for (i = 0; i < 256; i++) {
      running += hist[i];
      if (!haveLo && running >= loTarget) { lo = i; haveLo = true; }
      if (running >= hiTarget) { hi = i; break; }
    }
    if (hi <= lo) { hi = lo + 1; }

    // Pass two: stretch that window into the visible band.
    var span = (LEVEL_MAX - LEVEL_MIN) / (hi - lo);
    for (i = 0; i < px.length; i += 4) {
      lum = LEVEL_MIN + (px[i] - lo) * span;
      if (lum < LEVEL_MIN) { lum = LEVEL_MIN; }
      else if (lum > LEVEL_MAX) { lum = LEVEL_MAX; }
      px[i] = px[i + 1] = px[i + 2] = lum;
      px[i + 3] = 255;
    }

    octx.putImageData(frame, 0, 0);
    texture = off;
  }

  // Stamp a pattern's cells onto the board at (r0, c0). Coordinates wrap around
  // the toroidal grid, which is the same behaviour the simulation uses -- so a
  // pattern placed near an edge behaves the same as one placed in the middle.
  function stamp(pattern, r0, c0) {
    for (var k = 0; k < pattern.length; k++) {
      var r = ((r0 + pattern[k][0]) % rows + rows) % rows;
      var c = ((c0 + pattern[k][1]) % cols + cols) % cols;
      cells[r * cols + c] = 1;
    }
  }

  // Place N copies of a named pattern at random positions, keeping each entirely
  // on screen. Silently skips a pattern that will not fit at all -- on a narrow
  // mobile grid, the gun and LWSS drop out automatically.
  function place(name, count) {
    var p = PATTERNS[name];
    if (!p || count <= 0) { return; }
    if (rows < p.h || cols < p.w) { return; }

    var maxR = rows - p.h;
    var maxC = cols - p.w;
    for (var i = 0; i < count; i++) {
      var r = Math.floor(Math.random() * (maxR + 1));
      var c = Math.floor(Math.random() * (maxC + 1));
      stamp(p.cells, r, c);
    }
  }

  // Populate the empty board with a bit of everything. Order matters slightly:
  // the gun goes first and gets first pick of open space, since it needs the
  // biggest clear area and a single stray neighbour is enough to derail it.
  // Everything else is small enough to survive most collisions.
  function seed() {
    if (!cells || !cols || !rows) { return; }

    var randInt = function (lo, hi) {
      return lo + Math.floor(Math.random() * (hi - lo + 1));
    };

    if (Math.random() < GUN_CHANCE) { place('gun', 1); }

    place('block',   randInt(SEED_BLOCKS[0],    SEED_BLOCKS[1]));
    place('beehive', randInt(SEED_BEEHIVES[0],  SEED_BEEHIVES[1]));
    place('boat',    randInt(SEED_BOATS[0],     SEED_BOATS[1]));
    place('blinker', randInt(SEED_BLINKERS[0],  SEED_BLINKERS[1]));
    place('toad',    randInt(SEED_TOADS[0],     SEED_TOADS[1]));
    place('beacon',  randInt(SEED_BEACONS[0],   SEED_BEACONS[1]));
    place('glider',  randInt(SEED_GLIDERS[0],   SEED_GLIDERS[1]));
    place('lwss',    randInt(SEED_LWSS[0],      SEED_LWSS[1]));
  }

  function build() {
    dpr = Math.min(2, window.devicePixelRatio || 1);

    // innerWidth can still be 0 if this runs before the window has been laid out,
    // which would bake in a 0x0 canvas that never recovers. Fall back, and bail
    // out rather than committing to a degenerate grid.
    vw = window.innerWidth || document.documentElement.clientWidth || 0;
    vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (vw < 1 || vh < 1) { return; }

    var newCols = Math.ceil(vw / CELL_PX);
    var newRows = Math.ceil(vh / CELL_PX);
    var next = new Uint8Array(newCols * newRows);

    // Carry the existing colony across a resize instead of wiping it out.
    if (cells) {
      var c, r;
      for (r = 0; r < Math.min(rows, newRows); r++) {
        for (c = 0; c < Math.min(cols, newCols); c++) {
          next[r * newCols + c] = cells[r * cols + c];
        }
      }
    }

    cols = newCols;
    rows = newRows;
    cells = next;

    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    canvas.style.width = vw + 'px';
    canvas.style.height = vh + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    buildTexture();

    // Seed exactly once, on the first successful build. build() is also called
    // on resize and re-run at window.load in case the very first pass had zero
    // dimensions; neither should reseed and destroy the existing colony.
    if (!hasSeeded) {
      seed();
      hasSeeded = true;
    }

    paint();
  }

  // Blit this cell's slice of the greyscale texture. Source coordinates are in the
  // texture's device pixels; the destination is in CSS pixels, since the context
  // carries the dpr scale.
  function paintCell(c, r) {
    var x = c * CELL_PX;
    var y = r * CELL_PX;
    var w = CELL_PX - GUTTER;
    var h = CELL_PX - GUTTER;

    if (texture) {
      ctx.drawImage(texture, x * dpr, y * dpr, w * dpr, h * dpr, x, y, w, h);
    } else {
      ctx.fillRect(x, y, w, h);
    }
  }

  function paint() {
    ctx.clearRect(0, 0, vw, vh);
    ctx.fillStyle = LIVE;
    for (var r = 0; r < rows; r++) {
      var row = r * cols;
      for (var c = 0; c < cols; c++) {
        if (cells[row + c]) { paintCell(c, r); }
      }
    }
  }

  // Conway's B3/S23. The grid wraps, so gliders leave one edge and return by the
  // other rather than piling up in a corner and dying.
  function step() {
    if (!cols || !rows) { build(); return; }

    var next = new Uint8Array(cols * rows);

    for (var r = 0; r < rows; r++) {
      var up = ((r - 1 + rows) % rows) * cols;
      var mid = r * cols;
      var down = ((r + 1) % rows) * cols;

      for (var c = 0; c < cols; c++) {
        var left = (c - 1 + cols) % cols;
        var right = (c + 1) % cols;

        var n = cells[up + left] + cells[up + c] + cells[up + right]
              + cells[mid + left]                + cells[mid + right]
              + cells[down + left] + cells[down + c] + cells[down + right];

        next[mid + c] = (n === 3 || (n === 2 && cells[mid + c])) ? 1 : 0;
      }
    }

    cells = next;
    paint();
  }

  function start() {
    if (!timer) { timer = setInterval(step, TICK_MS); }
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // Seeding: light the block under the cursor and repaint that block alone.
  window.addEventListener('mousemove', function (e) {
    if (!cells || !cols) { return; }
    var c = Math.floor(e.clientX / CELL_PX);
    var r = Math.floor(e.clientY / CELL_PX);
    if (c < 0 || r < 0 || c >= cols || r >= rows) { return; }

    var i = r * cols + c;
    if (cells[i]) { return; }      // already on: nothing to draw

    cells[i] = 1;
    ctx.fillStyle = LIVE;
    paintCell(c, r);
  }, { passive: true });

  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(build, 200);
  });

  // No reason to simulate a background nobody is looking at.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stop(); } else { start(); }
  });

  build();     // starts blank: an empty grid until the cursor seeds it
  // Measure again once everything is laid out, in case the first attempt ran too
  // early to get real dimensions. build() carries any existing colony across.
  window.addEventListener('load', build);
  start();

})();


// ---- Thoughts loader -------------------------------------------------------
// Entries used to live inline in index.html, one <article> per piece; the file
// grew unbounded and every visitor downloaded every piece ever written on the
// first paint. Now each entry is its own tiny HTML fragment in thoughts/, listed
// once in thoughts/index.json, and this block fetches the manifest, sorts by
// date newest-first, and renders each fragment into #thoughts .notes.
//
// Adding a new piece is: write thoughts/2026-09-01-my-title.html (just paragraph
// content, no article wrapper -- the wrapper, title and date all come from the
// manifest so styling stays in one place), then append one entry to index.json.
// Ordering is by date, so the source order of the manifest doesn't matter.
//
// Deep links: #thoughts/2026-09-01-my-title activates the tab AND scrolls the
// entry into view. See the router in the main IIFE above.
(function () {

  var MANIFEST = 'thoughts/index.json';

  var loaded = false;
  var pendingSlug = null;

  var container = document.querySelector('#thoughts .notes');
  if (!container) { return; }

  // Router hook: called from the main script's hashchange handler. Either scrolls
  // immediately (if entries are already in the DOM) or remembers the request so
  // the render pass can honour it.
  window.__requestThoughtsJump = function (slug) {
    if (!slug) { return; }
    if (loaded) {
      scrollToSlug(slug);
    } else {
      pendingSlug = slug;
    }
  };

  function scrollToSlug(slug) {
    var el = document.getElementById('thought-' + slug);
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function slugOf(file) {
    return String(file).replace(/\.html?$/i, '');
  }

  function escape(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // "2026-09-01" -> "September 2026". Falls back to the raw string on anything
  // that does not parse as YYYY-MM-DD, so an unusual date value is still shown.
  function formatDate(iso) {
    var m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(iso));
    if (!m) { return String(iso); }
    var months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
    return months[parseInt(m[2], 10) - 1] + ' ' + m[1];
  }

  function renderEntries(entries) {
    // Sort newest-first, ties broken by manifest order (so a same-day pair stays
    // in whatever order the author chose to list them).
    var indexed = entries.map(function (e, i) { return { e: e, i: i }; });
    indexed.sort(function (a, b) {
      if (a.e.date !== b.e.date) { return a.e.date < b.e.date ? 1 : -1; }
      return a.i - b.i;
    });

    // Fetch every fragment in parallel; wait for all so the DOM order matches
    // the sort. A fragment that fails simply comes back empty and its entry gets
    // its title and date but no body -- the manifest metadata is still visible.
    return Promise.all(indexed.map(function (x) {
      return fetch('thoughts/' + x.e.file, { cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.text() : ''; })
        .catch(function () { return ''; });
    })).then(function (bodies) {
      container.innerHTML = '';

      if (!indexed.length) {
        container.innerHTML = '<p class="notes__empty">Nothing posted yet.</p>';
        loaded = true;
        return;
      }

      var frag = document.createDocumentFragment();
      indexed.forEach(function (x, k) {
        var article = document.createElement('article');
        article.className = 'note';
        article.id = 'thought-' + slugOf(x.e.file);
        article.innerHTML =
          '<h3 class="note__title">' + escape(x.e.title || '') + '</h3>' +
          '<p class="note__meta"><time datetime="' + escape(x.e.date || '') + '">' +
            escape(formatDate(x.e.date)) +
          '</time></p>' +
          bodies[k];
        frag.appendChild(article);
      });
      container.appendChild(frag);

      loaded = true;
      if (pendingSlug) {
        scrollToSlug(pendingSlug);
        pendingSlug = null;
      }
    });
  }

  fetch(MANIFEST, { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : { entries: [] }; })
    .then(function (data) { return renderEntries((data && data.entries) || []); })
    .catch(function () {
      // Manifest missing or malformed: leave the initial empty state alone.
      loaded = true;
    });

})();
