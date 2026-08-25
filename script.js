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

  // What region the user is currently looking at. Tracked so a hashchange that
  // does not switch tabs (e.g. picking an entry within Thoughts) does not play
  // the full wipe -- it would be visual noise for what is really an in-page nav.
  var currentRegion = null;

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

    // Show the region and highlight its menu link. Matching goes through each
    // link's *resolved* pathname rather than its href attribute: hrefs are
    // relative so they work under any mount point, which means the attribute
    // itself ("projects") is not something PATH_MAP can be keyed on.
    $(region).show();
    $('.main-menu a').each(function () {
      if (PATH_MAP[toRoute(this.pathname)] === region) {
        $(this).addClass('active');
      }
    });

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

  // Path-based routing. Every real page has its own URL (/, /projects,
  // /thoughts, /thoughts/<slug>), served either directly at that URL when it
  // maps to a real file OR via the SPA 404 fallback (see 404.html + the
  // receiver in index.html <head>). This handler runs on initial load, on
  // popstate (browser back/forward), and on internal link clicks intercepted
  // below -- the three ways the URL can change without a full page load.
  //
  // Paths are translated to DOM region selectors via PATH_MAP. Kept explicit
  // because path names ("projects") and internal region ids ("about") do not
  // always agree.
  var PATH_MAP = {
    '/':         '#home',
    '/projects': '#about',
    '/thoughts': '#thoughts'
  };

  // Where the app is mounted, worked out by the receiver in index.html's head:
  // "/" on a domain root, "/personal-site/" on a GitHub project page. Route
  // matching happens on the path with this prefix removed, so PATH_MAP stays
  // written in app-relative terms no matter where the site is deployed.
  var BASE = window.__BASE__ || '/';

  // Strip the mount point off a pathname, leaving an app-relative route.
  function toRoute(pathname) {
    var p = pathname;
    if (BASE !== '/' && p.indexOf(BASE) === 0) {
      p = '/' + p.slice(BASE.length);
    }
    return p.replace(/\/+$/, '') || '/';
  }

  // Build a full URL for an app-relative route, for pushState.
  function toUrl(route) {
    return (BASE + route.replace(/^\//, '')).replace(/\/{2,}/g, '/');
  }

  function parseLocation() {
    var path = toRoute(location.pathname);

    // /thoughts/<slug> is the one path pattern that carries data.
    var thoughtSlug = path.match(/^\/thoughts\/([\w-]+)$/);
    if (thoughtSlug) {
      return { region: '#thoughts', slug: thoughtSlug[1] };
    }

    var region = PATH_MAP[path];
    if (region && $(region).hasClass('content-region')) {
      return { region: region, slug: null };
    }
    // Unknown path -- fall back to home rather than dropping the user on a
    // blank page (e.g. a stale /contact bookmark from before that tab moved).
    return { region: '#home', slug: null };
  }

  function route(isInitial) {
    var loc = parseLocation();

    if (isInitial) {
      showRegion(loc.region);
    } else if (loc.region !== currentRegion) {
      // Real tab change: play the automaton wipe.
      playWipe(loc.region);
    }
    // Same region: no wipe, and showRegion would be a no-op. In-tab navigation
    // (e.g. picking an entry within Thoughts) only needs the view update below.
    currentRegion = loc.region;

    if (loc.region === '#thoughts' && window.__setThoughtsView) {
      window.__setThoughtsView(loc.slug);
    }
  }

  // Intercept clicks on internal links so navigation happens via pushState
  // instead of a full page reload -- keeps the SPA alive and lets the wipe
  // transition play. Links are matched on their *resolved* URL rather than the
  // raw href, because internal hrefs are relative now (see the note on the nav
  // markup) and the browser has already resolved them against <base>.
  //
  // Modifier-key clicks (cmd/ctrl for a new tab, shift for a new window,
  // middle-click) fall through to the browser untouched.
  $(document).on('click', 'a', function (e) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) { return; }

    var a = this;
    if (a.target === '_blank' || a.hasAttribute('download')) { return; }
    if (!a.origin || a.origin !== location.origin) { return; }   // external
    if (a.pathname.indexOf(BASE) !== 0) { return; }              // outside the app

    // Anything that names a real file (resume.pdf, an image) is a genuine
    // navigation, not a route.
    if (/\.[^\/]+$/.test(a.pathname)) { return; }

    var dest = a.pathname + a.search + a.hash;
    if (dest === location.pathname + location.search + location.hash) {
      e.preventDefault();
      return;
    }

    try {
      window.history.pushState(null, '', dest);
    } catch (err) {
      return;   // e.g. file://, where pushState is not allowed: let it navigate
    }
    e.preventDefault();
    route(false);
  });

  // Browser back/forward
  $(window).on('popstate', function () { route(false); });

  // Initial route runs once the router-adjacent functions are defined above.
  $(window).on('load', function () { route(true); });

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
// Entries live as individual HTML fragments in entries/, listed once in
// entries/index.json. On page load this fetches the manifest, fetches every
// fragment in parallel, and keeps them all in memory. The URL then decides
// which of two views is drawn into #thoughts .notes:
//
//   /thoughts             -> spiral index (see below)
//   /thoughts/<slug>      -> single view (that entry, full body, back link)
//
// The data folder is deliberately NOT called thoughts/: GitHub Pages resolves
// /thoughts/my-piece to thoughts/my-piece.html when such a file exists, which
// would serve the bare unstyled fragment instead of the site. Naming the folder
// entries/ means no request path can ever collide with a real file, so every
// deep URL falls through to 404.html and back into the app.
//
// The router calls __setThoughtsView on every navigation to /thoughts, so both
// index<->single transitions and cold deep-links land in the right place.
//
// Adding a new piece is: write entries/<slug>.html (body markup only, no
// wrapper), then append one { title, date, file } object to index.json.
(function () {

  var BASE = window.__BASE__ || '/';
  var MANIFEST = 'entries/index.json';
  var SNIPPET_CHARS = 200;

  var container = document.querySelector('#thoughts .notes');
  if (!container) { return; }

  var entries = [];        // { title, date, file, slug, body } sorted newest-first
  var loaded = false;
  var pendingView = null;  // null = list, string = requested slug

  // Router hook. Called with a slug to show that single entry, or with nothing
  // (or an unknown slug) to show the list. Safe to call before the manifest has
  // finished loading -- the request is queued and honoured on first render.
  window.__setThoughtsView = function (slug) {
    var view = slug || null;
    if (loaded) {
      show(view);
    } else {
      pendingView = view;
    }
  };

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

  // Take the plain-text of the first paragraph, trim to SNIPPET_CHARS, and
  // ellipsize at a word boundary so preview cards look consistent even when
  // fragments have wildly different structure.
  function snippetOf(body) {
    var host = document.createElement('div');
    host.innerHTML = body;
    var p = host.querySelector('p');
    var text = (p ? p.textContent : host.textContent).replace(/\s+/g, ' ').trim();
    if (text.length <= SNIPPET_CHARS) { return text; }
    var cut = text.slice(0, SNIPPET_CHARS - 1).replace(/\s+\S*$/, '');
    return cut + '…';
  }

  function findBySlug(slug) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].slug === slug) { return entries[i]; }
    }
    return null;
  }

  function meta(entry) {
    return '<p class="note__meta"><time datetime="' + escape(entry.date) + '">' +
             escape(formatDate(entry.date)) +
           '</time></p>';
  }

  // ---- Spiral index view ---------------------------------------------------
  // The list of entries is laid out as a Fibonacci-style spiral of SLOT_COUNT
  // cells. Slot 0 is the largest and holds the newest entry in view; each
  // subsequent slot is smaller and spirals inward toward the oldest.
  //
  // Scrolling does not move the grid -- it is sticky. Instead, scroll position
  // maps to a window offset over the entry list:
  //
  //   scroll DOWN -> the window slides toward older entries. Every visible
  //                  entry moves one slot OUTWARD (bigger), the newest drops
  //                  off the outside, an older one enters at the centre.
  //   scroll UP   -> the reverse: entries spiral inward and newer ones enter
  //                  at the largest slot.
  //
  // Each entry keeps its own DOM element for as long as it is on screen, and
  // moving between slots is a CSS transition on the element's position/size.
  // That is what produces the spiral motion rather than a re-render flicker.

  var SLOT_COUNT = 8;
  var STEP_PX = 320;    // scroll distance that advances the window by one entry

  // Fraction of the remaining rectangle each cell takes. 0.5 matches the
  // hand-drawn reference and is the only value that keeps all eight cells
  // usable; 0.618 (golden ratio) is the mathematically true Fibonacci spiral
  // but shrinks the innermost cell to roughly 40x13px, too small for text.
  var SPLIT = 0.5;

  // Default artwork. Entries have no images of their own, so each one borrows a
  // patch of wipe-frames.png -- the pre-rendered automaton sheet that is already
  // fetched and decoded for the tab transition, so this adds no new bytes. The
  // patch is taken from the one frame where the board is fully covered (no
  // transparent cells), and its offset is derived from the slug, so a given
  // entry always shows the same piece of board. Same trick the tool cells on
  // the Projects tab use for their missing thumbnails.
  //
  // An entry can override this by adding "image": "something.png" to its
  // manifest object -- the default is only a default.
  var SHEET_W    = 3200;    // the sheet at the 10x scale the transition uses
  var SHEET_H    = 64000;
  var COVER_TOP  = 32000;   // top of frame 16, the fully-covered one
  var FRAME_H    = 2000;
  var SAFE_W     = 820;     // largest cell we ever have to fill, plus margin
  var SAFE_H     = 540;

  // FNV-1a over the slug, so the choice of patch is stable and well spread.
  function patchFor(slug) {
    var h = 2166136261;
    for (var i = 0; i < slug.length; i++) {
      h ^= slug.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    var a = h >>> 0;
    var b = Math.imul(a ^ (a >>> 13), 1274126177) >>> 0;
    return {
      x: a % (SHEET_W - SAFE_W),
      y: COVER_TOP + (b % (FRAME_H - SAFE_H))
    };
  }

  function setSheetPatch(el, key) {
    var p = patchFor(key);
    el.classList.add('spiral-cell--pattern');
    el.style.backgroundImage = 'url(wipe-frames.png)';
    el.style.backgroundSize = SHEET_W + 'px ' + SHEET_H + 'px';
    el.style.backgroundPosition = '-' + p.x + 'px -' + p.y + 'px';
  }

  function applyBackdrop(el, entry) {
    if (entry.image) {
      el.classList.remove('spiral-cell--pattern');
      el.style.backgroundImage = 'url(' + entry.image + ')';
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      return;
    }
    setSheetPatch(el, entry.slug);
  }

  // Prefix for placeholder keys in the element map. The double underscore
  // cannot appear at the start of a slug, which is derived from a filename,
  // so placeholder keys and real slugs can never collide.
  var PLACEHOLDER_KEY = '__ph-';

  var slots = computeSlots(SLOT_COUNT, SPLIT);
  var spiralEls = {};       // slug -> element, so entries can transition slots
  var spiralStage = null;
  var windowStart = 0;
  var scrollBound = false;

  // Lay out the spiral: each cell takes SPLIT of what is left, against a side
  // that cycles top -> right -> bottom -> left. The final cell takes whatever
  // remains. Values are percentages of the stage.
  function computeSlots(count, ratio) {
    var out = [];
    var x = 0, y = 0, w = 100, h = 100;

    for (var i = 0; i < count - 1; i++) {
      var side = i % 4;
      var cw, ch, cx, cy;

      if (side === 0) {            // top
        cw = w; ch = h * ratio; cx = x; cy = y;
        y += ch; h -= ch;
      } else if (side === 1) {     // right
        cw = w * ratio; ch = h; cx = x + w - cw; cy = y;
        w -= cw;
      } else if (side === 2) {     // bottom
        cw = w; ch = h * ratio; cx = x; cy = y + h - ch;
        h -= ch;
      } else {                     // left
        cw = w * ratio; ch = h; cx = x; cy = y;
        x += cw; w -= cw;
      }
      out.push({ x: cx, y: cy, w: cw, h: ch });
    }
    out.push({ x: x, y: y, w: w, h: h });
    return out;
  }

  function maxWindowStart() {
    return Math.max(0, entries.length - SLOT_COUNT);
  }

  // How much content a cell can carry depends on how big it is. Rather than
  // overflow tiny cells, drop detail as they shrink.
  function densityFor(slot) {
    var area = slot.w * slot.h;
    if (area >= 900) { return 'full'; }    // title + date + snippet
    if (area >= 300) { return 'mid'; }     // title + date
    if (area >= 60)  { return 'title'; }   // title only
    return 'bare';                          // date only
  }

  // Text sits in its own element so it can carry a scrim: the artwork behind it
  // is a busy two-tone pattern and unscrimmed type on top of it is unreadable.
  function cellMarkup(entry, slot) {
    var density = densityFor(slot);
    var html = '';

    if (density === 'bare') {
      html = '<span class="spiral-cell__bare">' +
               escape(formatDate(entry.date)) +
             '</span>';
    } else {
      html += '<h3 class="note__title">' + escape(entry.title) + '</h3>';
      if (density !== 'title') { html += meta(entry); }
      if (density === 'full') {
        html += '<p class="note__snippet">' + escape(snippetOf(entry.body)) + '</p>';
      }
    }

    return '<span class="spiral-cell__body">' + html + '</span>';
  }

  function positionCell(el, slot) {
    el.style.left   = slot.x + '%';
    el.style.top    = slot.y + '%';
    el.style.width  = slot.w + '%';
    el.style.height = slot.h + '%';
  }

  // Draw the current window. Elements already on screen are repositioned (the
  // CSS transition animates the move); ones scrolled past fade out and go.
  function paintSpiral() {
    if (!spiralStage) { return; }

    var visible = entries.slice(windowStart, windowStart + SLOT_COUNT);
    var seen = {};

    visible.forEach(function (entry, i) {
      var slot = slots[i];
      var el = spiralEls[entry.slug];
      seen[entry.slug] = true;

      if (!el) {
        el = document.createElement('a');
        el.className = 'spiral-cell spiral-cell--entering';
        el.href = BASE + 'thoughts/' + entry.slug;
        positionCell(el, slot);
        applyBackdrop(el, entry);
        spiralStage.appendChild(el);
        spiralEls[entry.slug] = el;

        // Let the entering state paint before clearing it, so the fade runs.
        el.offsetWidth;
        el.classList.remove('spiral-cell--entering');
      } else {
        positionCell(el, slot);
      }

      el.setAttribute('data-slot', i);
      el.setAttribute('data-density', densityFor(slot));
      el.innerHTML = cellMarkup(entry, slot);
    });

    // Fewer entries than slots: fill the rest so the spiral still reads as a
    // complete shape rather than a filled corner with a hole in it. These are
    // inert -- not links, not focusable, hidden from assistive tech -- and just
    // carry a dimmed patch of the same sheet the real cells use.
    for (var i = visible.length; i < SLOT_COUNT; i++) {
      var key = PLACEHOLDER_KEY + i;
      seen[key] = true;

      var ph = spiralEls[key];
      if (!ph) {
        ph = document.createElement('div');
        ph.className = 'spiral-cell spiral-cell--placeholder';
        ph.setAttribute('aria-hidden', 'true');
        setSheetPatch(ph, 'placeholder-' + i);
        positionCell(ph, slots[i]);
        spiralStage.appendChild(ph);
        spiralEls[key] = ph;
      } else {
        positionCell(ph, slots[i]);
      }
      ph.setAttribute('data-slot', i);
    }

    Object.keys(spiralEls).forEach(function (slug) {
      if (seen[slug]) { return; }
      var el = spiralEls[slug];
      delete spiralEls[slug];
      el.classList.add('spiral-cell--leaving');
      setTimeout(function () {
        if (el.parentNode) { el.parentNode.removeChild(el); }
      }, 400);
    });
  }

  // Map scroll position within the tall track onto a window offset.
  function syncToScroll() {
    var track = document.getElementById('spiral-track');
    if (!track) { return; }

    var top = track.getBoundingClientRect().top;
    var travelled = Math.max(0, -top);
    var next = Math.min(maxWindowStart(), Math.round(travelled / STEP_PX));

    if (next !== windowStart) {
      windowStart = next;
      paintSpiral();
    }
  }

  function renderList() {
    container.classList.remove('notes--single');
    container.classList.add('notes--list');
    container.innerHTML = '';
    spiralEls = {};
    spiralStage = null;

    if (!entries.length) {
      container.innerHTML = '<p class="notes__empty">Nothing posted yet.</p>';
      return;
    }

    // The track is tall enough to give every window position its own stretch of
    // scroll, plus one viewport so the last state can be read before the grid
    // releases. The stage inside is sticky, so the grid holds position while
    // the page scrolls past it.
    var track = document.createElement('div');
    track.id = 'spiral-track';
    track.className = 'spiral-track';
    track.style.height = 'calc(100vh + ' + (maxWindowStart() * STEP_PX) + 'px)';

    var sticky = document.createElement('div');
    sticky.className = 'spiral-sticky';

    spiralStage = document.createElement('div');
    spiralStage.className = 'spiral-stage';

    sticky.appendChild(spiralStage);
    track.appendChild(sticky);
    container.appendChild(track);

    // A plain list underneath, for narrow screens (where an eight-cell spiral
    // is unreadable) and for anything that does not run the layout.
    var fallback = document.createElement('div');
    fallback.className = 'spiral-fallback';
    entries.forEach(function (e) {
      var card = document.createElement('a');
      card.className = 'note-preview';
      card.href = BASE + 'thoughts/' + e.slug;
      card.innerHTML =
        '<h3 class="note__title">' + escape(e.title) + '</h3>' +
        meta(e) +
        '<p class="note__snippet">' + escape(snippetOf(e.body)) + '</p>';
      fallback.appendChild(card);
    });
    container.appendChild(fallback);

    windowStart = 0;
    paintSpiral();
    syncToScroll();

    if (!scrollBound) {
      window.addEventListener('scroll', syncToScroll, { passive: true });
      scrollBound = true;
    }
  }

  function renderSingle(entry) {
    container.classList.remove('notes--list');
    container.classList.add('notes--single');
    container.innerHTML =
      '<p class="notes__back"><a href="' + BASE + 'thoughts">&larr; All thoughts</a></p>' +
      '<article class="note note--full" id="thought-' + entry.slug + '">' +
        '<h3 class="note__title">' + escape(entry.title) + '</h3>' +
        meta(entry) +
        entry.body +
      '</article>';

    // Land at the top of the entry, not wherever the reader last scrolled.
    window.scrollTo(0, 0);
  }

  function show(view) {
    if (!view) { return renderList(); }
    var entry = findBySlug(view);
    return entry ? renderSingle(entry) : renderList();
  }

  function ingest(manifestEntries) {
    var sorted = manifestEntries
      .map(function (e, i) { return { e: e, i: i }; })
      .sort(function (a, b) {
        if (a.e.date !== b.e.date) { return a.e.date < b.e.date ? 1 : -1; }
        return a.i - b.i;
      });

    return Promise.all(sorted.map(function (x) {
      return fetch('entries/' + x.e.file, { cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.text() : ''; })
        .catch(function () { return ''; });
    })).then(function (bodies) {
      entries = sorted.map(function (x, k) {
        return {
          title: x.e.title || '',
          date: x.e.date || '',
          file: x.e.file,
          image: x.e.image || null,   // optional; falls back to a sheet patch
          slug: slugOf(x.e.file),
          body: bodies[k] || ''
        };
      });
      loaded = true;
      show(pendingView);
      pendingView = null;
    });
  }

  fetch(MANIFEST, { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : { entries: [] }; })
    .then(function (data) { return ingest((data && data.entries) || []); })
    .catch(function () {
      // Manifest missing or malformed: leave the initial empty state alone.
      loaded = true;
    });

})();
